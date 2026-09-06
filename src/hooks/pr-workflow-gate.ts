import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, type Dirent, readFileSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionStatus } from '@opencode-ai/sdk';
import { z } from 'zod';
import {
	analyzeCandidateFields,
	type CandidateArtifactRepairKind,
	type CandidateSeverity,
	candidateHeaderFamily,
	type FindingsSeverity,
	isCandidateSeverity,
	normalizeCandidateArtifactCached,
	type RowFormatFamily,
	selectCandidateHeader,
	splitPipeFields,
} from '../background/candidate-contract.js';
import { parseCandidates } from '../background/candidate-parser.js';
import {
	type LaneOutputArtifact,
	readLaneOutput,
} from '../background/lane-output-store.js';
import {
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundDelegationWorkflowLaneRecovery,
	DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
	findByBatchId,
	publishPrReviewResultReceipt,
	readDelegations,
	type SweepableDelegationStatus,
	sweepStaleDelegations,
} from '../background/pending-delegations.js';
import { MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS } from '../background/pr-review-collection-receipt.js';
import {
	decodePrReviewWorkflowBinding,
	generatePrReviewRunId,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_FINDINGS_MAX_BYTES,
	PR_REVIEW_HANDOFF_MAX_BYTES,
	type PrReviewLaneResultEnvelope,
	PrReviewLaneResultEnvelopeSchema,
	type PrReviewResultReceipt,
	PrReviewResultReceiptSchema,
	type PrReviewRiskImpact,
	type PrReviewRiskTag,
	PrReviewRunIdSchema,
	prReviewFindingRequiresCritic,
	prReviewLaneResultEnvelopeDigest,
	prReviewLegacyTranscriptCompatibilityEnabled,
} from '../background/pr-review-contract.js';
import {
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
	type PrReviewInlineTriggerRow,
	PrReviewInlineTriggerRowSchema,
	parsePrReviewTriggerReceipt,
	prReviewTriggerLedgerDigest,
	validatePrReviewInlineTriggerLedger,
} from '../background/pr-review-trigger-contract.js';
import {
	type RevisionDigestResult,
	resolveCommitCountSince,
	resolveCommitCountSinceAsync,
	resolveCurrentGitHead,
	resolveCurrentGitHeadAsync,
	resolveCurrentLocalHeadRefAsync,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamPushTargetAsync,
	resolveCurrentUpstreamRemoteRef,
	resolveExactRemoteBranchHead,
	resolveExactRemoteBranchHeadAsync,
	resolveIsExactSingleChildCommit,
	resolveIsExactSingleChildCommitAsync,
	resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync,
	resolvePrFeedbackTrackingCandidatesAsync,
	resolvePrReviewDiffStats,
	resolvePrReviewDiffStatsAsync,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestDetailed,
	resolvePrWorkflowRevisionDigestDetailedAsync,
	resolveRemoteRefsContainingHead,
	resolveRemoteRefsContainingHeadAsync,
	resolveRemoteUrlIdentity,
	resolveRemoteUrlIdentityAsync,
	switchPrFeedbackTrackingCandidateAsync,
} from '../background/workspace-snapshot.js';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import type { LaneLivenessWatchdogConfig } from '../config/schema.js';
import {
	DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
	type PrReviewResilienceConfig,
	resolveGeneratedAgentRole,
} from '../config/schema.js';
import { closeAllProjectDbs } from '../db/project-db.js';
import { appendCoreEventSync, readCoreEvents } from '../events/core-events.js';
import {
	classifyPrWorkflowGitState,
	type PrWorkflowGitState,
} from '../git/pr-workflow-state.js';
import { redactSecrets } from '../memory/redaction.js';
import {
	bindPrReviewReentryBindingReader,
	hasPrReviewReentryAuthorizationAgainstBinding,
	type PrReviewReentryAuthorizationRecord,
	type PrReviewReentryBindingContext,
	type PrReviewReentryRole,
	reservePrReviewReentryAuthorizationAgainstBinding,
} from '../pr-review/authorization.js';
import {
	adoptPrReviewCircuit,
	CIRCUIT_TERMINAL_DELEGATION_STATUSES,
	classifyPrReviewCircuitSignal,
	type PrReviewCircuitAdoptionDiagnostic,
	type PrReviewCircuitLegacyRecord,
	PrReviewCircuitRecordSchema,
	type PrReviewCircuitRecordV2,
	type PrReviewCircuitSignal,
	type PrReviewResiliencePolicyRecord,
	resolvePrReviewResiliencePolicy,
} from '../pr-review/circuit.js';
// Issue #2385: the coverage/completion settlement boundary. The gate binds
// its derivation helpers into the boundary at module init below; the two
// state-returning entry points are re-exposed locally with their original
// full-state signatures.
import {
	admitPrReviewPartialBaseCoverage as admitPrReviewPartialBaseCoverageFromCompletion,
	allowedPrReviewReportVerdicts,
	assertPrReviewBaseCoverageSettled as assertPrReviewBaseCoverageSettledFromCompletion,
	bindPrReviewCompletionHelpers,
	derivePrReviewDimensionSettlement,
	type PrReviewBaseDimensionAttempts,
	type PrReviewDimensionCancellationRecord,
	PrReviewDimensionCancellationRecordSchema,
	type PrReviewPartialBaseCoverageRecord,
	PrReviewPartialBaseCoverageRecordSchema,
	type PrReviewReportVerdict,
	type PrReviewTerminalCoverageSettlement,
	summarizePrReviewBaseDimensionAttempts,
} from '../pr-review/completion.js';
// Issue #2385: the legacy transcript adapter boundary. Raw transcript /
// artifact-text -> canonical conversion exists only in
// src/pr-review/legacy-transcript-adapter.ts; the guardrail scanner
// (src/pr-review/guardrails.ts) allows the conversion identifiers only there,
// so this gate consumes the adapter through the `legacy*` aliases, the test
// surface, and the shared composition types below.
import {
	analyzeLegacyVerdictRowContract,
	bindPrReviewTranscriptAdapterHelpers,
	composePrReviewPhaseVerdicts,
	legacyArtifactHasExactPositiveVerdictRow,
	legacyFeedbackArtifactCoversItems,
	legacyFeedbackArtifactTextCoversItems,
	legacyTranscriptAdapterTestSurface,
	type PrReviewComposablePhase,
	type PrReviewItemClaim,
	type PrReviewPhaseComposition,
	parseCriticVerdict,
	readLegacySettledFeedbackClassifications,
	reviewerItemBindingKey,
} from '../pr-review/legacy-transcript-adapter.js';
// Issue #2385: the atomic persistence boundary. The gate binds its
// `_test_exports` object and its full state codec at module init below; all
// seam properties are read at call time through the bound reference.
import {
	bindPrReviewPersistenceHooks,
	bindPrReviewStateCodec,
	CHECKOUT_MUTATION_ACTION_TIMEOUT_MS,
	defaultPersistenceHooks,
	deleteStateWhileLocked,
	forgetTrackedPrWorkflowState,
	isoNow,
	MAX_TRACKED_SESSIONS,
	normalizeComparableFsPath,
	normalizeSessionID,
	readPrWorkflowGateStateFileFromDisk,
	readPrWorkflowGateStateFromDisk as readPrWorkflowStateFromDiskBound,
	rememberState,
	resetPrReviewPersistenceCaches,
	sameBigIntFileIdentity,
	WORKFLOW_GATE_DIR,
	withPrWorkflowCheckoutMutationLock,
	withSessionStateMutation,
	workflowCheckoutMutationLockRelativePath,
	workflowGateStateLockRelativePath,
	workflowGateStatePath,
	workflowGateStateRelativePath,
	writeAtomicJson,
	writeStateWhileLocked,
} from '../pr-review/persistence.js';
import { reducePrReviewEvent } from '../pr-review/reducer.js';
import type {
	PrReviewEffect,
	PrReviewEvent,
	PrReviewWorkflowState,
} from '../pr-review/types.js';
import { canonicalWorkspaceIdentity } from '../scope/scope-binding.js';
import { swarmState } from '../state.js';
import { getPrWorkflowToolCapability } from '../tools/tool-metadata.js';
import { sameProjectRoot } from '../utils/canonical-root.js';
import { log, warn } from '../utils/logger.js';
import { withTimeout } from '../utils/timeout.js';
import {
	classifyLaneLivenessCondition,
	defaultReadLaneActivity,
	type EffectivePrLaneHorizon,
	laneLivenessWatchdogFeatures,
	MAX_LANE_LIVENESS_DISCLOSED_IDS,
	resolveEffectivePrLaneHorizonMs,
} from './lane-liveness-watchdog.js';
import { normalizeToolName } from './normalize-tool-name.js';
import { validateSwarmPath } from './utils.js';

export type {
	PrReviewDimensionCancellationRecord,
	PrReviewDimensionTerminalState,
	PrReviewPartialBaseCoverageRecord,
	PrReviewPartialBaseCoverageRecordV1,
	PrReviewPartialBaseCoverageRecordV2,
	PrReviewReportVerdict,
	PrReviewTerminalCoverageKind,
	PrReviewTerminalCoverageSettlement,
	PrReviewUnresolvedDimensionRecord,
} from '../pr-review/completion.js';

// Issue #2385: completion-owned surfaces re-exported for existing importers
// (tools, tests) — the gate remains the public import surface.
export {
	allowedPrReviewReportVerdicts,
	normalizePrReviewPartialBaseCoverageRecord,
	PR_REVIEW_REPORT_VERDICTS,
	readPrReviewTerminalCoverageForReport,
	rollbackPrReviewPartialBaseCoverageAdmission,
} from '../pr-review/completion.js';
// Issue #2385: persistence-owned surfaces re-exported for existing importers
// (pr-feedback-event-queue.ts, prepare-pr-workflow-checkout.ts, tests).
export {
	ensurePrWorkflowSafeParentDirectory,
	PrWorkflowCheckoutMutationTimeoutError,
	prWorkflowSessionFileStem,
	withPrWorkflowCheckoutMutationLock,
	writePrWorkflowAtomicJson,
} from '../pr-review/persistence.js';

// Issue #2385 compile-time guarantee: the gate's full state structurally
// satisfies the PR-review slice the reducer governs (one field definition;
// the gate only ADDS non-PR-review fields). If this assertion fails, the
// slice in src/pr-review/types.ts drifted from the gate state.
type _GateStateSatisfiesPrReviewSlice =
	PrWorkflowGateState extends PrReviewWorkflowState ? true : never;
const _gateStateSliceAssertion: _GateStateSatisfiesPrReviewSlice = true;
void _gateStateSliceAssertion;

/** Typed disk read over the bound codec (gate callers want the full state). */
function readPrWorkflowGateStateFromDisk(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState | null> {
	return readPrWorkflowStateFromDiskBound<PrWorkflowGateState>(
		directory,
		sessionID,
	);
}

/**
 * Re-exported for compatibility: the canonical six-dimension list is owned by
 * the PR-review contract module (issue #2383 single-source rule; a
 * source-scan guard test enforces it).
 */
export { PR_REVIEW_BASE_DIMENSION_IDS };

export const PR_REVIEW_REQUIRED_MICRO_LANE_IDS = PR_REVIEW_REQUIRED_TRIGGER_IDS;

export type PrReviewBaseDimensionId =
	(typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
export type PrWorkflowMode = 'PR_REVIEW' | 'PR_FEEDBACK';

export type PrReviewLaneValidationPredicate =
	| 'batch.validated_at'
	| 'batch.expected_lane_unique'
	| 'record.missing'
	| 'record.duplicate_lane'
	| 'record.subagent_session_id'
	| 'record.duplicate_subagent_session_id'
	| 'record.forbidden_subagent_session_id'
	| 'record.created_at'
	| 'record.workflow_lane'
	| 'record.owned_workflow_lanes'
	| 'record.mode'
	| 'record.pr_head_sha'
	| 'record.git_head'
	| 'record.status'
	| 'result.output_degraded'
	| 'result.transcript_incomplete'
	| 'result.chars'
	| 'result.digest'
	| 'result.output_ref'
	| 'artifact.readable'
	| 'artifact.ref'
	| 'artifact.batch_id'
	| 'artifact.lane_id'
	| 'artifact.mode'
	| 'artifact.session_id'
	| 'artifact.parent_session_id'
	| 'artifact.agent'
	| 'artifact.role'
	| 'artifact.source'
	| 'artifact.workflow_lane_record'
	| 'artifact.workflow_lane_expected'
	| 'artifact.pr_head_sha'
	| 'artifact.git_head'
	| 'artifact.revision_digest'
	| 'record.scope'
	| 'artifact.scope'
	| 'artifact.digest'
	| 'artifact.chars'
	| 'discovery.header'
	| 'discovery.row'
	| 'discovery.coverage'
	| 'discovery.duplicate_evidence'
	| 'reviewer.verdict_rows'
	| 'critic.verdict_rows';

export interface PrReviewLaneValidationFailure {
	predicate: PrReviewLaneValidationPredicate;
	expected: string;
	actual: string;
}

export type PrReviewLaneValidationResult =
	| {
			ok: true;
			/**
			 * Workflow lanes accepted only after repair — a synthesized canonical
			 * header, or valid rows retained beside malformed ones. Structural rather
			 * than log-only, so a repaired artifact is programmatically
			 * distinguishable from a well-formed one.
			 */
			salvaged?: readonly string[];
			/** Typed recovery disclosures persisted to the durable delegation ledger. */
			recoveries?: readonly BackgroundDelegationWorkflowLaneRecovery[];
	  }
	| { ok: false; failure: PrReviewLaneValidationFailure };

export interface PrReviewDiscoveryLaneValidationInput {
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
	artifact: LaneOutputArtifact | null;
	expected: {
		mode:
			| 'swarm-pr-review:base'
			| 'swarm-pr-review:micro'
			| 'swarm-pr-review:council';
		workflowLane: string;
		ownedWorkflowLanes?: readonly string[];
		prHeadSha: string;
		gitHead: string;
		revisionDigest: string;
		workflowInstanceId?: string;
		workflowRevision?: number;
		baseSha?: string;
		reviewScope?: string;
		checkWorkflowLane?: boolean;
	};
}

export interface PrWorkflowTransportRecoveryValidationInput {
	directory: string;
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
	artifact: LaneOutputArtifact | null;
	revisionDigest: string;
}

export interface PrReviewVerdictCollectionReceipt {
	assignedReviewItemIds: string[];
	acceptedReviewItemIds: string[];
	rejectedReviewItemIds: string[];
}

export type PrWorkflowTransportRecoveryValidationResult =
	| {
			ok: true;
			recoveries?: readonly BackgroundDelegationWorkflowLaneRecovery[];
			receipt?: PrReviewVerdictCollectionReceipt;
	  }
	| {
			ok: false;
			reason: string;
			failure?: PrReviewLaneValidationFailure;
			receipt?: PrReviewVerdictCollectionReceipt;
	  };

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
	smallMaxChangedLines: 100,
	smallMaxChangedFiles: 5,
	mediumMaxChangedLines: 1500,
	mediumMaxChangedFiles: 50,
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
 * Cumulative lane floor for a tier-L base wave that used consolidated failure
 * recovery (issue #1968 MUST-FIX 1).
 *
 * `PR_REVIEW_BASE_LANE_FLOORS.L` is the *initial wave* floor and equals the
 * dimension count, so it cannot also serve as the post-consolidation floor: any
 * consolidated lane owns at least two dimensions, so a wave that consolidated
 * even once is backed by at most five lanes. Enforcing six cumulatively would
 * make the tier-L retry exception unreachable — i.e. delete the feature.
 *
 * The bound that *is* enforceable, and is the property worth defending, is that
 * a tier-L wave may never be reduced by consolidation to a lane count a tier-M
 * dispatch would already have satisfied: the depth tier chosen for this PR must
 * not be silently downgraded by failure recovery. Hence "strictly more than the
 * tier-M floor" — four distinct lanes for six dimensions, a bounded loss of at
 * most two lanes of depth, versus the unbounded loss (down to two lanes) a
 * per-batch-only floor permits when a retry is split across batches.
 */
export const PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR =
	PR_REVIEW_BASE_LANE_FLOORS.M + 1;

/**
 * Minimum lane counts for a FULL micro (risk-family) sweep per depth tier. These
 * mirror the base floors' tier *semantics* — not their numbers — scaled to the
 * eleven risk families: S does not bind (a tier-S PR of ≤100 lines/≤5 files may
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

interface PrReviewResilienceAttemptRecord {
	attempt: 0 | 1 | 2;
	targetDimensions: PrReviewBaseDimensionId[];
	canaryBatchId: string;
	canaryLaneId: string;
	canaryWorkflowLane: PrReviewBaseDimensionId;
	admittedAt: string;
	fanoutBatchId?: string;
}

/**
 * Issue #2382: the persisted circuit is a versioned union. The unversioned
 * pre-#2382 shape migrates once to a nonblocking v2 record on first adoption
 * (see `adoptPrReviewCircuit`); malformed records fail open.
 */
type PrReviewResilienceCircuitRecord =
	| PrReviewCircuitLegacyRecord
	| PrReviewCircuitRecordV2;

interface PrReviewResilienceStateRecord {
	policy: PrReviewResiliencePolicyRecord;
	attempts: PrReviewResilienceAttemptRecord[];
	circuit?: PrReviewResilienceCircuitRecord;
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
		/** Typed proof kind (issue #2131 criterion C4); optional for records persisted before it existed. */
		proofKind?: string;
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

/**
 * Issue #2108: durable publication-generation state machine. The legacy
 * {@link PrFeedbackReadyToPublishRecord} above becomes a derived mirror that
 * is present exactly while the active generation is `{armed, push_in_flight}`
 * (or a legacy record awaits migration), so a rolled-back binary keeps
 * enforcing the armed window instead of turning permissive.
 */
export type PrFeedbackPublicationGenerationState =
	// `reviewing` is RESERVED (issue #2108 §1 requires it in the schema; the
	// pre-arming ladder lives in the ordinary workflow fields, so no
	// generation record is created until `complete_pr_workflow` arms — a
	// generation never persists in this state today, and parsing it back
	// stays fail-closed for hand-edited state).
	| 'reviewing'
	| 'armed'
	| 'invalidated'
	| 'push_in_flight'
	| 'published'
	| 'cancelled_without_publication';
export interface PrFeedbackPublicationEvidenceJoin {
	stageAValidatedAt: string;
	batches: Array<{
		phase: PrFeedbackGatePhase;
		batchId: string;
		laneId: string;
	}>;
}

export interface PrFeedbackPublicationGeneration {
	schemaVersion: 1;
	generation: number;
	state: PrFeedbackPublicationGenerationState;
	/** Canonical workspace identity at arming (`canonicalWorkspaceIdentity`). */
	workspaceIdentity: string;
	sessionID: string;
	/** HTTPS PR URL bound at arming (PR identity disclosure), when present. */
	prTargetUrl?: string;
	/** Immutable intake head the approved commit descends from. */
	intakeHeadSha: string;
	/** Local branch ref resolved at arming. */
	localHeadRef: string;
	/** Exact approved local head commit. */
	localHead: string;
	remoteName: string;
	/** Credential-redacted remote URL identity (`git remote get-url`). */
	remoteUrlIdentity?: string;
	remoteBranchRef: string;
	remoteRef: string;
	revisionDigest: string;
	/** The exact receipt set that authorized this generation. */
	evidence: PrFeedbackPublicationEvidenceJoin;
	invalidationReason?: string;
	supersededByGeneration?: number;
	createdAt: string;
	armedAt?: string;
	invalidatedAt?: string;
	publishedAt?: string;
	cancelledAt?: string;
}

export type PrFeedbackPushAttemptOutcome =
	| 'completed'
	| 'rejected'
	| 'uncertain'
	| 'cancelled';

export interface PrFeedbackPushAttempt {
	attemptId: string;
	generation: number;
	sessionID: string;
	callID?: string;
	/** SHA-256 over the canonical intent JSON. */
	intentDigest: string;
	intent: { remote: string; sourceSha: string; destRef: string };
	prePush: {
		localHead: string;
		worktreeClean: boolean;
		remoteName: string;
		remoteBranchRef: string;
		observedRemoteHead: string | null;
	};
	startedAt: string;
	result?: {
		outcome: PrFeedbackPushAttemptOutcome;
		exitStatus: number | 'not-observed';
		/** Bounded (<=500 chars) and secret-redacted. */
		diagnostic: string;
		postPush: {
			localHead: string | null;
			observedRemoteHead: string | null;
		};
		completedAt: string;
	};
}

export interface PrFeedbackPublicationState {
	schemaVersion: 1;
	active?: PrFeedbackPublicationGeneration;
	/** Bounded superseded-generation summaries (last 4). */
	history: PrFeedbackPublicationGeneration[];
	/** Bounded attempt records for the active generation (last 8). */
	attempts: PrFeedbackPushAttempt[];
}

/** Bounded history retention (issue #2108: bounded, authoritative summaries). */
const MAX_PUBLICATION_HISTORY_GENERATIONS = 4;
const MAX_PUBLICATION_ATTEMPTS = 8;
/** Bounded length for any persisted attempt diagnostic. */
const MAX_PUSH_ATTEMPT_DIAGNOSTIC_CHARS = 500;
/** Version of the publication-generation + attempt schemas. */
const PUBLICATION_SCHEMA_VERSION = 1 as const;
const PUBLICATION_URL_CREDENTIALS_PATTERN =
	/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g;

export type PrWorkflowCompletionStatus =
	| 'completed'
	| 'ready-to-publish'
	| 'verified-no-change';

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
	/**
	 * Optional in the TYPE only so a legacy findings row persisted before
	 * required-severity landed still loads (`readFindings` JSON-parses without
	 * re-validating). Presence is REQUIRED by
	 * `assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts`, which treats an
	 * omitted severity as a mismatch rather than skipping the check (issue #2279).
	 */
	severity?: FindingsSeverity;
	/**
	 * Typed risk metadata (issue #2383). Optional in the TYPE for the same
	 * legacy-read reason as `severity`; the WRITE boundary requires both on
	 * every CONFIRMED record, and this validator compares CONFIRMED records
	 * against the authoritative reviewer verdict's typed values.
	 */
	risk_impact?: PrReviewRiskImpact;
	risk_tags?: PrReviewRiskTag[];
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

/**
 * Per-batch coherence keys for item-keyed reviewer/critic composition.
 *
 * This deliberately lives OUTSIDE `PrReviewValidationBatchRecord`: that record's
 * schema is `.strict()`, and Zod's unknown-key policy is per-schema — the parent
 * state schema's `.passthrough()` does not relax a strict child. Adding fields to
 * the batch record would make a rolled-back plugin fail `safeParse` on every gate
 * state read, including `requireAnyActiveState`, which `abortPrWorkflow` calls
 * *before* the clear escape hatch. Keeping this as one new optional TOP-LEVEL key
 * on the passthrough parent keeps older code at "ignore the field I don't know"
 * instead of "refuse to read the file at all".
 */
interface PrReviewBatchCoherenceRecord {
	/**
	 * The exact candidate/critic inventory this batch's ownership was validated
	 * against at record time. A batch may own a subset of this inventory; retaining
	 * the full set here prevents stale partial batches from contributing after the
	 * mechanically derived inventory changes.
	 */
	validatedInventory: string[];
	/**
	 * Critic batches only: per-item sha256 of the full canonical `[REVIEWED]` row
	 * that was authoritative for that item when the critic batch was declared. A
	 * critic claim is admitted only while the current winning reviewer row for
	 * that item is byte-identical, so a reviewer re-run that changes evidence or
	 * root cause — not only classification/severity — drops exactly the critic
	 * claims it invalidated and leaves its siblings intact.
	 */
	reviewerItemBindings?: Record<string, string>;
	/** Key encoding for reviewerItemBindings; absent means legacy raw item IDs. */
	reviewerItemBindingKeyEncoding?: 'prefixed-v1';
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
	prReviewResilience?: PrReviewResilienceStateRecord;
	/** Dimensions that consumed their one contract-only retry; top-level for rollback readability. */
	prReviewContractRetryDimensions?: PrReviewBaseDimensionId[];
	/** Canonical ordered semantic ledger frozen by the first micro dispatch. */
	prReviewTriggerLedger?: PrReviewInlineTriggerRow[];
	prReviewTriggerEvalPath?: string;
	/**
	 * The run_id bound to the trigger-evaluation receipt at first consumption.
	 * Mirrors `prReviewArtifactRunId`: once set, a subsequent receipt under a
	 * different run_id is rejected, and it must agree with the findings artifact
	 * run_id (both live under `.swarm/pr-review/<run_id>/`). Closes issue #2124.
	 */
	prReviewTriggerEvalRunId?: string;
	prReviewValidationBatches?: PrReviewValidationBatchRecord[];
	/** Keyed by validation batch id. See `PrReviewBatchCoherenceRecord`. */
	prReviewBatchCoherence?: Record<string, PrReviewBatchCoherenceRecord>;
	/**
	 * Child session ids that produced a reviewer artifact for a validation batch
	 * the capacity GC has since dropped (issue #1968 MUST-FIX 3).
	 *
	 * `reviewerSubagentSessionIds` derives the critic reuse ban by walking the
	 * live reviewer batches, so pruning one would silently un-forbid its child
	 * sessions and let an agent challenge its own review. This ledger carries
	 * that fail-closed set across the prune.
	 */
	prReviewRetiredReviewerSessionIds?: string[];
	/**
	 * Canonical dimension-set keys of consolidated base lanes whose batch the
	 * capacity GC dropped (issue #1968 review round 2, FIX D).
	 *
	 * `tierLBackingLaneCount` covers the consolidated lanes it can see, and it can
	 * only see surviving `prReviewBaseDispatches`. A failed consolidated base
	 * batch is prunable, so without this ledger a prune would shrink the cover's
	 * universe and monotonically hand the wave back consolidation budget it had
	 * already spent.
	 */
	prReviewRetiredConsolidatedLanes?: string[];
	/**
	 * Durably reserved run_id for the current PR_REVIEW workflow before either
	 * writer has successfully committed its artifact. This lets omitted run_id
	 * calls infer the same run across retries/restarts and keeps the reservation
	 * separate from the trigger/findings completion receipts.
	 */
	prReviewReservedRunId?: string;
	prReviewArtifactRunId?: string;
	prReviewFindingsPath?: string;
	prReviewArtifactBoundaries?: PrReviewArtifactBoundary[];
	prReviewPartialBaseCoverage?: PrReviewPartialBaseCoverageRecord;
	prReviewCoverageDisclosurePath?: string;
	prReviewCoverageDisclosureDigest?: string;
	/**
	 * Explicit per-dimension cancellations (issue #2383), written only by the
	 * audited armed-recovery operation. A cancelled dimension is terminal for
	 * settlement purposes and never counts as covered. Bounded to the six
	 * canonical dimensions by key.
	 */
	prReviewDimensionCancellations?: Partial<
		Record<PrReviewBaseDimensionId, PrReviewDimensionCancellationRecord>
	>;
	prReviewHandoffPath?: string;
	prReviewHandoffRequired?: boolean;
	checkoutRecovery?: PrWorkflowCheckoutRecoveryRecord;
	/** HTTPS PR URL selected after canonical GitHub PR identity validation. */
	prFeedbackTargetUrl?: string;
	prFeedbackReviewHandoff?: PrFeedbackReviewHandoffRecord;
	prFeedbackInventory?: string[];
	/**
	 * Append-only audit ledger of entries added to `prFeedbackInventory` after
	 * its first declaration (issue #2242 R3). Bounded by
	 * {@link MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS}; never pruned.
	 */
	prFeedbackInventoryAmendments?: PrFeedbackInventoryAmendmentRecord[];
	prFeedbackVerifications?: PrFeedbackVerificationRecord[];
	/**
	 * Item -> lane bindings of verification batches the capacity GC dropped
	 * (issue #1968 review round 2, MUST-FIX C).
	 *
	 * `enforcePrFeedbackVerificationOwnership` rejects a re-claim of an inventory
	 * item by a different lane using a ledger rebuilt from every live batch.
	 * Pruning a batch would silently un-claim its items; this carries the binding
	 * across the prune so the rejection stays cumulative.
	 */
	prFeedbackRetiredItemOwnership?: Record<string, string>;
	/** @deprecated Compatibility projection of the most recent verification dispatch. */
	prFeedbackVerification?: PrFeedbackVerificationRecord;
	prFeedbackStageA?: PrFeedbackStageARecord;
	prFeedbackGateBatches?: PrFeedbackGateBatchRecord[];
	prFeedbackReadyToPublish?: PrFeedbackReadyToPublishRecord;
	/**
	 * Issue #2108: audited publication generations + push attempts. The
	 * authoritative publication state machine; `prFeedbackReadyToPublish`
	 * above is its derived rollback mirror. Optional so pre-#2108 state (and
	 * older binaries, via the root `.passthrough()`) loads unchanged.
	 */
	prFeedbackPublication?: PrFeedbackPublicationState;
	/**
	 * Issue #2383: audited armed-recovery marker. Present only after an armed
	 * workflow was explicitly recovered — lanes settled, one bounded audit
	 * event appended, staged publication authorization invalidated — leaving a
	 * recoverable terminal state that preserves validated work.
	 */
	prFeedbackArmedRecovery?: PrFeedbackArmedRecoveryRecord;
	/**
	 * Issue #2131 criterion C2: count of controlled base-sync/rebind transitions.
	 * Each rebind moves the immutable intake head to a new verified remote PR
	 * head after merge/rebase/conflict repair and invalidates every
	 * ancestry-bound receipt (Stage A, verification, gate batches) so the full
	 * mechanical ladder re-runs on the new ancestry.
	 */
	prFeedbackRebindCount?: number;
	prFeedbackScopes?: PrFeedbackScopeDeclarationRecord[];
}

const GATE_SCHEMA_VERSION = 1 as const;
const MAX_WORKFLOW_BATCHES = 128;
/**
 * Every valid PR_REVIEW base batch partitions the fixed six-dimension base
 * universe exactly once, so a batch can contribute at most one failed-dimension
 * proof per dimension and therefore no more than six contributor entries. A
 * consolidated retry lane may own multiple failed dimensions, so the same
 * `(batchId, laneId)` pair can legitimately appear more than once in the proof
 * set when one lane represents multiple dimensions.
 * The resilience circuit's contributor proof set is bounded by the batch cap
 * times that per-batch maximum.
 */
const MAX_PR_REVIEW_BASE_LANES_PER_BATCH = PR_REVIEW_BASE_DIMENSION_IDS.length;
const MAX_PR_REVIEW_RESILIENCE_CIRCUIT_CONTRIBUTORS =
	MAX_WORKFLOW_BATCHES * MAX_PR_REVIEW_BASE_LANES_PER_BATCH;
/**
 * Ceiling on the retired-reviewer-session ledger the capacity GC maintains,
 * sized at eight child sessions per pruned batch across a full cap. If a prune
 * would exceed it, the GC keeps every batch instead of dropping a forbidden
 * session id — losing the ban is a fail-open, losing the reclaim is only a dead
 * end, and the schema bound must never be the thing that decides which.
 */
const MAX_RETIRED_REVIEWER_SESSION_IDS = 1024;
/**
 * Ceiling on the retired-consolidated-lane ledger. Every entry this code
 * *writes* is a canonical subset of the six base dimensions with at least two
 * members — `PrReviewBaseDispatchRecordSchema` constrains both `workflowLane`
 * and `ownedWorkflowLanes` to `PrReviewBaseDimensionIdSchema` — so there are
 * exactly 2^6 - 6 - 1 = 57 such values and self-written state can never reach
 * 64.
 *
 * The guard is nonetheless live, because the ledger is *seeded from disk* and
 * its own schema is `z.array(z.string().min(1)).max(64)`, not the dimension
 * enum: a state file carrying up to 64 non-canonical entries plus the canonical
 * keys a prune contributes exceeds the bound. That is precisely the case a
 * fail-closed guard is for — the same reasoning as `MAX_COVER_UNIVERSE_BITS`,
 * which also refuses to assume disk state is enum-shaped. As with the
 * reviewer-session ledger, an overflowing prune keeps every batch rather than
 * dropping an entry: losing the ledger is a fail-open, losing the reclaim is
 * only a dead end.
 */
const MAX_RETIRED_CONSOLIDATED_LANES = 64;
/**
 * Ceiling on the retired feedback item-ownership ledger. An entry can only exist
 * for an item that passed the `inventorySet` membership check, so the ledger is
 * bounded by the declared feedback inventory; this is the schema's independent
 * backstop for an inventory the schema itself does not bound. A prune that would
 * exceed it keeps every batch rather than dropping a binding, on the same
 * reasoning as the reviewer-session ledger.
 */
const MAX_RETIRED_FEEDBACK_ITEM_OWNERS = 4096;

/**
 * Bound on the PR_FEEDBACK inventory-amendment audit ledger (issue #2242 R3).
 *
 * `declarePrFeedbackInventory` is agent-callable and each call can append, so
 * this array would otherwise grow without limit on durable state. It is an
 * integrity ledger, not a reclaimable cache: unlike `prFeedbackVerifications`
 * (which `prunePrFeedbackVerificationsForCapacity` compacts), pruning it would
 * destroy the audit trail, so the cap fails closed on further amendments
 * instead.
 */
export const MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS = 128;
const MAX_PR_WORKFLOW_GATE_DIRECTORY_ENTRIES = MAX_TRACKED_SESSIONS * 2 + 1;
const MAX_CANDIDATE_ISSUES_PER_ARTIFACT = 8;
const MAX_BASE_COVERAGE_DIAGNOSTICS = 8;
const MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS = 1_000;
const MAX_LANE_VALIDATION_VALUE_CHARS = 240;
const DISPATCH_TOOL_NAME = 'dispatch_lanes_async';
const BLOCKING_DISPATCH_TOOL_NAME = 'dispatch_lanes';

const PrReviewBaseDimensionIdSchema = z.enum(PR_REVIEW_BASE_DIMENSION_IDS);

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
			.min(1)
			.max(MAX_PR_REVIEW_BASE_LANES_PER_BATCH),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrReviewResiliencePolicyRecordSchema = z
	.object({
		enabled: z.boolean(),
		canaryProbeMs: z.number().int().positive(),
		statusProbeTimeoutMs: z.number().int().positive(),
		correlatedFailureThreshold: z.number().int().min(2).max(8),
		maxRetryAttemptsAfterInitial: z.number().int().min(0).max(2),
		circuitOpenDurationMs: z
			.number()
			.int()
			.min(1_000)
			.max(1_800_000)
			.optional(),
	})
	.strict();

const PrReviewResilienceAttemptRecordSchema = z
	.object({
		attempt: z.union([z.literal(0), z.literal(1), z.literal(2)]),
		targetDimensions: z
			.array(PrReviewBaseDimensionIdSchema)
			.min(1)
			.max(PR_REVIEW_BASE_DIMENSION_IDS.length),
		canaryBatchId: z.string().min(1),
		canaryLaneId: z.string().min(1),
		canaryWorkflowLane: PrReviewBaseDimensionIdSchema,
		admittedAt: z.string().min(1),
		fanoutBatchId: z.string().min(1).optional(),
	})
	.strict();

const PrReviewResilienceStateRecordSchema = z
	.object({
		policy: PrReviewResiliencePolicyRecordSchema,
		attempts: z.array(PrReviewResilienceAttemptRecordSchema).max(3),
		circuit: PrReviewCircuitRecordSchema.optional(),
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
						proofKind: z
							.enum([
								'defect',
								'metadata',
								'source-proof',
								'conflict',
								'ci',
								'user-decision',
							])
							.optional(),
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

const PrFeedbackPublicationEvidenceJoinSchema = z
	.object({
		stageAValidatedAt: z.string().min(1),
		// May be empty ONLY on conservatively-invalidated legacy migrations
		// where no batch could be resolved; arming a live generation always
		// requires the full one-batch-per-phase join (buildPublicationEvidenceJoin).
		batches: z.array(
			z
				.object({
					phase: z.enum([
						'stage-b-reviewer',
						'stage-b-test',
						'closeout-reviewer',
						'closeout-critic',
					]),
					batchId: z.string().min(1),
					laneId: z.string().min(1),
				})
				.strict(),
		),
	})
	.strict();

const PrFeedbackPublicationGenerationSchema = z
	.object({
		schemaVersion: z.literal(PUBLICATION_SCHEMA_VERSION),
		generation: z.number().int().positive(),
		state: z.enum([
			'reviewing',
			'armed',
			'invalidated',
			'push_in_flight',
			'published',
			'cancelled_without_publication',
		]),
		workspaceIdentity: z.string().min(1),
		sessionID: z.string().min(1),
		prTargetUrl: z.string().min(1).optional(),
		intakeHeadSha: z.string().min(1),
		localHeadRef: z.string().min(1),
		localHead: z.string().min(1),
		remoteName: z.string().min(1),
		remoteUrlIdentity: z.string().min(1).optional(),
		remoteBranchRef: z.string().startsWith('refs/heads/'),
		remoteRef: z.string().startsWith('refs/remotes/'),
		revisionDigest: z.string().min(1),
		evidence: PrFeedbackPublicationEvidenceJoinSchema,
		invalidationReason: z.string().min(1).optional(),
		supersededByGeneration: z.number().int().positive().optional(),
		createdAt: z.string().min(1),
		armedAt: z.string().min(1).optional(),
		invalidatedAt: z.string().min(1).optional(),
		publishedAt: z.string().min(1).optional(),
		cancelledAt: z.string().min(1).optional(),
	})
	.strict();

const PrFeedbackPushAttemptSchema = z
	.object({
		attemptId: z.string().min(1),
		generation: z.number().int().positive(),
		sessionID: z.string().min(1),
		callID: z.string().min(1).optional(),
		intentDigest: z.string().regex(/^[0-9a-f]{64}$/),
		intent: z
			.object({
				remote: z.string().min(1),
				sourceSha: z.string().min(1),
				destRef: z.string().startsWith('refs/heads/'),
			})
			.strict(),
		prePush: z
			.object({
				localHead: z.string().min(1),
				worktreeClean: z.boolean(),
				remoteName: z.string().min(1),
				remoteBranchRef: z.string().startsWith('refs/heads/'),
				// Observed remote heads flow through the injectable resolver
				// seam; test seams legitimately return non-hex sentinels, and the
				// resolver's own bounded-subprocess discipline governs production.
				observedRemoteHead: z.string().min(1).nullable(),
			})
			.strict(),
		startedAt: z.string().min(1),
		result: z
			.object({
				outcome: z.enum(['completed', 'rejected', 'uncertain', 'cancelled']),
				exitStatus: z.union([z.number().int(), z.literal('not-observed')]),
				diagnostic: z.string().max(MAX_PUSH_ATTEMPT_DIAGNOSTIC_CHARS),
				postPush: z
					.object({
						localHead: z.string().min(1).nullable(),
						observedRemoteHead: z.string().min(1).nullable(),
					})
					.strict(),
				completedAt: z.string().min(1),
			})
			.strict()
			.optional(),
	})
	.strict();

const PrFeedbackPublicationStateSchema = z
	.object({
		schemaVersion: z.literal(PUBLICATION_SCHEMA_VERSION),
		active: PrFeedbackPublicationGenerationSchema.optional(),
		history: z
			.array(PrFeedbackPublicationGenerationSchema)
			.max(MAX_PUBLICATION_HISTORY_GENERATIONS),
		attempts: z
			.array(PrFeedbackPushAttemptSchema)
			.max(MAX_PUBLICATION_ATTEMPTS),
	})
	.strict();

/**
 * One appended PR_FEEDBACK inventory entry (issue #2242 R3). `batch` groups the
 * entries appended by a single `declarePrFeedbackInventory` call so an auditor
 * can tell "two items found in one pass" from "two separate late discoveries".
 */
const PrFeedbackInventoryAmendmentRecordSchema = z
	.object({
		entry: z.string().min(1),
		amendedAt: z.string().min(1),
		batch: z.number().int().positive(),
	})
	.strict();

export type PrFeedbackInventoryAmendmentRecord = z.infer<
	typeof PrFeedbackInventoryAmendmentRecordSchema
>;

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
						reviewItemIds: z
							.array(z.string().min(1))
							.min(1)
							.max(MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS)
							.optional(),
					})
					.strict(),
			)
			.min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

// Intentionally NOT .strict(): this record is the newest persisted shape and is
// the most likely to gain fields. Passthrough keeps a future field opaque but
// present through any read-modify-write cycle instead of bricking a rollback.
const PrReviewBatchCoherenceRecordSchema = z
	.object({
		validatedInventory: z.array(z.string().min(1)),
		reviewerItemBindings: z
			.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/))
			.optional(),
		reviewerItemBindingKeyEncoding: z.literal('prefixed-v1').optional(),
	})
	.passthrough();

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
		prReviewResilience: PrReviewResilienceStateRecordSchema.optional(),
		prReviewContractRetryDimensions: z
			.array(PrReviewBaseDimensionIdSchema)
			.max(PR_REVIEW_BASE_DIMENSION_IDS.length)
			.optional(),
		prReviewTriggerLedger: z
			.array(PrReviewInlineTriggerRowSchema)
			.length(PR_REVIEW_REQUIRED_TRIGGER_IDS.length)
			.optional(),
		prReviewTriggerEvalPath: z.string().min(1).optional(),
		prReviewTriggerEvalRunId: z.string().min(1).optional(),
		prReviewValidationBatches: z
			.array(PrReviewValidationBatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prReviewBatchCoherence: z
			.record(z.string().min(1), PrReviewBatchCoherenceRecordSchema)
			.refine(
				(entries) => Object.keys(entries).length <= MAX_WORKFLOW_BATCHES,
				`prReviewBatchCoherence may not exceed ${MAX_WORKFLOW_BATCHES} entries`,
			)
			.optional(),
		prReviewRetiredReviewerSessionIds: z
			.array(z.string().min(1))
			.max(MAX_RETIRED_REVIEWER_SESSION_IDS)
			.optional(),
		prReviewRetiredConsolidatedLanes: z
			.array(z.string().min(1))
			.max(MAX_RETIRED_CONSOLIDATED_LANES)
			.optional(),
		prReviewReservedRunId: z.string().min(1).optional(),
		prReviewArtifactRunId: z.string().min(1).optional(),
		prReviewFindingsPath: z.string().min(1).optional(),
		prReviewPartialBaseCoverage:
			PrReviewPartialBaseCoverageRecordSchema.optional(),
		prReviewCoverageDisclosurePath: z.string().min(1).max(512).optional(),
		prReviewCoverageDisclosureDigest: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional(),
		prReviewDimensionCancellations: z
			.record(
				z.enum(PR_REVIEW_BASE_DIMENSION_IDS),
				PrReviewDimensionCancellationRecordSchema,
			)
			.optional(),
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
		// Append-only audit ledger for inventory amendments (issue #2242 R3).
		// Optional in both directions: older persisted state omits it, and older
		// code ignores it through the root `.passthrough()` below.
		prFeedbackInventoryAmendments: z
			.array(PrFeedbackInventoryAmendmentRecordSchema)
			.max(MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS)
			.optional(),
		prFeedbackVerifications: z
			.array(PrFeedbackVerificationRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prFeedbackRetiredItemOwnership: z
			.record(z.string().min(1), z.string().min(1))
			.refine(
				(entries) =>
					Object.keys(entries).length <= MAX_RETIRED_FEEDBACK_ITEM_OWNERS,
				`prFeedbackRetiredItemOwnership may not exceed ${MAX_RETIRED_FEEDBACK_ITEM_OWNERS} entries`,
			)
			.optional(),
		prFeedbackVerification: PrFeedbackVerificationRecordSchema.optional(),
		prFeedbackStageA: PrFeedbackStageARecordSchema.optional(),
		prFeedbackGateBatches: z
			.array(PrFeedbackGateBatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prFeedbackReadyToPublish: PrFeedbackReadyToPublishRecordSchema.optional(),
		// Issue #2108 publication-generation state machine. Optional both ways:
		// pre-#2108 state omits it, and older binaries carry it through the
		// root `.passthrough()` below without deleting it.
		prFeedbackPublication: PrFeedbackPublicationStateSchema.optional(),
		// Issue #2383 armed-recovery recoverable-terminal marker.
		prFeedbackArmedRecovery: z
			.object({
				recoveredAt: z.string().datetime(),
				prHeadSha: z.string().regex(/^[0-9a-f]{6,64}$/i),
				revisionDigest: z.string().min(1).max(256),
				generation: z.number().int().nonnegative(),
				reason: z.string().min(1).max(500),
			})
			.strict()
			.optional(),
		prFeedbackRebindCount: z.number().int().nonnegative().optional(),
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
	const initiallyActive = await readPrWorkflowGateState(
		directory,
		normalizedSessionID,
	);
	// Git status must be sampled before the checkout lock file exists because a
	// legacy project may not have `.swarm/` in its local exclude yet. Only the
	// state publication is the activation event that restoration must serialize.
	const checkoutPreflight =
		!initiallyActive && options.requireCheckoutPreflight
			? await _test_exports.classifyPrWorkflowGitStateAsync(directory)
			: null;
	// Checkout restoration must be atomic against a new gate in any session,
	// not only against reactivation of the restoring session. Every activation
	// therefore takes the project checkout lock before its one session lock.
	return withPrWorkflowCheckoutMutationLock(directory, async () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
			let existing = await readPrWorkflowGateStateFromDisk(
				directory,
				normalizedSessionID,
			);
			if (existing?.mode === mode) {
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
						existing = await writeStateWhileLocked(directory, {
							...existing,
							prFeedbackTargetUrl: options.prUrl,
							updatedAt: isoNow(),
						});
					}
				}
				return options.prHeadSha
					? bindPrWorkflowHeadWhileLocked(
							directory,
							normalizedSessionID,
							options.prHeadSha,
						)
					: existing;
			}
			if (existing) {
				throw new Error(
					`BLOCKED: session "${normalizedSessionID}" already has an active ${existing.mode} workflow; complete it before starting ${mode}`,
				);
			}
			if (options.requireCheckoutPreflight) {
				if (!checkoutPreflight) {
					throw new Error(
						'BLOCKED: PR workflow gate state changed during checkout preflight; retry activation against the current project state',
					);
				}
				// Re-sample while the project checkout lock is held. Ignore only the two
				// exact controller lock files created by this activation; every other
				// `.swarm` path remains a fail-closed tracking error. This locked sample
				// is authoritative against a restore that completed after initial intake.
				const lockedCheckoutPreflight =
					await _test_exports.classifyPrWorkflowGitStateAsync(directory, {
						ignoredPaths: [
							path.join('.swarm', workflowCheckoutMutationLockRelativePath()),
							path.join(
								'.swarm',
								workflowGateStateLockRelativePath(normalizedSessionID),
							),
						],
					});
				if (
					lockedCheckoutPreflight.kind === 'recovery-required' ||
					lockedCheckoutPreflight.kind === 'indeterminate'
				) {
					throw new Error(formatCheckoutRecoveryBlock(lockedCheckoutPreflight));
				}
			}
			const initialHead = options.prHeadSha
				? await assertCurrentCheckoutHead(directory, options.prHeadSha, mode)
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
				...(feedbackTargetUrl
					? { prFeedbackTargetUrl: feedbackTargetUrl }
					: {}),
			};
			return writeStateWhileLocked(directory, nextState);
		}),
	);
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
		forgetTrackedPrWorkflowState(directory, normalizedSessionID);
	}
	return state;
}

export type SubmitPrReviewResultOutcome =
	| { status: 'recorded' | 'duplicate'; receiptDigest: string }
	| { status: 'rejected'; reason: string };

/**
 * Publish one structured base/micro discovery result from the exact child
 * session that owns the live delegation. Lock order is deliberately
 * workflow-session -> delegation-evidence; clear/abort takes the same outer
 * lock and terminalization takes the same inner lock.
 */
export async function submitPrReviewResult(
	directory: string,
	childSessionId: string,
	input: {
		batchId?: string;
		laneId?: string;
		revisionDigest: string;
		result: PrReviewLaneResultEnvelope;
	},
): Promise<SubmitPrReviewResultOutcome> {
	const child = childSessionId.trim();
	const parsedResult = PrReviewLaneResultEnvelopeSchema.safeParse(input.result);
	if (!child || !parsedResult.success) {
		return {
			status: 'rejected',
			reason: 'invalid child session or result envelope',
		};
	}
	const preliminary = readDelegations(directory).filter(
		(record) =>
			record.subagentSessionId === child &&
			record.correlationId === child &&
			(record.mode === 'swarm-pr-review:base' ||
				record.mode === 'swarm-pr-review:micro'),
	);
	if (preliminary.length !== 1) {
		return {
			status: 'rejected',
			reason: `expected one exact child delegation, found ${preliminary.length}`,
		};
	}
	const parentSessionId = preliminary[0].parentSessionId;
	const record = preliminary[0];
	if (!record.batchId || !record.laneId) {
		return {
			status: 'rejected',
			reason: 'delegation batch/lane provenance is missing',
		};
	}
	if (
		(input.batchId !== undefined && input.batchId !== record.batchId) ||
		(input.laneId !== undefined && input.laneId !== record.laneId)
	) {
		return {
			status: 'rejected',
			reason: 'delegation batch/lane identity mismatch',
		};
	}
	const batchId = record.batchId;
	const laneId = record.laneId;
	return withSessionStateMutation(directory, parentSessionId, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			parentSessionId,
		);
		if (
			!state ||
			state.mode !== 'PR_REVIEW' ||
			!state.workflowInstanceId ||
			!state.prHeadSha ||
			!state.prReviewBaseSha
		) {
			return {
				status: 'rejected',
				reason: 'no active bound PR_REVIEW workflow',
			};
		}
		const ctx = await createPrReviewGateContext(directory, state);
		if (ctx.revisionDigest !== input.revisionDigest) {
			return { status: 'rejected', reason: 'stale dispatch revision digest' };
		}
		const dispatchWorkflowInstanceId = decodePrReviewWorkflowBinding(
			record.jobId,
		);
		const dispatchWorkflowRevision = record.workflowGeneration;
		if (!dispatchWorkflowInstanceId || dispatchWorkflowRevision === undefined) {
			return {
				status: 'rejected',
				reason: 'delegation workflow binding provenance is missing',
			};
		}
		if (dispatchWorkflowInstanceId !== state.workflowInstanceId) {
			return { status: 'rejected', reason: 'stale workflow instance binding' };
		}
		// Publication performs the authoritative exact-identity/state recheck while
		// holding the delegation-evidence lock. Reuse the discovery snapshot here
		// instead of scanning the durable ledger a third time.
		if (
			(record.mode !== 'swarm-pr-review:base' &&
				record.mode !== 'swarm-pr-review:micro') ||
			!sameProjectRoot(record.workspace?.directory ?? '', directory)
		) {
			return {
				status: 'rejected',
				reason: 'delegation mode or workspace mismatch',
			};
		}
		const ownedWorkflowLanes = record.ownedWorkflowLanes?.length
			? record.ownedWorkflowLanes
			: record.workflowLane
				? [record.workflowLane]
				: [];
		if (!record.workflowLane || ownedWorkflowLanes.length === 0) {
			return { status: 'rejected', reason: 'delegation ownership is missing' };
		}
		const semanticEnvelopeDigest = prReviewLaneResultEnvelopeDigest(
			parsedResult.data,
		);
		// Issue #2385 (final-critic finding 2): the submission TRANSITION is
		// reducer-owned. The reducer decides recorded / replay / conflict; a
		// conflicting second submission is rejected BEFORE any durable write
		// with the publisher's own reason; every accepted transition executes
		// its settle_delegation effect through the atomic receipt publisher
		// below (which remains the exactly-once durable authority).
		const existingReceiptDigest =
			record.result?.prReviewResultReceipt?.semanticEnvelopeDigest;
		const submission = reducePrReviewEvent(state, {
			type: 'lane_structured_result_submitted',
			batchId,
			laneId,
			generation: state.revision,
			semanticEnvelopeDigest,
			outcome: parsedResult.data.outcome,
			...(existingReceiptDigest !== undefined ? { existingReceiptDigest } : {}),
		});
		if (submission.status === 'rejected') {
			return {
				status: 'rejected',
				reason:
					submission.rejection.code === 'duplicate_conflicting_result'
						? 'a different bound receipt is already recorded'
						: `structured result submission rejected: ${submission.rejection.code}`,
			};
		}
		const published = await publishPrReviewResultReceipt(directory, {
			parentSessionId,
			childSessionId: child,
			batchId,
			laneId,
			expectedWorkflowInstanceId: state.workflowInstanceId,
			expectedWorkflowRevision: dispatchWorkflowRevision,
			expectedBaseSha: state.prReviewBaseSha,
			receipt: {
				schemaVersion: 1,
				mode: record.mode,
				workflowInstanceId: dispatchWorkflowInstanceId,
				workflowRevision: dispatchWorkflowRevision,
				batchId,
				laneId,
				workflowLane: record.workflowLane,
				ownedWorkflowLanes,
				baseSha: state.prReviewBaseSha,
				headSha: state.prHeadSha,
				dispatchRevisionDigest: input.revisionDigest,
				childSessionId: child,
				generation: record.generation ?? 1,
				semanticEnvelopeDigest,
				envelope: parsedResult.data,
			},
		});
		if (published.status === 'recorded' || published.status === 'duplicate') {
			return {
				status: published.status,
				receiptDigest: semanticEnvelopeDigest,
			};
		}
		return { status: 'rejected', reason: published.reason };
	});
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
	return withPrWorkflowCheckoutMutationLock(directory, async () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
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
		}),
	);
}

/**
 * Serialize post-terminal checkout restoration against both checkout mutations
 * and same-session gate activation. Holding the session-state lock while the
 * caller restores makes the inactive-gate check atomic with respect to a new
 * activatePrWorkflow/persistState call.
 */
export async function withInactivePrWorkflowCheckoutRestoreLock<T>(
	directory: string,
	sessionID: string,
	action: () => Promise<T>,
): Promise<T> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withPrWorkflowCheckoutMutationLock(directory, async () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
			const state = await readPrWorkflowGateStateFromDisk(
				directory,
				normalizedSessionID,
			);
			if (state) {
				throw new Error(
					'BLOCKED: checkout restoration is allowed only after complete_pr_workflow or abort_pr_workflow clears the active gate',
				);
			}
			await assertNoActivePrWorkflowGateForCheckoutRestore(directory);
			return action();
		}),
	);
}

/**
 * Refuse a project-wide checkout restoration while any durable PR workflow is
 * active. The caller already owns the project checkout lock, so a new session
 * cannot activate between this scan and the restoration action. We do not take
 * every other session lock: doing so would invert or multiply the established
 * checkout-lock -> one-session-lock order and could deadlock terminal flows.
 */
async function assertNoActivePrWorkflowGateForCheckoutRestore(
	directory: string,
): Promise<void> {
	const gateDirectory = validateSwarmPath(directory, WORKFLOW_GATE_DIR);
	let handle: Awaited<ReturnType<typeof fsp.opendir>>;
	try {
		handle = await fsp.opendir(gateDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	let entriesRead = 0;
	let scanError: unknown;
	let closeError: unknown;
	try {
		for (;;) {
			const entry = await handle.read();
			if (!entry) break;
			entriesRead += 1;
			if (entriesRead > MAX_PR_WORKFLOW_GATE_DIRECTORY_ENTRIES) {
				throw new Error(
					'BLOCKED: PR workflow gate inventory exceeds the bounded checkout-restoration scan; clear stale workflow state before retrying',
				);
			}
			if (!/\.json$/i.test(entry.name)) continue;
			if (!entry.isFile()) {
				throw new Error(
					'BLOCKED: PR workflow gate inventory contains a non-regular state entry; checkout restoration cannot prove project inactivity',
				);
			}
			const statePath = validateSwarmPath(
				directory,
				path.join(WORKFLOW_GATE_DIR, entry.name),
			);
			const state =
				await readPrWorkflowGateStateFileFromDisk<PrWorkflowGateState>(
					statePath,
					entry.name,
				);
			if (!state) continue;
			const expectedName = path.basename(
				workflowGateStateRelativePath(state.sessionID),
			);
			if (entry.name !== expectedName) {
				throw new Error(
					'BLOCKED: PR workflow gate inventory contains an ambiguous state filename; checkout restoration cannot prove project inactivity',
				);
			}
			throw new Error(
				`BLOCKED: checkout restoration cannot mutate this project while session "${state.sessionID}" has an active ${state.mode} workflow`,
			);
		}
	} catch (error) {
		scanError = error;
	} finally {
		try {
			await handle.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
				closeError = error;
			}
		}
	}
	if (scanError !== undefined) throw scanError;
	if (closeError !== undefined) throw closeError;
}

export async function clearPrWorkflowGateState(
	directory: string,
	sessionID: string,
	expectedRevision?: number,
	options: { allowSalvagedRead?: boolean } = {},
): Promise<void> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	await withSessionStateMutation(directory, normalizedSessionID, async () => {
		// The CAS-guard read is only meaningful when a caller supplies a
		// revision to compare against; skip it entirely otherwise so a
		// genuinely unreadable/malformed state file can still be cleared
		// (the sole purpose of this escape hatch) instead of the read itself
		// re-throwing the same failure it exists to recover from.
		if (expectedRevision !== undefined) {
			// Issue #2242 R4: the recovery abort path salvaged a revision from a
			// schema-invalid state and still wants real concurrency protection.
			// Reading it back through the GENERAL reader would re-throw the very
			// `is invalid` failure the salvage exists to route around, forcing an
			// unnecessary CAS drop. Only the abort path sets this flag; every
			// other caller keeps the strict read byte-for-byte.
			const current = options.allowSalvagedRead
				? ((
						await readPrWorkflowGateStateForRecovery(
							directory,
							normalizedSessionID,
						)
					)?.state ?? null)
				: await readPrWorkflowGateStateFromDisk(directory, normalizedSessionID);
			if (!current || current.revision !== expectedRevision) {
				throw new Error(
					'BLOCKED: PR workflow gate state changed during terminal completion; revalidate the current session state before retrying',
				);
			}
		}
		await deleteStateWhileLocked(directory, normalizedSessionID, {
			expectedStateRevision: expectedRevision,
			allowSalvagedRead: options.allowSalvagedRead,
		});
	});
}

/**
 * Presumed-stale settlement horizon for PR-workflow lanes.
 *
 * Reuses the background-delegation subsystem's canonical default rather than
 * `hooks.background_pending_timeout_minutes`: the three gate predicates that
 * consume it receive only `directory`/`sessionID` and never a resolved plugin
 * config, and this sweep is a **reachability floor** (abort and completion must
 * not be permanently blocked by a lane whose backing process died), not a
 * tunable policy knob.
 */
const PR_WORKFLOW_STALE_LANE_TIMEOUT_MS = DEFAULT_STALE_DELEGATION_TIMEOUT_MS;

/** Upper bound on lane ids named in one operator-facing disclosure string. */
const MAX_DISCLOSED_LANE_IDS = 10;

/**
 * The only status classes this gate's durability sweep may finalize.
 *
 * The sweep must never exceed what `isOpenPrWorkflowLane` counts as open —
 * settlement here is a decision about lanes this session observed as `pending`
 * or `running`, and the sweep is directory-wide with no session or mode filter,
 * so any wider set finalizes records the decision never reasoned about and
 * never discloses.
 *
 * `ingestion_error` is specifically excluded: it is a **retryable** state
 * (`terminalDisposition` maps it to `retry_ingestion`; `isTerminal` excludes
 * it), and the flip to `stale` is **irreversible** — the ingestion claim gate
 * admits only `completed` and `ingestion_error`, so a swept record answers
 * `not_ready` forever and the sole `ingestion_error` producer requires an
 * active claim lease it can no longer obtain.
 */
const PR_WORKFLOW_SWEEPABLE_LANE_STATUSES: ReadonlySet<SweepableDelegationStatus> =
	new Set<SweepableDelegationStatus>(['pending', 'running']);

/**
 * Exact disclosure emitted when the abort path takes `clearPrWorkflowGateState`'s
 * documented `expectedRevision === undefined` escape hatch because the durable
 * state's `revision` could not be salvaged (issue #2242 R4).
 */
const CAS_ESCAPE_DISCLOSURE =
	'state revision unsalvageable; cleared without compare-and-swap';

/**
 * Deadline for one PR-workflow lane liveness probe (issue #2251).
 *
 * The probe is a best-effort contradiction check on a decision that is already
 * safe without it, so it must never become the slow path of an escape hatch.
 * Exposed through `_test_exports.laneLivenessProbeTimeoutMs` because
 * `withTimeout` uses a REAL `setTimeout` and the test clock only patches
 * `Date.now()` — without the seam the timeout branch is a five-second
 * wall-clock test or theater.
 */
const PR_WORKFLOW_LANE_LIVENESS_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long an async lane may sit pending before `collect_lane_results`
 * starts probing its host session for a liveness advisory (issue #2280 Part B).
 * Order-of-minutes by design: far below the 30-minute presumed-stale horizon,
 * above normal dispatch jitter. Exposed through
 * `_test_exports.pendingLaneLivenessThresholdMs` and read at CALL time for the
 * same reason as the probe deadline above — the test clock patches `Date.now()`
 * without touching timers, so the seam is how a test reaches the boundary
 * without a wall-clock wait.
 */
const PR_WORKFLOW_PENDING_LIVENESS_THRESHOLD_MS = 3 * 60_000;

/**
 * The pending-liveness advisory applies to EVERY long-pending async lane.
 *
 * It originally covered only the five `swarm-pr-review:*` modes (issue #2280),
 * which left a plain `dispatch_lanes_async` lane with no liveness signal at all
 * — the same silent-wedge exposure the pr-review modes were given the advisory
 * to close. Issue #2349 widened it: a generic lane stalls exactly as silently,
 * and the advisory is alert-only by construction (it never cancels, retries,
 * replaces, or settles anything), so widening adds diagnosis without changing
 * any lane's lifecycle. The probe stays bounded — at most one host
 * session-status call per collection, none below the threshold, none beyond the
 * caller's remaining budget.
 */

/**
 * The session-status types that count as "provably still running".
 *
 * Deliberately an ALLOWLIST, not `type !== 'idle'`. The SDK's `SessionStatus`
 * union is closed at three members today, so the two formulations coincide —
 * but a future fourth member (`'error'`, `'cancelled'`, `'paused'`, …) would
 * silently start CONTRADICTING staleness under the negative formulation and
 * re-wedge abort and completion, which is exactly this issue returning. The
 * compile-time assert below fails the build instead.
 *
 * The element type is the SDK union, and the literals go through `satisfies`, so
 * a TYPO is a compile error too: `['busy', 'retyr']` no longer type-checks. The
 * exhaustiveness assert below constrains the SDK union, not this set's members,
 * so without the `satisfies` a misspelt member would compile clean and silently
 * retire the probe — every lookup would miss and every live lane would settle.
 */
const LIVE_SESSION_STATUS_TYPES: ReadonlySet<SessionStatus['type']> = new Set([
	'busy',
	'retry',
] satisfies SessionStatus['type'][]);

/**
 * Membership test for a status string that came off the wire.
 *
 * The single widening cast is deliberate and confined here: the probe's input is
 * an untrusted `string` from the host response, and `ReadonlySet<T>.has` accepts
 * only `T`, so the alternative is either widening the set (which loses the typo
 * check above) or scattering casts at the call site.
 */
function isLiveSessionStatusType(type: string): boolean {
	return (LIVE_SESSION_STATUS_TYPES as ReadonlySet<string>).has(type);
}

type _UnhandledSessionStatus = Exclude<
	SessionStatus['type'],
	'idle' | 'busy' | 'retry'
>;
/**
 * Compile-time exhaustiveness guard for {@link LIVE_SESSION_STATUS_TYPES}.
 * If the SDK adds a status member, `_UnhandledSessionStatus` stops being
 * `never`, this initializer stops type-checking, and whoever bumps the SDK has
 * to decide explicitly whether the new member is alive or settles.
 */
const _sessionStatusAllowlistIsExhaustive: _UnhandledSessionStatus extends never
	? true
	: never = true;

/**
 * The single session operation the liveness probe needs.
 *
 * Deliberately a narrow LOCAL structural type rather than a type-only import of
 * `SessionOps` from `src/tools/dispatch-lanes.ts`: that module's
 * `isLaneReadyForCollection` is the fail-CLOSED counterpart of this probe, and
 * keeping the two textually independent removes any invitation to "share" the
 * predicate. A type-only import would be erased either way; this is about
 * preventing the wrong reuse, not about module graph cost.
 */
interface PrWorkflowLaneLivenessSessionOps {
	status?: (args: { query?: { directory?: string } }) => Promise<{
		data?: Record<string, { type?: string }> | null;
		error?: unknown;
	}>;
	/**
	 * Issue #2506: the watchdog's best-effort, one-attempt lane abort. The
	 * host session object exposes it; the seam type keeps it optional so the
	 * probe-only hosts of the #2251 era remain valid.
	 */
	abort?: (args: unknown) => Promise<unknown>;
}

const defaultGetSessionOps = (): PrWorkflowLaneLivenessSessionOps | null =>
	(swarmState.opencodeClient?.session as unknown as
		| PrWorkflowLaneLivenessSessionOps
		| undefined) ?? null;

/** Why a probe produced no evidence of life. Absent means the probe ran. */
export type PrWorkflowLaneProbeDegradedReason =
	| 'probe-unavailable'
	| 'probe-error'
	| 'probe-timeout'
	| 'probe-no-data';

/**
 * Core session-status probe shared by the fail-open liveness probe below and
 * the pending-lane liveness advisory (issue #2280 Part B). Same host call,
 * deadline, and failure taxonomy as the probe; instead of collapsing each
 * session to allowlist membership it records the status TYPE the host reported
 * for every record that has one, so a caller can distinguish "live" from
 * "affirmatively non-live" from "session absent". Failure modes return the
 * empty map plus a `degradedReason` — a probe that did not fully read its
 * response never yields a partial map.
 */
async function probePrWorkflowLaneSessionStatusTypes(
	directory: string,
	records: readonly BackgroundDelegationRecord[],
	timeoutMs?: number,
): Promise<{
	statuses: Map<string, string>;
	degradedReason?: PrWorkflowLaneProbeDegradedReason;
}> {
	const session = _test_exports.getSessionOps();
	const statusOp = session?.status;
	if (!session || typeof statusOp !== 'function') {
		return { statuses: new Map(), degradedReason: 'probe-unavailable' };
	}
	// Identity-compared sentinel: the ONLY way to tell "the host took too long"
	// apart from "the host threw", since withTimeout rejects with this exact
	// object.
	const timeoutError = new Error(
		'PR workflow lane liveness probe exceeded its deadline',
	);
	let response: Awaited<ReturnType<NonNullable<typeof statusOp>>> | undefined;
	try {
		response = await withTimeout(
			(async () => statusOp.call(session, { query: { directory } }))(),
			timeoutMs ?? _test_exports.laneLivenessProbeTimeoutMs,
			timeoutError,
		);
	} catch (error) {
		return {
			statuses: new Map(),
			degradedReason: error === timeoutError ? 'probe-timeout' : 'probe-error',
		};
	}
	try {
		if (response?.error) {
			return { statuses: new Map(), degradedReason: 'probe-error' };
		}
		const data = response?.data;
		if (data === null || data === undefined) {
			return { statuses: new Map(), degradedReason: 'probe-no-data' };
		}
		const statuses = new Map<string, string>();
		for (const record of records) {
			const subagentSessionId = record.subagentSessionId;
			if (!subagentSessionId) continue;
			const type = data[subagentSessionId]?.type;
			if (typeof type === 'string') {
				statuses.set(subagentSessionId, type);
			}
		}
		return { statuses };
	} catch {
		return { statuses: new Map(), degradedReason: 'probe-error' };
	}
}

/**
 * Probe which of `records` have a session the host affirmatively reports as
 * still running (issue #2251).
 *
 * **FAIL-OPEN, by design.** For its ERROR and NO-DATA cases this is the exact
 * inverse of `isLaneReadyForCollection` (`src/tools/dispatch-lanes.ts`), which
 * returns `false` on a truthy `error`, on missing `data`, and on a throw —
 * because a lane it cannot verify must not be collected. The two agree, rather
 * than invert, on ONE case: a host that exposes no `status` function at all.
 * There the collector returns `true` (`dispatch-lanes.ts`, the `typeof
 * session.status !== 'function'` guard) and this probe reports
 * `probe-unavailable`, so both fall through to proceeding — an unprobeable host
 * must not wedge either side.
 *
 * Here the default outcome must be "settle": an unavailable, erroring,
 * timing-out or empty probe returns the empty set, so age alone decides and the
 * reachability floor this whole subsystem exists to preserve is untouched. Only
 * a probe that RAN and affirmatively named a live session may contradict
 * staleness.
 *
 * The returned set is built only from a fully-read response — a mid-iteration
 * throw yields the empty set rather than a partial spare list, so a malformed
 * response can never spare an arbitrary subset of lanes.
 *
 * Keys are `subagentSessionId`s. A record without one is unprobeable and is
 * simply never added (it settles), which is the fail-open direction.
 */
async function probeAlivePrWorkflowLaneSessions(
	directory: string,
	records: BackgroundDelegationRecord[],
): Promise<{
	alive: Set<string>;
	degradedReason?: PrWorkflowLaneProbeDegradedReason;
}> {
	const probe = await probePrWorkflowLaneSessionStatusTypes(directory, records);
	if (probe.degradedReason) {
		return { alive: new Set<string>(), degradedReason: probe.degradedReason };
	}
	const alive = new Set<string>();
	for (const [sessionId, type] of probe.statuses) {
		if (isLiveSessionStatusType(type)) alive.add(sessionId);
	}
	return { alive };
}

/** One still-pending lane's host liveness reading (issue #2280 Part B). */
export interface PrWorkflowPendingLaneLiveness {
	laneId: string;
	/**
	 * Milliseconds since the lane record last changed — the same aging field
	 * (`updatedAt`) the 30-minute presumed-stale sweep measures age by, so the
	 * advisory and the terminal sweep can never disagree about how old a lane is.
	 */
	pendingMs: number;
	/**
	 * Host session status when known: `'busy'`/`'retry'` are live; any other
	 * reported type is an affirmative non-live reading; `'absent'` means the host
	 * enumerated sessions without ours; `'unknown'` means the probe degraded (or
	 * the record has no session id to probe at all).
	 */
	hostStatus: string;
	/**
	 * Past threshold AND the host did not affirmatively report the session live
	 * (non-live status, session absent, or probe degraded). DIAGNOSTIC ONLY — a
	 * `true` value never cancels, retries, replaces, or settles the lane.
	 */
	stalledSuspect: boolean;
	/**
	 * Why the reading is not a real host status: the probe's own failure reasons,
	 * plus `'advisory-unavailable'` when the advisory's surrounding accounting
	 * failed unexpectedly after the past-threshold set was already known — so an
	 * emitted entry always distinguishes "degraded" from a missing probe, and an
	 * ABSENT `pending_liveness` keeps meaning "no lane was past the threshold".
	 */
	degradedReason?: PrWorkflowLaneProbeDegradedReason | 'advisory-unavailable';
}

/**
 * Bounded, fail-open liveness advisory for still-pending async lanes
 * (issue #2280 Part B).
 *
 * ALERT-ONLY, by design: this reads host session status and reports it; it
 * never cancels, retries, replaces, or settles anything. A stalled-suspect
 * critic may still be thinking — automatic replacement would risk duplicate
 * long-running critics racing on the same items — and the 30-minute
 * presumed-stale sweep (issue #2251) remains the only terminal backstop.
 *
 * Cost model: below the threshold there is NO host round-trip at all; past it,
 * exactly ONE session-status call regardless of how many lanes are pending,
 * deadline-bounded through the same `_test_exports` seams as the #2251 probe
 * and additionally clamped to the caller's remaining collection budget
 * (`probeBudgetMs`) — the diagnostic must never add wait beyond the budget the
 * caller already granted the collection itself. Any failure mode degrades
 * (`hostStatus: 'unknown'`, `stalledSuspect: true`, reason named) instead of
 * throwing — collection must never block or fail on this advisory.
 */
export async function collectPrWorkflowPendingLaneLiveness(
	directory: string,
	records: readonly BackgroundDelegationRecord[],
	options: { probeBudgetMs?: number } = {},
): Promise<PrWorkflowPendingLaneLiveness[]> {
	let now = 0;
	let pastThreshold: BackgroundDelegationRecord[] = [];
	const degraded = (
		record: BackgroundDelegationRecord,
		reason: PrWorkflowPendingLaneLiveness['degradedReason'],
	): PrWorkflowPendingLaneLiveness => ({
		laneId: record.laneId ?? record.correlationId,
		pendingMs: Math.max(0, now - record.updatedAt),
		hostStatus: 'unknown',
		stalledSuspect: true,
		degradedReason: reason,
	});
	try {
		now = _test_exports.nowMs();
		const threshold = _test_exports.pendingLaneLivenessThresholdMs;
		pastThreshold = records.filter(
			(record) =>
				(record.status === 'pending' ||
					record.status === 'running' ||
					record.status === 'ingesting') &&
				now - record.updatedAt > threshold,
		);
		if (pastThreshold.length === 0) return [];
		const budgetMs = Math.max(
			0,
			Math.min(
				_test_exports.laneLivenessProbeTimeoutMs,
				options.probeBudgetMs ?? Number.POSITIVE_INFINITY,
			),
		);
		if (budgetMs <= 0) {
			// No caller budget left to spend on the diagnostic: report the
			// degradation per lane instead of spending host time the caller
			// did not grant (the same budgeting `getLaneCollectionReadiness`
			// applies to its status calls).
			return pastThreshold.map((record) => degraded(record, 'probe-timeout'));
		}
		const probe = await probePrWorkflowLaneSessionStatusTypes(
			directory,
			pastThreshold,
			budgetMs,
		);
		const advisories: PrWorkflowPendingLaneLiveness[] = [];
		for (const record of pastThreshold) {
			const pendingMs = now - record.updatedAt;
			const laneId = record.laneId ?? record.correlationId;
			if (probe.degradedReason) {
				advisories.push({
					laneId,
					pendingMs,
					hostStatus: 'unknown',
					stalledSuspect: true,
					degradedReason: probe.degradedReason,
				});
				continue;
			}
			// A record without a session id never reached the host at all, so
			// 'absent' ("the host enumerated sessions without ours") would
			// overclaim — 'unknown' is the honest reading for that shape too.
			const subagentSessionId = record.subagentSessionId;
			const type = subagentSessionId
				? probe.statuses.get(subagentSessionId)
				: undefined;
			if (type === undefined) {
				advisories.push({
					laneId,
					pendingMs,
					hostStatus: subagentSessionId ? 'absent' : 'unknown',
					stalledSuspect: true,
				});
				continue;
			}
			advisories.push({
				laneId,
				pendingMs,
				hostStatus: type,
				stalledSuspect: !isLiveSessionStatusType(type),
			});
		}
		return advisories;
	} catch {
		// The advisory is a diagnostic, never a gate: an unexpected failure in
		// the surrounding accounting still emits per-lane 'advisory-unavailable'
		// entries whenever the past-threshold set is already known, so an absent
		// `pending_liveness` stays unambiguous ("nothing was past the
		// threshold") instead of silently conflating the two — and the
		// collection call that hosted the advisory still never fails.
		return pastThreshold.map((record) =>
			degraded(record, 'advisory-unavailable'),
		);
	}
}

export interface PrWorkflowStaleLaneSettlement {
	/**
	 * Every lane that still blocks: lanes with a fresh `updatedAt` PLUS lanes
	 * past the horizon whose session the liveness probe reported still running.
	 */
	openLaneIds: string[];
	openLanes: number;
	/**
	 * Open lanes that block on FRESHNESS alone (age below the horizon).
	 *
	 * Separated from `openLanes` because the human-only `force` abort override
	 * (issue #2251 S3) must distinguish "blocked only by probe retention", which
	 * an operator may override, from "blocked by a lane that is genuinely young",
	 * which stays fail-closed. Deriving it by subtraction or by comparing lane
	 * LABELS would be wrong: `prWorkflowLaneLabel` falls back to `'unknown'`, so
	 * labels are not unique.
	 */
	freshOpenLanes: number;
	/** Lanes stale past the horizon, treated as settled with disclosure. */
	presumedStaleLaneIds: string[];
	/**
	 * Lanes past the horizon that the probe spared. Present only when non-empty.
	 */
	probedAliveLaneIds?: string[];
	/**
	 * The SAME records as {@link probedAliveLaneIds}, in the same order, keyed by
	 * `correlationId` instead of by display label.
	 *
	 * Both are needed and neither substitutes for the other: `prWorkflowLaneLabel`
	 * falls back to `'unknown'` and is not unique, so it cannot address a durable
	 * record — while `correlationId` is the ledger's primary key and is what the
	 * human-only `force` override must name to finalize exactly these records and
	 * nothing else. Present only when non-empty.
	 */
	probeRetainedCorrelationIds?: string[];
	/** Set when the probe could not produce evidence; absent when it ran. */
	probeDegradedReason?: PrWorkflowLaneProbeDegradedReason;
	/** Operator-facing disclosure; `undefined` when nothing was settled or retained. */
	disclosure?: string;
}

/**
 * Probe outcome rendered as a suffix for an operator-facing BLOCKED message.
 *
 * Wired into all three open-lane refusals so a blocked caller can tell "a lane
 * is genuinely young" from "a lane past the horizon was spared because its
 * session answered" — otherwise the two are indistinguishable and the probe's
 * effect on the block is invisible.
 */
function describePrWorkflowLaneProbe(
	settlement: PrWorkflowStaleLaneSettlement,
): string {
	const parts: string[] = [];
	if (settlement.probedAliveLaneIds?.length) {
		parts.push(
			`liveness probe reports still running: ${settlement.probedAliveLaneIds
				.slice(0, MAX_DISCLOSED_LANE_IDS)
				.join(', ')}`,
		);
	}
	if (settlement.probeDegradedReason) {
		parts.push(`liveness probe degraded (${settlement.probeDegradedReason})`);
	}
	return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function prWorkflowLaneLabel(record: BackgroundDelegationRecord): string {
	return record.laneId ?? record.subagentSessionId ?? 'unknown';
}

function isOpenPrWorkflowLane(
	record: BackgroundDelegationRecord,
	sessionID: string,
): boolean {
	return (
		record.parentSessionId === sessionID &&
		record.mode?.startsWith('swarm-pr-') === true &&
		(record.status === 'pending' || record.status === 'running')
	);
}

/**
 * Resolve the open-lane predicate shared by `abortPrWorkflow`, the
 * PR_REVIEW→PR_FEEDBACK transition, and `completePrWorkflow` (issue #2242 R2,
 * wedge W-4).
 *
 * A lane whose delegation record has not advanced its `updatedAt` within
 * `PR_WORKFLOW_STALE_LANE_TIMEOUT_MS` is **presumed stale** and settles with
 * disclosure instead of blocking forever. The background process backing a lane
 * can die without ever writing a terminal snapshot, and these three predicates
 * are exactly the exits an operator reaches for when nothing else can proceed —
 * previously the abort escape hatch was refused by the same check it exists to
 * resolve, leaving the workflow with no exit through any tool.
 *
 * Deliberate ordering — this is the reachability invariant, do not "simplify"
 * it: staleness is decided by the **in-memory filter below**, and
 * `sweepStaleDelegations` runs only afterwards as a best-effort durability
 * complement. That sweep swallows lock timeouts and returns 0
 * (`pending-delegations.ts`), so making reachability depend on it would let a
 * contended store lock re-create the exact wedge this removes.
 *
 * A lane with a RECENT `updatedAt` still blocks: a re-verification that CAN run
 * and reports "still progressing" contradicts settlement and fails closed.
 *
 * Issue #2251 adds the second, stronger contradiction: a lane PAST the horizon
 * whose session the host affirmatively reports as `busy`/`retry` is genuinely
 * running (nothing heartbeats `updatedAt`, so age alone cannot see this) and is
 * retained instead of discarded. The probe is fail-open — the settlement
 * consumes it through the alive-set wrapper {@link
 * probeAlivePrWorkflowLaneSessions}; the fail-open taxonomy itself lives in
 * {@link probePrWorkflowLaneSessionStatusTypes} — so an unavailable, erroring
 * or empty probe leaves the age-only behaviour exactly as it was.
 */
/**
 * Issue #2506 (G2): optional lane-liveness watchdog options for the on-demand
 * settlement entry points. The two-argument call shape every existing caller
 * uses means "watchdog disabled" (the default-off config contract).
 */
export interface PrWorkflowLaneLivenessOptions {
	laneLivenessWatchdog?: LaneLivenessWatchdogConfig;
	backgroundPendingTimeoutMs?: number;
}

/**
 * The #2506 watchdog budget counters (issue AC7). Mutated in place so the
 * `_test_exports.laneLivenessWatchdog` surface reads live values; zeroed by
 * `resetTrackedStateCache()`.
 */
const laneLivenessWatchdogCounters = {
	hostStatusCalls: 0,
	hostAbortCalls: 0,
	evaluations: 0,
};

/** The #2506 watchdog seam surface exposed through `_test_exports`. */
const laneLivenessWatchdogSurface = {
	resolveEffectivePrLaneHorizonMs,
	classifyLaneLivenessCondition,
	evaluateLaneLivenessWatchdog: evaluateLaneLivenessWatchdogEscalation,
	readLaneActivity: defaultReadLaneActivity,
	...laneLivenessWatchdogCounters,
};

/**
 * Best-effort, bounded, ONE-attempt abort of a lane's subagent session
 * (#2506 execution_deadline). Never retried: the settlement below proceeds
 * with the real outcome regardless of whether the abort was delivered.
 */
async function abortLaneSessionForWatchdog(
	record: BackgroundDelegationRecord,
): Promise<boolean> {
	const session = _test_exports.getSessionOps();
	const abortOp = session?.abort;
	if (!session || typeof abortOp !== 'function' || !record.subagentSessionId) {
		return false;
	}
	try {
		await withTimeout(
			(abortOp as NonNullable<PrWorkflowLaneLivenessSessionOps['abort']>).call(
				session,
				{ path: { id: record.subagentSessionId } },
			),
			_test_exports.laneLivenessProbeTimeoutMs,
			new Error('lane-liveness watchdog abort exceeded its deadline'),
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Last escalation timestamp (epoch ms) per lane label, derived from the
 * durable event log — the registered, bounded, already-disclosed channel
 * (`.swarm/events.jsonl`). Disk-derived on purpose: the dedup must survive
 * `resetTrackedStateCache()` (frozen C4 contract) and must not fork a second
 * durable state file. Reading is a single bounded scan; events older than
 * the 7-day retention window fold into the manifest header, after which a
 * stale escalation no longer suppresses a fresh one — the correct behavior.
 *
 * The same scan also indexes the ACTIVITY OBSERVATION events
 * (`escalated: false` + `activityObserved: true`) written by
 * `appendWatchdogActivityObservation`: the durable proof that a lane
 * progressed since the last escalation, which is what re-arms a suppressed
 * lane for its next stall. The `execution_deadline` disclosure event is also
 * `escalated: false` but is NOT an activity observation (no activity was
 * observed — the opposite), so the marker field, not the absence of
 * `escalated`, decides membership.
 */
function lastWatchdogEscalationsByLaneLabel(directory: string): {
	escalations: Map<string, number>;
	activityObservations: Map<string, number>;
} {
	const escalations = new Map<string, number>();
	const activityObservations = new Map<string, number>();
	let text = '';
	try {
		text = readCoreEvents(directory).text;
	} catch {
		return { escalations, activityObservations };
	}
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes('pr_workflow_lane_watchdog')) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type !== 'pr_workflow_lane_watchdog') continue;
		const isEscalation = event.escalated === true;
		const isActivityObservation =
			!isEscalation && event.activityObserved === true;
		if (!isEscalation && !isActivityObservation) continue;
		const timestamp = Date.parse(`${event.timestamp}`);
		if (!Number.isFinite(timestamp)) continue;
		const laneIds = event.laneIds;
		if (!Array.isArray(laneIds)) continue;
		const target = isEscalation ? escalations : activityObservations;
		for (const label of laneIds) {
			if (typeof label !== 'string') continue;
			const prior = target.get(label);
			if (prior === undefined || timestamp > prior)
				target.set(label, timestamp);
		}
	}
	return { escalations, activityObservations };
}

/**
 * Record a progressing (non-stalled) observation durably as a
 * `pr_workflow_lane_watchdog` event with `escalated: false`. This is what
 * makes the re-escalation rule falsifiable from disk alone: after real
 * activity, the next stall is a NEW stall. Re-nudge-suppression idea adopted
 * from opencode-ensemble with credit (ADR 0002); reimplemented here.
 */
function appendWatchdogActivityObservation(
	directory: string,
	sessionID: string,
	labels: string[],
	horizon: EffectivePrLaneHorizon,
): void {
	try {
		appendCoreEventSync(directory, {
			type: 'pr_workflow_lane_watchdog',
			timestamp: isoNow(),
			sessionID,
			condition: 'provider_retry_in_flight',
			laneIds: labels.slice(0, MAX_LANE_LIVENESS_DISCLOSED_IDS),
			effectiveHorizonMs: horizon.horizonMs,
			horizonSource: horizon.source,
			escalated: false,
			// The durable activity marker: `lastWatchdogEscalationsByLaneLabel`
			// indexes events by this field to re-arm a suppressed lane. Without
			// it, only the in-memory seam's `lastActivityAtMs` could prove
			// progression, and a stall evaluation whose seam reports no
			// timestamp would dedupe forever on the first escalation.
			activityObserved: true,
			disclosure: `${labels.length} lane(s) progressed (activity observed since the last escalation); stall escalation baseline reset`,
		});
	} catch {
		// Best-effort: a failed observation record must never block settlement.
	}
}

/**
 * The #2506 stall-escalation evaluation for the lanes a settlement still
 * considers open or probe-retained: escalate each lane whose session is
 * busy/retry and whose observed activity in the last `stall_threshold_ms`
 * missed BOTH the step and the estimated-token thresholds, deduped per lane
 * against the last escalation event unless activity was observed since.
 * Advisory by design: an escalated lane is never settled or aborted here —
 * the operator response (inspect, or the human-only force abort) owns that.
 */
async function evaluateLaneLivenessWatchdogEscalation(args: {
	directory: string;
	sessionID: string;
	lanes: BackgroundDelegationRecord[];
	sessionTypes: Map<string, string>;
	watchdog: LaneLivenessWatchdogConfig;
	horizon: EffectivePrLaneHorizon;
}): Promise<void> {
	const { directory, sessionID, lanes, sessionTypes, watchdog, horizon } = args;
	const candidates = lanes.filter((record) => {
		if (!record.subagentSessionId) return false;
		const type = sessionTypes.get(record.subagentSessionId);
		return type === 'busy' || type === 'retry';
	});
	if (candidates.length === 0) return;
	const lastEscalations = lastWatchdogEscalationsByLaneLabel(directory);
	const escalated: BackgroundDelegationRecord[] = [];
	const progressed: BackgroundDelegationRecord[] = [];
	for (const record of candidates) {
		const activity = await laneLivenessWatchdogSurface.readLaneActivity(
			directory,
			record.subagentSessionId as string,
		);
		const steps = activity?.stepsObserved ?? 0;
		const tokens = activity?.estimatedTokens ?? 0;
		const progressing =
			steps >= watchdog.stall_min_steps ||
			tokens >= watchdog.stall_token_threshold;
		if (progressing) {
			progressed.push(record);
			continue;
		}
		const label = prWorkflowLaneLabel(record);
		const lastEscalation = lastEscalations.escalations.get(label);
		if (lastEscalation !== undefined) {
			// "Activity since the last escalation" is provable from either of
			// two independent sources: the live seam's `lastActivityAtMs`, or
			// the durable activity-observation event the progression path
			// wrote. The durable event matters because a stalled re-evaluation
			// legitimately reports NO `lastActivityAtMs` (nothing is happening
			// now) — the observation is the surviving record that activity DID
			// happen in between. The comparison is `>=` so a same-timestamp
			// observation counts as "since" (frozen-clock tests, or activity
			// within the same millisecond).
			const lastActivity = activity?.lastActivityAtMs;
			const activitySince =
				(lastActivity !== undefined && lastActivity >= lastEscalation) ||
				(lastEscalations.activityObservations.get(label) ?? -Infinity) >=
					lastEscalation;
			if (!activitySince) continue;
		}
		escalated.push(record);
	}
	if (progressed.length > 0) {
		appendWatchdogActivityObservation(
			directory,
			sessionID,
			progressed.map(prWorkflowLaneLabel),
			horizon,
		);
	}
	if (escalated.length === 0) return;
	const first = escalated[0];
	const condition = classifyLaneLivenessCondition({
		sessionStatusType: first.subagentSessionId
			? sessionTypes.get(first.subagentSessionId)
			: undefined,
		recordStatus: first.status,
		waitBudgetExpired: false,
		exceededEffectiveHorizon: Date.now() - first.updatedAt > horizon.horizonMs,
	});
	const laneLabels = escalated.map(prWorkflowLaneLabel);
	const disclosure =
		`${laneLabels.length} lane(s) stalled (fewer than ${watchdog.stall_min_steps} steps ` +
		`and fewer than ~${watchdog.stall_token_threshold} estimated tokens in the last ` +
		`${watchdog.stall_threshold_ms}ms): inspect the lane transcript or abort via ` +
		`/swarm abort-pr-workflow (force): ${laneLabels
			.slice(0, MAX_LANE_LIVENESS_DISCLOSED_IDS)
			.join(', ')}`;
	try {
		appendCoreEventSync(directory, {
			type: 'pr_workflow_lane_watchdog',
			timestamp: isoNow(),
			sessionID,
			condition,
			laneIds: laneLabels.slice(0, MAX_LANE_LIVENESS_DISCLOSED_IDS),
			effectiveHorizonMs: horizon.horizonMs,
			horizonSource: horizon.source,
			escalated: true,
			stall: {
				stepsObserved: 0,
				estimatedTokens: 0,
				stallThresholdMs: watchdog.stall_threshold_ms,
				stallMinSteps: watchdog.stall_min_steps,
				stallTokenThreshold: watchdog.stall_token_threshold,
			},
			disclosure,
		});
	} catch {
		// The escalation is advisory; settlement must not depend on the audit.
	}
}

export async function settlePresumedStalePrWorkflowLanes(
	directory: string,
	sessionID: string,
	options?: PrWorkflowLaneLivenessOptions,
): Promise<PrWorkflowStaleLaneSettlement> {
	// Issue #2506 (G2): resolve the ONE effective horizon up front. With the
	// watchdog disabled (the default, and the shape of every pre-#2506
	// two-argument call) this is exactly `PR_WORKFLOW_STALE_LANE_TIMEOUT_MS`
	// and every behavior below is byte-identical to the substrate's.
	const watchdog = options?.laneLivenessWatchdog;
	const { deadlineActive, stallActive } =
		laneLivenessWatchdogFeatures(watchdog);
	const watchdogWork = deadlineActive || stallActive;
	const horizon = resolveEffectivePrLaneHorizonMs(
		watchdog,
		options?.backgroundPendingTimeoutMs,
	);
	const now = Date.now();
	const open: BackgroundDelegationRecord[] = [];
	const presumedStale: BackgroundDelegationRecord[] = [];
	for (const record of readDelegations(directory)) {
		if (!isOpenPrWorkflowLane(record, sessionID)) continue;
		if (now - record.updatedAt > horizon.horizonMs) {
			presumedStale.push(record);
		} else {
			open.push(record);
		}
	}
	if (watchdogWork && (open.length > 0 || presumedStale.length > 0)) {
		laneLivenessWatchdogSurface.evaluations += 1;
	}
	if (presumedStale.length === 0) {
		// Stall-only watchdog pass: one shared status call over the open lanes
		// (the same directory-wide query the probe uses — no per-lane fan-out).
		if (watchdogWork && stallActive && open.length > 0) {
			let statuses = new Map<string, string>();
			try {
				const probe = await _test_exports.probeLaneSessionStatusTypesAsync(
					directory,
					open,
				);
				statuses = probe.statuses;
				if (!probe.degradedReason)
					laneLivenessWatchdogSurface.hostStatusCalls += 1;
			} catch {
				// Fail-open: an unprobeable host must not wedge the advisory path.
			}
			if (statuses.size > 0) {
				await evaluateLaneLivenessWatchdogEscalation({
					directory,
					sessionID,
					lanes: open,
					sessionTypes: statuses,
					watchdog: watchdog as LaneLivenessWatchdogConfig,
					horizon,
				});
			}
		}
		// Nothing is below the horizon to re-verify, so the probe is not consulted
		// at all: no host round-trip on the overwhelmingly common path.
		const freshOnlyLaneIds = open.map(prWorkflowLaneLabel);
		return {
			openLaneIds: freshOnlyLaneIds,
			openLanes: open.length,
			freshOpenLanes: open.length,
			presumedStaleLaneIds: [],
		};
	}
	// R5: the seam is mutable and this function has call sites with no try/catch
	// of their own, so a throwing probe must degrade here rather than convert a
	// settleable workflow into an unhandled rejection.
	//
	// Issue #2506: when the watchdog is active, ONE types-carrying probe serves
	// both the substrate's alive/retention decision and the watchdog's typed
	// conditions (`retry` = provider latency; `busy` past the effective horizon
	// = execution deadline). When inactive, the substrate's alive-set probe is
	// used unchanged.
	let probe: {
		alive: Set<string>;
		degradedReason?: PrWorkflowLaneProbeDegradedReason;
	};
	let sessionTypes = new Map<string, string>();
	if (watchdogWork) {
		try {
			const typesProbe = await _test_exports.probeLaneSessionStatusTypesAsync(
				directory,
				stallActive ? [...presumedStale, ...open] : presumedStale,
			);
			sessionTypes = typesProbe.statuses;
			if (!typesProbe.degradedReason) {
				laneLivenessWatchdogSurface.hostStatusCalls += 1;
			}
			const alive = new Set<string>();
			for (const [sessionId, type] of typesProbe.statuses) {
				if (isLiveSessionStatusType(type)) alive.add(sessionId);
			}
			probe = typesProbe.degradedReason
				? {
						alive: new Set<string>(),
						degradedReason: typesProbe.degradedReason,
					}
				: { alive };
		} catch {
			probe = { alive: new Set<string>(), degradedReason: 'probe-error' };
		}
	} else {
		try {
			probe = await _test_exports.probeLaneLivenessAsync(
				directory,
				presumedStale,
			);
		} catch {
			probe = { alive: new Set<string>(), degradedReason: 'probe-error' };
		}
	}
	const probeRetained: BackgroundDelegationRecord[] = [];
	const settled: BackgroundDelegationRecord[] = [];
	// Issue #2506: with the execution deadline active, a `busy` lane past the
	// EFFECTIVE horizon is an execution_deadline — the watchdog overrides
	// probe retention for it (that retention is exactly what kept a
	// genuinely-over-deadline lane alive forever). `retry` stays retained:
	// provider latency owns its own bounded retry, and a deadline must not
	// invent child failure for it. With the deadline inactive, retention is
	// the substrate's: every live (busy/retry) lane is spared.
	const deadlineLanes: BackgroundDelegationRecord[] = [];
	for (const record of presumedStale) {
		const type = record.subagentSessionId
			? sessionTypes.get(record.subagentSessionId)
			: undefined;
		if (deadlineActive && type !== 'retry') {
			deadlineLanes.push(record);
			settled.push(record);
		} else if (
			record.subagentSessionId &&
			probe.alive.has(record.subagentSessionId)
		) {
			probeRetained.push(record);
		} else if (deadlineActive) {
			// Probe degraded (or no session id): the deadline governs.
			deadlineLanes.push(record);
			settled.push(record);
		} else {
			settled.push(record);
		}
	}
	// Every returned count is derived AFTER the probe. Reporting the pre-probe
	// partition would let a spared lane be reported as settled, which is the
	// inverse wedge: abort and completion would sail past a live lane.
	const probedAliveLaneIds = probeRetained.map(prWorkflowLaneLabel);
	const openLaneIds = [...open.map(prWorkflowLaneLabel), ...probedAliveLaneIds];
	const retentionDisclosure =
		probeRetained.length > 0
			? `${probeRetained.length} lane(s) past the horizon retained: ` +
				`liveness probe reports still running: ${probedAliveLaneIds
					.slice(0, MAX_DISCLOSED_LANE_IDS)
					.join(', ')}`
			: undefined;
	const retentionFields = {
		...(probedAliveLaneIds.length > 0
			? {
					probedAliveLaneIds,
					probeRetainedCorrelationIds: probeRetained.map(
						(record) => record.correlationId,
					),
				}
			: {}),
		...(probe.degradedReason
			? { probeDegradedReason: probe.degradedReason }
			: {}),
	};
	if (settled.length === 0) {
		// Nothing was settled, so nothing may be swept and no
		// `pr_workflow_lanes_presumed_stale` record may be written — an audit trail
		// asserting a settlement that did not happen is worse than none.
		//
		// Issue #2506: retention is not a dead end — stall escalation still
		// surfaces the low-output lane for operator action.
		if (watchdogWork && stallActive && probeRetained.length > 0) {
			await evaluateLaneLivenessWatchdogEscalation({
				directory,
				sessionID,
				lanes: probeRetained,
				sessionTypes,
				watchdog: watchdog as LaneLivenessWatchdogConfig,
				horizon,
			});
		}
		return {
			openLaneIds,
			openLanes: openLaneIds.length,
			freshOpenLanes: open.length,
			presumedStaleLaneIds: [],
			...retentionFields,
			disclosure: retentionDisclosure,
		};
	}
	// Issue #2506: abort each deadline lane's session ONCE, best-effort, and
	// only while it is actually running (busy). A lane the probe could not see
	// has nothing left to abort; its settlement keeps the real outcome.
	if (deadlineActive) {
		for (const record of deadlineLanes) {
			const type = record.subagentSessionId
				? sessionTypes.get(record.subagentSessionId)
				: undefined;
			if (type !== 'busy' || !record.subagentSessionId) continue;
			const aborted = await abortLaneSessionForWatchdog(record);
			if (aborted) laneLivenessWatchdogSurface.hostAbortCalls += 1;
		}
		if (deadlineLanes.length > 0) {
			try {
				appendCoreEventSync(directory, {
					type: 'pr_workflow_lane_watchdog',
					timestamp: isoNow(),
					sessionID,
					condition: 'execution_deadline',
					laneIds: deadlineLanes
						.map(prWorkflowLaneLabel)
						.slice(0, MAX_LANE_LIVENESS_DISCLOSED_IDS),
					effectiveHorizonMs: horizon.horizonMs,
					horizonSource: horizon.source,
					escalated: false,
					disclosure:
						`${deadlineLanes.length} lane(s) exceeded the ${horizon.horizonMs}ms execution ` +
						`deadline (${horizon.source}); sessions aborted best-effort and settled through ` +
						`the shared path with the real outcome: no output observed (no transcript ` +
						`activity recorded for these lanes)`,
				});
			} catch {
				// Best-effort audit; the settlement below is the durable fact.
			}
		}
	}
	const presumedStaleLaneIds = settled.map(prWorkflowLaneLabel);
	// The leading clause is a STABLE PREFIX: existing operator tooling and tests
	// pin `N lane(s) stale >30min` / `treated as settled: …`. The probe verdict is
	// APPENDED so the three outcomes (probe ran and found nothing / probe could
	// not run / some lanes retained) are distinguishable without breaking it.
	const disclosure =
		`${presumedStaleLaneIds.length} lane(s) stale >` +
		`${Math.round(horizon.horizonMs / 60_000)}min, ` +
		`treated as settled: ${presumedStaleLaneIds
			.slice(0, MAX_DISCLOSED_LANE_IDS)
			.join(', ')}` +
		(probe.degradedReason
			? `; settled despite liveness probe failure (${probe.degradedReason})`
			: '; liveness probe found no live session') +
		(retentionDisclosure ? `; ${retentionDisclosure}` : '');
	// Best-effort ONLY. Makes the terminal `stale` transition durable so later
	// readers and the delegation ledger agree with the decision already made
	// above; reachability never depends on either write succeeding.
	//
	// Restricted to `pending`/`running` so the durable sweep cannot exceed what
	// `isOpenPrWorkflowLane` counted as open. The sweep is directory-wide with no
	// session filter, and its default scope also finalizes `ingestion_error` —
	// which is retryable, is never counted open here, and whose flip to `stale`
	// is irreversible at the ingestion claim gate.
	//
	// Issue #2251 R1: the sweep filters on status and age ONLY. A probe-retained
	// lane is `pending`/`running` and past the horizon by construction, so in a
	// mixed batch this directory-wide sweep would durably flip the very lane the
	// probe just spared — the spare would last exactly one call. Excluding them by
	// `correlationId` extends the existing "cannot exceed what
	// `isOpenPrWorkflowLane` counted as open" restriction to "cannot exceed what
	// this settlement DECIDED". The seam + try/catch keep a sweep failure from
	// affecting the decision already made above.
	//
	// Issue #2506: the sweep runs at the EFFECTIVE horizon (identical to the
	// constant whenever the watchdog is off), and a watchdog deadline lane is
	// deliberately NOT excluded — its settlement IS the decision.
	try {
		await _test_exports.sweepStaleDelegationsAsync(
			directory,
			horizon.horizonMs,
			{
				statuses: PR_WORKFLOW_SWEEPABLE_LANE_STATUSES,
				excludeCorrelationIds: new Set(
					probeRetained.map((record) => record.correlationId),
				),
			},
		);
	} catch {
		// Durability is best-effort; the in-memory decision above already stands.
	}
	try {
		appendCoreEventSync(directory, {
			type: 'pr_workflow_lanes_presumed_stale',
			timestamp: isoNow(),
			sessionID,
			presumedStaleLanes: presumedStaleLaneIds.slice(0, MAX_DISCLOSED_LANE_IDS),
			staleTimeoutMs: horizon.horizonMs,
			probeStatus: probe.degradedReason ?? 'ok',
			probedAliveLanes: probedAliveLaneIds.slice(0, MAX_DISCLOSED_LANE_IDS),
			disclosure,
		});
	} catch {
		// The audit trail is best-effort; settlement must not depend on it.
	}
	// Issue #2506: stall escalation runs after a settlement with no deadline
	// event this evaluation — a deadline settlement already carries the
	// operator's attention, and the still-open/retained lanes get theirs here.
	if (
		watchdogWork &&
		stallActive &&
		!(deadlineActive && deadlineLanes.length > 0)
	) {
		const stallCandidates = [...open, ...probeRetained];
		if (stallCandidates.length > 0 && sessionTypes.size > 0) {
			await evaluateLaneLivenessWatchdogEscalation({
				directory,
				sessionID,
				lanes: stallCandidates,
				sessionTypes,
				watchdog: watchdog as LaneLivenessWatchdogConfig,
				horizon,
			});
		} else if (stallCandidates.length > 0) {
			// Probe degraded: one shared retry is not in the budget; treat unknown
			// sessions as unescalatable (fail-open to silence, never to noise).
		}
	}
	return {
		openLaneIds,
		openLanes: openLaneIds.length,
		freshOpenLanes: open.length,
		presumedStaleLaneIds,
		...retentionFields,
		disclosure,
	};
}

/**
 * What {@link finalizeOverriddenProbeRetainedLanes} POSITIVELY OBSERVED on disk
 * after it ran — never what it inferred from an id's absence.
 */
interface OverriddenProbeRetainedLaneOutcome {
	/**
	 * Every still-open `swarm-pr-*` record of THIS session, targeted or not. This
	 * is the restartability answer, because `countOpenPrWorkflowLanes` is what
	 * refuses the next checkout preparation and it ignores which lanes an
	 * override reasoned about.
	 */
	sessionOpenLaneIds: string[];
	/**
	 * Targeted ids observed terminal `stale`: the override really did abandon
	 * these, and only these may be described as no longer collectable.
	 */
	finalizedLaneIds: string[];
	/**
	 * Targeted lanes the sweep did NOT finalize because they had already moved to
	 * some other status, rendered as `correlationId (status)`.
	 *
	 * The OBSERVED status is carried rather than dropped, and the disclosure
	 * asserts only that the record was left intact. Claiming "its output is
	 * collectable" would be the mirror of the bug this fixes: `error` and
	 * `ingestion_error` records surface through `collect_lane_results` as
	 * `failed` with no result text (`recordToLaneResult`,
	 * `src/tools/dispatch-lanes.ts`), and `ingesting` is filtered out of
	 * `lane_results` entirely until it settles. Naming the status lets the
	 * operator judge; asserting collectability would overclaim for three of the
	 * statuses that can land here.
	 */
	sparedLaneDescriptions: string[];
}

/**
 * Finalize the delegation records of the probe-retained lanes a human `force`
 * abort is overriding, so clearing the gate actually restarts the workflow.
 *
 * Without this, the override traded an unexitable gate for an UN-RESTARTABLE
 * session. The gate cleared, but each retained record stayed `pending` on disk
 * forever (the retained lane never terminates — that is the hypothesis the
 * override exists for), and `countOpenPrWorkflowLanes`
 * (`src/tools/prepare-pr-workflow-checkout.ts`) is age-blind and horizon-blind:
 * it counts every `pending`/`running` `swarm-pr-*` record of the session. So the
 * next `prepare_pr_workflow_checkout` was refused permanently, recoverable only
 * by hand-editing the ledger — the exact class of wedge this whole subsystem
 * exists to remove.
 *
 * Three constraints shape this, and none of them is optional:
 *
 * 1. **Override path ONLY.** The ordinary retention path must leave a retained
 *    record `pending`: that lane is alive and its output is still collectable,
 *    which is the entire point of issue #2251. Only an explicit human override
 *    abandons it.
 * 2. **Exactly these `correlationId`s.** `includeCorrelationIds` narrows the
 *    otherwise directory-wide sweep to the records this session's settlement
 *    reasoned about. A directory-wide pass would finalize other sessions'
 *    records and retryable `ingestion_error` records — the over-reach hazard
 *    already documented at the settlement sweep above.
 * 3. **It must not force a terminal record.** The sweep's own status and age
 *    filters still apply on top of the id narrowing, so a lane that raced to
 *    `completed` between the settlement read and this call keeps its result.
 *    `appendDelegationTransition` would NOT be safe here: it explicitly permits
 *    `completed` → `stale`, which would discard collected output — this issue's
 *    own bug, re-introduced on the force path.
 *
 * Runs only AFTER `clearPrWorkflowGateState` has succeeded (issue #2251
 * closeout F1). The finalization is irreversible — a `stale` record is never
 * collected again — while the clear is a CAS-guarded write that can legitimately
 * lose the compare-and-swap and throw. Ordering the irreversible half after the
 * reversible one means a lost CAS destroys no RETAINED lane, so the retry is a
 * real override rather than a no-op over lanes a failed attempt already
 * abandoned. It does NOT mean nothing was finalized: settlement sweeps the
 * batch's probe-dead lanes before the clear is attempted.
 *
 * The single read-back answers two INDEPENDENT questions over two different id
 * sets, which is why it returns three lists rather than one (issue #2251
 * closeout F2, then N1):
 *
 * - **"Can this session start a new PR workflow?"** — `sessionOpenLaneIds`,
 *   over every `swarm-pr-*` record of THIS SESSION, deliberately NOT just the
 *   targeted ids. `countOpenPrWorkflowLanes`
 *   (`src/tools/prepare-pr-workflow-checkout.ts`) is what actually refuses the
 *   restart, and it counts every `pending`/`running` `swarm-pr-*` record of the
 *   session, not the retained ones. The ordinary settlement sweep is best-effort
 *   and `sweepStaleDelegations` swallows a lock timeout and returns 0, so a lane
 *   the settlement DECIDED was stale can still be `pending` on disk here — and
 *   it refuses the next checkout preparation exactly like an unfinalized
 *   retained lane does. Reporting only the targeted ids let that case claim
 *   restartability it had not verified.
 * - **"Whose output did this override actually abandon?"** — answered by the
 *   OBSERVED terminal status of each targeted id, never by absence from the open
 *   set. Constraint 3 above means a targeted lane that raced to `completed` is
 *   spared by the sweep's own status filter, so it is absent from
 *   `sessionOpenLaneIds` for the opposite reason a finalized lane is. Inferring
 *   abandonment from that absence told the operator to stop looking for output
 *   that was in fact still collectable — the exact class of silent discard this
 *   whole issue exists to remove. Only a positively observed `stale` lands in
 *   `finalizedLaneIds`; a targeted lane observed in any other non-open status
 *   lands in `sparedLaneDescriptions`, disclosed WITH that observed status and
 *   described only as left intact — never as "collectable", which would
 *   overclaim for `error`, `ingestion_error` and `ingesting`.
 *
 * The read-back reuses {@link isOpenPrWorkflowLane}, the same predicate the
 * settlement counts with, so a hand-rolled second copy of its clauses cannot
 * drift from it.
 *
 * The predicates agree; their INPUTS can still diverge, and the doc comment
 * should not pretend otherwise. Everything here reads through `readDelegations`,
 * which SKIPS any ledger line that fails schema validation, while
 * `countOpenPrWorkflowLanes` — the check that actually refuses the restart —
 * fails CLOSED and throws on one. So a session whose ledger holds a malformed
 * row can be reported restartable here and still be refused there, and a
 * targeted lane sitting on such a row falls into none of the three lists: it is
 * silently omitted rather than falsely described as uncollectable. That
 * divergence is a pre-existing property of the shared reader, not of this
 * override, and both of its directions are conservative — so this path does not
 * grow a second parser to close it.
 *
 * The result is disclosed rather than retried: reachability must never depend on
 * a durability write, so the abort has already succeeded either way and the
 * operator is told precisely which records still need attention.
 */
async function finalizeOverriddenProbeRetainedLanes(
	directory: string,
	sessionID: string,
	correlationIds: readonly string[],
): Promise<OverriddenProbeRetainedLaneOutcome> {
	try {
		await _test_exports.sweepStaleDelegationsAsync(
			directory,
			PR_WORKFLOW_STALE_LANE_TIMEOUT_MS,
			{
				statuses: PR_WORKFLOW_SWEEPABLE_LANE_STATUSES,
				includeCorrelationIds: new Set(correlationIds),
			},
		);
	} catch {
		// Best-effort, exactly like the settlement sweep. The re-read below is what
		// reports the truth, so a swallowed failure still reaches the operator.
	}
	// Read back rather than trusting the swept COUNT: the count cannot say which
	// ids went terminal, only how many rows it touched. Only the durable status
	// answers either question the disclosure makes.
	const targeted = new Set(correlationIds);
	const outcome: OverriddenProbeRetainedLaneOutcome = {
		sessionOpenLaneIds: [],
		finalizedLaneIds: [],
		sparedLaneDescriptions: [],
	};
	for (const record of readDelegations(directory)) {
		if (isOpenPrWorkflowLane(record, sessionID)) {
			outcome.sessionOpenLaneIds.push(record.correlationId);
		}
		if (!targeted.has(record.correlationId)) continue;
		if (record.status === 'stale') {
			outcome.finalizedLaneIds.push(record.correlationId);
		} else if (record.status !== 'pending' && record.status !== 'running') {
			// A targeted lane still `pending`/`running` is deliberately in NEITHER
			// list: the sweep did not finalize it, and it is already named by the
			// restartability warning. Naming it twice — "left intact" beside "will
			// keep refusing checkout preparation" — reads to an operator as two
			// contradictory instructions about the same lane.
			outcome.sparedLaneDescriptions.push(
				`${record.correlationId} (${record.status})`,
			);
		}
	}
	return outcome;
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
 *   5. A `recovery` abort may clear an unbound or bound gate once every lane
 *      has settled. This is the bounded escape hatch for exhausted discovery,
 *      validation, or checkout recovery; requiring a pre-bind
 *      `checkoutRecovery` marker here would strand failures discovered only
 *      after the head was bound. `force` remains the explicit user override.
 *
 * Records a non-fatal audit event into the existing `.swarm/events.jsonl`
 * (no new ledger file), then delegates to `clearPrWorkflowGateState`.
 */
export async function abortPrWorkflow(
	directory: string,
	sessionID: string,
	options: {
		expectedMode?: PrWorkflowMode;
		kind: 'recovery' | 'force' | 'cancel-publication';
		reason: string;
		/**
		 * Issue #2108: the explicit cancellation-without-publication arm. While
		 * an armed/push_in_flight/invalidated publication generation exists,
		 * this arm (and ONLY this arm — mutually exclusive with `force`) may
		 * clear the workflow: it records the generation as
		 * `cancelled_without_publication` with the observed remote head and a
		 * REQUIRED reason, and never manufactures push authority. Plain
		 * `recovery`/`force` aborts remain refused while armed.
		 */
		cancelPublication?: boolean;
		/** Issue #2506: lane-liveness watchdog config for this settlement. */
		laneLiveness?: PrWorkflowLaneLivenessOptions;
	} = { kind: 'recovery', reason: '' },
): Promise<{
	mode: PrWorkflowMode;
	prHeadSha?: string;
	openLanes: number;
	presumedStaleLanes?: string[];
	presumedStaleDisclosure?: string;
	/** Lanes past the horizon the liveness probe reported as still running. */
	probeRetainedLanes?: string[];
	/**
	 * Present ONLY when a human `force` abort cleared the gate while those
	 * probe-retained lanes were the sole remaining reason it was blocked
	 * (issue #2251 S3).
	 */
	probeRetentionOverrideDisclosure?: string;
	/** Why the liveness probe produced no evidence, when it could not run. */
	probeDegradedReason?: PrWorkflowLaneProbeDegradedReason;
	stateSalvaged?: boolean;
	stateSalvageDisclosure?: string;
	casEscapeDisclosure?: string;
}> {
	// W-5 (issue #2242 R4): abort reads through the DEDICATED recovery reader so
	// a schema-invalid-but-parseable gate state cannot defeat the one escape
	// hatch that exists to clear it. Unparseable bytes still fail here.
	const recovery = await readPrWorkflowGateStateForRecovery(
		directory,
		sessionID,
	);
	if (!recovery) {
		// Issue #2108: the audited cancellation remains reachable even when
		// the gate state was deleted by hand while a generation was live —
		// the dangling-generation guard blocks publication commands until a
		// terminal lands, and THIS arm is the terminal: append the
		// `cancelled_without_publication` event (the events trail is the
		// authority the state-file deletion cannot touch) and disclose that
		// there was no gate state to clear.
		if (options.cancelPublication) {
			if (!options.reason.trim()) {
				throw new Error(
					'BLOCKED: cancel_publication requires a non-empty reason; the cancellation reason is part of the durable audit trail',
				);
			}
			const dangling = findDanglingLivePublicationGeneration(
				directory,
				sessionID,
			);
			if (!dangling) throw noActiveGateError(sessionID);
			appendPublicationEvent(directory, {
				type: 'pr_feedback_publication_cancelled',
				sessionID: normalizeSessionID(sessionID),
				generation: dangling.generation,
				reason: options.reason.trim(),
				stateFileAbsent: true,
			});
			return {
				mode: 'PR_FEEDBACK',
				openLanes: 0,
				stateSalvaged: false,
				stateSalvageDisclosure:
					'The gate state file was already absent; the live publication generation in the audit trail was recorded as cancelled_without_publication (event-only terminal).',
			};
		}
		throw noActiveGateError(sessionID);
	}
	const state = recovery.state;
	// Issue #2108: when the cancel-publication arm writes a cancellation
	// transition, the CAS clear below must compare against the NEW revision.
	let cancelRevision: number | null = null;
	if (options.expectedMode && state.mode !== options.expectedMode) {
		throw wrongModeError(state, options.expectedMode);
	}
	// Issue #2108: the cancel-publication arm runs BEFORE the armed-state
	// refusal below — it is the one audited exit from an armed window, and it
	// terminates the workflow WITHOUT publication (never grants push
	// authority). It requires a non-empty reason and is mutually exclusive
	// with the human-only `force` kind.
	if (options.cancelPublication) {
		if (options.kind === 'force') {
			throw new Error(
				'BLOCKED: cancel_publication cannot be combined with kind "force"; use kind "cancel-publication" with a reason',
			);
		}
		if (!options.reason.trim()) {
			throw new Error(
				'BLOCKED: cancel_publication requires a non-empty reason; the cancellation reason is part of the durable audit trail',
			);
		}
		if (
			state.mode !== 'PR_FEEDBACK' ||
			(!state.prFeedbackReadyToPublish &&
				!recovery.armedShapeUnreadable &&
				!state.prFeedbackPublication?.active)
		) {
			throw new Error(
				'BLOCKED: cancel_publication applies only to a PR_FEEDBACK workflow with a publication generation (armed, push_in_flight, or invalidated)',
			);
		}
		cancelRevision = await cancelPrFeedbackPublication(
			directory,
			sessionID,
			options.reason.trim(),
		);
	}
	// An armed marker that is PRESENT but unreadable is treated as armed. Any
	// other reading would make "corrupt this one record" a bypass of the
	// armed-abort refusal. The cancel-publication arm above already completed
	// (it marked the generation cancelled_without_publication and cleared the
	// mirror), so a plain abort here still fails closed on a live armed window.
	if (
		(state.prFeedbackReadyToPublish || recovery.armedShapeUnreadable) &&
		!options.cancelPublication
	) {
		throw new Error(
			`BLOCKED: ${state.mode} is armed for publication; abort is blocked. Complete the workflow with complete_pr_workflow (or push the bound commit first) before aborting, or use the audited cancellation (abort_pr_workflow with cancel_publication and a reason).` +
				(recovery.armedShapeUnreadable
					? ' The publication-arming record is itself unreadable, so it is treated as armed (fail-closed).'
					: ''),
		);
	}
	// W-4 (issue #2242 R2): lanes stale past the settlement horizon no longer
	// refuse the escape hatch that exists to resolve their own wedge. Lanes with
	// a fresh `updatedAt` still block.
	const laneSettlement = await settlePresumedStalePrWorkflowLanes(
		directory,
		state.sessionID,
		options.laneLiveness,
	);
	// S3 (issue #2251 R2): the liveness probe can now retain a lane past the age
	// horizon indefinitely, so age alone no longer guarantees an eventual exit. A
	// lane whose session never goes idle would make the workflow permanently
	// unexitable through every tool, with no recourse short of hand-editing
	// `.swarm/delegations.jsonl`.
	//
	// The human-only `force` path therefore overrides probe RETENTION — and only
	// probe retention. `freshOpenLanes === 0` is the whole safety argument: a lane
	// with a fresh `updatedAt` still blocks even under force, so the contradiction
	// rule is untouched. An explicit human override is not an age-based
	// presumption. The retained sessions are NOT aborted and their output is NOT
	// collected — but their RECORDS are finalized below, once the clear has
	// actually succeeded, because a cleared gate over `pending` records is an
	// un-restartable session, not an exit.
	const probeRetainedLanes = laneSettlement.probedAliveLaneIds ?? [];
	const overridesProbeRetention =
		options.kind === 'force' &&
		laneSettlement.freshOpenLanes === 0 &&
		probeRetainedLanes.length > 0;
	if (laneSettlement.openLanes > 0 && !overridesProbeRetention) {
		const laneIds = laneSettlement.openLaneIds
			.filter(Boolean)
			.slice(0, MAX_DISCLOSED_LANE_IDS)
			.join(', ');
		throw new Error(
			`BLOCKED: ${state.mode} abort refused while ${laneSettlement.openLanes} PR workflow lane(s) are still in flight (lane ids: ${laneIds}). Collect their results or let them settle before aborting.` +
				describePrWorkflowLaneProbe(laneSettlement),
		);
	}
	const sanitizedReason =
		typeof options.reason === 'string' && options.reason.trim().length > 0
			? options.reason.trim().slice(0, 500)
			: undefined;
	if (sanitizedReason === undefined) {
		throw new Error(
			`BLOCKED: ${state.mode} abort requires a non-empty reason (recorded to the audit trail).`,
		);
	}
	// The lanes this override abandons, addressed by `correlationId` — the
	// ledger's primary key, not the non-unique display label. DECIDED here (after
	// every refusal, before anything is written) but FINALIZED only once the
	// CAS-guarded clear has succeeded, far below (issue #2251 closeout F1).
	//
	// Gated on the override rather than derived from the retained ids alone.
	// Reaching here with retained lanes DOES imply an override today (a retained
	// lane keeps `openLanes > 0`, which the refusal above rejects otherwise), but
	// making the audit field depend on that inference would let a future change to
	// the refusal silently start naming lanes no override ever targeted.
	const overrideTargetedLaneIds = overridesProbeRetention
		? (laneSettlement.probeRetainedCorrelationIds ?? [])
		: [];
	// Everything about the override that is TRUE BEFORE the clear runs. The
	// durable `pr_workflow_aborted` record below is appended pre-clear (FB-008,
	// issue #2242) and therefore may not claim a finalization outcome that has not
	// happened yet; the returned disclosure appends that outcome once it has.
	const probeRetentionOverrideDecision = overridesProbeRetention
		? `force abort overrode ${probeRetainedLanes.length} lane(s) past the staleness horizon that the liveness probe reported as still running: ${probeRetainedLanes
				.slice(0, MAX_DISCLOSED_LANE_IDS)
				.join(
					', ',
				)}. Their sessions were NOT stopped and their output was NOT collected.`
		: undefined;
	const abortEvent = {
		type: 'pr_workflow_aborted',
		timestamp: isoNow(),
		sessionID: state.sessionID,
		mode: state.mode,
		kind: options.kind,
		...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
		...(state.checkoutRecovery ? { hadTerminalRecovery: true } : {}),
		openLanes: laneSettlement.openLanes,
		...(laneSettlement.presumedStaleLaneIds.length > 0
			? {
					presumedStaleLanes: laneSettlement.presumedStaleLaneIds.slice(
						0,
						MAX_DISCLOSED_LANE_IDS,
					),
					presumedStaleDisclosure: laneSettlement.disclosure,
				}
			: {}),
		// Issue #2251 R4: the probe verdict belongs in the abort record, not only in
		// the return value — an operator auditing why a gate cleared has to see that
		// lanes were spared (or that the probe could not run at all).
		...(probeRetainedLanes.length > 0
			? {
					probeRetainedLanes: probeRetainedLanes.slice(
						0,
						MAX_DISCLOSED_LANE_IDS,
					),
				}
			: {}),
		...(probeRetentionOverrideDecision
			? { probeRetentionOverrideDisclosure: probeRetentionOverrideDecision }
			: {}),
		// Which records this override TARGETS, by `correlationId`. A decision, not
		// an outcome: this record is appended before the clear, and the finalization
		// it authorizes runs only if that clear succeeds. An auditor reconciles the
		// two halves against the ledger itself — `.swarm/delegations.jsonl` is the
		// authority on whether each named row went terminal, and a row that is still
		// `pending` there is one that still refuses checkout preparation for this
		// session.
		...(overridesProbeRetention
			? {
					probeRetentionOverrideLanes: overrideTargetedLaneIds.slice(
						0,
						MAX_DISCLOSED_LANE_IDS,
					),
				}
			: {}),
		...(laneSettlement.probeDegradedReason
			? { probeStatus: laneSettlement.probeDegradedReason }
			: {}),
		...(recovery.salvaged
			? {
					stateSalvaged: true,
					stateSalvageDisclosure: recovery.disclosure,
					...(recovery.revisionSalvageable
						? {}
						: { casEscapeDisclosure: CAS_ESCAPE_DISCLOSURE }),
				}
			: {}),
		reason: sanitizedReason,
	};
	try {
		appendCoreEventSync(directory, abortEvent);
	} catch {
		// Non-fatal: the audit trail is best-effort. The gate must clear
		// regardless so the deadlock does not persist because of a write error.
	}
	// Pass the revision snapshot as a CAS guard, matching completePrWorkflow's
	// concurrency discipline: if the gate state changed between our reads and
	// this clear, the clear is rejected and the caller revalidates. Self-heals
	// on retry and prevents a late concurrent mutation from being silently
	// dropped by our clear.
	//
	// W-5 (issue #2242 R4): when the revision itself could not be salvaged there
	// is no value to compare against, so this deliberately takes the documented
	// `expectedRevision === undefined` escape hatch in `clearPrWorkflowGateState`
	// (see its comment above) — a disclosed, intentional CAS drop, not an
	// accidental one. When the revision WAS salvageable, normal CAS still
	// applies, reading back through the same salvage-tolerant view.
	const casEscape = recovery.salvaged && !recovery.revisionSalvageable;
	await _test_exports.beforeAbortClear?.();
	try {
		await clearPrWorkflowGateState(
			directory,
			sessionID,
			casEscape ? undefined : (cancelRevision ?? state.revision),
			{ allowSalvagedRead: recovery.salvaged },
		);
	} catch (error) {
		// The `pr_workflow_aborted` record above is already durable, and the
		// append deliberately precedes the clear so a write failure can never
		// block the gate from clearing. But `clearPrWorkflowGateState` THROWS on
		// a CAS mismatch, so a concurrent mutation would otherwise leave the
		// audit trail asserting an abort that never executed, with no field
		// distinguishing it. Append a best-effort correction — same non-fatal
		// discipline as the abort event — carrying sessionID/mode/prHeadSha so it
		// correlates with the record it retracts, then re-throw unchanged.
		try {
			appendCoreEventSync(directory, {
				type: 'pr_workflow_abort_not_completed',
				timestamp: isoNow(),
				sessionID: state.sessionID,
				mode: state.mode,
				...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
				reason: sanitizedReason,
				// Issue #2251 closeout F1: the override's irreversible finalization is
				// ordered AFTER the clear, so reaching here means the OVERRIDE never
				// ran and touched no retained lane. Scoped to the override on purpose
				// — two broader readings are false and were shipped and retracted
				// once each. "This abort touched nothing" is false because settlement
				// durably sweeps the batch's probe-dead lanes before the clear; "the
				// retained lanes are untouched" is false because a concurrent force
				// abort can clear and finalize them, which is itself one of the ways
				// this CAS loses. The disclosure below is hedged to match.
				...(overridesProbeRetention
					? {
							probeRetentionOverrideLanes: overrideTargetedLaneIds.slice(
								0,
								MAX_DISCLOSED_LANE_IDS,
							),
							probeRetentionOverrideFinalized: false,
						}
					: {}),
				// Reuses the generic diagnostic char cap rather than declaring a
				// third one-off bound; the value is a plain length ceiling on an
				// operator-facing string, not a coverage-specific quantity.
				failure: (error instanceof Error ? error.message : String(error)).slice(
					0,
					MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS,
				),
				// Claims only what this catch can actually observe. Every throw
				// reachable from `clearPrWorkflowGateState` today precedes the
				// unlink (CAS mismatch, lock acquisition, non-ENOENT rm), so the
				// gate is in fact still active — but asserting that here would
				// depend on a swallow in `releaseSessionStateMutationLock` ~8,500
				// lines away. Making a DURABLE audit record depend on that is the
				// same defect class this record exists to retract, so it stays
				// hedged and the operator revalidates.
				disclosure:
					'RETRACTION: the pr_workflow_aborted record for this session did NOT complete — ' +
					'the clear failed and the gate state may still be active. Revalidate the current ' +
					'session state before retrying the abort.' +
					(overridesProbeRetention
						? ' The probe-retention override finalized no record: it runs only after the ' +
							'clear succeeds, and this clear failed. Other lanes in the same settlement ' +
							'batch may already have been finalized as presumed-stale, and a concurrent abort for this session may have finalized more — revalidate the lane records rather than assuming they are untouched.'
						: ''),
			});
		} catch {
			// Non-fatal, exactly like the abort event: a failed correction append
			// must not mask the clear failure the caller has to see.
		}
		throw error;
	}
	// THE IRREVERSIBLE HALF, deliberately last (issue #2251 closeout F1). A
	// finalized record is terminal, the collector skips terminal records, and that
	// lane's transcript is gone for good — so it may only run once the reversible,
	// CAS-guarded half has actually succeeded. Ordering it before the clear meant a
	// lost compare-and-swap left a provably-live lane already abandoned while the
	// thrown error named neither the lane nor the override, and the operator's
	// retry then read as an ordinary force abort over nothing.
	//
	// The residual exposure is a process crash in the window between the two
	// writes: the records stay `pending`, which keeps the session un-restartable
	// until they settle. That is strictly the lesser failure — recoverable, and
	// the lane's output is still collectable — and it is why the finalization is
	// best-effort-with-disclosure rather than a precondition of the abort.
	const overrideOutcome: OverriddenProbeRetainedLaneOutcome =
		overridesProbeRetention
			? await finalizeOverriddenProbeRetainedLanes(
					directory,
					state.sessionID,
					overrideTargetedLaneIds,
				)
			: {
					sessionOpenLaneIds: [],
					finalizedLaneIds: [],
					sparedLaneDescriptions: [],
				};
	// THREE independent facts on three independent conditions (issue #2251
	// closeout F2, then N1). Every one of them is a POSITIVE observation:
	//
	//   1. Which overridden records went terminal `stale`? — that, and only that,
	//      makes a lane's output permanently uncollectable.
	//   2. Which overridden records did the sweep leave INTACT because they had
	//      already moved on? — the operator must not be told to stop looking for
	//      work this abort never abandoned. Reported with the observed status
	//      rather than as "collectable": that would overclaim for the `error`,
	//      `ingestion_error` and `ingesting` statuses that can also land here.
	//   3. Can this session start a new PR workflow? — answered only by every
	//      still-open `swarm-pr-*` record of the session, because
	//      `countOpenPrWorkflowLanes` is what refuses the restart and it does not
	//      care which lanes an override reasoned about.
	//
	// (1) and (3) come apart in a mixed batch: the ordinary settlement sweep
	// swallows a store-lock timeout and returns 0, so a lane this abort reported
	// as SETTLED can still be `pending` on disk and refuse the next checkout
	// preparation even though every overridden lane WAS finalized. Conflating them
	// either claims restartability that was never verified (the original defect)
	// or suppresses the abandonment notice for a lane whose transcript is
	// genuinely gone.
	//
	// (1) and (2) came apart because the abandonment clause used to be decided by
	// ABSENCE from the open set. A raced-to-`completed` lane is absent for the
	// opposite reason a finalized one is, so the clause fired over a lane whose
	// result was sitting on disk, collectable — telling the operator to stop
	// looking for recoverable work is precisely the harm this issue removes.
	const probeRetentionOverrideDisclosure = probeRetentionOverrideDecision
		? probeRetentionOverrideDecision +
			(overrideOutcome.finalizedLaneIds.length === 0
				? ''
				: ` Their delegation records were finalized (correlationId: ${overrideOutcome.finalizedLaneIds
						.slice(0, MAX_DISCLOSED_LANE_IDS)
						.join(
							', ',
						)}); whatever those lanes still produce is no longer collectable.`) +
			(overrideOutcome.sparedLaneDescriptions.length === 0
				? ''
				: ` ${overrideOutcome.sparedLaneDescriptions.length} of the overridden lane(s) were NOT finalized: the sweep left those records intact at the status they had already reached (${overrideOutcome.sparedLaneDescriptions
						.slice(0, MAX_DISCLOSED_LANE_IDS)
						.join(
							', ',
						)}). This abort did not discard them — check collect_lane_results before assuming that work is gone.`) +
			(overrideOutcome.sessionOpenLaneIds.length === 0
				? ' A new PR workflow can now be started for this session.'
				: ` WARNING: ${overrideOutcome.sessionOpenLaneIds.length} PR workflow delegation record(s) for this session are still open (correlationId: ${overrideOutcome.sessionOpenLaneIds
						.slice(0, MAX_DISCLOSED_LANE_IDS)
						.join(
							', ',
						)}) and will keep refusing PR workflow checkout preparation for this session until they settle.`)
		: undefined;
	return {
		mode: state.mode,
		...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
		openLanes: laneSettlement.openLanes,
		...(laneSettlement.presumedStaleLaneIds.length > 0
			? {
					presumedStaleLanes: laneSettlement.presumedStaleLaneIds,
					presumedStaleDisclosure: laneSettlement.disclosure,
				}
			: {}),
		...(probeRetainedLanes.length > 0 ? { probeRetainedLanes } : {}),
		...(probeRetentionOverrideDisclosure
			? { probeRetentionOverrideDisclosure }
			: {}),
		...(laneSettlement.probeDegradedReason
			? { probeDegradedReason: laneSettlement.probeDegradedReason }
			: {}),
		...(recovery.salvaged
			? {
					stateSalvaged: true,
					stateSalvageDisclosure: recovery.disclosure,
				}
			: {}),
		...(casEscape ? { casEscapeDisclosure: CAS_ESCAPE_DISCLOSURE } : {}),
	};
}

/** Marker record left by an audited armed recovery (issue #2383). */
export interface PrFeedbackArmedRecoveryRecord {
	recoveredAt: string;
	prHeadSha: string;
	/** Revision digest of the invalidated staged publication authorization. */
	revisionDigest: string;
	/** Gate state revision (CAS generation) at recovery time. */
	generation: number;
	reason: string;
}

/**
 * Audited armed recovery (issue #2383): the explicit, identity-correlated
 * escape for a publication-armed workflow whose exact publication cannot
 * proceed.
 *
 * Requires the exact active session (state is session-keyed; a foreign session
 * finds no armed state), workflow identity, base/head SHA, the staged
 * authorization's revision digest, and the CURRENT gate-state generation.
 * Every mismatch fails closed. There is deliberately NO `force` parameter —
 * force never bypasses identity or revision checks. Exact approved publication
 * remains available and preferred: this operation never runs when publication
 * can still proceed by the normal path.
 *
 * Order of effects, all under the session-state mutation lock with CAS:
 *   1. settle/cancel remaining lanes FIRST (fresh open lanes refuse recovery);
 *   2. append exactly ONE bounded audit event (`pr_workflow_armed_recovery`);
 *   3. invalidate the staged publication authorization;
 *   4. transition to a recoverable terminal state — the state is PRESERVED
 *      (not cleared) with a `prFeedbackArmedRecovery` marker, so validated
 *      work survives and the controller can re-arm after repair or abort
 *      cleanly.
 */
export async function recoverArmedPrWorkflow(
	directory: string,
	sessionID: string,
	request: {
		expectedMode?: PrWorkflowMode;
		prHeadSha: string;
		/** Exact merge-base SHA; REQUIRED when the active state carries one. */
		baseSha?: string;
		revisionDigest: string;
		generation: number;
		workflowInstanceId?: string;
		reason: string;
		/** Issue #2506: lane-liveness watchdog config for this settlement. */
		laneLiveness?: PrWorkflowLaneLivenessOptions;
	},
): Promise<{
	mode: PrWorkflowMode;
	prHeadSha: string;
	openLanes: number;
	settledLanes: number;
	cancelledDimensions: PrReviewBaseDimensionId[];
	recoveredAt: string;
}> {
	const sanitizedReason =
		typeof request.reason === 'string' && request.reason.trim().length > 0
			? request.reason.trim().slice(0, 500)
			: undefined;
	if (sanitizedReason === undefined) {
		throw new Error(
			'BLOCKED: armed recovery requires a non-empty reason (recorded to the audit trail).',
		);
	}
	return withSessionStateMutation(
		directory,
		normalizeSessionID(sessionID),
		async () => {
			// Deliberately NOT the salvage-tolerant recovery reader: an armed
			// recovery must verify the armed record's exact revision digest, and a
			// state too malformed to load that record fails closed here. The human
			// `/swarm abort-pr-workflow` force path remains the only exit for a
			// corrupt armed record.
			const state = await readPrWorkflowGateStateFromDisk(
				directory,
				normalizeSessionID(sessionID),
			);
			if (!state) throw noActiveGateError(sessionID);
			if (request.expectedMode && state.mode !== request.expectedMode) {
				throw wrongModeError(state, request.expectedMode);
			}
			const armed = state.prFeedbackReadyToPublish;
			if (!armed) {
				throw new Error(
					`BLOCKED: ${state.mode} is not armed for publication; armed recovery applies only to an active staged publication authorization (complete or abort normally instead).`,
				);
			}
			if (request.prHeadSha !== state.prHeadSha) {
				throw new Error(
					`BLOCKED: armed recovery head mismatch: workflow is bound to "${state.prHeadSha ?? '(none)'}", request declared "${request.prHeadSha}".`,
				);
			}
			// Exact base/head SHA binding (issue #2383): when the active state
			// carries a merge-base binding (PR_REVIEW-origin workflows), the
			// request MUST declare the exact same base SHA; a workflow without
			// one accepts only an omitted value. Either mismatch fails closed.
			if (
				(state.prReviewBaseSha === undefined) !==
				(request.baseSha === undefined)
			) {
				throw new Error(
					`BLOCKED: armed recovery base mismatch: ${
						state.prReviewBaseSha === undefined
							? 'the active workflow has no merge-base binding but the request declared one'
							: 'the active workflow is merge-base bound but the request omitted base_sha'
					}; fail closed.`,
				);
			}
			if (
				request.baseSha !== undefined &&
				state.prReviewBaseSha !== undefined &&
				request.baseSha !== state.prReviewBaseSha
			) {
				throw new Error(
					`BLOCKED: armed recovery base mismatch: workflow is merge-base bound to "${state.prReviewBaseSha}", request declared "${request.baseSha}".`,
				);
			}
			if (request.revisionDigest !== armed.revisionDigest) {
				throw new Error(
					'BLOCKED: armed recovery revision digest does not match the staged publication authorization; fail closed.',
				);
			}
			if (request.generation !== state.revision) {
				throw new Error(
					`BLOCKED: armed recovery generation mismatch: current gate generation is ${state.revision}, request declared ${request.generation}. Stale requests fail closed; re-read the workflow state and retry.`,
				);
			}
			if (
				(request.workflowInstanceId === undefined) !==
				(state.workflowInstanceId === undefined)
			) {
				throw new Error(
					'BLOCKED: armed recovery workflow identity mismatch: request and active state disagree on workflowInstanceId presence; fail closed.',
				);
			}
			if (
				request.workflowInstanceId !== undefined &&
				state.workflowInstanceId !== undefined &&
				request.workflowInstanceId !== state.workflowInstanceId
			) {
				throw new Error(
					`BLOCKED: armed recovery workflow identity mismatch: active workflow is "${state.workflowInstanceId}", request declared "${request.workflowInstanceId}".`,
				);
			}
			// 1. Cancel/settle remaining lanes FIRST — before any mutation. Fresh
			// open lanes refuse recovery (collect or settle them first); presumed
			// stale lanes settle with disclosure, exactly like abort.
			const laneSettlement = await settlePresumedStalePrWorkflowLanes(
				directory,
				state.sessionID,
				request.laneLiveness,
			);
			if (laneSettlement.openLanes > 0) {
				const laneIds = laneSettlement.openLaneIds
					.filter(Boolean)
					.slice(0, MAX_DISCLOSED_LANE_IDS)
					.join(', ');
				throw new Error(
					`BLOCKED: armed recovery refused while ${laneSettlement.openLanes} PR workflow lane(s) are still in flight (lane ids: ${laneIds}). Collect their results or let them settle before recovering.` +
						describePrWorkflowLaneProbe(laneSettlement),
				);
			}
			// PR_REVIEW-origin dimensions still unresolved after settlement are
			// explicitly cancelled so a later N-of-6 settlement can truthfully
			// report them as CANCELLED (issue #2383).
			const cancelledDimensions: PrReviewBaseDimensionId[] = [];
			let cancellations:
				| Partial<
						Record<PrReviewBaseDimensionId, PrReviewDimensionCancellationRecord>
				  >
				| undefined = state.prReviewDimensionCancellations;
			if (state.mode === 'PR_REVIEW' && state.prHeadSha) {
				const ctx = await createPrReviewGateContext(directory, state);
				const settlement = derivePrReviewDimensionSettlement(
					directory,
					state,
					ctx.revisionDigest,
				);
				for (const entry of settlement.unresolvedDimensions) {
					if (entry.terminalState !== 'NOT_LAUNCHED') continue;
					cancelledDimensions.push(entry.dimension);
					cancellations = {
						...cancellations,
						[entry.dimension]: {
							reason: sanitizedReason,
							cancelledAt: isoNow(),
							source: 'armed_recovery' as const,
						},
					};
				}
			}
			const recoveredAt = isoNow();
			// 2. Exactly ONE bounded audit event, appended BEFORE the state
			// mutation: no lane output, prompts, or secrets — bounded identity and
			// outcome fields only. Best-effort (non-fatal), same discipline as abort.
			try {
				appendCoreEventSync(directory, {
					type: 'pr_workflow_armed_recovery',
					timestamp: recoveredAt,
					sessionID: state.sessionID,
					mode: state.mode,
					prHeadSha: state.prHeadSha,
					revisionDigest: armed.revisionDigest,
					generation: state.revision,
					settledLanes: laneSettlement.presumedStaleLaneIds?.length ?? 0,
					cancelledDimensions,
					reason: sanitizedReason,
				});
			} catch {
				// Non-fatal audit trail; the recovery itself must proceed.
			}
			// 3 + 4. Invalidate the staged publication authorization and transition
			// to the recoverable terminal state, CAS-guarded: a concurrent state
			// change rejects this write and the caller revalidates.
			await writeStateWhileLocked(directory, {
				...state,
				updatedAt: recoveredAt,
				prFeedbackReadyToPublish: undefined,
				prFeedbackArmedRecovery: {
					recoveredAt,
					prHeadSha: state.prHeadSha!,
					revisionDigest: armed.revisionDigest,
					generation: state.revision,
					reason: sanitizedReason,
				},
				...(cancellations
					? { prReviewDimensionCancellations: cancellations }
					: {}),
			});
			return {
				mode: state.mode,
				prHeadSha: state.prHeadSha!,
				openLanes: laneSettlement.openLanes,
				settledLanes: laneSettlement.presumedStaleLaneIds?.length ?? 0,
				cancelledDimensions,
				recoveredAt,
			};
		},
	);
}

/** Bind an active PR workflow to one immutable PR head. */
export async function bindPrWorkflowHead(
	directory: string,
	sessionID: string,
	prHeadSha: string,
): Promise<PrWorkflowGateState> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withPrWorkflowCheckoutMutationLock(directory, async () =>
		withSessionStateMutation(directory, normalizedSessionID, async () =>
			bindPrWorkflowHeadWhileLocked(directory, normalizedSessionID, prHeadSha),
		),
	);
}

/** Bind a head while the project checkout and target session locks are held. */
async function bindPrWorkflowHeadWhileLocked(
	directory: string,
	normalizedSessionID: string,
	prHeadSha: string,
): Promise<PrWorkflowGateState> {
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	const state = await readPrWorkflowGateStateFromDisk(
		directory,
		normalizedSessionID,
	);
	if (!state) {
		throw new Error(
			`BLOCKED: no active PR workflow gate for session "${normalizedSessionID}". ` +
				'The gate must be activated before the PR head can be bound.',
		);
	}
	await assertCurrentCheckoutHead(directory, normalizedHead, state.mode);
	if (state.prHeadSha && state.prHeadSha !== normalizedHead) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow is bound to PR head "${state.prHeadSha}"; received "${normalizedHead}"`,
		);
	}
	if (!state.prHeadSha) {
		await assertPrReviewCleanCheckout(directory, state.mode);
	}
	if (!state.prHeadSha && state.mode === 'PR_FEEDBACK') {
		await assertPrFeedbackTrackingCheckout(directory, normalizedHead);
	}
	if (state.prHeadSha === normalizedHead) {
		if (state.mode === 'PR_FEEDBACK') {
			await assertPrFeedbackTrackingCheckout(directory, normalizedHead);
		}
		return state;
	}
	const nextState = {
		...state,
		prHeadSha: normalizedHead,
		// A successful bind means any pre-bind checkout diagnostic is stale.
		// Recovery abort authorization is independently bounded by settled lanes,
		// pre-publication state, kind, reason, and the audit trail.
		checkoutRecovery: undefined,
		updatedAt: isoNow(),
	};
	await _test_exports.beforePrFeedbackTrackingPersist?.();
	try {
		return await writeStateWhileLocked(directory, nextState);
	} catch (error) {
		if (!state.prHeadSha) {
			try {
				const candidates = await resolvePrFeedbackTrackingCandidatesAsync(
					directory,
					normalizedHead,
				);
				if (candidates?.local.length === 1) {
					await switchPrFeedbackTrackingCandidateAsync(
						directory,
						candidates.local[0]!,
					);
				} else if (candidates?.remote.length === 1) {
					await switchPrFeedbackTrackingCandidateAsync(
						directory,
						candidates.remote[0]!,
					);
				}
				await assertPrFeedbackTrackingCheckout(directory, normalizedHead);
			} catch {
				// Best-effort recovery only; preserve the original persistence error.
			}
		}
		throw error;
	}
}

/**
 * Controlled base-sync/rebind transition for PR_FEEDBACK (issue #2131
 * criterion C2). After a merge/rebase used to resolve base drift or conflicts,
 * the local history is no longer a direct child of the original intake head and
 * the ordinary publication path can never be satisfied. Instead of an ad-hoc
 * abort, this transition moves the immutable intake head to a NEW verified
 * remote PR head and invalidates every ancestry-bound receipt (Stage A,
 * verification batches, ordered gates), forcing the full mechanical ladder to
 * re-run against the new ancestry.
 *
 * Fail-closed semantics:
 *   1. Only an active PR_FEEDBACK gate bound to a head may rebind.
 *   2. Refuses while publication is armed — an armed gate must complete (the
 *      immutable-commit binding must not be dropped silently).
 *   3. Refuses while PR workflow lanes are in flight.
 *   4. The new head must differ from the current intake head (a no-op rebind
 *      would silently launder receipts).
 *   5. The current checkout must equal the new head, and the PR-feedback
 *      tracking-checkout discipline is re-asserted for it.
 *   6. The immutable feedback inventory is preserved (item ownership
 *      continuity); only ancestry-bound receipts are invalidated.
 */
export async function rebindPrFeedbackHead(
	directory: string,
	sessionID: string,
	prHeadSha: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	if (state.prFeedbackReadyToPublish) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK rebind is refused while publication is armed; complete the workflow (or push the bound commit) before rebinding.',
		);
	}
	const openLanes = readDelegations(directory).filter(
		(record) =>
			record.parentSessionId === state.sessionID &&
			record.mode?.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	);
	if (openLanes.length > 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK rebind refused while ${openLanes.length} PR workflow lane(s) are still in flight; collect their results first.`,
		);
	}
	if (normalizedHead === state.prHeadSha) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK rebind to the current intake head "${normalizedHead}" is a no-op; a rebind must move to a genuinely new verified PR head after merge/rebase repair.`,
		);
	}
	await assertCurrentCheckoutHead(directory, normalizedHead, state.mode);
	await assertPrFeedbackTrackingCheckout(directory, normalizedHead);
	const nextState: PrWorkflowGateState = {
		...state,
		prHeadSha: normalizedHead,
		// Invalidate every ancestry-bound receipt: the entire mechanical ladder
		// (Stage A → verification → ordered gates) must re-run on the new
		// ancestry. The immutable inventory and retired item ownership survive
		// so item-set continuity is preserved across the repair.
		prFeedbackStageA: undefined,
		prFeedbackVerifications: undefined,
		prFeedbackGateBatches: undefined,
		prFeedbackRebindCount: (state.prFeedbackRebindCount ?? 0) + 1,
		updatedAt: isoNow(),
	};
	try {
		appendCoreEventSync(directory, {
			type: 'pr_feedback_rebound',
			timestamp: isoNow(),
			sessionID: state.sessionID,
			previousPrHeadSha: state.prHeadSha,
			prHeadSha: normalizedHead,
			rebindCount: nextState.prFeedbackRebindCount,
		});
	} catch {
		// Non-fatal audit trail.
	}
	return withSessionStateMutation(directory, state.sessionID, async () =>
		writeStateWhileLocked(directory, nextState),
	);
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
	mode: PrWorkflowMode = 'PR_REVIEW',
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
				`Verify with two separate standalone commands. First run: git -C "${directory}" rev-parse --verify HEAD^0. Then run: git -C "${directory}" cat-file -t HEAD (which must print commit).`,
		);
	}
	if (currentHead.toLowerCase() !== normalizedExpected.toLowerCase()) {
		// Remediation must use the bare, standalone form the read-only shell
		// classifier actually accepts: `git -C ... switch` is banned as a state
		// transition (see isAllowedPrWorkflowReadOnlyShell), so instructing it
		// here contradicted the gate and left callers stuck (#1931 follow-up).
		const remediation =
			mode === 'PR_FEEDBACK'
				? 'Check out the intended local tracking branch at that exact head (for example with a safe standalone `gh pr checkout <number-or-url>` or `git switch -c <local> --track <remote>/<branch>`), then retry the bind. Do not create a new detached feedback checkout.'
				: `Run bare, standalone commands from that directory. If the commit is not present locally, first run \`git fetch origin <pr-head-ref>\`. Then run \`git switch --detach ${normalizedExpected}\`. Do not prefix the switch with \`git -C\`; the read-only shell classifier refuses \`git -C ... switch\`.`;
		throw new Error(
			`BLOCKED: current checkout HEAD "${currentHead}" does not match PR head "${normalizedExpected}" ` +
				`(working directory: "${directory}"). ${remediation}`,
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
	const currentHead = (
		await _test_exports.resolveCurrentGitHeadAsync(directory)
	)?.trim();
	if (!currentHead) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires a resolved exact Git HEAD before first head bind',
		);
	}
	if (currentHead.toLowerCase() !== prHeadSha.toLowerCase()) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK exact head changed before attach; expected ${prHeadSha}, received ${currentHead}`,
		);
	}
	const currentUpstream =
		await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
	const matchingRemoteRefs =
		await _test_exports.resolveRemoteRefsContainingHeadAsync(
			directory,
			prHeadSha,
		);
	if (currentUpstream) {
		if (matchingRemoteRefs === null) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK could not verify the current upstream against the exact intake PR head; the bounded Git query failed or timed out',
			);
		}
		if (matchingRemoteRefs.includes(currentUpstream.remoteTrackingRef)) return;
		throw new Error(
			`BLOCKED: PR_FEEDBACK current upstream "${currentUpstream.remoteTrackingRef}" must point to the exact intake PR head "${prHeadSha}"; refusing to replace an existing tracking relationship`,
		);
	}
	const candidates = await resolvePrFeedbackTrackingCandidatesAsync(
		directory,
		prHeadSha,
	);
	if (!candidates) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK could not inspect tracked branches for exact PR head "${prHeadSha}"; the bounded Git query failed or timed out`,
		);
	}
	const { local: localCandidates, remote: remoteCandidates } = candidates;
	if (localCandidates.length === 1) {
		await _test_exports.beforePrFeedbackTrackingSwitch?.();
		if (
			!(await switchPrFeedbackTrackingCandidateAsync(
				directory,
				localCandidates[0]!,
			))
		) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK could not attach exact local tracked branch "${localCandidates[0]!.branchName}"; it may be checked out in another linked worktree or the bounded Git switch failed`,
			);
		}
	} else if (localCandidates.length > 1) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK exact head "${prHeadSha}" matches multiple local tracked branches: ${localCandidates
				.map((candidate) => candidate.branchName)
				.join(', ')}`,
		);
	} else {
		if (remoteCandidates.length === 1) {
			await _test_exports.beforePrFeedbackTrackingSwitch?.();
			if (
				!(await switchPrFeedbackTrackingCandidateAsync(
					directory,
					remoteCandidates[0]!,
				))
			) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK could not attach exact remote-tracking branch "${remoteCandidates[0]!.remoteTrackingRef}"; the bounded Git switch failed or timed out`,
				);
			}
		} else if (remoteCandidates.length > 1) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK exact head "${prHeadSha}" matches multiple remote-tracking refs: ${remoteCandidates
					.map((candidate) => candidate.remoteTrackingRef)
					.join(', ')}`,
			);
		} else {
			throw new Error(
				'BLOCKED: PR_FEEDBACK requires a current local branch or exact remote-tracking ref that points to the intake PR head before the first bind',
			);
		}
	}
	await _test_exports.afterPrFeedbackTrackingSwitch?.();
	const attachedHead = (
		await _test_exports.resolveCurrentGitHeadAsync(directory)
	)?.trim();
	if (attachedHead?.toLowerCase() !== prHeadSha.toLowerCase()) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK exact head changed after attach; expected ${prHeadSha}, received ${attachedHead ?? '(unresolved)'}`,
		);
	}
	if (
		(await _test_exports.resolveIsWorkingTreeCleanAsync(directory)) !== true
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires a clean working tree after checkout attachment',
		);
	}
	const attachedUpstream =
		await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
	if (!attachedUpstream) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK could not resolve the attached branch upstream after checkout promotion',
		);
	}
	const attachedRemoteRefs =
		await _test_exports.resolveRemoteRefsContainingHeadAsync(
			directory,
			prHeadSha,
		);
	if (!attachedRemoteRefs?.includes(attachedUpstream.remoteTrackingRef)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK upstream "${attachedUpstream.remoteTrackingRef}" must point to the exact intake PR head "${prHeadSha}" before the first head bind`,
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

export class PrReviewResilienceCircuitOpenError extends Error {
	readonly code = 'PR_REVIEW_RESILIENCE_CIRCUIT_OPEN' as const;

	constructor(message: string) {
		super(message);
		this.name = 'PrReviewResilienceCircuitOpenError';
	}
}

export class PrReviewResilienceRetryExhaustedError extends Error {
	readonly code = 'PR_REVIEW_RESILIENCE_RETRY_EXHAUSTED' as const;

	constructor(message: string) {
		super(message);
		this.name = 'PrReviewResilienceRetryExhaustedError';
	}
}

/**
 * Issue #2385: the policy snapshot lives in `src/pr-review/circuit.ts`
 * (`resolvePrReviewResiliencePolicy`) with every default sourced from
 * `DEFAULT_PR_REVIEW_RESILIENCE_CONFIG`. This local name is kept (callers and
 * the `_test_exports` seam) and delegates to the single authority.
 */
const snapshotPrReviewResiliencePolicy = resolvePrReviewResiliencePolicy;

function declaredBaseDimensions(
	lanes: readonly PrWorkflowLaneSpec[],
): PrReviewBaseDimensionId[] {
	return lanes.flatMap(
		(lane) =>
			(lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane]) as PrReviewBaseDimensionId[],
	);
}

function exactDimensionPartition(
	actual: readonly PrReviewBaseDimensionId[],
	expected: readonly PrReviewBaseDimensionId[],
): boolean {
	return (
		actual.length === expected.length &&
		new Set(actual).size === expected.length &&
		expected.every((dimension) => actual.includes(dimension))
	);
}

function latestDelegationRecord(
	records: readonly BackgroundDelegationRecord[],
): BackgroundDelegationRecord | null {
	const sorted = [...records].sort((left, right) => {
		const leftKey = left.completedAt ?? left.updatedAt ?? left.createdAt;
		const rightKey = right.completedAt ?? right.updatedAt ?? right.createdAt;
		return rightKey - leftKey;
	});
	return sorted[0] ?? null;
}

function batchLaneRecords(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	laneId: string,
): BackgroundDelegationRecord[] {
	return findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	}).filter((record) => record.laneId === laneId);
}

function batchIsTerminal(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
): boolean {
	const records = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	});
	return (
		records.length > 0 &&
		records.every(
			(record) =>
				TERMINAL_FAILED_DELEGATION_STATUSES.has(record.status) ||
				record.status === 'consumed',
		)
	);
}

function effectivePrReviewResiliencePolicy(
	state: PrWorkflowGateState,
	requestedPolicy?: PrReviewResilienceConfig,
): PrReviewResiliencePolicyRecord {
	return (
		state.prReviewResilience?.policy ??
		snapshotPrReviewResiliencePolicy(requestedPolicy)
	);
}

// ---------------------------------------------------------------------------
// PR-review resilience circuit (issue #2382) — typed, recoverable, versioned.
// Classification, adoption/migration, and the CLOSED/OPEN/HALF_OPEN machine
// live in `src/pr-review/circuit.ts` (pure, unit-tested); this file
// owns the durable reads (delegation ledger), the CAS persistence, and the
// enforcement wiring.
// ---------------------------------------------------------------------------

/** Bounded malformed-circuit diagnostic dedup: hash-keyed, FIFO-evicted. */
const MALFORMED_CIRCUIT_DIAGNOSTIC_LIMIT = 64;
const malformedCircuitDiagnosticsSeen = new Set<string>();

function reportCircuitAdoptionDiagnostic(
	diagnostic: PrReviewCircuitAdoptionDiagnostic,
): void {
	if (diagnostic.code === 'migrated_legacy_circuit') {
		log(
			'PR review resilience circuit: migrated unversioned legacy circuit record to v2 CLOSED (nonblocking, evidence waterlined)',
			{ legacyContributors: diagnostic.legacySignatureCount },
		);
		return;
	}
	if (malformedCircuitDiagnosticsSeen.has(diagnostic.bodyHash8)) return;
	if (
		malformedCircuitDiagnosticsSeen.size >= MALFORMED_CIRCUIT_DIAGNOSTIC_LIMIT
	) {
		const oldest = malformedCircuitDiagnosticsSeen.values().next().value;
		if (oldest !== undefined) {
			malformedCircuitDiagnosticsSeen.delete(oldest);
		}
	}
	malformedCircuitDiagnosticsSeen.add(diagnostic.bodyHash8);
	log(
		'PR review resilience circuit: malformed circuit record dropped (fail-open)',
		{
			bodyHash8: diagnostic.bodyHash8,
			byteLength: diagnostic.byteLength,
		},
	);
}

function circuitOpenDurationMs(policy: PrReviewResiliencePolicyRecord): number {
	return (
		policy.circuitOpenDurationMs ??
		DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.circuit_open_duration_ms
	);
}

/** Latest-record typed signal for every recorded dispatch lane. */
function laneSignalsForCircuitReview(
	directory: string,
	state: PrWorkflowGateState,
): PrReviewCircuitSignal[] {
	const signals: PrReviewCircuitSignal[] = [];
	for (const batch of state.prReviewBaseDispatches ?? []) {
		for (const lane of batch.lanes) {
			const latest = latestDelegationRecord(
				batchLaneRecords(directory, state, batch.batchId, lane.laneId),
			);
			if (!latest) continue;
			const signal = classifyPrReviewCircuitSignal(latest);
			if (signal) signals.push(signal);
		}
	}
	return signals;
}

/**
 * Observation of the CURRENT probe lane's latest record. Supplied only for a
 * HALF_OPEN circuit whose recorded probe matches the lane actually read, which
 * structurally drops late results from older generations.
 */
function probeObservationForCircuit(
	directory: string,
	state: PrWorkflowGateState,
	circuit: PrReviewCircuitRecordV2,
):
	| {
			terminalStatus: string;
			signal: PrReviewCircuitSignal | null;
			terminalAtMs: number;
	  }
	| undefined {
	if (circuit.state !== 'HALF_OPEN' || !circuit.probe) return undefined;
	const latest = latestDelegationRecord(
		batchLaneRecords(
			directory,
			state,
			circuit.probe.batchId,
			circuit.probe.laneId,
		),
	);
	if (!latest) return undefined;
	if (!TERMINAL_FAILED_DELEGATION_STATUSES.has(latest.status)) return undefined;
	return {
		terminalStatus: latest.status,
		signal: classifyPrReviewCircuitSignal(latest),
		terminalAtMs:
			latest.terminalResult?.recordedAt ??
			latest.completedAt ??
			latest.updatedAt ??
			latest.createdAt ??
			0,
	};
}

function formatPrReviewResilienceCircuitOpenMessage(
	circuit: PrReviewResilienceCircuitRecord | undefined,
	nowMs: number = Date.now(),
): string {
	// Issue #2385: an absent circuit record must not be replaced by a
	// synthetic inline construction here (parallel-rule guardrail); the
	// message degrades truthfully instead.
	if (!circuit) {
		return 'BLOCKED: PR_REVIEW resilience retry circuit is open; collect, diagnose, cancel, abort, gap reporting, and config disable remain available';
	}
	if ('version' in circuit) {
		const openUntilMs = circuit.openUntil ? Date.parse(circuit.openUntil) : 0;
		const remainingMs = Math.max(0, openUntilMs - nowMs);
		const retryNote =
			remainingMs > 0
				? `the recovery canary probe is admitted in about ${Math.ceil(remainingMs / 1000)}s`
				: 'the next staged dispatch is admitted as the recovery canary probe';
		return `BLOCKED: PR_REVIEW resilience retry circuit is ${circuit.state} after ${circuit.contributors.length} distinct terminal provider failures (${circuit.providerClass ?? 'provider'}); ${retryNote}; collect, diagnose, cancel, abort, gap reporting, and config disable remain available`;
	}
	// Issue #2385 recurrence sweep (class G): the legacy-record branch must
	// carry the SAME guidance as the v2 branch — collect every launched lane
	// and settle N-of-6 truthfully; "stop without partial findings" discarded
	// validated work and contradicts the current policy.
	return `BLOCKED: PR_REVIEW base dispatch circuit is open after ${circuit.count} correlated terminal failures (${circuit.signature}); collect every launched lane, then settle coverage truthfully (COMPLETE/PARTIAL/NO_COVERAGE) via complete_pr_workflow`;
}

interface PrReviewResilienceCircuitAdvanceOutcome {
	state: PrWorkflowGateState;
	snapshot: PrReviewResilienceStateRecord;
	/**
	 * Set ONLY for an admitted HALF_OPEN probe transition: the circuit record is
	 * persisted together with the successful admission's state write
	 * (mark-on-success), so a validation failure never leaves a phantom probe.
	 */
	pendingProbeCircuit?: PrReviewCircuitRecordV2;
	blocked?: { reason: 'circuit_open' | 'probe_in_flight' };
}

/**
 * Adopt the persisted circuit (v2 pass-through, legacy migration with a
 * bounded diagnostic, malformed fail-open), advance the machine one step, and
 * persist evidence-driven transitions under the enforcement lock. Runs inside
 * `withSessionStateMutation` only.
 */
async function advanceResilienceCircuitWhileLocked(args: {
	directory: string;
	state: PrWorkflowGateState;
	snapshot: PrReviewResilienceStateRecord;
	admission?: { batchId: string; laneId: string };
}): Promise<PrReviewResilienceCircuitAdvanceOutcome> {
	const { directory } = args;
	let state = args.state;
	let snapshot = args.snapshot;

	// Adoption. A malformed record is dropped IN MEMORY only — the broken bytes
	// stay on disk for forensics until a legitimate full-state write replaces
	// them. A legacy record migrates once to a nonblocking v2 CLOSED record and
	// that migration persists immediately (it must never stay blocking).
	const nowMs = _test_exports.nowMs();
	const adoption = adoptPrReviewCircuit(snapshot.circuit, nowMs);
	let circuit: PrReviewCircuitRecordV2 | null = null;
	if (adoption.kind === 'v2') {
		circuit = adoption.record;
	} else if (adoption.kind === 'migrated') {
		circuit = adoption.record;
		snapshot = { ...snapshot, circuit: adoption.record };
		state = await writeStateWhileLocked(directory, {
			...state,
			updatedAt: isoNow(),
			prReviewResilience: snapshot,
		});
		reportCircuitAdoptionDiagnostic(adoption.diagnostic);
	} else if (adoption.kind === 'malformed') {
		const withoutCircuit: PrReviewResilienceStateRecord = { ...snapshot };
		withoutCircuit.circuit = undefined;
		snapshot = withoutCircuit;
		reportCircuitAdoptionDiagnostic(adoption.diagnostic);
	}

	// Issue #2385 (final-critic finding 1): the circuit TRANSITION is
	// reducer-owned. This adapter emits `circuit_advance_requested` (the
	// reducer re-adopts the already-migrated circuit idempotently and runs
	// the machine), applies the returned state, and executes the returned
	// effects: `persist_state` writes now; `block_dispatch` maps to the
	// typed admission refusal; an admitted HALF_OPEN probe carries NO
	// persist effect (mark-on-success: the admission's own write persists
	// it, so a validation failure never leaves a phantom probe).
	const advanceOutcome = reducePrReviewEvent(state, {
		type: 'circuit_advance_requested',
		nowMs,
		laneSignals: laneSignalsForCircuitReview(directory, state),
		probeObservation:
			circuit?.state === 'HALF_OPEN'
				? probeObservationForCircuit(directory, state, circuit)
				: undefined,
		admission: args.admission,
		policy: snapshot.policy,
	});
	if (advanceOutcome.status === 'rejected') {
		// circuit_advance_requested has no rejection path; fail soft to the
		// pre-transition view rather than blocking the workflow.
		return { state, snapshot };
	}
	const nextState = advanceOutcome.state as PrWorkflowGateState;
	const blockedReason = advanceOutcome.effects.find(
		(effect): effect is Extract<PrReviewEffect, { kind: 'block_dispatch' }> =>
			effect.kind === 'block_dispatch',
	)?.reason;
	if (
		advanceOutcome.effects.some((effect) => effect.kind === 'persist_state')
	) {
		snapshot = {
			...snapshot,
			circuit: nextState.prReviewResilience?.circuit,
		};
		state = await writeStateWhileLocked(directory, {
			...nextState,
			updatedAt: isoNow(),
			prReviewResilience: snapshot,
		});
	} else {
		state = nextState;
	}
	if (blockedReason !== undefined) {
		return { state, snapshot, blocked: { reason: blockedReason } };
	}
	const pendingProbe = nextState.prReviewResilience?.circuit;
	if (
		pendingProbe &&
		'version' in pendingProbe &&
		pendingProbe.state === 'HALF_OPEN' &&
		pendingProbe.probe
	) {
		return { state, snapshot, pendingProbeCircuit: pendingProbe };
	}
	return { state, snapshot };
}

async function preflightPrReviewResilienceCircuitBeforePrune(
	directory: string,
	state: PrWorkflowGateState,
	previous: PrReviewBaseDispatchRecord[],
	policy: PrReviewResiliencePolicyRecord,
	liveResilienceEnabled: boolean,
): Promise<{
	state: PrWorkflowGateState;
	previous: PrReviewBaseDispatchRecord[];
}> {
	let nextState: PrWorkflowGateState = state;
	let nextPrevious = previous;
	let snapshot = nextState.prReviewResilience;
	if (!snapshot) {
		snapshot = { policy, attempts: [] };
		if (nextPrevious.length > 0) {
			nextState = await writeStateWhileLocked(directory, {
				...nextState,
				updatedAt: isoNow(),
				prReviewResilience: snapshot,
			});
			nextPrevious = nextState.prReviewBaseDispatches ?? [];
			snapshot = nextState.prReviewResilience ?? snapshot;
		}
	}
	// Issue #2382: the CURRENT config's `enabled` flag is authoritative. While
	// disabled the circuit is fully inert — no transition, no block, no prune
	// gating — and the persisted record (if any) is preserved for audit.
	if (!liveResilienceEnabled) {
		return { state: nextState, previous: nextPrevious };
	}
	const outcome = await advanceResilienceCircuitWhileLocked({
		directory,
		state: nextState,
		snapshot,
	});
	if (outcome.blocked) {
		throw new PrReviewResilienceCircuitOpenError(
			formatPrReviewResilienceCircuitOpenMessage(outcome.snapshot.circuit),
		);
	}
	return {
		state: outcome.state,
		previous: outcome.state.prReviewBaseDispatches ?? nextPrevious,
	};
}

async function probeResilienceCanaryLiveness(
	directory: string,
	records: readonly BackgroundDelegationRecord[],
	timeoutMs: number,
): Promise<{ live: boolean; reason?: string }> {
	const session = _test_exports.getSessionOps();
	const status = session?.status;
	if (!session || typeof status !== 'function') {
		return { live: false, reason: 'status probe unavailable' };
	}
	const timeoutError = new Error(
		'PR workflow resilience canary probe exceeded its deadline',
	);
	let response: Awaited<ReturnType<NonNullable<typeof status>>> | undefined;
	try {
		response = await withTimeout(
			(async () => status.call(session, { query: { directory } }))(),
			timeoutMs,
			timeoutError,
		);
	} catch (error) {
		return {
			live: false,
			reason:
				error === timeoutError
					? 'status probe timed out'
					: 'status probe failed',
		};
	}
	if (response?.error) return { live: false, reason: 'status probe errored' };
	if (!response?.data)
		return { live: false, reason: 'status probe returned no data' };
	for (const record of records) {
		const type = response.data[record.subagentSessionId]?.type;
		if (type === 'busy' || type === 'retry') return { live: true };
	}
	return { live: false, reason: 'status probe did not report busy/retry' };
}

async function evaluatePrReviewResilienceAttempt(
	directory: string,
	state: PrWorkflowGateState,
	attempt: PrReviewResilienceAttemptRecord,
	revisionDigest: string,
	policy: PrReviewResiliencePolicyRecord,
): Promise<{
	remaining: PrReviewBaseDimensionId[];
	inFlight: PrReviewBaseDimensionId[];
	canaryState: 'success' | 'failed' | 'live' | 'waiting';
	reason?: string;
	fanoutSettled: boolean;
}> {
	const attempts = summarizePrReviewBaseDimensionAttempts(
		directory,
		state,
		revisionDigest,
	);
	const remaining = attempt.targetDimensions.filter(
		(dimension) =>
			!attempts.successful.has(dimension) && !attempts.inFlight.has(dimension),
	);
	const inFlight = attempt.targetDimensions.filter((dimension) =>
		attempts.inFlight.has(dimension),
	);
	if (remaining.length === 0 && inFlight.length === 0) {
		return {
			remaining: [],
			inFlight: [],
			canaryState: 'success',
			fanoutSettled: Boolean(attempt.fanoutBatchId),
		};
	}
	if (attempts.successful.has(attempt.canaryWorkflowLane)) {
		return {
			remaining,
			inFlight,
			canaryState: 'success',
			fanoutSettled: attempt.fanoutBatchId
				? batchIsTerminal(directory, state, attempt.fanoutBatchId)
				: false,
		};
	}
	const canaryRecords = batchLaneRecords(
		directory,
		state,
		attempt.canaryBatchId,
		attempt.canaryLaneId,
	);
	if (
		canaryRecords.length > 0 &&
		canaryRecords.every((record) =>
			TERMINAL_FAILED_DELEGATION_STATUSES.has(record.status),
		)
	) {
		return { remaining, inFlight, canaryState: 'failed', fanoutSettled: false };
	}
	const admittedAtMs = Date.parse(attempt.admittedAt);
	if (
		Number.isFinite(admittedAtMs) &&
		_test_exports.nowMs() - admittedAtMs < policy.canaryProbeMs
	) {
		return {
			remaining,
			inFlight,
			canaryState: 'waiting',
			reason: 'canary probe horizon has not elapsed yet',
			fanoutSettled: false,
		};
	}
	const probe = await probeResilienceCanaryLiveness(
		directory,
		canaryRecords,
		policy.statusProbeTimeoutMs,
	);
	if (probe.live) {
		return { remaining, inFlight, canaryState: 'live', fanoutSettled: false };
	}
	return {
		remaining,
		inFlight,
		canaryState: 'waiting',
		reason: probe.reason,
		fanoutSettled: false,
	};
}

function unresolvedPrReviewBaseDimensions(
	attempts: Pick<PrReviewBaseDimensionAttempts, 'successful' | 'inFlight'>,
): PrReviewBaseDimensionId[] {
	return PR_REVIEW_BASE_DIMENSION_IDS.filter(
		(dimension) =>
			!attempts.successful.has(dimension) && !attempts.inFlight.has(dimension),
	) as PrReviewBaseDimensionId[];
}

interface EnforcePrReviewBaseDimensionsOptions {
	batchId: string;
	prHeadSha: string;
	revisionDigest?: string;
	prReviewContractRetry?: boolean;
	prReviewWaveStage?: 'canary' | 'fanout';
	prReviewWaveAttempt?: 0 | 1 | 2;
	prReviewResiliencePolicy?: PrReviewResilienceConfig;
}

export async function enforcePrReviewBaseDimensions(
	directory: string,
	sessionID: string,
	lanes: readonly PrWorkflowLaneSpec[],
	options: EnforcePrReviewBaseDimensionsOptions,
): Promise<PrWorkflowGateState> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withPrWorkflowCheckoutMutationLock(directory, async () =>
		withSessionStateMutation(directory, normalizedSessionID, async () =>
			enforcePrReviewBaseDimensionsWhileLocked(
				directory,
				normalizedSessionID,
				lanes,
				options,
			),
		),
	);
}

async function enforcePrReviewBaseDimensionsWhileLocked(
	directory: string,
	normalizedSessionID: string,
	lanes: readonly PrWorkflowLaneSpec[],
	options: EnforcePrReviewBaseDimensionsOptions,
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHeadWhileLocked(
		directory,
		normalizedSessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_REVIEW') {
		throw wrongModeError(state, 'PR_REVIEW');
	}
	const normalizedLanes = normalizeWorkflowLanes(lanes);
	const claimedDimensionIds = declaredBaseDimensions(normalizedLanes);
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
	if (
		(state.prReviewDepthTier ?? 'L') === 'L' &&
		normalizedLanes.some((lane) => (lane.ownedWorkflowLanes?.length ?? 1) !== 1)
	) {
		const rejection = await tierLConsolidationRejection(
			directory,
			state,
			normalizedLanes,
			options.revisionDigest,
		);
		if (rejection) {
			throw new Error(
				'BLOCKED: PR_REVIEW base dispatch at depth tier L requires one dedicated lane per dimension; ' +
					'consolidated owned_workflow_lanes are allowed only at tiers S and M, or on a retry batch that ' +
					'satisfies all five of: (1) every consolidated dimension already has a recorded lane that ' +
					'reached a terminal non-successful state; (2) no consolidated dimension already has a ' +
					`successful source; (3) no single lane owns all ${PR_REVIEW_BASE_DIMENSION_IDS.length} ` +
					`dimensions; (4) a batch claiming all ${PR_REVIEW_BASE_DIMENSION_IDS.length} dimensions uses ` +
					`at least ${PR_REVIEW_BASE_LANE_FLOORS.L} lanes; and (5) across every recorded base batch the ` +
					`six dimensions stay backed by at least ${PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR} distinct ` +
					'lanes, counting each dimension no consolidated lane claims as one plus the FEWEST declared ' +
					'consolidated lanes that suffice to cover every dimension consolidated lanes do claim. ' +
					'Clause 5 is cumulative over every base batch this wave recorded, including batches the ' +
					'capacity GC has since dropped, and it counts a minimum cover rather than declarations — so ' +
					'neither splitting one consolidation across several batches nor declaring overlapping or ' +
					'duplicate consolidations evades it. ' +
					rejection,
			);
		}
	}
	const batchId = normalizeBatchId(options.batchId);
	let previous = state.prReviewBaseDispatches ?? [];
	if (previous.some((record) => record.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_REVIEW base batch id "${batchId}" is already recorded`,
		);
	}
	const depthTier = state.prReviewDepthTier ?? 'L';
	const requestedContractRetry = options.prReviewContractRetry === true;
	const requestedWaveStage = options.prReviewWaveStage;
	const requestedWaveAttempt = options.prReviewWaveAttempt;
	if (
		requestedContractRetry &&
		(requestedWaveStage !== undefined || requestedWaveAttempt !== undefined)
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW contract retry is mutually exclusive with pr_review_wave_stage and pr_review_wave_attempt',
		);
	}
	if (
		(requestedWaveStage === undefined) !==
		(requestedWaveAttempt === undefined)
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW staged base dispatch requires both pr_review_wave_stage and pr_review_wave_attempt together',
		);
	}
	const resiliencePolicy = effectivePrReviewResiliencePolicy(
		state,
		options.prReviewResiliencePolicy,
	);
	// Issue #2382: the CURRENT config's `enabled` flag is authoritative for
	// gating decisions; the persisted snapshot only carries numeric knobs.
	const liveResilienceEnabled =
		options.prReviewResiliencePolicy?.enabled ??
		DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.enabled;
	if (
		previous.length >= MAX_WORKFLOW_BATCHES &&
		requestedWaveStage !== undefined &&
		requestedWaveAttempt !== undefined &&
		depthTier !== 'S' &&
		liveResilienceEnabled
	) {
		({ state, previous } = await preflightPrReviewResilienceCircuitBeforePrune(
			directory,
			state,
			previous,
			resiliencePolicy,
			liveResilienceEnabled,
		));
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		state = await prunePrWorkflowBatchesForCapacity(
			directory,
			state,
			options.revisionDigest,
		);
		previous = state.prReviewBaseDispatches ?? [];
		if (previous.length >= MAX_WORKFLOW_BATCHES) {
			throw new Error('BLOCKED: PR_REVIEW base batch limit reached');
		}
	}
	let nextResilience = state.prReviewResilience;
	if (!nextResilience) {
		nextResilience = { policy: resiliencePolicy, attempts: [] };
		if (previous.length > 0) {
			state = await writeStateWhileLocked(directory, {
				...state,
				updatedAt: isoNow(),
				prReviewResilience: nextResilience,
			});
			previous = state.prReviewBaseDispatches ?? [];
		}
	}
	// Issue #2382 live-disable semantics. While the CURRENT config disables
	// resilience, the circuit is inert: nothing blocks, nothing transitions, and
	// one guarded audit write marks the persisted policy disabled (detection
	// anchor; the record itself stays for audit). On the next enforcement with
	// resilience re-enabled, the whole record resets in ONE CAS write — fresh
	// v2 CLOSED generation, evidence waterline at now, attempts cleared, policy
	// refreshed from the current config — so pre-disable evidence can never
	// resurrect.
	//
	// Issue #2385: both transitions are REDUCER-OWNED — this adapter emits
	// `resilience_config_changed`, applies the returned state, and executes
	// the `persist_state` effect. No inline resilience-field mutation remains.
	if (
		nextResilience &&
		(!liveResilienceEnabled || nextResilience.policy.enabled === false)
	) {
		const configEvent: PrReviewEvent = {
			type: 'resilience_config_changed',
			enabled: liveResilienceEnabled,
			policy: liveResilienceEnabled
				? options.prReviewResiliencePolicy
				: undefined,
			nowMs: _test_exports.nowMs(),
		};
		const outcome = reducePrReviewEvent(state, configEvent);
		if (
			outcome.status === 'applied' &&
			outcome.effects.some((effect) => effect.kind === 'persist_state')
		) {
			state = await writeStateWhileLocked(directory, {
				...(outcome.state as PrWorkflowGateState),
				updatedAt: isoNow(),
			});
			previous = state.prReviewBaseDispatches ?? [];
			nextResilience = state.prReviewResilience ?? nextResilience;
		}
	}
	if (
		liveResilienceEnabled &&
		depthTier !== 'S' &&
		requestedWaveStage === undefined &&
		!requestedContractRetry
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW base dispatch at depth tier M or L requires canary-first staged admission while pr_review_resilience is enabled',
		);
	}
	if (requestedWaveStage !== undefined && requestedWaveAttempt !== undefined) {
		if (depthTier === 'S' || !liveResilienceEnabled) {
			throw new Error(
				'BLOCKED: staged PR_REVIEW base dispatch is valid only when pr_review_resilience is enabled at depth tier M or L',
			);
		}
		let revisionDigest = options.revisionDigest;
		if (!revisionDigest) {
			revisionDigest = (await createPrReviewGateContext(directory, state))
				.revisionDigest;
		}
		let snapshot = nextResilience ?? {
			policy: resiliencePolicy,
			attempts: [],
		};
		// Issue #2382: one machine advance per staged admission. Evidence-driven
		// transitions persist immediately (inside the advance helper); an admitted
		// HALF_OPEN probe defers its persist to this admission's success write
		// (mark-on-success), so a validation failure below never leaves a phantom
		// probe. `snapshot` is refreshed to the post-advance record so the
		// attempt bookkeeping below reads the same state the machine left.
		let pendingProbeCircuit: PrReviewCircuitRecordV2 | undefined;
		if (liveResilienceEnabled) {
			const outcome = await advanceResilienceCircuitWhileLocked({
				directory,
				state,
				snapshot,
				admission: {
					batchId,
					laneId: normalizedLanes[0]?.laneId ?? '',
				},
			});
			state = outcome.state;
			snapshot = outcome.snapshot;
			nextResilience = outcome.snapshot;
			pendingProbeCircuit = outcome.pendingProbeCircuit;
			if (outcome.blocked) {
				throw new PrReviewResilienceCircuitOpenError(
					formatPrReviewResilienceCircuitOpenMessage(outcome.snapshot.circuit),
				);
			}
		}
		const lastAttempt = snapshot.attempts.at(-1);
		if (requestedWaveStage === 'canary') {
			let target = [
				...PR_REVIEW_BASE_DIMENSION_IDS,
			] as PrReviewBaseDimensionId[];
			let expectedAttempt: 0 | 1 | 2 = 0;
			let globalInFlight: PrReviewBaseDimensionId[] = [];
			if (lastAttempt) {
				const globalAttempts = summarizePrReviewBaseDimensionAttempts(
					directory,
					state,
					revisionDigest,
				);
				globalInFlight = PR_REVIEW_BASE_DIMENSION_IDS.filter((dimension) =>
					globalAttempts.inFlight.has(dimension),
				) as PrReviewBaseDimensionId[];
				const globalTarget = unresolvedPrReviewBaseDimensions(globalAttempts);
				const evaluated = await evaluatePrReviewResilienceAttempt(
					directory,
					state,
					lastAttempt,
					revisionDigest,
					snapshot.policy,
				);
				if (!lastAttempt.fanoutBatchId) {
					if (evaluated.canaryState === 'success') {
						if (evaluated.remaining.length > 0) {
							throw new Error(
								`BLOCKED: PR_REVIEW base attempt ${lastAttempt.attempt} requires its fanout batch before a later retry attempt`,
							);
						}
						if (globalTarget.length === 0) {
							throw new PrReviewResilienceRetryExhaustedError(
								'BLOCKED: PR_REVIEW base dispatch has no unresolved obligations remaining',
							);
						}
						target = [...globalTarget];
					} else {
						if (evaluated.canaryState === 'live') {
							throw new Error(
								`BLOCKED: PR_REVIEW base attempt ${lastAttempt.attempt} canary is still live; fanout is the next admissible stage`,
							);
						}
						if (evaluated.canaryState === 'waiting') {
							throw new Error(
								`BLOCKED: PR_REVIEW base attempt ${lastAttempt.attempt} canary is not yet proven successful or live: ${evaluated.reason ?? 'probe failed closed'}`,
							);
						}
						target = [...globalTarget];
					}
				} else {
					if (!batchIsTerminal(directory, state, lastAttempt.fanoutBatchId)) {
						throw new Error(
							`BLOCKED: PR_REVIEW base attempt ${lastAttempt.attempt} fanout is still in flight`,
						);
					}
					target = [...globalTarget];
				}
				expectedAttempt = (lastAttempt.attempt + 1) as 0 | 1 | 2;
			} else if (previous.length > 0) {
				const globalAttempts = summarizePrReviewBaseDimensionAttempts(
					directory,
					state,
					revisionDigest,
				);
				globalInFlight = PR_REVIEW_BASE_DIMENSION_IDS.filter((dimension) =>
					globalAttempts.inFlight.has(dimension),
				) as PrReviewBaseDimensionId[];
				target = unresolvedPrReviewBaseDimensions(globalAttempts);
			}
			if (target.length === 0) {
				if (globalInFlight.length > 0) {
					throw new Error(
						lastAttempt
							? `BLOCKED: PR_REVIEW base attempt ${lastAttempt.attempt} still has in-flight obligations that cannot be retried yet: ${globalInFlight.join(', ')}`
							: `BLOCKED: PR_REVIEW base still has in-flight obligations that cannot be retried yet: ${globalInFlight.join(', ')}`,
					);
				}
				throw new PrReviewResilienceRetryExhaustedError(
					'BLOCKED: PR_REVIEW base dispatch has no unresolved obligations remaining',
				);
			}
			if (
				requestedWaveAttempt !== expectedAttempt ||
				requestedWaveAttempt > snapshot.policy.maxRetryAttemptsAfterInitial
			) {
				throw new PrReviewResilienceRetryExhaustedError(
					`BLOCKED: PR_REVIEW base allows attempt 0 plus at most ${snapshot.policy.maxRetryAttemptsAfterInitial} retry attempts`,
				);
			}
			if (
				normalizedLanes.length !== 1 ||
				(normalizedLanes[0]?.ownedWorkflowLanes?.length ?? 1) !== 1
			) {
				throw new Error(
					'BLOCKED: PR_REVIEW staged canary dispatch requires exactly one singleton base lane',
				);
			}
			const canaryDimension = normalizedLanes[0]!
				.workflowLane as PrReviewBaseDimensionId;
			if (!target.includes(canaryDimension)) {
				throw new Error(
					`BLOCKED: PR_REVIEW canary lane must target one unresolved base obligation from: ${target.join(', ')}`,
				);
			}
			nextResilience = {
				policy: snapshot.policy,
				attempts: [
					...snapshot.attempts,
					{
						attempt: requestedWaveAttempt,
						targetDimensions: target,
						canaryBatchId: batchId,
						canaryLaneId: normalizedLanes[0]!.laneId,
						canaryWorkflowLane: canaryDimension,
						admittedAt: isoNow(),
					},
				],
				// Issue #2382: an admitted HALF_OPEN probe persists with this very
				// success write (mark-on-success); any other surviving circuit
				// record carries forward unchanged.
				...((pendingProbeCircuit ?? snapshot.circuit)
					? { circuit: pendingProbeCircuit ?? snapshot.circuit }
					: {}),
			};
		} else {
			if (
				!lastAttempt ||
				lastAttempt.attempt !== requestedWaveAttempt ||
				lastAttempt.fanoutBatchId
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW base fanout must follow the recorded canary for attempt ${requestedWaveAttempt}`,
				);
			}
			const evaluated = await evaluatePrReviewResilienceAttempt(
				directory,
				state,
				lastAttempt,
				revisionDigest,
				snapshot.policy,
			);
			if (evaluated.canaryState === 'failed') {
				throw new Error(
					`BLOCKED: PR_REVIEW base attempt ${requestedWaveAttempt} canary failed; close the attempt and carry the unresolved target into the next retry`,
				);
			}
			if (evaluated.canaryState === 'waiting') {
				throw new Error(
					`BLOCKED: PR_REVIEW base attempt ${requestedWaveAttempt} canary is not yet proven successful or live: ${evaluated.reason ?? 'probe failed closed'}`,
				);
			}
			const remainingTarget = lastAttempt.targetDimensions.filter(
				(dimension) =>
					dimension !== lastAttempt.canaryWorkflowLane &&
					evaluated.remaining.includes(dimension),
			);
			if (remainingTarget.length === 0) {
				throw new Error(
					`BLOCKED: PR_REVIEW base attempt ${requestedWaveAttempt} has no remaining unresolved obligations for fanout`,
				);
			}
			if (
				!exactDimensionPartition(
					declaredBaseDimensions(normalizedLanes),
					remainingTarget,
				)
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW base fanout must partition the remaining unresolved obligations exactly once: ${remainingTarget.join(', ')}`,
				);
			}
			if (requestedWaveAttempt === 0) {
				const combinedDimensions = [
					lastAttempt.canaryWorkflowLane,
					...declaredBaseDimensions(normalizedLanes),
				];
				if (
					!exactDimensionPartition(
						combinedDimensions,
						lastAttempt.targetDimensions,
					)
				) {
					throw new Error(
						'BLOCKED: PR_REVIEW base attempt 0 canary plus fanout must partition all six base dimensions exactly once',
					);
				}
				if (
					depthTier === 'M' &&
					normalizedLanes.length + 1 < PR_REVIEW_BASE_LANE_FLOORS.M
				) {
					throw new Error(
						`BLOCKED: PR_REVIEW base attempt 0 at depth tier M requires at least ${PR_REVIEW_BASE_LANE_FLOORS.M} combined canary+fanout lanes`,
					);
				}
				if (
					depthTier === 'L' &&
					(normalizedLanes.length + 1 !== PR_REVIEW_BASE_DIMENSION_IDS.length ||
						normalizedLanes.some(
							(lane) => (lane.ownedWorkflowLanes?.length ?? 1) !== 1,
						))
				) {
					throw new Error(
						'BLOCKED: PR_REVIEW base attempt 0 at depth tier L requires six singleton combined canary+fanout lanes',
					);
				}
			}
			nextResilience = {
				...snapshot,
				attempts: [
					...snapshot.attempts.slice(0, -1),
					{ ...lastAttempt, fanoutBatchId: batchId },
				],
			};
		}
	}
	if (requestedContractRetry) {
		const revisionDigest =
			options.revisionDigest ??
			(await createPrReviewGateContext(directory, state)).revisionDigest;
		const attempts = summarizePrReviewBaseDimensionAttempts(
			directory,
			state,
			revisionDigest,
		);
		if (
			normalizedLanes.length !== 1 ||
			(normalizedLanes[0]?.ownedWorkflowLanes?.length ?? 1) !== 1
		) {
			throw new Error(
				'BLOCKED: PR_REVIEW contract retry requires exactly one singleton lane',
			);
		}
		const contractedDimension =
			declaredBaseDimensions(normalizedLanes)[0] ??
			normalizedLanes[0]!.workflowLane;
		if (attempts.successful.has(contractedDimension)) {
			throw new Error(
				`BLOCKED: PR_REVIEW contract retry cannot target already-successful dimension "${contractedDimension}"`,
			);
		}
		if (attempts.inFlight.has(contractedDimension)) {
			throw new Error(
				`BLOCKED: PR_REVIEW contract retry cannot target in-flight dimension "${contractedDimension}"`,
			);
		}
		if (!attempts.contractFailed.has(contractedDimension)) {
			throw new Error(
				`BLOCKED: PR_REVIEW contract retry requires a recorded terminal contract failure for dimension "${contractedDimension}"`,
			);
		}
		if (attempts.contractRetried.has(contractedDimension)) {
			throw new Error(
				`BLOCKED: PR_REVIEW contract retry for dimension "${contractedDimension}" was already admitted`,
			);
		}
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
		...(requestedContractRetry
			? {
					prReviewContractRetryDimensions: [
						...(state.prReviewContractRetryDimensions ?? []),
						declaredBaseDimensions(normalizedLanes)[0]!,
					],
				}
			: {}),
		...(nextResilience ? { prReviewResilience: nextResilience } : {}),
	};
	return writeStateWhileLocked(directory, nextState);
}

export async function rollbackPrReviewBaseAdmissionIfUnlaunched(
	directory: string,
	sessionID: string,
	batchId: string,
	contractRetry = false,
): Promise<boolean> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const normalizedBatchId = normalizeBatchId(batchId);
	return withPrWorkflowCheckoutMutationLock(directory, async () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
			const state = await readPrWorkflowGateState(
				directory,
				normalizedSessionID,
			);
			if (!state || state.mode !== 'PR_REVIEW') return false;
			const batchRecords = findByBatchId(directory, normalizedBatchId, {
				parentSessionId: normalizedSessionID,
			});
			// Issue #2385: the rollback transition is REDUCER-OWNED — the
			// adapter emits `base_admission_rolled_back`, and a typed rejection
			// (not-last batch / already-launched batch) maps to the same silent
			// false the pre-reducer guard produced.
			const rollbackOutcome = reducePrReviewEvent(state, {
				type: 'base_admission_rolled_back',
				batchId: normalizedBatchId,
				batchDelegationRecordsExist: batchRecords.length > 0,
			});
			if (rollbackOutcome.status === 'rejected') return false;
			const rollbackState = rollbackOutcome.state as PrWorkflowGateState;
			const currentBaseDispatches = state.prReviewBaseDispatches ?? [];
			const nextBaseDispatches = rollbackState.prReviewBaseDispatches ?? [];
			const rolledBackDimensions = new Set(
				currentBaseDispatches
					.at(-1)
					?.lanes.flatMap((lane) =>
						lane.ownedWorkflowLanes?.length
							? lane.ownedWorkflowLanes
							: [lane.workflowLane],
					) ?? [],
			);
			const nextContractRetryDimensions = contractRetry
				? (state.prReviewContractRetryDimensions ?? []).filter(
						(dimension) => !rolledBackDimensions.has(dimension),
					)
				: state.prReviewContractRetryDimensions;
			const lastAttempt = state.prReviewResilience?.attempts.at(-1);
			let nextResilience = rollbackState.prReviewResilience;
			if (lastAttempt?.canaryBatchId === normalizedBatchId) {
				nextResilience = nextResilience
					? {
							...nextResilience,
							attempts: nextResilience.attempts.slice(0, -1),
						}
					: nextResilience;
			} else if (lastAttempt?.fanoutBatchId === normalizedBatchId) {
				nextResilience = nextResilience
					? {
							...nextResilience,
							attempts: [
								...nextResilience.attempts.slice(0, -1),
								{ ...lastAttempt, fanoutBatchId: undefined },
							],
						}
					: nextResilience;
			}
			// Issue #2382 review (PRR-002): a rolled-back HALF_OPEN probe can
			// never produce a terminal record — this rollback's own precondition
			// is that the batch has zero delegation records — so leaving the
			// probe in place would wedge the circuit on probe_in_flight forever.
			// Issue #2385: the probe-end transition is REDUCER-OWNED
			// (`circuit_probe_settled` -> the machine's rolled-back-admission
			// path); the adapter applies the returned state.
			const rolledBackCircuit = nextResilience?.circuit;
			if (
				rolledBackCircuit &&
				'version' in rolledBackCircuit &&
				rolledBackCircuit.state === 'HALF_OPEN' &&
				rolledBackCircuit.probe?.batchId === normalizedBatchId
			) {
				const probeOutcome = reducePrReviewEvent(
					{ ...rollbackState, prReviewResilience: nextResilience },
					{
						type: 'circuit_probe_settled',
						outcome: { result: 'rolled_back_admission' },
						nowMs: _test_exports.nowMs(),
						policy: {
							...(nextResilience?.policy ?? snapshotPrReviewResiliencePolicy()),
							circuitOpenDurationMs: circuitOpenDurationMs(
								nextResilience?.policy ?? snapshotPrReviewResiliencePolicy(),
							),
						},
					},
				);
				if (probeOutcome.status === 'applied') {
					nextResilience =
						(probeOutcome.state as PrWorkflowGateState).prReviewResilience ??
						nextResilience;
				}
			}
			const shouldKeepResilience =
				(nextBaseDispatches.length > 0 && Boolean(nextResilience?.policy)) ||
				Boolean(nextResilience?.circuit) ||
				(nextResilience?.attempts.length ?? 0) > 0;
			await writeStateWhileLocked(directory, {
				...state,
				updatedAt: isoNow(),
				prReviewBaseDispatches: nextBaseDispatches,
				...(nextBaseDispatches.length > 0
					? { prReviewBaseDispatch: nextBaseDispatches.at(-1) }
					: { prReviewBaseDispatch: undefined }),
				...(shouldKeepResilience
					? { prReviewResilience: nextResilience }
					: { prReviewResilience: undefined }),
				...(nextContractRetryDimensions?.length
					? { prReviewContractRetryDimensions: nextContractRetryDimensions }
					: { prReviewContractRetryDimensions: undefined }),
			});
			return true;
		}),
	);
}

/**
 * Delegation statuses that prove a lane will produce nothing further.
 *
 * Enumerated here rather than reusing `isTerminal`
 * (`src/background/pending-delegations.ts:3555`) because that helper is private
 * to its module and because the two sets deliberately differ: `consumed` is a
 * *successfully ingested* terminal state, so treating it as a failure would let
 * a healthy lane be consolidated over. `pending` / `running` / `ingesting` /
 * `ingestion_error` are in flight or retryable. Any unrecognized (future) status
 * is treated as "not proven failed" and denies consolidation — default-deny.
 *
 * `completed` is included because completion alone is not success: a completed
 * record whose durable artifact is degraded, empty, identity-mismatched, or
 * semantically invalid is exactly the ran-and-failed case the tier-L retry
 * exception exists for. Preview truncation alone is recoverable when the durable
 * artifact validates. This set is therefore only consulted after both identity
 * and revision-independent semantic validation.
 *
 * Issue #2385: the set itself is owned by `src/pr-review/circuit.ts`
 * (`CIRCUIT_TERMINAL_DELEGATION_STATUSES`) — one vocabulary, no mirror.
 */
const TERMINAL_FAILED_DELEGATION_STATUSES =
	CIRCUIT_TERMINAL_DELEGATION_STATUSES;

/**
 * Fewest of these consolidated lane sets that together cover their own union.
 *
 * This is the "how many agents actually have to produce a review" number, and it
 * is deliberately a **minimum cover** rather than a count of declared lanes
 * (issue #1968 review round 2, MUST-FIX A). Declaring a lane costs nothing, so a
 * count of declarations inflates without bound while the union of the dimensions
 * they own saturates at six: four pairwise consolidations
 * `{A,B} {B,C} {D,E} {F,A}` are each individually legal, yet three of them
 * ({B,C}, {D,E}, {F,A}) already cover all six dimensions, and the wave settles at
 * three producing lanes — precisely `PR_REVIEW_BASE_LANE_FLOORS.M`, the tier-M
 * dispatch shape the tier-L floor exists to forbid. Re-declaring one identical
 * set several times is the same defect in its simplest form.
 *
 * Exact, not greedy. Greedy subset-elimination is order-dependent — on the four
 * pairs above it counts 4 in declaration order and 3 with `{A,B}` considered
 * last — and declaration order is chosen by the very controller being gated, so
 * an order-dependent count is not a floor.
 *
 * Cost is a bitmask DP over `2^|universe|` states. The universe is the set of
 * dimensions consolidated lanes own, which `enforcePrReviewBaseDimensions`
 * constrains to `PR_REVIEW_BASE_DIMENSION_IDS` before this ever runs, so it is
 * six in practice. State is nonetheless read from disk, so a universe wider than
 * `MAX_COVER_UNIVERSE_BITS` falls back to `ceil(|universe| / largest set size)` —
 * a valid lower bound on any cover, hence still fail-closed: it can only make the
 * floor reject more.
 */
const MAX_COVER_UNIVERSE_BITS = 12;

/**
 * Canonical key for a consolidated lane's owned dimension set. Sorted so two
 * declarations of the same set collapse, and `|`-joined because
 * `enforcePrReviewBaseDimensions` constrains every dimension to
 * `PR_REVIEW_BASE_DIMENSION_IDS`, none of which contains that character.
 */
function encodeConsolidatedLaneKey(owned: readonly string[]): string {
	return [...new Set(owned)].sort().join('|');
}

function decodeConsolidatedLaneKey(key: string): string[] {
	return key.split('|').filter((dimension) => dimension.length > 0);
}

function minimumConsolidatedLaneCover(
	sets: ReadonlyArray<readonly string[]>,
): number {
	const bitOf = new Map<string, number>();
	for (const set of sets) {
		for (const dimension of set) {
			if (!bitOf.has(dimension)) bitOf.set(dimension, bitOf.size);
		}
	}
	const universeSize = bitOf.size;
	if (universeSize === 0) return 0;
	const distinctMasks = new Set<number>();
	let largestSetSize = 1;
	for (const set of sets) {
		let mask = 0;
		let size = 0;
		for (const dimension of set) {
			const bit = 1 << (bitOf.get(dimension) as number);
			if ((mask & bit) === 0) size += 1;
			mask |= bit;
		}
		if (mask === 0) continue;
		distinctMasks.add(mask);
		largestSetSize = Math.max(largestSetSize, size);
	}
	if (universeSize > MAX_COVER_UNIVERSE_BITS) {
		return Math.ceil(universeSize / largestSetSize);
	}
	const full = (1 << universeSize) - 1;
	// Forward DP in increasing mask order. `mask | setMask` is strictly greater
	// than `mask` whenever it differs, so ascending order is a valid topological
	// order and one pass suffices. `full` is always reachable because the union
	// of every set is the universe by construction.
	const unreachable = universeSize + 1;
	const best: number[] = new Array<number>(full + 1).fill(unreachable);
	best[0] = 0;
	for (let mask = 0; mask < full; mask += 1) {
		const steps = best[mask] as number;
		if (steps === unreachable) continue;
		for (const setMask of distinctMasks) {
			const next = mask | setMask;
			if (next === mask) continue;
			if ((best[next] as number) > steps + 1) best[next] = steps + 1;
		}
	}
	return best[full] as number;
}

/**
 * Distinct lanes that would still back the six base dimensions once this batch
 * is recorded (issue #1968 MUST-FIX 1, refined by review round 2 MUST-FIX A).
 *
 * Counting rule: every dimension no consolidated lane claims contributes one
 * lane (it has, or will need, a dedicated lane of its own at tier L), plus the
 * MINIMUM number of the declared consolidated lanes needed to cover every
 * dimension consolidated lanes do claim — see `minimumConsolidatedLaneCover` for
 * why a count of declarations is not a floor. That sum is exactly "how many
 * agents actually produce the six-dimension base review".
 *
 * The cover is taken over lanes as **declared**, not as produced. Covering only
 * lanes that currently supply a source would let a controller declare every
 * consolidated retry batch before any of them lands — each one measured against
 * a wave that still looks un-consolidated — and land them all afterwards. A
 * consolidated lane that was later superseded by a successful *dedicated* lane
 * for every dimension it owned is dropped, so a failed consolidation followed by
 * singleton re-dispatch does not spend budget forever.
 *
 * `prReviewRetiredConsolidatedLanes` is walked alongside the live batches so the
 * cover is invariant under the capacity GC (issue #1968 review round 2, FIX D):
 * a failed consolidated base batch is prunable, and without the ledger dropping
 * it would shrink the cover's universe and hand the wave its consolidation
 * budget back.
 */
function tierLBackingLaneCount(
	state: PrWorkflowGateState,
	normalizedLanes: readonly PrWorkflowLaneSpec[],
	dedicatedSuccessful: ReadonlySet<string>,
): { backingLanes: number; consolidatedDimensions: string[] } {
	const consolidatedDimensions = new Set<string>();
	const consolidatedSets: string[][] = [];
	const consider = (
		owned: readonly (string | undefined)[],
		allowSupersede: boolean,
	): void => {
		const declared = owned.filter((dimension): dimension is string =>
			Boolean(dimension),
		);
		if (declared.length < 2) return;
		const live = allowSupersede
			? declared.filter((dimension) => !dedicatedSuccessful.has(dimension))
			: declared;
		if (live.length === 0) return;
		consolidatedSets.push([...new Set(live)]);
		for (const dimension of live) consolidatedDimensions.add(dimension);
	};
	const considerLane = (
		lane: { workflowLane?: string; ownedWorkflowLanes?: readonly string[] },
		allowSupersede: boolean,
	): void =>
		consider(
			lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane],
			allowSupersede,
		);
	for (const batch of state.prReviewBaseDispatches ?? []) {
		for (const lane of batch.lanes) considerLane(lane, true);
	}
	for (const key of state.prReviewRetiredConsolidatedLanes ?? []) {
		consider(decodeConsolidatedLaneKey(key), true);
	}
	for (const lane of normalizedLanes) considerLane(lane, false);
	const dedicatedDimensions = PR_REVIEW_BASE_DIMENSION_IDS.filter(
		(dimension) => !consolidatedDimensions.has(dimension),
	).length;
	return {
		backingLanes:
			dedicatedDimensions + minimumConsolidatedLaneCover(consolidatedSets),
		consolidatedDimensions: [...consolidatedDimensions],
	};
}

/**
 * Why this tier-L batch may not consolidate, or `null` when it may.
 *
 * Every clause of the retry exception must hold (issue #1968 P3.1, MUST-FIX 1).
 * The purely structural clauses — initial wave, one lane owning everything, and
 * the per-batch all-six floor — run first, so those rejections still cost no
 * artifact reads and no digest resolution. The remaining clauses, including the
 * cumulative wave floor, all read from the one `attempts` summary; the
 * cumulative floor adds no read the success/failure clauses did not already do.
 */
async function tierLConsolidationRejection(
	directory: string,
	state: PrWorkflowGateState,
	normalizedLanes: readonly PrWorkflowLaneSpec[],
	revisionDigest: string | undefined,
): Promise<string | null> {
	if ((state.prReviewBaseDispatches?.length ?? 0) === 0) {
		return 'This is the initial base wave, which may never consolidate at tier L.';
	}
	const dimensionCount = PR_REVIEW_BASE_DIMENSION_IDS.length;
	const consolidatedLanes = normalizedLanes.filter(
		(lane) => (lane.ownedWorkflowLanes?.length ?? 1) !== 1,
	);
	const wholeWaveLane = consolidatedLanes.find(
		(lane) => (lane.ownedWorkflowLanes?.length ?? 1) >= dimensionCount,
	);
	if (wholeWaveLane) {
		return `Lane "${wholeWaveLane.laneId}" owns all ${dimensionCount} dimensions on its own.`;
	}
	const claimedDimensions = new Set(
		normalizedLanes.flatMap(
			(lane) => lane.ownedWorkflowLanes ?? [lane.workflowLane],
		),
	);
	if (
		claimedDimensions.size >= dimensionCount &&
		normalizedLanes.length < PR_REVIEW_BASE_LANE_FLOORS.L
	) {
		return `This batch claims all ${dimensionCount} dimensions with only ${normalizedLanes.length} lanes.`;
	}
	let digest = revisionDigest;
	if (!digest) {
		// Dispatch always threads the digest it already resolved, so this branch
		// only serves direct callers (focused tests, future entry points). It is
		// the gate's single memoized resolve, never a per-record one.
		digest = (await createPrReviewGateContext(directory, state)).revisionDigest;
	}
	const attempts = summarizePrReviewBaseDimensionAttempts(
		directory,
		state,
		digest,
	);
	const consolidatedDimensions = [
		...new Set(
			consolidatedLanes.flatMap(
				(lane) => lane.ownedWorkflowLanes ?? [lane.workflowLane],
			),
		),
	].filter((dimension): dimension is string => Boolean(dimension));
	const alreadySuccessful = consolidatedDimensions.filter((dimension) =>
		attempts.successful.has(dimension),
	);
	if (alreadySuccessful.length > 0) {
		return `These consolidated dimensions already have a successful source: ${alreadySuccessful.join(', ')}.`;
	}
	const notTerminallyFailed = consolidatedDimensions.filter(
		(dimension) => !attempts.terminallyFailed.has(dimension),
	);
	if (notTerminallyFailed.length > 0) {
		return `These consolidated dimensions have no recorded lane that reached a terminal non-successful state (never dispatched, still in flight, or awaiting ingestion): ${notTerminallyFailed.join(', ')}.`;
	}
	// The cumulative floor. The per-batch clause above is defeated by splitting
	// one consolidation across two batches (claim five dimensions in one batch,
	// the sixth in a singleton batch that never reaches this predicate at all),
	// so the floor has to be measured over the whole base wave.
	const backing = tierLBackingLaneCount(
		state,
		normalizedLanes,
		attempts.dedicatedSuccessful,
	);
	if (backing.backingLanes < PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR) {
		return (
			`Across every base batch this wave would be backed by only ${backing.backingLanes} distinct ` +
			`lanes (each dimension no consolidated lane claims counts as one, plus the fewest declared ` +
			`consolidated lanes that cover the rest), and dimensions ` +
			`${backing.consolidatedDimensions.join(', ')} would be covered by consolidated lanes.`
		);
	}
	return null;
}

/**
 * Reclaim `MAX_WORKFLOW_BATCHES` capacity by dropping provably-inert batches.
 *
 * Pure with respect to durable state: it reads artifacts, returns a new state
 * object, and never persists. The caller re-reads its batch array from the
 * returned object and performs the one `persistState` for the whole
 * read-prune-append transaction — a separate GC write would be undone by the
 * subsequent `[...previous, record]` and would leave the local `revision` stale,
 * tripping the optimistic-concurrency check (issue #1968 BL-6).
 *
 * Fail-closed: the discharge of "pruning changed nothing observable" is
 * **inventory equality only** — `derivePrReviewCandidateInventory` and
 * `derivePrReviewCriticInventory`, the two pure `(directory, state)` derivations
 * the downstream gates consume. A past artifact-boundary exact-cover verdict is
 * deliberately NOT recomputed: `prReviewArtifactBoundaries` persists boundary
 * names only and the `findingIds` that check compares are caller-supplied and
 * never persisted, so that verdict is not a property of state and never was
 * (issue #1968 BL-5). If either inventory changes, or anything at all throws,
 * every batch is kept and the caller's cap error stands.
 */
async function prunePrWorkflowBatchesForCapacity(
	directory: string,
	state: PrWorkflowGateState,
	revisionDigest: string | undefined,
): Promise<PrWorkflowGateState> {
	try {
		const digest =
			revisionDigest ??
			(await createPrReviewGateContext(directory, state)).revisionDigest;
		const before = {
			candidate: derivePrReviewCandidateInventory(directory, state, {
				revisionDigest: digest,
			}),
			critic: derivePrReviewCriticInventory(directory, state, {
				revisionDigest: digest,
			}),
		};
		const pruned = pruneWorkflowBatches(directory, state, digest);
		if (!pruned) return state;
		const after = {
			candidate: derivePrReviewCandidateInventory(directory, pruned, {
				revisionDigest: digest,
			}),
			critic: derivePrReviewCriticInventory(directory, pruned, {
				revisionDigest: digest,
			}),
		};
		if (
			!sameStringSet(before.candidate, after.candidate) ||
			!sameStringSet(before.critic, after.critic)
		) {
			warn(
				'PR_REVIEW batch GC aborted: pruning would have changed the derived inventory; every batch was kept',
			);
			return state;
		}
		// The newest batch of every kind is unprunable, so the singular "latest"
		// pointers must survive. Assert rather than assume: a pointer left dangling
		// past its array entry would silently misreport the active dispatch.
		const survivingBaseIds = new Set(
			(pruned.prReviewBaseDispatches ?? []).map((batch) => batch.batchId),
		);
		if (
			state.prReviewBaseDispatch &&
			!survivingBaseIds.has(state.prReviewBaseDispatch.batchId)
		) {
			warn(
				'PR_REVIEW batch GC aborted: the latest base dispatch pointer would have been orphaned',
			);
			return state;
		}
		return pruned;
	} catch (error) {
		warn(
			`PR_REVIEW batch GC aborted: ${error instanceof Error ? error.message : String(error)}`,
		);
		return state;
	}
}

/**
 * The pure prune itself. Returns `null` when nothing is prunable.
 *
 * Never pruned:
 * - every `council` batch. `assertPrReviewValidationSettled` derives
 *   `declaredPhases` from the whole array and `prReviewPhaseWindow('reviewer')`
 *   scopes itself with `slice(latestCouncilIndex + 1)`, so council membership is
 *   load-bearing. Non-council batches are position-independent: removing one
 *   never changes *which* batches sit after the last council batch, only their
 *   indices, so the reviewer window is preserved by keeping council intact;
 * - every `critic` batch. `prReviewPhaseWindow('critic')` is **not** council
 *   scoped — it returns every critic batch in the array — so no critic batch is
 *   inert, including one recorded before the latest council. The fix plan's
 *   never-prune list omits this; dropping a pre-council critic batch would
 *   silently remove claims from critic settlement, which the inventory-equality
 *   proof below does not cover (critic settlement is not an inventory);
 * - the newest batch of each kind/phase, which keeps the singular latest-dispatch
 *   pointer and `declaredPhases` intact;
 * - any base batch carrying a fully-successful lane. The fix plan says "a current
 *   authoritative source for a dimension"; this protects the strict superset,
 *   because `derivePrReviewCandidateInventory` picks its authoritative source
 *   per *lane* under the tier-L singleton-first precedence, and a reverse
 *   per-batch scan here would not always agree. A superset can only under-prune;
 * - any reviewer batch that contributed at least one claim to the **exhaustive**
 *   composition. Contribution is read from a full-window scan rather than from
 *   the memoized early-exit pass, so this durable decision never rests on the
 *   composition's performance heuristic (issue #1968 MUST-FIX 3 / FIX 5; the two
 *   agree under today's exit condition — see `composePrReviewPhaseVerdicts`).
 *   A non-contributing reviewer batch is provably unable to change any verdict —
 *   composition is
 *   first-write-wins over a reverse scan, so a batch that claimed nothing at its
 *   own position cannot claim anything once the batches ahead of it are still
 *   there. That is a stronger warrant than inventory inequality and subsumes it:
 *   a batch validated against a different inventory contributes nothing anyway.
 *   The warrant is about the composition as it stands now; if a later inventory
 *   change made a dropped batch eligible again, its claims are simply absent,
 *   which can only leave an item unclaimed and BLOCK — never admit a verdict.
 *
 * Pruning a reviewer batch would otherwise loosen one fail-closed check —
 * `reviewerSubagentSessionIds`, the ban on a critic lane reusing a reviewer's
 * child session, which walks the live reviewer batches. Their child sessions are
 * therefore moved to `prReviewRetiredReviewerSessionIds`, which that function
 * unions in; if the ledger would overflow its bound the prune is abandoned.
 *
 * Pruning a base batch would loosen the other cumulative check the same way:
 * `tierLBackingLaneCount` covers the consolidated lanes it can see, and dropping
 * a failed consolidated batch would shrink that cover's universe and hand the
 * wave back consolidation budget it had already spent (issue #1968 review round
 * 2, FIX D). A dropped batch's consolidated lanes are therefore recorded in
 * `prReviewRetiredConsolidatedLanes` as canonical dimension-set keys, under the
 * same overflow-abandons-the-prune rule. Keys, not batches: the cover dedupes
 * identical sets anyway, so the ledger is bounded by the 57 non-singleton
 * subsets of six dimensions no matter how many batches retire.
 *
 * `prFeedbackVerifications` is not touched here — it belongs to the PR_FEEDBACK
 * mode, which never reaches this function — but it is no longer uncollected:
 * `prunePrFeedbackVerificationsForCapacity` reclaims it under the same
 * fail-closed contract (issue #1968 review round 2, MUST-FIX C).
 *
 * Survivor order is preserved, and an orphaned `prReviewBatchCoherence` entry is
 * always pruned with its batch.
 */
function pruneWorkflowBatches(
	directory: string,
	state: PrWorkflowGateState,
	revisionDigest: string,
): PrWorkflowGateState | null {
	const baseBatches = state.prReviewBaseDispatches ?? [];
	const validationBatches = state.prReviewValidationBatches ?? [];
	const ctx: PrReviewGateContext = { revisionDigest };

	const contributingBaseBatchIds = new Set<string>();
	for (const batch of baseBatches) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:base',
			batch.validatedAt,
			true,
			new Set(),
			revisionDigest,
		);
		const hasFullySuccessfulLane = batch.lanes.some((lane) =>
			(lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane]
			).every((dimension) => successful.has(dimension)),
		);
		if (hasFullySuccessfulLane) contributingBaseBatchIds.add(batch.batchId);
	}
	const newestBaseBatchId = baseBatches.at(-1)?.batchId;
	const survivingBase = baseBatches.filter(
		(batch) =>
			batch.batchId === newestBaseBatchId ||
			contributingBaseBatchIds.has(batch.batchId),
	);

	const newestBatchIdByPhase = new Map<string, string>();
	for (const batch of validationBatches) {
		newestBatchIdByPhase.set(batch.phase, batch.batchId);
	}
	// Exhaustive on purpose: the hot path stops as soon as every item is claimed,
	// and "was not reached before the early exit" is not evidence of inertness.
	const contributingReviewerBatchIds = new Set(
		composePrReviewPhaseVerdicts(directory, state, 'reviewer', ctx, true)
			.contributingBatchIds,
	);
	const survivingValidation = validationBatches.filter((batch) => {
		if (batch.phase === 'council' || batch.phase === 'critic') return true;
		if (newestBatchIdByPhase.get(batch.phase) === batch.batchId) return true;
		return contributingReviewerBatchIds.has(batch.batchId);
	});

	if (
		survivingBase.length === baseBatches.length &&
		survivingValidation.length === validationBatches.length
	) {
		return null;
	}
	const survivingValidationIds = new Set(
		survivingValidation.map((batch) => batch.batchId),
	);
	const retiredReviewerSessionIds = new Set(
		state.prReviewRetiredReviewerSessionIds ?? [],
	);
	for (const batch of validationBatches) {
		if (batch.phase !== 'reviewer') continue;
		if (survivingValidationIds.has(batch.batchId)) continue;
		for (const record of findByBatchId(directory, batch.batchId, {
			parentSessionId: state.sessionID,
		})) {
			const subagentSessionId = record.subagentSessionId?.trim();
			if (subagentSessionId) retiredReviewerSessionIds.add(subagentSessionId);
		}
	}
	if (retiredReviewerSessionIds.size > MAX_RETIRED_REVIEWER_SESSION_IDS) {
		warn(
			'PR_REVIEW batch GC aborted: retiring these reviewer batches would overflow the forbidden child-session ledger; every batch was kept',
		);
		return null;
	}
	// Same shape, for the other fail-closed check a prune would loosen: the
	// tier-L cumulative consolidation floor covers the consolidated lanes it can
	// see, and it can only see surviving base batches (issue #1968 FIX D).
	const survivingBaseIds = new Set(survivingBase.map((batch) => batch.batchId));
	const retiredConsolidatedLanes = new Set(
		state.prReviewRetiredConsolidatedLanes ?? [],
	);
	for (const batch of baseBatches) {
		if (survivingBaseIds.has(batch.batchId)) continue;
		for (const lane of batch.lanes) {
			const owned = lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane];
			if (new Set(owned).size < 2) continue;
			retiredConsolidatedLanes.add(encodeConsolidatedLaneKey(owned));
		}
	}
	if (retiredConsolidatedLanes.size > MAX_RETIRED_CONSOLIDATED_LANES) {
		warn(
			'PR_REVIEW batch GC aborted: retiring these base batches would overflow the retired consolidated-lane ledger; every batch was kept',
		);
		return null;
	}
	const survivingBatchIds = new Set([
		...survivingBaseIds,
		...survivingValidationIds,
	]);
	const coherence = Object.fromEntries(
		Object.entries(state.prReviewBatchCoherence ?? {}).filter(([batchId]) =>
			survivingBatchIds.has(batchId),
		),
	);
	return {
		...state,
		...(state.prReviewBaseDispatches
			? { prReviewBaseDispatches: survivingBase }
			: {}),
		...(state.prReviewValidationBatches
			? { prReviewValidationBatches: survivingValidation }
			: {}),
		prReviewBatchCoherence:
			Object.keys(coherence).length > 0 ? coherence : undefined,
		prReviewRetiredReviewerSessionIds:
			retiredReviewerSessionIds.size > 0
				? [...retiredReviewerSessionIds]
				: undefined,
		prReviewRetiredConsolidatedLanes:
			retiredConsolidatedLanes.size > 0
				? [...retiredConsolidatedLanes]
				: undefined,
	};
}

/**
 * Issue #2385: the coverage-disclosure admission/settlement state machine now
 * lives in `src/pr-review/completion.ts`, which the gate feeds through the
 * bound completion-helper seam (bound at module init below). The gate
 * re-exposes the two state-returning entry points with their original
 * full-state signatures: every state object the boundary returns was read and
 * written through this gate's own bound readers and codec, so the widening
 * cast is representation-preserving.
 */
export async function admitPrReviewPartialBaseCoverage(
	directory: string,
	sessionID: string,
	runId: string,
	unresolvedDimensions: readonly PrReviewBaseDimensionId[],
): Promise<PrWorkflowGateState> {
	return (await admitPrReviewPartialBaseCoverageFromCompletion(
		directory,
		sessionID,
		runId,
		unresolvedDimensions,
	)) as PrWorkflowGateState;
}

export async function assertPrReviewBaseCoverageSettled(
	directory: string,
	sessionID: string,
	gateContext?: PrReviewGateContext,
): Promise<{
	state: PrWorkflowGateState;
	settlement: PrReviewTerminalCoverageSettlement & {
		liveDimensions: PrReviewBaseDimensionId[];
	};
}> {
	const settled = await assertPrReviewBaseCoverageSettledFromCompletion(
		directory,
		sessionID,
		gateContext,
	);
	return {
		state: settled.state as PrWorkflowGateState,
		settlement: settled.settlement,
	};
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
	let ctx = await createPrReviewGateContext(directory, state);
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
			ctx,
		);
	} else if (phase === 'critic') {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
			ctx,
		);
	}
	// requireBoundState re-reads through the same snapshot, but the returned
	// object identity changed; the memoized compositions were computed against
	// the pre-reload object, so keep the digest and re-memoize against the state
	// this function actually persists from.
	ctx = { revisionDigest: ctx.revisionDigest };
	const normalizedLanes = normalizeWorkflowLanes(lanes);
	if (
		(phase === 'reviewer' || phase === 'critic') &&
		normalizedLanes.some((lane) => !lane.reviewItemIds?.length)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${phase} lanes require non-empty review_item_ids ownership`,
		);
	}
	let validatedInventory: string[] | undefined;
	if (phase === 'reviewer' || phase === 'critic') {
		assertNoDuplicates(
			normalizedLanes.flatMap((lane) => lane.reviewItemIds ?? []),
			`PR_REVIEW ${phase} review item ownership`,
		);
		const assigned = normalizedLanes.flatMap(
			(lane) => lane.reviewItemIds ?? [],
		);
		validatedInventory =
			phase === 'reviewer'
				? derivePrReviewCandidateInventory(directory, state, ctx)
				: derivePrReviewCriticInventory(directory, state, ctx);
		assertStringSetSubset(
			assigned,
			validatedInventory,
			`PR_REVIEW ${phase} ownership`,
		);
	}
	const batchId = normalizeBatchId(options.batchId);
	let previous = state.prReviewValidationBatches ?? [];
	if (previous.some((batch) => batch.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_REVIEW validation batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		// Prune inside this same read-prune-append transaction, before `previous`
		// and `retained` are derived, so the single persistState below writes the
		// pruned array (issue #1968 BL-6).
		state = await prunePrWorkflowBatchesForCapacity(
			directory,
			state,
			ctx.revisionDigest,
		);
		previous = state.prReviewValidationBatches ?? [];
		if (previous.length >= MAX_WORKFLOW_BATCHES) {
			throw new Error('BLOCKED: PR_REVIEW validation batch limit reached');
		}
	}
	const record: PrReviewValidationBatchRecord = {
		batchId,
		phase,
		lanes: normalizedLanes,
		validatedAt: isoNow(),
	};
	// A critic batch is meaningful only for the exact reviewer rows it was
	// launched against. Pin each owned item to the sha256 of the full canonical
	// [REVIEWED] row that was authoritative right now; composition drops exactly
	// the claims whose reviewer row later changed and keeps the rest.
	const reviewerItemBindings =
		phase === 'critic'
			? criticReviewerItemBindings(directory, state, normalizedLanes, ctx)
			: undefined;
	// Legacy critic batches carry no bindings, so nothing can decide per item
	// whether they went stale; for those the pre-existing blanket prune on every
	// new reviewer batch is retained verbatim. Bound critic batches survive and
	// are filtered per item at composition time instead.
	const retained =
		phase === 'reviewer'
			? previous.filter(
					(batch) =>
						batch.phase !== 'critic' ||
						Boolean(
							state.prReviewBatchCoherence?.[batch.batchId]
								?.reviewerItemBindings,
						),
				)
			: previous;
	const retainedIds = new Set(retained.map((batch) => batch.batchId));
	const coherence: Record<string, PrReviewBatchCoherenceRecord> =
		Object.fromEntries(
			Object.entries(state.prReviewBatchCoherence ?? {}).filter(([id]) =>
				retainedIds.has(id),
			),
		);
	if (validatedInventory) {
		coherence[batchId] = {
			validatedInventory,
			...(reviewerItemBindings
				? {
						reviewerItemBindings,
						reviewerItemBindingKeyEncoding: 'prefixed-v1' as const,
					}
				: {}),
		};
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewValidationBatches: [...retained, record],
		// Always reassigned, never spread-inherited: a pruned critic batch must
		// take its coherence entry with it.
		prReviewBatchCoherence:
			Object.keys(coherence).length > 0 ? coherence : undefined,
	};
	await persistState(directory, nextState);
	return nextState;
}

/**
 * Validate that every declared council obligation has a successful retry, and
 * that every reviewer/critic *item* carries an authenticated verdict.
 *
 * Council keeps lane-level accounting (council lanes carry no item ownership).
 * Reviewer and critic settle through `composePrReviewPhaseVerdicts`, so
 * settlement and every verdict derivation are literally the same computation —
 * settlement can never pass while derivation is empty.
 */
export async function assertPrReviewValidationSettled(
	directory: string,
	sessionID: string,
	phase?: PrReviewValidationPhase,
	gateContext?: PrReviewGateContext,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const ctx =
		gateContext ?? (await createPrReviewGateContext(directory, state));
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
		const batches =
			requiredPhase === 'council'
				? validationBatches.filter((batch) => batch.phase === 'council')
				: prReviewPhaseWindow(state, requiredPhase);
		// Ordering is load-bearing: the "no batch at all" diagnostic must fire
		// before composition, which derives the candidate inventory and can raise
		// its own (less useful, here) provenance errors.
		if (batches.length === 0) {
			throw new Error(
				requiredPhase === 'reviewer' && declaredPhases.has('council')
					? 'BLOCKED: PR_REVIEW requires at least one reviewer batch after the latest council batch'
					: `BLOCKED: PR_REVIEW requires at least one ${requiredPhase} batch`,
			);
		}
		if (requiredPhase === 'council') {
			const settled = new Set<string>();
			for (const batch of batches) {
				for (const obligation of successfulObligationsFromExactBatch(
					directory,
					state,
					batch.batchId,
					batch.lanes,
					'swarm-pr-review:council',
					batch.validatedAt,
					true,
					new Set(),
					ctx.revisionDigest,
				)) {
					settled.add(obligation);
				}
			}
			const missing = [
				...new Set(
					batches.flatMap((batch) =>
						batch.lanes.map((lane) => lane.workflowLane),
					),
				),
			].filter((obligation) => !settled.has(obligation));
			if (missing.length > 0) {
				throw new Error(
					`BLOCKED: PR_REVIEW council obligations lack successful exact artifacts: ${missing.join(', ')}`,
				);
			}
			continue;
		}
		const composed = composePrReviewPhaseVerdicts(
			directory,
			state,
			requiredPhase,
			ctx,
		);
		if (composed.unclaimed.length > 0) {
			const named = composed.unclaimed.slice(0, MAX_UNCLAIMED_ITEMS_IN_MESSAGE);
			const overflow = composed.unclaimed.length - named.length;
			throw new Error(
				`BLOCKED: PR_REVIEW ${requiredPhase} items lack an authenticated verdict from any successful lane: ${named.join(', ')}` +
					(overflow > 0 ? ` (+${overflow} more)` : '') +
					(composed.diagnostics.length > 0
						? `; diagnostics: ${composed.diagnostics.join(' | ')}`
						: ''),
			);
		}
		// B1 (issue #1968): reaching here means this phase is now *treated as
		// settled*. Settling is only meaningful if the authoritative verdict map
		// every downstream gate reads is actually populated over the same
		// inventory — a settled-but-empty reviewer map skips critic coverage
		// silently. Same memoized composition, so this costs one filter and adds
		// no digest resolution or artifact read.
		assertSettledPhaseHasAuthoritativeVerdicts(
			requiredPhase,
			composed,
			requiredPhase === 'reviewer'
				? deriveLatestPrReviewReviewerVerdicts(directory, state, ctx)
				: deriveLatestPrReviewCriticVerdicts(directory, state, ctx),
			`assertPrReviewValidationSettled(${requiredPhase})`,
		);
		if (composed.diagnostics.length > 0) {
			warn(
				`PR_REVIEW ${requiredPhase} settled by composition across batches [${composed.contributingBatchIds.join(', ')}] with abandoned or ineligible lanes`,
				composed.diagnostics,
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
		const existing = state.prFeedbackInventory;
		if (sameStringArray(existing, normalizedInventory)) return state;
		// Issue #2242 R3 (wedge W-2): hard immutability made a late-discovered
		// finding unrecoverable — the only exit was abort + full restart, which
		// also discarded every completed verification for correctly-declared
		// items. Growth is now accepted; mutation, removal and reorder are not.
		//
		// Note on the comparison primitive: `normalizeInventoryIds` canonicalises
		// by SORTING and rejects duplicates, so an appended id lands in sort
		// position rather than at the end. An array-PREFIX rule would therefore
		// reject legitimate appends. The equivalent (and, on a canonical form,
		// stronger) rule is set-superset: every previously-declared entry must
		// still be present. Because both sides are sorted and duplicate-free,
		// "same set" implies "same array", so a reorder is not expressible and a
		// missing entry is the single signal for mutation-or-removal.
		const nextIds = new Set(normalizedInventory);
		const droppedIds = existing.filter((itemId) => !nextIds.has(itemId));
		if (droppedIds.length > 0) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK inventory is append-only after declaration; declared item(s) may not be removed or renamed: ${droppedIds.join(', ')}`,
			);
		}
		const existingIds = new Set(existing);
		const appendedIds = normalizedInventory.filter(
			(itemId) => !existingIds.has(itemId),
		);
		/* c8 ignore next 6 -- unreachable: both sides are sorted and
		   duplicate-free, so "no drops and nothing appended" is exactly the
		   sameStringArray case already returned above. Kept as a fail-closed
		   assertion so a future change to normalizeInventoryIds cannot silently
		   turn this into a no-op amendment. */
		if (appendedIds.length === 0) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK inventory amendment declared no new items',
			);
		}
		const previousAmendments = state.prFeedbackInventoryAmendments ?? [];
		if (
			previousAmendments.length + appendedIds.length >
			MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS
		) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK inventory amendment limit reached (${MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS}); the amendment ledger is an audit trail and is never pruned`,
			);
		}
		const amendedAt = isoNow();
		const batch =
			previousAmendments.reduce(
				(highest, amendment) => Math.max(highest, amendment.batch),
				0,
			) + 1;
		const amendedState: PrWorkflowGateState = {
			...state,
			updatedAt: amendedAt,
			prFeedbackInventory: normalizedInventory,
			prFeedbackInventoryAmendments: [
				...previousAmendments,
				...appendedIds.map((entry) => ({ entry, amendedAt, batch })),
			],
			// The armed record attests coverage of the PRE-amendment inventory,
			// so adding an item invalidates exactly what it attested. Issue
			// #2108: when a live publication generation exists this disarm is an
			// AUDITED invalidation (generation -> invalidated, receipts
			// superseded, event appended) folded into this same atomic write;
			// re-arming then re-verifies every phase against the amended
			// inventory.
			prFeedbackReadyToPublish: undefined,
		};
		const superseded = supersedeLivePublicationInPendingState(
			amendedState,
			'inventory-amended',
		);
		await persistState(directory, superseded.state);
		if (superseded.invalidationEvent) {
			appendPublicationEvent(directory, superseded.invalidationEvent);
		}
		return superseded.state;
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

/**
 * Reclaim `MAX_WORKFLOW_BATCHES` capacity for `prFeedbackVerifications` (issue
 * #1968 review round 2, MUST-FIX C).
 *
 * Same contract as `prunePrWorkflowBatchesForCapacity`: pure with respect to
 * durable state (reads artifacts, returns a new object, never persists), so the
 * caller performs the one `persistState` for the whole read-prune-append
 * transaction and the optimistic-concurrency revision stays consistent.
 *
 * A verification batch holds exactly two things a later call reads:
 * - its contribution to settlement coverage, which is only ever the items of a
 *   lane that both passed batch integrity and produced an artifact covering
 *   them. `assertPrFeedbackVerificationSettled` unions coverage from those lanes
 *   alone, so a batch whose every lane failed contributes nothing at all — the
 *   retry-driven accumulation this cap suffers from is made entirely of such
 *   batches;
 * - its item->lane ownership bindings, which `enforcePrFeedbackVerificationOwnership`
 *   rebuilds cumulatively to reject a re-claim of an item by a *different* lane.
 *   Those are moved to `prFeedbackRetiredItemOwnership`, which that function
 *   seeds from, so the fail-closed re-claim rejection survives the prune. If the
 *   ledger would overflow its bound, every batch is kept instead.
 *
 * Fail-closed like its PR_REVIEW sibling: the covered-item set is recomputed
 * over the pruned state and must be identical, the newest batch is never
 * dropped (so the singular `prFeedbackVerification` pointer cannot dangle), and
 * anything that throws keeps every batch and lets the caller's cap error stand.
 *
 * Batch ids of dropped batches become reusable, which is safe for the same
 * reason it is in the PR_REVIEW GC: `recordsPassingBatchIntegrity` requires
 * `record.createdAt >= validatedAt`, so a new batch reusing a retired id cannot
 * inherit the retired batch's older delegation records.
 */
async function prunePrFeedbackVerificationsForCapacity(
	directory: string,
	state: PrWorkflowGateState,
): Promise<PrWorkflowGateState> {
	try {
		const digest = await currentPrFeedbackRevisionDigest(directory, state);
		const batches = state.prFeedbackVerifications ?? [];
		const before = prFeedbackCoveredItems(directory, state, digest);
		const newestBatchId = batches.at(-1)?.batchId;
		const surviving = batches.filter(
			(batch) =>
				batch.batchId === newestBatchId ||
				prFeedbackBatchCoveredItems(directory, state, batch, digest).size > 0,
		);
		if (surviving.length === batches.length) return state;
		const retiredItemOwnership: Record<string, string> = {
			...(state.prFeedbackRetiredItemOwnership ?? {}),
		};
		const survivingIds = new Set(surviving.map((batch) => batch.batchId));
		for (const batch of batches) {
			if (survivingIds.has(batch.batchId)) continue;
			for (const lane of batch.ownership) {
				for (const itemId of lane.ownedItemIds) {
					retiredItemOwnership[itemId] = lane.laneId;
				}
			}
		}
		if (
			Object.keys(retiredItemOwnership).length >
			MAX_RETIRED_FEEDBACK_ITEM_OWNERS
		) {
			warn(
				'PR_FEEDBACK verification GC aborted: retiring these batches would overflow the item-ownership ledger; every batch was kept',
			);
			return state;
		}
		const pruned: PrWorkflowGateState = {
			...state,
			prFeedbackVerifications: surviving,
			prFeedbackRetiredItemOwnership:
				Object.keys(retiredItemOwnership).length > 0
					? retiredItemOwnership
					: undefined,
		};
		const after = prFeedbackCoveredItems(directory, pruned, digest);
		if (!sameStringSet([...before], [...after])) {
			warn(
				'PR_FEEDBACK verification GC aborted: pruning would have changed the covered inventory; every batch was kept',
			);
			return state;
		}
		if (
			state.prFeedbackVerification &&
			!survivingIds.has(state.prFeedbackVerification.batchId)
		) {
			warn(
				'PR_FEEDBACK verification GC aborted: the latest verification pointer would have been orphaned',
			);
			return state;
		}
		return pruned;
	} catch (error) {
		warn(
			`PR_FEEDBACK verification GC aborted: ${error instanceof Error ? error.message : String(error)}`,
		);
		return state;
	}
}

export async function enforcePrFeedbackVerificationOwnership(
	directory: string,
	sessionID: string,
	ownership: readonly PrFeedbackLaneOwnership[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
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
	let previous = state.prFeedbackVerifications ?? [];
	const batchId = normalizeBatchId(options.batchId);
	if (previous.some((record) => record.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		// Feedback verification accumulates on retry exactly as the PR_REVIEW
		// arrays do — `dispatch-lanes.ts` appends a batch on EVERY verification
		// dispatch, retries included — so this cap needs the same reclaim (issue
		// #1968 review round 2, MUST-FIX C). What a dropped batch would otherwise
		// take with it is the cumulative item->lane ownership ledger rebuilt just
		// below; `prFeedbackRetiredItemOwnership` carries those bindings across the
		// prune so the re-claim rejection is preserved. Same transaction shape as
		// the PR_REVIEW GC: prune the in-memory state first, re-read `previous`
		// from it, and let the single persistState downstream commit both.
		state = await prunePrFeedbackVerificationsForCapacity(directory, state);
		previous = state.prFeedbackVerifications ?? [];
		if (previous.length >= MAX_WORKFLOW_BATCHES) {
			throw new Error('BLOCKED: PR_FEEDBACK verification batch limit reached');
		}
	}
	for (const [itemId, laneId] of Object.entries(
		state.prFeedbackRetiredItemOwnership ?? {},
	)) {
		claimedByItemId.set(itemId, laneId);
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

/**
 * Inventory items a verification batch settles: the items of every lane that is
 * both successful under batch integrity and whose artifact actually covers them.
 *
 * Shared with the capacity GC so "what this batch contributes to coverage" is
 * one computation rather than two that can drift (issue #1968 review round 2,
 * MUST-FIX C). A batch with no such lane contributes nothing to settlement.
 */
function prFeedbackBatchCoveredItems(
	directory: string,
	state: PrWorkflowGateState,
	batch: PrFeedbackVerificationRecord,
	currentDigest: string,
): Set<string> {
	const covered = new Set<string>();
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
			!legacyFeedbackArtifactCoversItems(
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
	return covered;
}

function prFeedbackCoveredItems(
	directory: string,
	state: PrWorkflowGateState,
	currentDigest: string,
): Set<string> {
	const covered = new Set<string>();
	for (const batch of state.prFeedbackVerifications ?? []) {
		for (const itemId of prFeedbackBatchCoveredItems(
			directory,
			state,
			batch,
			currentDigest,
		)) {
			covered.add(itemId);
		}
	}
	return covered;
}

/** Validate cumulative exact inventory ownership and settled verification artifacts. */
async function assertPrFeedbackVerificationSettledState(
	directory: string,
	state: PrWorkflowGateState,
): Promise<string> {
	if (state.mode !== 'PR_FEEDBACK') throw wrongModeError(state, 'PR_FEEDBACK');
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	const inventory = state.prFeedbackInventory;
	const batches = state.prFeedbackVerifications ?? [];
	if (!inventory || batches.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires an immutable inventory and verification batches',
		);
	}
	const covered = prFeedbackCoveredItems(directory, state, currentDigest);
	const missing = inventory.filter((itemId) => !covered.has(itemId));
	if (missing.length > 0 || covered.size !== inventory.length) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification ownership is incomplete; missing inventory items: ${missing.join(', ') || '(none)'}`,
		);
	}
	return currentDigest;
}

/** Validate cumulative exact inventory ownership and settled verification artifacts. */
export async function assertPrFeedbackVerificationSettled(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	await assertPrFeedbackVerificationSettledState(directory, state);
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
	const normalizedCategories = optionalCategoryOrder.filter((category) =>
		applicableCategories.includes(category),
	);
	// Issue #1968 P5a: a re-record on the SAME revision with an equal-or-wider
	// attestation invalidates nothing the already-recorded independent gate
	// batches proved, so those batches are retained instead of forcing a full
	// four-phase re-dispatch. An unchanged digest is NOT sufficient on its own:
	// `applicableObligations` / `applicableCategories` are caller-supplied and
	// validated only for internal self-consistency, so a re-record may narrow the
	// attestation, and a gate batch proved on the wider one is then no longer
	// evidence for what is being attested now. Narrower (or a changed revision)
	// wipes exactly as before.
	const retainsGateBatches = stageARetainsGateBatches(state.prFeedbackStageA, {
		revisionDigest: currentDigest,
		applicableCategories: normalizedCategories,
		applicableObligations,
	});
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackStageA: {
			revisionDigest: currentDigest,
			checks: [...checks],
			feedbackItemIds: reproductionFeedbackItemIds,
			applicableCategories: normalizedCategories,
			applicableObligations,
			validatedAt: isoNow(),
		},
		prFeedbackGateBatches: retainsGateBatches
			? [...(state.prFeedbackGateBatches ?? [])]
			: [],
		// Always disarmed, even when the gate batches are retained: re-arming is
		// one `complete_pr_workflow` call that re-verifies every retained phase,
		// so keeping an armed publication alive across a Stage A re-record would
		// widen the publication window for no saving worth having. Issue #2108:
		// when a live publication generation exists this disarm is an AUDITED
		// invalidation folded into this same atomic write.
		prFeedbackReadyToPublish: undefined,
	};
	const superseded = supersedeLivePublicationInPendingState(
		nextState,
		'stage-a-rerun',
	);
	await persistState(directory, superseded.state);
	if (superseded.invalidationEvent) {
		appendPublicationEvent(directory, superseded.invalidationEvent);
	}
	return superseded.state;
}

/**
 * Canonical identity of one Stage A workspace obligation.
 *
 * Field-ordered by construction rather than `JSON.stringify`-ed, because a fresh
 * caller object and a schema-parsed round-trip do not agree on key order. Every
 * field the obligation is validated against at `recordPrFeedbackStageA` time
 * participates: the same `id` carrying a different `source` or
 * `validatorContract` is a *different* obligation and must not read as retained.
 */
function canonicalStageAObligation(obligation: {
	id: string;
	category: string;
	workingDirectory: string;
	source: string;
	validatorContract?: { path: string; id: string };
}): string {
	return [
		obligation.id,
		obligation.category,
		obligation.workingDirectory,
		obligation.source,
		obligation.validatorContract?.path ?? '',
		obligation.validatorContract?.id ?? '',
	].join('\0');
}

/**
 * May the already-recorded PR_FEEDBACK gate batches survive this Stage A
 * re-record? Only when the revision is unchanged AND the incoming attestation is
 * equal to or a superset of the prior one.
 *
 * A previous record that carries neither attestation field is a *legacy* record
 * (both keys are optional in the schema and were absent before this retention
 * rule existed). Defaulting them to `[]` would make the superset check
 * vacuously true and retain gate approvals straight across a narrowed
 * re-attestation — the exact fail-open this function exists to close (issue
 * #1968 FIX 6). Unprovable therefore means wipe. `recordPrFeedbackStageA` always
 * writes both fields, so no record this code writes can take that branch.
 */
function stageARetainsGateBatches(
	previous: PrWorkflowGateState['prFeedbackStageA'],
	next: {
		revisionDigest: string;
		applicableCategories: ReadonlyArray<'build' | 'typecheck' | 'lint'>;
		applicableObligations: ReadonlyArray<
			Parameters<typeof canonicalStageAObligation>[0]
		>;
	},
): boolean {
	if (!previous || previous.revisionDigest !== next.revisionDigest)
		return false;
	if (!previous.applicableCategories || !previous.applicableObligations)
		return false;
	const nextCategories = new Set<string>(next.applicableCategories);
	if (
		!previous.applicableCategories.every((category) =>
			nextCategories.has(category),
		)
	) {
		return false;
	}
	const nextObligations = new Set(
		next.applicableObligations.map(canonicalStageAObligation),
	);
	return previous.applicableObligations.every((obligation) =>
		nextObligations.has(canonicalStageAObligation(obligation)),
	);
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
	// Issue #2242 R3: this is the control that makes an append-only inventory
	// amendment safe. `recordPrFeedbackGateBatch` proves exact ownership at
	// RECORD time, but `stageARetainsGateBatches` compares only the revision
	// digest, categories and obligations — never the item list — so an
	// amendment followed by a same-revision Stage A re-record RETAINS batches
	// whose `itemIds` predate the growth. `successfulObligationsFromExactBatch`
	// below is then fed the stale, shorter list and the appended item reaches
	// publication with no verdict at all. Re-check ownership against the CURRENT
	// inventory at settle time so every path (retention included) is covered.
	if (!sameStringArray(batch.itemIds, state.prFeedbackInventory ?? [])) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} evidence covers a stale inventory; the feedback inventory was amended after this batch was recorded. Re-run ${phase} against every current inventory item.`,
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

// ===== Publication-generation state machine (issue #2108) =====
//
// States: reviewing → armed → push_in_flight → published (terminal) with
// invalidated (recoverable via fresh Stage A + independent gates arming N+1)
// and cancelled_without_publication (terminal) reachable from the live
// states. The legacy `prFeedbackReadyToPublish` record is a derived mirror
// present exactly while `{armed, push_in_flight}` so a rolled-back binary
// keeps enforcing the armed window instead of turning permissive.

/**
 * Derive the legacy rollback mirror from the active generation. Present iff
 * the active generation is `{armed, push_in_flight}` — the mirror and the
 * generation record are fields of ONE state document written by ONE atomic
 * `writeAtomicJson` call, so there is no interleaved-write divergence window.
 */
function deriveReadyToPublishMirror(
	active: PrFeedbackPublicationGeneration | undefined,
): PrFeedbackReadyToPublishRecord | undefined {
	if (
		!active ||
		(active.state !== 'armed' && active.state !== 'push_in_flight')
	)
		return undefined;
	return {
		revisionDigest: active.revisionDigest,
		localHead: active.localHead,
		remoteName: active.remoteName,
		remoteBranchRef: active.remoteBranchRef,
		remoteRef: active.remoteRef,
		validatedAt: active.armedAt ?? active.createdAt,
	};
}

/** Which publication component drifted, or could not be verified. */
type PublicationIdentityCheck =
	| { kind: 'intact' }
	| { kind: 'drift'; component: string; detail: string }
	| { kind: 'unresolvable'; component: string; detail: string };

/** Recompute one identity component and compare it against the armed value. */
async function verifyPublicationIdentityComponent(
	directory: string,
	state: PrWorkflowGateState,
	active: PrFeedbackPublicationGeneration,
	component: string,
): Promise<PublicationIdentityCheck> {
	switch (component) {
		case 'digest': {
			try {
				const digest = await currentPrFeedbackRevisionDigest(directory, state);
				return digest === active.revisionDigest
					? { kind: 'intact' }
					: {
							kind: 'drift',
							component,
							detail: `approved revision digest ${active.revisionDigest} vs current ${digest}`,
						};
			} catch (error) {
				return {
					kind: 'unresolvable',
					component,
					detail: String((error as Error)?.message ?? error),
				};
			}
		}
		case 'head': {
			const head = (
				await _test_exports.resolveCurrentGitHeadAsync(directory)
			)?.trim();
			if (!head)
				return {
					kind: 'unresolvable',
					component,
					detail: 'HEAD resolution returned empty',
				};
			return head === active.localHead
				? { kind: 'intact' }
				: {
						kind: 'drift',
						component,
						detail: `approved head ${active.localHead} vs current ${head}`,
					};
		}
		case 'worktree': {
			const clean =
				await _test_exports.resolveIsWorkingTreeCleanAsync(directory);
			if (clean !== true && clean !== false)
				return {
					kind: 'unresolvable',
					component,
					detail: 'clean-status resolution failed',
				};
			return clean === true
				? { kind: 'intact' }
				: {
						kind: 'drift',
						component,
						detail: 'working tree or index is dirty',
					};
		}
		case 'upstream': {
			const target =
				await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
			if (!target)
				return {
					kind: 'unresolvable',
					component,
					detail: 'upstream target resolution returned empty',
				};
			return target.remoteName === active.remoteName &&
				target.remoteBranchRef === active.remoteBranchRef &&
				target.remoteTrackingRef === active.remoteRef
				? { kind: 'intact' }
				: {
						kind: 'drift',
						component,
						detail: `approved target ${active.remoteName}/${active.remoteBranchRef}/${active.remoteRef} vs current ${target.remoteName}/${target.remoteBranchRef}/${target.remoteTrackingRef}`,
					};
		}
		case 'remote-url': {
			// Every LIVE armed generation carries a push-URL identity (arming
			// and migration both hard-require it), so absence here means a
			// corrupt/hand-edited record — fail closed as unverifiable, never
			// silently intact.
			if (!active.remoteUrlIdentity) {
				return {
					kind: 'unresolvable',
					component,
					detail: 'armed generation carries no remote URL identity',
				};
			}
			const url = await _test_exports.resolveRemoteUrlIdentityAsync(
				directory,
				active.remoteName,
			);
			if (!url)
				return {
					kind: 'unresolvable',
					component,
					detail: `remote "${active.remoteName}" URL could not be resolved`,
				};
			return url === active.remoteUrlIdentity
				? { kind: 'intact' }
				: {
						kind: 'drift',
						component,
						detail: `approved remote URL identity ${active.remoteUrlIdentity} vs current ${url}`,
					};
		}
		case 'workspace-identity': {
			const identity = canonicalWorkspaceIdentity(directory);
			if (!identity)
				return {
					kind: 'unresolvable',
					component,
					detail: 'canonical workspace identity could not be resolved',
				};
			return identity === active.workspaceIdentity
				? { kind: 'intact' }
				: {
						kind: 'drift',
						component,
						detail: `generation is bound to a different workspace`,
					};
		}
		case 'evidence-join': {
			// First-class for locked re-verification (PR #2422 review PRR-009):
			// the receipt-set join drifts when the ACTIVE receipts no longer
			// match what armed the generation — a pure state comparison, so it
			// is always resolvable.
			return publicationEvidenceJoinIntact(state, active)
				? { kind: 'intact' }
				: {
						kind: 'drift',
						component,
						detail:
							'the receipt set recorded at arming is no longer the active one',
					};
		}
		default:
			return { kind: 'unresolvable', component, detail: 'unknown component' };
	}
}

const PUBLICATION_IDENTITY_COMPONENTS = [
	'digest',
	'head',
	'worktree',
	'upstream',
	'remote-url',
	'workspace-identity',
] as const;

/**
 * Verify every armed identity component outside any lock (the common intact
 * path takes no extra lock traffic). Proven mismatch → drift; resolver
 * failure → unresolvable (fail closed, NO state change — unverifiable is not
 * invalidation evidence).
 */
async function checkPublicationIdentity(
	directory: string,
	state: PrWorkflowGateState,
	active: PrFeedbackPublicationGeneration,
): Promise<PublicationIdentityCheck> {
	for (const component of PUBLICATION_IDENTITY_COMPONENTS) {
		const check = await verifyPublicationIdentityComponent(
			directory,
			state,
			active,
			component,
		);
		if (check.kind !== 'intact') return check;
	}
	if (!publicationEvidenceJoinIntact(state, active)) {
		return {
			kind: 'drift',
			component: 'evidence-join',
			detail: 'the receipt set recorded at arming is no longer the active one',
		};
	}
	return { kind: 'intact' };
}

/** Defense-in-depth: the active receipts still match the arming join. */
function publicationEvidenceJoinIntact(
	state: PrWorkflowGateState,
	active: PrFeedbackPublicationGeneration,
): boolean {
	if (state.prFeedbackStageA?.validatedAt !== active.evidence.stageAValidatedAt)
		return false;
	for (const join of active.evidence.batches) {
		const batch = [...(state.prFeedbackGateBatches ?? [])]
			.reverse()
			.find((candidate) => candidate.phase === join.phase);
		if (
			!batch ||
			batch.batchId !== join.batchId ||
			batch.laneId !== join.laneId
		)
			return false;
	}
	return true;
}

/** Build the evidence join for a freshly armed generation. */
function buildPublicationEvidenceJoin(
	state: PrWorkflowGateState,
	currentDigest: string,
): PrFeedbackPublicationEvidenceJoin | null {
	const stageA = state.prFeedbackStageA;
	if (!stageA || stageA.revisionDigest !== currentDigest || !stageA.validatedAt)
		return null;
	const batches: PrFeedbackPublicationEvidenceJoin['batches'] = [];
	for (const phase of PR_FEEDBACK_PHASE_ORDER) {
		const batch = [...(state.prFeedbackGateBatches ?? [])]
			.reverse()
			.find(
				(candidate) =>
					candidate.phase === phase &&
					candidate.revisionDigest === currentDigest,
			);
		if (!batch) return null;
		batches.push({ phase, batchId: batch.batchId, laneId: batch.laneId });
	}
	return { stageAValidatedAt: stageA.validatedAt, batches };
}

/** Append a publication core event; audit is non-fatal by house discipline. */
function appendPublicationEvent(
	directory: string,
	event: Record<string, unknown>,
): void {
	try {
		appendCoreEventSync(directory, { ...event, timestamp: isoNow() });
	} catch {
		// Non-fatal audit trail (same discipline as abort / no-change / rebind).
	}
}

function boundPublicationDiagnostic(text: string): string {
	const redacted = redactSecrets(text).replace(
		PUBLICATION_URL_CREDENTIALS_PATTERN,
		'$1[REDACTED:url_credentials]@',
	);
	return redacted.length > MAX_PUSH_ATTEMPT_DIAGNOSTIC_CHARS
		? `${redacted.slice(0, MAX_PUSH_ATTEMPT_DIAGNOSTIC_CHARS - 3)}...`
		: redacted;
}

/**
 * Snapshot of the publication container with bounded history trimming.
 * History keeps the last {@link MAX_PUBLICATION_HISTORY_GENERATIONS}
 * superseded generations; attempts belong to the active generation only.
 */
function nextPublicationContainer(
	previous: PrFeedbackPublicationState | undefined,
	active: PrFeedbackPublicationGeneration | undefined,
	historyAppends: PrFeedbackPublicationGeneration[] = [],
	attempts: PrFeedbackPushAttempt[] = [],
): PrFeedbackPublicationState {
	const history = [...(previous?.history ?? []), ...historyAppends].slice(
		-MAX_PUBLICATION_HISTORY_GENERATIONS,
	);
	return {
		schemaVersion: PUBLICATION_SCHEMA_VERSION,
		active,
		history,
		attempts: attempts.slice(-MAX_PUBLICATION_ATTEMPTS),
	};
}

/**
 * The audited invalidation transition (issue #2108 §4/§5). Supersedes every
 * content-dependent approval of the active generation — Stage A result,
 * verification batches, ordered-gate batches, scope declarations — by
 * removing them from ACTIVE state (the underlying lane artifacts remain in
 * their own stores; the superseded join is pinned in the generation record),
 * marks the generation `invalidated`, clears the rollback mirror, and appends
 * the audit event. Never deletes the generation itself or its history.
 *
 * `driftReverification` (auto-detected drift) re-proves the drifted component
 * under the session lock before writing, so a TOCTOU between the unlocked
 * snapshot and this write cannot invalidate on stale evidence.
 */
async function invalidatePublicationGeneration(
	directory: string,
	sessionID: string,
	reason: string,
	options: {
		drift?: { component: string; detail: string };
		driftReverification?: boolean;
		finalizeInFlightAs?: PrFeedbackPushAttemptOutcome;
	} = {},
): Promise<PrWorkflowPublicationTransitionResult> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!state || state.mode !== 'PR_FEEDBACK') {
			throw new Error(
				'BLOCKED: PR_FEEDBACK publication invalidation requires an active PR_FEEDBACK gate',
			);
		}
		return applyPublicationInvalidationWhileLocked(
			directory,
			state,
			reason,
			options,
		);
	});
}

/**
 * Invalidation core for callers that ALREADY hold the session state lock
 * (push admission re-verifies identity under its own lock). Performs no lock
 * acquisition of its own; the single atomic write and the audit event land
 * before it returns.
 */
async function applyPublicationInvalidationWhileLocked(
	directory: string,
	state: PrWorkflowGateState,
	reason: string,
	options: {
		drift?: { component: string; detail: string };
		driftReverification?: boolean;
		finalizeInFlightAs?: PrFeedbackPushAttemptOutcome;
	} = {},
): Promise<PrWorkflowPublicationTransitionResult> {
	{
		const active = state.prFeedbackPublication?.active;
		const legacyRecord = active ? undefined : state.prFeedbackReadyToPublish;
		if (!active && !legacyRecord) {
			throw new Error('BLOCKED: no armed publication generation to invalidate');
		}
		if (
			active &&
			active.state !== 'armed' &&
			active.state !== 'push_in_flight'
		) {
			throw new Error(
				`BLOCKED: publication generation ${active.generation} is already ${active.state}`,
			);
		}
		if (options.driftReverification && options.drift && active) {
			const recheck = await verifyPublicationIdentityComponent(
				directory,
				state,
				active,
				options.drift.component,
			);
			if (recheck.kind !== 'drift') {
				throw new Error(
					`BLOCKED: PR_FEEDBACK publication drift on ${options.drift.component} did not re-confirm under the state lock (${recheck.kind}); no invalidation was recorded — retry from current state`,
				);
			}
			options.drift = { component: recheck.component, detail: recheck.detail };
		}
		const now = isoNow();
		let attempts = (state.prFeedbackPublication?.attempts ?? []).map(
			(attempt) =>
				attempt.result
					? attempt
					: {
							...attempt,
							result: {
								outcome: options.finalizeInFlightAs ?? 'uncertain',
								exitStatus: 'not-observed' as const,
								diagnostic: `finalized by publication invalidation (${reason})`,
								postPush: { localHead: null, observedRemoteHead: null },
								completedAt: now,
							},
						},
		);
		let invalidated: PrFeedbackPublicationGeneration;
		if (active) {
			invalidated = {
				...active,
				state: 'invalidated',
				invalidatedAt: now,
				invalidationReason: reason,
			};
		} else if (legacyRecord) {
			// Legacy armed record that could not be proven equivalent to a
			// full generation identity: conservatively invalidated.
			invalidated = {
				schemaVersion: PUBLICATION_SCHEMA_VERSION,
				generation: 1,
				state: 'invalidated',
				workspaceIdentity:
					canonicalWorkspaceIdentity(directory) ?? 'unresolvable',
				sessionID: state.sessionID,
				intakeHeadSha: state.prHeadSha ?? 'unknown',
				localHeadRef: 'unknown',
				localHead: legacyRecord.localHead,
				remoteName: legacyRecord.remoteName,
				remoteUrlIdentity: undefined,
				remoteBranchRef: legacyRecord.remoteBranchRef,
				remoteRef: legacyRecord.remoteRef,
				revisionDigest: legacyRecord.revisionDigest,
				evidence: {
					stageAValidatedAt: state.prFeedbackStageA?.validatedAt ?? 'unknown',
					batches: (state.prFeedbackGateBatches ?? []).map((batch) => ({
						phase: batch.phase,
						batchId: batch.batchId,
						laneId: batch.laneId,
					})),
				},
				invalidationReason: reason,
				createdAt: legacyRecord.validatedAt,
				armedAt: legacyRecord.validatedAt,
				invalidatedAt: now,
			};
		} else {
			throw new Error('BLOCKED: no armed publication generation to invalidate');
		}
		if (!active) {
			// A legacy migration-invalidated generation never had attempts.
			attempts = [];
		}
		const nextState: PrWorkflowGateState = {
			...state,
			updatedAt: now,
			// Supersede every content-dependent approval of this generation:
			// arming N+1 requires freshly recorded evidence (rebind precedent).
			prFeedbackStageA: undefined,
			prFeedbackVerifications: undefined,
			prFeedbackGateBatches: undefined,
			prFeedbackScopes: undefined,
			prFeedbackReadyToPublish: undefined,
			prFeedbackPublication: nextPublicationContainer(
				state.prFeedbackPublication,
				invalidated,
				[],
				attempts,
			),
		};
		await writeStateWhileLocked(directory, nextState);
		appendPublicationEvent(directory, {
			type: 'pr_feedback_publication_invalidated',
			sessionID: state.sessionID,
			generation: invalidated.generation,
			reason,
			previousState: active?.state ?? 'armed',
			drift: options.drift ?? null,
			revisionDigest: invalidated.revisionDigest,
			localHead: invalidated.localHead,
			remoteName: invalidated.remoteName,
			remoteBranchRef: invalidated.remoteBranchRef,
			supersededBatchIds: invalidated.evidence.batches.map((b) => b.batchId),
		});
		return { generation: invalidated, state: nextState };
	}
}

interface PrWorkflowPublicationTransitionResult {
	generation: PrFeedbackPublicationGeneration;
	state: PrWorkflowGateState;
}

/**
 * Migrate a legacy armed record (pre-#2108 state) into the generation state
 * machine, conservatively: every identity component must recompute and match
 * under the session lock, and the active receipts must be present and bound
 * to the mirror's digest. Any mismatch or failure persists generation 1 as
 * `invalidated` with a `legacy-migration-*` reason — never silently armed.
 * No-op when no legacy record exists (returns the current state unchanged).
 */
async function ensurePublicationGenerationCurrent(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const state = await readPrWorkflowGateState(directory, normalizedSessionID);
	if (!state || state.mode !== 'PR_FEEDBACK') return state;
	if (state.prFeedbackPublication || !state.prFeedbackReadyToPublish) {
		return state;
	}
	const legacy = state.prFeedbackReadyToPublish;
	// Mirror/generation disagreement is treated as a legacy record awaiting
	// this migration; the checks below decide armed-vs-invalidated.
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const locked = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!locked || locked.mode !== 'PR_FEEDBACK') return locked ?? state;
		if (locked.prFeedbackPublication || !locked.prFeedbackReadyToPublish) {
			return locked;
		}
		const now = isoNow();
		const base = {
			schemaVersion: PUBLICATION_SCHEMA_VERSION,
			generation: 1,
			sessionID: locked.sessionID,
			prTargetUrl: locked.prFeedbackTargetUrl,
			intakeHeadSha: locked.prHeadSha ?? 'unknown',
			revisionDigest: legacy.revisionDigest,
			evidence:
				buildPublicationEvidenceJoin(locked, legacy.revisionDigest) ??
				({
					stageAValidatedAt: 'unknown',
					batches: [],
				} as PrFeedbackPublicationEvidenceJoin),
			createdAt: legacy.validatedAt,
			armedAt: legacy.validatedAt,
		};
		const mismatch = async (reason: string): Promise<PrWorkflowGateState> => {
			const invalidated: PrFeedbackPublicationGeneration = {
				...base,
				evidence:
					base.evidence.batches.length > 0
						? base.evidence
						: {
								stageAValidatedAt:
									locked.prFeedbackStageA?.validatedAt ?? 'unknown',
								batches: (locked.prFeedbackGateBatches ?? []).map((batch) => ({
									phase: batch.phase,
									batchId: batch.batchId,
									laneId: batch.laneId,
								})),
							},
				state: 'invalidated',
				workspaceIdentity:
					canonicalWorkspaceIdentity(directory) ?? 'unresolvable',
				localHeadRef: 'unknown',
				localHead: legacy.localHead,
				remoteName: legacy.remoteName,
				remoteUrlIdentity: undefined,
				remoteBranchRef: legacy.remoteBranchRef,
				remoteRef: legacy.remoteRef,
				invalidationReason: reason,
				invalidatedAt: now,
			};
			const nextState: PrWorkflowGateState = {
				...locked,
				updatedAt: now,
				// Same conservative receipt supersession as any invalidation: the
				// legacy approvals are historical-only until the ladder re-runs.
				prFeedbackStageA: undefined,
				prFeedbackVerifications: undefined,
				prFeedbackGateBatches: undefined,
				prFeedbackScopes: undefined,
				prFeedbackReadyToPublish: undefined,
				prFeedbackPublication: nextPublicationContainer(
					locked.prFeedbackPublication,
					invalidated,
				),
			};
			await writeStateWhileLocked(directory, nextState);
			appendPublicationEvent(directory, {
				type: 'pr_feedback_publication_migrated',
				sessionID: locked.sessionID,
				generation: 1,
				outcome: 'invalidated',
				reason,
			});
			return nextState;
		};
		// Receipt consistency first (issue critic #7): the armed record must be
		// backed by the receipts that authorized it.
		if (
			locked.prFeedbackStageA?.revisionDigest !== legacy.revisionDigest ||
			!(locked.prFeedbackGateBatches ?? []).some(
				(batch) => batch.revisionDigest === legacy.revisionDigest,
			)
		) {
			return mismatch('legacy-migration-receipt-mismatch');
		}
		const workspaceIdentity = canonicalWorkspaceIdentity(directory);
		if (!workspaceIdentity) return mismatch('legacy-migration-unresolvable');
		let digest: string;
		try {
			digest = await currentPrFeedbackRevisionDigest(directory, locked);
		} catch {
			return mismatch('legacy-migration-unresolvable');
		}
		const head = (
			await _test_exports.resolveCurrentGitHeadAsync(directory)
		)?.trim();
		const target =
			await _test_exports.resolveCurrentUpstreamPushTargetAsync(directory);
		const localHeadRef = await resolveCurrentLocalHeadRefAsync(directory);
		const remoteUrlIdentity = await _test_exports.resolveRemoteUrlIdentityAsync(
			directory,
			legacy.remoteName,
		);
		if (
			digest !== legacy.revisionDigest ||
			head !== legacy.localHead ||
			!target ||
			target.remoteName !== legacy.remoteName ||
			target.remoteBranchRef !== legacy.remoteBranchRef ||
			target.remoteTrackingRef !== legacy.remoteRef ||
			!localHeadRef ||
			!remoteUrlIdentity
		) {
			return mismatch('legacy-migration-identity-mismatch');
		}
		// Migration-to-armed must meet the SAME evidence strictness as a fresh
		// arm: the full one-batch-per-phase join (review L4). A partial join
		// means the legacy record cannot prove every ordered gate settled —
		// conservatively invalidated, never partially armed.
		const evidenceJoin = buildPublicationEvidenceJoin(
			locked,
			legacy.revisionDigest,
		);
		if (!evidenceJoin) {
			return mismatch('legacy-migration-receipt-mismatch');
		}
		const upgraded: PrFeedbackPublicationGeneration = {
			...base,
			evidence: evidenceJoin,
			state: 'armed',
			workspaceIdentity,
			localHeadRef,
			localHead: legacy.localHead,
			remoteName: legacy.remoteName,
			remoteUrlIdentity,
			remoteBranchRef: legacy.remoteBranchRef,
			remoteRef: legacy.remoteRef,
		};
		const nextState: PrWorkflowGateState = {
			...locked,
			updatedAt: now,
			prFeedbackPublication: nextPublicationContainer(
				locked.prFeedbackPublication,
				upgraded,
			),
		};
		await writeStateWhileLocked(directory, nextState);
		appendPublicationEvent(directory, {
			type: 'pr_feedback_publication_migrated',
			sessionID: locked.sessionID,
			generation: 1,
			outcome: 'armed',
			reason: 'legacy-record-proven-equivalent',
		});
		return nextState;
	});
}

/**
 * The reaper (issue #2108 §3): finalize any result-less push attempt before
 * another armed-window interaction proceeds. Recovers restarts and missed
 * `tool.execute.after` observations as `uncertain` and re-observes the remote
 * head, so `push_in_flight` can never wedge a generation.
 */
async function reconcileForeignInFlightAttempt(
	directory: string,
	sessionID: string,
	currentCallId?: string,
): Promise<PrWorkflowGateState | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		const publication = state?.prFeedbackPublication;
		const active = publication?.active;
		if (
			!state ||
			!publication ||
			!active ||
			active.state !== 'push_in_flight' ||
			!publication.attempts.some((attempt) => !attempt.result)
		) {
			return state;
		}
		const now = isoNow();
		const localHead = (
			await _test_exports.resolveCurrentGitHeadAsync(directory)
		)?.trim();
		const observedRemoteHead =
			await _test_exports.resolveExactRemoteBranchHeadAsync(
				directory,
				active.remoteName,
				active.remoteBranchRef,
			);
		const attempts = publication.attempts.map((attempt) =>
			attempt.result
				? attempt
				: {
						...attempt,
						result: {
							outcome: 'uncertain' as const,
							exitStatus: 'not-observed' as const,
							diagnostic: boundPublicationDiagnostic(
								`recovered without an observed result${
									currentCallId && attempt.callID === currentCallId
										? ' (same call)'
										: ''
								}`,
							),
							postPush: { localHead: localHead ?? null, observedRemoteHead },
							completedAt: now,
						},
					},
		);
		const nextState: PrWorkflowGateState = {
			...state,
			updatedAt: now,
			prFeedbackPublication: nextPublicationContainer(
				publication,
				{ ...active, state: 'armed' },
				[],
				attempts,
			),
		};
		await writeStateWhileLocked(directory, nextState);
		appendPublicationEvent(directory, {
			type: 'pr_feedback_push_attempt_result',
			sessionID: state.sessionID,
			generation: active.generation,
			outcome: 'uncertain',
			by: 'reaper',
			observedRemoteHead,
		});
		return nextState;
	});
}

/**
 * Controller-facing invalidation/rework transition (issue #2108 §4): the
 * explicit declaration that approved content must change, which opens the
 * mutation path by superseding every content-dependent approval of the
 * current armed generation. Requires a non-empty reason. Refuses when no
 * live window exists and reports already-invalidated as an informative
 * diagnostic (idempotent no-op is NOT silently accepted — the caller should
 * see the current state).
 */
export async function invalidatePrFeedbackPublication(
	directory: string,
	sessionID: string,
	reason: string,
): Promise<PrFeedbackPublicationGeneration> {
	const trimmed = reason.trim();
	if (!trimmed) {
		throw new Error(
			'BLOCKED: invalidate_pr_feedback_publication requires a non-empty reason; the reason is part of the durable audit trail',
		);
	}
	// Migrate a legacy armed record first so the transition targets a
	// generation, and reap any foreign in-flight attempt (R3.3).
	await ensurePublicationGenerationCurrent(directory, sessionID);
	await reconcileForeignInFlightAttempt(directory, sessionID);
	const result = await invalidatePublicationGeneration(
		directory,
		sessionID,
		`controller-rework:${trimmed}`,
	);
	return result.generation;
}

/**
 * Operator-facing publication summary for `pr_workflow_status` (issue #2108):
 * generation, state, target, attempts, invalidation reason, and the
 * state-appropriate recovery instruction. Returns null when the workflow has
 * no publication state to describe.
 */
export function describePrWorkflowPublicationSection(
	state: PrWorkflowGateState,
): string | null {
	const active = state.prFeedbackPublication?.active;
	const history = state.prFeedbackPublication?.history ?? [];
	const attempts = state.prFeedbackPublication?.attempts ?? [];
	if (!active && !state.prFeedbackReadyToPublish && history.length === 0) {
		return null;
	}
	const lines: string[] = [];
	if (state.prFeedbackReadyToPublish && !active) {
		lines.push(
			'publication: legacy armed record awaiting generation migration (fail-closed until the next gated interaction migrates it)',
		);
	}
	if (active) {
		lines.push(
			`publication: generation ${active.generation} state=${active.state}`,
		);
		lines.push(
			`  approved: ${active.localHead} -> ${active.remoteName} ${active.remoteBranchRef} (digest ${active.revisionDigest.slice(0, 12)}…)`,
		);
		if (active.remoteUrlIdentity) {
			lines.push(`  remote url identity: ${active.remoteUrlIdentity}`);
		}
		if (active.state === 'invalidated' && active.invalidationReason) {
			lines.push(`  invalidated because: ${active.invalidationReason}`);
		}
		if (active.supersededByGeneration) {
			lines.push(`  superseded by generation ${active.supersededByGeneration}`);
		}
		const generationAttempts = attempts.filter(
			(attempt) => attempt.generation === active.generation,
		);
		if (generationAttempts.length > 0) {
			const outcomes = generationAttempts.map(
				(attempt) => attempt.result?.outcome ?? 'in-flight',
			);
			lines.push(
				`  push attempts: ${generationAttempts.length} (${outcomes.join(', ')})`,
			);
		}
		switch (active.state) {
			case 'armed':
				lines.push(
					'  next: run the exact approved push, then complete_pr_workflow',
				);
				break;
			case 'push_in_flight':
				lines.push(
					'  next: a push attempt is in flight; the next gated interaction reconciles it (uncertain) and re-verifies the remote before any retry',
				);
				break;
			case 'invalidated':
				lines.push(
					'  next: rerun Stage A and every independent gate on the corrected content, then arm a fresh generation with complete_pr_workflow; the exact scoped rework path reopens via prepare_pr_feedback_scope',
				);
				break;
			case 'published':
				lines.push('  terminal: published (verified remote head)');
				break;
			case 'cancelled_without_publication':
				lines.push('  terminal: cancelled without publication');
				break;
			default:
				lines.push('  next: continue the ordered gates');
		}
	}
	if (history.length > 0) {
		const summary = history
			.map(
				(generation) =>
					`gen ${generation.generation}: ${generation.state}${
						generation.supersededByGeneration
							? ` -> ${generation.supersededByGeneration}`
							: ''
					}`,
			)
			.join('; ');
		lines.push(`  superseded generations: ${summary}`);
	}
	lines.push(
		'  audit: full publication trail in the .swarm events store (pr_feedback_publication_*, pr_feedback_push_attempt_*, pr_feedback_published)',
	);
	return lines.join('\n');
}

// ===== Dangling-live-generation guard (issue #2108 safety boundary) =====

const PUBLICATION_EVENT_TYPES = new Set([
	'pr_feedback_publication_armed',
	'pr_feedback_publication_migrated',
	'pr_feedback_push_attempt_started',
	'pr_feedback_publication_invalidated',
	'pr_feedback_published',
	'pr_feedback_publication_cancelled',
]);

/**
 * Issue #2108 safety boundary — "fail closed on corrupt, MISSING, ambiguous,
 * copied, cross-workspace, or conflicting generation state" and "a manual
 * state-file edit … cannot clear the authorization requirement": when the
 * gate state file for a session is absent (e.g. deleted by hand while a
 * generation was live) but the retained events window shows a LIVE
 * publication generation for that session — an `armed` or
 * `push_attempt_started` event with no later terminal (`published`,
 * `cancelled`, `invalidated`) — publication-capable commands fail closed
 * until an audited terminal lands. The events store is the append-only audit
 * authority the state-file deletion cannot touch; when the trail is empty or
 * compacted past the event the guard is silent (it never invents a dangling
 * generation from absent evidence).
 */
export function findDanglingLivePublicationGeneration(
	directory: string,
	sessionID: string,
): { generation: number } | null {
	let text: string;
	try {
		text = readCoreEvents(directory).text;
	} catch {
		return null;
	}
	if (!text.trim()) return null;
	let dangling: { generation: number } | null = null;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (
			typeof event.type !== 'string' ||
			!PUBLICATION_EVENT_TYPES.has(event.type) ||
			event.sessionID !== sessionID
		) {
			continue;
		}
		const generation =
			typeof event.generation === 'number' ? event.generation : null;
		switch (event.type) {
			case 'pr_feedback_publication_armed':
			case 'pr_feedback_push_attempt_started':
				dangling = generation ? { generation } : dangling;
				break;
			case 'pr_feedback_publication_migrated':
				// A successful legacy migration upgraded the record to an
				// ARMED generation 1 — live until a terminal lands. A
				// migration that invalidated is terminal for the window.
				if (event.outcome === 'armed') {
					dangling = generation ? { generation } : dangling;
				} else {
					dangling = null;
				}
				break;
			default:
				// published / cancelled / invalidated are terminal or
				// non-authorizing outcomes for the window.
				dangling = null;
				break;
		}
	}
	// NOTE: a truncated retained window is deliberately NOT treated as
	// ambiguous. Returning null on truncation would turn "grow the events
	// trail past the read bound, then delete the gate file" into a bypass;
	// a false block here is operator-resolvable via the audited cancel arm,
	// a false silence is not. (Reviewer nit deliberately declined.)
	return dangling;
}

// ===== Structural exact-push intent parsing (issue #2108 §2) =====

/** Typed rejection taxonomy for a standalone `git push` command. */
export type ExactPushIntentRejection =
	| 'shell-syntax'
	| 'token-shape'
	| 'flag-or-option'
	| 'credential-bearing-remote'
	| 'invalid-source-sha'
	| 'invalid-dest-ref'
	| 'delete-refspec'
	| 'wildcard-refspec'
	| 'remote-mismatch'
	| 'branch-mismatch'
	| 'source-mismatch'
	| 'unbound-target';

export interface ExactPushIntent {
	remote: string;
	sourceSha: string;
	destRef: string;
}

export interface ExactPushIntentParseResult {
	ok: boolean;
	intent?: ExactPushIntent;
	/** SHA-256 over the canonical intent JSON (persisted in attempt records). */
	digest?: string;
	reason?: ExactPushIntentRejection;
}

/**
 * Fold an audited invalidation into a PENDING single-write state transition
 * (the Stage A re-record and inventory-amendment disarm sites, issue #2108
 * R3.3): when the pending state still carries a live publication window, the
 * generation is marked `invalidated` with the given reason, the rollback
 * mirror and the remaining ancestry-bound receipts (verifications, gate
 * batches, scope declarations) are superseded in the SAME atomic write, and
 * any result-less attempt is finalized `uncertain`. A fresh `prFeedbackStageA`
 * the pending write itself is recording survives — it is evidence recorded
 * after the invalidation moment. No-op when no live window exists (the
 * normal unarmed flow keeps its existing behavior).
 *
 * Returns the pending state plus the audit-event payload; the CALLER appends
 * the event only AFTER its persistState succeeds (PR #2422 review PRR-023:
 * an event must never claim an invalidation whose state write failed — the
 * abort path's retraction discipline, applied here at the source).
 */
function supersedeLivePublicationInPendingState(
	pending: PrWorkflowGateState,
	reason: string,
): {
	state: PrWorkflowGateState;
	invalidationEvent: Record<string, unknown> | null;
} {
	const publication = pending.prFeedbackPublication;
	const active = publication?.active;
	const live =
		pending.prFeedbackReadyToPublish != null ||
		active?.state === 'armed' ||
		active?.state === 'push_in_flight';
	if (!live) return { state: pending, invalidationEvent: null };
	const now = isoNow();
	const attempts = (publication?.attempts ?? []).map((attempt) =>
		attempt.result
			? attempt
			: {
					...attempt,
					result: {
						outcome: 'uncertain' as const,
						exitStatus: 'not-observed' as const,
						diagnostic: `finalized by publication invalidation (${reason})`,
						postPush: { localHead: null, observedRemoteHead: null },
						completedAt: now,
					},
				},
	);
	const invalidatedActive: PrFeedbackPublicationGeneration | undefined = active
		? {
				...active,
				state: 'invalidated',
				invalidatedAt: now,
				invalidationReason: reason,
			}
		: undefined;
	const nextState: PrWorkflowGateState = {
		...pending,
		updatedAt: now,
		prFeedbackReadyToPublish: undefined,
		prFeedbackVerifications: undefined,
		prFeedbackGateBatches: undefined,
		prFeedbackScopes: undefined,
		prFeedbackPublication: active
			? nextPublicationContainer(publication, invalidatedActive, [], attempts)
			: pending.prFeedbackPublication,
	};
	const invalidationEvent = active
		? {
				type: 'pr_feedback_publication_invalidated',
				sessionID: pending.sessionID,
				generation: active.generation,
				reason,
				previousState: active.state,
				drift: null,
				revisionDigest: active.revisionDigest,
				localHead: active.localHead,
				remoteName: active.remoteName,
				remoteBranchRef: active.remoteBranchRef,
				supersededBatchIds: active.evidence.batches.map((b) => b.batchId),
			}
		: null;
	return { state: nextState, invalidationEvent };
}

/**
 * Parse a standalone push command into a typed intent BEFORE any shell
 * execution. The only publish-capable intent is the exact armed tuple —
 * `git push <remote> <localHead>:refs/heads/<branch>` — with NO flags, NO
 * extra refspecs, NO wildcard/delete/mirror/tag forms, and NO
 * credential-bearing remote token. This is a structural refactor of the
 * previous single-regex defense with the SAME accepted grammar (nothing that
 * the regex rejected is accepted here); every rejection is now explicit,
 * typed, and auditable. Remote and branch compare case-SENSITIVELY (git ref
 * semantics); the source SHA compares exactly, as before.
 */
function parseExactBoundPushIntent(
	command: string,
	armed: {
		remoteName: string;
		remoteBranchRef: string;
		localHead: string;
	},
): ExactPushIntentParseResult {
	if (hasUnsafeShellControlSyntax(command)) {
		return { ok: false, reason: 'shell-syntax' };
	}
	if (!armed.remoteBranchRef.startsWith('refs/heads/')) {
		return { ok: false, reason: 'unbound-target' };
	}
	const tokens = command.trim().split(/\s+/);
	if (
		tokens.length !== 4 ||
		tokens[0].toLowerCase() !== 'git' ||
		tokens[1].toLowerCase() !== 'push' ||
		tokens.some((token) => /["'\\]/.test(token))
	) {
		return { ok: false, reason: 'token-shape' };
	}
	const [remoteToken, refspecToken] = [tokens[2], tokens[3]];
	if (remoteToken.startsWith('-') || refspecToken.startsWith('-')) {
		return { ok: false, reason: 'flag-or-option' };
	}
	if (/[:@]/.test(remoteToken) || remoteToken.includes('://')) {
		// A remote NAME never carries userinfo, a colon, or a URL scheme; any
		// such token is a credential-bearing or URL remote form.
		return { ok: false, reason: 'credential-bearing-remote' };
	}
	const refspecParts = refspecToken.split(':');
	if (refspecParts.length !== 2) {
		// Zero colons is a bare ref/tag name; two or more is multiple colon
		// forms. Both fall outside the one exact `sha:refs/heads/...` refspec.
		return {
			ok: false,
			reason: refspecParts.length > 2 ? 'token-shape' : 'invalid-dest-ref',
		};
	}
	const [sourceToken, destToken] = refspecParts;
	if (!destToken.startsWith('refs/heads/') || destToken === 'refs/heads/') {
		return { ok: false, reason: 'invalid-dest-ref' };
	}
	if (sourceToken === '') {
		return { ok: false, reason: 'delete-refspec' };
	}
	if (sourceToken.includes('*') || destToken.includes('*')) {
		return { ok: false, reason: 'wildcard-refspec' };
	}
	// The source must equal the armed local head EXACTLY — that equality (to a
	// value produced by `git rev-parse` in production) binds the push to the
	// approved commit; no separate length heuristic is needed or wanted (the
	// pre-#2108 regex accepted whatever equaled the armed head).
	if (remoteToken !== armed.remoteName) {
		return { ok: false, reason: 'remote-mismatch' };
	}
	if (sourceToken !== armed.localHead) {
		return { ok: false, reason: 'source-mismatch' };
	}
	if (destToken !== armed.remoteBranchRef) {
		return { ok: false, reason: 'branch-mismatch' };
	}
	const intent: ExactPushIntent = {
		remote: remoteToken,
		sourceSha: sourceToken,
		destRef: destToken,
	};
	return {
		ok: true,
		intent,
		digest: createHash('sha256')
			.update(JSON.stringify(intent), 'utf8')
			.digest('hex'),
	};
}

// ===== Push attempt admission, result recording, cancellation =====

/**
 * Durable attempt-start before the exact bound push is permitted to execute
 * (issue #2108 §3), all under ONE session-lock acquisition: re-verify the
 * armed identity, observe the remote head, and either (a) record an
 * attempt whose result is already `completed` because the remote is observed
 * at the approved head (no-op push; the observation — not an exit code — is
 * the truth), or (b) persist the attempt-start and move the generation to
 * `push_in_flight` BEFORE the push can run.
 */
async function admitPrFeedbackPushAttempt(
	directory: string,
	sessionID: string,
	callID: string | undefined,
	intent: ExactPushIntent,
	intentDigest: string,
): Promise<{ kind: 'started' | 'already-published-remotely' }> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	await withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		const active = state?.prFeedbackPublication?.active;
		if (!state || state.mode !== 'PR_FEEDBACK' || !active) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK push admission requires an armed publication generation',
			);
		}
		if (active.state !== 'armed') {
			throw new Error(
				`BLOCKED: PR_FEEDBACK push admission requires the armed state, not ${active.state}`,
			);
		}
		const check = await checkPublicationIdentity(directory, state, active);
		if (check.kind === 'unresolvable') {
			throw new Error(
				`BLOCKED: PR_FEEDBACK could not verify the armed publication identity component "${check.component}" (${check.detail}); the push was not admitted`,
			);
		}
		if (check.kind === 'drift') {
			const invalidation = await applyPublicationInvalidationWhileLocked(
				directory,
				state,
				`drift:${check.component}`,
				{ drift: check },
			);
			throw new Error(
				`BLOCKED: PR_FEEDBACK publication generation ${invalidation.generation.generation} was INVALIDATED because approved content identity drifted (${check.component}: ${check.detail}). Rerun Stage A and every independent gate, then arm a fresh generation with complete_pr_workflow.`,
			);
		}
		const now = isoNow();
		// Defense-in-depth (PR #2422 review L1/L3): re-bind the parsed intent
		// to the freshly-locked generation snapshot. The intent was parsed
		// against the mirror before this lock; the mirror and `active` are
		// written atomically together, but asserting equality here makes the
		// binding explicit and refuses any future divergence path.
		if (
			intent.remote !== active.remoteName ||
			intent.sourceSha !== active.localHead ||
			intent.destRef !== active.remoteBranchRef
		) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK push intent does not match the armed publication generation under the state lock; the push was not admitted',
			);
		}
		const observedRemoteHead =
			await _test_exports.resolveExactRemoteBranchHeadAsync(
				directory,
				active.remoteName,
				active.remoteBranchRef,
			);
		const localHead = (
			await _test_exports.resolveCurrentGitHeadAsync(directory)
		)?.trim();
		const worktreeClean =
			await _test_exports.resolveIsWorkingTreeCleanAsync(directory);
		const baseAttempt: PrFeedbackPushAttempt = {
			attemptId: randomUUID(),
			generation: active.generation,
			sessionID: state.sessionID,
			callID,
			intentDigest,
			intent: {
				remote: intent.remote,
				sourceSha: intent.sourceSha,
				destRef: intent.destRef,
			},
			prePush: {
				localHead: active.localHead,
				worktreeClean: worktreeClean === true,
				remoteName: active.remoteName,
				remoteBranchRef: active.remoteBranchRef,
				observedRemoteHead,
			},
			startedAt: now,
		};
		const remoteAlreadyAtApprovedHead =
			observedRemoteHead?.toLowerCase() === active.localHead.toLowerCase();
		if (remoteAlreadyAtApprovedHead) {
			// The remote branch is already observed at the approved head: record
			// the attempt with an immediate observation-backed `completed`
			// result. This is a no-op push; completion still requires
			// complete_pr_workflow's own remote verification.
			const attempt: PrFeedbackPushAttempt = {
				...baseAttempt,
				result: {
					outcome: 'completed',
					exitStatus: 'not-observed',
					diagnostic:
						'remote branch already observed at the approved head (no-op push)',
					postPush: {
						localHead: localHead ?? null,
						observedRemoteHead: observedRemoteHead ?? null,
					},
					completedAt: now,
				},
			};
			const nextState: PrWorkflowGateState = {
				...state,
				updatedAt: now,
				prFeedbackPublication: nextPublicationContainer(
					state.prFeedbackPublication,
					active,
					[],
					[...(state.prFeedbackPublication?.attempts ?? []), attempt],
				),
			};
			await writeStateWhileLocked(directory, nextState);
			appendPublicationEvent(directory, {
				type: 'pr_feedback_push_attempt_result',
				sessionID: state.sessionID,
				generation: active.generation,
				outcome: 'completed',
				by: 'no-op-observation',
				observedRemoteHead,
			});
			return;
		}
		const nextState: PrWorkflowGateState = {
			...state,
			updatedAt: now,
			prFeedbackPublication: nextPublicationContainer(
				state.prFeedbackPublication,
				{ ...active, state: 'push_in_flight' },
				[],
				[...(state.prFeedbackPublication?.attempts ?? []), baseAttempt],
			),
		};
		await writeStateWhileLocked(directory, nextState);
		appendPublicationEvent(directory, {
			type: 'pr_feedback_push_attempt_started',
			sessionID: state.sessionID,
			generation: active.generation,
			intentDigest,
			intent,
			observedRemoteHead,
		});
	});
	const publication = await readPrWorkflowGateState(
		directory,
		normalizedSessionID,
	);
	const attempts = publication?.prFeedbackPublication?.attempts ?? [];
	const last = attempts[attempts.length - 1];
	return last?.result?.outcome === 'completed'
		? { kind: 'already-published-remotely' }
		: { kind: 'started' };
}

function describeToolOutputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (
		output &&
		typeof output === 'object' &&
		'output' in output &&
		typeof (output as { output?: unknown }).output === 'string'
	) {
		return (output as { output: string }).output;
	}
	try {
		return JSON.stringify(output) ?? '';
	} catch {
		return '';
	}
}

/**
 * Record the result of an admitted push from the `tool.execute.after` chain
 * (issue #2108 §3). Fail-open by design: a missed observation is recovered by
 * the reaper as `uncertain`; publication truth always comes from
 * complete_pr_workflow's direct remote verification, never from an exit code
 * alone. Exported for the single `tool.execute.after` guard in `src/index.ts`.
 */
export async function recordPrFeedbackPushAttemptResult(
	directory: string,
	input: { sessionID: string; callID?: string; tool: string },
	command: string,
	output: unknown,
): Promise<void> {
	// Lowercase defensively: `normalizeToolName` strips namespace prefixes
	// but does NOT lowercase, and harnesses disagree on casing (the tool
	// gate's own classifier lowercases the same way).
	const normalizedTool = (
		normalizeToolName(input.tool) ?? input.tool
	).toLowerCase();
	if (normalizedTool !== 'bash' && normalizedTool !== 'shell') return;
	// NBSP-safe: \s matches \u00A0 where a literal-space startsWith does not,
	// keeping the recorder's shape check aligned with the admission tokenizer.
	if (!/^\s*git\s+push/i.test(command)) return;
	const normalizedSessionID = normalizeSessionID(input.sessionID);
	await withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		const publication = state?.prFeedbackPublication;
		const active = publication?.active;
		if (
			!state ||
			!publication ||
			!active ||
			active.state !== 'push_in_flight' ||
			!input.callID
		) {
			return;
		}
		const attemptIndex = publication.attempts.findIndex(
			(attempt) => !attempt.result && attempt.callID === input.callID,
		);
		if (attemptIndex < 0) return;
		const now = isoNow();
		const localHead = (
			await _test_exports.resolveCurrentGitHeadAsync(directory)
		)?.trim();
		const observedRemoteHead =
			await _test_exports.resolveExactRemoteBranchHeadAsync(
				directory,
				active.remoteName,
				active.remoteBranchRef,
			);
		const remoteVerifiedAtApprovedHead =
			observedRemoteHead?.toLowerCase() === active.localHead.toLowerCase();
		// Exit status (issue #2108 §3): the plugin SDK's tool.execute.after
		// contract exposes only { title, output, metadata } — no structured
		// exit code. When the host DOES populate one on metadata (finite
		// number) it is persisted and drives the `rejected` classification;
		// otherwise the record is honest (`not-observed`) and publication
		// truth remains the remote observation, never the exit code.
		const metadataExit = (
			output as { metadata?: { exitCode?: unknown } } | null | undefined
		)?.metadata?.exitCode;
		const exitStatus: number | 'not-observed' =
			typeof metadataExit === 'number' && Number.isInteger(metadataExit)
				? metadataExit
				: 'not-observed';
		let outcome: PrFeedbackPushAttemptOutcome;
		if (remoteVerifiedAtApprovedHead) {
			outcome = 'completed';
		} else if (exitStatus !== 'not-observed' && exitStatus !== 0) {
			outcome = 'rejected';
		} else {
			outcome = 'uncertain';
		}
		const diagnostic = boundPublicationDiagnostic(
			remoteVerifiedAtApprovedHead
				? `push result observed; remote branch verified at the approved head${
						exitStatus !== 'not-observed' && exitStatus !== 0
							? ` (shell reported nonzero exit ${exitStatus}; the verified remote head is the publication truth)`
							: ''
					}`
				: `push result observed without remote verification at the approved head; exit status ${
						exitStatus === 'not-observed' ? 'not observed' : exitStatus
					}; output: ${describeToolOutputText(output)}`,
		);
		const attempts = publication.attempts.map((attempt, index) =>
			index === attemptIndex
				? {
						...attempt,
						result: {
							outcome,
							exitStatus,
							diagnostic,
							postPush: {
								localHead: localHead ?? null,
								observedRemoteHead: observedRemoteHead ?? null,
							},
							completedAt: now,
						},
					}
				: attempt,
		);
		const nextState: PrWorkflowGateState = {
			...state,
			updatedAt: now,
			prFeedbackPublication: nextPublicationContainer(
				publication,
				{ ...active, state: 'armed' },
				[],
				attempts,
			),
		};
		await writeStateWhileLocked(directory, nextState);
		appendPublicationEvent(directory, {
			type: 'pr_feedback_push_attempt_result',
			sessionID: state.sessionID,
			generation: active.generation,
			outcome,
			exitStatus,
			by: 'tool-after',
			observedRemoteHead,
		});
	});
}

/**
 * Cancellation without publication (issue #2108 §6): a terminal no-publish
 * transition. Finalizes any in-flight attempt as `cancelled`, discloses the
 * observed remote head, marks the generation `cancelled_without_publication`,
 * appends the audit event, and NEVER manufactures push authority. Used only
 * by `abortPrWorkflow`'s explicit `cancelPublication` arm. Returns the NEW
 * state revision when a state write landed (the abort clear must CAS against
 * it), or null when the generation state was absent/unreadable.
 */
async function cancelPrFeedbackPublication(
	directory: string,
	sessionID: string,
	reason: string,
): Promise<number | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	let nextRevision: number | null = null;
	let cancelledGeneration: number | null = null;
	let cancelledAttemptsFinalized = 0;
	try {
		await withSessionStateMutation(directory, normalizedSessionID, async () => {
			const state = await readPrWorkflowGateStateFromDisk(
				directory,
				normalizedSessionID,
			);
			const publication = state?.prFeedbackPublication;
			const active = publication?.active;
			if (!state || !publication || !active) {
				// Unreadable or absent generation state (e.g. salvage path): the
				// audit event below is still appended so the cancellation is
				// durable; the abort clearing that follows removes the gate.
				return;
			}
			if (
				active.state !== 'armed' &&
				active.state !== 'push_in_flight' &&
				active.state !== 'invalidated'
			) {
				return;
			}
			const now = isoNow();
			const observedRemoteHead =
				await _test_exports.resolveExactRemoteBranchHeadAsync(
					directory,
					active.remoteName,
					active.remoteBranchRef,
				);
			const attempts = publication.attempts.map((attempt) =>
				attempt.result
					? attempt
					: {
							...attempt,
							result: {
								outcome: 'cancelled' as const,
								exitStatus: 'not-observed' as const,
								diagnostic: 'finalized by publication cancellation',
								postPush: { localHead: null, observedRemoteHead },
								completedAt: now,
							},
						},
			);
			const cancelled: PrFeedbackPublicationGeneration = {
				...active,
				state: 'cancelled_without_publication',
				cancelledAt: now,
				invalidationReason: active.invalidationReason ?? `cancelled:${reason}`,
			};
			const nextState: PrWorkflowGateState = {
				...state,
				updatedAt: now,
				prFeedbackReadyToPublish: undefined,
				prFeedbackPublication: nextPublicationContainer(
					publication,
					cancelled,
					[],
					attempts,
				),
			};
			const written = await writeStateWhileLocked(directory, nextState);
			nextRevision = written.revision;
			cancelledGeneration = active.generation;
			cancelledAttemptsFinalized = attempts.filter(
				(attempt) => attempt.result?.outcome === 'cancelled',
			).length;
		});
	} catch {
		// The cancellation event below is the durable floor; a failed
		// state write here must not block the audited abort clearing.
	}
	appendPublicationEvent(directory, {
		type: 'pr_feedback_publication_cancelled',
		sessionID: normalizedSessionID,
		...(cancelledGeneration !== null
			? { generation: cancelledGeneration }
			: {}),
		reason,
		...(cancelledAttemptsFinalized > 0
			? { attemptsFinalized: cancelledAttemptsFinalized }
			: {}),
	});
	return nextRevision;
}

async function assertPrFeedbackPublicationArmed(
	directory: string,
	sessionID: string,
	options: { currentCallId?: string } = {},
): Promise<PrWorkflowGateState> {
	// Issue #2108: a legacy armed record first migrates (conservatively) into
	// the generation state machine, and any foreign in-flight push attempt is
	// reconciled (`uncertain`) before the window is judged.
	let state =
		(await ensurePublicationGenerationCurrent(directory, sessionID)) ??
		(await requireBoundState(directory, sessionID, 'PR_FEEDBACK'));
	state =
		(await reconcileForeignInFlightAttempt(
			directory,
			sessionID,
			options.currentCallId,
		)) ??
		state ??
		(await requireBoundState(directory, sessionID, 'PR_FEEDBACK'));
	const active = state.prFeedbackPublication?.active;
	if (
		!active ||
		(active.state !== 'armed' && active.state !== 'push_in_flight')
	) {
		if (active?.state === 'invalidated') {
			throw new Error(
				`BLOCKED: PR_FEEDBACK publication generation ${active.generation} was invalidated${
					active.invalidationReason ? ` (${active.invalidationReason})` : ''
				}; rerun Stage A and every independent gate, then arm a fresh generation with complete_pr_workflow`,
			);
		}
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication is not armed; call complete_pr_workflow once after every ordered gate passes',
		);
	}
	// Identity check outside the lock (issue #2108 §4): the intact path adds no
	// lock traffic. Proven drift invalidates durably under the lock with the
	// drifted component re-verified there; unverifiable stays armed + fails
	// closed (no evidence, no transition).
	const check = await checkPublicationIdentity(directory, state, active);
	if (check.kind === 'unresolvable') {
		throw new Error(
			`BLOCKED: PR_FEEDBACK could not verify the armed publication identity component "${check.component}" (${check.detail}); the armed window is unchanged and fails closed. Resolve the verification failure and retry.`,
		);
	}
	if (check.kind === 'drift') {
		const invalidation = await invalidatePublicationGeneration(
			directory,
			sessionID,
			`drift:${check.component}`,
			{ drift: check, driftReverification: true },
		);
		throw new Error(
			`BLOCKED: PR_FEEDBACK publication generation ${invalidation.generation.generation} was INVALIDATED because approved content identity drifted (${check.component}: ${check.detail}). Every approval of that generation is now superseded. Rerun Stage A and every independent gate, then arm a fresh generation with complete_pr_workflow.`,
		);
	}
	return state;
}

export async function resolvePrReviewWriterRunId(
	directory: string,
	sessionID: string,
	requestedRunId?: string,
): Promise<string> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withPrWorkflowCheckoutMutationLock(directory, () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
			const state = await requireBoundState(
				directory,
				normalizedSessionID,
				'PR_REVIEW',
			);
			const workflowInstanceId = workflowIdentity(state);
			const normalizedRequested = requestedRunId?.trim() || undefined;
			const stateBoundValues = [
				state.prReviewReservedRunId,
				state.prReviewTriggerEvalRunId,
				state.prReviewArtifactRunId,
			].filter((value): value is string => Boolean(value?.trim()));
			const stateDistinct = [...new Set(stateBoundValues)];
			if (
				normalizedRequested &&
				stateDistinct.some((value) => value !== normalizedRequested)
			) {
				if (stateDistinct.length === 1) {
					throw new Error(
						`BLOCKED: field run_id expected "${stateDistinct[0]}", got "${normalizedRequested}"`,
					);
				}
				throw new Error(
					`BLOCKED: field run_id expected one unambiguous active value, got "${normalizedRequested}" while active bindings are ${stateDistinct.join(', ')}`,
				);
			}
			const recoveredReservations = normalizedRequested
				? []
				: await findOwnedPrReviewRunReservations(
						directory,
						normalizedSessionID,
						workflowInstanceId,
					);
			const distinct = [
				...new Set([...stateBoundValues, ...recoveredReservations]),
			];
			if (!normalizedRequested && distinct.length > 1) {
				throw new Error(
					`BLOCKED: field run_id expected one unambiguous active value, got (omitted) while active bindings are ${distinct.join(', ')}`,
				);
			}

			const reserve = async (runId: string): Promise<string | null> => {
				const outcome = await tryCreatePrReviewRunReservation(
					directory,
					normalizedSessionID,
					workflowInstanceId,
					runId,
				);
				return outcome === 'occupied' ? null : runId;
			};

			let resolvedRunId = normalizedRequested ?? distinct[0];
			if (!resolvedRunId) {
				const base = generatePrReviewRunId();
				for (
					let suffix = 0;
					suffix < MAX_PR_REVIEW_RUN_ID_SUFFIX_ATTEMPTS && !resolvedRunId;
					suffix += 1
				) {
					const candidate = suffix === 0 ? base : `${base}-${suffix}`;
					const reserved = await reserve(candidate);
					if (reserved) resolvedRunId = reserved;
				}
				if (!resolvedRunId) {
					throw new Error(
						`BLOCKED: PR_REVIEW run_id generation exhausted ${MAX_PR_REVIEW_RUN_ID_SUFFIX_ATTEMPTS} reservation attempts for base "${base}"`,
					);
				}
			} else if ((await reserve(resolvedRunId)) === null) {
				throw new Error(
					`BLOCKED: field run_id expected an unused active reservation, got "${resolvedRunId}" which is already occupied by another workflow`,
				);
			}

			if (state.prReviewReservedRunId === resolvedRunId) return resolvedRunId;
			const nextState: PrWorkflowGateState = {
				...state,
				updatedAt: isoNow(),
				prReviewReservedRunId: resolvedRunId,
			};
			const persisted = await writeStateWhileLocked(directory, nextState, {
				replaceWorkflowInstanceId: state.workflowInstanceId,
			});
			return persisted.prReviewReservedRunId ?? resolvedRunId;
		}),
	);
}

export async function markPrReviewTriggerEvaluationComplete(
	directory: string,
	sessionID: string,
	runId: string,
	artifactPath: string,
): Promise<PrWorkflowGateState> {
	const state = (await assertPrReviewBaseCoverageSettled(directory, sessionID))
		.state;
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) {
		throw new Error('BLOCKED: PR_REVIEW trigger artifact run_id is required');
	}
	const normalizedPath = artifactPath.trim();
	if (!normalizedPath) {
		throw new Error('BLOCKED: PR_REVIEW trigger artifact path is required');
	}
	// The receipt is consumed once and bound to a single run_id for the session.
	// Mirrors the `prReviewArtifactRunId` equality check used for the findings
	// artifact at `assertPrReviewArtifactBoundary`, closing issue #2124.
	if (
		state.prReviewTriggerEvalRunId &&
		state.prReviewTriggerEvalRunId !== normalizedRunId
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW trigger evaluation is already bound to run "${state.prReviewTriggerEvalRunId}"`,
		);
	}
	// The trigger-eval receipt and the findings artifact share one
	// `.swarm/pr-review/<run_id>/` directory, so their run_ids must agree once
	// either is bound.
	if (
		state.prReviewArtifactRunId &&
		state.prReviewArtifactRunId !== normalizedRunId
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW trigger evaluation run_id must match the findings artifact run "${state.prReviewArtifactRunId}"`,
		);
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewTriggerEvalPath: normalizedPath,
		prReviewTriggerEvalRunId: normalizedRunId,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Freeze one exact inline trigger ledger across every micro dispatch. */
export async function bindPrReviewTriggerLedger(
	directory: string,
	sessionID: string,
	input: unknown,
): Promise<PrWorkflowGateState> {
	let ledger: ReturnType<typeof validatePrReviewInlineTriggerLedger>;
	try {
		ledger = validatePrReviewInlineTriggerLedger(input);
	} catch (error) {
		throw new Error(
			`BLOCKED: invalid PR_REVIEW trigger_evaluation: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const state = (await assertPrReviewBaseCoverageSettled(directory, sessionID))
		.state;
	if (state.prReviewTriggerLedger) {
		let frozen: ReturnType<typeof validatePrReviewInlineTriggerLedger>;
		try {
			frozen = validatePrReviewInlineTriggerLedger(state.prReviewTriggerLedger);
		} catch (error) {
			throw new Error(
				`BLOCKED: persisted PR_REVIEW trigger ledger is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (
			prReviewTriggerLedgerDigest(frozen.rows) !==
			prReviewTriggerLedgerDigest(ledger.rows)
		) {
			throw new Error(
				'BLOCKED: PR_REVIEW trigger_evaluation must remain exactly identical across every micro dispatch',
			);
		}
		return state;
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewTriggerLedger: ledger.rows,
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
	options: { skipBaseCoverage?: boolean } = {},
): Promise<PrWorkflowGateState> {
	let state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	// Issue #2280 Part A: the one exception to trigger-eval-before-findings is
	// the base-only `post_explorer` checkpoint, admissible after base settlement
	// and before the micro wave. The inventory check below then validates
	// against exactly the base-derived candidates: micro sources exist only on
	// the trigger-eval receipt and council sources are gated on the same field,
	// so with no receipt the derivation is structurally base-only. Every other
	// boundary keeps the hard trigger-eval prerequisite, message unchanged.
	const baseOnlyExplorerCheckpoint =
		boundary === 'post_explorer' && !state.prReviewTriggerEvalPath;
	if (!state.prReviewTriggerEvalPath && !baseOnlyExplorerCheckpoint) {
		throw new Error(
			'BLOCKED: PR_REVIEW findings persistence requires the trigger evaluation artifact (write_pr_review_trigger_eval must complete first)',
		);
	}
	if (baseOnlyExplorerCheckpoint && !options.skipBaseCoverage) {
		// The returned state is the freshest snapshot; the assignment threads it
		// through every downstream check here (boundary order, run binding,
		// candidate inventory) rather than mixing two reads of the gate state.
		state = (await assertPrReviewBaseCoverageSettled(directory, sessionID))
			.state;
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
	// One digest resolution and one composed verdict map for this whole gate
	// call: the settlement pass, the critic-inventory derivation and the
	// candidate-inventory check below must all see the same verdicts.
	const ctx = await createPrReviewGateContext(directory, state);
	if (boundary === 'post_reviewer') {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
			ctx,
		);
	} else if (boundary === 'post_critic') {
		await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
			ctx,
		);
		// Empty here must mean "no CONFIRMED CRITICAL/HIGH/MEDIUM verdict exists",
		// never "the reviewer map was empty" or "reviewer never settled".
		if (
			derivePrReviewCriticInventoryForCoverageGate(
				directory,
				state,
				ctx,
				'assertPrReviewArtifactBoundary(post_critic)',
			).length > 0
		) {
			state = await assertPrReviewValidationSettled(
				directory,
				sessionID,
				'critic',
				ctx,
			);
		}
	}
	if (state.prReviewArtifactRunId && state.prReviewArtifactRunId !== runId) {
		throw new Error(
			`BLOCKED: PR_REVIEW artifacts are already bound to run "${state.prReviewArtifactRunId}"`,
		);
	}
	// The findings artifact and the trigger-eval receipt share one
	// `.swarm/pr-review/<run_id>/` directory; once the trigger-eval run_id is
	// bound, findings must use the same run (issue #2124).
	if (
		state.prReviewTriggerEvalRunId &&
		state.prReviewTriggerEvalRunId !== runId
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW findings must use the same run as the trigger evaluation "${state.prReviewTriggerEvalRunId}"`,
		);
	}
	const expectedFindingIds = derivePrReviewCandidateInventory(
		directory,
		state,
		ctx,
	);
	const normalizedFindingIds = [...new Set(findingIds)].sort();
	if (
		normalizedFindingIds.length !== findingIds.length ||
		JSON.stringify(normalizedFindingIds) !==
			JSON.stringify([...expectedFindingIds].sort())
	) {
		const actualSet = new Set(normalizedFindingIds);
		const expectedSet = new Set(expectedFindingIds);
		const missing = [...expectedSet].filter((id) => !actualSet.has(id));
		const extra = [...actualSet].filter((id) => !expectedSet.has(id));
		const duplicates = [
			...new Set(
				findingIds.filter((id, index) => findingIds.indexOf(id) !== index),
			),
		].sort();
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings must exactly cover the discovered candidate inventory; missing: ${missing.join(', ') || '(none)'}; extra: ${extra.join(', ') || '(none)'}; duplicates: ${duplicates.join(', ') || '(none)'}`,
		);
	}
	return state;
}

/**
 * Artifact records are a projection of lane receipts, never a caller-controlled
 * replacement for them. Keep their workflow status/action aligned with the
 * reviewer and critic rows that the gate already authenticated. Every violation
 * across every record is reported in a single rejection, one line per violation
 * with the expected and actual value, so a caller repairs a payload in one
 * round trip instead of one rejected write per defect (issue #2277).
 */
export async function assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
	directory: string,
	sessionID: string,
	boundary: PrReviewArtifactBoundary,
	records: readonly PrReviewArtifactRecord[],
): Promise<void> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const violations: Array<{ findingId: string; detail: string }> = [];
	const report = (
		findingId: string,
		field: string,
		expected: string,
		actual: string,
	): void => {
		violations.push({
			findingId,
			detail: `${field} expected ${expected}, got ${actual}`,
		});
	};
	/**
	 * The severity comparison, unconditional by design. An OMITTED severity is a
	 * mismatch, never a skip: presence-guarding this check (`if (record.severity
	 * && …)`) is what let a caller bypass verification against BOTH the reviewer
	 * and the critic simply by leaving the field out (issue #2279). The message
	 * names the required value, so a caller repairs the payload in one round trip.
	 */
	const reportSeverity = (
		record: PrReviewArtifactRecord,
		expected: string,
	): void => {
		if (record.severity === expected) return;
		// A corrupted artifact must not be misdiagnosed as merely missing the
		// field: an absent key, `null`, and `""` are distinct defects and all
		// previously rendered as `(omitted)` (PRR-008). Widened deliberately —
		// the field is typed to the enum, but the schema leaves it optional and
		// `readFindings` reloads legacy rows without re-validating, so `null` and
		// `""` are reachable at runtime.
		const raw = record.severity as string | null | undefined;
		const actual =
			raw === undefined
				? '(omitted)'
				: raw === null
					? '(null)'
					: raw === ''
						? '(empty)'
						: `"${raw}"`;
		report(record.finding_id, 'severity', `"${expected}"`, actual);
	};
	/**
	 * Typed risk metadata comparison (issue #2383): a CONFIRMED record is a
	 * projection of the authoritative reviewer row, so its risk_impact and
	 * risk_tags must equal that row's typed values — the metadata that decides
	 * critic routing may never drift between the verdict and the artifact.
	 */
	const reportRiskMetadata = (
		record: PrReviewArtifactRecord,
		reviewer: { riskImpact?: PrReviewRiskImpact; riskTags?: PrReviewRiskTag[] },
	): void => {
		if (record.status !== 'CONFIRMED') return;
		const expectedImpact = reviewer.riskImpact ?? 'UNKNOWN';
		const expectedTags = reviewer.riskTags ?? [];
		const actualImpact = record.risk_impact ?? 'UNKNOWN';
		const actualTags = record.risk_tags ?? [];
		if (actualImpact !== expectedImpact) {
			report(
				record.finding_id,
				'risk_impact',
				`"${expectedImpact}"`,
				record.risk_impact === undefined ? '(omitted)' : `"${actualImpact}"`,
			);
		}
		if (actualTags.join(',') !== expectedTags.join(',')) {
			report(
				record.finding_id,
				'risk_tags',
				JSON.stringify(expectedTags),
				record.risk_tags === undefined
					? '(omitted)'
					: JSON.stringify(actualTags),
			);
		}
	};
	if (boundary === 'post_explorer') {
		// The candidate rows the inventory was derived from ARE the authority for
		// this boundary: a post_explorer record is a projection of one
		// `[CANDIDATE]` row, so its severity must equal that row's (issue #2320).
		const candidateSeverities = derivePrReviewCandidateSeverities(
			directory,
			state,
			await createPrReviewGateContext(directory, state),
		);
		for (const record of records) {
			if (record.status !== 'PENDING') {
				report(record.finding_id, 'status', '"PENDING"', `"${record.status}"`);
			}
			if (record.next_action !== 'route_to_reviewer') {
				report(
					record.finding_id,
					'next_action',
					'"route_to_reviewer"',
					`"${record.next_action}"`,
				);
			}
			// A DERIVED AUTHORITY ALWAYS WINS. This ordering is load-bearing:
			// `candidate_id` is unconstrained free text (`analyzeCandidateFields`
			// requires only non-empty), so a lane can legitimately — or
			// maliciously — name a real finding `CLEAN-REVIEW`. Testing the id
			// first let such a record be compared against `NONE` instead of the row
			// it projects, which both accepted a fabricated `NONE` for a CRITICAL
			// row and rejected the truthful value. Consulting the map first makes
			// the sentinel branch reachable only when there is genuinely no row.
			const candidateSeverity = candidateSeverities.get(record.finding_id);
			if (candidateSeverity) {
				// Exact-value comparison against the row that produced this record.
				reportSeverity(record, candidateSeverity);
				continue;
			}
			if (record.finding_id === PR_REVIEW_CLEAN_SENTINEL_ID) {
				// The zero-candidate sentinel, reached only with no row of its own.
				// Its mandated reviewer row carries `NONE` and `post_reviewer`
				// compares against exactly that, so `NONE` is correct here too —
				// requiring anything else would force a clean review to invent a
				// value and then flip it one boundary later.
				reportSeverity(record, 'NONE');
				continue;
			}
			// Unreachable by construction: `assertPrReviewArtifactBoundary` has
			// already forced every id to be in the inventory, and every
			// non-sentinel inventory id is appended from the same row that
			// contributed its severity (a row only enters the inventory once
			// `analyzeCandidateFields` validated its severity). Reported as a
			// violation rather than silently tolerated, so an invariant break
			// fails closed instead of quietly disabling the comparison.
			violations.push({
				findingId: record.finding_id,
				detail:
					'no authoritative candidate severity (absent from the derived candidate inventory)',
			});
		}
	} else {
		const ctx = await createPrReviewGateContext(directory, state);
		// B1: this is the gate that used to emit the misleading "no authoritative
		// reviewer verdict" per record. When the real cause is a settled-but-empty
		// verdict map, the guarded accessors name that cause instead.
		const reviewerVerdicts = authoritativeReviewerVerdictsForGate(
			directory,
			state,
			ctx,
			`assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(${boundary})`,
		);
		const criticVerdicts =
			boundary === 'post_critic'
				? authoritativeCriticVerdictsForGate(
						directory,
						state,
						ctx,
						`assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(${boundary})`,
					)
				: undefined;
		for (const record of records) {
			const reviewer = reviewerVerdicts.get(record.finding_id);
			if (!reviewer) {
				violations.push({
					findingId: record.finding_id,
					detail:
						'no authoritative reviewer verdict (absent from the settled reviewer map)',
				});
				continue;
			}
			const requiresCritic = prReviewFindingRequiresCritic({
				classification: reviewer.classification,
				severity: reviewer.severity,
				risk_impact: reviewer.riskImpact,
				risk_tags: reviewer.riskTags,
			});
			const expectedStatus =
				reviewer.classification === 'UNVERIFIED'
					? 'PENDING'
					: reviewer.classification;
			if (boundary === 'post_reviewer') {
				if (record.status !== expectedStatus) {
					report(
						record.finding_id,
						'status',
						`"${expectedStatus}"`,
						`"${record.status}"`,
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
					report(
						record.finding_id,
						'next_action',
						`"${expectedAction}"`,
						`"${record.next_action}"`,
					);
				}
				reportSeverity(record, reviewer.severity);
				reportRiskMetadata(record, reviewer);
				continue;
			}

			// post_critic, non-critic-routed: the reviewer disposition is final.
			if (!requiresCritic) {
				const expectedAction =
					reviewer.classification === 'CONFIRMED' ||
					reviewer.classification === 'PRE_EXISTING'
						? 'report'
						: reviewer.classification === 'DISPROVED'
							? 'suppress_with_reason'
							: 'route_to_reviewer';
				if (record.status !== expectedStatus) {
					report(
						record.finding_id,
						'status',
						`"${expectedStatus}"`,
						`"${record.status}"`,
					);
				}
				if (record.next_action !== expectedAction) {
					report(
						record.finding_id,
						'next_action',
						`"${expectedAction}"`,
						`"${record.next_action}"`,
					);
				}
				reportSeverity(record, reviewer.severity);
				reportRiskMetadata(record, reviewer);
				continue;
			}

			// post_critic, critic-routed: the critic verdict is authoritative.
			const critic = criticVerdicts?.get(record.finding_id);
			if (!critic) {
				// No critic verdict settled: the reviewer severity is the best
				// available authority, and the missing-critic violation below is
				// reported alongside it.
				reportSeverity(record, reviewer.severity);
				reportRiskMetadata(record, reviewer);
				violations.push({
					findingId: record.finding_id,
					detail:
						'no authoritative critic verdict (absent from the settled critic map)',
				});
				continue;
			}
			if (critic.status === 'DISPROVED') {
				if (record.status !== 'DISPROVED') {
					report(
						record.finding_id,
						'status',
						'"DISPROVED"',
						`"${record.status}"`,
					);
				}
				if (record.next_action !== 'suppress_with_reason') {
					report(
						record.finding_id,
						'next_action',
						'"suppress_with_reason"',
						`"${record.next_action}"`,
					);
				}
			} else {
				if (record.status !== 'CONFIRMED') {
					report(
						record.finding_id,
						'status',
						'"CONFIRMED"',
						`"${record.status}"`,
					);
				}
				if (!['report', 'handoff_to_feedback'].includes(record.next_action)) {
					report(
						record.finding_id,
						'next_action',
						'"report" or "handoff_to_feedback"',
						`"${record.next_action}"`,
					);
				}
			}
			// The critic is the FINAL word for a critic-routed item, so its severity
			// is the single authority here — including when it downgrades the
			// reviewer (reviewer MEDIUM -> critic LOW), which is now encodable
			// verbatim as `severity: "LOW"`. The previous code compared against the
			// reviewer when the two agreed and, when they disagreed, instructed the
			// caller to omit the field — which disabled the check entirely
			// (issue #2279).
			reportSeverity(record, critic.severity);
		}
	}
	if (violations.length > 0) {
		violations.sort((left, right) =>
			left.findingId < right.findingId
				? -1
				: left.findingId > right.findingId
					? 1
					: 0,
		);
		const lines = violations.map(
			(violation) => `  ${violation.findingId}: ${violation.detail}`,
		);
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} artifact invalid — ${violations.length} violation(s):\n${lines.join('\n')}`,
		);
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
): Promise<{ state: PrWorkflowGateState; alreadyOffered: boolean }> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withPrWorkflowCheckoutMutationLock(directory, () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
			const state = await requireBoundState(
				directory,
				normalizedSessionID,
				'PR_REVIEW',
			);
			if (
				state.prReviewArtifactRunId !== runId ||
				!(state.prReviewArtifactBoundaries ?? []).includes('post_critic')
			) {
				throw new Error(
					'BLOCKED: PR_REVIEW handoff requires the final findings boundary for the same run',
				);
			}
			const read = await readPrReviewFeedbackHandoffArtifact(
				directory,
				artifactPath,
			);
			const command = `/swarm pr-feedback ${read.artifact.pr_url} continue from .swarm/${artifactPath}`;
			const consentInput = {
				sessionID: normalizedSessionID,
				runId,
				handoffPath: artifactPath,
				handoffDigest: read.digest,
				prUrl: read.artifact.pr_url,
				prHeadSha: read.artifact.pr_head_sha,
				findingIdsDigest: hashPrReviewFindingIds(read.artifact.finding_ids),
				sourceWorkflowInstanceId: workflowIdentity(state),
			};
			const existing = await readPrReviewFeedbackConsent(directory, runId);
			const alreadyOffered = existing !== null;
			if (existing) {
				assertMatchingPrReviewFeedbackConsent(existing, consentInput);
			} else {
				await writePrReviewFeedbackConsent(directory, {
					schema_version: 1,
					state: 'offered',
					session_id: normalizedSessionID,
					source_workflow_instance_id: workflowIdentity(state),
					run_id: runId,
					handoff_path: artifactPath,
					handoff_digest: read.digest,
					pr_url: read.artifact.pr_url,
					pr_head_sha: read.artifact.pr_head_sha.toLowerCase(),
					finding_ids_digest: consentInput.findingIdsDigest,
					confirmation_command: command,
					offered_at: isoNow(),
				});
			}
			if (alreadyOffered && state.prReviewHandoffPath === artifactPath) {
				return { state, alreadyOffered: true };
			}
			const nextState: PrWorkflowGateState = {
				...state,
				updatedAt: isoNow(),
				prReviewHandoffPath: artifactPath,
			};
			return {
				state: await writeStateWhileLocked(directory, nextState),
				alreadyOffered,
			};
		}),
	);
}

const PR_REVIEW_HANDOFF_RELATIVE_PATH_PATTERN =
	/^pr-review\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/feedback-handoff\.json$/;
const PR_REVIEW_FEEDBACK_CONSENT_MAX_BYTES = 64 * 1024;
const PR_REVIEW_RUN_RESERVATION_MAX_BYTES = 16 * 1024;

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

const PrReviewRunReservationSchema = z
	.object({
		schema_version: z.literal(1),
		session_id: z.string().min(1),
		workflow_instance_id: z.string().min(1),
		run_id: z.string().min(1).max(128),
		reserved_at: z.string().datetime(),
	})
	.strict();

const PrReviewFeedbackConsentSchema = z
	.object({
		schema_version: z.literal(1),
		state: z.enum(['offered', 'confirmed']),
		session_id: z.string().min(1),
		source_workflow_instance_id: z.string().min(1),
		run_id: z.string().min(1).max(128),
		handoff_path: z.string().min(1).max(512),
		handoff_digest: z.string().regex(/^[a-f0-9]{64}$/),
		pr_url: z.string().url().max(2000),
		pr_head_sha: z.string().regex(/^[0-9a-f]{6,64}$/i),
		finding_ids_digest: z.string().regex(/^[a-f0-9]{64}$/),
		confirmation_command: z.string().min(1).max(4000),
		offered_at: z.string().datetime(),
		confirmed_at: z.string().datetime().optional(),
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

function buildAcceptedPrFeedbackContinuationCommands(
	confirmationCommand: string,
	relativeHandoffPath: string,
	requestedPrUrl?: string,
): Set<string> {
	const commands = new Set([confirmationCommand]);
	if (!requestedPrUrl) {
		commands.add(
			`/swarm pr-feedback continue from .swarm/${relativeHandoffPath}`,
		);
	}
	return commands;
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

function prReviewRunReservationRelativePath(runId: string): string {
	return `pr-review/${runId}/run-reservation.json`;
}

function prReviewFeedbackConsentRelativePath(runId: string): string {
	return `pr-review/${runId}/feedback-consent.json`;
}

const MAX_PR_REVIEW_RESERVATION_SCAN_ENTRIES = 1024;
const MAX_PR_REVIEW_RUN_ID_SUFFIX_ATTEMPTS = 64;

/**
 * Recover a reservation that reached disk before its gate-state binding did.
 * The scan is bounded and runs only in the explicit writer path while the
 * project checkout lock is held; it is never plugin-initialization work.
 */
async function findOwnedPrReviewRunReservations(
	directory: string,
	sessionID: string,
	workflowInstanceId: string,
): Promise<string[]> {
	const reviewRoot = validateSwarmPath(directory, 'pr-review');
	let entries: Dirent<string>[];
	try {
		entries = await fsp.readdir(reviewRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	if (entries.length > MAX_PR_REVIEW_RESERVATION_SCAN_ENTRIES) {
		throw new Error(
			`BLOCKED: PR_REVIEW reservation recovery expected at most ${MAX_PR_REVIEW_RESERVATION_SCAN_ENTRIES} run entries, got ${entries.length}`,
		);
	}

	const owned: string[] = [];
	for (const entry of entries) {
		if (
			!entry.isDirectory() ||
			!PrReviewRunIdSchema.safeParse(entry.name).success
		)
			continue;
		let reservation: Awaited<ReturnType<typeof readPrReviewRunReservation>>;
		try {
			reservation = await readPrReviewRunReservation(directory, entry.name);
		} catch {
			// An unrelated corrupt reservation is occupied but cannot establish
			// ownership for this workflow. Explicit reuse still fails in `reserve`.
			continue;
		}
		if (
			reservation?.session_id === sessionID &&
			reservation.workflow_instance_id === workflowInstanceId &&
			reservation.run_id === entry.name
		) {
			owned.push(entry.name);
		}
	}
	return owned.sort();
}

function hashPrReviewFindingIds(ids: readonly string[]): string {
	return createHash('sha256')
		.update([...new Set(ids)].sort().join('\0'), 'utf8')
		.digest('hex');
}

async function readPrReviewRunReservation(
	directory: string,
	runId: string,
): Promise<z.infer<typeof PrReviewRunReservationSchema> | null> {
	try {
		const raw = await readBoundedSwarmRegularFile(
			directory,
			prReviewRunReservationRelativePath(runId),
			PR_REVIEW_RUN_RESERVATION_MAX_BYTES,
			'PR_REVIEW run reservation',
		);
		const parsed = PrReviewRunReservationSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			throw new Error('BLOCKED: PR_REVIEW run reservation is invalid');
		}
		return parsed.data;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('does not exist')) return null;
		throw error;
	}
}

async function tryCreatePrReviewRunReservation(
	directory: string,
	sessionID: string,
	workflowInstanceId: string,
	runId: string,
): Promise<'created' | 'owned' | 'occupied'> {
	const relativePath = prReviewRunReservationRelativePath(runId);
	const absolutePath = validateSwarmPath(directory, relativePath);
	const runDirectory = path.dirname(absolutePath);
	const payload = `${JSON.stringify(
		{
			schema_version: 1,
			session_id: sessionID,
			workflow_instance_id: workflowInstanceId,
			run_id: runId,
			reserved_at: isoNow(),
		},
		null,
		2,
	)}\n`;
	await fsp.mkdir(runDirectory, { recursive: true });
	try {
		await fsp.writeFile(absolutePath, payload, {
			encoding: 'utf8',
			flag: 'wx',
		});
		return 'created';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const existing = await readPrReviewRunReservation(directory, runId);
	if (
		existing?.session_id === sessionID &&
		existing.workflow_instance_id === workflowInstanceId &&
		existing.run_id === runId
	) {
		return 'owned';
	}
	const occupiedNames = new Set([
		'trigger-eval.json',
		'findings.jsonl',
		'feedback-handoff.json',
		'feedback-consent.json',
	]);
	try {
		const entries = await fsp.readdir(runDirectory);
		if (entries.some((entry) => occupiedNames.has(entry))) return 'occupied';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	return 'occupied';
}

async function readPrReviewFeedbackConsent(
	directory: string,
	runId: string,
): Promise<z.infer<typeof PrReviewFeedbackConsentSchema> | null> {
	try {
		const raw = await readBoundedSwarmRegularFile(
			directory,
			prReviewFeedbackConsentRelativePath(runId),
			PR_REVIEW_FEEDBACK_CONSENT_MAX_BYTES,
			'PR_REVIEW feedback consent artifact',
		);
		const parsed = PrReviewFeedbackConsentSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			throw new Error(
				'BLOCKED: PR_REVIEW feedback consent artifact is invalid',
			);
		}
		return parsed.data;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('does not exist')) return null;
		throw error;
	}
}

async function writePrReviewFeedbackConsent(
	directory: string,
	record: z.infer<typeof PrReviewFeedbackConsentSchema>,
): Promise<void> {
	const relativePath = prReviewFeedbackConsentRelativePath(record.run_id);
	const absolutePath = validateSwarmPath(directory, relativePath);
	if (record.state === 'confirmed') {
		// The existing offer must be replaced portably. The shared atomic writer
		// provides containment checks, fsync, and bounded Windows rename retries.
		await writeAtomicJson(directory, absolutePath, record);
		return;
	}
	const parent = path.dirname(absolutePath);
	const tempPath = path.join(parent, `.feedback-consent.${randomUUID()}.tmp`);
	await fsp.mkdir(parent, { recursive: true });
	try {
		await fsp.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
			encoding: 'utf8',
			flag: 'wx',
		});
		// Link publishes the offer as an atomic create-only commit marker. A
		// concurrent or stale offer can never be silently overwritten.
		await fsp.link(tempPath, absolutePath);
	} finally {
		await fsp.rm(tempPath, { force: true }).catch(() => undefined);
	}
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

function assertMatchingPrReviewFeedbackConsent(
	record: z.infer<typeof PrReviewFeedbackConsentSchema>,
	input: {
		sessionID: string;
		runId: string;
		handoffPath: string;
		handoffDigest: string;
		prUrl: string;
		prHeadSha: string;
		findingIdsDigest: string;
		sourceWorkflowInstanceId: string;
	},
): void {
	if (
		record.session_id !== input.sessionID ||
		record.run_id !== input.runId ||
		record.handoff_path !== input.handoffPath ||
		record.handoff_digest !== input.handoffDigest ||
		canonicalGitHubPrUrl(record.pr_url) !== canonicalGitHubPrUrl(input.prUrl) ||
		record.pr_head_sha.toLowerCase() !== input.prHeadSha.toLowerCase() ||
		record.finding_ids_digest !== input.findingIdsDigest ||
		record.source_workflow_instance_id !== input.sourceWorkflowInstanceId
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW feedback consent artifact does not match the requested handoff; remove the stale sidecar or repeat the exact continuation offer',
		);
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
	laneLiveness?: PrWorkflowLaneLivenessOptions,
): Promise<{
	state: PrWorkflowGateState;
	settlement: PrReviewTerminalCoverageSettlement & {
		liveDimensions: PrReviewBaseDimensionId[];
	};
}> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	await assertPrReviewCleanCheckout(directory, 'PR_REVIEW');
	// W-4 (issue #2242 R2): stale lanes settle with disclosure; fresh ones block.
	const laneSettlement = await settlePresumedStalePrWorkflowLanes(
		directory,
		state.sessionID,
		laneLiveness,
	);
	if (laneSettlement.openLanes > 0) {
		throw new Error(
			`BLOCKED: PR_REVIEW transition has ${laneSettlement.openLanes} unsettled PR workflow lane(s)` +
				describePrWorkflowLaneProbe(laneSettlement),
		);
	}
	// One digest + one composed verdict map for the entire terminal check.
	const ctx = await createPrReviewGateContext(directory, state);
	const { settlement } = await assertPrReviewBaseCoverageSettled(
		directory,
		sessionID,
		ctx,
	);
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
		await assertPrReviewValidationSettled(directory, sessionID, 'council', ctx);
	}
	await assertPrReviewValidationSettled(directory, sessionID, 'reviewer', ctx);
	// The critic-coverage gate. `length === 0` skips the critic phase entirely,
	// so it must provably mean "no CONFIRMED CRITICAL/HIGH/MEDIUM reviewer
	// verdict exists" — not "reviewer never settled" and not "the authoritative
	// reviewer map came back empty". Both pathologies BLOCK inside this call.
	const criticInventory = derivePrReviewCriticInventoryForCoverageGate(
		directory,
		state,
		ctx,
		'completePrWorkflow critic-coverage gate',
	);
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
		await assertPrReviewValidationSettled(directory, sessionID, 'critic', ctx);
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
	return { state, settlement };
}

export async function transitionPrReviewToFeedback(
	directory: string,
	sessionID: string,
	request: {
		runId: string;
		handoffPath: string;
		prUrl?: string;
		exactCommand?: string;
		confirmedByUser?: boolean;
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
	let expectedConsentSourceIdentity: string;
	let sourceRevision = 0;
	let provenance: PrFeedbackReviewHandoffRecord['provenance'];
	if (preliminary) {
		if (preliminary.mode !== 'PR_REVIEW') {
			throw wrongModeError(preliminary, 'PR_REVIEW');
		}
		const ready = (
			await assertPrReviewTerminalReady(directory, normalizedSessionID)
		).state;
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
		expectedConsentSourceIdentity = sourceIdentity;
		sourceRevision = ready.revision;
		provenance = 'active-review-v1';
	} else {
		const reservation = await readPrReviewRunReservation(
			directory,
			request.runId,
		);
		if (
			!reservation ||
			reservation.session_id !== normalizedSessionID ||
			reservation.run_id !== request.runId
		) {
			throw new Error(
				'BLOCKED: completed PR_REVIEW continuation requires the matching durable run reservation for this session',
			);
		}
		expectedConsentSourceIdentity = reservation.workflow_instance_id;
		sourceIdentity = expectedConsentSourceIdentity;
		provenance = 'external-v1';
	}

	const consent = await readPrReviewFeedbackConsent(directory, request.runId);
	if (!consent) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK continuation requires explicit confirmation; repeat the exact continuation command first',
		);
	}
	assertMatchingPrReviewFeedbackConsent(consent, {
		sessionID: normalizedSessionID,
		runId: request.runId,
		handoffPath: normalizedHandoff.relativePath,
		handoffDigest: preliminaryRead.digest,
		prUrl: artifact.pr_url,
		prHeadSha: artifact.pr_head_sha,
		findingIdsDigest: hashPrReviewFindingIds(artifact.finding_ids),
		sourceWorkflowInstanceId: expectedConsentSourceIdentity,
	});
	const exactCommand = request.exactCommand?.trim();
	const acceptedContinuationCommands =
		buildAcceptedPrFeedbackContinuationCommands(
			consent.confirmation_command,
			normalizedHandoff.relativePath,
			request.prUrl,
		);
	if (
		request.confirmedByUser !== true ||
		!exactCommand ||
		!acceptedContinuationCommands.has(exactCommand)
	) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK continuation requires explicit confirmation with the offered command: ${consent.confirmation_command}`,
		);
	}

	await _test_exports.beforePrFeedbackTransitionLock?.();
	return withPrWorkflowCheckoutMutationLock(directory, () =>
		withSessionStateMutation(directory, normalizedSessionID, async () => {
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
			if (provenance === 'external-v1') {
				const lockedReservation = await readPrReviewRunReservation(
					directory,
					request.runId,
				);
				if (
					!lockedReservation ||
					lockedReservation.session_id !== normalizedSessionID ||
					lockedReservation.workflow_instance_id !==
						expectedConsentSourceIdentity
				) {
					throw new Error(
						'BLOCKED: PR_REVIEW run reservation changed during external feedback transition',
					);
				}
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
			const lockedConsent = await readPrReviewFeedbackConsent(
				directory,
				request.runId,
			);
			if (!lockedConsent) {
				throw new Error(
					'BLOCKED: PR_REVIEW feedback consent artifact disappeared during transition',
				);
			}
			assertMatchingPrReviewFeedbackConsent(lockedConsent, {
				sessionID: normalizedSessionID,
				runId: request.runId,
				handoffPath: normalizedHandoff.relativePath,
				handoffDigest: lockedRead.digest,
				prUrl: lockedRead.artifact.pr_url,
				prHeadSha: lockedRead.artifact.pr_head_sha,
				findingIdsDigest: hashPrReviewFindingIds(
					lockedRead.artifact.finding_ids,
				),
				sourceWorkflowInstanceId: expectedConsentSourceIdentity,
			});
			if (
				!buildAcceptedPrFeedbackContinuationCommands(
					lockedConsent.confirmation_command,
					normalizedHandoff.relativePath,
					request.prUrl,
				).has(exactCommand)
			) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK continuation command changed during transition',
				);
			}
			if (lockedConsent.state === 'offered') {
				await writePrReviewFeedbackConsent(directory, {
					...lockedConsent,
					state: 'confirmed',
					confirmed_at: isoNow(),
				});
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
		}),
	);
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
	expected: Pick<
		PrFeedbackScopeDeclarationRecord,
		'declaredAt' | 'revisionDigest' | 'files'
	>,
): Promise<PrFeedbackScopeDeclarationRecord | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!state || state.mode !== 'PR_FEEDBACK') return null;
		const declaration = (state.prFeedbackScopes ?? []).find(
			(entry) => entry.taskId === taskId,
		);
		if (!declaration) return null;
		// The declaration was classified before this lock was acquired so caller
		// directives could be checked without holding the workflow-state lock. Pin
		// the reservation to that exact snapshot: a controller replacement must
		// never consume new authority while publishing files from the old record.
		if (
			declaration.declaredAt !== expected.declaredAt ||
			declaration.revisionDigest !== expected.revisionDigest ||
			JSON.stringify(declaration.files) !== JSON.stringify(expected.files)
		) {
			return null;
		}
		const currentDigest = await assertPrFeedbackVerificationSettledState(
			directory,
			state,
		);
		if (currentDigest !== declaration.revisionDigest) return null;
		if (
			declaration.consumedByCallId &&
			declaration.consumedByCallId !== callID
		) {
			throw new Error(
				`SCOPE_NOT_DECLARED: PR-feedback scope ${taskId} was already consumed by another Task call`,
			);
		}
		if (declaration.consumedByCallId === callID) return declaration;
		const consumed = { ...declaration, consumedByCallId: callID };
		await writeStateWhileLocked(directory, {
			...state,
			updatedAt: isoNow(),
			prFeedbackScopes: (state.prFeedbackScopes ?? []).map((entry) =>
				entry.taskId === taskId ? consumed : entry,
			),
		});
		return consumed;
	});
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
	callID?: string,
): Promise<void> {
	let state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) {
		// Issue #2108 safety boundary: a hand-DELETED gate state file must not
		// silently reopen arbitrary pushes for a session whose events trail
		// still shows a LIVE publication generation. Publication-capable
		// commands fail closed until an audited terminal (the cancel arm in
		// abortPrWorkflow appends one even without gate state); every other
		// command proceeds — the guard never blocks on absent/compacted
		// evidence.
		const normalizedEarlyTool = toolName.toLowerCase();
		if (normalizedEarlyTool === 'bash' || normalizedEarlyTool === 'shell') {
			const earlyCommand =
				typeof args?.command === 'string' ? args.command.trim() : '';
			// ANY git-push-shaped invocation holds, however it is wrapped —
			// `git -c/-C … push`, env assignments, `env [-i] …`, nohup/nice/
			// timeout wrappers, compound `git status && git push`. Also held:
			// `git send-pack` (the plumbing command `git push` itself invokes,
			// force-update capable) and `gh api` calls touching `refs/heads/`
			// (the refs PATCH path). This is the last line of defense for the
			// state-absent case with a LIVE generation in the audit trail, so
			// it deliberately over-matches rather than under-matching any
			// wrapper form; the over-block is operator-resolvable via the
			// audited cancel arm.
			const publicationShaped =
				(/\bgit\b/.test(earlyCommand) &&
					(/\bpush\b/.test(earlyCommand) ||
						/\bsend-pack\b/.test(earlyCommand))) ||
				(/\bgh\s+api\b/i.test(earlyCommand) &&
					/refs\/heads\//.test(earlyCommand));
			if (publicationShaped) {
				const dangling = findDanglingLivePublicationGeneration(
					directory,
					sessionID,
				);
				if (dangling) {
					throw new Error(
						`BLOCKED: PR_FEEDBACK publication generation ${dangling.generation} for this session is live in the audit trail but its gate state is missing (deleted or moved by hand). Publication commands fail closed until the window is resolved: use abort_pr_workflow with kind "cancel-publication", cancel_publication: true, and a reason to record the audited no-publish terminal, or restore the gate state from backup.`,
					);
				}
			}
		}
		return;
	}
	// Issue #2108: a legacy armed record migrates (conservatively, under the
	// session lock) into the publication-generation state machine before any
	// armed-window decision is made below.
	if (
		state.mode === 'PR_FEEDBACK' &&
		state.prFeedbackReadyToPublish &&
		!state.prFeedbackPublication
	) {
		state =
			(await ensurePublicationGenerationCurrent(directory, sessionID)) ?? state;
	}
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
	const isAllowlistedReadOnlyTool =
		normalizedTool !== 'build_check' &&
		isAllowedPrReviewReadOnlyToolName(normalizedTool);
	const readOnlyArgumentClassification = isAllowlistedReadOnlyTool
		? classifyReadOnlyToolArguments(normalizedTool, args ?? {})
		: null;
	const isNamedReadOnlyTool =
		isTrustedWorkflowTool ||
		(isAllowlistedReadOnlyTool &&
			readOnlyArgumentClassification?.safe === true);
	const isRecoverySafeEvidenceTool =
		(trustedCapability === 'observe' &&
			isTrustedPrWorkflowToolInvocationSafe(normalizedTool, args ?? {})) ||
		(isAllowlistedReadOnlyTool &&
			readOnlyArgumentClassification?.safe === true);
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
		state.mode === 'PR_REVIEW' &&
		isAllowlistedReadOnlyTool &&
		readOnlyArgumentClassification?.safe === false
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW is read-only; tool "${normalizedTool}" rejected argument "${readOnlyArgumentClassification.path}": ${readOnlyArgumentClassification.constraint}`,
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
		let hasAuthorizedDirectReentry = false;
		if (
			isDirectAgentTask &&
			requestedAgentFields.length === 1 &&
			requestedAgentFields[0] === 'subagent_type' &&
			requestedRoles.length === 1 &&
			(requestedRoles[0] === 'reviewer' ||
				requestedRoles[0] === 'test_engineer') &&
			callID
		) {
			hasAuthorizedDirectReentry = await hasActivePrReviewReentryAuthorization(
				directory,
				sessionID,
				{
					role: requestedRoles[0],
				},
			);
		}
		const isAllowedReviewTool =
			isInternalWorkflowTool ||
			hasAuthorizedDirectReentry ||
			isNamedReadOnlyTool ||
			(isReadOnlyShell && (!isShellCheckout || isCanonicalReviewCheckout));
		if (
			!isAllowedReviewTool ||
			(Boolean(state.prHeadSha) && (isRemoteCheckoutTool || isShellCheckout))
		) {
			if (!state.prHeadSha && isShellCheckout) {
				throw new Error(
					'BLOCKED: PR_REVIEW checkout must use standalone commands: fetch the PR head, run `git rev-parse --verify <full_pr_head_sha>^0`, run `git cat-file -t <full_pr_head_sha>` (which must print `commit`), then run `git switch --detach <full_pr_head_sha>` and bind that exact head before dispatching explorer lanes. Do not use `--track FETCH_HEAD`.' +
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
		// NOTE (issue #2108): plain abort remains deliberately NOT allowed in
		// the armed state — clearing an armed gate would drop the
		// immutable-commit / upstream binding and leave a half-published
		// commit; once state is null, enforcePrWorkflowToolBefore returns
		// early and arbitrary pushes would become allowed. abortPrWorkflow
		// also refuses armed state at the hook level (defense in depth). Two
		// audited exits now exist: the explicit invalidation/rework transition
		// (`invalidate_pr_feedback_publication`, which supersedes every
		// approval and reopens the full ladder) and the terminal no-publish
		// cancellation (`abort_pr_workflow` with `cancel_publication: true`,
		// enforced at the hook level to require a reason and to never
		// manufacture push authority).
		if (normalizedTool === 'complete_pr_workflow') return;
		if (normalizedTool === 'invalidate_pr_feedback_publication') return;
		if (
			normalizedTool === 'abort_pr_workflow' &&
			args?.cancel_publication === true
		)
			return;
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
				{ currentCallId: callID },
			);
			const armed = armedState.prFeedbackReadyToPublish!;
			const intent = parseExactBoundPushIntent(command, armed);
			if (intent.ok && intent.intent && intent.digest) {
				// Durable attempt-start (or observation-backed no-op completion)
				// lands BEFORE the shell may execute the push (issue #2108 §3).
				await admitPrFeedbackPushAttempt(
					directory,
					sessionID,
					callID,
					intent.intent,
					intent.digest,
				);
				return;
			}
			throw new Error(
				`BLOCKED: PR_FEEDBACK is armed for publication; only the exact approved push is allowed: ${expectedBoundPushCommand(armed)}${intent.reason ? ` (rejected form: ${intent.reason})` : ''}`,
			);
		}
		throw new Error(
			'BLOCKED: PR_FEEDBACK is armed for publication; only read-only inspection, the exact approved push, and complete_pr_workflow are allowed. To change approved content, use invalidate_pr_feedback_publication (audited invalidation; the full ladder re-runs) or abort_pr_workflow with cancel_publication for a terminal no-publish cancellation',
		);
	}
	if (!state.prHeadSha && normalizedTool === 'prepare_pr_workflow_checkout') {
		return;
	}
	if (
		!state.prHeadSha &&
		isDetachedFeedbackCheckout &&
		!isCanonicalReviewCheckout
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK checkout should use one exact local tracking branch, such as `gh pr checkout <number> --branch <local_branch>` or `git switch -c <local_branch> --track <remote>/<branch>`, before binding. If checkout is already detached at the authoritative full PR head SHA, bind it directly; the controller attaches one unambiguous exact tracking ref. Other detached refs are not accepted',
		);
	}
	if (!state.prHeadSha && isCanonicalReviewCheckout) return;
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
				'BLOCKED: PR_FEEDBACK checkout should use one exact local tracking branch, such as `gh pr checkout <number> --branch <local_branch>` or `git switch -c <local_branch> --track <remote>/<branch>`, before binding. If checkout is already detached at the authoritative full PR head SHA, bind it directly; the controller attaches one unambiguous exact tracking ref',
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
/**
 * Read-only identity binding for reviewer re-entry authorization (issue
 * #2383). Returns the exact active-session PR_REVIEW identity a one-use
 * authorization must be issued against and re-verified under at consume time:
 * bound head SHA, current worktree revision digest, gate generation (CAS
 * revision), workflow instance id, and the active run id. Null when no active
 * head-bound PR_REVIEW gate exists for the session.
 */
export async function readPrReviewReentryBindingContext(
	directory: string,
	sessionID: string,
): Promise<PrReviewReentryBindingContext | null> {
	const state = await readPrWorkflowGateStateFromDisk(
		directory,
		normalizeSessionID(sessionID),
	);
	return state ? prReviewReentryBindingFromState(directory, state) : null;
}

async function prReviewReentryBindingFromState(
	directory: string,
	state: PrWorkflowGateState,
): Promise<PrReviewReentryBindingContext | null> {
	if (state.mode !== 'PR_REVIEW' || !state.prHeadSha) return null;
	const ctx = await createPrReviewGateContext(directory, state);
	return {
		prHeadSha: state.prHeadSha,
		revisionDigest: ctx.revisionDigest,
		generation: state.revision,
		...(state.workflowInstanceId
			? { workflowInstanceId: state.workflowInstanceId }
			: {}),
		...((state.prReviewArtifactRunId ?? state.prReviewReservedRunId)
			? {
					runId:
						state.prReviewArtifactRunId ??
						state.prReviewReservedRunId ??
						undefined,
				}
			: {}),
	};
}

/**
 * Read-only admission check for direct PR-review re-entry. It deliberately
 * does not consume the token: the delegation gate performs the one-use
 * reservation only after its own Task acceptance checks have passed.
 */
export async function hasActivePrReviewReentryAuthorization(
	directory: string,
	sessionID: string,
	request: { role: PrReviewReentryRole },
): Promise<boolean> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!state) return false;
		const binding = await prReviewReentryBindingFromState(directory, state);
		if (!binding) return false;
		return hasPrReviewReentryAuthorizationAgainstBinding(
			directory,
			normalizedSessionID,
			request,
			binding,
		);
	});
}

/**
 * Sole production reservation/verification path for direct PR-review re-entry.
 * Lock order is fixed: workflow-session first, authorization store second. The
 * active binding cannot change between its locked reread and reservation commit.
 */
export async function reserveActivePrReviewReentryAuthorization(
	directory: string,
	sessionID: string,
	request: { role: PrReviewReentryRole; callID: string },
): Promise<PrReviewReentryAuthorizationRecord | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	return withSessionStateMutation(directory, normalizedSessionID, async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!state) return null;
		const binding = await prReviewReentryBindingFromState(directory, state);
		if (!binding) return null;
		await _test_exports.beforePrReviewReentryReservation?.();
		return reservePrReviewReentryAuthorizationAgainstBinding(
			directory,
			normalizedSessionID,
			request,
			binding,
		);
	});
}

// Issue #2385: the reentry authorization boundary (src/pr-review/
// authorization.ts) reads the CURRENT workflow binding through this gate
// reader — bound once at module init so the boundary never imports the gate
// back. Function declarations hoist, so the reference is available here.
bindPrReviewReentryBindingReader(readPrReviewReentryBindingContext);

export async function completePrWorkflow(
	directory: string,
	sessionID: string,
	expectedMode: PrWorkflowMode,
	prHeadSha: string,
	options?: {
		reportVerdict?: PrReviewReportVerdict;
		/** Issue #2506: lane-liveness watchdog config for this settlement. */
		laneLiveness?: PrWorkflowLaneLivenessOptions;
	},
): Promise<PrWorkflowCompletionStatus> {
	const state = await requireBoundState(directory, sessionID, expectedMode);
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	if (state.prHeadSha !== normalizedHead) {
		throw new Error(
			`BLOCKED: cannot complete ${expectedMode} at PR head "${normalizedHead}"; workflow is bound to "${state.prHeadSha}"`,
		);
	}
	// W-4 (issue #2242 R2): stale lanes settle with disclosure; fresh ones block.
	const laneSettlement = await settlePresumedStalePrWorkflowLanes(
		directory,
		state.sessionID,
		options?.laneLiveness,
	);
	if (laneSettlement.openLanes > 0) {
		throw new Error(
			`BLOCKED: ${expectedMode} completion has ${laneSettlement.openLanes} unsettled PR workflow lane(s)` +
				describePrWorkflowLaneProbe(laneSettlement),
		);
	}
	// Issue #2383: a NO_COVERAGE completion admits the settlement disclosure
	// mid-completion, bumping the durable revision; the terminal clear must
	// CAS against that post-admission revision. Undefined otherwise.
	let terminalClearRevision: number | undefined;
	if (expectedMode === 'PR_REVIEW') {
		// Issue #2383: the controller must declare its terminal verdict and the
		// gate validates it against the settlement-derived coverage kind, so a
		// partial or zero-coverage review can never APPROVE.
		const verdict = options?.reportVerdict;
		if (verdict === undefined) {
			throw new Error(
				'BLOCKED: PR_REVIEW completion requires a terminal report_verdict (APPROVE, REQUEST_CHANGES, or INCOMPLETE)',
			);
		}
		const ctx = await createPrReviewGateContext(directory, state);
		const settlement = derivePrReviewDimensionSettlement(
			directory,
			state,
			ctx.revisionDigest,
		);
		if (settlement.kind === 'NO_COVERAGE') {
			// NO_COVERAGE settles at completion (issue #2383): zero covered
			// dimensions means no candidate inventory, no findings ladder, and
			// nothing for trigger evaluation to cover — the normal
			// terminal-ready ladder would (correctly) reject a run with
			// nothing to validate. The run completes as a forced-INCOMPLETE
			// operational report with explicit reasons; it never claims any
			// code-quality approval.
			if (settlement.liveDimensions.length > 0) {
				throw new Error(
					`BLOCKED: PR_REVIEW completion has zero covered dimensions and still-live lanes for: ${settlement.liveDimensions.join(', ')}. Collect or settle them, then complete with report_verdict INCOMPLETE.`,
				);
			}
			if (verdict !== 'INCOMPLETE') {
				throw new Error(
					`BLOCKED: PR_REVIEW NO_COVERAGE completion must report verdict INCOMPLETE; got "${verdict}". A zero-coverage report never approves and never claims a code-quality review.`,
				);
			}
			// Persist the durable v2 settlement disclosure BEFORE the audit
			// event and the terminal clear, exactly like a PARTIAL settlement
			// (plan WS1-8): an external auditor must be able to prove the
			// NO_COVERAGE kind from the immutable artifact, not only from the
			// audit line. A run with zero artifacts may have no reserved run
			// id, so one is generated in that case.
			const noCoverageRunId =
				state.prReviewArtifactRunId ??
				state.prReviewReservedRunId ??
				generatePrReviewRunId();
			const admittedState = await admitPrReviewPartialBaseCoverage(
				directory,
				sessionID,
				noCoverageRunId,
				settlement.unresolvedDimensions.map((entry) => entry.dimension),
			);
			// The admission bumped the durable revision; the terminal clear below
			// must CAS against the post-admission revision. If that clear itself
			// fails, the gate keeps the admitted (immutable) disclosure and a
			// retry re-admission throws — a deliberate fail-closed wedge; the
			// operator re-reads state and recovers via armed recovery rather
			// than silently re-crediting a zero-coverage settlement.
			terminalClearRevision = admittedState.revision;
			try {
				appendCoreEventSync(directory, {
					type: 'pr_review_no_coverage_terminal',
					timestamp: isoNow(),
					sessionID: state.sessionID,
					prHeadSha: state.prHeadSha,
					revisionDigest: ctx.revisionDigest,
					coveredDimensions: settlement.coveredDimensions.length,
					unresolvedDimensions: settlement.unresolvedDimensions.map(
						(entry) => `${entry.dimension}:${entry.terminalState}`,
					),
					disclosureRunId: noCoverageRunId,
					reportVerdict: verdict,
				});
			} catch {
				// Non-fatal audit trail (same discipline as abort).
			}
			// Fall through to the shared terminal clear below.
		} else {
			// Fail fast on an illegal verdict BEFORE the expensive terminal
			// ladder, then re-validate against the post-ladder settlement in
			// case state changed underneath the checks.
			const preAllowed = allowedPrReviewReportVerdicts(settlement.kind);
			if (!preAllowed.includes(verdict)) {
				throw new Error(
					`BLOCKED: PR_REVIEW ${settlement.kind} completion allows report_verdict ${preAllowed.join(' | ')}; got "${verdict}". Partial coverage never approves and never claims a full review.`,
				);
			}
			const ready = await assertPrReviewTerminalReady(
				directory,
				sessionID,
				options?.laneLiveness,
			);
			const readyState = ready.state;
			if (
				workflowIdentity(readyState) !== workflowIdentity(state) ||
				readyState.revision !== state.revision
			) {
				throw new Error(
					'BLOCKED: PR_REVIEW state changed while checking terminal readiness; retry from current state',
				);
			}
			const allowed = allowedPrReviewReportVerdicts(ready.settlement.kind);
			if (!allowed.includes(verdict)) {
				throw new Error(
					`BLOCKED: PR_REVIEW ${ready.settlement.kind} completion allows report_verdict ${allowed.join(' | ')}; got "${verdict}". Partial coverage never approves and never claims a full review.`,
				);
			}
		}
	} else {
		// Issue #2108: legacy armed records migrate (conservatively) before this
		// branch decides arming vs completion, and any in-flight push attempt
		// is reconciled (`uncertain`) before the window is judged.
		await ensurePublicationGenerationCurrent(directory, sessionID);
		let readyState = await assertPrFeedbackReadyToPublish(directory, sessionID);
		readyState =
			(await reconcileForeignInFlightAttempt(directory, sessionID)) ??
			readyState;
		const currentDigest = await currentPrFeedbackRevisionDigest(
			directory,
			readyState,
		);
		const armed = readyState.prFeedbackReadyToPublish;
		if (!armed) {
			const previousActive = readyState.prFeedbackPublication?.active;
			if (previousActive?.state === 'published') {
				// Crash-recovery idempotence: the generation was already marked
				// published but the gate clear never landed. Re-verify the remote
				// and finish the terminal clear instead of arming N+1 for
				// already-published content.
				const remoteHeadAtPublish =
					await _test_exports.resolveExactRemoteBranchHeadAsync(
						directory,
						previousActive.remoteName,
						previousActive.remoteBranchRef,
					);
				if (
					remoteHeadAtPublish?.toLowerCase() !==
					previousActive.localHead.toLowerCase()
				) {
					throw new Error(
						`BLOCKED: PR_FEEDBACK generation ${previousActive.generation} is marked published but the remote verification no longer holds; inspect pr_workflow_status`,
					);
				}
				await _test_exports.beforeTerminalClear?.();
				await clearPrWorkflowGateState(
					directory,
					sessionID,
					readyState.revision,
				);
				return 'completed';
			}
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
			if (commitCount === 0) {
				// Issue #2131 criterion C1: a fully verified no-change inventory
				// (every item DISPROVED / PRE_EXISTING / NEEDS_MORE_EVIDENCE /
				// NEEDS_USER_DECISION in the settled verification lanes) is a
				// legitimate terminal outcome with nothing to publish — the old
				// contract dead-ended it by demanding an empty commit. HEAD must
				// equal the immutable intake head (zero descendants AND no
				// divergence) and the tree must be clean.
				if (localHead !== state.prHeadSha) {
					throw new Error(
						'BLOCKED: PR_FEEDBACK zero-descendant completion requires HEAD to equal the immutable intake head (history diverged; resolve it or rebind via rebind_pr_feedback_head)',
					);
				}
				if (
					(await _test_exports.resolveIsWorkingTreeCleanAsync(directory)) !==
					true
				) {
					throw new Error(
						'BLOCKED: PR_FEEDBACK zero-descendant completion requires a clean index and working tree',
					);
				}
				const classifications = readLegacySettledFeedbackClassifications(
					directory,
					readyState,
				);
				const inventory = readyState.prFeedbackInventory ?? [];
				const offenders = inventory.filter(
					(itemId) =>
						!classifications.has(itemId) ||
						!FEEDBACK_NO_CHANGE_CLASSIFICATIONS.has(
							classifications.get(itemId)!,
						),
				);
				if (offenders.length > 0) {
					throw new Error(
						`BLOCKED: PR_FEEDBACK zero-commit completion requires every inventory item verified as a no-change outcome (DISPROVED, PRE_EXISTING, NEEDS_MORE_EVIDENCE, or NEEDS_USER_DECISION); offending items: ${offenders.slice(0, 10).join(', ')}. Items with confirmed content changes must follow the exactly-one-reviewed-commit path.`,
					);
				}
				try {
					appendCoreEventSync(directory, {
						type: 'pr_feedback_verified_no_change',
						timestamp: isoNow(),
						sessionID: state.sessionID,
						prHeadSha: state.prHeadSha,
						items: inventory.length,
					});
				} catch {
					// Non-fatal audit trail (same discipline as abort).
				}
				if (previousActive && previousActive.state === 'invalidated') {
					// Issue #2108: the invalidated generation ends without
					// publication — record the authoritative terminal summary.
					appendPublicationEvent(directory, {
						type: 'pr_feedback_publication_cancelled',
						sessionID: state.sessionID,
						generation: previousActive.generation,
						reason: 'verified-no-change-terminal',
					});
				}
				await clearPrWorkflowGateState(
					directory,
					sessionID,
					readyState.revision,
				);
				return 'verified-no-change';
			}
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
			// Issue #2108: capture the FULL generation identity before arming.
			// Every component must resolve — an unresolvable identity refuses to
			// arm (fail closed), never arms partially.
			if (previousActive && previousActive.state !== 'invalidated') {
				throw new Error(
					`BLOCKED: PR_FEEDBACK cannot arm a new publication generation while generation ${previousActive.generation} is ${previousActive.state}`,
				);
			}
			const workspaceIdentity = canonicalWorkspaceIdentity(directory);
			if (!workspaceIdentity) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without a canonical workspace identity',
				);
			}
			const localHeadRef =
				await _test_exports.resolveCurrentLocalHeadRefAsync(directory);
			if (!localHeadRef) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without the current branch ref (HEAD appears detached)',
				);
			}
			const remoteUrlIdentity =
				await _test_exports.resolveRemoteUrlIdentityAsync(
					directory,
					upstreamTarget.remoteName,
				);
			if (!remoteUrlIdentity) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK cannot arm publication without a credential-redacted remote URL identity for "${upstreamTarget.remoteName}"`,
				);
			}
			const evidenceJoin = buildPublicationEvidenceJoin(
				readyState,
				currentDigest,
			);
			if (!evidenceJoin) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without the exact settled receipt set (Stage A plus one batch per ordered phase)',
				);
			}
			const armedAt = isoNow();
			const generation: PrFeedbackPublicationGeneration = {
				schemaVersion: PUBLICATION_SCHEMA_VERSION,
				generation: (previousActive?.generation ?? 0) + 1,
				state: 'armed',
				workspaceIdentity,
				sessionID: readyState.sessionID,
				prTargetUrl: readyState.prFeedbackTargetUrl,
				intakeHeadSha: readyState.prHeadSha ?? 'unknown',
				localHeadRef,
				localHead,
				remoteName: upstreamTarget.remoteName,
				remoteUrlIdentity,
				remoteBranchRef: upstreamTarget.remoteBranchRef,
				remoteRef: upstreamTarget.remoteTrackingRef,
				revisionDigest: currentDigest,
				evidence: evidenceJoin,
				createdAt: armedAt,
				armedAt,
			};
			await persistState(directory, {
				...readyState,
				updatedAt: armedAt,
				// Derived rollback mirror — present iff armed/push_in_flight, so a
				// rolled-back binary keeps enforcing the armed window.
				prFeedbackReadyToPublish: deriveReadyToPublishMirror(generation),
				prFeedbackPublication: nextPublicationContainer(
					readyState.prFeedbackPublication,
					generation,
					previousActive
						? [
								{
									...previousActive,
									supersededByGeneration: generation.generation,
								},
							]
						: [],
					[],
				),
			});
			appendPublicationEvent(directory, {
				type: 'pr_feedback_publication_armed',
				sessionID: readyState.sessionID,
				generation: generation.generation,
				supersedes: previousActive?.generation ?? null,
				revisionDigest: currentDigest,
				localHead,
				remoteName: upstreamTarget.remoteName,
				remoteUrlIdentity,
				remoteBranchRef: upstreamTarget.remoteBranchRef,
			});
			return 'ready-to-publish';
		}
		// Armed completion: the full identity check (digest, HEAD, worktree,
		// upstream triple, remote URL, workspace identity, evidence join) runs
		// in assertPrFeedbackPublicationArmed, which durably invalidates the
		// generation on proven drift before throwing.
		const armedState = await assertPrFeedbackPublicationArmed(
			directory,
			sessionID,
		);
		const active = armedState.prFeedbackPublication?.active;
		if (!active) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK publication is not armed; call complete_pr_workflow once after every ordered gate passes',
			);
		}
		const attemptsForGeneration = (
			armedState.prFeedbackPublication?.attempts ?? []
		).filter((attempt) => attempt.generation === active.generation);
		if (!attemptsForGeneration.some((attempt) => attempt.result)) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK completion requires the exact approved push to have been admitted and observed for generation ${active.generation}; run the exact push first: ${expectedBoundPushCommand(armed)}`,
			);
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
		// Verified publication: mark the generation terminal (`published`) with
		// an authoritative summary event, then run the existing terminal clear.
		const publishedAt = isoNow();
		const published: PrFeedbackPublicationGeneration = {
			...active,
			state: 'published',
			publishedAt,
		};
		const publishState: PrWorkflowGateState = {
			...armedState,
			updatedAt: publishedAt,
			prFeedbackReadyToPublish: undefined,
			prFeedbackPublication: nextPublicationContainer(
				armedState.prFeedbackPublication,
				published,
			),
		};
		await persistState(directory, publishState);
		appendPublicationEvent(directory, {
			type: 'pr_feedback_published',
			sessionID: armedState.sessionID,
			generation: published.generation,
			localHead: published.localHead,
			remoteName: published.remoteName,
			remoteBranchRef: published.remoteBranchRef,
			remoteUrlIdentity: published.remoteUrlIdentity ?? null,
			revisionDigest: published.revisionDigest,
			attempts: attemptsForGeneration.length,
		});
		await _test_exports.beforeTerminalClear?.();
		await clearPrWorkflowGateState(directory, sessionID, publishState.revision);
		return 'completed';
	}
	await _test_exports.beforeTerminalClear?.();
	await clearPrWorkflowGateState(
		directory,
		sessionID,
		terminalClearRevision ?? state.revision,
	);
	return 'completed';
}

export const _test_exports = {
	// Issue #2382: the text-signature classifier was replaced by the typed
	// circuit-signal classifier (durable structured evidence only). Exposed so
	// the provider-terminal / ignored-reason classification can be asserted
	// directly.
	classifyPrReviewCircuitSignal,
	minimumConsolidatedLaneCover,
	analyzePrReviewBatchRecordIntegrity,
	MAX_COVER_UNIVERSE_BITS,
	// Exposed so a regression test can assert the coverage verdict and the
	// candidate-id extraction agree on the same artifact — the split-brain that
	// let a lane be judged "covered" while contributing zero findings.
	extractCandidateIds,
	parseCanonicalCandidateRows,
	resolvePrReviewRowFamily,
	boundPublicationDiagnostic,
	workflowGateStateRelativePath,
	workflowGateStateLockRelativePath,
	workflowCheckoutMutationLockRelativePath,
	withPrWorkflowCheckoutMutationLock,
	resetTrackedStateCache: () => {
		// Issue #2385: the four persistence caches/queues now live in
		// src/pr-review/persistence.ts; reset them through its API.
		resetPrReviewPersistenceCaches();
		// Issue #2382 review (PRR-005): the malformed-circuit diagnostic dedup is
		// process-level by design in production, but a shared test process must
		// not carry dedup state between suites — otherwise suite order changes
		// which diagnostics fire.
		malformedCircuitDiagnosticsSeen.clear();
		_test_exports.beforeTerminalClear = undefined;
		_test_exports.beforeAbortClear = undefined;
		_test_exports.beforePrFeedbackTransitionLock = undefined;
		_test_exports.beforePrFeedbackTrackingSwitch = undefined;
		_test_exports.afterPrFeedbackTrackingSwitch = undefined;
		_test_exports.beforePrFeedbackTrackingPersist = undefined;
		_test_exports.beforePrReviewReentryReservation = undefined;
		_test_exports.beforeBoundedSwarmFileOpen = undefined;
		_test_exports.beforeSessionStateLockWrite = undefined;
		_test_exports.beforeCheckoutLockWrite = undefined;
		_test_exports.beforeSafeDirectoryCreate = undefined;
		_test_exports.beforeAtomicTempWrite = undefined;
		_test_exports.beforeAtomicRename = undefined;
		_test_exports.openCheckoutLock = defaultPersistenceHooks.openCheckoutLock;
		_test_exports.removeCheckoutLock =
			defaultPersistenceHooks.removeCheckoutLock;
		_test_exports.checkoutMutationActionTimeoutMs =
			CHECKOUT_MUTATION_ACTION_TIMEOUT_MS;
		_test_exports.classifyPrWorkflowGitStateAsync = classifyPrWorkflowGitState;
		// Every one of these resets to the NAMED original binding, never to a
		// hand-rewritten literal: a re-written arrow is permanent pollution in
		// bun's shared test process, not a restore.
		_test_exports.sweepStaleDelegationsAsync = sweepStaleDelegations;
		_test_exports.probeLaneLivenessAsync = probeAlivePrWorkflowLaneSessions;
		_test_exports.probeLaneSessionStatusTypesAsync =
			probePrWorkflowLaneSessionStatusTypes;
		// Issue #2506: the watchdog counters zero and the activity seam
		// restores to its default, so suite ordering cannot leak budget
		// accounting or transcript fixtures between test files.
		laneLivenessWatchdogSurface.hostStatusCalls = 0;
		laneLivenessWatchdogSurface.hostAbortCalls = 0;
		laneLivenessWatchdogSurface.evaluations = 0;
		laneLivenessWatchdogSurface.readLaneActivity = defaultReadLaneActivity;
		_test_exports.getSessionOps = defaultGetSessionOps;
		_test_exports.laneLivenessProbeTimeoutMs =
			PR_WORKFLOW_LANE_LIVENESS_PROBE_TIMEOUT_MS;
		_test_exports.pendingLaneLivenessThresholdMs =
			PR_WORKFLOW_PENDING_LIVENESS_THRESHOLD_MS;
		closeAllProjectDbs();
	},
	beforeTerminalClear: undefined as (() => Promise<void>) | undefined,
	/**
	 * Interleave point between the durable `pr_workflow_aborted` append and the
	 * CAS-guarded clear, so a test can simulate the concurrent mutation that
	 * makes the clear throw after the audit record is already on disk (FB-008).
	 */
	beforeAbortClear: undefined as (() => Promise<void>) | undefined,
	beforePrFeedbackTransitionLock: undefined as
		| (() => Promise<void>)
		| undefined,
	beforePrFeedbackTrackingSwitch: undefined as
		| (() => Promise<void>)
		| undefined,
	afterPrFeedbackTrackingSwitch: undefined as (() => Promise<void>) | undefined,
	beforePrFeedbackTrackingPersist: undefined as
		| (() => Promise<void>)
		| undefined,
	/** Interleave point held inside the workflow-session lock before auth commit. */
	beforePrReviewReentryReservation: undefined as
		| (() => Promise<void>)
		| undefined,
	beforeBoundedSwarmFileOpen: undefined as (() => Promise<void>) | undefined,
	beforeSessionStateLockWrite: undefined as (() => Promise<void>) | undefined,
	beforeCheckoutLockWrite: undefined as (() => Promise<void>) | undefined,
	beforeSafeDirectoryCreate: undefined as
		| ((parentPath: string, nextPath: string) => Promise<void>)
		| undefined,
	beforeAtomicTempWrite: undefined as (() => Promise<void>) | undefined,
	beforeAtomicRename: undefined as (() => Promise<void>) | undefined,
	openCheckoutLock: defaultPersistenceHooks.openCheckoutLock,
	removeCheckoutLock: defaultPersistenceHooks.removeCheckoutLock,
	checkoutMutationActionTimeoutMs: CHECKOUT_MUTATION_ACTION_TIMEOUT_MS,
	classifyPrWorkflowGitStateAsync: classifyPrWorkflowGitState,
	/**
	 * The durability sweep, reached through a seam so a test can prove that a
	 * failing sweep cannot un-settle the decision `settlePresumedStalePrWorkflow-
	 * Lanes` already made in memory. It cannot throw today (it catches internally
	 * and returns 0) — the seam is what makes that guarantee testable rather than
	 * merely asserted.
	 */
	sweepStaleDelegationsAsync: sweepStaleDelegations,
	/** The fail-open liveness probe (issue #2251). */
	probeLaneLivenessAsync: probeAlivePrWorkflowLaneSessions,
	/**
	 * The types-carrying variant of the liveness probe (issue #2506): one
	 * shared status call returning per-session status TYPES, so the watchdog
	 * can distinguish `retry` (provider latency) from `busy` (past-deadline
	 * execution) without a second host round-trip. Seam for the same
	 * order-independence reason as `probeLaneLivenessAsync`.
	 */
	probeLaneSessionStatusTypesAsync: probePrWorkflowLaneSessionStatusTypes,
	/**
	 * The #2506 lane-liveness watchdog surface: the pure policy functions,
	 * the overridable transcript-activity reader, and the live budget
	 * counters (zeroed by `resetTrackedStateCache`).
	 */
	laneLivenessWatchdog: laneLivenessWatchdogSurface,
	/**
	 * Session handle for the liveness probe.
	 *
	 * A seam rather than a direct `swarmState.opencodeClient` read at the call
	 * site because 20+ test files mutate that field; without this, this suite and
	 * the stale-lane suite would be order-dependent in bun's shared process.
	 * Mirrors `_internals.getSessionOps` in `src/tools/dispatch-lanes.ts`.
	 */
	getSessionOps: defaultGetSessionOps,
	/**
	 * Probe deadline, read through the seam at CALL time. `freezeClock` patches
	 * `Date.now()`, not `setTimeout`, so a test that must reach the timeout branch
	 * has to shorten the real deadline. Same precedent as
	 * `checkoutMutationActionTimeoutMs` above.
	 */
	laneLivenessProbeTimeoutMs: PR_WORKFLOW_LANE_LIVENESS_PROBE_TIMEOUT_MS,
	/**
	 * Pending-liveness advisory threshold (issue #2280 Part B), seam-read at
	 * call time for the same clock reason — a test drives the boundary by
	 * shortening the threshold, not by waiting minutes.
	 */
	pendingLaneLivenessThresholdMs: PR_WORKFLOW_PENDING_LIVENESS_THRESHOLD_MS,
	/**
	 * Issue #2381: exposed so the staged-resilience DEFAULT can be pinned
	 * directly. This resolution path is reached whenever a gate state carries no
	 * recorded policy and no policy is supplied, and it previously hardcoded
	 * `enabled: true`; the default flip is only real if this agrees with
	 * `DEFAULT_PR_REVIEW_RESILIENCE_CONFIG`. Pure functions of their arguments,
	 * so `_test_exports` is the right seam (no `mock.module` needed).
	 */
	effectivePrReviewResiliencePolicy,
	snapshotPrReviewResiliencePolicy,
	resolveCurrentGitHead,
	resolveCurrentGitHeadAsync,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamPushTargetAsync,
	resolveCurrentUpstreamRemoteRef,
	resolveCurrentLocalHeadRefAsync,
	resolveRemoteUrlIdentity,
	resolveRemoteUrlIdentityAsync,
	// Issue #2108 publication-generation machinery.
	parseExactBoundPushIntent,
	admitPrFeedbackPushAttempt,
	recordPrFeedbackPushAttemptResult,
	reconcileForeignInFlightAttempt,
	ensurePublicationGenerationCurrent,
	invalidatePublicationGeneration,
	invalidatePrFeedbackPublication,
	cancelPrFeedbackPublication,
	buildPublicationEvidenceJoin,
	nextPublicationContainer,
	supersedeLivePublicationInPendingState,
	describePrWorkflowPublicationSection,
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
	/**
	 * The batch cap the capacity GC reclaims against. Exposed so the GC suite
	 * builds its fixture from the real bound instead of a hand-copied literal
	 * that would silently drift if the cap ever moved.
	 */
	MAX_WORKFLOW_BATCHES,
	MAX_PR_REVIEW_RESILIENCE_CIRCUIT_CONTRIBUTORS,
	/**
	 * The three ledger ceilings whose overflow makes the capacity GC abandon a
	 * prune and keep every batch. Exposed on the same reasoning as
	 * `MAX_WORKFLOW_BATCHES`: the overflow suite seeds a ledger to exactly its
	 * bound from the real constant, so a hand-copied literal cannot drift away
	 * from the branch it is meant to reach.
	 */
	MAX_RETIRED_REVIEWER_SESSION_IDS,
	MAX_RETIRED_CONSOLIDATED_LANES,
	MAX_RETIRED_FEEDBACK_ITEM_OWNERS,
	/**
	 * Issue #1968 P2.2: lets a focused test drive one specific bounded-snapshot
	 * failure reason so the BLOCKED diagnostic can be asserted per bound. The
	 * pre-existing `resolvePrWorkflowRevisionDigest` seam above still takes
	 * priority-two precedence and is unchanged for every existing fixture.
	 */
	resolvePrWorkflowRevisionDigestDetailed,
	resolveRemoteRefsContainingHead,
	resolveRemoteRefsContainingHeadAsync,
	parseCriticVerdict,
	/**
	 * Read-only view of the item-keyed composition for one session, including
	 * the diagnostics that settlement only logs (abandoned declared lanes,
	 * batches skipped for inventory incoherence). Production callers reach the
	 * same computation through settlement and the verdict derivations.
	 */
	composePrReviewPhaseVerdicts: async (
		directory: string,
		sessionID: string,
		phase: PrReviewComposablePhase,
	): Promise<PrReviewPhaseComposition> => {
		const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
		const ctx = await createPrReviewGateContext(directory, state);
		return composePrReviewPhaseVerdicts(directory, state, phase, ctx);
	},
	/**
	 * Issue #1968 B1 guardrail, exposed directly.
	 *
	 * Production reaches it from `assertPrReviewValidationSettled`, both
	 * critic-coverage gates and the artifact-record projection check. Item-keyed
	 * composition makes a real violation unreachable by construction, so the only
	 * way to exercise the assertion's own behaviour (and its cause-naming
	 * message) without mutating production code is to hand it the divergent pair
	 * a future re-split would produce.
	 */
	assertSettledPhaseHasAuthoritativeVerdicts,
	/**
	 * The critic-coverage gate's guarded input, exposed for the same reason as
	 * the assertion above: production reaches its unsettled-reviewer branch only
	 * if a caller stops settling reviewer first, which is precisely the future
	 * regression it exists to catch, so the branch is otherwise untestable.
	 */
	derivePrReviewCriticInventoryForCoverageGate: async (
		directory: string,
		sessionID: string,
		origin = '_test_exports',
	): Promise<string[]> => {
		const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
		const ctx = await createPrReviewGateContext(directory, state);
		return derivePrReviewCriticInventoryForCoverageGate(
			directory,
			state,
			ctx,
			origin,
		);
	},
	/**
	 * Read-only view of the mandatory candidate inventory for one session.
	 * Production reaches the same derivation through validation-batch ownership
	 * validation, the composition, and the artifact-boundary checks; this seam
	 * lets a focused test observe *which* base lane won a dimension (the tier-L
	 * singleton-over-consolidated precedence) without standing up the full
	 * micro-sweep and trigger-ledger prerequisites those entry points require.
	 */
	derivePrReviewCandidateInventory: async (
		directory: string,
		sessionID: string,
	): Promise<string[]> => {
		const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
		const ctx = await createPrReviewGateContext(directory, state);
		return derivePrReviewCandidateInventory(directory, state, ctx);
	},
	isProcessAlive: defaultPersistenceHooks.isProcessAlive,
	// Exposed for the `-c` config-injection regression test. The publication
	// path that calls this needs a fully-armed ready-to-publish state, so the
	// classifier is not otherwise reachable from a focused unit test.
	isSafeStandaloneGitCommit,
	rename: fsp.rename,
	nowMs: () => Date.now(),
};

// Issue #2385: the transcript-conversion test surface (the verdict-row pipe
// tolerance's fidelity boundary, the production indexing path for legacy
// overflow recovery, the digest-stability view the critic-claim binding hashes,
// and the exact verdict-row analysis / item composition parsers used by the
// assignment-boundary regression) now lives in
// src/pr-review/legacy-transcript-adapter.ts. The guardrail scanner
// (src/pr-review/guardrails.ts) allows those identifiers only in that module,
// so the historical `_test_exports` properties are re-exposed here by spreading
// the adapter's surface — same property names, same bindings, no gate-side
// conversion identifiers.
Object.assign(_test_exports, legacyTranscriptAdapterTestSurface);

// Issue #2385: bind the persistence boundary to this gate's seams and full
// state codec. Properties are read at CALL time through the bound reference,
// so test-time mutation of `_test_exports.<prop>` and `resetTrackedStateCache`
// remain fully visible inside src/pr-review/persistence.ts.
bindPrReviewPersistenceHooks(_test_exports);
bindPrReviewStateCodec<PrWorkflowGateState>({
	safeParse: (data) => PrWorkflowGateStateSchema.safeParse(data),
	parse: (data) => PrWorkflowGateStateSchema.parse(data),
});

// Issue #2385: bind the completion boundary's gate-owned derivation helpers
// (src/pr-review/completion.ts reads them through this binding and never
// imports the gate back). Function declarations hoist, so the references are
// available here.
bindPrReviewCompletionHelpers({
	createPrReviewGateContext,
	requireBoundState,
	readPrWorkflowGateStateFromDisk,
	readBoundedSwarmRegularFile,
	successfulObligationsFromExactBatch,
	recordsPassingBatchIntegrity,
	validatePrReviewDiscoveryLaneCompletion,
	validateExactStructuredReceiptCoverage,
});

// Issue #2385: bind the legacy transcript adapter's gate-owned composition
// helpers (src/pr-review/legacy-transcript-adapter.ts reads them through this
// binding and never imports the gate back). Function declarations hoist, so
// the references are available here.
bindPrReviewTranscriptAdapterHelpers({
	derivePrReviewCandidateInventory,
	derivePrReviewCriticInventory,
	authoritativeReviewerClaims,
	reviewerSubagentSessionIds,
	prReviewPhaseWindow,
	batchMayContributeClaims,
	recordsPassingBatchIntegrity,
	loadArtifactPassingLaneIntegrity,
});

/**
 * Issue #1931: surface the activation path so callers don't go hunting for a
 * fictional gate file. See withPrWorkflowCheckoutPreparationLock for the same
 * diagnostic on the prepare_pr_workflow_checkout path. Shared with
 * `abortPrWorkflow`, which reads through the recovery reader instead.
 */
function noActiveGateError(sessionID: string): Error {
	return new Error(
		`BLOCKED: no active PR workflow gate for session "${normalizeSessionID(sessionID)}". ` +
			`The gate is activated by running \`/swarm pr-review <pr-ref>\` (PR_REVIEW) or \`/swarm pr-feedback <pr-ref>\` (PR_FEEDBACK), ` +
			`or by the first dispatch_lanes_async call with mode "swarm-pr-review:*" / "swarm-pr-feedback:*".`,
	);
}

async function requireAnyActiveState(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) throw noActiveGateError(sessionID);
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
		await assertCurrentCheckoutHead(directory, state.prHeadSha, 'PR_REVIEW');
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
			if (reviewItemIds.length > MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS) {
				throw new Error(
					`BLOCKED: PR workflow review_item_ids may not exceed ${MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS} entries`,
				);
			}
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
	'authorize_pr_review_reentry',
	'parse_lane_candidates',
	'write_pr_review_artifact',
	'write_pr_review_trigger_eval',
]);

const PR_FEEDBACK_CONTROLLER_TOOLS = new Set([
	'invalidate_pr_feedback_publication',
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

type ReadOnlyArgumentClassification =
	| { safe: true }
	| {
			safe: false;
			path: string;
			constraint: string;
			value: unknown;
	  };

function unsafeReadOnlyArgument(
	path: string,
	constraint: string,
	value: unknown,
): ReadOnlyArgumentClassification {
	return { safe: false, path: path || '(root)', constraint, value };
}

function readOnlyArgumentPath(parent: string, key: string): string {
	return parent ? `${parent}.${key}` : key;
}

function classifyReadOnlyToolArguments(
	toolName: string,
	value: unknown,
	key = '',
	path = '',
	depth = 0,
): ReadOnlyArgumentClassification {
	if (depth > 8) {
		return unsafeReadOnlyArgument(
			path,
			'argument nesting exceeds the read-only depth limit of 8',
			value,
		);
	}
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
		return unsafeReadOnlyArgument(
			path,
			'argument name is mutation-bearing and is not allowed for read-only tools',
			value,
		);
	}
	if (keyTokens.some((token) => /^(?:method|verb)$/i.test(token))) {
		return typeof value === 'string' && /^(?:GET|HEAD)$/i.test(value.trim())
			? { safe: true }
			: unsafeReadOnlyArgument(
					path,
					'HTTP method/verb must be GET or HEAD for a read-only tool',
					value,
				);
	}
	if (
		keyTokens.length === 1 &&
		keyTokens.some((token) => /^(?:action|operation)$/i.test(token))
	) {
		return typeof value === 'string' &&
			/^(?:check|diff|fetch|find|get|inspect|list|lookup|open|read|scan|search|show|status|view)$/i.test(
				value.trim(),
			)
			? { safe: true }
			: unsafeReadOnlyArgument(
					path,
					'action/operation must name a recognized observation operation',
					value,
				);
	}
	if (/^mode$/i.test(key) && typeof value === 'string') {
		const allowed =
			toolName === 'search'
				? /^(?:r|rb|read|literal|regex)$/i
				: /^(?:r|rb|read)$/i;
		return allowed.test(value.trim())
			? { safe: true }
			: unsafeReadOnlyArgument(
					path,
					toolName === 'search'
						? 'search mode must be one of r, rb, read, literal, or regex'
						: 'mode must be one of r, rb, or read for a read-only tool',
					value,
				);
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
			return unsafeReadOnlyArgument(
				path,
				'query/request text contains a mutating operation',
				value,
			);
		}
		return /(?:^(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE|write|edit|patch|create|delete|destroy|remove|replace|truncate|update|upload)$|(?:^|[\r\n])\s*(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE)\s+\S+(?:\s+HTTP\/\d(?:\.\d)?)?|\bmutation\b|\b(?:create|drop|alter|truncate)\s+(?:or\s+replace\s+)?(?:table|database|schema|index|view|function|procedure|trigger|sequence)\b|\b(?:delete\s+from|insert\s+into|merge\s+into|replace\s+into|upsert\s+into)\b|\bupdate\s+[A-Za-z0-9_."'`-]+(?:\s+(?:AS\s+)?[A-Za-z0-9_"'`-]+)?\s+set\b|\b(?:grant|revoke)\s+\S+\s+(?:on|from|to)\b|\b(?:call|exec(?:ute)?)\s+[A-Za-z0-9_."'`-]+|\b(?:rm|rmdir|del|remove-item|move-item|set-content|add-content)\b)/i.test(
			value,
		)
			? unsafeReadOnlyArgument(
					path,
					'string value contains a mutating command or request',
					value,
				)
			: { safe: true };
	}
	if (
		value === null ||
		value === undefined ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return { safe: true };
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const result = classifyReadOnlyToolArguments(
				toolName,
				value[index],
				key,
				`${path}[${index}]`,
				depth + 1,
			);
			if (!result.safe) return result;
		}
		return { safe: true };
	}
	if (typeof value === 'object') {
		for (const [childKey, childValue] of Object.entries(value)) {
			const result = classifyReadOnlyToolArguments(
				toolName,
				childValue,
				childKey,
				readOnlyArgumentPath(path, childKey),
				depth + 1,
			);
			if (!result.safe) return result;
		}
		return { safe: true };
	}
	return unsafeReadOnlyArgument(
		path,
		'argument type is not supported by the read-only classifier',
		value,
	);
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
	if (hasUnsafeShellControlSyntax(command)) return false;

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
	const syntaxViolation = describeShellSyntaxViolation(command);
	if (syntaxViolation) {
		detail = syntaxViolation;
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

type PrWorkflowShellSyntaxReason =
	| 'compound-syntax'
	| 'unmatched-quote'
	| 'ambiguous-escaped-quote'
	| 'command-substitution'
	| 'gh-api-jq-pipe';

interface PrWorkflowShellSyntaxVerdict {
	unsafe: boolean;
	reason: PrWorkflowShellSyntaxReason | null;
}

interface PrWorkflowShellToken {
	value: string;
	quoted: boolean;
	pipeIsDoubleQuoted: boolean;
}

function classifyPrWorkflowShellSyntax(
	command: string,
): PrWorkflowShellSyntaxVerdict {
	const { normalized: inner } = normalizePrWorkflowShellCommand(command);
	const compact = inner.replace(/\s+/g, ' ').trim();
	if (!compact) return { unsafe: true, reason: 'compound-syntax' };
	// Preserve the existing fail-closed treatment for every shell control form
	// except the one narrowly admitted literal: `|` inside a double-quoted gh
	// api --jq value. Apostrophes quote in POSIX shells but not in cmd.exe, so
	// requiring double quotes keeps the accepted command safe for every executor
	// that may sit behind OpenCode's cross-platform shell tool. Quoting does not
	// widen semicolons, redirection, interpolation, or command substitution.
	if (/\$\(|@\(/.test(inner)) {
		return { unsafe: true, reason: 'command-substitution' };
	}
	// `\"` is a literal quote under POSIX but closes/opens quoting differently
	// under cmd.exe; `^"` has the symmetric cmd.exe escape behavior. Reject both
	// globally, including where our parser would otherwise treat the quote as an
	// opening delimiter, so no executor can expose a parser-hidden pipeline.
	if (/\\"|\^"/.test(inner)) {
		return { unsafe: true, reason: 'ambiguous-escaped-quote' };
	}
	if (/[\r\n;&<>`]/.test(inner)) {
		return { unsafe: true, reason: 'compound-syntax' };
	}
	const tokens: PrWorkflowShellToken[] = [];
	let current = '';
	let quoted = false;
	let quote: "'" | '"' | null = null;
	let pipeIsDoubleQuoted = true;

	const flush = (): void => {
		if (current.length > 0 || quoted) {
			tokens.push({ value: current, quoted, pipeIsDoubleQuoted });
		}
		current = '';
		quoted = false;
		quote = null;
		pipeIsDoubleQuoted = true;
	};

	for (let index = 0; index < inner.length; index += 1) {
		const ch = inner[index];
		if (quote === null) {
			if (/\s/.test(ch)) {
				flush();
				continue;
			}
			if (ch === "'" || ch === '"') {
				quoted = true;
				quote = ch;
				continue;
			}
			if (ch === ';' || ch === '<' || ch === '>' || ch === '`' || ch === '|') {
				return { unsafe: true, reason: 'compound-syntax' };
			}
			if (ch === '$' && inner[index + 1] === '(') {
				return { unsafe: true, reason: 'command-substitution' };
			}
			if (ch === '@' && inner[index + 1] === '(') {
				return { unsafe: true, reason: 'command-substitution' };
			}
			current += ch;
			continue;
		}

		if (quote === "'") {
			if (ch === "'") {
				quote = null;
				continue;
			}
			if (ch === '|') pipeIsDoubleQuoted = false;
			current += ch;
			continue;
		}

		if (ch === '"') {
			quote = null;
			continue;
		}
		// A backslash-quote is an escape in some POSIX-oriented parsers but not
		// in cmd.exe, where the quote closes and a following pipe becomes shell
		// control syntax. Raw shell text cannot prove one interpretation across
		// every supported executor, so fail closed instead of guessing.
		if (ch === '\\' && inner[index + 1] === '"') {
			return { unsafe: true, reason: 'ambiguous-escaped-quote' };
		}
		if (ch === '`') {
			return { unsafe: true, reason: 'command-substitution' };
		}
		if (ch === '$' && inner[index + 1] === '(') {
			return { unsafe: true, reason: 'command-substitution' };
		}
		if (ch === '@' && inner[index + 1] === '(') {
			return { unsafe: true, reason: 'command-substitution' };
		}
		current += ch;
	}

	if (quote !== null) {
		return { unsafe: true, reason: 'unmatched-quote' };
	}
	flush();

	const pipeTokens = tokens.filter((token) => token.value.includes('|'));
	if (pipeTokens.length === 0) return { unsafe: false, reason: null };
	if (
		pipeTokens.length !== 1 ||
		!pipeTokens[0].quoted ||
		!pipeTokens[0].pipeIsDoubleQuoted
	) {
		return { unsafe: true, reason: 'gh-api-jq-pipe' };
	}
	const quotedPipeToken = pipeTokens[0];
	if (!/^gh\s+api(?:\s|$)/i.test(compact)) {
		return { unsafe: true, reason: 'gh-api-jq-pipe' };
	}
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.value === '--jq' && tokens[index + 1] === quotedPipeToken) {
			return { unsafe: false, reason: null };
		}
	}
	return { unsafe: true, reason: 'gh-api-jq-pipe' };
}

function hasUnsafeShellControlSyntax(command: string): boolean {
	return classifyPrWorkflowShellSyntax(command).unsafe;
}

function describeShellSyntaxViolation(command: string): string | null {
	const verdict = classifyPrWorkflowShellSyntax(command);
	if (!verdict.unsafe) return null;
	switch (verdict.reason) {
		case 'unmatched-quote':
			return 'Reason: unmatched quote in the shell command. Close the quote and retry with a single read-only command.';
		case 'ambiguous-escaped-quote':
			return 'Reason: backslash- or caret-escaped double quotes are ambiguous across cmd.exe, PowerShell, and POSIX shells. Use a jq filter that needs no nested double quotes, or use the bounded gh_evidence tool.';
		case 'command-substitution':
			return 'Reason: command-substitution syntax ($() or @()) is not allowed in this read-only gate.';
		case 'gh-api-jq-pipe':
			return 'Reason: literal `|` is only allowed inside a double-quoted `gh api --jq` value; single quotes do not protect pipes under cmd.exe, and every other shape is treated as compound shell syntax.';
		default:
			return 'Reason: compound-syntax (;, &&, |, <, >, backtick, or $()/@()). Run ONE command per call; a single leading `cd <dir> &&` and a trailing `2>&1` are tolerated for reads only.';
	}
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
	const resolved = await resolvePrWorkflowRevisionDigestForGate(
		directory,
		state.prHeadSha,
	);
	if (!resolved.ok) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK could not compute a bounded current-revision digest' +
				` for pr_head_sha "${state.prHeadSha}"; ${describePrWorkflowRevisionDigestFailure(resolved)}`,
		);
	}
	return resolved.digest;
}

/**
 * The gate's view of a digest failure. Everything the bounded-snapshot resolver
 * can report, plus one test-only case: an injected `string | null` seam returned
 * `null`, which carries no reason at all. Modelled explicitly rather than folded
 * into one of the real reasons so a diagnostic never claims a bound fired when
 * nothing proved it did.
 */
type GateRevisionDigestResult =
	| RevisionDigestResult
	| { ok: false; reason: 'seam-unavailable'; detail?: string };

/**
 * Name the exact bound that fired, plus what to do about it.
 *
 * Exported because `dispatch_lanes_async` resolves the same bounded revision
 * digest before any gate entry point runs, and must produce the same
 * bound-naming diagnostic rather than the pre-fix "could not compute" with no
 * indication of which of six limits was hit (issue #1968 P2.2 / criterion 6).
 */
export function describePrWorkflowRevisionDigestFailure(
	failure: Extract<GateRevisionDigestResult, { ok: false }>,
): string {
	const detail = failure.detail ? ` (${failure.detail})` : '';
	switch (failure.reason) {
		case 'file-cap':
			return `the changed-file snapshot exceeded REVISION_MAX_FILES${detail}. Reduce the changed-path count (commit or stash generated/vendored output) before retrying`;
		case 'byte-cap':
			return `the changed-file snapshot exceeded REVISION_MAX_TOTAL_BYTES${detail}. Reduce the changed content size before retrying`;
		case 'buffer-truncated':
			return `a bounded git enumeration exceeded GIT_SNAPSHOT_MAX_BUFFER${detail}. The changed-path list is too large to enumerate`;
		case 'timeout':
			return `a bounded git enumeration timed out${detail}. Retry once the working tree is quiescent`;
		case 'git-failed':
			return `a bounded git enumeration failed${detail}. Verify the checkout is a healthy Git worktree at the recorded head`;
		case 'containment':
			return `git reported a changed path outside the project root${detail}. Nothing outside the project root may be hashed`;
		case 'read-failed':
			return `a changed path could not be read${detail}. Resolve the filesystem error before retrying`;
		default:
			return `an injected revision-digest seam returned no digest${detail}; production names one of REVISION_MAX_FILES / REVISION_MAX_TOTAL_BYTES / GIT_SNAPSHOT_MAX_BUFFER, a bounded git enumeration timeout, or a read failure`;
	}
}

/**
 * Production gate calls use the non-blocking, chunked digest implementation, and
 * consume its discriminated failure reason so a BLOCKED message can name the one
 * bound that actually fired instead of listing every bound that might have.
 *
 * Two synchronous seams are kept for focused tests, in priority order. The
 * detailed seam lets a test drive a specific failure reason; the pre-existing
 * `string | null` seam is preserved verbatim so every existing fixture keeps
 * working, and its `null` maps to the reasonless `seam-unavailable` case rather
 * than being attributed to a bound no test proved. Neither is selected while the
 * production implementation is in place.
 */
async function resolvePrWorkflowRevisionDigestForGate(
	directory: string,
	baseHeadSha: string,
): Promise<GateRevisionDigestResult> {
	if (
		_test_exports.resolvePrWorkflowRevisionDigestDetailed !==
		resolvePrWorkflowRevisionDigestDetailed
	) {
		return _test_exports.resolvePrWorkflowRevisionDigestDetailed(
			directory,
			baseHeadSha,
		);
	}
	if (
		_test_exports.resolvePrWorkflowRevisionDigest !==
		resolvePrWorkflowRevisionDigest
	) {
		const digest = _test_exports.resolvePrWorkflowRevisionDigest(
			directory,
			baseHeadSha,
		);
		return digest
			? { ok: true, digest }
			: { ok: false, reason: 'seam-unavailable' };
	}
	return resolvePrWorkflowRevisionDigestDetailedAsync(directory, baseHeadSha);
}

/**
 * One PR_REVIEW gate entry point's memoized derivation context.
 *
 * Two properties, both load-bearing:
 *
 * 1. **One revision digest per gate call.** Every artifact-integrity check below
 *    compares the persisted artifact's `revisionDigest` against the current
 *    worktree revision. Resolving that per record costs three blocking `git`
 *    calls plus a full re-read of every changed file, once per record. Both
 *    callers of the marker check already require
 *    `record.workspace.prHeadSha === state.prHeadSha` earlier in the same
 *    predicate, so every record reaching the comparison shares one head and one
 *    resolution is equivalent to N.
 *
 *    **Honest equivalence statement:** one digest is equivalent to N per-record
 *    resolves *absent concurrent worktree mutation during a gate call*. The
 *    resolver reads the live worktree, so this narrows a TOCTOU window rather
 *    than being a pure cost change. It adopts the precedent already set by the
 *    PR_FEEDBACK verification path, which resolves once and threads.
 *
 * 2. **One composed verdict map per gate call.** Settlement, critic-inventory
 *    derivation, the artifact-record projection check and the legacy-eligibility
 *    marker check are separate passes over the same state. They must never hold
 *    two different notions of "the current reviewer verdict", so the composition
 *    is computed once here and the same object is handed to all of them.
 *
 * A context is valid for exactly one gate entry-point call over one state
 * snapshot. Never cache it across calls.
 */
interface PrReviewGateContext {
	readonly revisionDigest: string;
	reviewer?: PrReviewPhaseComposition;
	critic?: PrReviewPhaseComposition;
	candidateInventory?: string[];
	/**
	 * candidate_id -> the severity its `[CANDIDATE]` row declared. Populated
	 * as a by-product of deriving the inventory, so it is exactly as
	 * authoritative and as scoped as the inventory itself (issue #2320).
	 */
	candidateSeverities?: Map<string, CandidateSeverity>;
}

/**
 * Resolve the single current-revision digest this gate call will thread.
 *
 * A failed resolution is a hard BLOCK, never a silently-threaded `undefined`:
 * `undefined` restores the per-record synchronous fallback inside the marker
 * check, which would make the gate quietly do 1+N blocking resolutions and
 * would make a "resolved once" guardrail assert something production does not
 * do. The resolver reports a discriminated failure reason, so the message names
 * the one bound that actually fired rather than every bound that might have.
 */
async function createPrReviewGateContext(
	directory: string,
	state: PrWorkflowGateState,
): Promise<PrReviewGateContext> {
	if (!state.prHeadSha) {
		throw new Error('BLOCKED: PR_REVIEW revision binding requires pr_head_sha');
	}
	const resolved = await resolvePrWorkflowRevisionDigestForGate(
		directory,
		state.prHeadSha,
	);
	if (!resolved.ok) {
		throw new Error(
			'BLOCKED: PR_REVIEW could not compute a bounded current-revision digest for ' +
				`pr_head_sha "${state.prHeadSha}"; ${describePrWorkflowRevisionDigestFailure(resolved)}`,
		);
	}
	return { revisionDigest: resolved.digest };
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

/** Order- and duplicate-insensitive set equality over two id lists. */
function sameStringSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	return (
		leftSet.size === rightSet.size && [...leftSet].every((v) => rightSet.has(v))
	);
}

/** Require a duplicate-free, non-empty subset of the mechanically derived IDs. */
function assertStringSetSubset(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): void {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	const extra = [...actualSet].filter((value) => !expectedSet.has(value));
	if (
		actual.length === 0 ||
		actual.length !== actualSet.size ||
		extra.length > 0
	) {
		throw new Error(
			`BLOCKED: ${label} must be a non-empty subset of the mechanically derived inventory; extra: ${extra.join(', ') || '(none)'}`,
		);
	}
}

/**
 * The single synthetic inventory id used when discovery found no candidates at
 * all. Its reviewer row is mandated to carry `final_severity: NONE`
 * (swarm-pr-review SKILL.md), so `NONE` is the CORRECT severity for it at every
 * boundary — including `post_explorer`, which has no `[CANDIDATE]` row to
 * compare against because there are none.
 */
const PR_REVIEW_CLEAN_SENTINEL_ID = 'CLEAN-REVIEW';

function derivePrReviewCandidateInventory(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
): string[] {
	if (ctx.candidateInventory) return ctx.candidateInventory;
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
	const reversedBaseBatches = [
		...(state.prReviewBaseDispatches ?? []),
	].reverse();
	const successfulByBaseBatchId = new Map<string, Set<string>>();
	for (const batch of reversedBaseBatches) {
		successfulByBaseBatchId.set(
			batch.batchId,
			successfulObligationsFromExactBatch(
				directory,
				state,
				batch.batchId,
				batch.lanes,
				'swarm-pr-review:base',
				batch.validatedAt,
				true,
				new Set(),
				ctx.revisionDigest,
			),
		);
	}
	// Tier L only (issue #1968 P3.2): a successful SINGLETON source outranks a
	// consolidated one for the same dimension, with most-recent-wins applying
	// within each class. Tier L's contract is per-dimension depth
	// (PR_REVIEW_BASE_LANE_FLOORS.L), and consolidation is permitted there only
	// as failure recovery — so when both exist, the singleton is the lane that
	// actually satisfied the tier's contract. This closes the residual race where
	// a singleton's record completes only after a consolidated retry was already
	// declared against it. Tiers S and M keep plain most-recent-wins, where
	// consolidation is a first-class dispatch shape rather than a fallback.
	const laneClassPasses: Array<(ownedCount: number) => boolean> =
		(state.prReviewDepthTier ?? 'L') === 'L'
			? [(ownedCount) => ownedCount === 1, (ownedCount) => ownedCount !== 1]
			: [() => true];
	for (const laneIsInClass of laneClassPasses) {
		for (const batch of reversedBaseBatches) {
			const successful =
				successfulByBaseBatchId.get(batch.batchId) ?? new Set<string>();
			for (const lane of batch.lanes) {
				const ownedDimensions = lane.ownedWorkflowLanes?.length
					? lane.ownedWorkflowLanes
					: [lane.workflowLane];
				if (!laneIsInClass(ownedDimensions.length)) continue;
				const creditedDimensions = ownedDimensions.filter((dimension) =>
					successful.has(dimension),
				);
				if (creditedDimensions.length === 0) continue;
				const key = `${batch.batchId}\0${lane.laneId}`;
				baseSourceFullOwnershipCount.set(key, ownedDimensions.length);
				for (const dimension of creditedDimensions) {
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
	// Council batches are unrecordable before the trigger evaluation completes
	// (`recordPrReviewValidationBatch` refuses every validation phase without a
	// receipt), so under normal flow this loop only ever runs with the receipt
	// present. Gating it on the same field as the micro-source block below keeps
	// the base-only `post_explorer` checkpoint (issue #2280 Part A) STRUCTURALLY
	// base-only: a reconstructed or hand-modified state that carries council
	// batches without a receipt must never widen the inventory an early
	// checkpoint is validated against.
	if (state.prReviewTriggerEvalPath) {
		for (const batch of [
			...(state.prReviewValidationBatches ?? []),
		].reverse()) {
			if (batch.phase !== 'council') continue;
			const successful = successfulObligationsFromExactBatch(
				directory,
				state,
				batch.batchId,
				batch.lanes,
				'swarm-pr-review:council',
				batch.validatedAt,
				true,
				new Set(),
				ctx.revisionDigest,
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
	}
	const degradedSourceKeys = new Set<string>();
	if (state.prReviewTriggerEvalPath) {
		const triggerPath = validateSwarmPath(
			directory,
			state.prReviewTriggerEvalPath,
		);
		let triggerArtifact: unknown;
		try {
			const triggerStat = statSync(triggerPath);
			if (
				!triggerStat.isFile() ||
				triggerStat.size > PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES
			) {
				throw new Error('trigger evaluation artifact exceeds its read bound');
			}
			triggerArtifact = JSON.parse(readFileSync(triggerPath, 'utf-8'));
		} catch {
			throw new Error(
				'BLOCKED: PR_REVIEW trigger evaluation artifact is missing or invalid',
			);
		}
		let receipt: ReturnType<typeof parsePrReviewTriggerReceipt>;
		try {
			receipt = parsePrReviewTriggerReceipt(triggerArtifact);
		} catch (error) {
			throw new Error(
				`BLOCKED: PR_REVIEW trigger evaluation is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		for (const row of receipt.matchedRows) {
			sources.push({
				batchId: row.source_batch_id,
				laneId: row.source_lane_id,
				mode: 'swarm-pr-review:micro',
				workflowLane: row.trigger_id,
			});
		}
		// Dispatch tuples whose micro lane was accepted with a recorded coverage
		// degradation (write_pr_review_trigger_eval). If such a lane's retained
		// artifact still cannot contribute a covered row, the family is skipped
		// below — the degradation is already durably disclosed on the receipt —
		// instead of re-creating the trigger-eval dead-end at the inventory.
		for (const degradation of receipt.coverageDegradations) {
			degradedSourceKeys.add(
				`${degradation.source_batch_id}\0${degradation.source_lane_id}`,
			);
		}
	}
	const candidateIds: string[] = [];
	const candidateSeverities = new Map<string, CandidateSeverity>();
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
			// Identity checks stay hard (lane, mode, exact head). Coverage-quality
			// flags (status, degraded output) deliberately do NOT skip here: a
			// micro lane that ended degraded after retries was already accepted by
			// write_pr_review_trigger_eval with a recorded coverage degradation —
			// re-blocking here would re-create the trigger-eval dead-end this
			// inventory feeds. A degraded lane simply contributes whatever covered
			// rows its retained artifact holds (possibly none).
			if (
				record.laneId !== source.laneId ||
				record.mode !== source.mode ||
				record.workspace?.prHeadSha !== state.prHeadSha ||
				record.workspace?.gitHead !== state.prHeadSha
			)
				continue;
			const structured = record.result?.prReviewResultReceipt;
			if (structured) {
				const credited = source.creditedLanes?.length
					? structured.envelope.creditedLanes.filter((lane) =>
							source.creditedLanes?.includes(lane),
						)
					: structured.envelope.creditedLanes;
				if (source.workflowLane && !credited.includes(source.workflowLane)) {
					continue;
				}
				resolvedArtifact = true;
				const laneKey = `${source.batchId}\0${source.laneId}`;
				if (!extractedLaneKeys.has(laneKey)) {
					extractedLaneKeys.add(laneKey);
					for (const finding of structured.envelope.findings) {
						if (!credited.includes(finding.workflowLane)) continue;
						candidateIds.push(finding.id);
						if (!candidateSeverities.has(finding.id)) {
							candidateSeverities.set(finding.id, finding.severity);
						}
					}
				}
				continue;
			}
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
					ctx.revisionDigest,
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
						recordOwnedLanes,
						source.mode,
					))
			)
				continue;
			resolvedArtifact = true;
			const laneKey = `${source.batchId}\0${source.laneId}`;
			if (!extractedLaneKeys.has(laneKey)) {
				extractedLaneKeys.add(laneKey);
				const extracted = extractCandidateRows(
					artifact.text,
					resolvePrReviewRowFamily(source.workflowLane, source.mode),
					source.creditedLanes,
				);
				for (const row of extracted) {
					candidateIds.push(row.candidateId);
					// Duplicate ids are rejected by assertNoDuplicates below, so a
					// first-write here is also the only write; recording it
					// unconditionally would mask that check rather than defer to it.
					if (row.severity && !candidateSeverities.has(row.candidateId)) {
						candidateSeverities.set(row.candidateId, row.severity);
					}
				}
			}
		}
		if (source.mode === 'swarm-pr-review:micro' && !resolvedArtifact) {
			if (degradedSourceKeys.has(`${source.batchId}\0${source.laneId}`)) {
				// Accepted-with-disclosure at trigger-eval time: the receipt already
				// records why this family's lane could not contribute. Skipping it
				// here is the documented degraded path, not a silent waiver.
				continue;
			}
			throw new Error(
				`BLOCKED: PR_REVIEW mandatory micro-lane provenance is missing or invalid for ${source.workflowLane ?? source.laneId}`,
			);
		}
	}
	assertNoDuplicates(candidateIds, 'PR_REVIEW discovery candidate ids');
	ctx.candidateSeverities = candidateSeverities;
	ctx.candidateInventory =
		candidateIds.length > 0
			? candidateIds.sort()
			: [PR_REVIEW_CLEAN_SENTINEL_ID];
	return ctx.candidateInventory;
}

/**
 * Extract candidate ids from a discovery artifact's [CANDIDATE] rows. When
 * `scopeToLanes` is given (base-dimension sources credited for only a subset
 * of their owned dimensions), rows whose `lane` field is outside that set are
 * skipped — the artifact may legitimately discuss a dimension this source is
 * no longer the authoritative source for (a more recent batch superseded it),
 * and that stale content must not re-enter the candidate pool.
 */
interface CanonicalCandidateArtifactRow {
	candidateId: string;
	workflowLane: string;
	/**
	 * The row's declared severity, already validated against
	 * `CANDIDATE_SEVERITIES` by `analyzeCandidateFields` (so never `NONE`).
	 * Carried so the `post_explorer` findings boundary can compare a record's
	 * severity against the candidate row that produced it (issue #2320).
	 */
	severity: CandidateSeverity | null;
	evidence: string;
	lineNumber: number;
}

interface CandidateArtifactParseResult {
	rows: CanonicalCandidateArtifactRow[];
	issues: string[];
}

function appendBoundedCandidateIssue(issues: string[], message: string): void {
	if (issues.length < MAX_CANDIDATE_ISSUES_PER_ARTIFACT - 1) {
		issues.push(message.slice(0, MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS));
		return;
	}
	if (issues.length === MAX_CANDIDATE_ISSUES_PER_ARTIFACT - 1) {
		issues.push('additional malformed candidate diagnostics omitted');
	}
}

/**
 * Single source of truth for a PR-review lane's row family.
 *
 * Coverage validation and id extraction previously derived this separately (one
 * from the dispatch mode, one from lane membership). Because the artifact
 * normalizer's output depends on the family, any disagreement would reintroduce
 * the very coverage/inventory split this normalization exists to remove.
 */
function resolvePrReviewRowFamily(
	workflowLane: string | undefined,
	mode?: string,
): RowFormatFamily {
	// MODE FIRST, deliberately. The dispatch output contract tells a lane which
	// row family to emit purely from the mode (dispatch-lanes.ts: base -> base row
	// family; micro and council -> micro row family), so the mode is the ground
	// truth about what the artifact will contain. Deriving from the lane label
	// instead lets a council lane named after a base dimension resolve one way at
	// the coverage site and the other way at the extraction site — the exact
	// coverage/inventory split this normalization exists to remove.
	if (mode === 'swarm-pr-review:base') return 'base_explorer';
	if (mode === 'swarm-pr-review:micro' || mode === 'swarm-pr-review:council') {
		return 'micro_lane';
	}
	// No mode available: fall back to lane membership. Base dimension ids are a
	// closed set, so anything outside it is a micro/trigger lane.
	return workflowLane !== undefined &&
		PR_REVIEW_BASE_DIMENSION_IDS.includes(
			workflowLane as PrReviewBaseDimensionId,
		)
		? 'base_explorer'
		: 'micro_lane';
}

function parseCanonicalCandidateRows(
	text: string,
	fallbackFamily: RowFormatFamily,
): CandidateArtifactParseResult {
	const rows: CanonicalCandidateArtifactRow[] = [];
	const issues: string[] = [];
	let headerFamily: RowFormatFamily | null = null;
	for (const [index, line] of normalizeCandidateArtifactCached(
		text,
		fallbackFamily,
	)
		.text.split(/\r?\n/)
		.entries()) {
		const fields = splitPipeFields(line).map((field) => field.trim());
		const detectedHeaderFamily = candidateHeaderFamily(fields);
		if (detectedHeaderFamily) {
			headerFamily = detectedHeaderFamily;
			continue;
		}
		const explicitMarker = fields[0] === '[CANDIDATE]';
		const markerlessRow =
			headerFamily !== null && Boolean(fields[0]) && !fields[0].startsWith('[');
		if (!explicitMarker && !markerlessRow) continue;
		if (explicitMarker && headerFamily === null) {
			appendBoundedCandidateIssue(
				issues,
				`row ${index + 1} field header: candidate output must begin with one exact canonical base or micro [CANDIDATE] header`,
			);
			continue;
		}
		const family = headerFamily ?? fallbackFamily;
		const candidateFields = explicitMarker ? fields.slice(1) : fields;
		const analysis = analyzeCandidateFields(candidateFields, family);
		if (!analysis.valid) {
			for (const issue of analysis.issues) {
				appendBoundedCandidateIssue(
					issues,
					`row ${index + 1} field ${issue.field}: ${issue.message}`,
				);
			}
			continue;
		}
		if (!analysis.candidateId || !analysis.workflowLane) continue;
		rows.push({
			candidateId: analysis.candidateId,
			workflowLane: analysis.workflowLane,
			severity: isCandidateSeverity(analysis.values.severity)
				? analysis.values.severity
				: null,
			evidence: candidateFields.slice(2).join('\0'),
			lineNumber: index + 1,
		});
	}
	return { rows, issues };
}

function extractCandidateRows(
	text: string,
	fallbackFamily: RowFormatFamily,
	scopeToLanes?: readonly string[],
): CanonicalCandidateArtifactRow[] {
	const inScope = (lane: string | undefined) =>
		!scopeToLanes || (lane !== undefined && scopeToLanes.includes(lane));
	return parseCanonicalCandidateRows(text, fallbackFamily).rows.filter((row) =>
		inScope(row.workflowLane),
	);
}

function extractCandidateIds(
	text: string,
	fallbackFamily: RowFormatFamily,
	scopeToLanes?: readonly string[],
): string[] {
	return extractCandidateRows(text, fallbackFamily, scopeToLanes).map(
		(row) => row.candidateId,
	);
}

/**
 * candidate_id -> declared severity, for the SAME authoritative rows the
 * candidate inventory is derived from. Deriving the inventory populates this as
 * a by-product, so the two can never disagree about which rows are credited.
 *
 * Every non-sentinel inventory id is guaranteed present: an id and its severity
 * are appended from the same validated row, and a lane that cannot contribute a
 * row contributes no id either. The `CLEAN-REVIEW` sentinel is the one id with
 * no `[CANDIDATE]` row, and the gate handles it explicitly rather than through a
 * lenient fallback (issue #2320).
 */
function derivePrReviewCandidateSeverities(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
): Map<string, CandidateSeverity> {
	if (!ctx.candidateSeverities) {
		derivePrReviewCandidateInventory(directory, state, ctx);
	}
	if (!ctx.candidateSeverities) {
		// Fail closed. `derivePrReviewCandidateInventory` early-returns on a
		// memoized `ctx.candidateInventory` WITHOUT populating the severity map, so
		// a caller threading in a context that already derived the inventory would
		// otherwise silently receive an empty map — every record would fall through
		// to the no-authority branch and exact comparison would disappear with no
		// test failing. An empty map is never a legitimate result here.
		throw new Error(
			'BLOCKED: PR_REVIEW candidate severity authority is unavailable for this gate context',
		);
	}
	return ctx.candidateSeverities;
}

// Issue #2385: `PrReviewComposablePhase`, `PrReviewItemClaim`,
// `PrReviewPhaseComposition`, and `appendCompositionDiagnostic` moved to
// src/pr-review/legacy-transcript-adapter.ts (imported above).

/** Item ids named in one BLOCKED message before it degrades to a count. */
const MAX_UNCLAIMED_ITEMS_IN_MESSAGE = 50;

/**
 * The batches a phase composes over.
 *
 * Reviewer is scoped to everything after the latest council batch (a council
 * verdict re-opens the reviewer question). Critic spans every critic batch;
 * critic staleness is enforced per item by the reviewer row binding rather than
 * positionally. Note this makes reviewer *derivation* council-scoped, which it
 * was not before — derivation and settlement previously disagreed on the window,
 * and one computation cannot hold two windows.
 */
function prReviewPhaseWindow(
	state: PrWorkflowGateState,
	phase: PrReviewComposablePhase,
): PrReviewValidationBatchRecord[] {
	const all = state.prReviewValidationBatches ?? [];
	if (phase === 'critic') {
		return all.filter((batch) => batch.phase === 'critic');
	}
	let latestCouncilIndex = -1;
	for (let index = 0; index < all.length; index++) {
		if (all[index]?.phase === 'council') latestCouncilIndex = index;
	}
	return (
		latestCouncilIndex >= 0 ? all.slice(latestCouncilIndex + 1) : all
	).filter((batch) => batch.phase === 'reviewer');
}

/**
 * Child sessions that already produced a reviewer artifact. A critic lane may
 * never reuse one — an agent cannot independently challenge its own review.
 *
 * Seeded from `prReviewRetiredReviewerSessionIds` so the ban survives the
 * capacity GC: a pruned reviewer batch is gone from the array this walks, and
 * without the ledger its child sessions would silently become reusable.
 */
function reviewerSubagentSessionIds(
	directory: string,
	state: PrWorkflowGateState,
): Set<string> {
	const forbidden = new Set<string>(
		state.prReviewRetiredReviewerSessionIds ?? [],
	);
	for (const reviewerBatch of (state.prReviewValidationBatches ?? []).filter(
		(batch) => batch.phase === 'reviewer',
	)) {
		for (const record of findByBatchId(directory, reviewerBatch.batchId, {
			parentSessionId: state.sessionID,
		})) {
			const subagentSessionId = record.subagentSessionId?.trim();
			if (subagentSessionId) forbidden.add(subagentSessionId);
		}
	}
	return forbidden;
}

/**
 * May this batch contribute claims at all?
 *
 * Two live paths, deliberately different in granularity:
 *
 * - **Coherent (has a `prReviewBatchCoherence` entry).** Reviewer batches must
 *   have been validated against exactly the inventory in force now: a reviewer
 *   verdict set is only meaningful for the candidate inventory it was assigned,
 *   and nothing else pins it. Critic batches are admitted at batch level and
 *   filtered *per item* by `reviewerItemBindings`, which is the finer and
 *   strictly stronger check — batch-level inventory equality for critics would
 *   discard every sibling item's still-valid claim the moment one item left the
 *   critic inventory, reintroducing exactly the batch-granularity failure this
 *   composition exists to remove.
 * - **Legacy (no entry, written by an older plugin).** Exactly today's rule: the
 *   batch must be wholly successful and its declared item set must equal the
 *   current inventory. Expressed as a stricter predicate inside the same
 *   algorithm, so legacy state can never loosen.
 */
function batchMayContributeClaims(
	directory: string,
	state: PrWorkflowGateState,
	batch: PrReviewValidationBatchRecord,
	phase: PrReviewComposablePhase,
	requiredInventory: readonly string[],
	forbiddenSubagentSessionIds: ReadonlySet<string>,
	reviewerClaims: ReadonlyMap<string, PrReviewItemClaim> | undefined,
	ctx: PrReviewGateContext,
): boolean {
	const coherence = state.prReviewBatchCoherence?.[batch.batchId];
	if (coherence) {
		return (
			phase === 'critic' ||
			sameStringSet(coherence.validatedInventory, requiredInventory)
		);
	}
	const declaredItems = batch.lanes.flatMap((lane) => lane.reviewItemIds ?? []);
	if (!sameStringSet(declaredItems, requiredInventory)) return false;
	const successful = successfulObligationsFromExactBatch(
		directory,
		state,
		batch.batchId,
		batch.lanes,
		`swarm-pr-review:${phase}`,
		batch.validatedAt,
		true,
		forbiddenSubagentSessionIds,
		ctx.revisionDigest,
		undefined,
		reviewerClaims,
	);
	return (
		successful.size === batch.lanes.length &&
		batch.lanes.every((lane) => successful.has(lane.workflowLane))
	);
}

/**
 * Reviewer claims only when the reviewer phase is item-complete. Preserves the
 * pre-existing fail-closed "empty map" semantics for an unsettled reviewer
 * phase, now derived from the same computation settlement uses.
 */
function authoritativeReviewerClaims(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
): ReadonlyMap<string, PrReviewItemClaim> {
	const composed = composePrReviewPhaseVerdicts(
		directory,
		state,
		'reviewer',
		ctx,
	);
	return composed.unclaimed.length === 0 ? composed.claims : new Map();
}

/**
 * Pin every item a critic batch owns to the sha256 of the reviewer row that is
 * authoritative for it right now.
 *
 * The throw is unreachable defense in depth, kept deliberately: callers reach
 * here only via `recordPrReviewValidationBatch`, which first asserts reviewer
 * settlement and then requires the assigned items to exactly equal
 * `derivePrReviewCriticInventory` — an inventory derived *from* the reviewer
 * claims — so every assigned item necessarily has an authoritative row. It
 * throws rather than emitting a partial binding set so that a future caller
 * reaching it out of that order fails loudly instead of recording a critic
 * batch with silently missing bindings.
 *
 * It is NOT protecting against an `undefined === undefined` admission: an
 * earlier version of this comment claimed that, and it was wrong.
 * `criticClaimIsBoundToCurrentReviewerRow` requires
 * `Boolean(bound && current && bound === current)`, so a missing binding
 * already blocks. Both the throw and its absence are fail-closed.
 */
function criticReviewerItemBindings(
	directory: string,
	state: PrWorkflowGateState,
	lanes: ReadonlyArray<{ reviewItemIds?: string[] }>,
	ctx: PrReviewGateContext,
): Record<string, string> {
	const reviewerClaims = authoritativeReviewerClaims(directory, state, ctx);
	const bindings: Record<string, string> = {};
	for (const itemId of lanes.flatMap((lane) => lane.reviewItemIds ?? [])) {
		const rowDigest = reviewerClaims.get(itemId)?.rowDigest;
		if (!rowDigest) {
			throw new Error(
				`BLOCKED: PR_REVIEW critic dispatch cannot bind item "${itemId}" to an authoritative reviewer verdict row`,
			);
		}
		bindings[reviewerItemBindingKey(itemId)] = rowDigest;
	}
	return bindings;
}

/**
 * Items whose reviewer verdict obliges critic coverage.
 *
 * The reviewer map is read through the B1-guarded accessor: an empty or partial
 * map after a *settled* reviewer phase is a hard BLOCK here rather than an
 * empty critic inventory that silently disables the critic gate. The
 * complementary "reviewer never settled" case is rejected at the coverage gates
 * by `derivePrReviewCriticInventoryForCoverageGate`; this function stays usable
 * on unsettled states because batch GC derives it there.
 */
function derivePrReviewCriticInventory(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
): string[] {
	const verdicts = authoritativeReviewerVerdictsForGate(
		directory,
		state,
		ctx,
		'derivePrReviewCriticInventory',
	);
	// Issue #2383: the ONE shared production routing predicate. Never inline a
	// severity triple here — the centralization guard test enforces it.
	return [...verdicts.entries()]
		.filter(([, verdict]) =>
			prReviewFindingRequiresCritic({
				classification: verdict.classification,
				severity: verdict.severity,
				risk_impact: verdict.riskImpact,
				risk_tags: verdict.riskTags,
			}),
		)
		.map(([itemId]) => itemId)
		.sort();
}

/** Thin projection of the composed critic phase. Empty unless item-complete. */
function deriveLatestPrReviewCriticVerdicts(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
): Map<string, { status: string; severity: string }> {
	const composed = composePrReviewPhaseVerdicts(
		directory,
		state,
		'critic',
		ctx,
	);
	if (composed.unclaimed.length > 0) return new Map();
	return new Map(
		[...composed.claims].map(([itemId, claim]) => [
			itemId,
			{ status: claim.classification, severity: claim.severity },
		]),
	);
}

/** Thin projection of the composed reviewer phase. Empty unless item-complete. */
function deriveLatestPrReviewReviewerVerdicts(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
): Map<string, ReviewerVerdict> {
	return new Map(
		[...authoritativeReviewerClaims(directory, state, ctx)].map(
			([itemId, claim]) => [
				itemId,
				{
					classification: claim.classification,
					severity: claim.severity,
					riskImpact: claim.riskImpact,
					riskTags: claim.riskTags,
				},
			],
		),
	);
}

/**
 * **B1 invariant — the accounting defect class's most dangerous recurrence.**
 *
 * Issue #1968's defect class treats the whole inventory on the current revision
 * as the atomic unit of validity. Its worst recurrence is not a false BLOCK, it
 * is a silent PASS: a phase treated as *settled* while the authoritative verdict
 * map every downstream gate reads is empty or partial. For the reviewer phase
 * that chain is `derivePrReviewCriticInventory` -> `[]` ->
 * `completePrWorkflow`'s `criticInventory.length > 0` is false -> **critic
 * coverage is skipped entirely** and CONFIRMED CRITICAL/HIGH findings ship
 * unchallenged, with the only surface symptom a downstream
 * `no authoritative reviewer verdict` that names a consequence, not the cause.
 *
 * Composition currently makes this unreachable by construction: settlement *is*
 * `unclaimed.length === 0` over the very map derivation projects, and claims are
 * filtered to `requiredInventory`, so `unclaimed === []` implies the map covers
 * every required item. This assertion deliberately does **not** rely on that
 * adjacency. It states the property directly so a future refactor that re-splits
 * settlement from derivation fails loudly at the gate instead of silently
 * skipping the critic phase.
 *
 * Fail-closed and always on; never downgraded to a warning, because the failure
 * it catches is invisible in the passing direction. Pure over values the caller
 * already computed: no digest resolution, no artifact reads, no subprocess work.
 */
function assertSettledPhaseHasAuthoritativeVerdicts(
	phase: PrReviewComposablePhase,
	// Narrowed to the two fields the property is stated over, so the check can
	// never come to depend on the rest of the composition.
	composed: Pick<PrReviewPhaseComposition, 'requiredInventory' | 'unclaimed'>,
	authoritative: ReadonlyMap<string, unknown>,
	origin: string,
): void {
	// Antecedent, both halves load-bearing: an *unsettled* phase is supposed to
	// project an empty map (that is the pre-existing fail-closed semantics), and
	// an empty required inventory legitimately yields an empty map.
	if (composed.unclaimed.length > 0) return;
	if (composed.requiredInventory.length === 0) return;
	const missing = composed.requiredInventory.filter(
		(itemId) => !authoritative.has(itemId),
	);
	if (missing.length === 0) return;
	const named = missing.slice(0, MAX_UNCLAIMED_ITEMS_IN_MESSAGE);
	const overflow = missing.length - named.length;
	throw new Error(
		`BLOCKED: PR_REVIEW internal invariant violated at ${origin}: the ${phase} phase settled over ` +
			`${composed.requiredInventory.length} required item(s), but its authoritative ${phase} verdict map is ` +
			(authoritative.size === 0
				? 'EMPTY'
				: `PARTIAL (${authoritative.size} of ${composed.requiredInventory.length} items)`) +
			' after successful settlement' +
			(phase === 'reviewer'
				? '; an empty or partial reviewer verdict map empties the critic inventory, which silently skips the critic-coverage gate and lets CONFIRMED CRITICAL/HIGH findings ship unchallenged'
				: '; an empty or partial critic verdict map silently drops challenges the gate already accepted') +
			`; missing ${phase} verdicts for: ${named.join(', ')}` +
			(overflow > 0 ? ` (+${overflow} more)` : ''),
	);
}

/**
 * The reviewer verdict map downstream gates consume, with the B1 invariant
 * checked at the point of use. Reuses the caller's memoized composition, so the
 * check costs one array filter and adds no digest or artifact work.
 */
function authoritativeReviewerVerdictsForGate(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
	origin: string,
): Map<string, ReviewerVerdict> {
	const verdicts = deriveLatestPrReviewReviewerVerdicts(directory, state, ctx);
	assertSettledPhaseHasAuthoritativeVerdicts(
		'reviewer',
		composePrReviewPhaseVerdicts(directory, state, 'reviewer', ctx),
		verdicts,
		origin,
	);
	return verdicts;
}

/** Critic twin of `authoritativeReviewerVerdictsForGate`. */
function authoritativeCriticVerdictsForGate(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
	origin: string,
): Map<string, { status: string; severity: string }> {
	const verdicts = deriveLatestPrReviewCriticVerdicts(directory, state, ctx);
	assertSettledPhaseHasAuthoritativeVerdicts(
		'critic',
		composePrReviewPhaseVerdicts(directory, state, 'critic', ctx),
		verdicts,
		origin,
	);
	return verdicts;
}

/**
 * The critic-coverage gate's input, with the "empty" case made provable.
 *
 * `completePrWorkflow` and the `post_critic` artifact boundary both branch on
 * `length > 0` to decide whether the critic phase is required *at all*, so an
 * empty result there must provably mean "no CONFIRMED CRITICAL/HIGH/MEDIUM
 * reviewer verdict exists" and never "the reviewer verdict map came back empty".
 * Two distinct pathologies produce the same `[]`:
 *
 * 1. the reviewer phase was never settled — rejected here explicitly;
 * 2. the reviewer phase settled but its verdict map is empty or partial —
 *    rejected by `assertSettledPhaseHasAuthoritativeVerdicts` (B1).
 *
 * Past both, `[]` is a filter result over a map that covers every required
 * reviewer item. This cannot newly block any state reachable today: both call
 * sites run `assertPrReviewValidationSettled(..., 'reviewer', ctx)` on the same
 * context immediately beforehand, which already throws on `unclaimed > 0`. The
 * point is that the guarantee stops depending on that adjacency.
 *
 * Deliberately NOT folded into `derivePrReviewCriticInventory` itself:
 * `prunePrWorkflowBatchesForCapacity` derives the critic inventory on states
 * whose reviewer phase is legitimately unsettled, and its fail-closed try/catch
 * would convert the throw into "keep every batch", silently disabling GC.
 */
function derivePrReviewCriticInventoryForCoverageGate(
	directory: string,
	state: PrWorkflowGateState,
	ctx: PrReviewGateContext,
	origin: string,
): string[] {
	const reviewer = composePrReviewPhaseVerdicts(
		directory,
		state,
		'reviewer',
		ctx,
	);
	if (reviewer.unclaimed.length > 0) {
		const named = reviewer.unclaimed.slice(0, MAX_UNCLAIMED_ITEMS_IN_MESSAGE);
		const overflow = reviewer.unclaimed.length - named.length;
		throw new Error(
			`BLOCKED: PR_REVIEW internal invariant violated at ${origin}: the critic-coverage decision requires a settled reviewer phase, ` +
				`but ${reviewer.unclaimed.length} reviewer item(s) lack an authenticated verdict; an unsettled reviewer phase derives an empty ` +
				`critic inventory, which would skip critic coverage instead of demanding it; unsettled reviewer items: ${named.join(', ')}` +
				(overflow > 0 ? ` (+${overflow} more)` : ''),
		);
	}
	return derivePrReviewCriticInventory(directory, state, ctx);
}

interface ExpectedWorkflowLane {
	laneId: string;
	workflowLane: string;
	reviewItemIds?: string[];
	ownedWorkflowLanes?: string[];
}

interface QualifiedBatchRecord {
	record: ReturnType<typeof findByBatchId>[number];
	expectedLane: ExpectedWorkflowLane;
	expectedWorkflowLane: string;
	expectedOwnedLanes: string[];
}

type BatchRecordIntegrityAnalysis =
	| ({ ok: true } & QualifiedBatchRecord)
	| {
			ok: false;
			expectedLane: ExpectedWorkflowLane;
			expectedWorkflowLane: string;
			expectedOwnedLanes: string[];
			failure: PrReviewLaneValidationFailure;
	  };

function boundedLaneValidationValue(value: unknown): string {
	let rendered: string;
	try {
		rendered = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		rendered = String(value);
	}
	const sanitized = [...(rendered ?? String(value))]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127 ? ' ' : character;
		})
		.join('')
		.trim();
	return sanitized.length <= MAX_LANE_VALIDATION_VALUE_CHARS
		? sanitized
		: `${sanitized.slice(0, MAX_LANE_VALIDATION_VALUE_CHARS - 1)}…`;
}

function failedLaneValidation(
	predicate: PrReviewLaneValidationPredicate,
	expected: unknown,
	actual: unknown,
): { ok: false; failure: PrReviewLaneValidationFailure } {
	return {
		ok: false,
		failure: {
			predicate,
			expected: boundedLaneValidationValue(expected),
			actual: boundedLaneValidationValue(actual),
		},
	};
}

export function formatPrReviewLaneValidationFailure(
	failure: PrReviewLaneValidationFailure,
): string {
	return `predicate=${failure.predicate} expected=${JSON.stringify(failure.expected)} actual=${JSON.stringify(failure.actual)}`.slice(
		0,
		MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS,
	);
}

interface LaneRecordResultExpected {
	mode: string;
	workflowLane: string;
	ownedWorkflowLanes: readonly string[];
	prHeadSha: string;
	gitHead: string;
	checkWorkflowLane: boolean;
}

function analyzeLaneRecordResultIntegrity(args: {
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult | undefined;
	expected: LaneRecordResultExpected;
	requireCompleted: boolean;
	allowTranscriptIncompleteRecovery: boolean;
}): PrReviewLaneValidationResult {
	const { record, result, expected } = args;
	if (
		expected.checkWorkflowLane &&
		record.workflowLane !== expected.workflowLane
	) {
		return failedLaneValidation(
			'record.workflow_lane',
			expected.workflowLane,
			record.workflowLane ?? '(missing)',
		);
	}
	if (
		expected.checkWorkflowLane &&
		!ownedLaneSetsEqual(record.ownedWorkflowLanes, expected.ownedWorkflowLanes)
	) {
		return failedLaneValidation(
			'record.owned_workflow_lanes',
			expected.ownedWorkflowLanes,
			record.ownedWorkflowLanes ??
				(record.workflowLane ? [record.workflowLane] : []),
		);
	}
	if (record.mode !== expected.mode) {
		return failedLaneValidation(
			'record.mode',
			expected.mode,
			record.mode ?? '(missing)',
		);
	}
	if (record.workspace?.prHeadSha !== expected.prHeadSha) {
		return failedLaneValidation(
			'record.pr_head_sha',
			expected.prHeadSha,
			record.workspace?.prHeadSha ?? '(missing)',
		);
	}
	if (record.workspace?.gitHead !== expected.gitHead) {
		return failedLaneValidation(
			'record.git_head',
			expected.gitHead,
			record.workspace?.gitHead ?? '(missing)',
		);
	}
	if (args.requireCompleted && record.status !== 'completed') {
		return failedLaneValidation('record.status', 'completed', record.status);
	}
	if (result?.outputDegraded === true) {
		return failedLaneValidation('result.output_degraded', 'not true', true);
	}
	if (
		result?.transcriptIncomplete === true &&
		!args.allowTranscriptIncompleteRecovery
	) {
		return failedLaneValidation(
			'result.transcript_incomplete',
			'false outside discovery candidate recovery',
			true,
		);
	}
	if ((result?.chars ?? 0) <= 0) {
		return failedLaneValidation(
			'result.chars',
			'greater than 0',
			result?.chars ?? 0,
		);
	}
	if (!result?.digest?.trim()) {
		return failedLaneValidation(
			'result.digest',
			'non-empty digest',
			result?.digest ?? '(missing)',
		);
	}
	if (!result?.outputRef?.trim()) {
		return failedLaneValidation(
			'result.output_ref',
			'non-empty output ref',
			result?.outputRef ?? '(missing)',
		);
	}
	return { ok: true };
}

function analyzePrReviewBatchRecordIntegrity(args: {
	batchId: string;
	expectedLanes: ReadonlyArray<ExpectedWorkflowLane>;
	expectedMode: string;
	validatedAt: string;
	checkWorkflowLane: boolean;
	forbiddenSubagentSessionIds: ReadonlySet<string>;
	records: readonly BackgroundDelegationRecord[];
	expectedPrHeadSha?: string;
}): BatchRecordIntegrityAnalysis[] {
	const validatedAtMs = Date.parse(args.validatedAt);
	const expectedByLaneId = new Map(
		args.expectedLanes.map((lane) => [lane.laneId, lane]),
	);
	const batchFailure = !Number.isFinite(validatedAtMs)
		? failedLaneValidation(
				'batch.validated_at',
				'valid ISO timestamp',
				args.validatedAt,
			)
		: expectedByLaneId.size !== args.expectedLanes.length
			? failedLaneValidation(
					'batch.expected_lane_unique',
					'unique expected lane ids',
					args.expectedLanes.map((lane) => lane.laneId),
				)
			: null;
	const relevantRecords = args.records.filter(
		(record) => record.laneId && expectedByLaneId.has(record.laneId),
	);
	const recordsByLaneId = new Map<string, BackgroundDelegationRecord[]>();
	const recordCountBySubagentSessionId = new Map<string, number>();
	for (const record of relevantRecords) {
		const laneRecords = recordsByLaneId.get(record.laneId!) ?? [];
		laneRecords.push(record);
		recordsByLaneId.set(record.laneId!, laneRecords);
		const sessionId = record.subagentSessionId?.trim();
		if (sessionId) {
			recordCountBySubagentSessionId.set(
				sessionId,
				(recordCountBySubagentSessionId.get(sessionId) ?? 0) + 1,
			);
		}
	}

	return args.expectedLanes.map((expectedLane) => {
		const expectedWorkflowLane = expectedLane.workflowLane;
		const expectedOwnedLanes = expectedLane.ownedWorkflowLanes?.length
			? expectedLane.ownedWorkflowLanes
			: [expectedWorkflowLane];
		const failed = (
			failure: PrReviewLaneValidationFailure,
		): BatchRecordIntegrityAnalysis => ({
			ok: false,
			expectedLane,
			expectedWorkflowLane,
			expectedOwnedLanes,
			failure,
		});
		if (batchFailure && !batchFailure.ok) return failed(batchFailure.failure);
		const laneRecords = recordsByLaneId.get(expectedLane.laneId) ?? [];
		if (laneRecords.length === 0) {
			return failed(
				failedLaneValidation('record.missing', 'exactly one record', 0).failure,
			);
		}
		if (laneRecords.length !== 1) {
			return failed(
				failedLaneValidation(
					'record.duplicate_lane',
					'exactly one record',
					laneRecords.length,
				).failure,
			);
		}
		const record = laneRecords[0];
		const subagentSessionId = record.subagentSessionId?.trim();
		if (!subagentSessionId) {
			return failed(
				failedLaneValidation(
					'record.subagent_session_id',
					'non-empty child session id',
					record.subagentSessionId ?? '(missing)',
				).failure,
			);
		}
		if (recordCountBySubagentSessionId.get(subagentSessionId) !== 1) {
			return failed(
				failedLaneValidation(
					'record.duplicate_subagent_session_id',
					'one record per child session',
					recordCountBySubagentSessionId.get(subagentSessionId),
				).failure,
			);
		}
		if (args.forbiddenSubagentSessionIds.has(subagentSessionId)) {
			return failed(
				failedLaneValidation(
					'record.forbidden_subagent_session_id',
					'child session not reused from a forbidden phase',
					subagentSessionId,
				).failure,
			);
		}
		if (record.createdAt < validatedAtMs) {
			return failed(
				failedLaneValidation(
					'record.created_at',
					`at or after ${args.validatedAt}`,
					new Date(record.createdAt).toISOString(),
				).failure,
			);
		}
		const recordIntegrity = analyzeLaneRecordResultIntegrity({
			record,
			result: record.result,
			expected: {
				mode: args.expectedMode,
				workflowLane: expectedWorkflowLane,
				ownedWorkflowLanes: expectedOwnedLanes,
				prHeadSha: args.expectedPrHeadSha ?? record.workspace?.prHeadSha ?? '',
				gitHead: args.expectedPrHeadSha ?? record.workspace?.gitHead ?? '',
				checkWorkflowLane: args.checkWorkflowLane,
			},
			requireCompleted: true,
			allowTranscriptIncompleteRecovery:
				args.expectedMode === 'swarm-pr-review:base' ||
				args.expectedMode === 'swarm-pr-review:micro',
		});
		if (!recordIntegrity.ok) return failed(recordIntegrity.failure);
		return {
			ok: true,
			record,
			expectedLane,
			expectedWorkflowLane,
			expectedOwnedLanes,
		};
	});
}

/**
 * Every record of a batch that passes the record-level integrity chain: exactly
 * one record per declared lane, exactly one record per child session, no reuse
 * of a forbidden child session, recorded after the batch was declared, exact
 * lane/ownership/mode/head match, and a non-degraded result with retrievable
 * output. Discovery modes may pass this identity chain with a partial transcript
 * only so the later semantic validator can distinguish positive candidate
 * recovery from invalid negative evidence.
 *
 * Extracted so the per-item composition can reuse the identical chain instead of
 * re-deriving it. `successfulObligationsFromExactBatch` composes this with the
 * contract-marker check.
 */
function recordsPassingBatchIntegrity(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	expectedLanes: ReadonlyArray<ExpectedWorkflowLane>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane = true,
	forbiddenSubagentSessionIds: ReadonlySet<string> = new Set(),
	diagnostics?: string[],
): QualifiedBatchRecord[] {
	const records = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	});
	const analyses = analyzePrReviewBatchRecordIntegrity({
		batchId,
		expectedLanes,
		expectedMode,
		validatedAt,
		checkWorkflowLane,
		forbiddenSubagentSessionIds,
		records,
		expectedPrHeadSha: state.prHeadSha,
	});
	for (const analysis of analyses) {
		if (
			!analysis.ok &&
			diagnostics &&
			diagnostics.length < MAX_BASE_COVERAGE_DIAGNOSTICS
		) {
			diagnostics.push(
				`batch=${batchId} lane=${analysis.expectedLane.laneId} workflow_lane=${analysis.expectedWorkflowLane}: ${formatPrReviewLaneValidationFailure(analysis.failure)}`.slice(
					0,
					MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS,
				),
			);
		}
	}
	return analyses.filter(
		(
			analysis,
		): analysis is Extract<BatchRecordIntegrityAnalysis, { ok: true }> =>
			analysis.ok,
	);
}

function successfulObligationsFromExactBatch(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	expectedLanes: ReadonlyArray<ExpectedWorkflowLane>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane = true,
	forbiddenSubagentSessionIds: ReadonlySet<string> = new Set(),
	expectedRevisionDigest?: string,
	diagnostics?: string[],
	reviewerClaims?: ReadonlyMap<string, PrReviewItemClaim>,
): Set<string> {
	const successful = new Set<string>();
	for (const qualified of recordsPassingBatchIntegrity(
		directory,
		state,
		batchId,
		expectedLanes,
		expectedMode,
		validatedAt,
		checkWorkflowLane,
		forbiddenSubagentSessionIds,
		diagnostics,
	)) {
		const structuredCoverage = validateExactStructuredReceiptCoverage({
			record: qualified.record,
			result: qualified.record.result!,
			artifact: null,
			expected: {
				mode:
					expectedMode === 'swarm-pr-review:base' ||
					expectedMode === 'swarm-pr-review:micro'
						? expectedMode
						: 'swarm-pr-review:base',
				workflowLane: qualified.expectedWorkflowLane,
				ownedWorkflowLanes: qualified.expectedOwnedLanes,
				prHeadSha: state.prHeadSha ?? '',
				gitHead: state.prHeadSha ?? '',
				revisionDigest: expectedRevisionDigest ?? '',
				workflowInstanceId: state.workflowInstanceId,
				workflowRevision: qualified.record.workflowGeneration,
				baseSha: state.prReviewBaseSha,
				reviewScope:
					state.mode === 'PR_REVIEW' && state.prReviewBaseSha && state.prHeadSha
						? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
						: undefined,
			},
		});
		if (structuredCoverage.status === 'accepted') {
			for (const obligation of structuredCoverage.creditedWorkflowLanes) {
				successful.add(obligation);
			}
			continue;
		}
		if (structuredCoverage.status === 'rejected') {
			if (diagnostics && diagnostics.length < MAX_BASE_COVERAGE_DIAGNOSTICS) {
				diagnostics.push(
					`batch=${batchId} lane=${qualified.expectedLane.laneId} workflow_lane=${qualified.expectedWorkflowLane}: ${formatPrReviewLaneValidationFailure(structuredCoverage.failure)}`.slice(
						0,
						MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS,
					),
				);
			}
			continue;
		}
		if (
			workflowArtifactHasContractMarker(
				directory,
				state,
				qualified.record,
				expectedMode,
				qualified.expectedWorkflowLane,
				qualified.expectedLane.reviewItemIds,
				expectedRevisionDigest,
				qualified.expectedOwnedLanes,
				diagnostics,
				reviewerClaims,
			)
		) {
			for (const obligation of qualified.expectedOwnedLanes) {
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

type ExactStructuredReceiptCoverageValidation =
	| { status: 'absent' }
	| {
			status: 'accepted';
			creditedWorkflowLanes: string[];
			receipt: PrReviewResultReceipt;
	  }
	| { status: 'rejected'; failure: PrReviewLaneValidationFailure };

function validateExactStructuredReceiptCoverage(
	input: PrReviewDiscoveryLaneValidationInput,
): ExactStructuredReceiptCoverageValidation {
	if (
		input.expected.mode !== 'swarm-pr-review:base' &&
		input.expected.mode !== 'swarm-pr-review:micro'
	) {
		return { status: 'absent' };
	}
	const rawReceipt = input.result.prReviewResultReceipt;
	if (!rawReceipt) return { status: 'absent' };
	const parsedReceipt = PrReviewResultReceiptSchema.safeParse(rawReceipt);
	if (!parsedReceipt.success) {
		return {
			status: 'rejected',
			failure: failedLaneValidation(
				'discovery.coverage',
				'schema-valid exact child/workflow/revision-bound structured receipt',
				'invalid structured receipt',
			).failure,
		};
	}
	if (
		input.expected.workflowInstanceId === undefined ||
		input.expected.workflowRevision === undefined ||
		input.expected.baseSha === undefined
	) {
		return {
			status: 'rejected',
			failure: failedLaneValidation(
				'discovery.coverage',
				'live workflow instance/revision/base identity',
				'missing live workflow instance/revision/base identity',
			).failure,
		};
	}
	const receipt = parsedReceipt.data;
	const recordWorkflowInstanceId = decodePrReviewWorkflowBinding(
		input.record.jobId,
	);
	const recordWorkflowRevision = input.record.workflowGeneration;
	const ownedWorkflowLanes = input.expected.ownedWorkflowLanes?.length
		? [...input.expected.ownedWorkflowLanes]
		: [input.expected.workflowLane];
	if (
		!recordWorkflowInstanceId ||
		recordWorkflowRevision === undefined ||
		recordWorkflowInstanceId !== input.expected.workflowInstanceId ||
		recordWorkflowRevision !== input.expected.workflowRevision ||
		receipt.mode !== input.expected.mode ||
		receipt.workflowInstanceId !== recordWorkflowInstanceId ||
		receipt.workflowRevision !== recordWorkflowRevision ||
		receipt.baseSha !== input.expected.baseSha ||
		receipt.batchId !== input.record.batchId ||
		receipt.laneId !== input.record.laneId ||
		receipt.childSessionId !== input.record.subagentSessionId ||
		receipt.workflowLane !== input.expected.workflowLane ||
		!ownedLaneSetsEqual(receipt.ownedWorkflowLanes, ownedWorkflowLanes) ||
		receipt.headSha !== input.expected.prHeadSha ||
		receipt.dispatchRevisionDigest !== input.expected.revisionDigest
	) {
		return {
			status: 'rejected',
			failure: failedLaneValidation(
				'discovery.coverage',
				'exact child/workflow/revision-bound structured receipt',
				'mismatched structured receipt',
			).failure,
		};
	}
	return {
		status: 'accepted',
		creditedWorkflowLanes: receipt.envelope.creditedLanes.filter((lane) =>
			ownedWorkflowLanes.includes(lane),
		),
		receipt,
	};
}

interface LaneArtifactExpected {
	mode: string;
	workflowLane: string;
	prHeadSha: string;
	gitHead: string;
	revisionDigest: string;
	reviewScope?: string;
}

function analyzeLaneArtifactIntegrity(args: {
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
	artifact: LaneOutputArtifact | null;
	expected: LaneArtifactExpected;
}): PrReviewLaneValidationResult {
	const { record, result, artifact, expected } = args;
	if (!artifact) {
		return failedLaneValidation(
			'artifact.readable',
			'readable stored artifact',
			'missing or invalid',
		);
	}
	if (artifact.ref !== result.outputRef?.trim()) {
		return failedLaneValidation(
			'artifact.ref',
			result.outputRef?.trim() ?? '(missing)',
			artifact.ref,
		);
	}
	if (artifact.batchId !== record.batchId) {
		return failedLaneValidation(
			'artifact.batch_id',
			record.batchId ?? '(missing)',
			artifact.batchId,
		);
	}
	if (artifact.laneId !== record.laneId) {
		return failedLaneValidation(
			'artifact.lane_id',
			record.laneId ?? '(missing)',
			artifact.laneId,
		);
	}
	if (artifact.mode !== expected.mode) {
		return failedLaneValidation(
			'artifact.mode',
			expected.mode,
			artifact.mode ?? '(missing)',
		);
	}
	if (artifact.sessionId !== record.subagentSessionId) {
		return failedLaneValidation(
			'artifact.session_id',
			record.subagentSessionId,
			artifact.sessionId ?? '(missing)',
		);
	}
	if (artifact.parentSessionId !== record.parentSessionId) {
		return failedLaneValidation(
			'artifact.parent_session_id',
			record.parentSessionId,
			artifact.parentSessionId ?? '(missing)',
		);
	}
	if (artifact.agent !== record.swarmPrefixedAgent) {
		return failedLaneValidation(
			'artifact.agent',
			record.swarmPrefixedAgent,
			artifact.agent,
		);
	}
	if (artifact.role !== record.normalizedAgent) {
		return failedLaneValidation(
			'artifact.role',
			record.normalizedAgent,
			artifact.role,
		);
	}
	if (artifact.source !== 'collect_lane_results') {
		return failedLaneValidation(
			'artifact.source',
			'collect_lane_results',
			artifact.source,
		);
	}
	if (artifact.workflowLane !== record.workflowLane) {
		return failedLaneValidation(
			'artifact.workflow_lane_record',
			record.workflowLane ?? '(missing)',
			artifact.workflowLane ?? '(missing)',
		);
	}
	if (artifact.workflowLane !== expected.workflowLane) {
		return failedLaneValidation(
			'artifact.workflow_lane_expected',
			expected.workflowLane,
			artifact.workflowLane ?? '(missing)',
		);
	}
	if (artifact.prHeadSha !== expected.prHeadSha) {
		return failedLaneValidation(
			'artifact.pr_head_sha',
			expected.prHeadSha,
			artifact.prHeadSha ?? '(missing)',
		);
	}
	if (artifact.gitHead !== expected.gitHead) {
		return failedLaneValidation(
			'artifact.git_head',
			expected.gitHead,
			artifact.gitHead ?? '(missing)',
		);
	}
	if (artifact.revisionDigest !== expected.revisionDigest) {
		return failedLaneValidation(
			'artifact.revision_digest',
			expected.revisionDigest,
			artifact.revisionDigest ?? '(missing)',
		);
	}
	if (
		expected.reviewScope !== undefined &&
		record.workspace?.scope !== expected.reviewScope
	) {
		return failedLaneValidation(
			'record.scope',
			expected.reviewScope,
			record.workspace?.scope ?? '(missing)',
		);
	}
	if (
		expected.reviewScope !== undefined &&
		artifact.scope !== expected.reviewScope
	) {
		return failedLaneValidation(
			'artifact.scope',
			expected.reviewScope,
			artifact.scope ?? '(missing)',
		);
	}
	if (artifact.digest !== result.digest) {
		return failedLaneValidation(
			'artifact.digest',
			result.digest,
			artifact.digest,
		);
	}
	if (artifact.chars !== result.chars) {
		return failedLaneValidation('artifact.chars', result.chars, artifact.chars);
	}
	return { ok: true };
}

/**
 * The mode-independent half of the contract-marker check: load the lane artifact
 * and prove it is the exact artifact this delegation record produced, on this
 * revision, for this identity. Returns the artifact when the lane passes, `null`
 * otherwise.
 *
 * Split out of `workflowArtifactHasContractMarker` so the item-keyed composition
 * can admit *individual items* from a lane. The marker function itself still
 * ends in an all-items-or-nothing verdict, which is what base, council, micro
 * and every PR_FEEDBACK caller require and continue to get unchanged.
 *
 * `expectedRevisionDigest` is required (issue #1968 FIX 7). It used to fall back
 * to a per-record synchronous `resolvePrWorkflowRevisionDigest`, which was dead
 * in production — every entry point threads a digest resolved once per gate call
 * from a context that hard-throws when it cannot be resolved — while keeping an
 * unchunked `readFileSync` snapshot loop reachable under the raised 512 MB cap.
 * An empty digest still fails closed below rather than matching an artifact.
 */
function loadArtifactPassingLaneIntegrity(
	directory: string,
	state: PrWorkflowGateState,
	record: ReturnType<typeof findByBatchId>[number],
	expectedMode: string,
	expectedWorkflowLane: string,
	expectedRevisionDigest: string,
	diagnostics?: string[],
): LaneOutputArtifact | null {
	const ref = record.result?.outputRef?.trim();
	if (!ref) return null;
	const loaded = readLaneOutput(directory, ref);
	const artifact = loaded?.artifact ?? null;
	const expectedReviewScope =
		state.mode === 'PR_REVIEW' && state.prReviewBaseSha && state.prHeadSha
			? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
			: undefined;
	const integrity = analyzeLaneArtifactIntegrity({
		record,
		result: record.result!,
		artifact,
		expected: {
			mode: expectedMode,
			workflowLane: expectedWorkflowLane,
			prHeadSha: record.workspace?.prHeadSha ?? '',
			gitHead: record.workspace?.gitHead ?? '',
			revisionDigest: expectedRevisionDigest,
			reviewScope: expectedReviewScope,
		},
	});
	if (!integrity.ok) {
		if (diagnostics && diagnostics.length < MAX_BASE_COVERAGE_DIAGNOSTICS) {
			diagnostics.push(
				`batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'} workflow_lane=${expectedWorkflowLane} output_ref=${ref}: ${formatPrReviewLaneValidationFailure(integrity.failure)}`.slice(
					0,
					MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS,
				),
			);
		}
		return null;
	}
	return artifact;
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
	diagnostics?: string[],
	// Reviewer claims for the critic branch. The only production caller that
	// reaches that branch is the legacy-eligibility predicate in the composition,
	// which always passes the memoized map. Absent, the critic branch degrades to
	// the pre-existing "reviewer map was empty" behaviour rather than inventing a
	// second reviewer derivation with its own digest cost.
	reviewerClaims?: ReadonlyMap<string, PrReviewItemClaim>,
): boolean {
	const ref = record.result?.outputRef?.trim();
	// Fail closed rather than resolving a digest here (issue #1968 FIX 7): every
	// production path threads the gate's single memoized digest, so an absent one
	// means a caller skipped the resolve, not that a per-record resolve is owed.
	const artifact = expectedRevisionDigest
		? loadArtifactPassingLaneIntegrity(
				directory,
				state,
				record,
				expectedMode,
				expectedWorkflowLane,
				expectedRevisionDigest,
				diagnostics,
			)
		: null;
	if (!artifact) return false;
	if (
		expectedMode === 'swarm-pr-review:reviewer' ||
		expectedMode === 'swarm-pr-review:critic'
	) {
		const phase: PrReviewComposablePhase =
			expectedMode === 'swarm-pr-review:reviewer' ? 'reviewer' : 'critic';
		return analyzeLegacyVerdictRowContract(
			artifact.text,
			reviewItemIds ?? [],
			phase,
			reviewerClaims,
		).ok;
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
					legacyArtifactHasExactPositiveVerdictRow(
						artifact.text,
						feedbackVerdict[0],
						itemId,
						feedbackVerdict[1],
					),
				),
		);
	}
	if (
		expectedMode === 'swarm-pr-review:base' ||
		expectedMode === 'swarm-pr-review:micro'
	) {
		const reviewScope =
			state.mode === 'PR_REVIEW' && state.prReviewBaseSha && state.prHeadSha
				? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
				: undefined;
		const validation = validatePrReviewDiscoveryLaneCompletion({
			record,
			result: record.result!,
			artifact,
			expected: {
				mode: expectedMode,
				workflowLane: expectedWorkflowLane,
				ownedWorkflowLanes,
				prHeadSha: state.prHeadSha ?? '',
				gitHead: state.prHeadSha ?? '',
				revisionDigest: expectedRevisionDigest ?? '',
				workflowInstanceId: state.workflowInstanceId,
				workflowRevision: record.workflowGeneration,
				baseSha: state.prReviewBaseSha,
				reviewScope,
			},
		});
		if (!validation.ok) {
			if (diagnostics && diagnostics.length < MAX_BASE_COVERAGE_DIAGNOSTICS) {
				diagnostics.push(
					`batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'} workflow_lane=${expectedWorkflowLane} output_ref=${ref}: ${formatPrReviewLaneValidationFailure(validation.failure)}`.slice(
						0,
						MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS,
					),
				);
			}
			return false;
		}
		return true;
	}
	const coveredLanes = ownedWorkflowLanes?.length
		? ownedWorkflowLanes
		: [expectedWorkflowLane];
	const coverageAnalyses = coveredLanes.map((coveredLane) => ({
		coveredLane,
		analysis: analyzePrReviewDiscoveryArtifact(
			artifact.text,
			coveredLane,
			coveredLanes,
			expectedMode,
		),
	}));
	if (coverageAnalyses.some(({ analysis }) => !analysis.covered)) {
		for (const { coveredLane, analysis } of coverageAnalyses) {
			if (analysis.covered || analysis.issues.length === 0) continue;
			if (diagnostics && diagnostics.length < MAX_BASE_COVERAGE_DIAGNOSTICS) {
				const diagnostic = `batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'} workflow_lane=${coveredLane} output_ref=${ref} digest=${record.result?.digest ?? '(missing)'}: ${analysis.issues.join('; ')}`;
				diagnostics.push(
					diagnostic.slice(0, MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS),
				);
			}
		}
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
				coveredLanes,
				expectedMode,
			);
			if (evidence === null) continue;
			const priorLane = seenEvidence.get(evidence);
			if (priorLane) return false;
			seenEvidence.set(evidence, coveredLane);
		}
	}
	return true;
}

interface PrReviewDiscoveryCoverageAnalysis {
	covered: boolean;
	evidence: string | null;
	issues: string[];
	coverageKind: 'candidate' | 'clean' | null;
	/**
	 * True when coverage required any explicit normalization repair. Surfaced so
	 * a repaired artifact is auditable rather than silently indistinguishable
	 * from a well-formed one.
	 */
	salvaged: boolean;
	repairKinds: readonly CandidateArtifactRepairKind[];
	/**
	 * The parse retained this lane's candidate rows but discredited a conflicting
	 * `[CLEAN]` attestation. Tracked separately from `repairKinds` because nothing
	 * was repaired — an assertion was dropped (issue #2279).
	 */
	cleanAttestationSalvaged: boolean;
	failurePredicate?: Extract<
		PrReviewLaneValidationPredicate,
		'discovery.header' | 'discovery.row' | 'discovery.coverage'
	>;
}

function analyzePrReviewDiscoveryArtifact(
	text: string,
	expectedWorkflowLane: string,
	ownedWorkflowLanes: readonly string[] = [expectedWorkflowLane],
	mode?: string,
	acceptPartial = false,
): PrReviewDiscoveryCoverageAnalysis {
	// `mode` is threaded in so this site and the extraction site
	// (derivePrReviewCandidateInventory) resolve the row family from the SAME
	// input. Without it, a council lane named after a base dimension resolves
	// base_explorer here and micro_lane there, and the artifact can be judged
	// covered while contributing nothing to the inventory.
	const fallbackFamily = resolvePrReviewRowFamily(expectedWorkflowLane, mode);
	const issues: string[] = [];
	const normalized = normalizeCandidateArtifactCached(text, fallbackFamily);
	const canonicalText = normalized.text;
	const repairKinds = normalized.repairKinds;
	let salvaged = repairKinds.length > 0;
	let cleanAttestationSalvaged = false;
	const header = selectCandidateHeader(canonicalText.split(/\r?\n/));
	if (
		header === null ||
		!header.markerBearing ||
		header.family !== fallbackFamily
	) {
		appendBoundedCandidateIssue(
			issues,
			`field header: expected one exact canonical ${fallbackFamily} [CANDIDATE] header before discovery rows`,
		);
		return {
			covered: false,
			evidence: null,
			issues,
			coverageKind: null,
			salvaged,
			repairKinds,
			cleanAttestationSalvaged,
			failurePredicate: 'discovery.header',
		};
	}

	const parsed = parseCandidates(
		{
			output_ref: 'pr-workflow:discovery-artifact',
			batchId: 'pr-workflow',
			laneId: expectedWorkflowLane,
			agent: 'explorer',
			role: 'explorer',
			digest: '0'.repeat(64),
			text: canonicalText,
			artifact_status: 'ok',
			source: 'collect_lane_results',
			produced_at: '1970-01-01T00:00:00.000Z',
		},
		{
			accept_partial: acceptPartial,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			producer: 'swarm-pr-review',
			expected_family: fallbackFamily,
			...(fallbackFamily === 'base_explorer'
				? {
						expected_lane: expectedWorkflowLane,
						expected_lanes: [...ownedWorkflowLanes],
					}
				: {
						expected_micro_lane: expectedWorkflowLane,
						expected_micro_lanes: [...ownedWorkflowLanes],
					}),
		},
	);
	if (parsed.error) appendBoundedCandidateIssue(issues, parsed.error);
	// A discredited-but-salvaged CLEAN no longer arrives as `parsed.error`, so it
	// is re-entered here as BOTH an issue and a salvage signal. The two are
	// redundant on purpose — `salvaged = true` alone already keeps the lane in
	// the durable salvagedLanes/recoveries ledger — but the issue entry is what
	// carries the human-readable reason into the post-mortem diagnostics.
	if (parsed.clean_attestation_salvaged) {
		cleanAttestationSalvaged = true;
		salvaged = true;
		appendBoundedCandidateIssue(
			issues,
			parsed.clean_attestation_salvage_reason ??
				'CLEAN attestation discredited; candidate rows retained',
		);
	}
	for (const detail of parsed.diagnostics.parse_error_details) {
		appendBoundedCandidateIssue(
			issues,
			`row ${detail.row_index + 1} field ${detail.field}: ${detail.message}`,
		);
	}
	const hasParseFailure =
		Boolean(parsed.error) ||
		// Keeps the predicate identical to pre-#2279 behaviour: this shape used to
		// surface as `parsed.error`, so a lane that ends up uncovered must still
		// report `discovery.row` rather than silently becoming `discovery.coverage`.
		Boolean(parsed.clean_attestation_salvaged) ||
		parsed.diagnostics.parse_error_details.length > 0;
	// Duplicate candidate ids are the one row defect that is never salvaged: the
	// inventory they feed is asserted globally unique, so admitting them would
	// convert a recoverable lane defect into a late workflow-wide failure.
	//
	// Checked against the EXTRACTOR's rows rather than the parser's diagnostics.
	// The parser drops an out-of-ownership row before its duplicate detector runs,
	// so a reused id spread across one owned and one foreign row produces no
	// duplicate diagnostic at all — while extractCandidateIds deliberately keeps
	// both rows (an unscoped extraction is intentional so inconsistent lane
	// labelling never silently drops a real candidate). Reading the extractor's
	// output is the only check that sees exactly what assertNoDuplicates will.
	const extractedCandidateIds = parseCanonicalCandidateRows(
		canonicalText,
		fallbackFamily,
	).rows.map((row) => row.candidateId);
	const hasDuplicateCandidateId =
		new Set(extractedCandidateIds).size !== extractedCandidateIds.length;
	if (hasDuplicateCandidateId) {
		return {
			covered: false,
			evidence: null,
			issues,
			coverageKind: null,
			salvaged,
			repairKinds,
			cleanAttestationSalvaged,
			failurePredicate: 'discovery.row',
		};
	}
	// Otherwise a malformed row is a diagnostic, not a verdict: valid rows that
	// establish coverage are retained and the defective ones are reported.
	const matchingCandidate = parsed.candidates.find(
		(candidate) =>
			(candidate.lane ?? candidate.micro_lane) === expectedWorkflowLane,
	);
	if (matchingCandidate) {
		return {
			covered: true,
			evidence: [
				matchingCandidate.severity,
				matchingCandidate.category,
				matchingCandidate.file_line,
				matchingCandidate.claim,
				matchingCandidate.evidence_summary,
				matchingCandidate.impact_context ??
					matchingCandidate.invariant_violated,
				matchingCandidate.confidence,
			].join('\0'),
			issues,
			coverageKind: 'candidate',
			salvaged,
			repairKinds,
			cleanAttestationSalvaged,
		};
	}
	const clean = parsed.clean_attestation;
	if (
		clean &&
		(clean.row_format_family === 'base_explorer'
			? clean.lane
			: clean.micro_lane) === expectedWorkflowLane
	) {
		return {
			covered: true,
			evidence: `${clean.coverage_scope}\0${clean.evidence}`,
			issues,
			coverageKind: 'clean',
			salvaged,
			repairKinds,
			cleanAttestationSalvaged,
		};
	}
	return {
		covered: false,
		evidence: null,
		issues,
		coverageKind: null,
		salvaged,
		repairKinds,
		cleanAttestationSalvaged,
		// Preserve today's predicate: a row-level defect is still reported as
		// such once it turns out no valid row could establish coverage.
		failurePredicate: hasParseFailure ? 'discovery.row' : 'discovery.coverage',
	};
}

/**
 * Validate a just-collected base, micro, or council discovery result before the
 * delegation ledger publishes it as completed. The caller supplies the
 * prospective result and exact stored artifact, so this pure validator cannot
 * accidentally accept stale terminal state or a different output reference.
 */
export function validatePrReviewDiscoveryLaneCompletion(
	input: PrReviewDiscoveryLaneValidationInput,
): PrReviewLaneValidationResult {
	const ownedWorkflowLanes = input.expected.ownedWorkflowLanes?.length
		? [...input.expected.ownedWorkflowLanes]
		: [input.expected.workflowLane];
	const recordIntegrity = analyzeLaneRecordResultIntegrity({
		record: input.record,
		result: input.result,
		expected: {
			mode: input.expected.mode,
			workflowLane: input.expected.workflowLane,
			ownedWorkflowLanes,
			prHeadSha: input.expected.prHeadSha,
			gitHead: input.expected.gitHead,
			checkWorkflowLane: input.expected.checkWorkflowLane ?? true,
		},
		requireCompleted: false,
		allowTranscriptIncompleteRecovery:
			input.expected.mode === 'swarm-pr-review:base' ||
			input.expected.mode === 'swarm-pr-review:micro',
	});
	if (!recordIntegrity.ok) return recordIntegrity;
	const structuredCoverage = validateExactStructuredReceiptCoverage(input);
	if (structuredCoverage.status === 'accepted') {
		return { ok: true };
	}
	if (structuredCoverage.status === 'rejected') {
		return { ok: false, failure: structuredCoverage.failure };
	}
	if (
		(input.expected.mode === 'swarm-pr-review:base' ||
			input.expected.mode === 'swarm-pr-review:micro') &&
		!prReviewLegacyTranscriptCompatibilityEnabled(
			input.record.prReviewLegacyTranscriptCompatibility,
		)
	) {
		return failedLaneValidation(
			'discovery.coverage',
			'child-bound structured receipt',
			'missing structured receipt (legacy transcript adapter disabled)',
		);
	}
	const artifactIntegrity = analyzeLaneArtifactIntegrity({
		record: input.record,
		result: input.result,
		artifact: input.artifact,
		expected: {
			mode: input.expected.mode,
			workflowLane: input.expected.workflowLane,
			prHeadSha: input.expected.prHeadSha,
			gitHead: input.expected.gitHead,
			revisionDigest: input.expected.revisionDigest,
			reviewScope: input.expected.reviewScope,
		},
	});
	if (!artifactIntegrity.ok) return artifactIntegrity;

	const artifact = input.artifact!;
	const analyses = ownedWorkflowLanes.map((workflowLane) => ({
		workflowLane,
		analysis: analyzePrReviewDiscoveryArtifact(
			artifact.text,
			workflowLane,
			ownedWorkflowLanes,
			input.expected.mode,
			input.result.transcriptIncomplete === true,
		),
	}));
	// A lane that is covered but carried defects is the whole point of salvage —
	// and also the one case the failure path never reports, because diagnostics
	// are only rendered for lanes that fail. Record them here so a repaired or
	// partially-dropped artifact is never silently indistinguishable from a
	// clean one.
	//
	// The returned `salvaged` list is the PRODUCTION signal: the caller persists it
	// as `salvagedWorkflowLanes` on the durable delegation ledger, which is what a
	// post-mortem actually reads. The `warn` below is debug-gated — `utils/logger.ts`
	// returns early unless `process.env.OPENCODE_SWARM_DEBUG === '1'` exactly, so any
	// other value (including `true`) leaves it silent — and is therefore a developer
	// convenience only. Do not treat it as the observability guarantee, and do not
	// weaken the ledger write on the assumption the log covers it.
	const salvagedLanes: string[] = [];
	const recoveries: BackgroundDelegationWorkflowLaneRecovery[] = [];
	const previewTruncated = input.result.truncated === true;
	const transcriptIncomplete = input.result.transcriptIncomplete === true;
	for (const { workflowLane, analysis } of analyses) {
		if (!analysis.covered) continue;
		const laneRecoveries: BackgroundDelegationWorkflowLaneRecovery[] = [];
		if (previewTruncated) {
			laneRecoveries.push({
				workflowLane,
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			});
		}
		if (transcriptIncomplete) {
			if (analysis.coverageKind === 'candidate') {
				laneRecoveries.push({
					workflowLane,
					kind: 'transcript-incomplete-terminal-candidate',
					reason:
						'partial transcript accepted only because a durable [CANDIDATE] row proved this lane',
				});
			} else if (analysis.coverageKind === 'clean') {
				return failedLaneValidation(
					'result.transcript_incomplete',
					'complete transcript for every [CLEAN] attestation',
					`workflow lane ${workflowLane} was covered only by [CLEAN] after a partial transcript fetch`,
				);
			}
		}
		if (
			laneRecoveries.length === 0 &&
			!analysis.salvaged &&
			analysis.issues.length === 0
		) {
			continue;
		}
		salvagedLanes.push(workflowLane);
		if (analysis.repairKinds.length > 0) {
			laneRecoveries.push({
				workflowLane,
				kind: 'parser-normalization',
				reason: `structural repairs applied: ${analysis.repairKinds.join(', ')}`,
			});
		}
		if (analysis.cleanAttestationSalvaged) {
			laneRecoveries.push({
				workflowLane,
				kind: 'clean-attestation-salvaged',
				reason:
					'a conflicting [CLEAN] attestation was discredited while the independently validated candidate rows were retained',
			});
		}
		if (analysis.issues.length > 0) {
			laneRecoveries.push({
				workflowLane,
				kind: 'parser-row-recovery',
				reason:
					'one or more malformed or out-of-ownership rows were dropped while retaining valid coverage',
			});
		}
		recoveries.push(...laneRecoveries);
		const reason = laneRecoveries.map((recovery) => recovery.reason).join('; ');
		warn(
			`[pr-workflow-gate] discovery artifact salvaged: batch=${input.record.batchId ?? '(missing)'} lane=${input.record.laneId ?? '(missing)'} workflow_lane=${workflowLane} — ${reason}; retained coverage from the valid rows. Dropped-row diagnostics: ${analysis.issues.join('; ') || '(none)'}`,
		);
	}
	const failedCoverage = analyses.find(({ analysis }) => !analysis.covered);
	if (failedCoverage) {
		return failedLaneValidation(
			failedCoverage.analysis.failurePredicate ?? 'discovery.coverage',
			`one valid ${input.expected.mode === 'swarm-pr-review:base' ? 'base_explorer' : 'micro_lane'} [CANDIDATE] row or [CLEAN] attestation for ${failedCoverage.workflowLane}`,
			failedCoverage.analysis.issues.join('; ') || 'no matching lane row',
		);
	}
	if (ownedWorkflowLanes.length > 1) {
		const seenEvidence = new Map<string, string>();
		for (const { workflowLane, analysis } of analyses) {
			if (analysis.evidence === null) continue;
			const priorLane = seenEvidence.get(analysis.evidence);
			if (priorLane) {
				return failedLaneValidation(
					'discovery.duplicate_evidence',
					'distinct evidence for every owned workflow lane',
					`${priorLane} and ${workflowLane} share evidence`,
				);
			}
			seenEvidence.set(analysis.evidence, workflowLane);
		}
	}
	return salvagedLanes.length > 0
		? { ok: true, salvaged: salvagedLanes, recoveries }
		: { ok: true };
}

/**
 * Collection-time proof for transport-recovered structured workflow lanes.
 *
 * Reviewer/critic/PR-feedback lanes normally settle later through the workflow
 * gate, not in `collect_lane_results`, so a truncated inline preview used to
 * pass through collection with no durable typed provenance. This helper proves
 * the durable artifact still carries the exact rows the already-declared batch
 * owns, allowing collection to persist the transport recovery immediately. Any
 * unsupported or unprovable structured mode fails closed.
 */
export async function validatePrWorkflowTransportRecovery(
	input: PrWorkflowTransportRecoveryValidationInput,
): Promise<PrWorkflowTransportRecoveryValidationResult> {
	const mode = input.record.mode?.trim();
	const isPrReviewVerdictMode =
		mode === 'swarm-pr-review:reviewer' || mode === 'swarm-pr-review:critic';
	if (
		!isPrReviewVerdictMode &&
		input.result.truncated !== true &&
		input.result.transcriptIncomplete !== true
	) {
		return { ok: true };
	}
	const workflowLane = input.record.workflowLane?.trim();
	if (!mode || !workflowLane) {
		return {
			ok: false,
			reason:
				'structured workflow transport recovery requires non-empty mode and workflow_lane provenance',
		};
	}
	const state = await requireAnyActiveState(
		input.directory,
		input.record.parentSessionId,
	);
	const batchId = input.record.batchId?.trim();
	const laneId = input.record.laneId?.trim();
	const verdictPhase: PrReviewComposablePhase | null =
		mode === 'swarm-pr-review:reviewer'
			? 'reviewer'
			: mode === 'swarm-pr-review:critic'
				? 'critic'
				: null;
	const declaredVerdictLane = verdictPhase
		? (state.prReviewValidationBatches ?? [])
				.find(
					(candidate) =>
						candidate.batchId === batchId && candidate.phase === verdictPhase,
				)
				?.lanes.find((candidate) => candidate.laneId === laneId)
		: undefined;
	const declaredItemIds = declaredVerdictLane?.reviewItemIds ?? [];
	const rejectedReceipt: PrReviewVerdictCollectionReceipt | undefined =
		declaredItemIds.length > 0
			? {
					assignedReviewItemIds: [...declaredItemIds],
					acceptedReviewItemIds: [],
					rejectedReviewItemIds: [...declaredItemIds],
				}
			: undefined;
	const recordIntegrity = analyzeLaneRecordResultIntegrity({
		record: input.record,
		result: input.result,
		expected: {
			mode,
			workflowLane,
			ownedWorkflowLanes: [workflowLane],
			prHeadSha: input.record.workspace?.prHeadSha ?? '',
			gitHead: input.record.workspace?.gitHead ?? '',
			checkWorkflowLane: true,
		},
		requireCompleted: false,
		allowTranscriptIncompleteRecovery: false,
	});
	if (!recordIntegrity.ok) {
		return {
			ok: false,
			reason: formatPrReviewLaneValidationFailure(recordIntegrity.failure),
			failure: recordIntegrity.failure,
			...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
		};
	}
	const artifactIntegrity = analyzeLaneArtifactIntegrity({
		record: input.record,
		result: input.result,
		artifact: input.artifact,
		expected: {
			mode,
			workflowLane,
			prHeadSha: input.record.workspace?.prHeadSha ?? '',
			gitHead: input.record.workspace?.gitHead ?? '',
			revisionDigest: input.revisionDigest,
			reviewScope: input.record.workspace?.scope ?? undefined,
		},
	});
	if (!artifactIntegrity.ok) {
		return {
			ok: false,
			reason: formatPrReviewLaneValidationFailure(artifactIntegrity.failure),
			failure: artifactIntegrity.failure,
			...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
		};
	}
	const expectedMode = mode.startsWith('swarm-pr-review:')
		? 'PR_REVIEW'
		: mode.startsWith('swarm-pr-feedback:')
			? 'PR_FEEDBACK'
			: null;
	if (!expectedMode) {
		return {
			ok: false,
			reason: `structured workflow transport recovery does not support mode "${mode}"`,
			...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
		};
	}
	if (state.mode !== expectedMode) {
		return {
			ok: false,
			reason: `active workflow mode mismatch; expected ${expectedMode}, got ${state.mode}`,
			...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
		};
	}
	const artifactText = input.artifact?.text ?? '';
	const prReviewGateContext: PrReviewGateContext | undefined =
		state.mode === 'PR_REVIEW'
			? { revisionDigest: input.revisionDigest }
			: undefined;
	if (!batchId || !laneId) {
		return {
			ok: false,
			reason:
				'structured workflow transport recovery requires non-empty batch_id and lane_id provenance',
			...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
		};
	}
	if (
		mode === 'swarm-pr-review:reviewer' ||
		mode === 'swarm-pr-review:critic'
	) {
		const phase = verdictPhase ?? 'reviewer';
		const batch = (state.prReviewValidationBatches ?? []).find(
			(candidate) => candidate.batchId === batchId && candidate.phase === phase,
		);
		const lane = batch?.lanes.find((candidate) => candidate.laneId === laneId);
		if (!lane || lane.workflowLane !== workflowLane) {
			return {
				ok: false,
				reason:
					'no matching declared reviewer/critic lane ownership was found for this transport recovery',
				...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
			};
		}
		const itemIds = lane.reviewItemIds ?? [];
		const reviewerClaims =
			phase === 'critic'
				? authoritativeReviewerClaims(
						input.directory,
						state,
						prReviewGateContext ?? { revisionDigest: input.revisionDigest },
					)
				: undefined;
		if (phase === 'critic' && (!reviewerClaims || reviewerClaims.size === 0)) {
			return {
				ok: false,
				reason:
					'critic transport recovery requires authoritative settled reviewer claims for every assigned item',
				...(rejectedReceipt ? { receipt: rejectedReceipt } : {}),
			};
		}
		const analysis = analyzeLegacyVerdictRowContract(
			artifactText,
			itemIds,
			phase,
			reviewerClaims,
		);
		if (!analysis.ok) {
			const failure = failedLaneValidation(
				phase === 'reviewer' ? 'reviewer.verdict_rows' : 'critic.verdict_rows',
				analysis.expected,
				analysis.actual,
			).failure;
			return {
				ok: false,
				reason: formatPrReviewLaneValidationFailure(failure),
				failure,
				receipt: {
					assignedReviewItemIds: [...itemIds],
					acceptedReviewItemIds: [],
					rejectedReviewItemIds: [...itemIds],
				},
			};
		}
		const receipt: PrReviewVerdictCollectionReceipt = {
			assignedReviewItemIds: [...itemIds],
			acceptedReviewItemIds: [...itemIds],
			rejectedReviewItemIds: [],
		};
		const recoveries = [
			...(analysis.recoveries ?? []).map(({ recovery, itemId }) => ({
				workflowLane,
				kind: 'legacy-verdict-row-recovery' as const,
				reason:
					recovery === 'legacy-fidelity-safe'
						? `legacy verdict row ${itemId} used trailing-field pipe recovery with full field fidelity`
						: `legacy verdict row ${itemId} used trailing-field pipe recovery with lossy prose normalization`,
			})),
			...(input.result.truncated === true
				? [
						{
							workflowLane,
							kind: 'truncated-preview-durable-artifact' as const,
							reason:
								'inline preview truncated; durable artifact retained exact coverage',
						},
					]
				: []),
		];
		return recoveries.length > 0
			? {
					ok: true,
					receipt,
					recoveries,
				}
			: { ok: true, receipt };
	} else if (mode === 'swarm-pr-feedback:verification') {
		const batch = (state.prFeedbackVerifications ?? []).find(
			(candidate) => candidate.batchId === batchId,
		);
		const lane = batch?.ownership.find(
			(candidate) => candidate.laneId === laneId,
		);
		if (!lane || workflowLane !== lane.laneId) {
			return {
				ok: false,
				reason:
					'no matching declared PR_FEEDBACK verification ownership was found for this transport recovery',
			};
		}
		const itemIds = lane?.ownedItemIds ?? [];
		if (
			itemIds.length === 0 ||
			!legacyFeedbackArtifactTextCoversItems(artifactText, itemIds)
		) {
			return {
				ok: false,
				reason:
					'every assigned PR_FEEDBACK verification item requires one exact [FEEDBACK-VERIFIED] row in the durable artifact',
			};
		}
	} else {
		const feedbackPhase = {
			'swarm-pr-feedback:stage-b-reviewer': {
				phase: 'stage-b-reviewer',
				marker: '[STAGE-B-REVIEW]',
				verdict: 'APPROVE',
			},
			'swarm-pr-feedback:stage-b-test': {
				phase: 'stage-b-test',
				marker: '[STAGE-B-TEST]',
				verdict: 'PASS',
			},
			'swarm-pr-feedback:closeout-reviewer': {
				phase: 'closeout-reviewer',
				marker: '[CLOSEOUT-REVIEW]',
				verdict: 'APPROVE',
			},
			'swarm-pr-feedback:closeout-critic': {
				phase: 'closeout-critic',
				marker: '[CLOSEOUT-CRITIC]',
				verdict: 'APPROVE',
			},
		}[mode];
		if (!feedbackPhase) {
			return {
				ok: false,
				reason: `structured workflow transport recovery does not support mode "${mode}"`,
			};
		}
		const batch = (state.prFeedbackGateBatches ?? []).find(
			(candidate) =>
				candidate.batchId === batchId &&
				candidate.phase === feedbackPhase.phase &&
				candidate.laneId === laneId,
		);
		if (!batch || workflowLane !== feedbackPhase.phase) {
			return {
				ok: false,
				reason:
					'no matching declared ordered PR_FEEDBACK lane provenance was found for this transport recovery',
			};
		}
		const itemIds = batch?.itemIds ?? [];
		if (
			itemIds.length === 0 ||
			!itemIds.every((itemId) =>
				legacyArtifactHasExactPositiveVerdictRow(
					artifactText,
					feedbackPhase.marker,
					itemId,
					feedbackPhase.verdict,
				),
			)
		) {
			return {
				ok: false,
				reason:
					'every assigned ordered PR_FEEDBACK item requires one exact positive verdict row in the durable artifact',
			};
		}
	}
	return input.result.truncated === true
		? {
				ok: true,
				recoveries: [
					{
						workflowLane,
						kind: 'truncated-preview-durable-artifact',
						reason:
							'inline preview truncated; durable artifact retained exact coverage',
					},
				],
			}
		: { ok: true };
}

/** Require at least one semantically valid discovery row or CLEAN attestation. */
export function prReviewDiscoveryArtifactCoversLane(
	text: string,
	expectedWorkflowLane: string,
	ownedWorkflowLanes: readonly string[] = [expectedWorkflowLane],
	mode?: string,
): boolean {
	return analyzePrReviewDiscoveryArtifact(
		text,
		expectedWorkflowLane,
		ownedWorkflowLanes,
		mode,
	).covered;
}

function extractLaneCoverageEvidenceText(
	text: string,
	expectedWorkflowLane: string,
	ownedWorkflowLanes: readonly string[] = [expectedWorkflowLane],
	mode?: string,
): string | null {
	return analyzePrReviewDiscoveryArtifact(
		text,
		expectedWorkflowLane,
		ownedWorkflowLanes,
		mode,
	).evidence;
}

// Issue #2385: `REVIEW_SEVERITY_RANK` and `FEEDBACK_CLASSIFICATIONS` moved to
// src/pr-review/legacy-transcript-adapter.ts, which owns the severity-rank /
// classification vocabulary used in transcript-text conversion.

/**
 * Issue #2131 criterion C1: a fully verified no-change inventory is one where
 * EVERY item's settled verification classification is a no-change outcome.
 * Any CONFIRMED/PARTIAL item requires real content changes, so the ordinary
 * exactly-one-reviewed-commit path still applies.
 */
const FEEDBACK_NO_CHANGE_CLASSIFICATIONS = new Set([
	'DISPROVED',
	'PRE_EXISTING',
	'NEEDS_MORE_EVIDENCE',
	'NEEDS_USER_DECISION',
]);

interface ReviewerVerdict {
	classification: string;
	severity: string;
	/** Typed risk metadata projected from the reviewer row (issue #2383). */
	riskImpact?: PrReviewRiskImpact;
	riskTags?: PrReviewRiskTag[];
}

// Issue #2385: the entire transcript/artifact-text -> canonical conversion
// cluster (IndexedVerdictRows, the row parsers/validators/digest, the pipe
// field codec, the feedback-artifact coverage readers, and the critic
// single-row parser) moved verbatim to src/pr-review/legacy-transcript-adapter.ts.

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

/** Upper bound on schema issues quoted in one salvage disclosure. */
const MAX_SALVAGED_SCHEMA_ERRORS = 10;

/**
 * Upper bound on the length of ONE quoted schema issue.
 *
 * The issue-COUNT cap alone is not a bound on disclosure size: zod folds every
 * unrecognized key of a single strict object into ONE `unrecognized_keys` issue
 * whose message inlines all of them, so one oversized key in a nested strict
 * child (e.g. `checkoutRecovery`) yields a single 80,000-char message that the
 * count cap does nothing about. The disclosure is written durably to
 * `.swarm/events.jsonl` and surfaced verbatim in `pr_workflow_status`, so an
 * attacker-influenced or partially-written state file could otherwise flood the
 * audit sink and the operator's console. Matches the ellipsis-marker style of
 * `MAX_LANE_VALIDATION_VALUE_CHARS` — this is operator prose, so the truncation
 * must be visible rather than silent.
 */
export const MAX_SALVAGED_SCHEMA_ERROR_CHARS = 240;

/** Bound one quoted schema issue, marking any truncation for the operator. */
function boundSalvagedSchemaError(message: string): string {
	return message.length <= MAX_SALVAGED_SCHEMA_ERROR_CHARS
		? message
		: `${message.slice(0, MAX_SALVAGED_SCHEMA_ERROR_CHARS - 1)}…`;
}

/** Result of one recovery-only gate-state read. */
export interface PrWorkflowGateRecoveryRead {
	/** Schema-valid state, or the salvaged projection when `salvaged`. */
	state: PrWorkflowGateState;
	/** true when the durable bytes failed schema validation and were salvaged. */
	salvaged: boolean;
	/** `path: message` per schema issue; empty unless `salvaged`. */
	schemaErrors: string[];
	/** Loud operator-facing disclosure; present only when `salvaged`. */
	disclosure?: string;
	/** false when `revision` could not be salvaged — the CAS escape is required. */
	revisionSalvageable: boolean;
	/**
	 * true when a `prFeedbackReadyToPublish` key is present in the raw bytes but
	 * is itself unreadable. Callers MUST treat this as armed: silently dropping
	 * an unreadable armed marker would turn "corrupt that one record" into a way
	 * to bypass the armed-abort refusal — a forgery-class relaxation, not an
	 * availability one.
	 */
	armedShapeUnreadable: boolean;
}

/**
 * Recovery-only gate-state reader (issue #2242 R4, wedge W-5).
 *
 * Used by `abortPrWorkflow` and `pr_workflow_status` ONLY. The general reader
 * (`readPrWorkflowGateStateFromDisk`) is deliberately unchanged, so no write,
 * completion, or verification path can ever act on a salvaged projection.
 *
 * Policy, mirroring the file-wide "unavailability degrades with disclosure;
 * contradiction fails closed" invariant:
 *   - **Unparseable bytes fail everywhere**, recovery included. There is nothing
 *     to salvage and guessing would be fabrication.
 *   - **Schema-validation failure on parseable JSON** salvages the fields abort
 *     actually reads — `{sessionID, mode, prHeadSha}` plus `revision`,
 *     `prFeedbackReadyToPublish` and `checkoutRecovery` when each is
 *     individually well-formed — with a loud disclosure naming the schema
 *     errors. Everything else is dropped rather than guessed.
 *   - **Identity is not salvageable ⇒ nothing is.** Without a readable
 *     `sessionID` and `mode` there is no provable subject to act on, so the
 *     original `is invalid` failure stands.
 *
 * A salvaged view is never written to the tracked-state cache.
 */
export async function readPrWorkflowGateStateForRecovery(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateRecoveryRead | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const filePath = workflowGateStatePath(directory, normalizedSessionID);
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
			`BLOCKED: PR workflow gate state for session "${normalizedSessionID}" is not valid JSON`,
		);
	}
	const parsed = PrWorkflowGateStateSchema.safeParse(parsedJson);
	if (parsed.success) {
		return {
			state: parsed.data,
			salvaged: false,
			schemaErrors: [],
			revisionSalvageable: true,
			armedShapeUnreadable: false,
		};
	}
	const invalidError = new Error(
		`BLOCKED: PR workflow gate state for session "${normalizedSessionID}" is invalid`,
	);
	if (
		typeof parsedJson !== 'object' ||
		parsedJson === null ||
		Array.isArray(parsedJson)
	) {
		throw invalidError;
	}
	const rawRecord = parsedJson as Record<string, unknown>;
	const salvagedSessionID = z.string().min(1).safeParse(rawRecord.sessionID);
	const salvagedMode = z
		.enum(['PR_REVIEW', 'PR_FEEDBACK'])
		.safeParse(rawRecord.mode);
	if (!salvagedSessionID.success || !salvagedMode.success) throw invalidError;
	const salvagedRevision = z
		.number()
		.int()
		.nonnegative()
		.safeParse(rawRecord.revision);
	const salvagedHead = z.string().min(1).safeParse(rawRecord.prHeadSha);
	const salvagedActivatedAt = z
		.string()
		.min(1)
		.safeParse(rawRecord.activatedAt);
	const salvagedUpdatedAt = z.string().min(1).safeParse(rawRecord.updatedAt);
	// `undefined` is the only unarmed shape: the schema is `.optional()`, never
	// `.nullable()`, so a `null` here can only come from corruption — treating
	// it as absent would let the single most likely nested-record corruption
	// bypass the armed-abort refusal (4.5-review finding, 2026-08-19).
	const armedKeyPresent = rawRecord.prFeedbackReadyToPublish !== undefined;
	const salvagedArmed = PrFeedbackReadyToPublishRecordSchema.safeParse(
		rawRecord.prFeedbackReadyToPublish,
	);
	// Issue #2108: a present-but-unreadable publication-generation record gets
	// the same fail-closed armed treatment — a corrupt active generation must
	// never downgrade into "no publication window". A well-formed record is
	// salvaged so the abort cancel arm can reason about it.
	const publicationKeyPresent = rawRecord.prFeedbackPublication !== undefined;
	const salvagedPublication = PrFeedbackPublicationStateSchema.safeParse(
		rawRecord.prFeedbackPublication,
	);
	const publicationShapeUnreadable =
		publicationKeyPresent && !salvagedPublication.success;
	const salvagedCheckoutRecovery =
		PrWorkflowCheckoutRecoveryRecordSchema.safeParse(
			rawRecord.checkoutRecovery,
		);
	const armedShapeUnreadable =
		(armedKeyPresent && !salvagedArmed.success) || publicationShapeUnreadable;
	const schemaErrors = parsed.error.issues
		.slice(0, MAX_SALVAGED_SCHEMA_ERRORS)
		.map((issue) =>
			boundSalvagedSchemaError(
				`${issue.path.join('.') || '(root)'}: ${issue.message}`,
			),
		);
	const disclosure =
		`DEGRADED: PR workflow gate state for session "${normalizedSessionID}" failed schema validation ` +
		`and was SALVAGED for recovery only (abort/status; write and completion paths still refuse it). ` +
		`Schema errors: ${schemaErrors.join('; ')}.` +
		(salvagedRevision.success ? '' : ' state revision unsalvageable.') +
		(armedShapeUnreadable
			? ' prFeedbackReadyToPublish is present but unreadable; treated as ARMED (fail-closed).'
			: '') +
		(publicationShapeUnreadable
			? ' prFeedbackPublication is present but unreadable; treated as ARMED (fail-closed).'
			: '');
	return {
		state: {
			schemaVersion: GATE_SCHEMA_VERSION,
			revision: salvagedRevision.success ? salvagedRevision.data : 0,
			sessionID: salvagedSessionID.data,
			mode: salvagedMode.data,
			activatedAt: salvagedActivatedAt.success
				? salvagedActivatedAt.data
				: isoNow(),
			updatedAt: salvagedUpdatedAt.success ? salvagedUpdatedAt.data : isoNow(),
			...(salvagedHead.success ? { prHeadSha: salvagedHead.data } : {}),
			...(salvagedArmed.success
				? { prFeedbackReadyToPublish: salvagedArmed.data }
				: {}),
			...(salvagedPublication.success
				? { prFeedbackPublication: salvagedPublication.data }
				: {}),
			...(salvagedCheckoutRecovery.success
				? { checkoutRecovery: salvagedCheckoutRecovery.data }
				: {}),
		},
		salvaged: true,
		schemaErrors,
		disclosure,
		revisionSalvageable: salvagedRevision.success,
		armedShapeUnreadable,
	};
}
