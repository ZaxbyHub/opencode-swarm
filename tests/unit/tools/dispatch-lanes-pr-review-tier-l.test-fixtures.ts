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
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

export { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

/**
 * Shared fixtures for the tier-L consolidated-retry suites.
 *
 * Bun scopes `beforeEach`/`afterEach` to the test file whose module evaluation
 * registered them, and a shared module is evaluated once per process, so this
 * module deliberately exports plain setup/teardown functions instead of
 * registering hooks itself. Each consuming test file wires them up.
 */

export const SESSION_ID = 'tier-l-retry';
export const HEAD_SHA = 'abc123';
export const REVISION_DIGEST = 'tier-l-revision';
export const TIER_L_MESSAGE =
	'depth tier L requires one dedicated lane per dimension';
const CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

let directory = '';
let currentRevisionDigest = REVISION_DIGEST;

const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;

/** The temp worktree the current test is running against. */
export function tierLDirectory(): string {
	return directory;
}

/** The digest the stubbed resolver currently returns. */
export function tierLRevisionDigest(): string {
	return currentRevisionDigest;
}

/** Simulate a worktree edit by moving the resolved revision digest. */
export function setTierLRevisionDigest(next: string): void {
	currentRevisionDigest = next;
}

export function setupTierLFixtures(): void {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-review-tier-l-')),
	);
	currentRevisionDigest = REVISION_DIGEST;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolvePrWorkflowRevisionDigest = () => currentRevisionDigest;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
}

export async function teardownTierLFixtures(): Promise<void> {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
}

function artifactText(
	rows: ReadonlyArray<{ candidateId: string; dimension: string }>,
): string {
	return [
		CANDIDATE_HEADER,
		...rows.map(
			({ candidateId, dimension }) =>
				`${candidateId} | ${dimension} | HIGH | correctness | src/${dimension}.ts:1 | claim about ${dimension} | evidence for ${dimension} | impact on ${dimension} | HIGH | ORDINARY | `,
		),
	].join('\n');
}

/**
 * Persist one base lane's delegation record and artifact. Written per lane
 * rather than per batch so a single batch can mix a terminally-failed lane with
 * a successful one, which is exactly the state the retry predicate discriminates
 * on.
 */
export async function persistBaseLane(options: {
	batchId: string;
	laneId: string;
	workflowLane: string;
	ownedWorkflowLanes?: string[];
	candidateIds?: string[];
	status?: 'completed' | 'error';
}): Promise<void> {
	const correlationId = `${options.batchId}--${options.laneId}`;
	const owned = options.ownedWorkflowLanes?.length
		? options.ownedWorkflowLanes
		: [options.workflowLane];
	const candidateIds =
		options.candidateIds ?? owned.map((dimension) => `C-${dimension}`);
	const text = artifactText(
		owned.map((dimension, index) => ({
			candidateId: candidateIds[index] ?? `C-${dimension}`,
			dimension,
		})),
	);
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: options.batchId,
		laneId: options.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: options.workflowLane,
		...(options.ownedWorkflowLanes
			? { ownedWorkflowLanes: options.ownedWorkflowLanes }
			: {}),
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: options.batchId,
		laneId: options.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: options.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: options.status ?? 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
}

export function singleton(workflowLane: string, prefix = 'lane') {
	return { laneId: `${prefix}-${workflowLane}`, workflowLane };
}

/** Activate PR_REVIEW and declare the tier-L six-lane singleton initial wave. */
export async function recordInitialWave(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	await enforcePrReviewBaseDimensions(
		directory,
		SESSION_ID,
		PR_REVIEW_BASE_DIMENSION_IDS.map((dimension) => singleton(dimension)),
		{
			batchId: 'base-initial',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
}

/** Fail every initial-wave lane terminally — a realistic provider outage. */
export async function failEntireInitialWave(): Promise<void> {
	for (const dimension of PR_REVIEW_BASE_DIMENSION_IDS) {
		await persistBaseLane({
			batchId: 'base-initial',
			laneId: `lane-${dimension}`,
			workflowLane: dimension,
			status: 'error',
		});
	}
}

/** Record a base batch, returning the rejection error or `null` on acceptance. */
export async function attemptBaseBatch(
	lanes: ReadonlyArray<{
		laneId: string;
		workflowLane: string;
		ownedWorkflowLanes?: string[];
	}>,
	batchId: string,
): Promise<Error | null> {
	return enforcePrReviewBaseDimensions(directory, SESSION_ID, lanes, {
		batchId,
		prHeadSha: HEAD_SHA,
		revisionDigest: currentRevisionDigest,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	}).then(
		() => null,
		(reason: unknown) => reason as Error,
	);
}

/** The single-consolidated-lane retry shape most cases exercise. */
export async function attemptConsolidatedRetry(
	ownedWorkflowLanes: readonly string[],
	batchId = 'base-retry-consolidated',
): Promise<Error | null> {
	return attemptBaseBatch(
		[
			{
				laneId: 'retry-consolidated',
				workflowLane: ownedWorkflowLanes[0],
				ownedWorkflowLanes: [...ownedWorkflowLanes],
			},
		],
		batchId,
	);
}
