import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { readLaneOutput } from '../background/lane-output-store.js';
import {
	findByBatchId,
	readDelegations,
} from '../background/pending-delegations.js';
import {
	resolveCommitCountSince,
	resolveCommitCountSinceAsync,
	resolveCurrentGitHead,
	resolveCurrentGitHeadAsync,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamPushTargetAsync,
	resolveCurrentUpstreamRemoteRef,
	resolveExactRemoteBranchHead,
	resolveExactRemoteBranchHeadAsync,
	resolveIsExactSingleChildCommit,
	resolveIsExactSingleChildCommitAsync,
	resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync,
	resolvePrReviewDiffStats,
	resolvePrReviewDiffStatsAsync,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
	resolveRemoteRefsContainingHead,
	resolveRemoteRefsContainingHeadAsync,
} from '../background/workspace-snapshot.js';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import { resolveGeneratedAgentRole } from '../config/schema.js';
import {
	classifyPrWorkflowGitState,
	type PrWorkflowGitState,
} from '../git/pr-workflow-state.js';
import { getPrWorkflowToolCapability } from '../tools/tool-metadata.js';
import { validateSwarmPath } from './utils.js';

export const PR_REVIEW_BASE_DIMENSION_IDS = [
	'intent-architecture',
	'correctness-state',
	'tests-falsifiability',
	'security-trust',
	'reliability-performance',
	'compatibility-delivery',
] as const;

export const PR_REVIEW_REQUIRED_MICRO_LANE_IDS = [
	'auth-identity-secrets',
	'untrusted-input-boundaries',
	'subprocess-platform',
	'concurrency-state',
	'dependencies-build-release',
	'api-schema-migrations',
	'test-infrastructure',
	'ui-accessibility-i18n',
	'privacy-observability',
	'generated-provenance',
	'unclassified-risk',
] as const;

export type PrReviewBaseDimensionId =
	(typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
export type PrWorkflowMode = 'PR_REVIEW' | 'PR_FEEDBACK';

export interface PrWorkflowCheckoutRecoveryRecord {
	code:
		| 'UNMERGED_INDEX'
		| 'GIT_OPERATION_IN_PROGRESS'
		| 'DIRTY_SUBMODULE'
		| 'SWARM_STATE_TRACKING_ERROR'
		| 'GIT_STATE_INDETERMINATE';
	retryable: false;
	requiredAction: string;
	evidence: PrWorkflowGitState['evidence'];
	detectedAt: string;
}

export interface PrFeedbackReviewHandoffRecord {
	path: string;
	runId: string;
	sourcePrHeadSha: string;
	prUrl: string;
	findingIds: string[];
	digest: string;
	sourceWorkflowInstanceId: string;
	provenance: 'active-review-v1' | 'external-v1';
}

export type PrReviewDepthTier = 'S' | 'M' | 'L';

/**
 * Objective size thresholds for the controller-computed PR-review depth tier.
 * Risk-trigger escalation is semantic and stays caller-side: callers may
 * always dispatch more lanes than a tier's floor, never fewer.
 */
export const PR_REVIEW_DEPTH_TIER_THRESHOLDS = {
	smallMaxChangedLines: 50,
	smallMaxChangedFiles: 3,
	mediumMaxChangedLines: 500,
	mediumMaxChangedFiles: 20,
} as const;

/**
 * Minimum initial base-wave lane counts per depth tier. Tier L preserves the
 * historical exact-six singleton wave; S/M permit consolidated lanes that own
 * multiple dimensions while every dimension stays mandatory to evaluate.
 */
export const PR_REVIEW_BASE_LANE_FLOORS: Record<PrReviewDepthTier, number> = {
	S: 1,
	M: 3,
	L: PR_REVIEW_BASE_DIMENSION_IDS.length,
};

/**
 * Minimum lane counts for a FULL micro (risk-family) sweep per depth tier. These
 * mirror the base floors' tier *semantics* — not their numbers — scaled to the
 * eleven risk families: S does not bind (a tier-S PR of ≤50 lines/≤3 files may
 * consolidate a full sweep into one lane, exactly as base tier S permits); M
 * requires at least half the families to get independent lanes (ceil(11/2) = 6,
 * the deliberate scale-up from base M's 3 = ceil(6/2)); L requires one lane per
 * family (the family count, matching base L = dimension count). The floor binds
 * only on a batch (or the final attestation) that covers all eleven families;
 * partial retry batches covering a subset are exempt, and callers may always
 * dispatch more lanes than a tier's floor, never fewer.
 */
export const PR_REVIEW_MICRO_LANE_FLOORS: Record<PrReviewDepthTier, number> = {
	S: 1,
	M: 6,
	L: PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length,
};

/**
 * Unknown or uncomputable diff size fails strict to the deepest tier, as does
 * any range containing a submodule pointer change: git's numstat reports a
 * gitlink bump as a fixed 1-added/1-deleted row regardless of the referenced
 * repository's actual diff size, so no line/file threshold can bound it.
 */
export function computePrReviewDepthTier(
	stats:
		| {
				changedLines: number;
				changedFiles: number;
				hasSubmoduleChange?: boolean;
		  }
		| null
		| undefined,
): PrReviewDepthTier {
	if (!stats) return 'L';
	if (stats.hasSubmoduleChange) return 'L';
	if (
		stats.changedLines <=
			PR_REVIEW_DEPTH_TIER_THRESHOLDS.smallMaxChangedLines &&
		stats.changedFiles <= PR_REVIEW_DEPTH_TIER_THRESHOLDS.smallMaxChangedFiles
	) {
		return 'S';
	}
	if (
		stats.changedLines <=
			PR_REVIEW_DEPTH_TIER_THRESHOLDS.mediumMaxChangedLines &&
		stats.changedFiles <= PR_REVIEW_DEPTH_TIER_THRESHOLDS.mediumMaxChangedFiles
	) {
		return 'M';
	}
	return 'L';
}

export interface PrWorkflowLaneSpec {
	laneId?: string;
	workflowLane?: string;
	reviewItemIds?: string[];
	/**
	 * Complete dimension/family set this lane covers under a consolidated depth
	 * tier. Must contain workflowLane. Absent means the singleton [workflowLane].
	 */
	ownedWorkflowLanes?: string[];
}

export interface PrFeedbackLaneOwnership {
	laneId: string;
	ownedItemIds: string[];
}

interface PrReviewBaseDispatchRecord {
	batchId: string;
	lanes: Array<{
		laneId: string;
		workflowLane: PrReviewBaseDimensionId;
		ownedWorkflowLanes?: PrReviewBaseDimensionId[];
	}>;
	validatedAt: string;
}

interface PrFeedbackVerificationRecord {
	batchId: string;
	ownership: PrFeedbackLaneOwnership[];
	validatedAt: string;
}

export type PrFeedbackGatePhase =
	| 'stage-b-reviewer'
	| 'stage-b-test'
	| 'closeout-reviewer'
	| 'closeout-critic';

export type PrFeedbackStageACategory =
	| 'build'
	| 'typecheck'
	| 'lint'
	| 'diff-check'
	| 'reproduction';

export interface PrFeedbackStageACheckReceipt {
	category: PrFeedbackStageACategory;
	workingDirectory?: string;
	obligationId?: string;
	validatorContract?: { path: string; id: string };
	command: string[];
	targets?: string[];
	feedbackTargets?: Array<{
		feedbackItemId: string;
		target: string;
		expectedBehavior: string;
	}>;
	durationMs: number;
}

interface PrFeedbackStageARecord {
	revisionDigest: string;
	checks: PrFeedbackStageACheckReceipt[];
	feedbackItemIds?: string[];
	applicableCategories?: Array<'build' | 'typecheck' | 'lint'>;
	applicableObligations?: Array<{
		id: string;
		category: 'build' | 'typecheck' | 'lint';
		workingDirectory: string;
		source: string;
		validatorContract?: { path: string; id: string };
	}>;
	validatedAt: string;
}

interface PrFeedbackGateBatchRecord {
	batchId: string;
	phase: PrFeedbackGatePhase;
	laneId: string;
	itemIds: string[];
	revisionDigest: string;
	validatedAt: string;
}

interface PrFeedbackReadyToPublishRecord {
	revisionDigest: string;
	localHead: string;
	remoteName: string;
	remoteBranchRef: string;
	remoteRef: string;
	validatedAt: string;
}

export type PrWorkflowCompletionStatus = 'completed' | 'ready-to-publish';

export type PrReviewValidationPhase = 'council' | 'reviewer' | 'critic';
export type PrReviewArtifactBoundary =
	| 'post_explorer'
	| 'post_reviewer'
	| 'post_critic';

type PrReviewArtifactRecord = {
	finding_id: string;
	status: 'PENDING' | 'CONFIRMED' | 'DISPROVED' | 'PRE_EXISTING';
	next_action:
		| 'route_to_reviewer'
		| 'route_to_critic'
		| 'report'
		| 'suppress_with_reason'
		| 'handoff_to_feedback';
	severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
};

interface PrFeedbackScopeDeclarationRecord {
	taskId: string;
	files: string[];
	revisionDigest: string;
	declaredAt: string;
	consumedByCallId?: string;
}

interface PrReviewValidationBatchRecord {
	batchId: string;
	phase: PrReviewValidationPhase;
	lanes: Array<{
		laneId: string;
		workflowLane: string;
		reviewItemIds?: string[];
	}>;
	validatedAt: string;
}

export interface PrWorkflowGateState {
	schemaVersion: 1;
	/** Monotonic durable revision used to reject stale same-session transitions. */
	revision: number;
	/** Stable identity that prevents revision-only ABA during mode replacement. */
	workflowInstanceId?: string;
	sessionID: string;
	mode: PrWorkflowMode;
	activatedAt: string;
	updatedAt: string;
	prHeadSha?: string;
	prReviewBaseRef?: string;
	prReviewBaseSha?: string;
	/** Controller-computed size tier for the bound merge-base scope. */
	prReviewDepthTier?: PrReviewDepthTier;
	/** Audit record of the bounded numstat totals behind prReviewDepthTier. */
	prReviewDiffStats?: {
		changedLines: number;
		changedFiles: number;
		hasSubmoduleChange: boolean;
	};
	prReviewBaseDispatches?: PrReviewBaseDispatchRecord[];
	/** @deprecated Compatibility projection of the most recent base dispatch. */
	prReviewBaseDispatch?: PrReviewBaseDispatchRecord;
	prReviewTriggerEvalPath?: string;
	prReviewValidationBatches?: PrReviewValidationBatchRecord[];
	prReviewArtifactRunId?: string;
	prReviewFindingsPath?: string;
	prReviewArtifactBoundaries?: PrReviewArtifactBoundary[];
	prReviewHandoffPath?: string;
	prReviewHandoffRequired?: boolean;
	checkoutRecovery?: PrWorkflowCheckoutRecoveryRecord;
	/** Canonical PR URL selected when PR_FEEDBACK was mechanically activated. */
	prFeedbackTargetUrl?: string;
	prFeedbackReviewHandoff?: PrFeedbackReviewHandoffRecord;
	prFeedbackInventory?: string[];
	prFeedbackVerifications?: PrFeedbackVerificationRecord[];
	/** @deprecated Compatibility projection of the most recent verification dispatch. */
	prFeedbackVerification?: PrFeedbackVerificationRecord;
	prFeedbackStageA?: PrFeedbackStageARecord;
	prFeedbackGateBatches?: PrFeedbackGateBatchRecord[];
	prFeedbackReadyToPublish?: PrFeedbackReadyToPublishRecord;
	prFeedbackScopes?: PrFeedbackScopeDeclarationRecord[];
}

interface SessionStateMutationLock {
	ownerToken: string;
	pid: number;
	createdAtMs: number;
}

const GATE_SCHEMA_VERSION = 1 as const;
const MAX_TRACKED_SESSIONS = 200;
const MAX_WORKFLOW_BATCHES = 128;
const WINDOWS_RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 10;
const STATE_MUTATION_LOCK_MAX_ATTEMPTS = 50;
const STATE_MUTATION_LOCK_RETRY_DELAY_MS = 10;
const STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS = 30_000;
const DISPATCH_TOOL_NAME = 'dispatch_lanes_async';
const BLOCKING_DISPATCH_TOOL_NAME = 'dispatch_lanes';
const WORKFLOW_GATE_DIR = 'pr-workflow-gates';
const trackedStatesByProjectSession = new Map<string, PrWorkflowGateState>();
const pendingStateMutationsByProjectSession = new Map<string, Promise<void>>();

const PrReviewBaseDimensionIdSchema = z.enum([
	'intent-architecture',
	'correctness-state',
	'tests-falsifiability',
	'security-trust',
	'reliability-performance',
	'compatibility-delivery',
]);

const PrReviewBaseDispatchRecordSchema = z
	.object({
		batchId: z.string().min(1),
		lanes: z
			.array(
				z
					.object({
						laneId: z.string().min(1),
						workflowLane: PrReviewBaseDimensionIdSchema,
						ownedWorkflowLanes: z
							.array(PrReviewBaseDimensionIdSchema)
							.min(1)
							.max(PR_REVIEW_BASE_DIMENSION_IDS.length)
							.optional(),
					})
					.strict(),
			)
			.min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackLaneOwnershipSchema = z
	.object({
		laneId: z.string().min(1),
		ownedItemIds: z.array(z.string().min(1)).min(1),
	})
	.strict();

const PrFeedbackVerificationRecordSchema = z
	.object({
		batchId: z.string().min(1),
		ownership: z.array(PrFeedbackLaneOwnershipSchema).min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackStageACheckReceiptSchema = z
	.object({
		category: z.enum([
			'build',
			'typecheck',
			'lint',
			'diff-check',
			'reproduction',
		]),
		workingDirectory: z.string().min(1).optional(),
		obligationId: z.string().min(1).optional(),
		validatorContract: z
			.object({ path: z.string().min(1), id: z.string().min(1) })
			.strict()
			.optional(),
		command: z.array(z.string().min(1)).min(1),
		targets: z.array(z.string().min(1)).min(1).optional(),
		feedbackTargets: z
			.array(
				z
					.object({
						feedbackItemId: z.string().min(1),
						target: z.string().min(1),
						expectedBehavior: z.string().min(8),
					})
					.strict(),
			)
			.min(1)
			.optional(),
		durationMs: z.number().nonnegative(),
	})
	.strict();

const PrFeedbackStageARecordSchema = z
	.object({
		revisionDigest: z.string().min(1),
		checks: z.array(PrFeedbackStageACheckReceiptSchema).min(2).max(258),
		feedbackItemIds: z.array(z.string().min(1)).min(1).optional(),
		applicableCategories: z
			.array(z.enum(['build', 'typecheck', 'lint']))
			.max(3)
			.optional(),
		applicableObligations: z
			.array(
				z
					.object({
						id: z.string().min(1),
						category: z.enum(['build', 'typecheck', 'lint']),
						workingDirectory: z.string().min(1),
						source: z.string().min(1),
						validatorContract: z
							.object({ path: z.string().min(1), id: z.string().min(1) })
							.strict()
							.optional(),
					})
					.strict(),
			)
			.max(256)
			.optional(),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackGateBatchRecordSchema = z
	.object({
		batchId: z.string().min(1),
		phase: z.enum([
			'stage-b-reviewer',
			'stage-b-test',
			'closeout-reviewer',
			'closeout-critic',
		]),
		laneId: z.string().min(1),
		itemIds: z.array(z.string().min(1)).min(1),
		revisionDigest: z.string().min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackReadyToPublishRecordSchema = z
	.object({
		revisionDigest: z.string().min(1),
		localHead: z.string().min(1),
		remoteName: z.string().min(1),
		remoteBranchRef: z.string().startsWith('refs/heads/'),
		remoteRef: z.string().startsWith('refs/remotes/'),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrReviewValidationBatchRecordSchema = z
	.object({
		batchId: z.string().min(1),
		phase: z.enum(['council', 'reviewer', 'critic']),
		lanes: z
			.array(
				z
					.object({
						laneId: z.string().min(1),
						workflowLane: z.string().min(1),
						reviewItemIds: z.array(z.string().min(1)).min(1).optional(),
					})
					.strict(),
			)
			.min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackScopeDeclarationRecordSchema = z
	.object({
		taskId: z.string().regex(/^\d+\.\d+(?:\.\d+)*$/),
		files: z.array(z.string().min(1)).min(1).max(10_000),
		revisionDigest: z.string().min(1),
		declaredAt: z.string().min(1),
		consumedByCallId: z.string().min(1).optional(),
	})
	.strict();

const PrWorkflowCheckoutRecoveryRecordSchema = z
	.object({
		code: z.enum([
			'UNMERGED_INDEX',
			'GIT_OPERATION_IN_PROGRESS',
			'DIRTY_SUBMODULE',
			'SWARM_STATE_TRACKING_ERROR',
			'GIT_STATE_INDETERMINATE',
		]),
		retryable: z.literal(false),
		requiredAction: z.string().min(1).max(2000),
		evidence: z
			.object({
				worktreeRoot: z.string().nullable(),
				gitDir: z.string().nullable(),
				operations: z.array(z.string().min(1)).max(16),
				unmergedCodes: z.array(z.string().min(1)).max(16),
				paths: z.array(z.string()).max(20),
				trackedCount: z.number().int().nonnegative(),
				untrackedCount: z.number().int().nonnegative(),
				pathsTruncated: z.boolean(),
				detail: z.string().max(1000).optional(),
			})
			.strict(),
		detectedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackReviewHandoffRecordSchema = z
	.object({
		path: z.string().min(1).max(512),
		runId: z.string().min(1).max(128),
		sourcePrHeadSha: z.string().regex(/^[0-9a-f]{6,64}$/i),
		prUrl: z.string().url().max(2000),
		findingIds: z.array(z.string().min(1).max(128)).min(1).max(1000),
		digest: z.string().regex(/^[0-9a-f]{64}$/),
		sourceWorkflowInstanceId: z.string().min(1).max(128),
		provenance: z.enum(['active-review-v1', 'external-v1']),
	})
	.strict();

const PrWorkflowGateStateSchema = z
	.object({
		schemaVersion: z.literal(GATE_SCHEMA_VERSION),
		revision: z.number().int().nonnegative().default(0),
		workflowInstanceId: z.string().min(1).max(128).optional(),
		sessionID: z.string().min(1),
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
		activatedAt: z.string().min(1),
		updatedAt: z.string().min(1),
		prHeadSha: z.string().min(1).optional(),
		prReviewBaseRef: z.string().min(1).optional(),
		prReviewBaseSha: z.string().min(1).optional(),
		prReviewDepthTier: z.enum(['S', 'M', 'L']).optional(),
		prReviewDiffStats: z
			.object({
				changedLines: z.number().int().nonnegative(),
				changedFiles: z.number().int().nonnegative(),
				// Older persisted state (written before this field existed) omits
				// it entirely; default to false rather than rejecting the whole
				// record — the depth tier it backs was already computed and
				// persisted under the pre-existing rules, so backfilling "no known
				// submodule signal" does not retroactively change anything.
				hasSubmoduleChange: z.boolean().default(false),
			})
			.strict()
			.optional(),
		prReviewBaseDispatches: z
			.array(PrReviewBaseDispatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prReviewBaseDispatch: PrReviewBaseDispatchRecordSchema.optional(),
		prReviewTriggerEvalPath: z.string().min(1).optional(),
		prReviewValidationBatches: z
			.array(PrReviewValidationBatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prReviewArtifactRunId: z.string().min(1).optional(),
		prReviewFindingsPath: z.string().min(1).optional(),
		prReviewArtifactBoundaries: z
			.array(z.enum(['post_explorer', 'post_reviewer', 'post_critic']))
			.max(3)
			.optional(),
		prReviewHandoffPath: z.string().min(1).optional(),
		prReviewHandoffRequired: z.boolean().optional(),
		checkoutRecovery: PrWorkflowCheckoutRecoveryRecordSchema.optional(),
		prFeedbackTargetUrl: z.string().url().max(2000).optional(),
		prFeedbackReviewHandoff: PrFeedbackReviewHandoffRecordSchema.optional(),
		prFeedbackInventory: z.array(z.string().min(1)).min(1).optional(),
		prFeedbackVerifications: z
			.array(PrFeedbackVerificationRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prFeedbackVerification: PrFeedbackVerificationRecordSchema.optional(),
		prFeedbackStageA: PrFeedbackStageARecordSchema.optional(),
		prFeedbackGateBatches: z
			.array(PrFeedbackGateBatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prFeedbackReadyToPublish: PrFeedbackReadyToPublishRecordSchema.optional(),
		prFeedbackScopes: z
			.array(PrFeedbackScopeDeclarationRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
	})
	// .passthrough(), not .strict(): this state is written unconditionally on
	// every PR_REVIEW/PR_FEEDBACK session and persists across process
	// restarts by design. A .strict() schema means a code rollback that
	// re-encounters a field a newer version added throws BLOCKED on every
	// read (including the abort/reset escape hatch, since
	// requireAnyActiveState reads through this same schema before
	// clearPrWorkflowGateState ever runs), with no self-service recovery.
	// Passthrough keeps unknown fields opaque but present through any
	// read-modify-write cycle, so older code degrades to "ignore the field
	// it doesn't know about" instead of "refuse to read the file at all".
	.passthrough();

function formatCheckoutRecoveryBlock(state: PrWorkflowGitState): string {
	const evidence = JSON.stringify({
		operations: state.evidence.operations,
		unmerged_codes: state.evidence.unmergedCodes,
		paths: state.evidence.paths,
		paths_truncated: state.evidence.pathsTruncated,
	});
	return (
		`BLOCKED: PR workflow checkout requires manual Git recovery before activation. ` +
		`code=${state.code} retryable=false required_action=${state.requiredAction} evidence=${evidence}`
	);
}

function checkoutRecoveryRecord(
	state: PrWorkflowGitState,
): PrWorkflowCheckoutRecoveryRecord {
	if (state.kind !== 'recovery-required' && state.kind !== 'indeterminate') {
		throw new Error(
			'PR workflow checkout recovery requires a terminal Git state',
		);
	}
	return {
		code: state.code as PrWorkflowCheckoutRecoveryRecord['code'],
		retryable: false,
		requiredAction: state.requiredAction,
		evidence: state.evidence,
		detectedAt: isoNow(),
	};
}

export async function activatePrWorkflow(
	directory: string,
	sessionID: string,
	mode: PrWorkflowMode,
	options: {
		prHeadSha?: string;
		requireCheckoutPreflight?: boolean;
		prUrl?: string;
	} = {},
): Promise<PrWorkflowGateState> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const existing = await readPrWorkflowGateState(
		directory,
		normalizedSessionID,
	);
	if (existing?.mode === mode) {
		let activeState = existing;
		if (mode === 'PR_FEEDBACK' && options.prUrl) {
			const requestedTarget = canonicalGitHubPrUrl(options.prUrl);
			if (!requestedTarget) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK target must be a canonical GitHub PR URL',
				);
			}
			const existingTarget = existing.prFeedbackTargetUrl
				? canonicalGitHubPrUrl(existing.prFeedbackTargetUrl)
				: null;
			if (existingTarget && requestedTarget !== existingTarget) {
				throw new Error(
					`BLOCKED: active PR_FEEDBACK targets a different GitHub pull request`,
				);
			}
			if (!existingTarget) {
				activeState = {
					...existing,
					prFeedbackTargetUrl: options.prUrl,
					updatedAt: isoNow(),
				};
				await persistState(directory, activeState);
			}
		}
		return options.prHeadSha
			? bindPrWorkflowHead(directory, normalizedSessionID, options.prHeadSha)
			: activeState;
	}
	if (existing) {
		throw new Error(
			`BLOCKED: session "${normalizedSessionID}" already has an active ${existing.mode} workflow; complete it before starting ${mode}`,
		);
	}
	if (options.requireCheckoutPreflight) {
		const checkoutState = await classifyPrWorkflowGitState(directory);
		if (
			checkoutState.kind === 'recovery-required' ||
			checkoutState.kind === 'indeterminate'
		) {
			throw new Error(formatCheckoutRecoveryBlock(checkoutState));
		}
	}
	const initialHead = options.prHeadSha
		? await assertCurrentCheckoutHead(directory, options.prHeadSha)
		: undefined;
	const timestamp = isoNow();
	const feedbackTargetUrl =
		mode === 'PR_FEEDBACK' && options.prUrl
			? canonicalGitHubPrUrl(options.prUrl)
				? options.prUrl
				: null
			: undefined;
	if (feedbackTargetUrl === null) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK target must be a canonical GitHub PR URL',
		);
	}
	const nextState: PrWorkflowGateState = {
		schemaVersion: GATE_SCHEMA_VERSION,
		revision: 0,
		workflowInstanceId: randomUUID(),
		sessionID: normalizedSessionID,
		mode,
		activatedAt: timestamp,
		updatedAt: timestamp,
		...(initialHead ? { prHeadSha: initialHead } : {}),
		...(feedbackTargetUrl ? { prFeedbackTargetUrl: feedbackTargetUrl } : {}),
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function readPrWorkflowGateState(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	// State is shared by plugin processes. The bounded cache is an eviction aid
	// for locally persisted snapshots, never an authority over the durable file.
	const state = await readPrWorkflowGateStateFromDisk(
		directory,
		normalizedSessionID,
	);
	if (state) {
		rememberState(directory, state);
	} else {
		trackedStatesByProjectSession.delete(
			stateCacheKey(directory, normalizedSessionID),
		);
	}
	return state;
}

/**
 * Serialize a pre-bind checkout-preservation controller with every terminal
 * PR-workflow transition for the raw parent session. The caller's action may
 * perform the fixed Git preservation command while holding this lock; abort,
 * bind, and a same-session reactivation cannot clear or replace the gate until
 * it settles. The state passed to the action is schema-validated durable state,
 * never a caller-supplied projection.
 */
export async function withPrWorkflowCheckoutPreparationLock<T>(
	directory: string,
	sessionID: string,
	action: (
		state: PrWorkflowGateState,
		controls: {
			markRecoveryRequired: (
				gitState: PrWorkflowGitState,
			) => Promise<PrWorkflowGateState>;
		},
	) => Promise<T>,
): Promise<T> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!state) {
			// Issue #1931 RC3: prepare_pr_workflow_checkout is called AFTER the
			// gate is activated (by `/swarm pr-review` at commands/registry.ts
			// or by the first swarm-pr-review: dispatch in dispatch_lanes_async).
			// Calling it before either of those ran is a protocol ordering
			// error, not a missing-file bug — point the caller at the
			// activation path so they don't go hunting for a fictional
			// gate file.
			throw new Error(
				`BLOCKED: no active PR workflow gate for session "${normalizedSessionID}". ` +
					`The gate is activated by running \`/swarm pr-review <pr-ref>\` (which activates PR_REVIEW) ` +
					`or \`/swarm pr-feedback <pr-ref>\` (which activates PR_FEEDBACK), or by the first ` +
					`dispatch_lanes_async call with mode "swarm-pr-review:*" / "swarm-pr-feedback:*". ` +
					`Run the appropriate command first, then retry checkout preparation.`,
			);
		}
		if (state.prHeadSha) {
			throw new Error(
				`BLOCKED: ${state.mode} checkout preparation is allowed only before the PR head is bound`,
			);
		}
		return action(state, {
			markRecoveryRequired: async (gitState) => {
				const nextState: PrWorkflowGateState = {
					...state,
					updatedAt: isoNow(),
					checkoutRecovery: checkoutRecoveryRecord(gitState),
				};
				const persisted = await writeStateWhileLocked(directory, nextState);
				Object.assign(state, persisted);
				return persisted;
			},
		});
	});
}

export async function clearPrWorkflowGateState(
	directory: string,
	sessionID: string,
	expectedRevision?: number,
): Promise<void> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	await withSessionStateMutation(directory, normalizedSessionID, async () => {
		// The CAS-guard read is only meaningful when a caller supplies a
		// revision to compare against; skip it entirely otherwise so a
		// genuinely unreadable/malformed state file can still be cleared
		// (the sole purpose of this escape hatch) instead of the read itself
		// re-throwing the same failure it exists to recover from.
		if (expectedRevision !== undefined) {
			const current = await readPrWorkflowGateStateFromDisk(
				directory,
				normalizedSessionID,
			);
			if (!current || current.revision !== expectedRevision) {
				throw new Error(
					'BLOCKED: PR workflow gate state changed during terminal completion; revalidate the current session state before retrying',
				);
			}
		}
		try {
			await fsp.rm(workflowGateStatePath(directory, normalizedSessionID), {
				force: true,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		trackedStatesByProjectSession.delete(
			stateCacheKey(directory, normalizedSessionID),
		);
	});
}

/**
 * Abort an active PR workflow gate without reaching terminal completion.
 *
 * This is the escape hatch for the deadlock where `/swarm pr-review` activates
 * a PR_REVIEW gate without binding a PR head and the architect cannot reach
 * `completePrWorkflow` (compound `git fetch && git checkout` rejected by the
 * read-only shell classifier, missing PR ref, model confusion, etc.). Without
 * this path the durable gate is permanent for the session and the response
 * gate's auto-resume loop runs unbounded.
 *
 * Fail-closed semantics, checked in order:
 *   1. Authorization: operates on the raw caller `sessionID` only. A lane or
 *      child session whose ID has no gate record throws "no active gate" —
 *      lanes must not abort the controller's gate.
 *   2. Mode match when `expectedMode` is supplied.
 *   3. Refuses while `prFeedbackReadyToPublish` is set — clearing an armed
 *      gate would drop the immutable-commit binding and leave a half-published
 *      commit. The tool gate refuses armed abort too (defense in depth).
 *   4. Refuses while open `swarm-pr-*` delegations exist, matching
 *      `completePrWorkflow` — aborting mid-flight would orphan running lanes.
 *
 * Records a non-fatal audit event into the existing `.swarm/events.jsonl`
 * (no new ledger file), then delegates to `clearPrWorkflowGateState`.
 */
export async function abortPrWorkflow(
	directory: string,
	sessionID: string,
	options: { expectedMode?: PrWorkflowMode; reason?: string } = {},
): Promise<{
	mode: PrWorkflowMode;
	prHeadSha?: string;
	openLanes: number;
}> {
	const state = await requireAnyActiveState(directory, sessionID);
	if (options.expectedMode && state.mode !== options.expectedMode) {
		throw wrongModeError(state, options.expectedMode);
	}
	if (state.prFeedbackReadyToPublish) {
		throw new Error(
			`BLOCKED: ${state.mode} is armed for publication; abort is blocked. Complete the workflow with complete_pr_workflow (or push the bound commit first) before aborting.`,
		);
	}
	const openLanes = readDelegations(directory).filter(
		(record) =>
			record.parentSessionId === state.sessionID &&
			record.mode?.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	);
	if (openLanes.length > 0) {
		const laneIds = openLanes
			.map((record) => record.laneId ?? record.subagentSessionId ?? 'unknown')
			.filter(Boolean)
			.slice(0, 10)
			.join(', ');
		throw new Error(
			`BLOCKED: ${state.mode} abort refused while ${openLanes.length} PR workflow lane(s) are still in flight (lane ids: ${laneIds}). Collect their results or let them settle before aborting.`,
		);
	}
	const sanitizedReason =
		typeof options.reason === 'string'
			? options.reason.trim().slice(0, 500)
			: undefined;
	const abortEvent = {
		type: 'pr_workflow_aborted',
		timestamp: isoNow(),
		sessionID: state.sessionID,
		mode: state.mode,
		...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
		openLanes: openLanes.length,
		...(sanitizedReason ? { reason: sanitizedReason } : {}),
	};
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		await fsp.appendFile(
			eventsPath,
			`${JSON.stringify(abortEvent)}\n`,
			'utf-8',
		);
	} catch {
		// Non-fatal: the audit trail is best-effort. The gate must clear
		// regardless so the deadlock does not persist because of a write error.
	}
	// Pass the revision snapshot as a CAS guard, matching completePrWorkflow's
	// concurrency discipline: if the gate state changed between our reads and
	// this clear, the clear is rejected and the caller revalidates. Self-heals
	// on retry and prevents a late concurrent mutation from being silently
	// dropped by our clear.
	await clearPrWorkflowGateState(directory, sessionID, state.revision);
	return {
		mode: state.mode,
		...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
		openLanes: openLanes.length,
	};
}

/** Bind an active PR workflow to one immutable PR head. */
export async function bindPrWorkflowHead(
	directory: string,
	sessionID: string,
	prHeadSha: string,
): Promise<PrWorkflowGateState> {
	const state = await requireAnyActiveState(directory, sessionID);
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	await assertCurrentCheckoutHead(directory, normalizedHead);
	if (!state.prHeadSha)
		await assertPrReviewCleanCheckout(directory, state.mode);
	if (!state.prHeadSha && state.mode === 'PR_FEEDBACK') {
		await assertPrFeedbackTrackingCheckout(directory, normalizedHead);
	}
	if (state.prHeadSha && state.prHeadSha !== normalizedHead) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow is bound to PR head "${state.prHeadSha}"; received "${normalizedHead}"`,
		);
	}
	if (state.prHeadSha === normalizedHead) return state;
	const nextState = {
		...state,
		prHeadSha: normalizedHead,
		updatedAt: isoNow(),
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Bind an active PR_REVIEW workflow to one immutable merge-base scope. */
export async function bindPrReviewBase(
	directory: string,
	sessionID: string,
	options: { prHeadSha: string; baseRef: string; baseSha: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
	if (state.mode !== 'PR_REVIEW') {
		throw new Error('BLOCKED: only PR_REVIEW can bind a review merge base');
	}
	const baseRef = options.baseRef.trim();
	const baseSha = normalizePrHeadSha(options.baseSha).toLowerCase();
	if (!baseRef)
		throw new Error('BLOCKED: PR_REVIEW base_ref must not be empty');
	if (
		(state.prReviewBaseRef && state.prReviewBaseRef !== baseRef) ||
		(state.prReviewBaseSha && state.prReviewBaseSha !== baseSha)
	) {
		throw new Error(
			`BLOCKED: active PR_REVIEW is bound to merge-base scope "${state.prReviewBaseRef ?? '(unbound)'}" at "${state.prReviewBaseSha ?? '(unbound)'}"; received "${baseRef}" at "${baseSha}"`,
		);
	}
	if (state.prReviewBaseRef === baseRef && state.prReviewBaseSha === baseSha) {
		return state;
	}
	const prHeadSha = normalizePrHeadSha(options.prHeadSha).toLowerCase();
	const diffStats = await _test_exports.resolvePrReviewDiffStatsAsync(
		directory,
		baseSha,
		prHeadSha,
	);
	state = {
		...state,
		prReviewBaseRef: baseRef,
		prReviewBaseSha: baseSha,
		prReviewDepthTier: computePrReviewDepthTier(diffStats),
		...(diffStats ? { prReviewDiffStats: diffStats } : {}),
		updatedAt: isoNow(),
	};
	await persistState(directory, state);
	return state;
}

/**
 * Prove that caller-provided PR identity equals the actual checked-out commit.
 *
 * Two distinct failure modes are reported with separate, diagnostic-rich
 * messages (issue #1931): a null HEAD means Git could not resolve HEAD at all
 * (the directory may not be a repository, HEAD may be unborn, the commit may
 * be missing from a shallow clone, the `git` binary may not be on PATH, or
 * the bounded Git invocation may have timed out); a non-matching HEAD means
 * a different commit is checked out. Both messages name `directory` and the
 * exact remediation command so callers can self-diagnose instead of
 * cascading into fictional root causes.
 */
export async function assertCurrentCheckoutHead(
	directory: string,
	expectedHead: string,
): Promise<string> {
	const normalizedExpected = normalizePrHeadSha(expectedHead);
	const currentHead = (
		await _test_exports.resolveCurrentGitHeadAsync(directory)
	)?.trim();
	if (!currentHead) {
		throw new Error(
			`BLOCKED: cannot resolve the current Git HEAD in "${directory}" to verify against PR head "${normalizedExpected}". ` +
				`This means Git could not resolve HEAD (the working directory may not be a Git repository, ` +
				`HEAD may be unborn, the commit object may be missing in a shallow clone, the Git binary may not be on PATH, ` +
				`or the bounded Git invocation may have timed out). ` +
				`Verify with: git -C "${directory}" rev-parse --verify HEAD^{commit}`,
		);
	}
	if (currentHead.toLowerCase() !== normalizedExpected.toLowerCase()) {
		// Remediation must use the bare, standalone form the read-only shell
		// classifier actually accepts: `git -C ... switch` is banned as a state
		// transition (see isAllowedPrWorkflowReadOnlyShell), so instructing it
		// here contradicted the gate and left callers stuck (#1931 follow-up).
		throw new Error(
			`BLOCKED: current checkout HEAD "${currentHead}" does not match PR head "${normalizedExpected}" ` +
				`(working directory: "${directory}"). ` +
				`Run these bare, standalone commands from that directory: if the commit is not present locally, ` +
				`\`git fetch origin <pr-head-ref>\`; then \`git switch --detach ${normalizedExpected}\`. ` +
				`Do not prefix the switch with \`git -C\`; the read-only shell classifier refuses \`git -C ... switch\`.`,
		);
	}
	return normalizedExpected;
}

/** Prove that every PR-review lane reads the immutable checked-out PR tree. */
export async function assertPrReviewCleanCheckout(
	directory: string,
	mode: PrWorkflowMode = 'PR_REVIEW',
): Promise<void> {
	if (
		(await _test_exports.resolveIsWorkingTreeCleanAsync(directory)) !== true
	) {
		throw new Error(
			`BLOCKED: ${mode} requires a clean index and working tree at the exact PR head`,
		);
	}
}

async function assertPrFeedbackTrackingCheckout(
	directory: string,
	prHeadSha: string,
): Promise<void> {
	const upstream =
		await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
	if (!upstream) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires a current local branch bound to an exact remote name, remote branch ref, and remote-tracking ref before the first head bind; detached or non-tracking checkouts are not allowed',
		);
	}
	const matchingRemoteRefs =
		await _test_exports.resolveRemoteRefsContainingHeadAsync(
			directory,
			prHeadSha,
		);
	if (!matchingRemoteRefs?.includes(upstream.remoteTrackingRef)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK upstream "${upstream.remoteTrackingRef}" must point to the exact intake PR head "${prHeadSha}" before the first head bind`,
		);
	}
}

export async function enforcePrWorkflowDispatchLanesAsync(
	directory: string,
	sessionID: string,
	toolName: string,
): Promise<PrWorkflowGateState | null> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) return null;
	if (toolName === DISPATCH_TOOL_NAME) return state;
	if (toolName === BLOCKING_DISPATCH_TOOL_NAME) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow for session "${state.sessionID}" requires ${DISPATCH_TOOL_NAME}; ${BLOCKING_DISPATCH_TOOL_NAME} is not allowed`,
		);
	}
	return state;
}

export async function enforcePrReviewBaseDimensions(
	directory: string,
	sessionID: string,
	lanes: readonly PrWorkflowLaneSpec[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	const state = await bindPrWorkflowHead(
		directory,
		sessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_REVIEW') {
		throw wrongModeError(state, 'PR_REVIEW');
	}
	const normalizedLanes = normalizeWorkflowLanes(lanes);
	const claimedDimensionIds = normalizedLanes.flatMap(
		(lane) => lane.ownedWorkflowLanes ?? [lane.workflowLane],
	);
	const extras = claimedDimensionIds.filter(
		(laneId) =>
			!PR_REVIEW_BASE_DIMENSION_IDS.includes(laneId as PrReviewBaseDimensionId),
	);
	if (extras.length > 0) {
		const expected = PR_REVIEW_BASE_DIMENSION_IDS.join(', ');
		const received = claimedDimensionIds.join(', ') || '(none)';
		throw new Error(
			`BLOCKED: PR_REVIEW base dispatch lane ids must be drawn from: ${expected}. Received: ${received}`,
		);
	}
	// Tier L requires one dedicated lane per dimension on every base batch, not
	// only the initial wave — a later retry/supplementary batch may not use a
	// consolidated lane to settle multiple dimensions from a single artifact
	// that never went through the initial-wave tier check.
	if (
		(state.prReviewDepthTier ?? 'L') === 'L' &&
		normalizedLanes.some((lane) => (lane.ownedWorkflowLanes?.length ?? 1) !== 1)
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW base dispatch at depth tier L requires one dedicated lane per dimension; consolidated owned_workflow_lanes are allowed only at tiers S and M',
		);
	}
	const batchId = normalizeBatchId(options.batchId);
	const previous = state.prReviewBaseDispatches ?? [];
	if (previous.some((record) => record.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_REVIEW base batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		throw new Error('BLOCKED: PR_REVIEW base batch limit reached');
	}
	const record: PrReviewBaseDispatchRecord = {
		batchId,
		lanes: normalizedLanes.map((lane) => ({
			laneId: lane.laneId,
			workflowLane: lane.workflowLane as PrReviewBaseDimensionId,
			...(lane.ownedWorkflowLanes
				? {
						ownedWorkflowLanes:
							lane.ownedWorkflowLanes as PrReviewBaseDimensionId[],
					}
				: {}),
		})),
		validatedAt: isoNow(),
	};

	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewBaseDispatches: [...previous, record],
		prReviewBaseDispatch: record,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Validate durable exact-six PR review evidence across all base and retry batches. */
export async function assertPrReviewBaseCoverageSettled(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const batches = state.prReviewBaseDispatches ?? [];
	if (batches.length === 0) {
		throw new Error('BLOCKED: PR_REVIEW requires at least one base batch');
	}
	const covered = new Set<PrReviewBaseDimensionId>();
	for (const batch of batches) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:base',
			batch.validatedAt,
		);
		for (const obligation of successful) {
			covered.add(obligation as PrReviewBaseDimensionId);
		}
	}
	const missing = PR_REVIEW_BASE_DIMENSION_IDS.filter(
		(dimension) => !covered.has(dimension),
	);
	if (
		missing.length > 0 ||
		covered.size !== PR_REVIEW_BASE_DIMENSION_IDS.length
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW base coverage is incomplete; missing dimensions: ${missing.join(', ') || '(none)'}`,
		);
	}
	return state;
}

/** Persist a council/reviewer/critic validation batch before launch. */
export async function recordPrReviewValidationBatch(
	directory: string,
	sessionID: string,
	phase: PrReviewValidationPhase,
	lanes: readonly PrWorkflowLaneSpec[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
	if (state.mode !== 'PR_REVIEW') throw wrongModeError(state, 'PR_REVIEW');
	if (!state.prReviewTriggerEvalPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW validation dispatch requires a completed trigger evaluation',
		);
	}
	if (
		phase === 'reviewer' &&
		(state.prReviewValidationBatches ?? []).some(
			(batch) => batch.phase === 'council',
		)
	) {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'council',
		);
	} else if (phase === 'critic') {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
		);
	}
	const normalizedLanes = normalizeWorkflowLanes(lanes);
	if (
		(phase === 'reviewer' || phase === 'critic') &&
		normalizedLanes.some((lane) => !lane.reviewItemIds?.length)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${phase} lanes require non-empty review_item_ids ownership`,
		);
	}
	if (phase === 'reviewer' || phase === 'critic') {
		assertNoDuplicates(
			normalizedLanes.flatMap((lane) => lane.reviewItemIds ?? []),
			`PR_REVIEW ${phase} review item ownership`,
		);
		const assigned = normalizedLanes.flatMap(
			(lane) => lane.reviewItemIds ?? [],
		);
		const required =
			phase === 'reviewer'
				? derivePrReviewCandidateInventory(directory, state)
				: derivePrReviewCriticInventory(directory, state);
		assertExactStringSet(assigned, required, `PR_REVIEW ${phase} ownership`);
	}
	const batchId = normalizeBatchId(options.batchId);
	const previous = state.prReviewValidationBatches ?? [];
	if (previous.some((batch) => batch.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_REVIEW validation batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		throw new Error('BLOCKED: PR_REVIEW validation batch limit reached');
	}
	const record: PrReviewValidationBatchRecord = {
		batchId,
		phase,
		lanes: normalizedLanes,
		validatedAt: isoNow(),
	};
	// Any new reviewer verdict set invalidates every prior critic receipt. A
	// critic is meaningful only for the reviewer inventory that immediately
	// precedes it; stale critic batches must never certify later severities.
	const retained =
		phase === 'reviewer'
			? previous.filter((batch) => batch.phase !== 'critic')
			: previous;
	const nextState = {
		...state,
		updatedAt: isoNow(),
		prReviewValidationBatches: [...retained, record],
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Validate that every declared council/reviewer/critic obligation has a successful retry. */
export async function assertPrReviewValidationSettled(
	directory: string,
	sessionID: string,
	phase?: PrReviewValidationPhase,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const declaredPhases = new Set(
		(state.prReviewValidationBatches ?? []).map((batch) => batch.phase),
	);
	const phases: PrReviewValidationPhase[] = phase
		? [phase]
		: (['council', 'reviewer', 'critic'] as const).filter((candidate) =>
				declaredPhases.has(candidate),
			);
	for (const requiredPhase of phases) {
		const validationBatches = state.prReviewValidationBatches ?? [];
		const forbiddenSubagentSessionIds = new Set<string>();
		if (requiredPhase === 'critic') {
			for (const reviewerBatch of validationBatches.filter(
				(batch) => batch.phase === 'reviewer',
			)) {
				for (const record of findByBatchId(directory, reviewerBatch.batchId, {
					parentSessionId: state.sessionID,
				})) {
					const subagentSessionId = record.subagentSessionId?.trim();
					if (subagentSessionId) {
						forbiddenSubagentSessionIds.add(subagentSessionId);
					}
				}
			}
		}
		let batches = validationBatches.filter(
			(batch) => batch.phase === requiredPhase,
		);
		if (requiredPhase === 'reviewer') {
			let latestCouncilIndex = -1;
			for (let index = 0; index < validationBatches.length; index++) {
				if (validationBatches[index]?.phase === 'council') {
					latestCouncilIndex = index;
				}
			}
			if (latestCouncilIndex >= 0) {
				batches = validationBatches
					.slice(latestCouncilIndex + 1)
					.filter((batch) => batch.phase === 'reviewer');
			}
		}
		if (batches.length === 0) {
			throw new Error(
				requiredPhase === 'reviewer' && declaredPhases.has('council')
					? 'BLOCKED: PR_REVIEW requires at least one reviewer batch after the latest council batch'
					: `BLOCKED: PR_REVIEW requires at least one ${requiredPhase} batch`,
			);
		}
		const allObligations = new Set(
			batches.flatMap((batch) => batch.lanes.map((lane) => lane.workflowLane)),
		);
		const settled = new Set<string>();
		let hasFullySuccessfulExactBatch = false;
		for (const batch of batches) {
			const successful = successfulObligationsFromExactBatch(
				directory,
				state,
				batch.batchId,
				batch.lanes,
				`swarm-pr-review:${requiredPhase}`,
				batch.validatedAt,
				true,
				forbiddenSubagentSessionIds,
			);
			if (
				successful.size === batch.lanes.length &&
				batch.lanes.every((lane) => successful.has(lane.workflowLane))
			) {
				hasFullySuccessfulExactBatch = true;
			}
			for (const obligation of successful) {
				settled.add(obligation);
			}
		}
		if (
			(requiredPhase === 'reviewer' || requiredPhase === 'critic') &&
			!hasFullySuccessfulExactBatch
		) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${requiredPhase} requires one fully successful exact batch; complementary partial retries are not a coherent verdict set`,
			);
		}
		const missing = [...allObligations].filter(
			(obligation) => !settled.has(obligation),
		);
		if (missing.length > 0) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${requiredPhase} obligations lack successful exact artifacts: ${missing.join(', ')}`,
			);
		}
	}
	return state;
}

export async function declarePrFeedbackInventory(
	directory: string,
	sessionID: string,
	inventoryIds: readonly string[],
	options: { prHeadSha: string },
): Promise<PrWorkflowGateState> {
	const state = await bindPrWorkflowHead(
		directory,
		sessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_FEEDBACK') {
		throw wrongModeError(state, 'PR_FEEDBACK');
	}
	const normalizedInventory = normalizeInventoryIds(inventoryIds);
	const requiredHandoffIds = state.prFeedbackReviewHandoff?.findingIds ?? [];
	const inventorySet = new Set(normalizedInventory);
	const missingHandoffIds = requiredHandoffIds.filter(
		(findingId) => !inventorySet.has(findingId),
	);
	if (missingHandoffIds.length > 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK inventory must include every continued review finding: ${missingHandoffIds.join(', ')}`,
		);
	}
	if (state.prFeedbackInventory) {
		if (!sameStringArray(state.prFeedbackInventory, normalizedInventory)) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK inventory is immutable after declaration',
			);
		}
		return state;
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackInventory: normalizedInventory,
		prFeedbackVerifications: [],
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function enforcePrFeedbackVerificationOwnership(
	directory: string,
	sessionID: string,
	ownership: readonly PrFeedbackLaneOwnership[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	const state = await bindPrWorkflowHead(
		directory,
		sessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_FEEDBACK') {
		throw wrongModeError(state, 'PR_FEEDBACK');
	}
	const inventory = state.prFeedbackInventory;
	if (!inventory || inventory.length === 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification for session "${state.sessionID}" requires a declared feedback inventory before dispatch`,
		);
	}

	const normalizedOwnership = normalizeOwnership(ownership);
	const inventorySet = new Set(inventory);
	const claimedByItemId = new Map<string, string>();
	const previous = state.prFeedbackVerifications ?? [];
	const batchId = normalizeBatchId(options.batchId);
	if (previous.some((record) => record.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		throw new Error('BLOCKED: PR_FEEDBACK verification batch limit reached');
	}
	for (const record of previous) {
		for (const lane of record.ownership) {
			for (const itemId of lane.ownedItemIds) {
				claimedByItemId.set(itemId, lane.laneId);
			}
		}
	}

	for (const lane of normalizedOwnership) {
		for (const itemId of lane.ownedItemIds) {
			if (!inventorySet.has(itemId)) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK verification lane "${lane.laneId}" owns undeclared item "${itemId}"`,
				);
			}
			const previousLane = claimedByItemId.get(itemId);
			if (previousLane && previousLane !== lane.laneId) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK verification item "${itemId}" is owned by both "${previousLane}" and "${lane.laneId}"`,
				);
			}
			claimedByItemId.set(itemId, lane.laneId);
		}
	}

	const record: PrFeedbackVerificationRecord = {
		batchId,
		ownership: normalizedOwnership,
		validatedAt: isoNow(),
	};

	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackVerifications: [...previous, record],
		prFeedbackVerification: record,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Validate cumulative exact inventory ownership and settled verification artifacts. */
export async function assertPrFeedbackVerificationSettled(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	const inventory = state.prFeedbackInventory;
	const batches = state.prFeedbackVerifications ?? [];
	if (!inventory || batches.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires an immutable inventory and verification batches',
		);
	}
	const covered = new Set<string>();
	for (const batch of batches) {
		const successfulLaneIds = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.ownership.map((lane) => ({
				laneId: lane.laneId,
				workflowLane: lane.laneId,
			})),
			'swarm-pr-feedback:verification',
			batch.validatedAt,
			false,
			new Set(),
			currentDigest,
		);
		for (const lane of batch.ownership) {
			if (!successfulLaneIds.has(lane.laneId)) continue;
			if (
				!feedbackArtifactCoversItems(
					directory,
					state,
					batch.batchId,
					lane.laneId,
					lane.ownedItemIds,
				)
			)
				continue;
			for (const itemId of lane.ownedItemIds) covered.add(itemId);
		}
	}
	const missing = inventory.filter((itemId) => !covered.has(itemId));
	if (missing.length > 0 || covered.size !== inventory.length) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification ownership is incomplete; missing inventory items: ${missing.join(', ') || '(none)'}`,
		);
	}
	return state;
}

const PR_FEEDBACK_PHASE_ORDER: readonly PrFeedbackGatePhase[] = [
	'stage-b-reviewer',
	'stage-b-test',
	'closeout-reviewer',
	'closeout-critic',
];

/** Persist an actually executed Stage A receipt and invalidate later approvals. */
export async function recordPrFeedbackStageA(
	directory: string,
	sessionID: string,
	revisionDigest: string,
	checks: readonly PrFeedbackStageACheckReceipt[],
	options: {
		applicableCategories?: ReadonlyArray<'build' | 'typecheck' | 'lint'>;
		applicableObligations?: ReadonlyArray<{
			id: string;
			category: 'build' | 'typecheck' | 'lint';
			workingDirectory: string;
			source: string;
			validatorContract?: { path: string; id: string };
		}>;
	} = {},
): Promise<PrWorkflowGateState> {
	const state = await assertPrFeedbackVerificationSettled(directory, sessionID);
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (revisionDigest !== currentDigest) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A receipt is stale because the working-tree revision changed during validation',
		);
	}
	if (checks.length < 2 || checks.length > 258) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A requires two to 258 controller-created check receipts',
		);
	}
	const optionalCategoryOrder = ['build', 'typecheck', 'lint'] as const;
	const applicableCategories =
		options.applicableCategories ??
		optionalCategoryOrder.filter((category) =>
			checks.some((check) => check.category === category),
		);
	assertNoDuplicates(
		applicableCategories,
		'PR_FEEDBACK Stage A applicable categories',
	);
	if (
		applicableCategories.some(
			(category) => !optionalCategoryOrder.includes(category),
		)
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A applicability may contain only build, typecheck, and lint',
		);
	}
	const required = new Set<PrFeedbackStageACategory>([
		'diff-check',
		'reproduction',
		...applicableCategories,
	]);
	const singletonSeen = new Set<string>();
	const applicableObligations = [...(options.applicableObligations ?? [])];
	assertNoDuplicates(
		applicableObligations.map(({ id }) => id),
		'PR_FEEDBACK Stage A applicable obligations',
	);
	const requiredObligationIds = new Set(
		applicableObligations.map(({ id }) => id),
	);
	const commandDigests = new Set<string>();
	let reproductionFeedbackItemIds: string[] = [];
	for (const check of checks) {
		if (
			['diff-check', 'reproduction'].includes(check.category) &&
			singletonSeen.has(check.category)
		) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK Stage A contains duplicate category "${check.category}"`,
			);
		}
		singletonSeen.add(check.category);
		required.delete(check.category);
		if (check.obligationId) {
			const obligation = applicableObligations.find(
				(candidate) => candidate.id === check.obligationId,
			);
			if (
				!obligation ||
				obligation.category !== check.category ||
				obligation.workingDirectory !== (check.workingDirectory ?? '.') ||
				!requiredObligationIds.delete(check.obligationId)
			) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK Stage A receipt does not match one exact applicable obligation: ${check.obligationId}`,
				);
			}
			const sourceContract = obligation.source.includes('.pr-validation.json#')
				? {
						path: obligation.source.slice(
							0,
							obligation.source.lastIndexOf('#'),
						),
						id: obligation.source.slice(obligation.source.lastIndexOf('#') + 1),
					}
				: undefined;
			const requiredContract = obligation.validatorContract ?? sourceContract;
			if (
				requiredContract &&
				(check.validatorContract?.path !== requiredContract.path ||
					check.validatorContract.id !== requiredContract.id)
			) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK Stage A obligation ${obligation.id} requires exact validator contract provenance`,
				);
			}
		}
		const commandDigest = createHash('sha256')
			.update(
				`${check.obligationId ?? check.category}\0${check.workingDirectory ?? '.'}\0${check.command.join('\0')}`,
			)
			.digest('hex');
		if (commandDigests.has(commandDigest)) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK Stage A cannot reuse one command as multiple check receipts',
			);
		}
		commandDigests.add(commandDigest);
		if (
			check.category === 'diff-check' &&
			!sameStringArray(check.command, ['git', 'diff', '--check'])
		) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK Stage A diff-check receipt is not the exact git diff --check command',
			);
		}
		if (
			check.category === 'reproduction' &&
			(!check.targets?.length ||
				!check.feedbackTargets?.length ||
				check.targets.some(
					(target) => !check.command.join(' ').includes(target),
				))
		) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK Stage A reproduction receipt requires exact selected targets',
			);
		}
		if (check.category === 'reproduction') {
			reproductionFeedbackItemIds = check.feedbackTargets!.map(
				(mapping) => mapping.feedbackItemId,
			);
			assertNoDuplicates(
				reproductionFeedbackItemIds,
				'PR_FEEDBACK Stage A reproduction feedback item mappings',
			);
			if (
				check.feedbackTargets!.some(
					(mapping) => !check.targets!.includes(mapping.target),
				)
			) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK Stage A feedback mappings must reference exact executed reproduction targets',
				);
			}
		}
	}
	if (required.size > 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK Stage A is missing required checks: ${[...required].join(', ')}`,
		);
	}
	if (requiredObligationIds.size > 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK Stage A is missing applicable workspace obligations: ${[...requiredObligationIds].join(', ')}`,
		);
	}
	if (
		!sameStringArray(
			reproductionFeedbackItemIds,
			state.prFeedbackInventory ?? [],
		)
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A reproduction must map every immutable feedback item exactly once and in declared order',
		);
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackStageA: {
			revisionDigest: currentDigest,
			checks: [...checks],
			feedbackItemIds: reproductionFeedbackItemIds,
			applicableCategories: optionalCategoryOrder.filter((category) =>
				applicableCategories.includes(category),
			),
			applicableObligations,
			validatedAt: isoNow(),
		},
		prFeedbackGateBatches: [],
		prFeedbackReadyToPublish: undefined,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Record one ordered, single-lane feedback validation phase before launch. */
export async function recordPrFeedbackGateBatch(
	directory: string,
	sessionID: string,
	phase: PrFeedbackGatePhase,
	lane: PrFeedbackLaneOwnership,
	options: { batchId: string; prHeadSha: string; revisionDigest: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
	if (state.mode !== 'PR_FEEDBACK') throw wrongModeError(state, 'PR_FEEDBACK');
	const inventory = state.prFeedbackInventory;
	if (!inventory?.length) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK ordered gates require an immutable feedback inventory',
		);
	}
	const normalized = normalizeOwnership([lane])[0];
	if (!sameStringArray(normalized.ownedItemIds, inventory)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} must own every inventory item exactly once and in declared order`,
		);
	}
	const phaseIndex = PR_FEEDBACK_PHASE_ORDER.indexOf(phase);
	const prerequisite = PR_FEEDBACK_PHASE_ORDER[phaseIndex - 1];
	if (prerequisite) {
		state = await assertPrFeedbackGatePhaseSettled(
			directory,
			sessionID,
			prerequisite,
		);
	}
	// The prerequisite check may await independent evidence. Refresh the durable
	// state and digest afterwards so the newly-recorded batch cannot bind an
	// earlier content snapshot.
	const stageA = state.prFeedbackStageA;
	const refreshedInventory = state.prFeedbackInventory;
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (
		!stageA ||
		!refreshedInventory ||
		stageA.revisionDigest !== currentDigest ||
		!sameStringArray(stageA.feedbackItemIds ?? [], refreshedInventory) ||
		options.revisionDigest !== currentDigest
	) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} requires fresh Stage A checks on the current revision`,
		);
	}
	const batchId = normalizeBatchId(options.batchId);
	const previous = state.prFeedbackGateBatches ?? [];
	if (previous.some((batch) => batch.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK gate batch id "${batchId}" is already recorded`,
		);
	}
	const retained = previous.filter(
		(batch) => PR_FEEDBACK_PHASE_ORDER.indexOf(batch.phase) < phaseIndex,
	);
	const record: PrFeedbackGateBatchRecord = {
		batchId,
		phase,
		laneId: normalized.laneId,
		itemIds: normalized.ownedItemIds,
		revisionDigest: currentDigest,
		validatedAt: isoNow(),
	};
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackGateBatches: [...retained, record],
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Require the latest receipt for a feedback gate phase to be positive and fresh. */
export async function assertPrFeedbackGatePhaseSettled(
	directory: string,
	sessionID: string,
	phase: PrFeedbackGatePhase,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (state.prFeedbackStageA?.revisionDigest !== currentDigest) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} cannot use stale Stage A evidence`,
		);
	}
	if (
		!sameStringArray(
			state.prFeedbackStageA?.feedbackItemIds ?? [],
			state.prFeedbackInventory ?? [],
		)
	) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} Stage A reproduction is not bound to the exact immutable feedback inventory`,
		);
	}
	const batch = [...(state.prFeedbackGateBatches ?? [])]
		.reverse()
		.find((candidate) => candidate.phase === phase);
	if (!batch || batch.revisionDigest !== currentDigest) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} has no validation batch on the current revision`,
		);
	}
	const successful = successfulObligationsFromExactBatch(
		directory,
		state,
		batch.batchId,
		[
			{
				laneId: batch.laneId,
				workflowLane: phase,
				reviewItemIds: batch.itemIds,
			},
		],
		`swarm-pr-feedback:${phase}`,
		batch.validatedAt,
		true,
		new Set(),
		currentDigest,
	);
	if (!successful.has(phase)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} requires one complete, non-degraded positive verdict row per inventory item`,
		);
	}
	const record = findByBatchId(directory, batch.batchId, {
		parentSessionId: state.sessionID,
	}).find((candidate) => candidate.laneId === batch.laneId);
	if (record?.workspace?.dirtyHash !== currentDigest) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} artifact is not bound to the current revision digest`,
		);
	}
	assertIndependentFeedbackGateSessions(directory, state, phase);
	return state;
}

const PR_FEEDBACK_PHASE_ROLE: Readonly<Record<PrFeedbackGatePhase, string>> = {
	'stage-b-reviewer': 'reviewer',
	'stage-b-test': 'test_engineer',
	'closeout-reviewer': 'reviewer',
	'closeout-critic': 'critic',
};

/** Prove each ordered gate came from a distinct, correctly-typed child session. */
function assertIndependentFeedbackGateSessions(
	directory: string,
	state: PrWorkflowGateState,
	throughPhase: PrFeedbackGatePhase,
): void {
	const throughIndex = PR_FEEDBACK_PHASE_ORDER.indexOf(throughPhase);
	const batches = (state.prFeedbackGateBatches ?? []).filter(
		(batch) => PR_FEEDBACK_PHASE_ORDER.indexOf(batch.phase) <= throughIndex,
	);
	const seenSessions = new Set<string>();
	for (const batch of batches) {
		const matching = findByBatchId(directory, batch.batchId, {
			parentSessionId: state.sessionID,
		}).filter((record) => record.laneId === batch.laneId);
		if (matching.length !== 1) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK ${batch.phase} must resolve from exactly one durable child session`,
			);
		}
		const record = matching[0];
		const expectedRole = PR_FEEDBACK_PHASE_ROLE[batch.phase];
		const roleMatches =
			record.normalizedAgent === expectedRole ||
			(expectedRole === 'critic' &&
				record.normalizedAgent.startsWith('critic_'));
		if (!roleMatches) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK ${batch.phase} requires role ${expectedRole}, received ${record.normalizedAgent || '(unknown)'}`,
			);
		}
		if (seenSessions.has(record.subagentSessionId)) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK independent phases reused child session "${record.subagentSessionId}"`,
			);
		}
		seenSessions.add(record.subagentSessionId);
	}
}

/** Require every ordered feedback gate on one unchanged revision. */
export async function assertPrFeedbackReadyToPublish(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	let state = await assertPrFeedbackVerificationSettled(directory, sessionID);
	for (const phase of PR_FEEDBACK_PHASE_ORDER) {
		state = await assertPrFeedbackGatePhaseSettled(directory, sessionID, phase);
	}
	return state;
}

async function assertPrFeedbackPublicationArmed(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const armed = state.prFeedbackReadyToPublish;
	if (!armed) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication is not armed; call complete_pr_workflow once after every ordered gate passes',
		);
	}
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (armed.revisionDigest !== currentDigest) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK changed after publication was armed; rerun Stage A and every independent gate',
		);
	}
	if (
		(await _test_exports.resolveCurrentGitHeadAsync(directory))?.trim() !==
		armed.localHead
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK current Git HEAD changed after publication was armed',
		);
	}
	if (
		(await _test_exports.resolveIsWorkingTreeCleanAsync(directory)) !== true
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK working tree changed after publication was armed',
		);
	}
	const currentTarget =
		await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
	if (
		!currentTarget ||
		currentTarget.remoteName !== armed.remoteName ||
		currentTarget.remoteBranchRef !== armed.remoteBranchRef ||
		currentTarget.remoteTrackingRef !== armed.remoteRef
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK upstream publication target changed after publication was armed',
		);
	}
	return state;
}

export async function markPrReviewTriggerEvaluationComplete(
	directory: string,
	sessionID: string,
	artifactPath: string,
): Promise<PrWorkflowGateState> {
	const state = await assertPrReviewBaseCoverageSettled(directory, sessionID);
	const normalizedPath = artifactPath.trim();
	if (!normalizedPath) {
		throw new Error('BLOCKED: PR_REVIEW trigger artifact path is required');
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewTriggerEvalPath: normalizedPath,
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function assertPrReviewArtifactBoundary(
	directory: string,
	sessionID: string,
	runId: string,
	boundary: PrReviewArtifactBoundary,
	findingIds: string[],
): Promise<PrWorkflowGateState> {
	let state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	if (!state.prReviewTriggerEvalPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW findings persistence requires the trigger evaluation artifact',
		);
	}
	const persistedBoundaries = state.prReviewArtifactBoundaries ?? [];
	const boundaryOrder: readonly PrReviewArtifactBoundary[] = [
		'post_explorer',
		'post_reviewer',
		'post_critic',
	];
	const boundaryIndex = boundaryOrder.indexOf(boundary);
	const requiredPriorBoundary = boundaryOrder[boundaryIndex - 1];
	if (
		requiredPriorBoundary &&
		!persistedBoundaries.includes(requiredPriorBoundary)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings require the prior ${requiredPriorBoundary} checkpoint`,
		);
	}
	if (
		persistedBoundaries.some(
			(persisted) => boundaryOrder.indexOf(persisted) > boundaryIndex,
		)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings cannot be persisted after a later checkpoint`,
		);
	}
	if (boundary === 'post_reviewer') {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
		);
	} else if (boundary === 'post_critic') {
		await assertPrReviewValidationSettled(directory, sessionID, 'reviewer');
		if (derivePrReviewCriticInventory(directory, state).length > 0) {
			state = await assertPrReviewValidationSettled(
				directory,
				sessionID,
				'critic',
			);
		}
	}
	if (state.prReviewArtifactRunId && state.prReviewArtifactRunId !== runId) {
		throw new Error(
			`BLOCKED: PR_REVIEW artifacts are already bound to run "${state.prReviewArtifactRunId}"`,
		);
	}
	const expectedFindingIds = derivePrReviewCandidateInventory(directory, state);
	const normalizedFindingIds = [...new Set(findingIds)].sort();
	if (
		normalizedFindingIds.length !== findingIds.length ||
		JSON.stringify(normalizedFindingIds) !==
			JSON.stringify([...expectedFindingIds].sort())
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings must exactly cover the discovered candidate inventory`,
		);
	}
	return state;
}

/**
 * Artifact records are a projection of lane receipts, never a caller-controlled
 * replacement for them. Keep their workflow status/action aligned with the
 * reviewer and critic rows that the gate already authenticated.
 */
export async function assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
	directory: string,
	sessionID: string,
	boundary: PrReviewArtifactBoundary,
	records: readonly PrReviewArtifactRecord[],
): Promise<void> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	if (boundary === 'post_explorer') {
		for (const record of records) {
			if (
				record.status !== 'PENDING' ||
				record.next_action !== 'route_to_reviewer'
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_explorer record ${record.finding_id} must remain PENDING and route_to_reviewer`,
				);
			}
		}
		return;
	}

	const reviewerVerdicts = deriveLatestPrReviewReviewerVerdicts(
		directory,
		state,
	);
	const criticVerdicts =
		boundary === 'post_critic'
			? deriveLatestPrReviewCriticVerdicts(directory, state)
			: undefined;
	for (const record of records) {
		const reviewer = reviewerVerdicts.get(record.finding_id);
		if (!reviewer) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${boundary} record ${record.finding_id} has no authoritative reviewer verdict`,
			);
		}
		if (record.severity && record.severity !== reviewer.severity) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${boundary} record ${record.finding_id} severity differs from its reviewer verdict`,
			);
		}
		const requiresCritic =
			reviewer.classification === 'CONFIRMED' &&
			['CRITICAL', 'HIGH', 'MEDIUM'].includes(reviewer.severity);
		if (boundary === 'post_reviewer') {
			const expectedStatus =
				reviewer.classification === 'UNVERIFIED'
					? 'PENDING'
					: reviewer.classification;
			if (record.status !== expectedStatus) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_reviewer record ${record.finding_id} status differs from its reviewer verdict`,
				);
			}
			const expectedAction = requiresCritic
				? 'route_to_critic'
				: reviewer.classification === 'CONFIRMED' ||
						reviewer.classification === 'PRE_EXISTING'
					? 'report'
					: reviewer.classification === 'DISPROVED'
						? 'suppress_with_reason'
						: 'route_to_reviewer';
			if (record.next_action !== expectedAction) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_reviewer record ${record.finding_id} action does not match reviewer disposition`,
				);
			}
			continue;
		}

		if (!requiresCritic) {
			const expectedStatus =
				reviewer.classification === 'UNVERIFIED'
					? 'PENDING'
					: reviewer.classification;
			const expectedAction =
				reviewer.classification === 'CONFIRMED' ||
				reviewer.classification === 'PRE_EXISTING'
					? 'report'
					: reviewer.classification === 'DISPROVED'
						? 'suppress_with_reason'
						: 'route_to_reviewer';
			if (
				record.status !== expectedStatus ||
				record.next_action !== expectedAction
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} cannot override its non-critic reviewer disposition`,
				);
			}
			continue;
		}

		const critic = criticVerdicts?.get(record.finding_id);
		if (!critic) {
			throw new Error(
				`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} has no authoritative critic verdict`,
			);
		}
		if (record.severity && record.severity !== critic.severity) {
			throw new Error(
				`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} severity differs from its critic verdict`,
			);
		}
		if (critic.status === 'DISPROVED') {
			if (
				record.status !== 'DISPROVED' ||
				record.next_action !== 'suppress_with_reason'
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} must preserve the critic DISPROVED disposition`,
				);
			}
		} else if (
			record.status !== 'CONFIRMED' ||
			!['report', 'handoff_to_feedback'].includes(record.next_action)
		) {
			throw new Error(
				`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} action does not match its critic verdict`,
			);
		}
	}
}

export async function markPrReviewArtifactBoundary(
	directory: string,
	sessionID: string,
	runId: string,
	boundary: PrReviewArtifactBoundary,
	artifactPath: string,
	findingIds: string[],
	handoffRequired: boolean,
): Promise<PrWorkflowGateState> {
	const state = await assertPrReviewArtifactBoundary(
		directory,
		sessionID,
		runId,
		boundary,
		findingIds,
	);
	const boundaries = new Set(state.prReviewArtifactBoundaries ?? []);
	boundaries.add(boundary);
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewArtifactRunId: runId,
		prReviewFindingsPath: artifactPath,
		prReviewArtifactBoundaries: [...boundaries],
		prReviewHandoffRequired: handoffRequired,
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function markPrReviewHandoffComplete(
	directory: string,
	sessionID: string,
	runId: string,
	artifactPath: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	if (
		state.prReviewArtifactRunId !== runId ||
		!(state.prReviewArtifactBoundaries ?? []).includes('post_critic')
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW handoff requires the final findings boundary for the same run',
		);
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewHandoffPath: artifactPath,
	};
	await persistState(directory, nextState);
	return nextState;
}

const PR_REVIEW_HANDOFF_RELATIVE_PATH_PATTERN =
	/^pr-review\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/feedback-handoff\.json$/;
const PR_REVIEW_HANDOFF_MAX_BYTES = 128 * 1024;
const PR_REVIEW_FINDINGS_MAX_BYTES = 10 * 1024 * 1024;

const PrReviewFeedbackHandoffArtifactSchema = z
	.object({
		schema_version: z.literal(1),
		run_id: z.string().min(1).max(128),
		pr_head_sha: z.string().regex(/^[0-9a-f]{6,64}$/i),
		created_at: z.string().datetime(),
		pr_url: z.string().url().max(2000),
		finding_ids: z.array(z.string().min(1).max(128)).min(1).max(1000),
		summary: z.string().min(1).max(20_000),
		provenance: z.array(z.string().min(1).max(4000)).min(1).max(1000),
	})
	.strict();

function normalizePrReviewFeedbackHandoffPath(
	handoffPath: string,
): { runId: string; relativePath: string } | null {
	const normalized = handoffPath.trim().replace(/\\/g, '/');
	const relative = normalized.startsWith('.swarm/')
		? normalized.slice('.swarm/'.length)
		: normalized;
	const matched = relative.match(PR_REVIEW_HANDOFF_RELATIVE_PATH_PATTERN);
	if (!matched) return null;
	return { runId: matched[1], relativePath: relative };
}

async function readBoundedSwarmRegularFile(
	directory: string,
	relativePath: string,
	maxBytes: number,
	label: string,
): Promise<string> {
	const absPath = validateSwarmPath(directory, relativePath);
	const swarmRoot = path.resolve(directory, '.swarm');
	let rootStat: BigIntStats;
	let artifactStat: BigIntStats;
	try {
		rootStat = await fsp.lstat(swarmRoot, { bigint: true });
		artifactStat = await fsp.lstat(absPath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`BLOCKED: ${label} "${relativePath}" does not exist`);
		}
		throw error;
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error(
			`BLOCKED: ${label} root must be a real project .swarm directory`,
		);
	}
	if (artifactStat.isSymbolicLink() || !artifactStat.isFile()) {
		throw new Error(`BLOCKED: ${label} must be a bounded regular file`);
	}
	if (artifactStat.size > BigInt(maxBytes)) {
		throw new Error(`BLOCKED: ${label} exceeds ${maxBytes} bytes`);
	}
	const [realRoot, realArtifact] = await Promise.all([
		fsp.realpath(swarmRoot),
		fsp.realpath(absPath),
	]);
	const relativeRealPath = path.relative(realRoot, realArtifact);
	if (
		relativeRealPath === '' ||
		relativeRealPath === '..' ||
		relativeRealPath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeRealPath)
	) {
		throw new Error(`BLOCKED: ${label} escapes the project .swarm directory`);
	}
	await _test_exports.beforeBoundedSwarmFileOpen?.();
	const handle = await fsp.open(realArtifact, 'r');
	try {
		const openedStat = await handle.stat({ bigint: true });
		if (
			!openedStat.isFile() ||
			openedStat.size > BigInt(maxBytes) ||
			!sameBigIntFileIdentity(artifactStat, openedStat)
		) {
			throw new Error(`BLOCKED: ${label} changed during its bounded read`);
		}
		const [postRootStat, postArtifactStat, postRealRoot, postRealArtifact] =
			await Promise.all([
				fsp.lstat(swarmRoot, { bigint: true }),
				fsp.lstat(absPath, { bigint: true }),
				fsp.realpath(swarmRoot),
				fsp.realpath(absPath),
			]);
		const postRelativeRealPath = path.relative(postRealRoot, postRealArtifact);
		if (
			postRootStat.isSymbolicLink() ||
			!postRootStat.isDirectory() ||
			!sameBigIntFileIdentity(rootStat, postRootStat) ||
			postArtifactStat.isSymbolicLink() ||
			!postArtifactStat.isFile() ||
			!sameBigIntFileIdentity(artifactStat, postArtifactStat) ||
			!sameBigIntFileIdentity(openedStat, postArtifactStat) ||
			normalizeComparableFsPath(realRoot) !==
				normalizeComparableFsPath(postRealRoot) ||
			normalizeComparableFsPath(realArtifact) !==
				normalizeComparableFsPath(postRealArtifact) ||
			postRelativeRealPath === '' ||
			postRelativeRealPath === '..' ||
			postRelativeRealPath.startsWith(`..${path.sep}`) ||
			path.isAbsolute(postRelativeRealPath)
		) {
			throw new Error(
				`BLOCKED: ${label} changed or escaped during its bounded read`,
			);
		}
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		if (bytesRead > maxBytes) {
			throw new Error(`BLOCKED: ${label} exceeds ${maxBytes} bytes`);
		}
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

function sameBigIntFileIdentity(
	left: Pick<BigIntStats, 'dev' | 'ino'>,
	right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function normalizeComparableFsPath(value: string): string {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function readPrReviewFeedbackHandoffArtifact(
	directory: string,
	relativePath: string,
): Promise<{
	artifact: z.infer<typeof PrReviewFeedbackHandoffArtifactSchema>;
	digest: string;
}> {
	const raw = await readBoundedSwarmRegularFile(
		directory,
		relativePath,
		PR_REVIEW_HANDOFF_MAX_BYTES,
		'PR_REVIEW feedback handoff artifact',
	);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		throw new Error(
			'BLOCKED: PR_REVIEW feedback handoff artifact is not valid JSON',
		);
	}
	const parsed = PrReviewFeedbackHandoffArtifactSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error('BLOCKED: PR_REVIEW feedback handoff artifact is invalid');
	}
	if (
		new Set(parsed.data.finding_ids).size !== parsed.data.finding_ids.length
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW feedback handoff artifact contains duplicate finding IDs',
		);
	}
	return {
		artifact: parsed.data,
		digest: createHash('sha256').update(raw, 'utf8').digest('hex'),
	};
}

const PrReviewFindingProjectionSchema = z
	.object({
		finding_id: z.string().min(1).max(128),
		status: z.enum(['PENDING', 'CONFIRMED', 'DISPROVED', 'PRE_EXISTING']),
		next_action: z.enum([
			'route_to_reviewer',
			'route_to_critic',
			'report',
			'suppress_with_reason',
			'handoff_to_feedback',
		]),
	})
	.passthrough();

async function readActionableReviewFindingIds(
	directory: string,
	state: PrWorkflowGateState,
	runId: string,
): Promise<string[]> {
	const expectedPath = `pr-review/${runId}/findings.jsonl`;
	if (state.prReviewFindingsPath !== expectedPath) {
		throw new Error(
			`BLOCKED: PR_REVIEW transition requires the exact final findings artifact "${expectedPath}"`,
		);
	}
	const raw = await readBoundedSwarmRegularFile(
		directory,
		expectedPath,
		PR_REVIEW_FINDINGS_MAX_BYTES,
		'PR_REVIEW final findings artifact',
	);
	const latest = new Map<
		string,
		z.infer<typeof PrReviewFindingProjectionSchema>
	>();
	for (const [index, line] of raw.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(
				`BLOCKED: PR_REVIEW final findings artifact contains invalid JSON at line ${index + 1}`,
			);
		}
		const parsed = PrReviewFindingProjectionSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error(
				`BLOCKED: PR_REVIEW final findings artifact contains an invalid record at line ${index + 1}`,
			);
		}
		latest.set(parsed.data.finding_id, parsed.data);
	}
	return [...latest.values()]
		.filter(
			(record) =>
				record.status === 'CONFIRMED' &&
				record.next_action === 'handoff_to_feedback',
		)
		.map((record) => record.finding_id)
		.sort();
}

function canonicalGitHubPrUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.hostname.toLowerCase() !== 'github.com'
		) {
			return null;
		}
		const matched = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
		if (!matched) return null;
		const prNumber = Number(matched[3]);
		if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
		return `github.com/${matched[1].toLowerCase()}/${matched[2].toLowerCase()}/pull/${prNumber}`;
	} catch {
		return null;
	}
}

function workflowIdentity(state: PrWorkflowGateState): string {
	return (
		state.workflowInstanceId ??
		`legacy-${createHash('sha256')
			.update(`${state.sessionID}\0${state.mode}\0${state.activatedAt}`)
			.digest('hex')
			.slice(0, 32)}`
	);
}

function sameHandoffIds(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const normalizedLeft = [...new Set(left)].sort();
	const normalizedRight = [...new Set(right)].sort();
	return sameStringArray(normalizedLeft, normalizedRight);
}

function assertSamePrFeedbackHandoff(
	state: PrWorkflowGateState,
	relativePath: string,
	read: {
		artifact: z.infer<typeof PrReviewFeedbackHandoffArtifactSchema>;
		digest: string;
	},
	requestedPrUrl?: string,
): void {
	const existing = state.prFeedbackReviewHandoff;
	if (!existing) {
		throw new Error(
			`BLOCKED: session "${state.sessionID}" is already active in PR_FEEDBACK without persisted review handoff provenance`,
		);
	}
	const artifactPr = canonicalGitHubPrUrl(read.artifact.pr_url);
	const requestedPr = requestedPrUrl
		? canonicalGitHubPrUrl(requestedPrUrl)
		: artifactPr;
	if (
		!artifactPr ||
		(requestedPrUrl && requestedPr !== artifactPr) ||
		existing.path !== relativePath ||
		existing.runId !== read.artifact.run_id ||
		existing.digest !== read.digest ||
		existing.sourcePrHeadSha.toLowerCase() !==
			read.artifact.pr_head_sha.toLowerCase() ||
		canonicalGitHubPrUrl(existing.prUrl) !== artifactPr ||
		!sameHandoffIds(existing.findingIds, read.artifact.finding_ids)
	) {
		throw new Error(
			`BLOCKED: session "${state.sessionID}" is already active in PR_FEEDBACK for a different handoff or PR`,
		);
	}
}

async function assertPrReviewTerminalReady(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	await assertPrReviewCleanCheckout(directory, 'PR_REVIEW');
	const open = readDelegations(directory).filter(
		(record) =>
			record.parentSessionId === state.sessionID &&
			record.mode?.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	);
	if (open.length > 0) {
		throw new Error(
			`BLOCKED: PR_REVIEW transition has ${open.length} unsettled PR workflow lane(s)`,
		);
	}
	await assertPrReviewBaseCoverageSettled(directory, sessionID);
	if (!state.prReviewTriggerEvalPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW transition requires a persisted trigger evaluation artifact',
		);
	}
	if (
		(state.prReviewValidationBatches ?? []).some(
			(batch) => batch.phase === 'council',
		)
	) {
		await assertPrReviewValidationSettled(directory, sessionID, 'council');
	}
	await assertPrReviewValidationSettled(directory, sessionID, 'reviewer');
	const criticInventory = derivePrReviewCriticInventory(directory, state);
	if (criticInventory.length > 0) {
		if (
			!(state.prReviewValidationBatches ?? []).some(
				(batch) => batch.phase === 'critic',
			)
		) {
			throw new Error(
				`BLOCKED: PR_REVIEW reviewer verdicts require critic coverage for: ${criticInventory.join(', ')}`,
			);
		}
		await assertPrReviewValidationSettled(directory, sessionID, 'critic');
	}
	const requiredBoundaries: PrReviewArtifactBoundary[] = [
		'post_explorer',
		'post_reviewer',
		'post_critic',
	];
	const persistedBoundaries = new Set(state.prReviewArtifactBoundaries ?? []);
	const missing = requiredBoundaries.filter(
		(boundary) => !persistedBoundaries.has(boundary),
	);
	if (!state.prReviewFindingsPath || missing.length > 0) {
		throw new Error(
			`BLOCKED: PR_REVIEW transition requires durable findings checkpoints; missing: ${missing.join(', ') || 'findings path'}`,
		);
	}
	if (state.prReviewHandoffRequired && !state.prReviewHandoffPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW actionable findings require a persisted feedback handoff artifact',
		);
	}
	return state;
}

export async function transitionPrReviewToFeedback(
	directory: string,
	sessionID: string,
	request: {
		runId: string;
		handoffPath: string;
		prUrl?: string;
	},
): Promise<PrWorkflowGateState> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const normalizedHandoff = normalizePrReviewFeedbackHandoffPath(
		request.handoffPath,
	);
	if (!normalizedHandoff || normalizedHandoff.runId !== request.runId) {
		throw new Error(
			'BLOCKED: PR-feedback continuation must use .swarm/pr-review/<run_id>/feedback-handoff.json',
		);
	}
	const preliminaryRead = await readPrReviewFeedbackHandoffArtifact(
		directory,
		normalizedHandoff.relativePath,
	);
	const artifact = preliminaryRead.artifact;
	const artifactPr = canonicalGitHubPrUrl(artifact.pr_url);
	const requestedPr = request.prUrl
		? canonicalGitHubPrUrl(request.prUrl)
		: null;
	if (!artifactPr || (request.prUrl && requestedPr !== artifactPr)) {
		throw new Error(
			'BLOCKED: PR_REVIEW feedback handoff artifact does not match the requested GitHub PR URL',
		);
	}
	if (artifact.run_id !== request.runId) {
		throw new Error(
			'BLOCKED: PR_REVIEW feedback handoff artifact does not match the requested review run',
		);
	}
	const preliminary = await readPrWorkflowGateState(
		directory,
		normalizedSessionID,
	);
	if (preliminary?.mode === 'PR_FEEDBACK') {
		assertSamePrFeedbackHandoff(
			preliminary,
			normalizedHandoff.relativePath,
			preliminaryRead,
			request.prUrl,
		);
		return preliminary;
	}

	let sourceIdentity: string;
	let sourceRevision = 0;
	let provenance: PrFeedbackReviewHandoffRecord['provenance'];
	if (preliminary) {
		if (preliminary.mode !== 'PR_REVIEW') {
			throw wrongModeError(preliminary, 'PR_REVIEW');
		}
		const ready = await assertPrReviewTerminalReady(
			directory,
			normalizedSessionID,
		);
		if (
			workflowIdentity(ready) !== workflowIdentity(preliminary) ||
			ready.revision !== preliminary.revision ||
			ready.mode !== 'PR_REVIEW' ||
			ready.prReviewHandoffPath !== normalizedHandoff.relativePath ||
			ready.prReviewArtifactRunId !== request.runId ||
			!ready.prHeadSha ||
			ready.prHeadSha.toLowerCase() !== artifact.pr_head_sha.toLowerCase() ||
			canonicalGitHubPrUrl(artifact.pr_url) !==
				canonicalGitHubPrUrl(request.prUrl ?? artifact.pr_url)
		) {
			throw new Error(
				'BLOCKED: PR_REVIEW feedback handoff does not match the terminal active review state',
			);
		}
		const actionableIds = await readActionableReviewFindingIds(
			directory,
			ready,
			request.runId,
		);
		if (!sameHandoffIds(actionableIds, artifact.finding_ids)) {
			throw new Error(
				'BLOCKED: PR_REVIEW feedback handoff finding IDs do not match the authoritative final findings ledger',
			);
		}
		sourceIdentity = workflowIdentity(ready);
		sourceRevision = ready.revision;
		provenance = 'active-review-v1';
	} else {
		if (!request.prUrl) {
			throw new Error(
				'BLOCKED: continuing a completed PR_REVIEW requires an explicit GitHub PR URL',
			);
		}
		sourceIdentity = `external-${preliminaryRead.digest.slice(0, 32)}`;
		provenance = 'external-v1';
	}

	await _test_exports.beforePrFeedbackTransitionLock?.();
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const current = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (current?.mode === 'PR_FEEDBACK') {
			assertSamePrFeedbackHandoff(
				current,
				normalizedHandoff.relativePath,
				preliminaryRead,
				request.prUrl,
			);
			return current;
		}
		if (provenance === 'active-review-v1') {
			if (
				!current ||
				current.mode !== 'PR_REVIEW' ||
				workflowIdentity(current) !== sourceIdentity ||
				current.revision !== sourceRevision ||
				current.prHeadSha?.toLowerCase() !==
					artifact.pr_head_sha.toLowerCase() ||
				current.prReviewArtifactRunId !== request.runId ||
				current.prReviewHandoffPath !== normalizedHandoff.relativePath
			) {
				throw new Error(
					'BLOCKED: PR_REVIEW state changed while validating the feedback handoff; retry from current state',
				);
			}
		} else if (current) {
			throw new Error(
				'BLOCKED: another PR workflow became active while validating the external handoff',
			);
		}
		const lockedRead = await readPrReviewFeedbackHandoffArtifact(
			directory,
			normalizedHandoff.relativePath,
		);
		if (lockedRead.digest !== preliminaryRead.digest) {
			throw new Error(
				'BLOCKED: PR_REVIEW feedback handoff artifact changed during transition',
			);
		}
		if (
			artifactPr !== canonicalGitHubPrUrl(lockedRead.artifact.pr_url) ||
			lockedRead.artifact.run_id !== request.runId ||
			lockedRead.artifact.pr_head_sha.toLowerCase() !==
				artifact.pr_head_sha.toLowerCase() ||
			!sameHandoffIds(lockedRead.artifact.finding_ids, artifact.finding_ids)
		) {
			throw new Error(
				'BLOCKED: PR_REVIEW feedback handoff artifact changed during transition',
			);
		}
		const timestamp = isoNow();
		const nextState: PrWorkflowGateState = {
			schemaVersion: GATE_SCHEMA_VERSION,
			revision: sourceRevision,
			workflowInstanceId: randomUUID(),
			sessionID: normalizedSessionID,
			mode: 'PR_FEEDBACK',
			activatedAt: timestamp,
			updatedAt: timestamp,
			prFeedbackReviewHandoff: {
				path: normalizedHandoff.relativePath,
				runId: lockedRead.artifact.run_id,
				sourcePrHeadSha: lockedRead.artifact.pr_head_sha.toLowerCase(),
				prUrl: lockedRead.artifact.pr_url,
				findingIds: [...new Set(lockedRead.artifact.finding_ids)].sort(),
				digest: preliminaryRead.digest,
				sourceWorkflowInstanceId: sourceIdentity,
				provenance,
			},
			prFeedbackTargetUrl: artifact.pr_url,
		};
		return writeStateWhileLocked(directory, nextState, {
			replaceWorkflowInstanceId:
				provenance === 'active-review-v1'
					? current?.workflowInstanceId
					: undefined,
		});
	});
}

export async function declarePrFeedbackScope(
	directory: string,
	sessionID: string,
	taskId: string,
	files: string[],
): Promise<PrWorkflowGateState> {
	const state = await assertPrFeedbackVerificationSettled(directory, sessionID);
	const revisionDigest = await currentPrFeedbackRevisionDigest(
		directory,
		state,
	);
	const previous = state.prFeedbackScopes ?? [];
	const existing = previous.find((entry) => entry.taskId === taskId);
	if (existing?.consumedByCallId) {
		throw new Error(
			`SCOPE_NOT_DECLARED: PR-feedback scope ${taskId} was already consumed; use a fresh task_id for any retry`,
		);
	}
	const record: PrFeedbackScopeDeclarationRecord = {
		taskId,
		files,
		revisionDigest,
		declaredAt: isoNow(),
	};
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackScopes: [
			...previous.filter((entry) => entry.taskId !== taskId),
			record,
		],
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function resolvePrFeedbackScopeDeclaration(
	directory: string,
	sessionID: string,
	taskId: string,
): Promise<PrFeedbackScopeDeclarationRecord | null> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (state?.mode !== 'PR_FEEDBACK') return null;
	const declaration = (state.prFeedbackScopes ?? []).find(
		(entry) => entry.taskId === taskId,
	);
	if (!declaration) return null;
	await assertPrFeedbackVerificationSettled(directory, sessionID);
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	return currentDigest === declaration.revisionDigest ? declaration : null;
}

export async function consumePrFeedbackScopeDeclaration(
	directory: string,
	sessionID: string,
	taskId: string,
	callID: string,
): Promise<PrFeedbackScopeDeclarationRecord | null> {
	const declaration = await resolvePrFeedbackScopeDeclaration(
		directory,
		sessionID,
		taskId,
	);
	if (!declaration) return null;
	if (declaration.consumedByCallId && declaration.consumedByCallId !== callID) {
		throw new Error(
			`SCOPE_NOT_DECLARED: PR-feedback scope ${taskId} was already consumed by another Task call`,
		);
	}
	if (declaration.consumedByCallId === callID) return declaration;
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackScopes: (state.prFeedbackScopes ?? []).map((entry) =>
			entry.taskId === taskId ? { ...entry, consumedByCallId: callID } : entry,
		),
	};
	await persistState(directory, nextState);
	return { ...declaration, consumedByCallId: callID };
}

export async function validatePrFeedbackScopeBinding(
	directory: string,
	binding: {
		taskId: string;
		files: string[];
		dispatchCallId?: string;
		workflowSessionId?: string;
		workflowRevisionDigest?: string;
	},
): Promise<boolean> {
	if (!binding.workflowSessionId || !binding.workflowRevisionDigest)
		return false;
	const declaration = await resolvePrFeedbackScopeDeclaration(
		directory,
		binding.workflowSessionId,
		binding.taskId,
	);
	return Boolean(
		declaration &&
			declaration.consumedByCallId === binding.dispatchCallId &&
			declaration.revisionDigest === binding.workflowRevisionDigest &&
			JSON.stringify(declaration.files) === JSON.stringify(binding.files),
	);
}

export async function enforcePrWorkflowToolBefore(
	directory: string,
	sessionID: string,
	toolName: string,
	args: Record<string, unknown> | undefined,
	generatedAgentNames: readonly string[] = [],
): Promise<void> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) return;
	const normalizedTool = toolName.toLowerCase();
	const isDirectAgentTask =
		normalizedTool === 'task' || normalizedTool === 'run_agent';
	const requestedAgentFields = (['subagent_type', 'agent'] as const).filter(
		(field) => Object.hasOwn(args ?? {}, field),
	);
	const requestedRoles = requestedAgentFields.map((field) => {
		const value = args?.[field];
		if (typeof value !== 'string' || !value.trim()) return '';
		return resolveGeneratedAgentRole(value.trim(), generatedAgentNames);
	});
	const isDirectWrite = (WRITE_TOOL_NAMES as readonly string[]).includes(
		normalizedTool,
	);
	const command = typeof args?.command === 'string' ? args.command.trim() : '';
	const serializedArgs = JSON.stringify(args ?? {});
	const referencesProtectedWorkflowEvidence = containsProtectedWorkflowPath(
		command || serializedArgs,
	);
	const isInternalWorkflowTool = isPrWorkflowControllerTool(
		state.mode,
		normalizedTool,
	);
	const isShellTool = normalizedTool === 'bash' || normalizedTool === 'shell';
	// Preserve the original short-circuit: only resolve the upstream target when
	// the tool is actually a non-empty shell command, so non-shell tools do not
	// pay for an extra Git invocation.
	let isReadOnlyShell = false;
	// Hoisted so the BLOCKED diagnosis (C2) re-classifies against the exact same
	// permission envelope the classifier evaluated, computed once.
	let shellPermissionEnvelope: {
		allowCheckout: boolean;
		allowFetch: boolean;
		allowTrackingFetch: boolean;
		trackingFetchTarget?: {
			remoteName: string;
			remoteBranchRef: string;
		} | null;
	} | null = null;
	if (isShellTool && command.length > 0) {
		const trackingFetchTarget = state.prHeadSha
			? await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory)
			: null;
		shellPermissionEnvelope = {
			allowCheckout: !state.prHeadSha,
			allowFetch: !state.prHeadSha,
			allowTrackingFetch: Boolean(state.prHeadSha),
			trackingFetchTarget,
		};
		isReadOnlyShell = isAllowedPrWorkflowReadOnlyShell(
			command,
			shellPermissionEnvelope,
		);
	}
	const trustedCapability = getPrWorkflowToolCapability(
		normalizedTool,
		state.mode,
	);
	const isTrustedWorkflowTool =
		trustedCapability !== null &&
		isTrustedPrWorkflowToolInvocationSafe(normalizedTool, args ?? {});
	const isNamedReadOnlyTool =
		isTrustedWorkflowTool ||
		(normalizedTool !== 'build_check' &&
			isAllowedPrReviewReadOnlyToolName(normalizedTool) &&
			readOnlyToolArgumentsAreSafe(args ?? {}));
	const isRecoverySafeEvidenceTool =
		(trustedCapability === 'observe' &&
			isTrustedPrWorkflowToolInvocationSafe(normalizedTool, args ?? {})) ||
		(normalizedTool !== 'build_check' &&
			isAllowedPrReviewReadOnlyToolName(normalizedTool) &&
			readOnlyToolArgumentsAreSafe(args ?? {}));
	if (state.checkoutRecovery) {
		if (
			isRecoverySafeEvidenceTool ||
			isReadOnlyShell ||
			normalizedTool === 'abort_pr_workflow' ||
			normalizedTool === 'pr_workflow_status' ||
			normalizedTool === 'prepare_pr_workflow_checkout'
		) {
			return;
		}
		throw new Error(
			`BLOCKED: ${state.mode} requires manual Git recovery before controller work can continue. ` +
				`code=${state.checkoutRecovery.code} retryable=false required_action=${state.checkoutRecovery.requiredAction}`,
		);
	}
	if (
		referencesProtectedWorkflowEvidence &&
		!isInternalWorkflowTool &&
		!isNamedReadOnlyTool &&
		!isReadOnlyShell
	) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow evidence under .swarm is controller-owned and cannot be modified directly`,
		);
	}
	const isShellCommandRequiringVerification =
		isShellTool && command.length > 0 && !isReadOnlyShell;
	const isRemoteReviewTool =
		/(?:git|github|pull|(?:^|[_-])pr(?:[_-]|$)|issue|review)/i.test(
			normalizedTool,
		);
	const hasRemoteMutationVerb =
		/(?:^|[_-])(?:add|approve|cancel|close|comment|commit|convert|create|delete|dismiss|edit|mark|merge|push|ready|reopen|rerun|resolve|submit|transfer|unresolve|update)(?:[_-]|$)/i.test(
			normalizedTool,
		);
	const hasRemoteReadVerb =
		/(?:^|[_-])(?:github|git)[_-]+(?:check|checks|checkout|diff|fetch|get|inspect|list|read|search|status|view)(?:[_-]|$)/i.test(
			normalizedTool,
		) ||
		/(?:^|[_-])(?:github|git)[_-]+(?:pull[_-]+request|pr|issue|review[_-]+thread)[_-]+(?:check|checks|checkout|diff|fetch|get|inspect|list|read|search|status|view)(?:[_-]|$)/i.test(
			normalizedTool,
		);
	const isRemoteMutationTool =
		isRemoteReviewTool && (hasRemoteMutationVerb || !hasRemoteReadVerb);
	const isRemoteCheckoutTool =
		/(?:^|[_-])(?:github|git)[_-]+checkout(?:[_-]|$)/i.test(normalizedTool);
	const isShellCheckout =
		(normalizedTool === 'bash' || normalizedTool === 'shell') &&
		(/\bgit\b(?:(?![;&|]).){0,200}\b(?:checkout|switch)\b/i.test(command) ||
			/\bgh\s+pr\s+checkout\b/i.test(command));
	// Mirror ONLY the trailing `2>&1` tolerance the read-only classifier grants,
	// so the canonical detached review checkout stays canonical when a model
	// appends the stderr merge. cd-prefixes are deliberately NOT normalized here:
	// a cd-wrapped transition is already rejected by the classifier, so the
	// backstop below must still see (and block) the raw wrapped form.
	const stderrMergeNormalizedCommand = command
		.replace(PR_WORKFLOW_TRAILING_STDERR_MERGE_PATTERN, '')
		.trim();
	const isCanonicalReviewCheckout =
		/^git\s+switch\s+--detach\s+[0-9a-f]{40,64}$/i.test(
			stderrMergeNormalizedCommand,
		);
	// The write-side predicates below (isDetachedFeedbackCheckout, git commit,
	// publication/push) intentionally evaluate the RAW `command`: a wrapped form
	// of a state transition or publication has no usability necessity, so any
	// cd-prefix or 2>&1 wrapper on those keeps them fail-closed.
	const detachedFeedbackSwitchMatch = command.match(
		/^git\s+switch\s+--detach\s+(\S+)$/i,
	);
	const isDetachedFeedbackCheckout =
		Boolean(
			detachedFeedbackSwitchMatch?.[1] &&
				isSafeGitRefToken(detachedFeedbackSwitchMatch[1]),
		) || /^gh\s+pr\s+checkout\b.*\s--detach(?:\s|$)/i.test(command);
	const containsGitCommitShell =
		isShellCommandRequiringVerification &&
		/\bgit\b(?:(?![;&|]).){0,200}\bcommit\b/i.test(command);
	const isStandaloneGitCommitShell =
		containsGitCommitShell && isSafeStandaloneGitCommit(command);
	const isPublicationShell =
		isShellCommandRequiringVerification &&
		(/\bgit\b(?:(?![;&|]).){0,200}\bpush\b/i.test(command) ||
			/\bgh\s+(?:api|pr|issue|run)\b/i.test(command));
	const isPublicationTool = !isInternalWorkflowTool && isRemoteMutationTool;
	const isCoderTask =
		isDirectAgentTask &&
		requestedRoles.length > 0 &&
		requestedRoles.every((role) => role === 'coder');
	// A bounded, append-only diagnosis for blocked shell commands (C2). Only
	// computed when the blocked tool is actually a shell command the classifier
	// rejected; never widens anything — it explains WHY and points at the
	// read-only alternative plus the pr_workflow_status observation tool.
	const blockedShellDiagnosis =
		isShellTool && command && !isReadOnlyShell && shellPermissionEnvelope
			? ` ${describeBlockedPrReviewShellCommand(command, shellPermissionEnvelope)}`
			: '';
	if (state.mode === 'PR_REVIEW') {
		const isAllowedReviewTool =
			isInternalWorkflowTool ||
			isNamedReadOnlyTool ||
			(isReadOnlyShell && (!isShellCheckout || isCanonicalReviewCheckout));
		if (
			!isAllowedReviewTool ||
			(Boolean(state.prHeadSha) && (isRemoteCheckoutTool || isShellCheckout))
		) {
			if (!state.prHeadSha && isShellCheckout) {
				throw new Error(
					'BLOCKED: PR_REVIEW checkout must use standalone commands: fetch the PR head, verify the full commit object with `git cat-file -e <full_pr_head_sha>^{commit}`, then run `git switch --detach <full_pr_head_sha>` and bind that exact head before dispatching explorer lanes. Do not use `--track FETCH_HEAD`.' +
						blockedShellDiagnosis,
				);
			}
			throw new Error(
				'BLOCKED: PR_REVIEW is read-only and fail-closed; only controller tools and positively classified observation tools are allowed, and every agent lane requires structured dispatch_lanes_async' +
					describePrWorkflowControllerToolNames(state.mode) +
					blockedShellDiagnosis,
			);
		}
		return;
	}
	if (isDirectAgentTask && !isCoderTask) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK reviewer, test, critic, explorer, and unknown agent lanes require structured dispatch_lanes_async provenance',
		);
	}
	if (
		!isInternalWorkflowTool &&
		!isDirectAgentTask &&
		!isDirectWrite &&
		!isShellTool &&
		!isNamedReadOnlyTool
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK rejects unclassified plugin/MCP tools; use positively classified observation tools, built-in structured write tools after verification, or the workflow controller' +
				describePrWorkflowControllerToolNames(state.mode),
		);
	}
	if (state.prHeadSha && (isShellCheckout || isRemoteCheckoutTool)) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK checkout is immutable after exact PR head binding',
		);
	}
	if (containsGitCommitShell && state.prFeedbackReadyToPublish) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK is armed for publication; the approved commit is immutable',
		);
	}
	if (
		(containsGitCommitShell || isPublicationShell) &&
		hasUnsafeShellControlSyntax(command)
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication commands must be standalone shell commands without control, redirection, or command-substitution syntax',
		);
	}
	if (containsGitCommitShell && !isStandaloneGitCommitShell) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK commit must use a standalone git commit command after every ordered local gate passes',
		);
	}
	if (state.prFeedbackReadyToPublish) {
		// NOTE: abort_pr_workflow is deliberately NOT allowed in the armed
		// state. Clearing an armed gate would drop the immutable-commit /
		// upstream binding and leave a half-published commit; once state is
		// null, enforcePrWorkflowToolBefore returns early and arbitrary
		// pushes would become allowed. abortPrWorkflow also refuses armed
		// state at the hook level (defense in depth). The armed workflow
		// must be completed (or explicitly un-armed by a human) before any
		// abort path opens.
		if (normalizedTool === 'complete_pr_workflow') return;
		if (isNamedReadOnlyTool) return;
		if (
			(normalizedTool === 'bash' || normalizedTool === 'shell') &&
			command.length > 0 &&
			isAllowedPrWorkflowReadOnlyShell(command, {
				allowCheckout: false,
				allowFetch: false,
				allowTrackingFetch: false,
			})
		)
			return;
		if (normalizedTool === 'bash' || normalizedTool === 'shell') {
			const armedState = await assertPrFeedbackPublicationArmed(
				directory,
				sessionID,
			);
			const armed = armedState.prFeedbackReadyToPublish!;
			if (isSafeExactBoundPush(command, armed)) return;
			throw new Error(
				`BLOCKED: PR_FEEDBACK is armed for publication; only the exact approved push is allowed: ${expectedBoundPushCommand(armed)}`,
			);
		}
		throw new Error(
			'BLOCKED: PR_FEEDBACK is armed for publication; only read-only inspection, the exact approved push, and complete_pr_workflow are allowed',
		);
	}
	if (!state.prHeadSha && isDetachedFeedbackCheckout) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires a tracked PR branch before the first head bind; detached checkout is valid for PR_REVIEW, not PR_FEEDBACK.',
		);
	}
	if (isStandaloneGitCommitShell) {
		await assertPrFeedbackReadyToPublish(directory, sessionID);
		return;
	}
	if (isPublicationShell || isPublicationTool) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication is not armed; finish every ordered gate, create the one approved commit, and call complete_pr_workflow before publishing',
		);
	}
	if (isShellCommandRequiringVerification) {
		if (!state.prHeadSha && isShellCheckout) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK checkout must use a safe standalone pre-bind form: `gh pr checkout <number-or-url>` without force/submodule flags, or `git switch -c <local> --track <remote>/<branch>`. Detached checkouts are not allowed in PR_FEEDBACK. Then verify exact HEAD, a clean tree, and the intended upstream before dispatching feedback lanes.',
			);
		}
		throw new Error(
			'BLOCKED: PR_FEEDBACK shell commands fail closed unless they are explicit read-only intake or the one standalone approved git commit; use structured coder/write tools for fixes and run_pr_feedback_stage_a for validation',
		);
	}
	if (
		!isDirectWrite &&
		!isShellCommandRequiringVerification &&
		!isRemoteMutationTool &&
		!isCoderTask &&
		normalizedTool !== 'prepare_pr_feedback_scope'
	)
		return;
	// abort_pr_workflow is a pure escape hatch, not a publication-adjacent
	// operation. It must be reachable from a bound-but-unverified PR_FEEDBACK
	// state — that is exactly the deadlock scenario it exists to resolve
	// (architect cannot complete the ordered gates). The hook itself enforces
	// the armed-state refusal, so letting it past the verification gate here
	// does not weaken publication safety.
	if (normalizedTool === 'abort_pr_workflow') return;
	await assertPrFeedbackVerificationSettled(directory, sessionID);
}

/** Validate the terminal PR workflow contract before removing its durable gate. */
export async function completePrWorkflow(
	directory: string,
	sessionID: string,
	expectedMode: PrWorkflowMode,
	prHeadSha: string,
): Promise<PrWorkflowCompletionStatus> {
	const state = await requireBoundState(directory, sessionID, expectedMode);
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	if (state.prHeadSha !== normalizedHead) {
		throw new Error(
			`BLOCKED: cannot complete ${expectedMode} at PR head "${normalizedHead}"; workflow is bound to "${state.prHeadSha}"`,
		);
	}
	const open = readDelegations(directory).filter(
		(record) =>
			record.parentSessionId === state.sessionID &&
			record.mode?.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	);
	if (open.length > 0) {
		throw new Error(
			`BLOCKED: ${expectedMode} completion has ${open.length} unsettled PR workflow lane(s)`,
		);
	}
	if (expectedMode === 'PR_REVIEW') {
		const readyState = await assertPrReviewTerminalReady(directory, sessionID);
		if (
			workflowIdentity(readyState) !== workflowIdentity(state) ||
			readyState.revision !== state.revision
		) {
			throw new Error(
				'BLOCKED: PR_REVIEW state changed while checking terminal readiness; retry from current state',
			);
		}
	} else {
		const readyState = await assertPrFeedbackReadyToPublish(
			directory,
			sessionID,
		);
		const currentDigest = await currentPrFeedbackRevisionDigest(
			directory,
			readyState,
		);
		const armed = readyState.prFeedbackReadyToPublish;
		if (!armed) {
			const localHead = (
				await _test_exports.resolveCurrentGitHeadAsync(directory)
			)?.trim();
			if (!localHead) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without a verified local Git HEAD',
				);
			}
			const commitCount = await _test_exports.resolveCommitCountSinceAsync(
				directory,
				state.prHeadSha!,
				localHead,
			);
			if (commitCount !== 1) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK publication requires exactly one descendant commit after the immutable intake head',
				);
			}
			if (
				(await _test_exports.resolveIsExactSingleChildCommitAsync(
					directory,
					state.prHeadSha!,
					localHead,
				)) !== true
			) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK publication commit must be a non-merge direct child of the immutable intake head',
				);
			}
			if (
				(await _test_exports.resolveIsWorkingTreeCleanAsync(directory)) !== true
			) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK publication requires a clean index and working tree so all approved content is captured by the bound commit',
				);
			}
			const upstreamTarget =
				await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
			if (!upstreamTarget) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without a current branch bound to an exact remote name, remote branch ref, and remote-tracking ref',
				);
			}
			await persistState(directory, {
				...readyState,
				updatedAt: isoNow(),
				prFeedbackReadyToPublish: {
					revisionDigest: currentDigest,
					localHead,
					remoteName: upstreamTarget.remoteName,
					remoteBranchRef: upstreamTarget.remoteBranchRef,
					remoteRef: upstreamTarget.remoteTrackingRef,
					validatedAt: isoNow(),
				},
			});
			return 'ready-to-publish';
		}
		if (armed.revisionDigest !== currentDigest) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK publication revision differs from the independently approved content digest',
			);
		}
		const publishedHead = (
			await _test_exports.resolveCurrentGitHeadAsync(directory)
		)?.trim();
		const remoteRefs = publishedHead
			? await _test_exports.resolveRemoteRefsContainingHeadAsync(
					directory,
					publishedHead,
				)
			: null;
		const remoteHead = await _test_exports.resolveExactRemoteBranchHeadAsync(
			directory,
			armed.remoteName,
			armed.remoteBranchRef,
		);
		if (
			!publishedHead ||
			publishedHead !== armed.localHead ||
			!remoteRefs?.includes(armed.remoteRef) ||
			remoteHead?.toLowerCase() !== armed.localHead.toLowerCase()
		) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK completion requires approved commit ${armed.localHead} at current Git HEAD and intended remote-tracking ref ${armed.remoteRef} at that exact commit`,
			);
		}
	}
	await _test_exports.beforeTerminalClear?.();
	await clearPrWorkflowGateState(directory, sessionID, state.revision);
	return 'completed';
}

export const _test_exports = {
	workflowGateStateRelativePath,
	workflowGateStateLockRelativePath,
	resetTrackedStateCache: () => {
		trackedStatesByProjectSession.clear();
		pendingStateMutationsByProjectSession.clear();
		_test_exports.beforeTerminalClear = undefined;
		_test_exports.beforePrFeedbackTransitionLock = undefined;
		_test_exports.beforeBoundedSwarmFileOpen = undefined;
		_test_exports.beforeSafeDirectoryCreate = undefined;
		_test_exports.beforeAtomicTempWrite = undefined;
		_test_exports.beforeAtomicRename = undefined;
	},
	beforeTerminalClear: undefined as (() => Promise<void>) | undefined,
	beforePrFeedbackTransitionLock: undefined as
		| (() => Promise<void>)
		| undefined,
	beforeBoundedSwarmFileOpen: undefined as (() => Promise<void>) | undefined,
	beforeSafeDirectoryCreate: undefined as
		| ((parentPath: string, nextPath: string) => Promise<void>)
		| undefined,
	beforeAtomicTempWrite: undefined as (() => Promise<void>) | undefined,
	beforeAtomicRename: undefined as (() => Promise<void>) | undefined,
	resolveCurrentGitHead,
	resolveCurrentGitHeadAsync,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamPushTargetAsync,
	resolveCurrentUpstreamRemoteRef,
	resolveExactRemoteBranchHead,
	resolveExactRemoteBranchHeadAsync,
	resolveCommitCountSince,
	resolveCommitCountSinceAsync,
	resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync,
	resolveIsExactSingleChildCommit,
	resolveIsExactSingleChildCommitAsync,
	resolvePrReviewDiffStats,
	resolvePrReviewDiffStatsAsync,
	resolvePrWorkflowRevisionDigest,
	resolveRemoteRefsContainingHead,
	resolveRemoteRefsContainingHeadAsync,
	parseCriticVerdict,
	isProcessAlive,
	// Exposed for the `-c` config-injection regression test. The publication
	// path that calls this needs a fully-armed ready-to-publish state, so the
	// classifier is not otherwise reachable from a focused unit test.
	isSafeStandaloneGitCommit,
	rename: fsp.rename,
	nowMs: () => Date.now(),
};

async function requireAnyActiveState(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) {
		// Issue #1931: surface the activation path so callers don't go
		// hunting for a fictional gate file. See withPrWorkflowCheckoutPreparationLock
		// for the same diagnostic on the prepare_pr_workflow_checkout path.
		throw new Error(
			`BLOCKED: no active PR workflow gate for session "${normalizeSessionID(sessionID)}". ` +
				`The gate is activated by running \`/swarm pr-review <pr-ref>\` (PR_REVIEW) or \`/swarm pr-feedback <pr-ref>\` (PR_FEEDBACK), ` +
				`or by the first dispatch_lanes_async call with mode "swarm-pr-review:*" / "swarm-pr-feedback:*".`,
		);
	}
	return state;
}

async function requireBoundState(
	directory: string,
	sessionID: string,
	expectedMode: PrWorkflowMode,
): Promise<PrWorkflowGateState> {
	const state = await requireAnyActiveState(directory, sessionID);
	if (state.mode !== expectedMode) {
		throw wrongModeError(state, expectedMode);
	}
	if (!state.prHeadSha) {
		throw new Error(
			`BLOCKED: active ${expectedMode} workflow is not bound to a PR head`,
		);
	}
	if (expectedMode === 'PR_REVIEW') {
		await assertCurrentCheckoutHead(directory, state.prHeadSha);
		await assertPrReviewCleanCheckout(directory);
	}
	return state;
}

function wrongModeError(
	state: PrWorkflowGateState,
	expectedMode: PrWorkflowMode,
): Error {
	return new Error(
		`BLOCKED: session "${state.sessionID}" is active in ${state.mode}, not ${expectedMode}`,
	);
}

function normalizeWorkflowLanes(lanes: readonly PrWorkflowLaneSpec[]): Array<{
	laneId: string;
	workflowLane: string;
	reviewItemIds?: string[];
	ownedWorkflowLanes?: string[];
}> {
	if (!Array.isArray(lanes) || lanes.length === 0) {
		throw new Error(
			'BLOCKED: PR workflow lane validation requires at least one lane',
		);
	}
	const normalized = lanes.map((lane) => {
		const workflowLane = lane.workflowLane?.trim();
		const laneId = lane.laneId?.trim() || workflowLane;
		if (!workflowLane || !laneId) {
			throw new Error(
				'BLOCKED: PR workflow lane validation requires every lane to have non-empty laneId and workflow_lane values',
			);
		}
		const reviewItemIds = lane.reviewItemIds?.map((itemId: string) =>
			itemId.trim(),
		);
		if (reviewItemIds?.some((itemId: string) => !itemId)) {
			throw new Error(
				'BLOCKED: PR workflow review_item_ids must not contain empty values',
			);
		}
		if (reviewItemIds) {
			assertNoDuplicates(reviewItemIds, 'review item ids within one lane');
		}
		const ownedWorkflowLanes = lane.ownedWorkflowLanes?.map((owned: string) =>
			owned.trim(),
		);
		if (ownedWorkflowLanes) {
			if (ownedWorkflowLanes.some((owned: string) => !owned)) {
				throw new Error(
					'BLOCKED: PR workflow owned_workflow_lanes must not contain empty values',
				);
			}
			assertNoDuplicates(
				ownedWorkflowLanes,
				'owned workflow lanes within one lane',
			);
			if (!ownedWorkflowLanes.includes(workflowLane)) {
				throw new Error(
					`BLOCKED: PR workflow lane "${laneId}" must include its own workflow_lane "${workflowLane}" in owned_workflow_lanes`,
				);
			}
		}
		return {
			laneId,
			workflowLane,
			...(reviewItemIds ? { reviewItemIds } : {}),
			...(ownedWorkflowLanes ? { ownedWorkflowLanes } : {}),
		};
	});
	assertNoDuplicates(
		normalized.map((lane) => lane.laneId),
		'lane ids',
	);
	assertNoDuplicates(
		normalized.map((lane) => lane.workflowLane),
		'workflow lane ids',
	);
	assertNoDuplicates(
		normalized.flatMap(
			(lane) => lane.ownedWorkflowLanes ?? [lane.workflowLane],
		),
		'owned workflow lane ids across lanes',
	);
	return normalized;
}

function normalizeInventoryIds(inventoryIds: readonly string[]): string[] {
	if (!Array.isArray(inventoryIds) || inventoryIds.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK inventory declaration requires at least one feedback item id',
		);
	}
	const normalized = inventoryIds.map((inventoryId) => {
		const itemId = inventoryId.trim();
		if (!itemId) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK inventory declaration contains an empty item id',
			);
		}
		return itemId;
	});
	assertNoDuplicates(normalized, 'inventory item ids');
	return normalized.sort();
}

function normalizeOwnership(
	ownership: readonly PrFeedbackLaneOwnership[],
): PrFeedbackLaneOwnership[] {
	if (!Array.isArray(ownership) || ownership.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK verification ownership requires at least one lane declaration',
		);
	}
	const normalized = ownership.map((lane) => {
		const laneId = lane.laneId?.trim();
		if (!laneId) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK verification ownership requires every lane to have a non-empty laneId',
			);
		}
		const ownedItemIds = normalizeInventoryIds(lane.ownedItemIds);
		return { laneId, ownedItemIds };
	});
	assertNoDuplicates(
		normalized.map((lane) => lane.laneId),
		'PR_FEEDBACK verification lane ids',
	);
	return normalized;
}

function assertNoDuplicates(values: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`BLOCKED: duplicate ${label} are not allowed: ${value}`);
		}
		seen.add(value);
	}
}

function containsProtectedWorkflowPath(value: string): boolean {
	return /(?:^|[^A-Za-z0-9_.-])\.swarm(?:[\\/]|$)/i.test(
		value.replace(/\\\\/g, '\\'),
	);
}

const PR_WORKFLOW_SHARED_CONTROLLER_TOOLS = new Set([
	'abort_pr_workflow',
	'collect_lane_results',
	'complete_pr_workflow',
	'dispatch_lanes_async',
	'prepare_pr_workflow_checkout',
]);

const PR_REVIEW_CONTROLLER_TOOLS = new Set([
	'parse_lane_candidates',
	'write_pr_review_artifact',
	'write_pr_review_trigger_eval',
]);

const PR_FEEDBACK_CONTROLLER_TOOLS = new Set([
	'prepare_pr_feedback_scope',
	'run_pr_feedback_stage_a',
]);

function isPrWorkflowControllerTool(
	mode: PrWorkflowMode,
	toolName: string,
): boolean {
	if (PR_WORKFLOW_SHARED_CONTROLLER_TOOLS.has(toolName)) return true;
	return mode === 'PR_REVIEW'
		? PR_REVIEW_CONTROLLER_TOOLS.has(toolName)
		: PR_FEEDBACK_CONTROLLER_TOOLS.has(toolName);
}

/**
 * Bounded, append-only recovery pointer (S1.5) naming the allowed controller
 * tools for the active mode, so a blocked agent finds the allowlist directly
 * instead of discovering it by retry-and-fail churn. Sourced from the same
 * `PR_WORKFLOW_SHARED_CONTROLLER_TOOLS` / `PR_REVIEW_CONTROLLER_TOOLS` /
 * `PR_FEEDBACK_CONTROLLER_TOOLS` sets the classifier itself checks — never a
 * duplicated list — and sorted for deterministic output. Pure string builder;
 * it never authorizes anything.
 */
function describePrWorkflowControllerToolNames(mode: PrWorkflowMode): string {
	const modeTools =
		mode === 'PR_REVIEW'
			? PR_REVIEW_CONTROLLER_TOOLS
			: PR_FEEDBACK_CONTROLLER_TOOLS;
	const names = [...PR_WORKFLOW_SHARED_CONTROLLER_TOOLS, ...modeTools].sort(
		(a, b) => a.localeCompare(b),
	);
	return ` Allowed controller tools for ${mode}: ${names.join(', ')}. Observe current state read-only with the pr_workflow_status tool.`;
}

const PR_REVIEW_READ_ONLY_TOOL_NAMES = new Set([
	'ast_grep_search',
	'codesearch',
	'glob',
	'grep',
	'list',
	'lsp',
	'open',
	'read',
	'search',
	'skill',
	'tree',
	'view',
	// Both spellings of web fetch/search are intentional: normalizeToolName
	// lowercases but does NOT collapse underscores, and harnesses disagree —
	// some ship `web_fetch`/`web_search`, others `webfetch`/`websearch`.
	'web_fetch',
	'web_search',
	'webfetch',
	'websearch',
]);

function isTrustedPrWorkflowToolInvocationSafe(
	toolName: string,
	args: Record<string, unknown>,
): boolean {
	if (toolName === 'lint') return args.mode === 'check';
	if (toolName === 'sast_scan') return args.capture_baseline !== true;
	return true;
}

/**
 * Positive classifier for non-shell tools usable during PR_REVIEW.
 *
 * Connector and MCP tools are intentionally fail-closed: an unknown name is
 * blocked unless it carries a recognized observation verb and no mutation
 * verb. This prevents newly installed tools such as filesystem_write_file or
 * mcp.filesystem.write_file from silently bypassing the workflow boundary.
 */
function isAllowedPrReviewReadOnlyToolName(toolName: string): boolean {
	if (PR_REVIEW_READ_ONLY_TOOL_NAMES.has(toolName)) return true;
	const tokens = toolName.split(/[._:/-]+/).filter(Boolean);
	if (
		tokens.some((token) =>
			/^(?:add|alter|and|append|apply|approve|cancel|checkout|close|comment|commit|convert|create|delete|destroy|dismiss|drop|edit|execute|grant|insert|mark|merge|move|patch|prepend|publish|push|ready|remove|rename|replace|resolve|rerun|revoke|run|send|submit|then|transfer|truncate|unresolve|update|upload|write)$/i.test(
				token,
			),
		)
	) {
		return false;
	}
	return tokens.some((token) =>
		/^(?:check|checks|diff|fetch|find|get|glob|grep|hover|inspect|list|lookup|open|read|references|scan|screenshot|search|show|status|symbols|tree|view)$/i.test(
			token,
		),
	);
}

function readOnlyToolArgumentsAreSafe(
	value: unknown,
	key = '',
	depth = 0,
): boolean {
	if (depth > 8) return false;
	const keyTokens = key
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.split(/[._:/-]+/)
		.filter(Boolean);
	if (
		keyTokens.some((token) =>
			/^(?:append|body|content|create|data|delete|destination|destroy|edit|insert|mutation|output|patch|payload|prepend|remove|replace|save|set|truncate|update|upload|write)$/i.test(
				token,
			),
		)
	) {
		return false;
	}
	if (keyTokens.some((token) => /^(?:method|verb)$/i.test(token))) {
		return typeof value === 'string' && /^(?:GET|HEAD)$/i.test(value.trim());
	}
	if (
		keyTokens.length === 1 &&
		keyTokens.some((token) => /^(?:action|operation)$/i.test(token))
	) {
		return (
			typeof value === 'string' &&
			/^(?:check|diff|fetch|find|get|inspect|list|lookup|open|read|scan|search|show|status|view)$/i.test(
				value.trim(),
			)
		);
	}
	if (/^mode$/i.test(key) && typeof value === 'string') {
		return /^(?:r|rb|read)$/i.test(value.trim());
	}
	if (typeof value === 'string') {
		if (
			keyTokens.some((token) =>
				/^(?:query|request|sql|statement)$/i.test(token),
			) &&
			/(?:\b(?:alter|call|comment|create|delete|drop|exec(?:ute)?|grant|insert|merge|mutation|replace|revoke|truncate|update|upsert)\b|\bselect\b[\s\S]{0,4000}\binto\s+[A-Za-z_"'`])/i.test(
				value,
			)
		) {
			return false;
		}
		return !/(?:^(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE|write|edit|patch|create|delete|destroy|remove|replace|truncate|update|upload)$|(?:^|[\r\n])\s*(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE)\s+\S+(?:\s+HTTP\/\d(?:\.\d)?)?|\bmutation\b|\b(?:create|drop|alter|truncate)\s+(?:or\s+replace\s+)?(?:table|database|schema|index|view|function|procedure|trigger|sequence)\b|\b(?:delete\s+from|insert\s+into|merge\s+into|replace\s+into|upsert\s+into)\b|\bupdate\s+[A-Za-z0-9_."'`-]+(?:\s+(?:AS\s+)?[A-Za-z0-9_"'`-]+)?\s+set\b|\b(?:grant|revoke)\s+\S+\s+(?:on|from|to)\b|\b(?:call|exec(?:ute)?)\s+[A-Za-z0-9_."'`-]+|\b(?:rm|rmdir|del|remove-item|move-item|set-content|add-content)\b)/i.test(
			value,
		);
	}
	if (
		value === null ||
		value === undefined ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every((entry) =>
			readOnlyToolArgumentsAreSafe(entry, key, depth + 1),
		);
	}
	if (typeof value === 'object') {
		return Object.entries(value).every(([childKey, childValue]) =>
			readOnlyToolArgumentsAreSafe(childValue, childKey, depth + 1),
		);
	}
	return false;
}

/**
 * Read-only-neutral wrapper grammar for the intake shell. Field reports showed
 * models habitually emitting `cd <dir> && <cmd> 2>&1`, which the compound-syntax
 * reject turned into a 100% block of otherwise-allowlisted read-only commands.
 * Both tolerated wrappers are provably read-only-neutral: `cd` only moves the
 * subshell working directory and `2>&1` merges stderr into stdout without
 * touching files. Fail-closed grammar: cd targets — quoted or bare — may contain
 * ONLY a conservative path charset. Shell metacharacters, `$`, `%`, backticks,
 * and nested quotes never match, so cross-shell quoting/expansion differentials
 * (bash vs cmd.exe vs PowerShell) cannot smuggle syntax through the stripped
 * region. A target outside the grammar leaves the command unstripped and the
 * pre-existing compound-syntax reject fails it closed.
 */
const PR_WORKFLOW_CD_PREFIX_PATTERN =
	/^cd\s+(?:\/d\s+)?(?:"[A-Za-z0-9 _.\\/:~+-]+"|'[A-Za-z0-9 _.\\/:~+-]+'|[A-Za-z0-9_.\\/:~+-]+)\s*&&\s*/i;
const PR_WORKFLOW_TRAILING_STDERR_MERGE_PATTERN = /\s+2>&1\s*$/;
const PR_WORKFLOW_MAX_CD_PREFIX_STRIPS = 3;

/**
 * Matches `git [-C <dir>]... <rest>`, capturing `<rest>` in group 1.
 *
 * Deliberately NOT fully case-insensitive: the `-C` directory-override flag
 * is matched with an explicit `[Cc]`-free literal `-C` so that lowercase
 * `-c` (git's arbitrary per-invocation config flag, e.g. `-c
 * core.pager=touch`) never satisfies this branch. `-c` therefore falls
 * through to the fail-closed reject instead of being silently treated as a
 * (misidentified) directory override. Only the leading `git` keyword itself
 * is matched case-insensitively via the `[Gg][Ii][Tt]` character classes.
 */
const PR_WORKFLOW_GIT_DIR_OVERRIDE_PATTERN =
	/^[Gg][Ii][Tt](?: -C (?:"[^"]+"|'[^']+'|\S+))* (.+)$/;
/** Detects a `git -C <dir>` prefix specifically (see pattern note above). */
const PR_WORKFLOW_GIT_HAS_DIR_OVERRIDE_PATTERN = /^[Gg][Ii][Tt] -C /;

/**
 * Strip the tolerated read-only wrappers (leading `cd <path> &&` segments and one
 * trailing `2>&1`), reporting whether a cd prefix was removed so state-transition
 * verbs can keep requiring the bare form (see the git `-C` ban those verbs carry).
 */
export function normalizePrWorkflowShellCommand(command: string): {
	normalized: string;
	strippedCdPrefix: boolean;
} {
	let normalized = command.trim();
	const withoutTrailingMerge = normalized.replace(
		PR_WORKFLOW_TRAILING_STDERR_MERGE_PATTERN,
		'',
	);
	if (withoutTrailingMerge !== normalized)
		normalized = withoutTrailingMerge.trim();
	let strippedCdPrefix = false;
	for (let index = 0; index < PR_WORKFLOW_MAX_CD_PREFIX_STRIPS; index += 1) {
		const next = normalized.replace(PR_WORKFLOW_CD_PREFIX_PATTERN, '');
		if (next === normalized) break;
		normalized = next.trim();
		strippedCdPrefix = true;
	}
	return { normalized, strippedCdPrefix };
}

function isAllowedPrWorkflowReadOnlyShell(
	command: string,
	options: {
		allowCheckout: boolean;
		allowFetch: boolean;
		allowTrackingFetch: boolean;
		trackingFetchTarget?: {
			remoteName: string;
			remoteBranchRef: string;
		} | null;
	},
): boolean {
	const { normalized: inner, strippedCdPrefix } =
		normalizePrWorkflowShellCommand(command);
	const normalized = inner.replace(/\s+/g, ' ');
	if (!normalized) return false;

	// A pre-verification shell is an intake-only surface. Reject composition,
	// redirection, interpolation, and multiline scripts before considering an
	// individual command. This deliberately fails closed for unknown syntax.
	// Runs against the post-wrapper-strip remainder (`inner`) so a chained
	// command hidden after the tolerated `cd <dir> &&` wrapper is still caught.
	if (/[\r\n;&|<>`]/.test(inner) || /\$\(|@\(/.test(inner)) return false;

	// A stripped `cd <dir> &&` prefix must never smuggle a state transition past
	// the bare-form requirement those verbs carry (mirror of the `git -C` ban,
	// extended to `gh pr checkout`): re-block them here even though the remainder
	// looks like an otherwise-allowlisted command.
	if (
		strippedCdPrefix &&
		(/^git (?:fetch|checkout|switch|branch)(?:\s|$)/i.test(normalized) ||
			/^gh pr checkout(?:\s|$)/i.test(normalized))
	)
		return false;

	const gitMatch = normalized.match(PR_WORKFLOW_GIT_DIR_OVERRIDE_PATTERN);
	if (gitMatch?.[1]) {
		const hasDirectoryOverride =
			PR_WORKFLOW_GIT_HAS_DIR_OVERRIDE_PATTERN.test(normalized);
		if (
			hasDirectoryOverride &&
			/^(?:fetch|checkout|switch|branch)(?:\s|$)/i.test(gitMatch[1])
		)
			return false;
		return isAllowedPrWorkflowGitIntake(gitMatch[1], options);
	}

	if (/^gh /i.test(normalized)) return isAllowedPrFeedbackGhIntake(normalized);

	if (
		/^rg\b/i.test(normalized) &&
		/\s--pre(?:-glob)?(?:\s|=|$)/i.test(normalized)
	)
		return false;

	return /^(?:rg|grep|cat|Get-Content|Select-String|Test-Path|Get-ChildItem|ls|dir|pwd|which|where)(?:\s|$)/i.test(
		normalized,
	);
}

/**
 * Bounded, append-only prose explaining WHY a shell command was rejected under
 * the PR_REVIEW gate, the working read-only alternative, and a pointer to the
 * pr_workflow_status observation tool. Mirrors the classifier's decision order
 * so the named reason is accurate. Pure string builder — it never authorizes
 * anything and never widens the classifier. Kept well under ~600 chars.
 */
function describeBlockedPrReviewShellCommand(
	command: string,
	options: {
		allowCheckout: boolean;
		allowFetch: boolean;
		allowTrackingFetch: boolean;
		trackingFetchTarget?: {
			remoteName: string;
			remoteBranchRef: string;
		} | null;
	},
): string {
	const { normalized: inner, strippedCdPrefix } =
		normalizePrWorkflowShellCommand(command);
	const normalized = inner.replace(/\s+/g, ' ');
	const gitMatch = normalized.match(PR_WORKFLOW_GIT_DIR_OVERRIDE_PATTERN);
	const pointer =
		' Observe HEAD/branch/dirty/remotes/gate state read-only with the pr_workflow_status tool.';
	let detail: string;
	if (/[\r\n;&|<>`]/.test(inner) || /\$\(|@\(/.test(inner)) {
		detail =
			'Reason: compound-syntax (;, &&, |, <, >, backtick, or $()/@()). Run ONE command per call; a single leading `cd <dir> &&` and a trailing `2>&1` are tolerated for reads only.';
	} else if (
		strippedCdPrefix &&
		(/^git (?:fetch|checkout|switch|branch)(?:\s|$)/i.test(normalized) ||
			/^gh pr checkout(?:\s|$)/i.test(normalized))
	) {
		detail =
			'Reason: cd-prefix-on-checkout-verb. Run fetch/checkout/switch/branch or `gh pr checkout` bare, with no `cd <dir> &&` prefix.';
	} else if (
		PR_WORKFLOW_GIT_HAS_DIR_OVERRIDE_PATTERN.test(normalized) &&
		gitMatch?.[1] &&
		/^(?:fetch|checkout|switch|branch)(?:\s|$)/i.test(gitMatch[1])
	) {
		detail =
			'Reason: git -C on a state transition. Run fetch/checkout/switch/branch from the target directory, not via `git -C <dir>`.';
	} else if (
		!options.allowFetch &&
		gitMatch?.[1] &&
		/^fetch(?:\s|$)/i.test(gitMatch[1])
	) {
		detail = options.allowTrackingFetch
			? 'Reason: bound-fetch-restriction. After the PR head is bound only the exact bound remote-tracking fetch is allowed; read remote state via gh_evidence otherwise.'
			: 'Reason: bound-fetch-restriction. Fetch is not permitted in this bound state; read remote state via gh_evidence instead.';
	} else if (gitMatch?.[1] || /^git(?:\s|$)/i.test(normalized)) {
		detail =
			'Reason: unlisted git verb. Allowed git reads: status/log/show/diff/rev-parse/merge-base/ls-files/grep/blame/cat-file/for-each-ref, `branch` with listing flags only, `stash list`, `worktree list`, `remote -v`, `config --get`.';
	} else if (/^gh(?:\s|$)/i.test(normalized)) {
		detail =
			'Reason: unlisted gh form. Allowed gh reads: pr view/diff/checks/status/list, run view/list/watch, issue view/list, search, api GET. If gh is missing, fetch the api.github.com REST URL with the web fetch tool.';
	} else {
		detail =
			'Reason: unlisted binary. Allowed: rg/grep/cat/ls/dir/pwd/which/where plus read-only git/gh intake.';
	}
	return detail + pointer;
}

function hasUnsafeShellControlSyntax(command: string): boolean {
	return /[;&|<>`\r\n]/.test(command) || /\$\(/.test(command);
}

function isSafeStandaloneGitCommit(command: string): boolean {
	if (hasUnsafeShellControlSyntax(command)) return false;
	if (/(?:^|\s)--(?:allow-empty|amend)(?:\s|=|$)/i.test(command)) return false;
	// Case-sensitive on `-C`, for the same reason as
	// PR_WORKFLOW_GIT_DIR_OVERRIDE_PATTERN: a case-insensitive match let
	// lowercase `-c` — git's arbitrary per-invocation config flag — satisfy the
	// directory-override branch, so `git -c core.hooksPath=/tmp/evil commit -m x`
	// was accepted as a bare standalone commit with the injected config stripped
	// from what the classifier evaluated. On a mutating verb that means
	// attacker-chosen hooks execute at commit time. Only the leading `git`
	// keyword stays case-insensitive; `-c ...` now falls through to the
	// fail-closed reject.
	return /^[Gg][Ii][Tt](?:\s+-C(?:=|\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|<>`]+))?\s+commit(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|<>`]+))*\s*$/.test(
		command.trim(),
	);
}

function boundPushTarget(
	armed: PrFeedbackReadyToPublishRecord,
): { remote: string; branch: string } | null {
	const remote = armed.remoteName;
	const branch = armed.remoteBranchRef.slice('refs/heads/'.length);
	if (!armed.remoteBranchRef.startsWith('refs/heads/') || !branch) return null;
	if (/\s|[;&|<>`]/.test(remote) || /\s|[;&|<>`]/.test(branch)) return null;
	return { remote, branch };
}

function expectedBoundPushCommand(
	armed: PrFeedbackReadyToPublishRecord,
): string {
	const target = boundPushTarget(armed);
	return target
		? `git push ${target.remote} ${armed.localHead}:refs/heads/${target.branch}`
		: '(invalid bound remote-tracking ref; restart the workflow)';
}

/** Permit one non-force, single-ref push of only the content-bound commit. */
function isSafeExactBoundPush(
	command: string,
	armed: PrFeedbackReadyToPublishRecord,
): boolean {
	if (hasUnsafeShellControlSyntax(command)) return false;
	const target = boundPushTarget(armed);
	if (!target) return false;
	const match = command
		.trim()
		.match(/^git\s+push\s+([^\s;&|<>`]+)\s+([^\s;&|<>`]+)\s*$/i);
	if (!match) return false;
	return (
		match[1] === target.remote &&
		match[2] === `${armed.localHead}:refs/heads/${target.branch}`
	);
}

function isAllowedPrWorkflowGitIntake(
	gitArgs: string,
	options: {
		allowCheckout: boolean;
		allowFetch: boolean;
		allowTrackingFetch: boolean;
		trackingFetchTarget?: {
			remoteName: string;
			remoteBranchRef: string;
		} | null;
	},
): boolean {
	if (
		/(?:--ext-diff|--textconv|--open-files-in-pager|--output(?:=|\s)|--upload-pack(?:=|\s)|--exec(?:=|\s))/i.test(
			gitArgs,
		)
	)
		return false;

	if (
		/^(?:status|log|show|diff|rev-parse|merge-base|ls-files|grep|blame|cat-file|for-each-ref|--version|version)(?:\s|$)/i.test(
			gitArgs,
		)
	)
		return true;

	// `git branch` with listing/read flags only is a pure read. Mutation and
	// creation forms are rejected by the dedicated helper, which falls through
	// (returns false) so the `--set-upstream-to=` pre-bind carve-out below can
	// still admit its own narrow shape.
	if (isAllowedReadOnlyGitBranchListing(gitArgs)) return true;

	// `git stash list` is a pure read (issue S1.6): the recovery instruction in
	// prepare-pr-workflow-checkout.ts hands the model `git stash apply --index
	// <oid>` but gives it no allowed way to enumerate or confirm that OID first.
	// Every mutating stash subcommand (push/pop/apply/drop/clear/save/create/
	// store/branch) and the bare `git stash` (which implicitly pushes) fall
	// through to reject.
	if (isAllowedReadOnlyGitStashListing(gitArgs)) return true;

	// `git worktree list` is a pure read. add/remove/move/prune/lock/unlock/
	// repair all fall through to reject.
	if (isAllowedReadOnlyGitWorktreeListing(gitArgs)) return true;

	if (options.allowFetch && /^fetch(?:\s|$)/i.test(gitArgs)) return true;
	if (
		options.allowTrackingFetch &&
		isAllowedBoundRemoteTrackingFetch(gitArgs, options.trackingFetchTarget)
	)
		return true;

	if (/^remote(?:\s+-v)?$/i.test(gitArgs)) return true;

	// Checkout/switch are limited to one existing ref (optionally detached).
	// Branch creation and path restoration therefore cannot pass this allowlist.
	if (options.allowCheckout && isAllowedPreBindBranchSetup(gitArgs))
		return true;

	if (
		options.allowCheckout &&
		/^(?:checkout|switch)\s+(?:--detach\s+)?[^\s-][^\s]*$/i.test(gitArgs)
	)
		return true;

	// Config intake must select a read operation. Scope/origin flags alone never
	// authorize a key/value write.
	return /^config\s+(?:(?:--show-origin|--show-scope|--global|--local|--system|--worktree)\s+)*(?:--list|--get(?:-all)?\s+\S+)$/i.test(
		gitArgs,
	);
}

function isAllowedBoundRemoteTrackingFetch(
	gitArgs: string,
	target: { remoteName: string; remoteBranchRef: string } | null | undefined,
): boolean {
	if (!target?.remoteName || !target.remoteBranchRef.startsWith('refs/heads/'))
		return false;
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length !== 3 || tokens[0].toLowerCase() !== 'fetch') return false;
	const [, remote, remoteBranch] = tokens;
	const expectedBranch = target.remoteBranchRef.slice('refs/heads/'.length);
	return (
		isSafeGitRefToken(remote) &&
		!remote.includes('/') &&
		isSafeGitRefToken(remoteBranch) &&
		!remoteBranch.startsWith('-') &&
		!remoteBranch.includes(':') &&
		remote === target.remoteName &&
		remoteBranch === expectedBranch
	);
}

function isAllowedPreBindBranchSetup(gitArgs: string): boolean {
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length === 5) {
		const [verb, createFlag, localBranch, trackFlag, upstream] = tokens;
		return (
			(verb === 'checkout' || verb === 'switch') &&
			(createFlag === '-b' || createFlag === '-c') &&
			trackFlag === '--track' &&
			isSafeGitRefToken(localBranch) &&
			isSafeGitRefToken(upstream) &&
			upstream.includes('/')
		);
	}
	if (tokens.length === 3 && tokens[0] === 'branch') {
		const upstream = tokens[1].match(/^--set-upstream-to=(.+)$/)?.[1];
		return Boolean(
			upstream &&
				isSafeGitRefToken(upstream) &&
				upstream.includes('/') &&
				isSafeGitRefToken(tokens[2]),
		);
	}
	return false;
}

/**
 * Admit `git branch` ONLY in read-only listing forms. Fail-closed: every token
 * after `branch` must be a recognized listing/read flag, a `=`-bearing read flag
 * (`--sort=`, `--format=`, `--color=`), or — only while a listing selector
 * (`--list`/`--contains`/`--merged`/`--no-merged`/`--points-at`) is in effect —
 * the selector's positional argument. Any mutation/creation flag (`-d`/`-D`,
 * `-m`/`-M`, `-c`/`-C`, `-f`/`--force`, `-u`/`--set-upstream-to=`,
 * `--unset-upstream`, `-t`/`--track`, `--edit-description`), any unrecognized
 * `-` flag, and any bare positional with no selector in effect (a plain token =
 * branch creation) fall through to a reject.
 */
function isAllowedReadOnlyGitBranchListing(gitArgs: string): boolean {
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length === 0 || tokens[0].toLowerCase() !== 'branch') return false;
	let listingSelectorInEffect = false;
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (
			/^(?:--list|--contains|--merged|--no-merged|--points-at)$/i.test(token)
		) {
			listingSelectorInEffect = true;
			continue;
		}
		if (
			/^(?:-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--color|--no-color|--column|--no-column|-i|--ignore-case)$/i.test(
				token,
			) ||
			/^--(?:sort|format|color)=/i.test(token)
		) {
			continue;
		}
		// Unrecognized flags (which includes every mutation/creation form) fail
		// closed. A bare positional is only ever the selector's argument.
		if (token.startsWith('-')) return false;
		if (!listingSelectorInEffect) return false;
	}
	return true;
}

/**
 * Admit `git stash list` ONLY. Fail-closed: the bare verb `stash` (which
 * implicitly runs `stash push`) is rejected, every mutating subcommand
 * (`push`, `pop`, `apply`, `drop`, `clear`, `save`, `create`, `store`,
 * `branch`) is rejected, and any token after `list` must be a recognized
 * read-only log/format flag — an unrecognized flag or any positional
 * (e.g. a stash ref for `apply`/`show`) falls through to a reject.
 */
function isAllowedReadOnlyGitStashListing(gitArgs: string): boolean {
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length < 2 || tokens[0].toLowerCase() !== 'stash') return false;
	if (tokens[1].toLowerCase() !== 'list') return false;
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (/^(?:-v|--oneline|--patch|-p|--stat|--color|--no-color)$/i.test(token))
			continue;
		if (/^--(?:format|pretty)=/i.test(token)) continue;
		return false;
	}
	return true;
}

/**
 * Admit `git worktree list` ONLY. Fail-closed: the bare verb `worktree` and
 * every mutating subcommand (`add`, `remove`, `move`, `prune`, `lock`,
 * `unlock`, `repair`) are rejected, and any token after `list` must be a
 * recognized read-only listing flag.
 */
function isAllowedReadOnlyGitWorktreeListing(gitArgs: string): boolean {
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length < 2 || tokens[0].toLowerCase() !== 'worktree') return false;
	if (tokens[1].toLowerCase() !== 'list') return false;
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (/^(?:-v|--verbose|--porcelain|-z)$/i.test(token)) continue;
		return false;
	}
	return true;
}

function isSafeGitRefToken(value: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
		!value.includes('..') &&
		!value.includes('//') &&
		!value.includes('@{') &&
		!value.endsWith('/') &&
		!value.endsWith('.') &&
		!value.endsWith('.lock')
	);
}

function isAllowedPrFeedbackGhIntake(command: string): boolean {
	if (/^gh\s+pr\s+checkout(?:\s|$)/i.test(command)) {
		return isAllowedSafeGhPrCheckout(command);
	}
	if (
		/^gh\s+--version$/i.test(command) ||
		/^gh\s+pr\s+(?:view|diff|checks|status|list)(?:\s|$)/i.test(command) ||
		/^gh\s+run\s+(?:view|list|watch)(?:\s|$)/i.test(command) ||
		/^gh\s+issue\s+(?:view|list)(?:\s|$)/i.test(command) ||
		/^gh\s+search\s+(?:code|commits|issues|prs|repos)(?:\s|$)/i.test(command) ||
		/^gh\s+auth\s+status(?:\s|$)/i.test(command)
	)
		return true;

	if (!/^gh\s+api(?:\s|$)/i.test(command)) return false;
	if (/\bmutation\b/i.test(command)) return false;
	const method = command.match(
		/\s(?:--method(?:\s+|=)|-X(?:\s+|=)?)([A-Z]+)/i,
	)?.[1];
	if (method && method.toUpperCase() !== 'GET') return false;
	if (
		/\s(?:--input|--raw-field)(?:\s|=)/i.test(command) ||
		/\s-F(?:\s|=|\S)/.test(command)
	)
		return false;

	// REST defaults to GET. GraphQL queries may use `-f query=...`; the explicit
	// mutation rejection above keeps that review-thread intake read-only.
	return !/\s(?:--field|-f)(?:\s|=)(?!query=)/i.test(command);
}

function isAllowedSafeGhPrCheckout(command: string): boolean {
	if (/\s--(?:force|recurse-submodules)(?:\s|=|$)/i.test(command)) return false;
	const tokens = command.trim().split(/\s+/);
	if (
		tokens.length < 4 ||
		tokens[0] !== 'gh' ||
		tokens[1] !== 'pr' ||
		tokens[2] !== 'checkout'
	)
		return false;
	const target = tokens[3];
	if (
		!/^\d+$/.test(target) &&
		!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(
			target,
		)
	)
		return false;
	for (let index = 4; index < tokens.length; index += 1) {
		const token = tokens[index];
		const repoEquals = token.match(/^--repo=(.+)$/)?.[1];
		if (repoEquals) {
			if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoEquals)) return false;
			continue;
		}
		const branchEquals = token.match(/^--branch=(.+)$/)?.[1];
		if (branchEquals) {
			if (!isSafeGitRefToken(branchEquals)) return false;
			continue;
		}
		if (token === '--repo' || token === '-R') {
			const repo = tokens[++index];
			if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
				return false;
			continue;
		}
		if (token === '--branch' || token === '-b') {
			const branch = tokens[++index];
			if (!branch || !isSafeGitRefToken(branch)) return false;
			continue;
		}
		return false;
	}
	return true;
}

function normalizePrHeadSha(prHeadSha: string): string {
	const normalized = prHeadSha.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow requires a non-empty pr_head_sha');
	}
	return normalized;
}

async function currentPrFeedbackRevisionDigest(
	directory: string,
	state: PrWorkflowGateState,
): Promise<string> {
	if (!state.prHeadSha) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK revision binding requires pr_head_sha',
		);
	}
	const digest = await resolvePrWorkflowRevisionDigestForGate(
		directory,
		state.prHeadSha,
	);
	if (!digest) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK could not compute a bounded current-revision digest',
		);
	}
	return digest;
}

/**
 * Production gate calls use the non-blocking, chunked digest implementation.
 * Keep the synchronous seam for existing focused tests and explicit test
 * injection; it is never selected while the production implementation is in
 * place.
 */
async function resolvePrWorkflowRevisionDigestForGate(
	directory: string,
	baseHeadSha: string,
): Promise<string | null> {
	if (
		_test_exports.resolvePrWorkflowRevisionDigest !==
		resolvePrWorkflowRevisionDigest
	) {
		return _test_exports.resolvePrWorkflowRevisionDigest(
			directory,
			baseHeadSha,
		);
	}
	return resolvePrWorkflowRevisionDigestAsync(directory, baseHeadSha);
}

function normalizeBatchId(batchId: string): string {
	const normalized = batchId.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow requires a non-empty batch id');
	}
	return normalized;
}

function sameStringArray(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function assertExactStringSet(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): void {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	const missing = [...expectedSet].filter((value) => !actualSet.has(value));
	const extra = [...actualSet].filter((value) => !expectedSet.has(value));
	if (
		actual.length !== actualSet.size ||
		actualSet.size !== expectedSet.size ||
		missing.length > 0 ||
		extra.length > 0
	) {
		throw new Error(
			`BLOCKED: ${label} must exactly cover the mechanically derived inventory; missing: ${missing.join(', ') || '(none)'}; extra: ${extra.join(', ') || '(none)'}`,
		);
	}
}

function derivePrReviewCandidateInventory(
	directory: string,
	state: PrWorkflowGateState,
): string[] {
	const sources: Array<{
		batchId: string;
		laneId: string;
		mode: string;
		workflowLane?: string;
		/**
		 * Base-dimension sources only: the exact dimensions this lane is the
		 * authoritative (most-recent) source for. When this is a strict subset
		 * of the lane's actual ownedWorkflowLanes (a more recent batch claimed
		 * the rest), extraction below scopes to only these dimensions so the
		 * lane's stale content for an already-superseded dimension never
		 * re-enters the candidate pool alongside whoever superseded it.
		 */
		creditedLanes?: string[];
	}> = [];
	// Assign each of the 6 canonical dimensions to exactly one authoritative
	// (batchId, laneId) source: the most-recent successful lane that owns it
	// (batches are scanned reverse-chronologically, so first-write-wins here
	// means most-recent-wins). This is deliberately dimension-first, not
	// lane-first: a lane-first admission (accept a whole lane once ANY of its
	// owned dimensions is still unclaimed) can re-admit an older,
	// already-partially-superseded consolidated lane purely because it also
	// owns a second, still-unclaimed dimension — reintroducing that lane's
	// stale content for the dimension a newer batch already settled. Scanning
	// per-dimension instead means an older lane is only ever referenced for
	// dimensions no newer batch has claimed, so each contributing lane is
	// still extracted at most once (via the existing extractedLaneKeys dedup
	// below) but never credited for a dimension someone more recent covers.
	const baseDimensionSources = new Map<
		string,
		{ batchId: string; laneId: string }
	>();
	const baseSourceCreditedDimensions = new Map<string, string[]>();
	const baseSourceFullOwnershipCount = new Map<string, number>();
	for (const batch of [...(state.prReviewBaseDispatches ?? [])].reverse()) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:base',
			batch.validatedAt,
		);
		for (const lane of batch.lanes) {
			const ownedDimensions = lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane];
			if (!ownedDimensions.every((dimension) => successful.has(dimension)))
				continue;
			const key = `${batch.batchId}\0${lane.laneId}`;
			baseSourceFullOwnershipCount.set(key, ownedDimensions.length);
			for (const dimension of ownedDimensions) {
				if (!baseDimensionSources.has(dimension)) {
					baseDimensionSources.set(dimension, {
						batchId: batch.batchId,
						laneId: lane.laneId,
					});
					const credited = baseSourceCreditedDimensions.get(key);
					if (credited) {
						credited.push(dimension);
					} else {
						baseSourceCreditedDimensions.set(key, [dimension]);
					}
				}
			}
		}
	}
	const seenBaseSourceKeys = new Set<string>();
	for (const { batchId, laneId } of baseDimensionSources.values()) {
		const key = `${batchId}\0${laneId}`;
		if (seenBaseSourceKeys.has(key)) continue;
		seenBaseSourceKeys.add(key);
		const credited = baseSourceCreditedDimensions.get(key);
		const fullOwnershipCount = baseSourceFullOwnershipCount.get(key) ?? 0;
		sources.push({
			batchId,
			laneId,
			mode: 'swarm-pr-review:base',
			// Scope extraction ONLY when this lane is credited for a strict
			// subset of its full ownership (a more recent batch claimed the
			// rest). A lane credited for its full ownership — every tier-L
			// singleton lane, and any consolidated lane whose complete owned
			// set remains uncontested — gets no filter at all, exactly
			// matching pre-existing behavior: extract every well-formed
			// [CANDIDATE] row regardless of its lane label, so a subagent's
			// inconsistent lane-field labeling never silently drops a real
			// candidate from the mandatory coverage set.
			creditedLanes:
				credited && credited.length < fullOwnershipCount ? credited : undefined,
		});
	}
	const selectedCouncilLanes = new Set<string>();
	for (const batch of [...(state.prReviewValidationBatches ?? [])].reverse()) {
		if (batch.phase !== 'council') continue;
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:council',
			batch.validatedAt,
		);
		for (const lane of batch.lanes) {
			if (
				successful.has(lane.workflowLane) &&
				!selectedCouncilLanes.has(lane.workflowLane)
			) {
				sources.push({
					batchId: batch.batchId,
					laneId: lane.laneId,
					mode: 'swarm-pr-review:council',
				});
				selectedCouncilLanes.add(lane.workflowLane);
			}
		}
	}
	if (state.prReviewTriggerEvalPath) {
		const triggerPath = validateSwarmPath(
			directory,
			state.prReviewTriggerEvalPath,
		);
		let triggerArtifact: unknown;
		try {
			triggerArtifact = JSON.parse(readFileSync(triggerPath, 'utf-8'));
		} catch {
			throw new Error(
				'BLOCKED: PR_REVIEW trigger evaluation artifact is missing or invalid',
			);
		}
		const rows = (triggerArtifact as { rows?: unknown }).rows;
		if (!Array.isArray(rows)) {
			throw new Error('BLOCKED: PR_REVIEW trigger evaluation rows are invalid');
		}
		const rowIds = rows.map((row) =>
			typeof row === 'object' && row !== null
				? (row as { trigger_id?: unknown }).trigger_id
				: undefined,
		);
		const provenanceTuples = rows.map((row) => {
			if (typeof row !== 'object' || row === null) return '';
			const batchId = (row as { source_batch_id?: unknown }).source_batch_id;
			const laneId = (row as { source_lane_id?: unknown }).source_lane_id;
			return typeof batchId === 'string' &&
				typeof laneId === 'string' &&
				batchId.trim() &&
				laneId.trim()
				? `${batchId}\0${laneId}`
				: '';
		});
		const exactMandatorySet =
			rows.length === PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length &&
			new Set(rowIds).size === PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length &&
			provenanceTuples.every(Boolean) &&
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.every((id) => rowIds.includes(id)) &&
			rows.every(
				(row) =>
					typeof row === 'object' &&
					row !== null &&
					(row as { result?: unknown }).result === 'MATCHED',
			);
		if (!exactMandatorySet) {
			throw new Error(
				'BLOCKED: PR_REVIEW requires the exact all-MATCHED repository-agnostic micro-lane set with complete source provenance',
			);
		}
		// A provenance tuple may back several rows only when the dispatched lane
		// declared that consolidated ownership set; the per-row validation below
		// enforces ownership containment and all-owned artifact attestation.
		for (const row of rows) {
			if (
				typeof row === 'object' &&
				row !== null &&
				(row as { result?: unknown }).result === 'MATCHED' &&
				typeof (row as { source_batch_id?: unknown }).source_batch_id ===
					'string' &&
				typeof (row as { source_lane_id?: unknown }).source_lane_id === 'string'
			) {
				sources.push({
					batchId: (row as { source_batch_id: string }).source_batch_id,
					laneId: (row as { source_lane_id: string }).source_lane_id,
					mode: 'swarm-pr-review:micro',
					workflowLane: (row as { trigger_id: string }).trigger_id,
				});
			}
		}
	}
	const candidateIds: string[] = [];
	// A consolidated lane can be the provenance source for several sources
	// (one base lane owning several dimensions collapses to one source
	// already, but micro trigger rows are per-family: several rows may cite
	// the same consolidated (batchId, laneId)). Extract that lane's full
	// artifact text exactly once regardless of how many families cite it, so
	// shared candidate ids are not duplicated into the inventory.
	const extractedLaneKeys = new Set<string>();
	for (const source of sources) {
		let resolvedArtifact = false;
		for (const record of findByBatchId(directory, source.batchId, {
			parentSessionId: state.sessionID,
		})) {
			if (
				record.laneId !== source.laneId ||
				record.mode !== source.mode ||
				record.status !== 'completed' ||
				record.workspace?.prHeadSha !== state.prHeadSha ||
				record.workspace?.gitHead !== state.prHeadSha ||
				record.result?.outputDegraded === true ||
				record.result?.transcriptIncomplete === true ||
				record.result?.truncated === true
			)
				continue;
			const ref = record.result?.outputRef?.trim();
			const artifact = ref
				? readLaneOutput(directory, ref)?.artifact
				: undefined;
			const recordOwnedLanes = record.ownedWorkflowLanes?.length
				? record.ownedWorkflowLanes
				: record.workflowLane
					? [record.workflowLane]
					: undefined;
			if (
				!artifact ||
				!workflowArtifactHasContractMarker(
					directory,
					state,
					record,
					source.mode,
					record.workflowLane ?? source.workflowLane ?? source.laneId,
					undefined,
					undefined,
					recordOwnedLanes,
				)
			)
				continue;
			if (
				source.workflowLane &&
				(!recordOwnedLanes?.includes(source.workflowLane) ||
					!prReviewDiscoveryArtifactCoversLane(
						artifact.text,
						source.workflowLane,
					))
			)
				continue;
			resolvedArtifact = true;
			const laneKey = `${source.batchId}\0${source.laneId}`;
			if (!extractedLaneKeys.has(laneKey)) {
				extractedLaneKeys.add(laneKey);
				candidateIds.push(
					...extractCandidateIds(artifact.text, source.creditedLanes),
				);
			}
		}
		if (source.mode === 'swarm-pr-review:micro' && !resolvedArtifact) {
			throw new Error(
				`BLOCKED: PR_REVIEW mandatory micro-lane provenance is missing or invalid for ${source.workflowLane ?? source.laneId}`,
			);
		}
	}
	assertNoDuplicates(candidateIds, 'PR_REVIEW discovery candidate ids');
	return candidateIds.length > 0 ? candidateIds.sort() : ['CLEAN-REVIEW'];
}

/**
 * Extract candidate ids from a discovery artifact's [CANDIDATE] rows. When
 * `scopeToLanes` is given (base-dimension sources credited for only a subset
 * of their owned dimensions), rows whose `lane` field is outside that set are
 * skipped — the artifact may legitimately discuss a dimension this source is
 * no longer the authoritative source for (a more recent batch superseded it),
 * and that stale content must not re-enter the candidate pool.
 */
function extractCandidateIds(
	text: string,
	scopeToLanes?: readonly string[],
): string[] {
	const candidateIds: string[] = [];
	let markerHeaderSeen = false;
	const inScope = (lane: string | undefined) =>
		!scopeToLanes || (lane !== undefined && scopeToLanes.includes(lane));
	for (const line of text.split(/\r?\n/)) {
		const fields = pipeFields(line);
		if (
			fields[0] === '[CANDIDATE]' &&
			fields[1]?.toLowerCase() === 'candidate_id'
		) {
			markerHeaderSeen = true;
			continue;
		}
		if (
			fields[0] === '[CANDIDATE]' &&
			fields.length >= 10 &&
			fields.slice(1, 10).every(Boolean)
		) {
			if (inScope(fields[2])) candidateIds.push(fields[1]);
			continue;
		}
		if (
			markerHeaderSeen &&
			fields.length >= 9 &&
			fields[0] &&
			!fields[0].startsWith('[') &&
			fields.slice(0, 9).every(Boolean)
		) {
			if (inScope(fields[1])) candidateIds.push(fields[0]);
		}
	}
	return candidateIds;
}

function derivePrReviewCriticInventory(
	directory: string,
	state: PrWorkflowGateState,
): string[] {
	const verdicts = deriveLatestPrReviewReviewerVerdicts(directory, state);
	return [...verdicts.entries()]
		.filter(
			([, verdict]) =>
				verdict.classification === 'CONFIRMED' &&
				['CRITICAL', 'HIGH', 'MEDIUM'].includes(verdict.severity),
		)
		.map(([itemId]) => itemId)
		.sort();
}

function deriveLatestPrReviewCriticVerdicts(
	directory: string,
	state: PrWorkflowGateState,
): Map<string, { status: string; severity: string }> {
	const reviewerVerdicts = deriveLatestPrReviewReviewerVerdicts(
		directory,
		state,
	);
	const criticBatches = (state.prReviewValidationBatches ?? []).filter(
		(batch) => batch.phase === 'critic',
	);
	for (const batch of [...criticBatches].reverse()) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:critic',
			batch.validatedAt,
		);
		if (
			batch.lanes.some((lane) => !successful.has(lane.workflowLane)) ||
			successful.size !== batch.lanes.length
		) {
			continue;
		}
		const required = batch.lanes.flatMap((lane) => lane.reviewItemIds ?? []);
		const verdicts = new Map<string, { status: string; severity: string }>();
		for (const lane of batch.lanes) {
			const record = findByBatchId(directory, batch.batchId, {
				parentSessionId: state.sessionID,
			}).find((candidate) => candidate.laneId === lane.laneId);
			const ref = record?.result?.outputRef?.trim();
			const artifact = ref
				? readLaneOutput(directory, ref)?.artifact
				: undefined;
			if (!artifact) continue;
			for (const itemId of lane.reviewItemIds ?? []) {
				const verdict = parseCriticVerdict(
					artifact.text,
					itemId,
					reviewerVerdicts.get(itemId)?.severity,
				);
				if (verdict) verdicts.set(itemId, verdict);
			}
		}
		if (required.every((itemId) => verdicts.has(itemId))) return verdicts;
	}
	return new Map();
}

function deriveLatestPrReviewReviewerVerdicts(
	directory: string,
	state: PrWorkflowGateState,
): Map<string, ReviewerVerdict> {
	const reviewerBatches = (state.prReviewValidationBatches ?? []).filter(
		(batch) => batch.phase === 'reviewer',
	);
	for (const batch of [...reviewerBatches].reverse()) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:reviewer',
			batch.validatedAt,
		);
		if (
			batch.lanes.some((lane) => !successful.has(lane.workflowLane)) ||
			successful.size !== batch.lanes.length
		) {
			continue;
		}
		const required = batch.lanes.flatMap((lane) => lane.reviewItemIds ?? []);
		const verdicts = new Map<string, ReviewerVerdict>();
		for (const lane of batch.lanes) {
			const record = findByBatchId(directory, batch.batchId, {
				parentSessionId: state.sessionID,
			}).find((candidate) => candidate.laneId === lane.laneId);
			const ref = record?.result?.outputRef?.trim();
			const artifact = ref
				? readLaneOutput(directory, ref)?.artifact
				: undefined;
			if (!artifact) continue;
			for (const itemId of lane.reviewItemIds ?? []) {
				const verdict = parseReviewerVerdict(artifact.text, itemId);
				if (verdict) verdicts.set(itemId, verdict);
			}
		}
		if (required.every((itemId) => verdicts.has(itemId))) {
			return verdicts;
		}
	}
	return new Map();
}

function successfulObligationsFromExactBatch(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	expectedLanes: ReadonlyArray<{
		laneId: string;
		workflowLane: string;
		reviewItemIds?: string[];
		ownedWorkflowLanes?: string[];
	}>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane = true,
	forbiddenSubagentSessionIds: ReadonlySet<string> = new Set(),
	expectedRevisionDigest?: string,
): Set<string> {
	const records = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	});
	const successful = new Set<string>();
	const validatedAtMs = Date.parse(validatedAt);
	if (!Number.isFinite(validatedAtMs)) return successful;
	const expectedByLaneId = new Map(
		expectedLanes.map((lane) => [lane.laneId, lane]),
	);
	if (expectedByLaneId.size !== expectedLanes.length) return successful;
	const recordCountByLaneId = new Map<string, number>();
	const recordCountBySubagentSessionId = new Map<string, number>();
	for (const record of records) {
		if (!record.laneId || !expectedByLaneId.has(record.laneId)) continue;
		recordCountByLaneId.set(
			record.laneId,
			(recordCountByLaneId.get(record.laneId) ?? 0) + 1,
		);
		const subagentSessionId = record.subagentSessionId?.trim();
		if (subagentSessionId) {
			recordCountBySubagentSessionId.set(
				subagentSessionId,
				(recordCountBySubagentSessionId.get(subagentSessionId) ?? 0) + 1,
			);
		}
	}
	for (const record of records) {
		const expectedLane = record.laneId
			? expectedByLaneId.get(record.laneId)
			: undefined;
		const expectedWorkflowLane = expectedLane?.workflowLane;
		const expectedOwnedLanes = expectedLane?.ownedWorkflowLanes?.length
			? expectedLane.ownedWorkflowLanes
			: expectedWorkflowLane !== undefined
				? [expectedWorkflowLane]
				: undefined;
		const subagentSessionId = record.subagentSessionId?.trim();
		if (
			expectedWorkflowLane !== undefined &&
			expectedOwnedLanes !== undefined &&
			record.laneId !== undefined &&
			recordCountByLaneId.get(record.laneId) === 1 &&
			Boolean(subagentSessionId) &&
			recordCountBySubagentSessionId.get(subagentSessionId!) === 1 &&
			!forbiddenSubagentSessionIds.has(subagentSessionId!) &&
			record.createdAt >= validatedAtMs &&
			(!checkWorkflowLane || record.workflowLane === expectedWorkflowLane) &&
			(!checkWorkflowLane ||
				ownedLaneSetsEqual(record.ownedWorkflowLanes, expectedOwnedLanes)) &&
			record.mode === expectedMode &&
			record.workspace?.prHeadSha === state.prHeadSha &&
			record.workspace?.gitHead === state.prHeadSha &&
			record.status === 'completed' &&
			record.result?.outputDegraded !== true &&
			record.result?.transcriptIncomplete !== true &&
			record.result?.truncated !== true &&
			(record.result?.chars ?? 0) > 0 &&
			Boolean(record.result?.digest?.trim()) &&
			Boolean(record.result?.outputRef?.trim()) &&
			workflowArtifactHasContractMarker(
				directory,
				state,
				record,
				expectedMode,
				expectedWorkflowLane,
				expectedLane?.reviewItemIds,
				expectedRevisionDigest,
				expectedOwnedLanes,
			)
		) {
			for (const obligation of expectedOwnedLanes) {
				successful.add(obligation);
			}
		}
	}
	return successful;
}

/**
 * A dispatch record's persisted owned set must equal the batch's expected
 * owned set. Absent record ownership means the singleton [workflowLane], so
 * legacy singleton records stay valid while consolidated claims must have
 * been declared at dispatch time — an expectation cannot widen after launch.
 */
function ownedLaneSetsEqual(
	recordOwned: readonly string[] | undefined,
	expectedOwned: readonly string[],
): boolean {
	if (!recordOwned || recordOwned.length === 0) {
		return expectedOwned.length === 1;
	}
	const recordSet = new Set(recordOwned);
	const expectedSet = new Set(expectedOwned);
	// Strict set equality: reject a record whose owned list contains
	// duplicates or does not have exactly the same distinct members as the
	// expected set (defense in depth — declaration-time validation already
	// rejects duplicate/mismatched ownership before a record can be written).
	if (
		recordSet.size !== recordOwned.length ||
		recordSet.size !== expectedSet.size
	) {
		return false;
	}
	return recordOwned.every((owned) => expectedSet.has(owned));
}

function workflowArtifactHasContractMarker(
	directory: string,
	state: PrWorkflowGateState,
	record: ReturnType<typeof findByBatchId>[number],
	expectedMode: string,
	expectedWorkflowLane: string,
	reviewItemIds?: readonly string[],
	expectedRevisionDigest?: string,
	ownedWorkflowLanes?: readonly string[],
): boolean {
	const ref = record.result?.outputRef?.trim();
	if (!ref) return false;
	const loaded = readLaneOutput(directory, ref);
	if (!loaded) return false;
	const artifact = loaded.artifact;
	const recordPrHeadSha = record.workspace?.prHeadSha;
	const recordGitHead = record.workspace?.gitHead;
	const resolvedRevisionDigest =
		expectedRevisionDigest ??
		(recordPrHeadSha
			? _test_exports.resolvePrWorkflowRevisionDigest(
					directory,
					recordPrHeadSha,
				)
			: null);
	const expectedReviewScope =
		state.mode === 'PR_REVIEW' && state.prReviewBaseSha && state.prHeadSha
			? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
			: undefined;
	if (
		artifact.batchId !== record.batchId ||
		artifact.laneId !== record.laneId ||
		artifact.mode !== expectedMode ||
		artifact.sessionId !== record.subagentSessionId ||
		artifact.parentSessionId !== record.parentSessionId ||
		artifact.agent !== record.swarmPrefixedAgent ||
		artifact.role !== record.normalizedAgent ||
		artifact.source !== 'collect_lane_results' ||
		artifact.workflowLane !== record.workflowLane ||
		artifact.workflowLane !== expectedWorkflowLane ||
		!recordPrHeadSha ||
		artifact.prHeadSha !== recordPrHeadSha ||
		!recordGitHead ||
		artifact.gitHead !== recordGitHead ||
		!resolvedRevisionDigest ||
		artifact.revisionDigest !== resolvedRevisionDigest ||
		(expectedReviewScope !== undefined &&
			(record.workspace?.scope !== expectedReviewScope ||
				artifact.scope !== expectedReviewScope)) ||
		artifact.digest !== record.result?.digest ||
		artifact.chars !== record.result?.chars
	) {
		return false;
	}
	if (expectedMode === 'swarm-pr-review:reviewer') {
		return Boolean(
			reviewItemIds?.length &&
				reviewItemIds.every((itemId) =>
					Boolean(parseReviewerVerdict(artifact.text, itemId)),
				),
		);
	}
	if (expectedMode === 'swarm-pr-review:critic') {
		const reviewerVerdicts = deriveLatestPrReviewReviewerVerdicts(
			directory,
			state,
		);
		return Boolean(
			reviewItemIds?.length &&
				reviewItemIds.every((itemId) =>
					Boolean(
						parseCriticVerdict(
							artifact.text,
							itemId,
							reviewerVerdicts.get(itemId)?.severity,
						),
					),
				),
		);
	}
	if (expectedMode === 'swarm-pr-feedback:verification') {
		return /^\[FEEDBACK-VERIFIED\]\s*\|/m.test(artifact.text);
	}
	const feedbackVerdict = {
		'swarm-pr-feedback:stage-b-reviewer': ['[STAGE-B-REVIEW]', 'APPROVE'],
		'swarm-pr-feedback:stage-b-test': ['[STAGE-B-TEST]', 'PASS'],
		'swarm-pr-feedback:closeout-reviewer': ['[CLOSEOUT-REVIEW]', 'APPROVE'],
		'swarm-pr-feedback:closeout-critic': ['[CLOSEOUT-CRITIC]', 'APPROVE'],
	}[expectedMode];
	if (feedbackVerdict) {
		return Boolean(
			reviewItemIds?.length &&
				reviewItemIds.every((itemId) =>
					artifactHasExactPositiveVerdictRow(
						artifact.text,
						feedbackVerdict[0],
						itemId,
						feedbackVerdict[1],
					),
				),
		);
	}
	const coveredLanes = ownedWorkflowLanes?.length
		? ownedWorkflowLanes
		: [expectedWorkflowLane];
	if (
		!coveredLanes.every((coveredLane) =>
			prReviewDiscoveryArtifactCoversLane(artifact.text, coveredLane),
		)
	) {
		return false;
	}
	if (coveredLanes.length > 1) {
		// A single consolidated lane's coverage check above only verifies each
		// owned family's row is long enough and correctly labeled; it has no
		// way to tell a genuine per-family assessment from a copy-pasted
		// template relabeled across families (a real, reproduced gap — the
		// underlying length/label check requires no adversarial intent to
		// defeat, only an honest-but-lazy subagent templating the remaining
		// families instead of assessing each one). Requiring the matched
		// evidence text to differ across owned families directly closes that
		// path without any semantic understanding of the content.
		const seenEvidence = new Map<string, string>();
		for (const coveredLane of coveredLanes) {
			const evidence = extractLaneCoverageEvidenceText(
				artifact.text,
				coveredLane,
			);
			if (evidence === null) continue;
			const priorLane = seenEvidence.get(evidence);
			if (priorLane) return false;
			seenEvidence.set(evidence, coveredLane);
		}
	}
	return true;
}

/** Require at least one real discovery row or a lane-bound CLEAN attestation. */
export function prReviewDiscoveryArtifactCoversLane(
	text: string,
	expectedWorkflowLane: string,
): boolean {
	const lines = text.split(/\r?\n/);
	let candidateHeaderSeen = false;
	for (const line of lines) {
		const fields = pipeFields(line);
		if (fields.length === 0) continue;
		if (
			fields[0] === '[CLEAN]' &&
			fields.length >= 4 &&
			fields[1] === expectedWorkflowLane &&
			fields.slice(1, 4).every(Boolean) &&
			fields[2].length >= 12 &&
			fields[3].length >= 20
		)
			return true;
		if (fields[0] === '[CANDIDATE]') {
			if (fields[1]?.toLowerCase() === 'candidate_id') {
				candidateHeaderSeen = true;
				continue;
			}
			if (
				fields.length >= 10 &&
				fields[2] === expectedWorkflowLane &&
				fields.slice(1, 10).every(Boolean)
			)
				return true;
			continue;
		}
		if (
			candidateHeaderSeen &&
			fields.length >= 9 &&
			fields[0]?.toLowerCase() !== 'candidate_id' &&
			fields[1] === expectedWorkflowLane &&
			fields.slice(0, 9).every(Boolean)
		)
			return true;
	}
	return false;
}

/**
 * Extract the exact evidence text that satisfies coverage for one lane,
 * mirroring prReviewDiscoveryArtifactCoversLane's own matching rules but
 * returning the matched substantive fields instead of a boolean. Used only
 * for cross-family distinctness comparison on consolidated (multi-owned-lane)
 * artifacts; returns null when the lane has no matching row.
 */
function extractLaneCoverageEvidenceText(
	text: string,
	expectedWorkflowLane: string,
): string | null {
	const lines = text.split(/\r?\n/);
	let candidateHeaderSeen = false;
	for (const line of lines) {
		const fields = pipeFields(line);
		if (fields.length === 0) continue;
		if (
			fields[0] === '[CLEAN]' &&
			fields.length >= 4 &&
			fields[1] === expectedWorkflowLane &&
			fields.slice(1, 4).every(Boolean) &&
			fields[2].length >= 12 &&
			fields[3].length >= 20
		)
			return `${fields[2]}\0${fields[3]}`;
		if (fields[0] === '[CANDIDATE]') {
			if (fields[1]?.toLowerCase() === 'candidate_id') {
				candidateHeaderSeen = true;
				continue;
			}
			if (
				fields.length >= 10 &&
				fields[2] === expectedWorkflowLane &&
				fields.slice(1, 10).every(Boolean)
			)
				return fields.slice(3, 10).join('\0');
			continue;
		}
		if (
			candidateHeaderSeen &&
			fields.length >= 9 &&
			fields[0]?.toLowerCase() !== 'candidate_id' &&
			fields[1] === expectedWorkflowLane &&
			fields.slice(0, 9).every(Boolean)
		)
			return fields.slice(2, 9).join('\0');
	}
	return null;
}

const REVIEWER_CLASSIFICATIONS = new Set([
	'CONFIRMED',
	'DISPROVED',
	'UNVERIFIED',
	'PRE_EXISTING',
]);
const REVIEWER_EVIDENCE_TYPES = new Set([
	'STRUCTURALLY_PROVEN',
	'EXECUTION_PROVEN',
	'STATIC_TRACE_PROVEN',
	'PLAUSIBLE_BUT_UNVERIFIED',
]);
const REVIEW_SEVERITIES = new Set([
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
	'NONE',
]);
const CRITIC_STATUSES = new Set([
	'UPHELD',
	'DOWNGRADED',
	'DISPROVED',
	'NEEDS_MORE_EVIDENCE',
]);
const FEEDBACK_CLASSIFICATIONS = new Set([
	'CONFIRMED',
	'PARTIAL',
	'DISPROVED',
	'PRE_EXISTING',
	'NEEDS_MORE_EVIDENCE',
	'NEEDS_USER_DECISION',
]);

interface ReviewerVerdict {
	classification: string;
	severity: string;
}

function parseReviewerVerdict(
	text: string,
	itemId: string,
): ReviewerVerdict | null {
	const rows = text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === '[REVIEWED]' && fields[1] === itemId);
	if (rows.length !== 1) return null;
	const fields = rows[0];
	if (fields.length !== 10 || !fields.slice(1).every(Boolean)) return null;
	const introduced = fields[5]
		.replace(/^introduced_by_pr\s*:\s*/i, '')
		.toUpperCase();
	if (
		!REVIEWER_CLASSIFICATIONS.has(fields[2]) ||
		!REVIEWER_EVIDENCE_TYPES.has(fields[3]) ||
		!REVIEW_SEVERITIES.has(fields[4]) ||
		!['YES', 'NO', 'UNKNOWN'].includes(introduced)
	)
		return null;
	if (fields[7].length < 8 || fields[8].length < 5 || fields[9].length < 3)
		return null;
	return { classification: fields[2], severity: fields[4] };
}

function parseCriticVerdict(
	text: string,
	itemId: string,
	reviewerSeverity?: string,
): { status: string; severity: string } | null {
	const rows = text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === '[CRITIC]' && fields[1] === itemId);
	if (rows.length !== 1) return null;
	const fields = rows[0];
	if (
		fields.length !== 6 ||
		!fields.slice(1).every(Boolean) ||
		!CRITIC_STATUSES.has(fields[2]) ||
		!REVIEW_SEVERITIES.has(fields[3])
	)
		return null;
	if (fields[2] === 'NEEDS_MORE_EVIDENCE') return null;
	if (fields[2] === 'DISPROVED' && fields[3] !== 'NONE') return null;
	if (
		fields[2] === 'UPHELD' &&
		!['CRITICAL', 'HIGH', 'MEDIUM'].includes(fields[3])
	)
		return null;
	if (fields[2] === 'DOWNGRADED' && fields[3] === 'CRITICAL') return null;
	if (reviewerSeverity) {
		const severityRank = new Map([
			['NONE', 0],
			['INFO', 1],
			['LOW', 2],
			['MEDIUM', 3],
			['HIGH', 4],
			['CRITICAL', 5],
		]);
		const reviewerRank = severityRank.get(reviewerSeverity);
		const criticRank = severityRank.get(fields[3]);
		if (reviewerRank === undefined || criticRank === undefined) return null;
		if (fields[2] === 'UPHELD' && criticRank !== reviewerRank) return null;
		if (fields[2] === 'DOWNGRADED' && criticRank >= reviewerRank) return null;
	}
	if (fields[4].length < 6 || fields[5].length < 6) return null;
	return { status: fields[2], severity: fields[3] };
}

function artifactHasExactPositiveVerdictRow(
	text: string,
	marker: string,
	itemId: string,
	positiveVerdict: string,
): boolean {
	const rows = text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === marker && fields[1] === itemId);
	return (
		rows.length === 1 &&
		rows[0].length >= 4 &&
		rows[0][2] === positiveVerdict &&
		rows[0].slice(1, 4).every(Boolean)
	);
}

function pipeFields(line: string): string[] {
	if (!line.includes('|')) return [];
	return line.split('|').map((field) => field.trim());
}

function feedbackArtifactCoversItems(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	laneId: string,
	itemIds: readonly string[],
): boolean {
	const record = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	}).find((candidate) => candidate.laneId === laneId);
	const ref = record?.result?.outputRef?.trim();
	const loaded = ref ? readLaneOutput(directory, ref) : null;
	if (!loaded) return false;
	const rows = loaded.artifact.text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === '[FEEDBACK-VERIFIED]');
	if (rows.length !== itemIds.length) return false;
	return itemIds.every((itemId) => {
		const matches = rows.filter((fields) => fields[1] === itemId);
		return (
			matches.length === 1 &&
			matches[0].length === 4 &&
			matches[0].slice(1, 4).every(Boolean) &&
			FEEDBACK_CLASSIFICATIONS.has(matches[0][2])
		);
	});
}

async function persistState(
	directory: string,
	state: PrWorkflowGateState,
): Promise<void> {
	const validated = PrWorkflowGateStateSchema.parse(state);
	await withSessionStateMutation(directory, validated.sessionID, async () => {
		const nextState = await writeStateWhileLocked(directory, validated);
		Object.assign(state, nextState);
	});
}

/** Persist one CAS-checked state replacement while the session lock is held. */
async function writeStateWhileLocked(
	directory: string,
	state: PrWorkflowGateState,
	options: { replaceWorkflowInstanceId?: string } = {},
): Promise<PrWorkflowGateState> {
	const validated = PrWorkflowGateStateSchema.parse(state);
	const current = await readPrWorkflowGateStateFromDisk(
		directory,
		validated.sessionID,
	);
	if (
		current ? current.revision !== validated.revision : validated.revision !== 0
	) {
		throw new Error(
			'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
		);
	}
	if (
		current?.workflowInstanceId &&
		validated.workflowInstanceId !== current.workflowInstanceId &&
		options.replaceWorkflowInstanceId !== current.workflowInstanceId
	) {
		throw new Error(
			'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
		);
	}
	const nextState = PrWorkflowGateStateSchema.parse({
		...validated,
		revision: validated.revision + 1,
	});
	const filePath = workflowGateStatePath(directory, validated.sessionID);
	await writeAtomicJson(directory, filePath, nextState);
	rememberState(directory, nextState);
	return nextState;
}

/** Serialize in-process mutations; the durable revision rejects stale callers. */
async function withSessionStateMutation<T>(
	directory: string,
	sessionID: string,
	action: () => Promise<T>,
): Promise<T> {
	const key = stateCacheKey(directory, sessionID);
	const previous =
		pendingStateMutationsByProjectSession.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	pendingStateMutationsByProjectSession.set(key, queued);
	await previous;
	try {
		const lock = await acquireSessionStateMutationLock(directory, sessionID);
		try {
			return await action();
		} finally {
			await releaseSessionStateMutationLock(lock);
		}
	} finally {
		release();
		if (pendingStateMutationsByProjectSession.get(key) === queued) {
			pendingStateMutationsByProjectSession.delete(key);
		}
	}
}

async function acquireSessionStateMutationLock(
	directory: string,
	sessionID: string,
): Promise<{ path: string; ownerToken: string }> {
	const lockPath = workflowGateStateLockPath(directory, sessionID);
	await fsp.mkdir(path.dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await fsp.open(lockPath, 'wx');
			const lock: SessionStateMutationLock = {
				ownerToken: randomUUID(),
				pid: process.pid,
				createdAtMs: _test_exports.nowMs(),
			};
			let writeError: unknown;
			try {
				await handle.writeFile(JSON.stringify(lock), 'utf-8');
			} catch (error) {
				writeError = error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (writeError) {
				await removeSessionStateMutationLockIfOwned(lockPath, lock.ownerToken);
				throw writeError;
			}
			return { path: lockPath, ownerToken: lock.ownerToken };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await reclaimAbandonedSessionStateMutationLock(lockPath)) continue;
			if (attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS - 1) {
				await delay(STATE_MUTATION_LOCK_RETRY_DELAY_MS);
			}
		}
	}
	throw new Error(
		'BLOCKED: PR workflow gate state is being mutated by another process; retry after that session transition finishes',
	);
}

async function releaseSessionStateMutationLock(lock: {
	path: string;
	ownerToken: string;
}): Promise<void> {
	try {
		await removeSessionStateMutationLockIfOwned(lock.path, lock.ownerToken);
	} catch {
		// Best-effort cleanup; a crash-recovered lock is reclaimed by the next mutation.
	}
}

async function reclaimAbandonedSessionStateMutationLock(
	lockPath: string,
): Promise<boolean> {
	const lock = await readSessionStateMutationLock(lockPath);
	if (lock) {
		if (_test_exports.isProcessAlive(lock.pid)) return false;
		return removeSessionStateMutationLockIfOwned(lockPath, lock.ownerToken);
	}
	try {
		const stat = await fsp.stat(lockPath);
		if (
			_test_exports.nowMs() - stat.mtimeMs <
			STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS
		) {
			return false;
		}
		await fsp.rm(lockPath, { force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

async function readSessionStateMutationLock(
	lockPath: string,
): Promise<SessionStateMutationLock | null> {
	let raw: string;
	try {
		raw = await fsp.readFile(lockPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as SessionStateMutationLock).ownerToken === 'string' &&
			(parsed as SessionStateMutationLock).ownerToken.length > 0 &&
			typeof (parsed as SessionStateMutationLock).pid === 'number' &&
			Number.isInteger((parsed as SessionStateMutationLock).pid) &&
			(parsed as SessionStateMutationLock).pid > 0 &&
			typeof (parsed as SessionStateMutationLock).createdAtMs === 'number' &&
			Number.isFinite((parsed as SessionStateMutationLock).createdAtMs)
		) {
			return parsed as SessionStateMutationLock;
		}
	} catch {
		// A crash between exclusive create and metadata write is recovered below.
	}
	return null;
}

async function removeSessionStateMutationLockIfOwned(
	lockPath: string,
	ownerToken: string,
): Promise<boolean> {
	const lock = await readSessionStateMutationLock(lockPath);
	if (!lock || lock.ownerToken !== ownerToken) return false;
	try {
		await fsp.rm(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Permission errors prove the process exists. Unknown errors fail closed.
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

async function readPrWorkflowGateStateFromDisk(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState | null> {
	const filePath = workflowGateStatePath(directory, sessionID);
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${sessionID}" is not valid JSON`,
		);
	}
	const parsed = PrWorkflowGateStateSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${sessionID}" is invalid`,
		);
	}
	return parsed.data;
}

function rememberState(directory: string, state: PrWorkflowGateState): void {
	const cacheKey = stateCacheKey(directory, state.sessionID);
	trackedStatesByProjectSession.delete(cacheKey);
	trackedStatesByProjectSession.set(cacheKey, state);
	while (trackedStatesByProjectSession.size > MAX_TRACKED_SESSIONS) {
		const oldestKey = trackedStatesByProjectSession.keys().next().value;
		if (!oldestKey) break;
		trackedStatesByProjectSession.delete(oldestKey);
	}
}

function stateCacheKey(directory: string, sessionID: string): string {
	const resolved = path.normalize(path.resolve(directory));
	const canonicalDirectory =
		process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	return `${canonicalDirectory}\u0000${normalizeSessionID(sessionID)}`;
}

function workflowGateStatePath(directory: string, sessionID: string): string {
	return validateSwarmPath(directory, workflowGateStateRelativePath(sessionID));
}

function workflowGateStateLockPath(
	directory: string,
	sessionID: string,
): string {
	return validateSwarmPath(
		directory,
		workflowGateStateLockRelativePath(sessionID),
	);
}

function workflowGateStateLockRelativePath(sessionID: string): string {
	return path.join(
		WORKFLOW_GATE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.lock`,
	);
}

function workflowGateStateRelativePath(sessionID: string): string {
	return path.join(
		WORKFLOW_GATE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.json`,
	);
}

export function prWorkflowSessionFileStem(sessionID: string): string {
	const normalized = normalizeSessionID(sessionID);
	const slug =
		normalized.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'session';
	const digest = createHash('sha256')
		.update(normalized)
		.digest('hex')
		.slice(0, 12);
	return `${slug}-${digest}`;
}

function normalizeSessionID(sessionID: string): string {
	const normalized = sessionID.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow gate requires a non-empty sessionID');
	}
	return normalized;
}

export async function ensurePrWorkflowSafeParentDirectory(
	directory: string,
	filePath: string,
): Promise<string> {
	const swarmRoot = path.resolve(directory, '.swarm');
	const parentPath = path.dirname(path.resolve(filePath));
	const relativeParent = path.relative(swarmRoot, parentPath);
	if (
		relativeParent === '..' ||
		relativeParent.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeParent)
	) {
		throw new Error(
			'BLOCKED: PR workflow atomic destination escapes the project .swarm directory',
		);
	}
	await fsp.mkdir(swarmRoot, { recursive: true });
	let currentPath = swarmRoot;
	let currentIdentity = await assertSafeDirectory(currentPath, undefined);
	for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
		const nextPath = path.join(currentPath, segment);
		await _test_exports.beforeSafeDirectoryCreate?.(currentPath, nextPath);
		await assertSafeDirectory(currentPath, currentIdentity);
		try {
			await fsp.mkdir(nextPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		await assertSafeDirectory(currentPath, currentIdentity);
		const nextIdentity = await assertSafeDirectory(nextPath, undefined);
		const [realCurrent, realNext] = await Promise.all([
			fsp.realpath(currentPath),
			fsp.realpath(nextPath),
		]);
		if (
			normalizeComparableFsPath(path.dirname(realNext)) !==
			normalizeComparableFsPath(realCurrent)
		) {
			throw new Error(
				'BLOCKED: PR workflow directory creation escaped the project .swarm tree',
			);
		}
		currentPath = nextPath;
		currentIdentity = nextIdentity;
	}
	const realRoot = await fsp.realpath(swarmRoot);
	const realParent = await fsp.realpath(parentPath);
	const relativeRealParent = path.relative(realRoot, realParent);
	if (
		relativeRealParent === '..' ||
		relativeRealParent.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeRealParent)
	) {
		throw new Error(
			'BLOCKED: PR workflow atomic parent escapes the project .swarm directory',
		);
	}
	return realParent;
}

async function assertSafeDirectory(
	directoryPath: string,
	expectedIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined,
): Promise<Pick<BigIntStats, 'dev' | 'ino'>> {
	const stat = await fsp.lstat(directoryPath, { bigint: true });
	if (
		stat.isSymbolicLink() ||
		!stat.isDirectory() ||
		(expectedIdentity && !sameBigIntFileIdentity(stat, expectedIdentity))
	) {
		throw new Error(
			'BLOCKED: PR workflow .swarm path must be a real directory and must not change during the operation',
		);
	}
	return { dev: stat.dev, ino: stat.ino };
}

async function assertOpenedSwarmFileIdentity(
	directory: string,
	filePath: string,
	handle: Awaited<ReturnType<typeof fsp.open>>,
	expectedParent: string,
	label: string,
): Promise<Pick<BigIntStats, 'dev' | 'ino'>> {
	const openedStat = await handle.stat({ bigint: true });
	if (!openedStat.isFile()) throw new Error(`BLOCKED: ${label} is not a file`);
	await assertClosedSwarmFileIdentity(
		directory,
		filePath,
		openedStat,
		expectedParent,
		label,
	);
	return { dev: openedStat.dev, ino: openedStat.ino };
}

async function assertClosedSwarmFileIdentity(
	directory: string,
	filePath: string,
	expectedIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined,
	expectedParent: string,
	label: string,
): Promise<void> {
	if (!expectedIdentity) throw new Error(`BLOCKED: ${label} has no identity`);
	const [stat, realRoot, realFile, realParent] = await Promise.all([
		fsp.lstat(filePath, { bigint: true }),
		fsp.realpath(path.resolve(directory, '.swarm')),
		fsp.realpath(filePath),
		fsp.realpath(path.dirname(filePath)),
	]);
	const relativeFile = path.relative(realRoot, realFile);
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		!sameBigIntFileIdentity(stat, expectedIdentity) ||
		normalizeComparableFsPath(realParent) !==
			normalizeComparableFsPath(expectedParent) ||
		relativeFile === '' ||
		relativeFile === '..' ||
		relativeFile.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeFile)
	) {
		throw new Error(`BLOCKED: ${label} changed or escaped .swarm`);
	}
}

async function writeAtomicJson(
	directory: string,
	filePath: string,
	value: unknown,
): Promise<void> {
	const safeParent = await ensurePrWorkflowSafeParentDirectory(
		directory,
		filePath,
	);
	const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
	let tempIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined;
	let lastError: unknown;
	try {
		const handle = await fsp.open(tempPath, 'wx');
		try {
			await _test_exports.beforeAtomicTempWrite?.();
			tempIdentity = await assertOpenedSwarmFileIdentity(
				directory,
				tempPath,
				handle,
				safeParent,
				'PR workflow atomic temporary file',
			);
			await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await _test_exports.beforeAtomicRename?.();
		await assertClosedSwarmFileIdentity(
			directory,
			tempPath,
			tempIdentity,
			safeParent,
			'PR workflow atomic temporary file',
		);
		for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
			try {
				await _test_exports.rename(tempPath, filePath);
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
					break;
				}
				if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
					await delay(RENAME_RETRY_DELAY_MS);
				}
			}
		}
		if (lastError) {
			throw lastError;
		}
		await assertClosedSwarmFileIdentity(
			directory,
			filePath,
			tempIdentity,
			safeParent,
			'PR workflow atomic destination file',
		);
	} finally {
		try {
			await fsp.rm(tempPath, { force: true });
		} catch {
			// best-effort temp cleanup
		}
	}
}

/**
 * Write a PR-workflow artifact with the gate's Windows-safe atomic persistence
 * contract. Checkout-preparation receipts must survive the same transient
 * rename contention as canonical gate state.
 */
export async function writePrWorkflowAtomicJson(
	directory: string,
	filePath: string,
	value: unknown,
): Promise<void> {
	await writeAtomicJson(directory, filePath, value);
}

function isoNow(): string {
	return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
