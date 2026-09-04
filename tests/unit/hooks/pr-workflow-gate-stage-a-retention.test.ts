import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	prWorkflowSessionFileStem,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';

/**
 * Issue #1968 P5a: re-recording Stage A used to wipe every already-proven
 * independent gate batch unconditionally, so a re-attestation on an unchanged
 * revision forced all four PR_FEEDBACK phases to re-dispatch. Retention is bound
 * to Stage A *equivalence*, not to the digest alone — `applicableObligations`
 * and `applicableCategories` are caller-supplied and validated only for internal
 * self-consistency, so an unchanged digest can still carry a NARROWER
 * attestation, and a gate proved against the wider one is no longer evidence for
 * what is being attested now.
 */

const SESSION_ID = 'feedback-stage-a-retention';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const NEXT_REVISION = 'revision-2';
const ITEM_ID = 'FB-001';

let directory = '';
let currentRevision = REVISION;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveRevision = gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolveCurrentUpstreamPushTarget =
	gateInternals.resolveCurrentUpstreamPushTarget;
const originalResolveCurrentUpstreamPushTargetAsync =
	gateInternals.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHead =
	gateInternals.resolveRemoteRefsContainingHead;
const originalResolveRemoteRefsContainingHeadAsync =
	gateInternals.resolveRemoteRefsContainingHeadAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-stage-a-')),
	);
	currentRevision = REVISION;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolvePrWorkflowRevisionDigest = () => currentRevision;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-branch',
		remoteTrackingRef: 'refs/remotes/origin/pr-branch',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		gateInternals.resolveCurrentUpstreamPushTarget(dir);
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-branch',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async (...args) =>
		gateInternals.resolveRemoteRefsContainingHead(...args);
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolveCurrentUpstreamPushTarget =
		originalResolveCurrentUpstreamPushTarget;
	gateInternals.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	gateInternals.resolveRemoteRefsContainingHead =
		originalResolveRemoteRefsContainingHead;
	gateInternals.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistLaneArtifact(options: {
	batchId: string;
	laneId: string;
	mode: string;
	role: string;
	text: string;
	revisionDigest: string;
}): Promise<void> {
	const correlationId = `${options.batchId}--${options.laneId}`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: options.role,
		swarmPrefixedAgent: options.role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId: options.batchId,
		laneId: options.laneId,
		mode: options.mode,
		workflowLane: options.laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: options.revisionDigest,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: options.batchId,
		laneId: options.laneId,
		agent: options.role,
		role: options.role,
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: options.mode,
		workflowLane: options.laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: options.revisionDigest,
		source: 'collect_lane_results',
		text: options.text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'completed',
		result: {
			text: options.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

async function settleVerification(
	batchId: string,
	revisionDigest: string,
): Promise<void> {
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION_ID,
		[{ laneId: 'verify', ownedItemIds: [ITEM_ID] }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistLaneArtifact({
		batchId,
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		role: 'reviewer',
		text: `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`,
		revisionDigest,
	});
}

interface StageAObligation {
	id: string;
	category: 'build';
	workingDirectory: string;
	source: string;
	validatorContract?: { path: string; id: string };
}

function obligations(ids: readonly string[]): StageAObligation[] {
	return ids.map((id) => ({
		id,
		category: 'build' as const,
		workingDirectory: '.',
		source: `manual:${id}`,
	}));
}

/**
 * Receipts that exactly satisfy `declared`. `recordPrFeedbackStageA` demands
 * that each receipt's category, working directory and validator contract match
 * its obligation, so this is derived from the obligations rather than hardcoded
 * — otherwise a test that varies an obligation field would be rejected by that
 * consistency check long before retention was consulted.
 */
function checksForObligations(declared: readonly StageAObligation[]) {
	return [
		{
			category: 'diff-check' as const,
			command: ['git', 'diff', '--check'],
			durationMs: 1,
		},
		{
			category: 'reproduction' as const,
			command: ['test', 'regression'],
			targets: ['regression'],
			feedbackTargets: [
				{
					feedbackItemId: ITEM_ID,
					target: 'regression',
					expectedBehavior: 'regression stays fixed',
				},
			],
			durationMs: 1,
		},
		...declared.map((obligation) => ({
			category: obligation.category,
			command: ['build', obligation.id],
			obligationId: obligation.id,
			workingDirectory: obligation.workingDirectory,
			...(obligation.validatorContract
				? { validatorContract: obligation.validatorContract }
				: {}),
			durationMs: 1,
		})),
	];
}

function checks(obligationIds: readonly string[]) {
	return checksForObligations(obligations(obligationIds));
}

async function recordStageAWith(
	revisionDigest: string,
	declared: readonly StageAObligation[],
) {
	return recordPrFeedbackStageA(
		directory,
		SESSION_ID,
		revisionDigest,
		checksForObligations(declared),
		{
			applicableCategories: ['build'],
			applicableObligations: declared,
		},
	);
}

async function recordStageA(
	revisionDigest: string,
	obligationIds: readonly string[],
) {
	return recordStageAWith(revisionDigest, obligations(obligationIds));
}

/** Activate, settle verification, record Stage A, and prove one gate phase. */
async function armOneGateBatchWith(
	declared: readonly StageAObligation[],
): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(directory, SESSION_ID, [ITEM_ID], {
		prHeadSha: HEAD_SHA,
	});
	await settleVerification('verify-1', REVISION);
	await recordStageAWith(REVISION, declared);
	await recordPrFeedbackGateBatch(
		directory,
		SESSION_ID,
		'stage-b-reviewer',
		{ laneId: 'stage-b-reviewer', ownedItemIds: [ITEM_ID] },
		{
			batchId: 'gate-review',
			prHeadSha: HEAD_SHA,
			revisionDigest: REVISION,
		},
	);
	await persistLaneArtifact({
		batchId: 'gate-review',
		laneId: 'stage-b-reviewer',
		mode: 'swarm-pr-feedback:stage-b-reviewer',
		role: 'reviewer',
		text: `[STAGE-B-REVIEW] | ${ITEM_ID} | APPROVE | evidence`,
		revisionDigest: REVISION,
	});
}

async function armOneGateBatch(
	obligationIds: readonly string[],
): Promise<void> {
	await armOneGateBatchWith(obligations(obligationIds));
}

const BASE_OBLIGATION: StageAObligation = {
	id: 'OBL-A',
	category: 'build',
	workingDirectory: '.',
	source: 'manual:OBL-A',
};
const CONTRACTED_OBLIGATION: StageAObligation = {
	...BASE_OBLIGATION,
	validatorContract: { path: 'contracts/validators.json', id: 'build-a' },
};

/**
 * Every field `canonicalStageAObligation` folds in besides `id` and `category`
 * — `category` is separately pinned by the receipt-consistency check above, so
 * it cannot be varied here in isolation. Each row keeps the obligation `id`
 * FIXED and changes exactly one other field: identity by id alone would read
 * every one of these as "the same obligation, still attested" and retain gate
 * evidence proved against an obligation that no longer exists.
 */
const NON_ID_IDENTITY_FIELDS: ReadonlyArray<{
	field: string;
	before: StageAObligation;
	after: StageAObligation;
}> = [
	{
		field: 'source',
		before: BASE_OBLIGATION,
		after: { ...BASE_OBLIGATION, source: 'pr-validation:OBL-A' },
	},
	{
		field: 'workingDirectory',
		before: BASE_OBLIGATION,
		after: { ...BASE_OBLIGATION, workingDirectory: 'packages/app' },
	},
	{
		field: 'validatorContract.path',
		before: CONTRACTED_OBLIGATION,
		after: {
			...CONTRACTED_OBLIGATION,
			validatorContract: { path: 'contracts/other.json', id: 'build-a' },
		},
	},
	{
		field: 'validatorContract.id',
		before: CONTRACTED_OBLIGATION,
		after: {
			...CONTRACTED_OBLIGATION,
			validatorContract: { path: 'contracts/validators.json', id: 'build-b' },
		},
	},
	{
		field: 'validatorContract (added)',
		before: BASE_OBLIGATION,
		after: CONTRACTED_OBLIGATION,
	},
	{
		field: 'validatorContract (removed)',
		before: CONTRACTED_OBLIGATION,
		after: BASE_OBLIGATION,
	},
];

describe('PR_FEEDBACK Stage A gate-batch retention', () => {
	for (const { field, before, after } of NON_ID_IDENTITY_FIELDS) {
		test(`the same obligation id with a different ${field} wipes gate batches`, async () => {
			await armOneGateBatchWith([before]);
			const state = await recordStageAWith(REVISION, [after]);
			expect(state.prFeedbackGateBatches).toEqual([]);
		});
	}

	test('an obligation identical in every canonical field retains gate batches', async () => {
		// Positive control for the table above: a fresh object with the same
		// values retains, so each wipe there is attributable to the one field
		// that changed and not to object identity or re-recording itself.
		await armOneGateBatchWith([CONTRACTED_OBLIGATION]);
		const state = await recordStageAWith(REVISION, [
			{
				...CONTRACTED_OBLIGATION,
				validatorContract: { ...CONTRACTED_OBLIGATION.validatorContract! },
			},
		]);
		expect(state.prFeedbackGateBatches?.map((batch) => batch.batchId)).toEqual([
			'gate-review',
		]);
	});

	test('an identical re-attestation on the same revision retains gate batches', async () => {
		await armOneGateBatch(['OBL-A']);
		const state = await recordStageA(REVISION, ['OBL-A']);
		expect(state.prFeedbackGateBatches?.map((batch) => batch.batchId)).toEqual([
			'gate-review',
		]);
	});

	test('a widened re-attestation on the same revision retains gate batches', async () => {
		await armOneGateBatch(['OBL-A']);
		const state = await recordStageA(REVISION, ['OBL-A', 'OBL-B']);
		expect(state.prFeedbackGateBatches?.map((batch) => batch.batchId)).toEqual([
			'gate-review',
		]);
		expect(state.prFeedbackStageA?.applicableObligations).toHaveLength(2);
	});

	test('a NARROWED re-attestation on the same revision wipes gate batches', async () => {
		await armOneGateBatch(['OBL-A', 'OBL-B']);
		const state = await recordStageA(REVISION, ['OBL-A']);
		expect(state.prFeedbackGateBatches).toEqual([]);
	});

	test('a narrowed applicable-category set on the same revision wipes gate batches', async () => {
		await armOneGateBatch(['OBL-A']);
		// Same obligations, but the caller no longer attests the lint category.
		// The prior gate batch was proved against the wider attestation.
		const state = await recordPrFeedbackStageA(
			directory,
			SESSION_ID,
			REVISION,
			[
				...checks(['OBL-A']),
				{ category: 'lint' as const, command: ['lint'], durationMs: 1 },
			],
			{
				applicableCategories: ['build', 'lint'],
				applicableObligations: obligations(['OBL-A']),
			},
		);
		expect(state.prFeedbackGateBatches?.map((batch) => batch.batchId)).toEqual([
			'gate-review',
		]);
		const narrowed = await recordStageA(REVISION, ['OBL-A']);
		expect(narrowed.prFeedbackGateBatches).toEqual([]);
	});

	test('a changed revision wipes gate batches even with an identical attestation', async () => {
		await armOneGateBatch(['OBL-A']);
		currentRevision = NEXT_REVISION;
		await settleVerification('verify-2', NEXT_REVISION);
		const state = await recordStageA(NEXT_REVISION, ['OBL-A']);
		expect(state.prFeedbackGateBatches).toEqual([]);
	});

	test('retention never keeps an armed publication', async () => {
		await armOneGateBatch(['OBL-A']);
		const state = await recordStageA(REVISION, ['OBL-A']);
		expect(state.prFeedbackReadyToPublish).toBeUndefined();
	});

	test('a legacy Stage A record without an attestation cannot prove non-narrowing', async () => {
		// Issue #1968 FIX 6. Both attestation keys are optional in the schema, so a
		// record written by an older plugin carries neither. Defaulting them to []
		// made the superset check vacuously true and retained gate approvals across
		// an attestation that may have narrowed arbitrarily.
		await armOneGateBatch(['OBL-A', 'OBL-B']);
		const statePath = path.join(
			directory,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8'));
		delete persisted.prFeedbackStageA.applicableCategories;
		delete persisted.prFeedbackStageA.applicableObligations;
		await writeAuthoritativePrWorkflowState(
			directory,
			persisted as {
				sessionID: string;
				revision: number;
				mode: string;
				[key: string]: unknown;
			},
		);
		gateInternals.resetTrackedStateCache();

		// Same revision, and an attestation that is a superset of nothing — but the
		// prior one is unknown, so non-narrowing is unprovable and the gate batches
		// must be wiped rather than carried across.
		const state = await recordStageA(REVISION, ['OBL-A', 'OBL-B']);
		expect(state.prFeedbackGateBatches).toEqual([]);
	});
});
