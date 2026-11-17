import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate.js';
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

// Issue #2973 macos-entry retirement: the "atomically reserves one
// PR-feedback declaration when Task calls race" case moved here from
// pr-feedback-scope-controller.test.ts (FR-006 — the hardened classifier
// outgrew the 500-line cap) and was determinism-hardened with the recovered
// 2026-09-12 attempt-1 evidence in hand. See
// pr-feedback-scope-race-transient-2973.test.ts for the injected-transient
// twin of this scenario.

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
afterEach(teardownPrWorkflowGateFixtures);

describe('PR_FEEDBACK scope race atomicity (#2973 hardening)', () => {
	beforeEach(() => {
		resetSwarmState();
		ensureAgentSession(SESSION_ID, 'architect', tempDir);
	});

	test('atomically reserves one PR-feedback declaration when Task calls race', async () => {
		// macOS retry-flake hardening (issue #2973 retirement): the recovered
		// attempt-1 evidence (CI run 34670762927's repository-validation
		// artifact) shows this test failing with "Expected length: 1 / Received
		// length: 0" — a shared fail-closed pre-consumption transient (or a
		// winner that consumed then failed post-consume) rejects BOTH racing
		// calls without violating the exactly-once reservation. The loop below
		// retries ONLY the environmental shapes with a bounded attempt count,
		// applies the FULL assertion set on whichever attempt is accepted, and
		// fails immediately (with per-attempt history) on any atomicity
		// violation: two fulfilled calls, two typed losers, a foreign
		// consumedByCallId, or a non-retryable zero-fulfilled shape.
		await settleFeedbackVerification();
		const delegation = createDelegationGateHook(makeConfig(), tempDir);
		const MAX_RACE_ATTEMPTS = 3;
		const typedLoserText = /already consumed by another Task call/;
		interface RaceAttemptRecord {
			attempt: number;
			taskId: string;
			callIds: string[];
			rejectionReasons: (string | null)[];
			consumedByCallId: string | null | undefined;
			fulfilledCount: number;
		}
		const history: RaceAttemptRecord[] = [];
		const failWithHistory = (summary: string): never => {
			throw new Error(
				`race atomicity failure: ${summary}; attempt history: ${JSON.stringify(history)}`,
			);
		};
		let accepted = false;
		for (
			let attempt = 1;
			attempt <= MAX_RACE_ATTEMPTS && !accepted;
			attempt += 1
		) {
			const taskId = `8.${7 + attempt}`; // 8.8, 8.9, 8.10 — strict N.M grammar only
			const prepared = JSON.parse(
				await executePreparePrFeedbackScope(
					{ task_id: taskId, files: ['src/index.ts'] },
					tempDir,
					{ sessionID: SESSION_ID },
				),
			) as { success: boolean };
			expect(prepared.success).toBe(true);
			const callIds = [`scope-race-a${attempt}`, `scope-race-b${attempt}`];
			const results = await Promise.allSettled(
				callIds.map((callID) =>
					delegation.toolBefore(
						{ tool: 'Task', sessionID: SESSION_ID, callID },
						{
							args: {
								subagent_type: 'coder',
								task_id: taskId,
								prompt:
									'TASK: ' +
									taskId +
									'\nFILE: src/index.ts\nACCEPTANCE: close the authenticated feedback item',
							},
						},
					),
				),
			);
			const rejectionReasons = results.map((result) =>
				result.status === 'rejected'
					? String(
							(result.reason as Error | undefined)?.message ?? result.reason,
						)
					: null,
			);
			const fulfilledCount = results.filter(
				(r) => r.status === 'fulfilled',
			).length;
			const declaration = await resolvePrFeedbackScopeDeclaration(
				tempDir,
				SESSION_ID,
				taskId,
			);
			history.push({
				attempt,
				taskId,
				callIds,
				rejectionReasons,
				consumedByCallId: declaration?.consumedByCallId,
				fulfilledCount,
			});
			if (fulfilledCount === 2) {
				// Rule 1: atomicity violation (the idempotent same-callID branch is
				// unreachable with distinct call ids).
				failWithHistory('both calls fulfilled');
			}
			if (
				rejectionReasons.every(
					(reason) => reason !== null && typedLoserText.test(reason),
				)
			) {
				// Rule 2: two typed losers, regardless of declaration state.
				failWithHistory('two typed loser rejections');
			}
			if (fulfilledCount === 1) {
				// Rule 3: ACCEPT this attempt with the full assertion set.
				const winnerIndex = results.findIndex((r) => r.status === 'fulfilled');
				const loserIndex = 1 - winnerIndex;
				expect(declaration?.consumedByCallId).toBe(callIds[winnerIndex]);
				expect(rejectionReasons[loserIndex]).toMatch(typedLoserText);
				accepted = true;
				continue;
			}
			// Zero fulfilled: classify the environmental retry shapes.
			const consumedBy = declaration?.consumedByCallId ?? null;
			const bothNonTyped = rejectionReasons.every(
				(reason) => reason !== null && !typedLoserText.test(reason),
			);
			const nonTypedIndex = rejectionReasons.findIndex(
				(reason) => reason !== null && !typedLoserText.test(reason),
			);
			const consumedByCurrentCall =
				consumedBy !== null &&
				callIds.includes(consumedBy) &&
				nonTypedIndex >= 0 &&
				consumedBy === callIds[nonTypedIndex] &&
				typedLoserText.test(rejectionReasons[1 - nonTypedIndex] ?? '');
			const attemptsRemain = attempt < MAX_RACE_ATTEMPTS;
			if (
				consumedBy === null &&
				declaration &&
				bothNonTyped &&
				attemptsRemain
			) {
				continue; // Rule 4: shared pre-consumption transient — plain re-race.
			}
			if (consumedByCurrentCall && attemptsRemain) {
				continue; // Rule 5: winner consumed then failed post-consume — fresh id.
			}
			// Rule 6: every other state/reason combination fails immediately.
			failWithHistory(
				attemptsRemain
					? 'non-retryable zero-fulfilled shape'
					: 'retry budget exhausted without an accepted attempt',
			);
		}
		// Accepted-attempt-or-throw: the loop cannot exit vacuously.
		expect(accepted).toBe(true);
	});
});
