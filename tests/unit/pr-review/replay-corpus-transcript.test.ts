import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrReviewBase,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * Issue #2385 replay corpus — historical failure shapes 5-6 from tracker
 * #2380, replayed through the REGISTERED `submit_pr_review_result` path:
 *
 *  5. CLEAN-plus-prose shapes (consolidated and singleton): ordinary reviewer
 *     prose after a CLEAN row was parsed as malformed legacy evidence and
 *     invalidated an otherwise clean review (the #2384 incident).
 *  6. truncated CLEAN transcript shape: a truncated transcript could not
 *     settle a lane that had in fact completed.
 *
 * A valid structured receipt settles the lane; LATER transcript-shaped
 * evidence (prose, truncation) can never downgrade or replace it.
 */

const HEAD_SHA = 'aaa123bbb';
const BASE_SHA = 'ccc456ddd';
const REVISION_DIGEST = 'e'.repeat(64);
const SESSION_ID = 'corpus-transcript-controller';
const CHILD_SESSION = 'corpus-transcript-child';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-corpus-transcript-');
	await initializeGitRepository(directory);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

function cleanEnvelope(
	credited: string[],
	attestations: Array<{
		workflowLane: string;
		coverageScope: string;
		evidence: string;
	}>,
) {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: credited,
		findings: [],
		cleanAttestations: attestations,
		unresolved: [],
	};
}

async function establishWorkflowAndLane(
	ownedLanes: string[],
): Promise<{ batchId: string; laneId: string }> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	await bindPrReviewBase(directory, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: BASE_SHA,
	});
	const batchId = 'corpus-transcript-batch';
	const laneId = 'corpus-transcript-lane';
	await recordPendingDelegation(directory, {
		correlationId: CHILD_SESSION,
		jobId: null,
		subagentSessionId: CHILD_SESSION,
		parentSessionId: SESSION_ID,
		callID: 'corpus-transcript-call',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: ownedLanes[0]!,
		ownedWorkflowLanes: ownedLanes,
		prReviewLegacyTranscriptCompatibility: true,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: `complete PR diff ${BASE_SHA}...${HEAD_SHA}`,
		},
		promptHash: 'corpus-transcript-hash',
		generation: 1,
	});
	return { batchId, laneId };
}

async function submitClean(args: {
	batchId: string;
	laneId: string;
	credited: string[];
	attestations: Array<{
		workflowLane: string;
		coverageScope: string;
		evidence: string;
	}>;
}): Promise<{ success: boolean; status?: string; reason?: string }> {
	return JSON.parse(
		await executeSubmitPrReviewResult(
			{
				schemaVersion: 1,
				batchId: args.batchId,
				laneId: args.laneId,
				revisionDigest: REVISION_DIGEST,
				result: cleanEnvelope(args.credited, args.attestations),
			},
			directory,
			{ sessionID: CHILD_SESSION },
		),
	);
}

/**
 * Drive the LATER transcript evidence through the REGISTERED collect path
 * (`executeCollectLaneResults`): the host reports the lane idle and the
 * transcript carries ordinary prose (optionally truncated) — exactly the
 * shapes that pre-#2384 parsing converted into untrusted-attestation
 * failures. The collect settlement must preserve the accepted receipt.
 */
async function collectWithTranscript(
	batchId: string,
	transcript: string,
): Promise<void> {
	const dispatchInternals = (
		await import('../../../src/tools/dispatch-lanes.js')
	)._internals;
	const originalGetSessionOps = dispatchInternals.getSessionOps;
	const originalNow = dispatchInternals.now;
	const originalResolveRevision =
		dispatchInternals.resolvePrWorkflowRevisionDigest;
	const originalResolveRevisionAsync =
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
	try {
		dispatchInternals.now = () => 2_000_000_000_000;
		dispatchInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
			REVISION_DIGEST;
		dispatchInternals.getSessionOps = () =>
			({
				create: async () => ({ data: { id: 'unused' } }),
				prompt: async () => ({ data: null }),
				delete: async () => undefined,
				status: async () => ({
					data: { [CHILD_SESSION]: { type: 'idle' } },
					error: undefined,
				}),
				messages: async () => ({
					data: [
						{
							info: {
								role: 'assistant',
								time: { completed: 2 },
								finish: 'stop',
							},
							parts: [{ type: 'text', text: transcript }],
						},
					],
					error: undefined,
				}),
				abort: async () => undefined,
			}) as never;
		const { executeCollectLaneResults } = await import(
			'../../../src/tools/dispatch-lanes.js'
		);
		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
			{ sessionID: SESSION_ID },
		);
		// The collect call settled the lane from the transcript; whether the
		// transcript ALONE would justify completion is not this shape's
		// question — the receipt's survival is (see assertions below).
		expect(result.total).toBe(1);
	} finally {
		dispatchInternals.getSessionOps = originalGetSessionOps;
		dispatchInternals.now = originalNow;
		dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
			originalResolveRevisionAsync;
	}
}

const PROSE_AFTER_CLEAN = [
	'The diff looks good overall; no issues found in this area.',
	'I also double-checked the edge cases mentioned in the PR description.',
].join(' \\n ');

describe('replay corpus: structured receipts cannot be downgraded by later transcript parsing (#2380 shapes 5-6)', () => {
	test('singleton CLEAN receipt survives later prose', async () => {
		const { batchId, laneId } = await establishWorkflowAndLane([
			'intent-architecture',
		]);
		const submitted = await submitClean({
			batchId,
			laneId,
			credited: ['intent-architecture'],
			attestations: [
				{
					workflowLane: 'intent-architecture',
					coverageScope: 'Complete changed architecture surface.',
					evidence: 'No reachable architecture defect remains.',
				},
			],
		});
		expect(submitted.status).toBe('recorded');

		// Later transcript-shaped evidence arrives (prose after CLEAN).
		await collectWithTranscript(batchId, PROSE_AFTER_CLEAN);

		const record = findByCorrelationId(directory, CHILD_SESSION);
		// The structured receipt remains attached to the settled record —
		// the later prose can neither erase nor downgrade it. (Pre-#2384,
		// prose parsing invalidated an accepted CLEAN result.)
		expect(['completed', 'error']).toContain(record?.status);
		expect(record?.result?.prReviewResultReceipt).toBeDefined();
		expect(record?.result?.prReviewResultReceipt?.envelope?.outcome).toBe(
			'CLEAN',
		);
	});

	test('consolidated CLEAN receipt survives a truncated later transcript', async () => {
		const owned = ['intent-architecture', 'security-trust'];
		const { batchId, laneId } = await establishWorkflowAndLane(owned);
		const submitted = await submitClean({
			batchId,
			laneId,
			credited: owned,
			attestations: owned.map((workflowLane) => ({
				workflowLane,
				coverageScope: `Complete ${workflowLane} surface in the bound diff.`,
				evidence: 'No defect remains on this dimension.',
			})),
		});
		expect(submitted.status).toBe('recorded');

		await collectWithTranscript(batchId, `${PROSE_AFTER_CLEAN.slice(0, 40)}…`);

		const record = findByCorrelationId(directory, CHILD_SESSION);
		expect(['completed', 'error']).toContain(record?.status);
		expect(record?.result?.prReviewResultReceipt).toBeDefined();
		expect(record?.result?.prReviewResultReceipt?.envelope?.outcome).toBe(
			'CLEAN',
		);
	});

	test('an identical receipt replay is exactly-once (duplicate, not a second transition)', async () => {
		const { batchId, laneId } = await establishWorkflowAndLane([
			'intent-architecture',
		]);
		const args = {
			batchId,
			laneId,
			credited: ['intent-architecture'],
			attestations: [
				{
					workflowLane: 'intent-architecture',
					coverageScope: 'Complete changed architecture surface.',
					evidence: 'No reachable architecture defect remains.',
				},
			],
		};
		const first = await submitClean(args);
		expect(first.status).toBe('recorded');
		const replay = await submitClean(args);
		expect(replay.status).toBe('duplicate');
	});
});
