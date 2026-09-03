import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	findByBatchId,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { encodePrReviewWorkflowBinding } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	_test_exports as dispatchInternals,
	_internals as dispatchRuntimeInternals,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

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
let deliveredPrompts: string[] = [];
let createdSessions = 0;
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveDiffStats = _test_exports.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync =
	_test_exports.resolvePrReviewDiffStatsAsync;
const originalDispatchGetSessionOps = dispatchRuntimeInternals.getSessionOps;
const originalDispatchGeneratedAgentNames =
	dispatchRuntimeInternals.getGeneratedAgentNames;
const originalDispatchRevisionDigest =
	dispatchRuntimeInternals.resolvePrWorkflowRevisionDigestAsync;
const originalDispatchMergeBase =
	dispatchRuntimeInternals.resolveExactMergeBaseAsync;

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-corpus-transcript-');
	await initializeGitRepository(directory);
	deliveredPrompts = [];
	createdSessions = 0;
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	// Tier-M sized diff so a consolidated two-dimension lane may be admitted
	// (tier L forbids consolidation on the initial base wave).
	_test_exports.resolvePrReviewDiffStats = () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	_test_exports.resolvePrReviewDiffStatsAsync = async (...args) =>
		_test_exports.resolvePrReviewDiffStats(...args);
	dispatchRuntimeInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchRuntimeInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	dispatchRuntimeInternals.getGeneratedAgentNames = () => ['explorer'];
	const sessionOps: SessionOps = {
		create: mock(async () => ({
			data: { id: `transport-child-${++createdSessions}` },
			error: undefined,
		})),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async (args) => {
			deliveredPrompts.push(args.body.parts[0]?.text ?? '');
			return { data: undefined, error: undefined };
		}),
		delete: mock(async () => undefined),
	};
	dispatchRuntimeInternals.getSessionOps = () => sessionOps;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
	_test_exports.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
	dispatchRuntimeInternals.getSessionOps = originalDispatchGetSessionOps;
	dispatchRuntimeInternals.getGeneratedAgentNames =
		originalDispatchGeneratedAgentNames;
	dispatchRuntimeInternals.resolvePrWorkflowRevisionDigestAsync =
		originalDispatchRevisionDigest;
	dispatchRuntimeInternals.resolveExactMergeBaseAsync =
		originalDispatchMergeBase;
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
	await establishBoundWorkflow();
	const batchId = 'corpus-transcript-batch';
	const laneId = 'corpus-transcript-lane';
	// Admit the base batch through the registered enforcement path so the
	// gate state carries the live workflow instance/revision/base identity
	// the discovery settlement validates against (final-critic finding 3:
	// the corpus must prove the lane settles COMPLETED, not merely that the
	// receipt bytes survive).
	await enforcePrReviewBaseDimensions(
		directory,
		SESSION_ID,
		[
			{
				laneId,
				workflowLane: ownedLanes[0] as never,
				ownedWorkflowLanes: ownedLanes as never,
			},
		],
		{
			batchId,
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	if (!state?.workflowInstanceId) {
		throw new Error('base admission did not persist workflow provenance');
	}
	await recordPendingDelegation(directory, {
		correlationId: CHILD_SESSION,
		jobId: encodePrReviewWorkflowBinding(state.workflowInstanceId),
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
		workflowGeneration: state.revision,
	});
	return { batchId, laneId };
}

async function establishBoundWorkflow(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	await bindPrReviewBase(directory, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: BASE_SHA,
	});
}

async function advanceWorkflowRevision(): Promise<void> {
	await withSessionStateMutation(directory, SESSION_ID, async () => {
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		if (!state) throw new Error('missing active workflow state');
		await writeStateWhileLocked(directory, {
			...state,
			updatedAt: '2026-01-01T00:00:00.000Z',
		});
	});
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
 * Replay the LATER transcript evidence as the CHILD'S ORDINARY COMPLETION
 * EVENT (the production transport that settles a receipted lane):
 * `claimTerminalResult` carries the transcript-shaped result — prose after
 * CLEAN, or a truncated transcript — and must settle the lane COMPLETED
 * with the accepted receipt preserved (issue #2384 contract; final-critic
 * finding 3: the corpus asserts `completed`, not merely receipt survival).
 */
async function settleViaCompletionEvent(transcript: {
	text: string;
	truncated: boolean;
}): Promise<void> {
	const { claimTerminalResult } = await import(
		'../../../src/background/pending-delegations.js'
	);
	const claimed = await claimTerminalResult(directory, CHILD_SESSION, {
		eventId: `corpus-completion-${transcript.truncated ? 'trunc' : 'prose'}`,
		status: 'completed',
		recordedAt: 42,
		result: {
			text: transcript.text,
			chars: transcript.text.length,
			truncated: transcript.truncated,
			digest: 'f'.repeat(64),
		},
	});
	expect(claimed?.disposition).toBe('claimed');
}

const PROSE_AFTER_CLEAN = [
	'The diff looks good overall; no issues found in this area.',
	'I also double-checked the edge cases mentioned in the PR description.',
].join(' \\n ');

describe('replay corpus: structured receipts cannot be downgraded by later transcript parsing (#2380 shapes 5-6)', () => {
	test('production dispatch delivers provenance and settles through the child tool path', async () => {
		await establishBoundWorkflow();
		const batchId = 'transport-provenance-batch';
		const result = await executeDispatchLanesAsync(
			{
				batch_id: batchId,
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
					id: `transport-${workflowLane}`,
					agent: 'explorer',
					prompt: `Review ${workflowLane} on the exact bound revision.`,
					workflow_lane: workflowLane,
				})),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result.success).toBe(true);
		expect(deliveredPrompts).toHaveLength(6);
		const records = findByBatchId(directory, batchId);
		expect(records).toHaveLength(6);
		for (const record of records) {
			expect(record.correlationId).toBe(record.subagentSessionId);
			expect(deliveredPrompts.join('\n')).toContain(`batch_id: ${batchId}`);
			expect(deliveredPrompts.join('\n')).toContain(
				`lane_id: ${record.laneId}`,
			);
		}
		const firstRecord = records[0];
		if (!firstRecord?.workflowLane) throw new Error('missing workflow lane');
		const submitted = JSON.parse(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: 1,
					revisionDigest: REVISION_DIGEST,
					result: cleanEnvelope(
						[firstRecord.workflowLane],
						[
							{
								workflowLane: firstRecord.workflowLane,
								coverageScope: 'complete bound transport-dispatched lane',
								evidence:
									'production prompt transport rendered authenticated provenance',
							},
						],
					),
				},
				directory,
				{ sessionID: firstRecord.subagentSessionId },
			),
		) as { success: boolean; status?: string };
		expect(submitted).toMatchObject({ success: true, status: 'recorded' });
		const settled = findByCorrelationId(
			directory,
			firstRecord.subagentSessionId,
		);
		expect(settled?.result?.prReviewResultReceipt?.batchId).toBe(batchId);
		expect(settled?.result?.prReviewResultReceipt?.laneId).toBe(
			firstRecord.laneId,
		);
	});

	test('rendered child contract exposes provenance and authenticated child can omit guessed IDs', async () => {
		const { batchId, laneId } = await establishWorkflowAndLane([
			'intent-architecture',
		]);
		const rendered = dispatchInternals.applyPrWorkflowPromptContract(
			[
				{
					id: laneId,
					agent: 'explorer',
					prompt: 'Inspect the exact bound review scope.',
					workflow_lane: 'intent-architecture',
				},
			],
			{
				mode: 'swarm-pr-review:base',
				batchId,
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION_DIGEST,
			},
		);
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) throw new Error('expected a rendered child contract');
		expect(rendered.lanes[0]?.prompt).toContain(`batch_id: ${batchId}`);
		expect(rendered.lanes[0]?.prompt).toContain(`lane_id: ${laneId}`);
		const submitted = JSON.parse(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: 1,
					revisionDigest: REVISION_DIGEST,
					result: cleanEnvelope(
						['intent-architecture'],
						[
							{
								workflowLane: 'intent-architecture',
								coverageScope: 'complete bound diff',
								evidence: 'rendered contract and exact child ledger binding',
							},
						],
					),
				},
				directory,
				{ sessionID: CHILD_SESSION },
			),
		) as { success: boolean; status?: string };
		expect(submitted).toMatchObject({ success: true, status: 'recorded' });
		const settled = findByCorrelationId(directory, CHILD_SESSION);
		expect(settled?.result?.prReviewResultReceipt?.batchId).toBe(batchId);
		expect(settled?.result?.prReviewResultReceipt?.laneId).toBe(laneId);
	});

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
		await settleViaCompletionEvent({
			text: PROSE_AFTER_CLEAN,
			truncated: false,
		});

		const record = findByCorrelationId(directory, CHILD_SESSION);
		// The lane settles COMPLETED and the structured receipt remains the
		// authoritative result — the later prose can neither erase, downgrade,
		// nor terminalize it (pre-#2384, prose parsing invalidated an
		// accepted CLEAN result).
		expect(record?.status).toBe('completed');
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

		await settleViaCompletionEvent({
			text: PROSE_AFTER_CLEAN.slice(0, 40),
			truncated: true,
		});

		const record = findByCorrelationId(directory, CHILD_SESSION);
		expect(record?.status).toBe('completed');
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
		await advanceWorkflowRevision();
		const replay = await submitClean(args);
		expect(replay.status).toBe('duplicate');
	});
});
