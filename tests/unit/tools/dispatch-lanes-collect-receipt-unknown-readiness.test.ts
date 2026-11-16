/**
 * Issue #3313 AC4 (trace C28, DISCRIMINATING) — a pending discovery lane
 * carrying a bound, schema-valid result receipt settles from that receipt
 * DURING collect_lane_results (readiness unknown, no assistant text), without
 * waiting for a terminal boundary. RED at base: the record is still `pending`
 * after collect (collectOnce's `!transcript.text` / unknown-readiness skips
 * fire before any settle step), so `expect(result.completed).toBe(1)` fails
 * (Expected: 1 / Received: 0). GREEN after the fix settles receipt-bearing
 * lanes through the #2865 exact-coverage validation.
 */

/**
 * Issues #3312/#3313 acceptance checks — settle a receipt-proven discovery
 * lane DURING collection, without waiting for a terminal transcript boundary.
 *
 * `collectOnce` (src/tools/dispatch-lanes.ts) skips a lane whose fetched
 * window holds no assistant text (`if (!transcript.text) continue;`) even when
 * the durable record already carries the child's exactly-once structured
 * result receipt (`record.result.prReviewResultReceipt`) — the same receipt
 * `settleCollectedLane` carries into its prospective result and re-adopts via
 * the issue #2865 re-read branch. A lane whose receipt landed but whose host
 * transcript is unreadable/empty therefore sits pending until the 30-minute
 * presumed-stale sweep even though its settlement is already proven durable.
 *
 * AC28 (discriminating): a pending swarm-pr-review:base discovery lane whose
 * record carries a bound, schema-valid receipt (publish admitted against the
 * live workflow identity), whose host session is ABSENT from the status map
 * (readiness 'unknown'), and whose fetched window has no assistant text, is
 * settled by collect_lane_results from the receipt during collection. At the
 * base tree this test FAILS: the record is still `pending` after the collect
 * run (failed:1 / completed:0, record.status 'pending').
 *
 * AC29 (preserving): the same shape but the receipt on the record is NOT bound
 * — its internal laneId belongs to another lane, so the exact identity binding
 * (gate validateExactStructuredReceiptCoverage: receipt.laneId ===
 * record.laneId) rejects it. The lane must STAY pending after collect; an
 * unbound receipt must never settle a lane. Green at the base tree.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	findByCorrelationId,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const BASE_SHA = '5f9144349970d5af3e2d46773599a1208a60ec01';
const HEAD_SHA = 'aa112233445566778899aabbccddeeff00112233';
const REVISION_DIGEST = 'd'.repeat(64);
const CREDITED_LANE = 'tests-falsifiability';
const UNRESOLVED_LANE = 'security-trust';
const PARENT = 'receipt-settle-parent-3312';

const originalInternals = { ..._internals };
const originalGateInternals = { ...gateInternals };
let directory = '';

beforeEach(async () => {
	directory = canonicalMkdtemp('collect-receipt-settle-3312-');
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStatsAsync = async () => ({
		changedLines: 2,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
	await activatePrWorkflow(directory, PARENT, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	await bindPrReviewBase(directory, PARENT, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: BASE_SHA,
	});
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	Object.assign(gateInternals, originalGateInternals);
	gateInternals.resetTrackedStateCache();
	_test_exports.resetDeliveredLaneOutputs();
	closeAllProjectDbs();
	for (let i = 0; ; i++) {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
			break;
		} catch (error) {
			if (i >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY') {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
});

async function workflowIdentity(): Promise<{
	instance: string;
	revision: number;
}> {
	const state = await readPrWorkflowGateState(directory, PARENT);
	expect(state).not.toBeNull();
	expect(state?.workflowInstanceId).toBeDefined();
	expect(state?.revision).toBeDefined();
	return { instance: state!.workflowInstanceId!, revision: state!.revision! };
}

function buildReceipt(args: {
	instance: string;
	revision: number;
	laneId: string;
	child: string;
}) {
	const envelope = {
		schemaVersion: 1 as const,
		outcome: 'INCOMPLETE' as const,
		creditedLanes: [CREDITED_LANE],
		findings: [
			{
				id: 'R-1',
				workflowLane: CREDITED_LANE,
				severity: 'HIGH' as const,
				riskImpact: 'ORDINARY' as const,
				riskTags: [],
				title: 'Receipt-settle regression finding',
				body: 'Receipt-backed collection settle probe.',
				evidence: 'Deterministic pre-collect receipt publish.',
				location: {
					kind: 'non_local' as const,
					label: 'receipt',
					detail: 'lane-settlement',
				},
			},
		],
		cleanAttestations: [],
		unresolved: [
			{
				workflowLane: UNRESOLVED_LANE,
				reason: 'RESOURCE_LIMIT' as const,
				detail: 'fixture-unresolved-lane',
			},
		],
	};
	return {
		schemaVersion: 1,
		mode: 'swarm-pr-review:base',
		workflowInstanceId: args.instance,
		workflowRevision: args.revision,
		batchId: 'receipt-settle-batch-3312',
		laneId: args.laneId,
		workflowLane: CREDITED_LANE,
		ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		dispatchRevisionDigest: REVISION_DIGEST,
		childSessionId: args.child,
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
	};
}

async function seedPendingDiscoveryLane(args: {
	instance: string;
	revision: number;
}): Promise<{ batchId: string; laneId: string; child: string }> {
	const batchId = 'receipt-settle-batch-3312';
	const laneId = 'receipt-settle-lane';
	const child = 'receipt-settle-child';
	const recorded = await recordPendingDelegation(directory, {
		correlationId: child,
		jobId: encodePrReviewWorkflowBinding(args.instance),
		subagentSessionId: child,
		parentSessionId: PARENT,
		callID: `call-${child}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: CREDITED_LANE,
		ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
		promptHash: 'prompt-hash-3312',
		workflowGeneration: args.revision,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: `complete PR diff ${BASE_SHA}...${HEAD_SHA}`,
		},
		generation: 1,
	});
	expect(recorded).not.toBeNull();
	return { batchId, laneId, child };
}

/**
 * Host transport for the AC28/AC29 shape: the child session is ABSENT from the
 * batched status map (readiness 'unknown') and its fetched window holds NO
 * assistant text — there is no terminal transcript boundary to wait for.
 */
function installTextlessWindowOps(): void {
	_test_exports.resetDeliveredLaneOutputs();
	_internals.getSessionOps = () => ({
		create: async () => ({ data: { id: 'unused' }, error: undefined }),
		prompt: async () => ({ data: null, error: undefined }),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status: async () => ({ data: {}, error: undefined }),
		messages: async () => ({
			data: [
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'dispatch prompt (no reply yet)' }],
				},
			],
			error: undefined,
		}),
	});
}

describe('collect_lane_results — receipt-proven discovery lanes settle during collection (#3312/#3313)', () => {
	test('AC28: a bound, schema-valid receipt settles the lane during collection with no assistant text in the window', async () => {
		const identity = await workflowIdentity();
		const { batchId, laneId, child } = await seedPendingDiscoveryLane(identity);
		const published = await publishPrReviewResultReceipt(directory, {
			parentSessionId: PARENT,
			childSessionId: child,
			batchId,
			laneId,
			expectedWorkflowInstanceId: identity.instance,
			expectedWorkflowRevision: identity.revision,
			expectedBaseSha: BASE_SHA,
			receipt: buildReceipt({
				instance: identity.instance,
				revision: identity.revision,
				laneId,
				child,
			}),
		});
		expect(published.status).toBe('recorded');
		installTextlessWindowOps();

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
			{ sessionID: PARENT },
		);

		// The receipt is the lane's exactly-once durable settlement proof: it
		// must be consumed DURING collection — the record goes terminal on the
		// receipt (existing receipt settle semantics) instead of waiting for a
		// terminal transcript boundary or the 30-minute stale horizon.
		// Base-tree failure signature (captured at 6c68fc7af): record.status
		// 'pending', result.completed 0 / result.pending 1.
		expect(result.completed).toBe(1);
		const record = findByCorrelationId(directory, child)!;
		expect(record.status).toBe('completed');
		expect(record.result?.prReviewResultReceipt).toBeDefined();
		expect(record.result?.error).toBeUndefined();
	});
});
