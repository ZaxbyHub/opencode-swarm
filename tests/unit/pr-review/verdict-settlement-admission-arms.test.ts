import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	deriveVerdictSettlementAdmission,
	PR_REVIEW_VERDICT_RETRY_BUDGET,
	PrReviewVerdictSettlementReceiptSchema,
} from '../../../src/pr-review/verdict-settlement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Review PRR-025: executing coverage for the fail-closed admission arms that
// previously had none — the uncertain delegation-store read, each identity
// conjunction leg, the non-liveness-terminal owner refusal, and the
// cancelled/error terminalStatus mapping. These call
// `deriveVerdictSettlementAdmission` directly over a seeded delegation store.

const HEAD = 'abc123';
let directory = '';
const originalLookup = _internals.findByBatchIdDetailed;

const BATCH_ID = 'arms-batch-1';
const LANE_ID = 'arms-lane';
const OTHER_LANE_ID = 'arms-other-lane';

function windowFor(itemIds: string[], laneId = LANE_ID) {
	return [
		{
			batchId: BATCH_ID,
			lanes: [
				{
					laneId,
					workflowLane: laneId,
					reviewItemIds: itemIds,
				},
			],
		},
	];
}

interface SeedArgs {
	mode?: string;
	prHeadSha?: string;
	laneId?: string;
	batchId?: string;
	status?: 'stale' | 'cancelled' | 'error' | 'completed';
	withLivenessClass?: boolean;
}

async function seedRecord({
	mode = 'swarm-pr-review:reviewer',
	prHeadSha = HEAD,
	laneId = LANE_ID,
	batchId = BATCH_ID,
	status = 'stale',
	withLivenessClass = true,
}: SeedArgs = {}): Promise<void> {
	const correlationId = `${batchId}-${laneId}-seed`;
	const reason = 'seeded terminality record';
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'arms-session',
		callID: `${batchId}-${laneId}-call`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode,
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory,
			gitHead: HEAD,
			dirtyHash: null,
			prHeadSha,
			scope: null,
		},
	});
	await appendDelegationTransition(directory, correlationId, {
		status,
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			...(withLivenessClass
				? { workflowLaneFailureClass: 'liveness' as const }
				: {}),
		},
	});
}

beforeEach(() => {
	directory = canonicalMkdtemp('verdict-settlement-arms-');
});

afterEach(() => {
	_internals.findByBatchIdDetailed = originalLookup;
});

describe('verdict settlement admission arms (issue #3101, review PRR-025)', () => {
	test('an uncertain delegation-store read fails closed (settlement keeps blocking)', () => {
		_internals.findByBatchIdDetailed = () => ({
			status: 'uncertain',
			attempts: 3,
			reason: 'store locked',
		});
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.reason).toMatch(/delegation store read was uncertain/);
		expect(admission.items).toEqual([]);
	});

	test('identity conjunction: a record with a mismatched mode is not admissible terminality evidence', async () => {
		await seedRecord({ mode: 'swarm-pr-review:critic' });
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.reason).toMatch(/non-admissible owner lane/);
	});

	test('identity conjunction: a record with a mismatched prHeadSha is not admissible terminality evidence', async () => {
		await seedRecord({ prHeadSha: 'other-head' });
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.reason).toMatch(/non-admissible owner lane/);
	});

	test('identity conjunction: a record whose laneId does not match the declaring lane is not admissible', async () => {
		await seedRecord({ laneId: OTHER_LANE_ID });
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.reason).toMatch(/non-admissible owner lane/);
	});

	test('a completed (non-liveness-terminal) owner record is refused even with the liveness class present', async () => {
		await seedRecord({ status: 'completed' });
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(false);
		// Issue #3311: a completed owner is a consumed attempt, never a
		// blocker - with a single batch the per-item budget arm refuses first;
		// with the budget met, the no-typed-dead-source arm refuses instead.
		expect(admission.reason).toMatch(
			/verdict retry budget not exhausted .1 of 3 required attempts./,
		);
	});

	test('cancelled and error terminal records map to their own disclosed terminalStatus values', async () => {
		// Per-item budget needs 1 + BUDGET distinct owner batches; seed one
		// terminal record per batch with the status under test.
		for (const [index, status] of (
			['cancelled', 'error', 'stale'] as const
		).entries()) {
			const batchId = `${BATCH_ID}-${index}`;
			await seedRecord({ batchId, status });
		}
		const window = [0, 1, 2].map((index) => ({
			batchId: `${BATCH_ID}-${index}`,
			lanes: [
				{
					laneId: LANE_ID,
					workflowLane: LANE_ID,
					reviewItemIds: ['X'],
				},
			],
		}));
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window,
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(true);
		expect(admission.items).toHaveLength(1);
		// The cited batch is the FIRST counted attempt, and its terminal status
		// is the one disclosed (cited-batch conjunction by construction).
		expect(admission.items[0]?.sourceBatchId).toBe(`${BATCH_ID}-0`);
		expect(admission.items[0]?.terminalStatus).toBe('cancelled');
	});

	test('a single owner batch never satisfies the per-item budget even when liveness-dead', async () => {
		await seedRecord({ status: 'cancelled' });
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.reason).toMatch(
			/verdict retry budget not exhausted \(1 of 3 required attempts\)/,
		);
	});

	test('parentSessionId scoping excludes foreign-session records from terminality evidence (review PRR-029)', async () => {
		// Seed the record under a FOREIGN parent session; the admission call
		// scopes its lookup to its own parent session, so the record must not
		// be found (fail closed) rather than silently counting foreign work.
		const correlationId = `${BATCH_ID}-${LANE_ID}-foreign`;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: 'foreign-session',
			callID: `${BATCH_ID}-${LANE_ID}-call`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: BATCH_ID,
			laneId: LANE_ID,
			mode: 'swarm-pr-review:reviewer',
			prReviewLegacyTranscriptCompatibility: true,
			workflowLane: LANE_ID,
			workspace: {
				directory,
				gitHead: HEAD,
				dirtyHash: null,
				prHeadSha: HEAD,
				scope: null,
			},
		});
		await appendDelegationTransition(directory, correlationId, {
			status: 'stale',
			result: {
				error: 'foreign liveness record',
				chars: 21,
				truncated: false,
				digest: createHash('sha256').update('x').digest('hex'),
				workflowLaneFailureClass: 'liveness',
			},
		});
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: windowFor(['X']),
			unclaimed: ['X'],
			parentSessionId: 'arms-session',
		});
		expect(admission.admitted).toBe(false);
		expect(admission.reason).toMatch(/non-admissible owner lane/);
	});

	test('receipt schema caps items at the writer/read contract bound (review PRR-023)', () => {
		const item = {
			itemId: 'X',
			sourceBatchId: 'b',
			sourceLaneId: 'l',
			disposition: 'liveness_dead' as const,
			evidenceClass: 'liveness' as const,
			terminalStatus: 'stale' as const,
		};
		const atCap = PrReviewVerdictSettlementReceiptSchema.safeParse({
			schemaVersion: 1,
			runId: 'r',
			prHeadSha: HEAD,
			revisionDigest: 'rev',
			phase: 'reviewer',
			items: Array.from({ length: 128 }, () => item),
		});
		expect(atCap.success).toBe(true);
		const overCap = PrReviewVerdictSettlementReceiptSchema.safeParse({
			schemaVersion: 1,
			runId: 'r',
			prHeadSha: HEAD,
			revisionDigest: 'rev',
			phase: 'reviewer',
			items: Array.from({ length: 129 }, () => item),
		});
		expect(overCap.success).toBe(false);
	});

	test('budget constant mirrors the documented 1 + 2 arithmetic', () => {
		expect(PR_REVIEW_VERDICT_RETRY_BUDGET).toBe(2);
	});
});

export type { BackgroundDelegationRecord };
