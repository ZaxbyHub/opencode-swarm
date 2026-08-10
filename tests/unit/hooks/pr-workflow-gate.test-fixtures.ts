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
	_test_exports,
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';

export const SESSION_ID = 'session-123';
export const HEAD_SHA = 'abc123';
export const REVISION_DIGEST = 'revision-test';
/** Merge-base used by fixtures that call bindPrReviewBase. */
export const PR_REVIEW_BASE_SHA = 'def456';
/** Scope every persisted artifact must carry once a fixture binds a base. */
export const PR_REVIEW_SCOPE = `complete PR diff ${PR_REVIEW_BASE_SHA}...${HEAD_SHA}`;
const BASE_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
const MICRO_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';

export let tempDir = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveCurrentUpstreamPushTarget =
	_test_exports.resolveCurrentUpstreamPushTarget;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHead =
	_test_exports.resolveRemoteRefsContainingHead;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;
const originalResolvePrReviewDiffStatsAsync =
	_test_exports.resolvePrReviewDiffStatsAsync;

/**
 * Bun scopes a `beforeEach`/`afterEach` call to whichever test file's module
 * evaluation was executing when the call happened. A shared fixtures module
 * is only ever evaluated once (import caching), so calling these hooks here
 * at module scope would register them for only the first consuming test
 * file to import this module in a given process — every other consumer
 * would silently run without setup/teardown when co-run in the same `bun
 * test` invocation. Each consuming test file must call
 * `beforeEach(setupPrWorkflowGateFixtures)` /
 * `afterEach(teardownPrWorkflowGateFixtures)` itself so Bun scopes the hooks
 * to that file.
 */
export function setupPrWorkflowGateFixtures(): void {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-gate-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	// The gate bind/verify path resolves Git off the blocking spawn (async).
	// Route the async resolvers through the sync stubs above so existing
	// synchronous fixtures drive the async production path unchanged.
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
	_test_exports.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	_test_exports.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		_test_exports.resolveCurrentUpstreamPushTarget(dir);
	_test_exports.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
	_test_exports.resolveRemoteRefsContainingHeadAsync = async (dir, head) =>
		_test_exports.resolveRemoteRefsContainingHead(dir, head);
	// bindPrReviewBase resolves diff stats off the blocking spawn (async).
	// Consumers stub the sync member locally before calling bindPrReviewBase;
	// this call-time delegation routes the async production read through
	// whatever sync stub is in place when the bind runs.
	_test_exports.resolvePrReviewDiffStatsAsync = async (...a) =>
		_test_exports.resolvePrReviewDiffStats(...a);
}

export async function teardownPrWorkflowGateFixtures(): Promise<void> {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resolveCurrentUpstreamPushTarget =
		originalResolveCurrentUpstreamPushTarget;
	_test_exports.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	_test_exports.resolveRemoteRefsContainingHead =
		originalResolveRemoteRefsContainingHead;
	_test_exports.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	_test_exports.resolvePrReviewDiffStatsAsync =
		originalResolvePrReviewDiffStatsAsync;
	await fs.rm(tempDir, { recursive: true, force: true });
}

export async function persistBatch(
	batchId: string,
	mode: string,
	lanes: ReadonlyArray<{
		laneId: string;
		workflowLane: string;
		ownedWorkflowLanes?: string[];
	}>,
	options: {
		status?: 'completed' | 'error';
		head?: string;
		empty?: boolean;
		textOverride?: string;
		transcriptIncomplete?: boolean;
		artifactRole?: string;
		subagentSessionId?: string;
		scope?: string;
	} = {},
): Promise<void> {
	for (const [index, lane] of lanes.entries()) {
		// Correlation IDs identify one immutable launch. Derive the fixture ID from
		// the logical lane so separate persistBatch calls for disjoint slices of the
		// same batch cannot collide merely because each slice restarts at index 0.
		const correlationId = `${batchId}--${lane.laneId}`;
		const subagentSessionId = options.subagentSessionId ?? correlationId;
		await recordPendingDelegation(tempDir, {
			correlationId,
			jobId: null,
			subagentSessionId,
			parentSessionId: SESSION_ID,
			callID: `call-${correlationId}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId: lane.laneId,
			mode,
			workflowLane: lane.workflowLane,
			ownedWorkflowLanes: lane.ownedWorkflowLanes,
			workspace: {
				directory: tempDir,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: options.head ?? HEAD_SHA,
				scope: options.scope ?? null,
			},
		});
		const ownedLanes = lane.ownedWorkflowLanes?.length
			? lane.ownedWorkflowLanes
			: [lane.workflowLane];
		const text =
			options.textOverride ??
			(options.empty
				? ''
				: mode === 'swarm-pr-review:reviewer'
					? '[REVIEWED] | C-001 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer'
					: mode === 'swarm-pr-review:critic'
						? '[CRITIC] | C-001 | UPHELD | HIGH | reason | no change'
						: mode === 'swarm-pr-feedback:verification'
							? `[FEEDBACK-VERIFIED] | ${lane.workflowLane} | CONFIRMED | evidence`
							: [
									mode === 'swarm-pr-review:micro'
										? MICRO_CANDIDATE_HEADER
										: BASE_CANDIDATE_HEADER,
									`C-${index} | ${ownedLanes[0]} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH`,
									...ownedLanes
										.slice(1)
										.map(
											(owned) =>
												`[CLEAN] | ${owned} | exact reviewed diff | no finding after focused invariant review`,
										),
								].join('\n'));
		const stored = storeLaneOutput(tempDir, {
			batchId,
			laneId: lane.laneId,
			agent: 'reviewer',
			role: options.artifactRole ?? 'reviewer',
			sessionId: subagentSessionId,
			parentSessionId: SESSION_ID,
			mode,
			workflowLane: lane.workflowLane,
			prHeadSha: options.head ?? HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			source: 'collect_lane_results',
			text,
			transcriptIncomplete: options.transcriptIncomplete,
			...(options.scope ? { scope: options.scope } : {}),
		});
		await appendDelegationTransition(tempDir, correlationId, {
			status: options.status ?? 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				...(stored.ref ? { outputRef: stored.ref } : {}),
				...(options.transcriptIncomplete ? { transcriptIncomplete: true } : {}),
			},
		});
	}
}

/**
 * Same base/micro coverage as establishReviewPrerequisites, but the first
 * `ownedFamilyCount` required micro families (default 2) are settled by ONE
 * consolidated lane (declaring ownedWorkflowLanes for all of them) whose
 * artifact carries one real [CANDIDATE] row for the first family and a
 * [CLEAN] attestation for each remaining owned family — exercising the
 * depth-tier consolidated-ownership path with an actual finding, not an
 * all-CLEAN artifact, and (at ownedFamilyCount >= 3) proving the same
 * consolidated lane can be cited by more than two trigger rows at once.
 */
export async function establishReviewPrerequisitesWithConsolidatedMicroLane(
	ownedFamilyCount = 2,
): Promise<{
	consolidatedCandidateId: string;
	baseCandidateIds: string[];
}> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-all', 'swarm-pr-review:base', baseLanes);
	const baseCandidateIds = baseLanes.map((_lane, index) => `C-${index}`);

	const ownedFamilies = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(
		0,
		ownedFamilyCount,
	);
	const remainingFamilies =
		PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(ownedFamilyCount);
	const [familyA, ...cleanFamilies] = ownedFamilies;
	const consolidatedCandidateId = 'C-CONSOLIDATED';
	const consolidatedText = [
		'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
		`${consolidatedCandidateId} | ${familyA} | HIGH | secrets | src/consolidated.ts:1 | leaked credential | LEAST_PRIVILEGE | observed in log output | HIGH`,
		// Each clean family's evidence text must be genuinely distinct (not a
		// copy-pasted template) to satisfy the multi-lane anti-templating check
		// in workflowArtifactHasContractMarker.
		...cleanFamilies.map(
			(family) =>
				`[CLEAN] | ${family} | exact reviewed diff scoped to ${family} | no ${family} finding after focused invariant review`,
		),
	].join('\n');
	const consolidatedBatchId = 'micro-consolidated';
	const consolidatedLaneId = 'micro-sweep-a';
	await recordPendingDelegation(tempDir, {
		correlationId: `${consolidatedBatchId}-0`,
		jobId: null,
		subagentSessionId: `${consolidatedBatchId}-0`,
		parentSessionId: SESSION_ID,
		callID: `call-${consolidatedBatchId}-0`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: consolidatedBatchId,
		laneId: consolidatedLaneId,
		mode: 'swarm-pr-review:micro',
		workflowLane: familyA,
		ownedWorkflowLanes: [...ownedFamilies],
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(tempDir, {
		batchId: consolidatedBatchId,
		laneId: consolidatedLaneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: `${consolidatedBatchId}-0`,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:micro',
		workflowLane: familyA,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text: consolidatedText,
	});
	await appendDelegationTransition(tempDir, `${consolidatedBatchId}-0`, {
		status: 'completed',
		result: {
			text: consolidatedText,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});

	const triggerRows: Array<Record<string, string>> = ownedFamilies.map(
		(family) => ({
			trigger_id: family,
			result: 'MATCHED',
			evidence: `Test fixture evidence for ${family}`,
			source_batch_id: consolidatedBatchId,
			source_lane_id: consolidatedLaneId,
		}),
	);
	for (const [index, workflowLane] of remainingFamilies.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Test fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		triggerRelative,
	);
	return { consolidatedCandidateId, baseCandidateIds };
}

export async function establishReviewPrerequisites(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, lanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-all', 'swarm-pr-review:base', lanes);
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Test fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		triggerRelative,
	);
}

/**
 * Two base batches independently claim the same dimension: an initial
 * consolidated lane (owning dimA + dimB, at forced depth tier S) contributes
 * a real candidate for each, then a later retry lane re-claims dimB alone
 * with a fresh candidate. Exercises the dimension-scoped extraction fix: the
 * retry's fresh candidate must supersede the initial lane's now-stale dimB
 * content, while the initial lane's still-uniquely-owned dimA candidate must
 * still surface.
 */
export async function establishReviewPrerequisitesWithOverlappingBaseRetry(): Promise<{
	onlyDimACandidateId: string;
	freshDimBCandidateId: string;
	staleDimBCandidateId: string;
	remainingBaseCandidateIds: string[];
}> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');

	const originalResolvePrReviewDiffStats =
		_test_exports.resolvePrReviewDiffStats;
	try {
		// setupPrWorkflowGateFixtures installs a call-time
		// resolvePrReviewDiffStatsAsync delegation that reads this sync member,
		// so bindPrReviewBase's async production read routes through this stub.
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 10,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		await bindPrReviewBase(tempDir, SESSION_ID, {
			prHeadSha: HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: PR_REVIEW_BASE_SHA,
		});
	} finally {
		_test_exports.resolvePrReviewDiffStats = originalResolvePrReviewDiffStats;
	}

	const [dimA, dimB, ...remainingDimensions] = PR_REVIEW_BASE_DIMENSION_IDS;
	const onlyDimACandidateId = 'ONLY-DIMA';
	const staleDimBCandidateId = 'STALE-DIMB';
	const freshDimBCandidateId = 'FRESH-DIMB';
	const candidateHeader =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';

	const consolidatedLane = {
		laneId: 'sweep-ab',
		workflowLane: dimA,
		ownedWorkflowLanes: [dimA, dimB],
	};
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [consolidatedLane], {
		batchId: 'base-consolidated-ab',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch(
		'base-consolidated-ab',
		'swarm-pr-review:base',
		[consolidatedLane],
		{
			textOverride: [
				candidateHeader,
				`${onlyDimACandidateId} | ${dimA} | HIGH | correctness | file.ts:1 | claim-a | evidence-a | impact-a | HIGH`,
				`${staleDimBCandidateId} | ${dimB} | HIGH | correctness | file.ts:2 | claim-b-stale | evidence-b-stale | impact-b-stale | HIGH`,
			].join('\n'),
			scope: PR_REVIEW_SCOPE,
		},
	);

	const retryLane = { laneId: 'retry-dimb', workflowLane: dimB };
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [retryLane], {
		batchId: 'base-retry-dimb',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-retry-dimb', 'swarm-pr-review:base', [retryLane], {
		textOverride: [
			candidateHeader,
			`${freshDimBCandidateId} | ${dimB} | HIGH | correctness | file.ts:3 | claim-b-fresh | evidence-b-fresh | impact-b-fresh | HIGH`,
		].join('\n'),
		scope: PR_REVIEW_SCOPE,
	});

	const remainingLanes = remainingDimensions.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, remainingLanes, {
		batchId: 'base-remaining',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-remaining', 'swarm-pr-review:base', remainingLanes, {
		scope: PR_REVIEW_SCOPE,
	});
	const remainingBaseCandidateIds = remainingLanes.map(
		(_lane, index) => `C-${index}`,
	);

	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
				scope: PR_REVIEW_SCOPE,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Test fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		triggerRelative,
	);

	return {
		onlyDimACandidateId,
		freshDimBCandidateId,
		staleDimBCandidateId,
		remainingBaseCandidateIds,
	};
}

/**
 * Same base/micro coverage as establishReviewPrerequisites, but one singleton
 * (fully-owned, never-superseded) base lane's [CANDIDATE] row labels itself
 * with a slightly different lane string than the exact dimension it was
 * dispatched for — a realistic subagent labeling inconsistency. Exercises
 * that a lane credited for its FULL ownership gets no extraction scoping at
 * all (matching pre-existing behavior), so this mismatch never silently
 * drops the candidate from the mandatory coverage set.
 */
export async function establishReviewPrerequisitesWithMislabeledSingletonLane(): Promise<{
	normalCandidateIds: string[];
	coveringCandidateId: string;
	mislabeledCandidateId: string;
}> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	const [mislabeledLane, ...normalLanes] = baseLanes;
	await persistBatch('base-all', 'swarm-pr-review:base', normalLanes);
	const normalCandidateIds = normalLanes.map((_lane, index) => `C-${index}`);

	// One correctly-labeled row proves this lane covers its dispatched
	// dimension (required for base coverage to settle at all); a second,
	// well-formed row for the SAME lane labels itself with a slightly
	// different string — a realistic case of a subagent finding two issues
	// in one dispatch and being inconsistent about the exact label on the
	// second one.
	const coveringCandidateId = 'C-COVERING';
	const mislabeledCandidateId = 'C-MISLABELED';
	const mislabeledText = [
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
		`${coveringCandidateId} | ${mislabeledLane.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH`,
		`${mislabeledCandidateId} | ${mislabeledLane.workflowLane}-typo | HIGH | correctness | file.ts:2 | claim | evidence | impact | HIGH`,
	].join('\n');
	const mislabeledCorrelationId = 'base-all-mislabeled';
	await recordPendingDelegation(tempDir, {
		correlationId: mislabeledCorrelationId,
		jobId: null,
		subagentSessionId: mislabeledCorrelationId,
		parentSessionId: SESSION_ID,
		callID: `call-${mislabeledCorrelationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'base-all',
		laneId: mislabeledLane.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: mislabeledLane.workflowLane,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(tempDir, {
		batchId: 'base-all',
		laneId: mislabeledLane.laneId,
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: mislabeledCorrelationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: mislabeledLane.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text: mislabeledText,
	});
	await appendDelegationTransition(tempDir, mislabeledCorrelationId, {
		status: 'completed',
		result: {
			text: mislabeledText,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});

	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Test fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		triggerRelative,
	);
	return { normalCandidateIds, coveringCandidateId, mislabeledCandidateId };
}
