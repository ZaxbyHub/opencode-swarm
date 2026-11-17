import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	createDelegationGateHook,
	_internals as delegationInternals,
} from '../../../src/hooks/delegation-gate.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	resolvePrFeedbackScopeDeclaration,
} from '../../../src/hooks/pr-workflow-gate.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { makeConfig } from './_delegation-gate-helpers.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// Issue #2973 macos-entry retirement evidence, made executable: the
// 2026-09-12 passed-on-retry flake (CI run 34670762927, macos-latest
// unit-shard 1) failed the race test with "Expected length: 1 / Received
// length: 0" — BOTH racing Task calls rejected. The recovered attempt-1
// stderr lives in that run's repository-validation artifact. This spec pins
// the production semantics that make that outcome a fail-closed transient,
// NOT an atomicity violation:
//   - a pre-consumption transient rejecting both racing calls leaves the
//     declaration UNCONSUMED (non-destructive) — the next attempt races a
//     clean declaration;
//   - once the transient clears, the exactly-once reservation holds: one
//     call fulfills, the other takes the typed designed-loser rejection,
//     and consumedByCallId names the fulfilled call.
const SENTINEL =
	'race-transient-2973 injected pre-consume transient (beforePrFeedbackScopeConsume)';

async function settleFeedbackVerification(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-001'], {
		prHeadSha: HEAD_SHA,
	});
	await enforcePrFeedbackVerificationOwnership(
		tempDir,
		SESSION_ID,
		[{ laneId: 'verify-scope', ownedItemIds: ['FB-001'] }],
		{ batchId: 'verify-scope', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'verify-scope',
		'swarm-pr-feedback:verification',
		[{ laneId: 'verify-scope', workflowLane: 'verify-scope' }],
		{
			textOverride: '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence',
		},
	);
}

beforeEach(setupPrWorkflowGateFixtures);
afterEach(async () => {
	delegationInternals.beforePrFeedbackScopeConsume = undefined;
	await teardownPrWorkflowGateFixtures();
});

describe('PR_FEEDBACK scope race under an injected pre-consume transient (#2973)', () => {
	beforeEach(() => {
		resetSwarmState();
		ensureAgentSession(SESSION_ID, 'architect', tempDir);
	});

	test('both racing calls fail closed, non-destructively, then the clean re-race reserves exactly once', async () => {
		await settleFeedbackVerification();
		const prepared = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '9.9', files: ['src/index.ts'] },
				tempDir,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean };
		expect(prepared.success).toBe(true);

		const delegation = createDelegationGateHook(makeConfig(), tempDir);
		const raceTaskCalls = (callIds: string[]) =>
			Promise.allSettled(
				callIds.map((callID) =>
					delegation.toolBefore(
						{ tool: 'Task', sessionID: SESSION_ID, callID },
						{
							args: {
								subagent_type: 'coder',
								task_id: '9.9',
								prompt:
									'TASK: 9.9\nFILE: src/index.ts\nACCEPTANCE: close the authenticated feedback item',
							},
						},
					),
				),
			);

		// Leg 1 — controlled reproduction of the 2026-09-12 failure shape:
		// the seam fires once per racing call BEFORE any consumption; throwing
		// on the first two invocations rejects BOTH calls pre-consume. The real
		// incident was an un-retried race; leg 2 below covers recovery separately.
		let seamInvocations = 0;
		delegationInternals.beforePrFeedbackScopeConsume = async () => {
			seamInvocations += 1;
			if (seamInvocations <= 2) {
				throw new Error(SENTINEL);
			}
		};
		const transientCallIds = ['transient-race-a', 'transient-race-b'];
		const transientResults = await raceTaskCalls(transientCallIds);
		const transientReasons = transientResults.map((result) =>
			result.status === 'rejected'
				? String((result.reason as Error | undefined)?.message ?? result.reason)
				: null,
		);
		// The seam was reached by BOTH calls (non-vacuous: an earlier unrelated
		// rejection would leave the count below two or carry a foreign reason).
		expect(seamInvocations).toBe(2);
		expect(
			transientResults.filter((r) => r.status === 'fulfilled'),
		).toHaveLength(0);
		expect(transientReasons[0]).toBe(SENTINEL);
		expect(transientReasons[1]).toBe(SENTINEL);
		// Fail-closed AND non-destructive: the declaration was never consumed,
		// so the recovery attempt races a clean declaration.
		const afterTransient = await resolvePrFeedbackScopeDeclaration(
			tempDir,
			SESSION_ID,
			'9.9',
		);
		expect(afterTransient?.consumedByCallId).toBeUndefined();

		// Leg 2 — the transient clears: exactly-once reservation holds with
		// the designed-loser typed rejection on the losing call.
		const cleanCallIds = ['clean-race-a', 'clean-race-b'];
		const cleanResults = await raceTaskCalls(cleanCallIds);
		const fulfilled = cleanResults.filter((r) => r.status === 'fulfilled');
		expect(fulfilled).toHaveLength(1);
		const winnerIndex = cleanResults.findIndex((r) => r.status === 'fulfilled');
		const loserReason =
			cleanResults[1 - winnerIndex]?.status === 'rejected'
				? String(
						(cleanResults[1 - winnerIndex].reason as Error | undefined)
							?.message ?? cleanResults[1 - winnerIndex].reason,
					)
				: null;
		expect(loserReason).toMatch(/already consumed by another Task call/);
		const declaration = await resolvePrFeedbackScopeDeclaration(
			tempDir,
			SESSION_ID,
			'9.9',
		);
		expect(declaration?.consumedByCallId).toBe(cleanCallIds[winnerIndex]);
	});
});
