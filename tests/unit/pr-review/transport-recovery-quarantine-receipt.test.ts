/**
 * Issue #3357 AC2: quarantined verdict-row strays surface on the DURABLE
 * recovery-receipt surface. Two layers are pinned:
 *
 * 1. The validator layer: `validatePrWorkflowTransportRecovery` returns a
 *    `legacy-verdict-row-quarantine` recovery entry (distinct from
 *    `legacy-verdict-row-recovery`) when the artifact contained quarantined
 *    strays, and no such entry for a clean artifact.
 * 2. The durable layer (the codec both halves — TS union AND the persisted
 *    WorkflowLaneRecoverySchema): the quarantine entry survives a real
 *    collect settlement and a re-read through the delegation reader. If the
 *    persisted schema ever drops the kind, the re-read loses the entry and
 *    this fails.
 *
 * Drives the real exported surfaces through the shared gate fixtures harness
 * (tests/unit/hooks/pr-workflow-gate.test-fixtures.js).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	readLaneOutput,
	storeLaneOutput,
} from '../../../src/background/lane-output-store.js';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	recordPrReviewValidationBatch,
	validatePrWorkflowTransportRecovery,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	PR_REVIEW_SCOPE,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const BATCH_ID = 'quarantine-receipt-batch';
const LANE_ID = 'quarantine-receipt-lane';
const CORRELATION_ID = 'quarantine-receipt-correlation';
const GOOD_C0_ROW =
	'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer notes | UNKNOWN |';
/** Stage-B stray: 14 raw fields against the 12-field reviewer grammar. */
const STRAY_ROW_14_RAW =
	'[REVIEWED] | task-unknown | REJECTED | summary | with | pipes | a | b | c | d | e | f | g | h';

const originalInternals = { ..._internals };

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
});
afterEach(async () => {
	Object.assign(_internals, originalInternals);
	await teardownPrWorkflowGateFixtures();
});

async function prepareLane(text: string) {
	await establishReviewPrerequisites();
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[{ laneId: LANE_ID, workflowLane: LANE_ID, reviewItemIds: ['C-0'] }],
		{ batchId: BATCH_ID, prHeadSha: HEAD_SHA },
	);
	const record = await recordPendingDelegation(tempDir, {
		correlationId: CORRELATION_ID,
		jobId: null,
		subagentSessionId: CORRELATION_ID,
		parentSessionId: SESSION_ID,
		callID: BATCH_ID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH_ID,
		laneId: LANE_ID,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: LANE_ID,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: PR_REVIEW_SCOPE,
		},
	});
	expect(record).not.toBeNull();
	const stored = storeLaneOutput(tempDir, {
		batchId: BATCH_ID,
		laneId: LANE_ID,
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: CORRELATION_ID,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: LANE_ID,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: PR_REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	const artifact = readLaneOutput(tempDir, stored.ref!)?.artifact;
	expect(artifact).toBeDefined();
	return {
		record: record!,
		result: {
			text,
			chars: text.length,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
		artifact: artifact!,
	};
}

function hostFor(sessionId: string, text: string): SessionOps {
	return {
		create: mock(async () => ({ data: { id: sessionId } })),
		prompt: mock(async () => ({ data: null })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
		abort: mock(async () => undefined),
		status: mock(async () => ({
			data: { [sessionId]: { type: 'idle' as const } },
		})),
		messages: mock(async () => ({
			data: [
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'p' }] },
				{
					info: {
						role: 'assistant' as const,
						time: { completed: 1_750_000_000_000 },
						finish: 'stop',
					},
					parts: [{ type: 'text' as const, text }],
				},
			],
		})),
	} as never;
}

function quarantineRecoveries(recoveries: Array<{ kind: string }> | undefined) {
	return (recoveries ?? []).filter(
		(entry) => entry.kind === 'legacy-verdict-row-quarantine',
	);
}

describe('transport-recovery receipt surfaces quarantined strays (#3357 AC2)', () => {
	test('validator: quarantined artifact yields a legacy-verdict-row-quarantine recovery entry', async () => {
		const input = await prepareLane(`${GOOD_C0_ROW}\n${STRAY_ROW_14_RAW}`);
		const validation = await validatePrWorkflowTransportRecovery({
			directory: tempDir,
			record: input.record,
			result: input.result,
			artifact: input.artifact,
			revisionDigest: REVISION_DIGEST,
		});

		expect(
			validation.ok,
			`stray must be quarantined, not lane-voiding; reason: ${validation.ok ? '' : (validation.reason ?? '')}`,
		).toBe(true);
		const named = quarantineRecoveries(validation.recoveries);
		expect(named.length).toBeGreaterThan(0);
		expect(named[0]?.reason).toContain('task-unknown');
		expect(named[0]?.reason).toContain('14');
	}, 120000);

	test('validator: clean artifact yields no quarantine entry', async () => {
		const input = await prepareLane(GOOD_C0_ROW);
		const validation = await validatePrWorkflowTransportRecovery({
			directory: tempDir,
			record: input.record,
			result: input.result,
			artifact: input.artifact,
			revisionDigest: REVISION_DIGEST,
		});

		expect(validation.ok).toBe(true);
		expect(quarantineRecoveries(validation.recoveries)).toEqual([]);
	}, 120000);

	test('durable: the quarantine entry survives collect settlement and a delegation-store re-read', async () => {
		const artifactText = `${GOOD_C0_ROW}\n${STRAY_ROW_14_RAW}`;
		await prepareLane(artifactText);
		// Drive the real collect path over the recorded lane with the artifact
		// as the lane's assistant output, so the terminal record (carrying the
		// quarantine recovery) lands in the delegation store.
		_internals.getSessionOps = () => hostFor(CORRELATION_ID, artifactText);
		await executeCollectLaneResults(
			{ batch_id: BATCH_ID, wait: false },
			tempDir,
		);
		const settled = await findByCorrelationId(tempDir, CORRELATION_ID);

		expect(
			settled,
			'settled record must be readable through the delegation reader',
		).toBeDefined();
		const durable = [
			...(settled?.result?.salvagedWorkflowLaneRecoveries ?? []),
			...(settled?.terminalResult?.result.salvagedWorkflowLaneRecoveries ?? []),
		];
		const named = quarantineRecoveries(durable);
		expect(
			named.length,
			`the persisted record must carry the quarantine recovery after re-read (if the persisted schema dropped the kind, the reader silently drops it); got ${JSON.stringify(durable)}`,
		).toBeGreaterThan(0);
	}, 120000);
});
