/**
 * Issue #3312 (AC15) — cross-lane duplicate finding-id rejection at receipt
 * publication.
 *
 * `publishPrReviewResultReceipt` (src/background/pending-delegations.ts)
 * validates the receipt schema and rechecks immutable delegation identity
 * under the store lock, but performs NO workflow-level duplicate
 * candidate/finding-id check: uniqueness is enforced per-envelope only
 * (assertUniqueStrings in src/background/pr-review-contract.ts), so the first
 * workflow-level duplicate surfaces downstream as the FATAL gate
 * assertNoDuplicates refusal (src/hooks/pr-workflow-gate.ts) after the
 * conflicting receipt is already durable.
 *
 * POST-FIX CONTRACT under test: after schema + identity validation and under
 * the existing store lock, publishing a receipt whose envelope.findings[].id
 * collides with a finding id already recorded by a DIFFERENT lane's receipt
 * (same workflowInstanceId, different laneId) is rejected with the existing
 * `{status: 'conflict', reason}` outcome — the reason is prefixed
 * 'duplicate id' and names the duplicated id plus the owning lane — and the
 * receipt is NOT recorded. A distinct finding id on another lane still
 * publishes.
 *
 * DISCRIMINATING at base: the colliding lane-B publish returns
 * 'recorded' (not 'conflict'), so the `expect(...).toBe('conflict')`
 * assertion fails with:
 *   error: expect(received).toBe('conflict') // Object.is equality
 *   Received: 'recorded'
 *
 * Schema field names: the receipt carries no separate "candidates" array —
 * the id surface is `envelope.findings[].id` (PrReviewResultFindingSchema,
 * pr-review-contract.ts); this test uses that real field name.
 *
 * Reuses the seeding/publish patterns of the AC16 floor
 * tests/unit/background/pr-review-result-receipt-lifecycle.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	findByCorrelationId,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
	type PrReviewResultFinding,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const WORKFLOW_INSTANCE_ID = 'wf-3312';
const WORKFLOW_REVISION = 3;
const PARENT_SESSION_ID = 'parent-3312';
const BASE_SHA = 'ab'.repeat(20);
const HEAD_SHA = 'cd'.repeat(20);
const DISPATCH_REVISION_DIGEST = '0d'.repeat(32);

interface SeededLane {
	childSessionId: string;
	batchId: string;
	laneId: string;
	workflowLane:
		| 'intent-architecture'
		| 'security-trust'
		| 'reliability-performance';
}

const LANE_A: SeededLane = {
	childSessionId: 'child-3312-a',
	batchId: 'batch-3312-a',
	laneId: 'lane-3312-a',
	workflowLane: 'intent-architecture',
};

const LANE_B: SeededLane = {
	childSessionId: 'child-3312-b',
	batchId: 'batch-3312-b',
	laneId: 'lane-3312-b',
	workflowLane: 'security-trust',
};

/** Control lane: never reuses an id, must always publish. */
const LANE_C: SeededLane = {
	childSessionId: 'child-3312-c',
	batchId: 'batch-3312-c',
	laneId: 'lane-3312-c',
	workflowLane: 'reliability-performance',
};

function finding(
	id: string,
	workflowLane: SeededLane['workflowLane'],
): PrReviewResultFinding {
	return {
		id,
		workflowLane,
		severity: 'HIGH',
		riskImpact: 'ORDINARY',
		riskTags: [],
		title: `Finding ${id} title`,
		body: `Finding ${id} describes a defect inside the lane's owned scope.`,
		evidence: `Finding ${id} evidence captured from the changed diff.`,
		location: { kind: 'local', file: 'src/review.ts', line: 12 },
	};
}

function receiptFor(lane: SeededLane, findingIds: readonly string[]) {
	const envelope: PrReviewLaneResultEnvelope = {
		schemaVersion: 1,
		outcome: 'FINDINGS',
		creditedLanes: [lane.workflowLane],
		findings: findingIds.map((id) => finding(id, lane.workflowLane)),
		cleanAttestations: [],
		unresolved: [],
	};
	return {
		schemaVersion: 1 as const,
		mode: 'swarm-pr-review:base' as const,
		workflowInstanceId: WORKFLOW_INSTANCE_ID,
		workflowRevision: WORKFLOW_REVISION,
		batchId: lane.batchId,
		laneId: lane.laneId,
		workflowLane: lane.workflowLane,
		ownedWorkflowLanes: [lane.workflowLane],
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		dispatchRevisionDigest: DISPATCH_REVISION_DIGEST,
		childSessionId: lane.childSessionId,
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
	};
}

async function seedLane(directory: string, lane: SeededLane): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: lane.childSessionId,
		jobId: encodePrReviewWorkflowBinding(WORKFLOW_INSTANCE_ID),
		subagentSessionId: lane.childSessionId,
		parentSessionId: PARENT_SESSION_ID,
		callID: `call-${lane.laneId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: lane.batchId,
		laneId: lane.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: lane.workflowLane,
		ownedWorkflowLanes: [lane.workflowLane],
		workflowGeneration: WORKFLOW_REVISION,
		generation: 1,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
}

function publicationInput(lane: SeededLane, receipt: unknown) {
	return {
		parentSessionId: PARENT_SESSION_ID,
		childSessionId: lane.childSessionId,
		batchId: lane.batchId,
		laneId: lane.laneId,
		expectedWorkflowInstanceId: WORKFLOW_INSTANCE_ID,
		expectedWorkflowRevision: WORKFLOW_REVISION,
		expectedBaseSha: BASE_SHA,
		receipt,
	};
}

describe('PR-review receipt publish rejects cross-lane duplicate finding ids (#3312 AC15)', () => {
	test('a finding id already owned by another lane is rejected and never recorded', async () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-dup-ids-');
		try {
			fs.mkdirSync(path.join(safe.dir, '.opencode'), { recursive: true });
			fs.mkdirSync(path.join(safe.dir, '.swarm'), { recursive: true });
			await seedLane(safe.dir, LANE_A);
			await seedLane(safe.dir, LANE_B);
			await seedLane(safe.dir, LANE_C);

			// Lane A publishes first and owns finding ids X and Y.
			const first = await publishPrReviewResultReceipt(
				safe.dir,
				publicationInput(
					LANE_A,
					receiptFor(LANE_A, ['finding-X', 'finding-Y']),
				),
			);
			expect(first.status).toBe('recorded');
			expect(
				findByCorrelationId(safe.dir, LANE_A.childSessionId)?.result
					?.prReviewResultReceipt?.laneId,
			).toBe(LANE_A.laneId);

			// Control: a DISTINCT finding id on another lane of the same workflow
			// still publishes (guards the false-positive direction of the check).
			const control = await publishPrReviewResultReceipt(
				safe.dir,
				publicationInput(LANE_C, receiptFor(LANE_C, ['finding-Z'])),
			);
			expect(control.status).toBe('recorded');

			// DISCRIMINATING: lane B's receipt reuses lane A's finding-X under the
			// same workflowInstanceId with a different laneId. Post-fix this is a
			// rejection whose reason names the duplicate id and the owning lane.
			const rejected = await publishPrReviewResultReceipt(
				safe.dir,
				publicationInput(LANE_B, receiptFor(LANE_B, ['finding-X'])),
			);
			expect(rejected.status).toBe('conflict');
			if (rejected.status === 'conflict') {
				expect(rejected.reason).toMatch(/duplicate id/i);
				expect(rejected.reason).toContain('finding-X');
				expect(rejected.reason).toContain(LANE_A.laneId);
			}

			// The rejected receipt must not be recorded on lane B's delegation.
			expect(
				findByCorrelationId(safe.dir, LANE_B.childSessionId)?.result
					?.prReviewResultReceipt,
			).toBeUndefined();
			// Lane A's recorded receipt is untouched by the rejection.
			expect(
				findByCorrelationId(safe.dir, LANE_A.childSessionId)?.result
					?.prReviewResultReceipt?.laneId,
			).toBe(LANE_A.laneId);
		} finally {
			safe.cleanup();
		}
	});
});
