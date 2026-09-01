/**
 * Durable pending background-delegation store (issue #1151, PR 2 Stage A;
 * bounded recovery via checkpoint/tail compaction — issue #2034).
 *
 * Append-only JSONL event log under project-root `.swarm/background-delegations.jsonl`.
 * Each line is a full record snapshot; readers fold to the latest snapshot per
 * `correlationId`. This tracks native background `Task` dispatches and deterministic
 * async advisory lanes so trusted completions can be correlated to a real dispatch.
 * The stale sweep bounds the number of permanently-running entries by transitioning
 * them to `stale`, so the folded in-memory view stays bounded by distinct correlationIds.
 *
 * Bounded recovery (issue #2034): the raw log alone is no longer the recovery
 * source once history grows. Compaction — run lazily under the store lock when the
 * ledger passes `DELEGATION_COMPACTION_HIGH_WATER_BYTES` — checkpoints the folded
 * authoritative state (active ownership, terminal results, coder settlement, pending
 * advisory inbox) plus compact closed-record summaries into
 * `.swarm/background-delegations.checkpoint.json`, publishes it via
 * `.swarm/background-delegations.manifest.json`, and rolls the ledger to the
 * post-cut transition tail. Recovery folds checkpoint + bounded tail with hard
 * byte/count bounds and preserves fail-closed uncertainty; the 4 MiB
 * `MAX_RECOVERY_LEDGER_BYTES` guard is unchanged and still applies to legacy
 * uncheckpointed ledgers.
 *
 * Scope: dispatch records `pending`/`running` snapshots, collection or trusted synthetic
 * completions record terminal snapshots, and the stale sweep records `stale` snapshots.
 * This store itself has no gate-advancement side effect. Stage B gate ingestion is a
 * separate consumer of trusted terminal snapshots. Circuit-breaker and transient-retry
 * counters are invocation-owned and are NEVER serialized here (issue #2034 req 9).
 *
 * Concurrency: all writes (append, sweep, compaction) run under a single
 * project-scoped lock via `withEvidenceLock`, so concurrent dispatches/sweeps cannot
 * interleave appends. Reads are lock-free (line-oriented; partial trailing lines are
 * skipped defensively by the lenient reader; the strict recovery reader fails closed).
 *
 * Containment: every path is validated with `validateSwarmPath`, so it can never
 * escape `.swarm/` (Invariant 4).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
	EvidenceLockTimeoutError,
	withEvidenceLock,
} from '../evidence/lock.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { bunWrite } from '../utils/bun-compat.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import * as logger from '../utils/logger.js';
import {
	appendDelegationMaintenanceObservation,
	DelegationCheckpointAuditSchema,
	type DelegationCheckpointAuditSummary,
	type DelegationMaintenanceFact,
	readDelegationHealthArtifact,
	writeDelegationHealthArtifact,
} from './delegation-health.js';
import {
	encodePrReviewCollectionReceiptShedMarker,
	PR_REVIEW_COLLECTION_RECEIPT_PREFIX,
	PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX,
	parsePrReviewCollectionReceiptFooter,
	parsePrReviewCollectionReceiptShedMarker,
} from './pr-review-collection-receipt.js';
import {
	type PrReviewResultReceipt,
	PrReviewResultReceiptSchema,
} from './pr-review-contract.js';

export const BACKGROUND_DELEGATIONS_FILE = 'background-delegations.jsonl';
export const BACKGROUND_DELEGATION_FALLBACK_DIR =
	'background-delegation-fallback';
export const BACKGROUND_CODER_RESERVATIONS_FILE =
	'background-coder-reservations.json';
export const BACKGROUND_DELEGATIONS_CHECKPOINT_FILE =
	'background-delegations.checkpoint.json';
export const BACKGROUND_DELEGATIONS_MANIFEST_FILE =
	'background-delegations.manifest.json';
export const MAX_LIVE_BACKGROUND_FALLBACKS = 256;
export const MAX_LIVE_BACKGROUND_CODER_RESERVATIONS = 256;
export const MAX_BACKGROUND_OBSERVED_FILES = 5_000;
export const MAX_BACKGROUND_ADVISORY_CHARS = 4_000;
export const LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER =
	'legacy coder settlement transfer is pending';
const MAX_BACKGROUND_DELEGATION_GENERATION = 1_000_000;

/** Strict recovery bound for the ledger/tail (issue #2034: unchanged guard). */
export { MAX_RECOVERY_LEDGER_BYTES } from './delegation-health.js';

import { MAX_RECOVERY_LEDGER_BYTES } from './delegation-health.js';

const MAX_RECOVERY_FALLBACK_BYTES = 1024 * 1024;
const MAX_TRACKED_LENIENT_LEDGER_SIGNALS = 32;
const LENIENT_LEDGER_SIGNAL_SOURCE = 'lenient-read';

/**
 * Compaction watermarks (issue #2034). Auto-compaction fires above the high
 * water mark so the post-roll tail plus one in-flight append (~250 KiB worst
 * case) stays far below the 4 MiB strict recovery bound in normal operation.
 */
export const DELEGATION_COMPACTION_LOW_WATER_BYTES = 256 * 1024;
export const DELEGATION_COMPACTION_HIGH_WATER_BYTES = 1024 * 1024;
/** Hard validation bound for the checkpoint file on every read. */
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
/** Leave room for final audit/checksum growth beyond the selection estimate. */
const CHECKPOINT_SELECTION_RESERVE_BYTES = 64 * 1024;
/** Hard validation bound for live (non-summary) records in a checkpoint. */
export const MAX_CHECKPOINT_RECORDS = 2_048;
/**
 * Closed-record summaries younger than this are never evicted to meet the
 * checkpoint byte budget — evicting them would let a replayed dispatch of a
 * recently closed session be recorded as fresh (double delivery). Over-budget
 * young state skips compaction and surfaces pressure instead.
 */
export const TOMBSTONE_MIN_AGE_MS = 72 * 60 * 60 * 1000;

export type RecoveryOwnershipScanResult<T> =
	| {
			status: 'ok';
			owners: T[];
			/** How the primary store was reconstructed (issue #2034); absent for pre-checkpoint scans. */
			source?: 'checkpoint+tail' | 'checkpoint+ledger-suffix' | 'legacy-ledger';
	  }
	| {
			status: 'uncertain';
			reason: string;
			/**
			 * Best-known interpretation mode at failure time; `'unknown'` when the
			 * manifest/checkpoint state itself was unreadable (issue #2034 — the
			 * durable recovery observation must not claim a wrong source).
			 */
			source?:
				| 'checkpoint+tail'
				| 'checkpoint+ledger-suffix'
				| 'legacy-ledger'
				| 'unknown';
			/** Operator remediation guidance, when the failure mode has one. */
			repairHint?: string;
	  };

/** Lock + diagnostics identity for the project-scoped store lock. */
const STORE_LOCK_AGENT = 'background';
const STORE_LOCK_TASK = 'background-delegations';
const FALLBACK_LOCK_TASK = 'background-delegation-fallback';
const RESERVATION_LOCK_TASK = 'background-coder-reservations';
const ADVISORY_PREPARE_LEASE_MS = 30_000;
const INGESTION_CLAIM_LEASE_MS = 30_000;

/** An abandoned ingestion lease may be reclaimed after this bounded interval. */
export const BACKGROUND_INGESTION_LEASE_MS = 30_000;

/**
 * Coder-reservation lease bounds (issue #2104). The lease is a liveness hint,
 * never release authority: expiry only triggers corroborated reconciliation.
 * `leaseMs` inputs are clamped into [MIN, MAX]. Documented default 15 min,
 * hard maximum 60 min, floor 60 s.
 */
export const BACKGROUND_CODER_RESERVATION_LEASE_MS = 15 * 60_000;
export const BACKGROUND_CODER_RESERVATION_LEASE_MAX_MS = 60 * 60_000;
export const BACKGROUND_CODER_RESERVATION_LEASE_MIN_MS = 60_000;

function clampReservationLeaseMs(leaseMs: number | undefined): number {
	if (leaseMs === undefined) return BACKGROUND_CODER_RESERVATION_LEASE_MS;
	if (!Number.isFinite(leaseMs)) return BACKGROUND_CODER_RESERVATION_LEASE_MS;
	return Math.min(
		Math.max(Math.round(leaseMs), BACKGROUND_CODER_RESERVATION_LEASE_MIN_MS),
		BACKGROUND_CODER_RESERVATION_LEASE_MAX_MS,
	);
}

function isValidReservationGeneration(generation: number | undefined): boolean {
	return (
		generation === undefined ||
		(Number.isInteger(generation) &&
			generation >= 1 &&
			generation <= MAX_BACKGROUND_DELEGATION_GENERATION)
	);
}

/**
 * Canonical default staleness horizon for a tracked background delegation: a
 * record whose `updatedAt` has not advanced in this long is treated as
 * abandoned (its backing process died without ever writing a terminal
 * snapshot) and may be swept to `stale`.
 *
 * 30 minutes is the value this subsystem already shipped — it was duplicated as
 * a module-local literal in `src/tools/dispatch-lanes.ts` and as the
 * `hooks.background_pending_timeout_minutes` schema default. It lives here so
 * every consumer agrees on one number: this module imports nothing from
 * `dispatch-lanes.ts` or `pr-workflow-gate.ts`, so both can reference it
 * without an import cycle.
 */
export const DEFAULT_STALE_DELEGATION_TIMEOUT_MS = 30 * 60_000;

export type BackgroundDelegationStatus =
	| 'pending'
	| 'running'
	| 'ingesting'
	| 'ingestion_error'
	| 'completed'
	| 'error'
	| 'cancelled'
	| 'stale'
	| 'consumed';

/**
 * The status classes the stale sweep is allowed to finalize to `stale`.
 *
 * Deliberately a subset of {@link BackgroundDelegationStatus}: a caller may
 * *narrow* the sweep but can never widen it to a status the sweep was never
 * meant to touch (`completed`, `consumed`, `ingesting`, ...).
 */
export type SweepableDelegationStatus =
	| 'pending'
	| 'running'
	| 'ingestion_error';

/**
 * Default sweep scope — the exact set the sweep has always finalized.
 *
 * `ingestion_error` is included here because the pre-existing lazy-maintenance
 * caller (`recordPendingDelegation`) relies on it: an ingestion that never
 * retried within the horizon is genuinely abandoned from that caller's point of
 * view. Callers for whom `ingestion_error` is still *retryable* — the ingestion
 * claim gate admits `completed` and `ingestion_error` only, so the `stale` flip
 * is irreversible — must pass a narrowed set instead.
 */
export const DEFAULT_SWEEPABLE_DELEGATION_STATUSES: ReadonlySet<SweepableDelegationStatus> =
	new Set<SweepableDelegationStatus>(['pending', 'running', 'ingestion_error']);

export interface BackgroundDelegationRecord {
	schemaVersion: 1 | 2 | 3 | 4;
	/** Subagent session id from the dispatch envelope — the correlation key. */
	correlationId: string;
	/** Structured jobId from dispatch metadata when available, else null. */
	jobId: string | null;
	/** Subagent session id (== correlationId; kept explicit for clarity/forward-compat). */
	subagentSessionId: string;
	/** Parent (dispatching) session id. */
	parentSessionId: string;
	/** Tool callID of the dispatching Task call. */
	callID: string;
	/** Canonical swarm role (e.g. "reviewer", "test_engineer"). */
	normalizedAgent: string;
	/** Raw, possibly swarm-prefixed agent name (e.g. "mega_reviewer"). */
	swarmPrefixedAgent: string;
	/** Plan/evidence task id resolved at dispatch, or null. */
	planTaskId: string | null;
	evidenceTaskId: string | null;
	status: BackgroundDelegationStatus;
	createdAt: number;
	updatedAt: number;
	/** Async advisory lane batch id. Present for dispatch_lanes_async records. */
	batchId?: string;
	/** Stable lane id within batchId. */
	laneId?: string;
	/** Advisory workflow/mode that launched the lane. */
	mode?: string;
	/** Mechanical PR workflow obligation identifier, distinct from retry-safe laneId. */
	workflowLane?: string;
	/**
	 * Complete set of PR-review dimensions/risk families this lane covers when a
	 * depth tier consolidates dispatch. Always contains workflowLane. Absent for
	 * singleton lanes (legacy and tier-L dispatches).
	 */
	ownedWorkflowLanes?: string[];
	/** Dispatch-time snapshot; absent legacy records keep transcript compatibility. */
	prReviewLegacyTranscriptCompatibility?: boolean;
	/** Canonical hash of prompt/provenance inputs captured at dispatch time. */
	promptHash?: string;
	/** Project/root provenance captured at dispatch time. */
	workspace?: BackgroundWorkspaceSnapshot;
	/** Immutable pre-coder provenance for doc-only gate classification. */
	taskChangeContext?: BackgroundTaskChangeContext;
	/** Exact-task workflow generation captured before a Stage B dispatch. */
	workflowGeneration?: number;
	/** Complete isolated-worktree recovery coordinates captured before handoff. */
	worktree?: BackgroundWorktreeDescriptor;
	/** Stable pre-launch background-coder capacity reservation. */
	coderReservationId?: string;
	prompt?: BackgroundPromptSnapshot;
	generation?: number;
	/** Immutable trusted terminal event. Established exactly once. */
	terminalResult?: BackgroundTerminalResult;
	/** Durable coder settlement state. Settled outcomes are never recomputed. */
	coderSettlement?: BackgroundCoderSettlement;
	/** Durable parent advisory keyed by terminalResult.eventId. */
	advisoryInbox?: BackgroundAdvisoryInboxEntry;
	/** Exact legacy coder WAL transfer that still needs durable reconciliation. */
	legacyCoderSettlementTransfer?: {
		taskId: string;
		transitionId: string;
		updatedAt: number;
	};
	/** CAS marker for exactly one active ingestion attempt. */
	ingestion?: BackgroundDelegationIngestion;
	result?: BackgroundDelegationResult;
	completedAt?: number;
}

export interface BackgroundWorkspaceSnapshot {
	directory: string;
	gitHead: string | null;
	dirtyHash: string | null;
	changedFiles?: string[] | null;
	prHeadSha: string | null;
	scope: string | null;
}

export interface BackgroundTaskChangeContext {
	declaredFiles: string[] | null;
	baseline: BackgroundWorkspaceSnapshot;
	/** Exact-task workflow generation captured before coder dispatch. */
	workflowGeneration?: number;
}

export interface BackgroundWorktreeDescriptor {
	callID: string;
	parentSessionId: string;
	taskId: string;
	planTaskId: string | null;
	worktreePath: string;
	branchName: string;
	worktreeId: string;
	worktreeSessionId: string;
	mergeStrategy: 'merge' | 'rebase' | 'cherry-pick';
	laneIndex: number;
	worktreeDir: string | null;
	reservationId?: string;
	generation?: number;
	provisioningOwner?: {
		reservationId: string;
		generation: number;
		branchName: string;
	};
}

export interface BackgroundPromptSnapshot {
	text: string;
	chars: number;
	truncated: boolean;
	digest: string;
}

export type BackgroundDelegationRecoveryKind =
	| 'legacy-verdict-row-recovery'
	| 'parser-normalization'
	| 'parser-row-recovery'
	| 'truncated-preview-durable-artifact'
	| 'transcript-incomplete-terminal-candidate'
	/**
	 * A `[CLEAN]` attestation was discredited while the artifact's candidate rows
	 * were retained. Distinct from `parser-normalization` (a text-shape repair by
	 * `normalizeCandidateArtifact`) because nothing was repaired — an assertion
	 * was dropped (issue #2279).
	 */
	| 'clean-attestation-salvaged';

export interface BackgroundDelegationWorkflowLaneRecovery {
	workflowLane: string;
	kind: BackgroundDelegationRecoveryKind;
	reason: string;
}

export type BackgroundDelegationWorkflowLaneFailureClass =
	| 'contract'
	| 'resource'
	| 'deadline';

/**
 * Issue #2382: structured, bounded classification of the terminal error that
 * settled a lane, captured from `classifyLaneTerminalError` at settle time so
 * downstream consumers (the PR-review resilience circuit) can derive a typed
 * provider-terminal signal from durable evidence instead of parsing the
 * bounded display string in `error`.
 *
 * Deliberately carries NO message text: `error` remains the display surface.
 * `kind` mirrors the SDK discriminator semantics (authoritative for the
 * settled status); `category`/`statusCode`/`hostRetryable` are advisory
 * provenance from `classifyProviderFailure` / `ApiError.data`.
 */
export interface BackgroundDelegationTerminalErrorClass {
	kind: 'provider' | 'aborted' | 'output_length' | 'unknown';
	/** Canonical `classifyProviderFailure` category (e.g. `provider.rate_limit`). */
	category: string;
	statusCode?: number;
	/** `ApiError.data.isRetryable` — host-stated, not inferred. */
	hostRetryable?: boolean;
}

export interface BackgroundDelegationResult {
	text?: string;
	error?: string;
	chars: number;
	truncated: boolean;
	digest: string;
	outputRef?: string;
	outputPreviewChars?: number;
	outputDegraded?: boolean;
	outputArtifactError?: string;
	transcriptIncomplete?: boolean;
	messageCount?: number;
	/**
	 * Issue #2384: authoritative structured PR-review result receipt. Persisted
	 * separately from transcript text so compaction and preview truncation can
	 * never promote presentation-layer text into machine authority.
	 */
	prReviewResultReceipt?: import('./pr-review-contract.js').PrReviewResultReceipt;
	/**
	 * Durable failure provenance for a lane-atomic PR-workflow terminalization.
	 * Optional because successful lanes and legacy terminal results have none.
	 */
	workflowLaneFailureClass?: BackgroundDelegationWorkflowLaneFailureClass;
	/**
	 * Issue #2382: typed terminal-error classification captured at settle time
	 * (see {@link BackgroundDelegationTerminalErrorClass}). Optional because only
	 * lanes settled from a real child run with a classified terminal error carry
	 * it; successful, cancelled, stale, and legacy records have none. Present in
	 * the `.strict()` ResultSchema below in the same edit — an undeclared field
	 * here would make whole records invisible to `readDelegations`.
	 */
	terminalErrorClass?: BackgroundDelegationTerminalErrorClass;
	/**
	 * Workflow lanes whose discovery artifact was accepted only after repair — a
	 * synthesized canonical header, or valid rows retained beside malformed ones.
	 * Recorded on the durable ledger so a repaired lane stays distinguishable from
	 * a well-formed one after the fact, which is where post-mortems actually look.
	 */
	salvagedWorkflowLanes?: string[];
	/**
	 * Per-workflow-lane recovery disclosures retained on the durable ledger.
	 * Unlike `salvagedWorkflowLanes`, which is the compatibility list surface,
	 * this captures the exact recovery class and human-readable reason so
	 * transport recovery is not collapsed into the same bucket as parser repair.
	 */
	salvagedWorkflowLaneRecoveries?: BackgroundDelegationWorkflowLaneRecovery[];
}

export interface BackgroundTerminalResult {
	/** Stable identity derived from trusted correlation + immutable result metadata. */
	eventId: string;
	status: 'completed' | 'error' | 'cancelled';
	recordedAt: number;
	result: BackgroundDelegationResult;
}

export type BackgroundCoderSettlementState =
	| 'pending'
	| 'settling'
	| 'settled'
	| 'preserved';

export interface BackgroundCoderSettlementProvenance {
	correlationId: string;
	parentSessionId: string;
	callID: string;
	planTaskId: string | null;
	baseline: BackgroundWorkspaceSnapshot;
	worktree: BackgroundWorktreeDescriptor | null;
}

export interface BackgroundCoderSettlementOutcome {
	kind: 'shared-root' | 'standard-worktree';
	result: 'ready' | 'merged' | 'unchanged' | 'partial' | 'failed';
	reason?: string;
	sourceHeadAfterCommit?: string | null;
	targetHeadBeforeMerge?: string | null;
	targetHeadAfterMerge?: string | null;
}

export interface BackgroundCoderSettlement {
	state: BackgroundCoderSettlementState;
	provenance: BackgroundCoderSettlementProvenance;
	operationId?: string;
	sourceHeadAfterCommit?: string | null;
	targetHeadBeforeMerge?: string | null;
	observedFiles: string[] | null;
	outcome?: BackgroundCoderSettlementOutcome;
	updatedAt: number;
}

export interface BackgroundAdvisoryPreparation {
	id: string;
	preparedAt: number;
	leaseExpiresAt: number;
}

export interface BackgroundAdvisoryInboxEntry {
	eventId: string;
	parentSessionId: string;
	state: 'pending' | 'delivered';
	message: string;
	createdAt: number;
	preparation?: BackgroundAdvisoryPreparation;
	deliveredAt?: number;
}

export interface BackgroundDelegationIngestion {
	state: 'claimed' | 'retryable' | 'consumed';
	attempt: number;
	updatedAt: number;
	claimToken: string;
	leaseExpiresAt?: number;
}

export interface BackgroundCoderReservation {
	reservationId: string;
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
	state: 'reserved' | 'bound';
	correlationId: string | null;
	/**
	 * Launch generation this reservation currently owns (issue #2104). New in
	 * this schema revision: absent on legacy records and read as 1. Bind
	 * couples the reservation to the delegation record's launch generation and
	 * may only move it forward. No current dispatch path advances a record
	 * past generation 1 (PR #2091 hydrates replays at the stored generation),
	 * so the generation fences in bind/release/maintenance are currently
	 * forward-looking defense-in-depth: they exist so a future
	 * generation-advancing relaunch caller cannot have its reservation
	 * released or rebound by an older attempt's terminal.
	 */
	generation?: number;
	/**
	 * Lease expiry (issue #2104): a liveness hint for maintenance, never
	 * release authority by itself. Absent on legacy records, which stay
	 * protected (only proven-terminal reconciliation may release them).
	 */
	leaseExpiresAt?: number;
	createdAt: number;
	updatedAt: number;
}

const WorkflowLaneRecoverySchema = z
	.object({
		workflowLane: z.string(),
		kind: z.enum([
			'legacy-verdict-row-recovery',
			'parser-normalization',
			'parser-row-recovery',
			'truncated-preview-durable-artifact',
			'transcript-incomplete-terminal-candidate',
			'clean-attestation-salvaged',
		]),
		reason: z.string(),
	})
	.strict();

const ResultSchema = z
	.object({
		text: z.string().optional(),
		error: z.string().optional(),
		chars: z.number(),
		truncated: z.boolean(),
		digest: z.string(),
		outputRef: z.string().optional(),
		outputPreviewChars: z.number().optional(),
		outputDegraded: z.boolean().optional(),
		outputArtifactError: z.string().optional(),
		transcriptIncomplete: z.boolean().optional(),
		messageCount: z.number().optional(),
		prReviewResultReceipt: PrReviewResultReceiptSchema.optional(),
		workflowLaneFailureClass: z
			.enum(['contract', 'resource', 'deadline'])
			.optional(),
		// Issue #2382: must be declared here (schema is .strict()) — see the
		// interface comment and the parity guard below this schema.
		terminalErrorClass: z
			.object({
				kind: z.enum(['provider', 'aborted', 'output_length', 'unknown']),
				category: z.string().min(1).max(128),
				statusCode: z.number().int().optional(),
				hostRetryable: z.boolean().optional(),
			})
			.strict()
			.optional(),
		// Must be declared here: this schema is .strict() and readDelegations
		// safeParse-skips any record it rejects, so an undeclared field would make
		// the entire terminal transition invisible to every reader — turning a
		// successfully salvaged lane into one that appears never to have completed.
		salvagedWorkflowLanes: z.array(z.string()).optional(),
		salvagedWorkflowLaneRecoveries: z
			.array(WorkflowLaneRecoverySchema)
			.optional(),
	})
	.strict();

/**
 * Compile-time parity guard between the TypeScript interface and the `.strict()`
 * schema above.
 *
 * `appendRecord` writes without validating while `readDelegations`
 * safeParse-skips anything the schema rejects, so a field declared on the
 * interface but missing from the schema is written to disk and then silently
 * invisible to every reader — dropping the whole record, not just the field.
 * That is not a hypothetical: it shipped once during this change and made
 * completed lanes read back as `pending`.
 *
 * Mutual assignability makes `tsc` reject the next occurrence for free, which is
 * a strictly stronger rung than another runtime test.
 */
// Compared by KEY, deliberately. Mutual assignability does not work here: an
// optional field present on one side and absent from the other still satisfies
// `extends` in both directions, so an assignability guard would silently pass on
// exactly the drift that caused the bug.
type FieldsMissingFromResultSchema = Exclude<
	keyof BackgroundDelegationResult,
	keyof z.infer<typeof ResultSchema>
>;
type FieldsMissingFromResultInterface = Exclude<
	keyof z.infer<typeof ResultSchema>,
	keyof BackgroundDelegationResult
>;
const _RESULT_SCHEMA_MATCHES_INTERFACE: [
	FieldsMissingFromResultSchema,
	FieldsMissingFromResultInterface,
] extends [never, never]
	? true
	: false = true;
void _RESULT_SCHEMA_MATCHES_INTERFACE;

const WorkspaceSchema = z
	.object({
		directory: z.string(),
		gitHead: z.string().nullable(),
		dirtyHash: z.string().nullable(),
		changedFiles: z.array(z.string()).nullable().optional(),
		prHeadSha: z.string().nullable(),
		scope: z.string().nullable(),
	})
	.strict();

const TaskChangeContextSchema = z
	.object({
		declaredFiles: z.array(z.string()).nullable(),
		baseline: WorkspaceSchema,
		workflowGeneration: z.number().int().nonnegative().optional(),
	})
	.strict();

const WorktreeDescriptorSchema = z
	.object({
		callID: z.string().min(1).max(256),
		parentSessionId: z.string().min(1).max(256),
		taskId: z.string().min(1).max(256),
		planTaskId: z.string().min(1).max(256).nullable(),
		worktreePath: z.string().min(1).max(4_096),
		branchName: z.string().min(1).max(1_024),
		worktreeId: z.string().min(1).max(256),
		worktreeSessionId: z.string().min(1).max(256),
		mergeStrategy: z.enum(['merge', 'rebase', 'cherry-pick']),
		laneIndex: z.number().int().nonnegative().max(255),
		worktreeDir: z.string().min(1).max(4_096).nullable(),
		reservationId: z.string().min(1).max(512).optional(),
		generation: z.number().int().min(1).optional(),
		provisioningOwner: z
			.object({
				reservationId: z.string().min(1).max(512),
				generation: z.number().int().min(1),
				branchName: z.string().min(1).max(1_024),
			})
			.strict()
			.optional(),
	})
	.strict();

const TerminalResultSchema = z
	.object({
		eventId: z.string().min(1).max(256),
		status: z.enum(['completed', 'error', 'cancelled']),
		recordedAt: z.number().int().nonnegative(),
		result: ResultSchema,
	})
	.strict();

const NormalizedObservedFileSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => normalizeObservedFile(value) === value);

const SettlementProvenanceSchema = z
	.object({
		correlationId: z.string().min(1).max(256),
		parentSessionId: z.string().min(1).max(256),
		callID: z.string().max(256),
		planTaskId: z.string().min(1).max(256).nullable(),
		baseline: WorkspaceSchema,
		worktree: WorktreeDescriptorSchema.nullable(),
	})
	.strict();

const SettlementOutcomeSchema = z
	.object({
		kind: z.enum(['shared-root', 'standard-worktree']),
		result: z.enum(['ready', 'merged', 'unchanged', 'partial', 'failed']),
		reason: z.string().min(1).max(2_000).optional(),
		sourceHeadAfterCommit: z.string().min(1).max(256).nullable().optional(),
		targetHeadBeforeMerge: z.string().min(1).max(256).nullable().optional(),
		targetHeadAfterMerge: z.string().min(1).max(256).nullable().optional(),
	})
	.strict();

const CoderSettlementSchema = z
	.object({
		state: z.enum(['pending', 'settling', 'settled', 'preserved']),
		provenance: SettlementProvenanceSchema,
		operationId: z.string().min(1).max(256).optional(),
		sourceHeadAfterCommit: z.string().min(1).max(256).nullable().optional(),
		targetHeadBeforeMerge: z.string().min(1).max(256).nullable().optional(),
		observedFiles: z
			.array(NormalizedObservedFileSchema)
			.max(MAX_BACKGROUND_OBSERVED_FILES)
			.nullable(),
		outcome: SettlementOutcomeSchema.optional(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.state !== 'pending' && !value.operationId) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'settling, settled, and preserved states require operationId',
			});
		}
		if (
			(value.state === 'settled' || value.state === 'preserved') &&
			!value.outcome
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'terminal settlement state requires outcome',
			});
		}
	});

const AdvisoryPreparationSchema = z
	.object({
		id: z.string().min(1).max(256),
		preparedAt: z.number().int().nonnegative(),
		leaseExpiresAt: z.number().int().nonnegative(),
	})
	.strict();

const AdvisoryInboxSchema = z
	.object({
		eventId: z.string().min(1).max(256),
		parentSessionId: z.string().min(1).max(256),
		state: z.enum(['pending', 'delivered']),
		message: z.string().min(1).max(MAX_BACKGROUND_ADVISORY_CHARS),
		createdAt: z.number().int().nonnegative(),
		preparation: AdvisoryPreparationSchema.optional(),
		deliveredAt: z.number().int().nonnegative().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.state === 'delivered' && value.deliveredAt === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'delivered advisory requires deliveredAt',
			});
		}
		if (value.state === 'delivered' && value.preparation !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'delivered advisory cannot retain a preparation lease',
			});
		}
	});

const DelegationIngestionSchema = z
	.object({
		state: z.enum(['claimed', 'retryable', 'consumed']),
		attempt: z.number().int().positive(),
		updatedAt: z.number().int().nonnegative(),
		claimToken: z.string().min(1).max(256),
		leaseExpiresAt: z.number().int().nonnegative().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.state === 'claimed' && value.leaseExpiresAt === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'claimed ingestion requires a lease expiry',
			});
		}
		if (value.state !== 'claimed' && value.leaseExpiresAt !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'completed ingestion cannot retain a claim lease',
			});
		}
	});

const BackgroundCoderReservationSchema = z
	.object({
		reservationId: z.string().min(1).max(256),
		parentSessionId: z.string().min(1).max(256),
		planTaskId: z.string().min(1).max(256).nullable(),
		callID: z.string().min(1).max(256),
		state: z.enum(['reserved', 'bound']),
		correlationId: z.string().min(1).max(256).nullable(),
		generation: z
			.number()
			.int()
			.min(1)
			.max(MAX_BACKGROUND_DELEGATION_GENERATION)
			.optional(),
		leaseExpiresAt: z.number().int().nonnegative().optional(),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.state === 'reserved' && value.correlationId !== null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'unbound reservation cannot have a correlationId',
			});
		}
		if (value.state === 'bound' && value.correlationId === null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'bound reservation requires a correlationId',
			});
		}
	});

const BackgroundCoderReservationStoreSchema = z
	.object({
		schemaVersion: z.literal(1),
		reservations: z
			.array(BackgroundCoderReservationSchema)
			.max(MAX_LIVE_BACKGROUND_CODER_RESERVATIONS),
	})
	.strict()
	.superRefine((value, context) => {
		const ids = new Set<string>();
		for (const reservation of value.reservations) {
			if (ids.has(reservation.reservationId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'duplicate reservationId',
				});
				return;
			}
			if (
				reservation.reservationId !==
				buildBackgroundCoderReservationId({
					parentSessionId: reservation.parentSessionId,
					planTaskId: reservation.planTaskId,
					callID: reservation.callID,
				})
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'reservationId does not match owner identity',
				});
				return;
			}
			ids.add(reservation.reservationId);
		}
	});

const PromptSchema = z
	.object({
		text: z.string(),
		chars: z.number(),
		truncated: z.boolean(),
		digest: z.string(),
	})
	.strict();

const RecordSchema = z
	.object({
		schemaVersion: z.union([
			z.literal(1),
			z.literal(2),
			z.literal(3),
			z.literal(4),
		]),
		correlationId: z.string().min(1),
		jobId: z.string().nullable(),
		subagentSessionId: z.string().min(1),
		parentSessionId: z.string().min(1),
		callID: z.string(),
		normalizedAgent: z.string(),
		swarmPrefixedAgent: z.string(),
		planTaskId: z.string().nullable(),
		evidenceTaskId: z.string().nullable(),
		status: z.enum([
			'pending',
			'running',
			'ingestion_error',
			'completed',
			'error',
			'cancelled',
			'stale',
			'consumed',
		]),
		createdAt: z.number(),
		updatedAt: z.number(),
		batchId: z.string().optional(),
		laneId: z.string().optional(),
		mode: z.string().optional(),
		workflowLane: z.string().optional(),
		ownedWorkflowLanes: z
			.array(z.string().min(1).max(120))
			.min(1)
			.max(11)
			.optional(),
		prReviewLegacyTranscriptCompatibility: z.boolean().optional(),
		promptHash: z.string().optional(),
		workspace: WorkspaceSchema.optional(),
		taskChangeContext: TaskChangeContextSchema.optional(),
		workflowGeneration: z.number().int().nonnegative().optional(),
		worktree: WorktreeDescriptorSchema.optional(),
		coderReservationId: z.string().min(1).max(256).optional(),
		prompt: PromptSchema.optional(),
		generation: z
			.number()
			.int()
			.positive()
			.max(MAX_BACKGROUND_DELEGATION_GENERATION)
			.optional(),
		terminalResult: TerminalResultSchema.optional(),
		coderSettlement: CoderSettlementSchema.optional(),
		advisoryInbox: AdvisoryInboxSchema.optional(),
		legacyCoderSettlementTransfer: z
			.object({
				taskId: z.string().min(1).max(256),
				transitionId: z.string().min(1).max(256),
				updatedAt: z.number().nonnegative(),
			})
			.strict()
			.optional(),
		ingestion: DelegationIngestionSchema.optional(),
		result: ResultSchema.optional(),
		completedAt: z.number().optional(),
	})
	.strict();

const FallbackArtifactSchema = z
	.object({
		schemaVersion: z.literal(1),
		correlationId: z.string().min(1).max(256),
		createdAt: z.number().int().nonnegative(),
		record: RecordSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.record.correlationId !== value.correlationId ||
			value.record.subagentSessionId !== value.correlationId ||
			value.record.status !== 'pending'
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'fallback identity/status does not match its pending record',
			});
		}
	});

function storePath(directory: string): string {
	return validateSwarmPath(directory, BACKGROUND_DELEGATIONS_FILE);
}

function checkpointPath(directory: string): string {
	return validateSwarmPath(directory, BACKGROUND_DELEGATIONS_CHECKPOINT_FILE);
}

function manifestPath(directory: string): string {
	return validateSwarmPath(directory, BACKGROUND_DELEGATIONS_MANIFEST_FILE);
}

// ---------------------------------------------------------------------------
// Checkpoint / compaction layer (issue #2034)
// ---------------------------------------------------------------------------

export interface BackgroundDelegationCheckpoint {
	schemaVersion: 1;
	/** Monotonic checkpoint sequence for this store. */
	sequence: number;
	/** Diagnostics-only identity of the writing process (never validated). */
	writerId: string;
	/** Resolved project root this checkpoint is bound to. */
	rootPath: string;
	createdAt: number;
	/** Byte length of the ledger at the cut. */
	cutLedgerBytes: number;
	/** sha256 of the ledger bytes [0..cutLedgerBytes) at the cut. */
	cutLedgerDigest: string;
	/** Live full records (bounded by MAX_CHECKPOINT_RECORDS). */
	records: BackgroundDelegationRecord[];
	/** Compact closed-record summaries, byte-budget governed. */
	closed: BackgroundDelegationRecord[];
	audit: DelegationCheckpointAuditSummary;
	payloadChecksum: string;
}

export interface BackgroundDelegationManifest {
	schemaVersion: 1;
	sequence: number;
	checkpointChecksum: string;
	writerId: string;
	rootPath: string;
	updatedAt: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const CheckpointSchema = z
	.object({
		schemaVersion: z.literal(1),
		sequence: z.number().int().positive(),
		writerId: z.string().min(1).max(128),
		rootPath: z.string().min(1).max(4_096),
		createdAt: z.number().int().nonnegative(),
		cutLedgerBytes: z.number().int().nonnegative(),
		cutLedgerDigest: z.string().regex(SHA256_HEX),
		records: z.array(RecordSchema).max(MAX_CHECKPOINT_RECORDS),
		closed: z.array(RecordSchema),
		audit: DelegationCheckpointAuditSchema,
		payloadChecksum: z.string().regex(SHA256_HEX),
	})
	.strict();

const ManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		sequence: z.number().int().positive(),
		checkpointChecksum: z.string().regex(SHA256_HEX),
		writerId: z.string().min(1).max(128),
		rootPath: z.string().min(1).max(4_096),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict();

/** Per-process diagnostic writer identity (issue #2034 requirement 2). */
const WRITER_ID = `w-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export const _checkpointInternals: {
	renameWithRetry: (from: string, to: string) => void;
	renameOnce: (from: string, to: string) => void;
	syncSleep: (ms: number) => void;
} = {
	renameWithRetry: (from, to) => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				_checkpointInternals.renameOnce(from, to);
				return;
			} catch (err) {
				lastError = err;
				const code = (err as NodeJS.ErrnoException).code;
				// Windows can briefly hold a handle (AV/indexer) on the target.
				if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM') {
					throw err;
				}
				_checkpointInternals.syncSleep(15);
			}
		}
		throw lastError;
	},
	renameOnce: (from, to) => {
		fs.renameSync(from, to);
	},
	syncSleep: (ms) => {
		// Portable sleep (transient-retry.ts precedent): Atomics.wait throws
		// on some platforms/threads; fall back to a bounded busy-wait.
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {
			const start = Date.now();
			while (Date.now() - start < ms) {
				/* bounded busy-wait */
			}
		}
	},
};

/**
 * Durable JSON write: temp file → fsync → rename (with Windows lock retries) →
 * best-effort directory fsync. Crash safety comes from the publication ordering
 * in `compactDelegationsLocked`, not from any single fsync.
 */
function writeDurableFileSync(target: string, contents: string | Buffer): void {
	const tmp = `${target}.tmp-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	try {
		const fd = fs.openSync(tmp, 'w');
		try {
			// Descriptor write (an excluded write head for the evidence-cache
			// scanner): the path is named at this openSync, not at the write.
			if (typeof contents === 'string') {
				fs.writeSync(fd, contents);
			} else {
				fs.writeSync(fd, contents, 0, contents.length);
			}
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		_checkpointInternals.renameWithRetry(tmp, target);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best-effort cleanup of the abandoned temp file
		}
		throw err;
	}
	try {
		const dfd = fs.openSync(path.dirname(target), 'r');
		try {
			fs.fsyncSync(dfd);
		} finally {
			fs.closeSync(dfd);
		}
	} catch {
		// Directory fsync is unsupported on Windows; ordering covers durability.
	}
}

type JsonFileRead =
	| { status: 'absent' }
	| { status: 'ok'; value: unknown }
	| { status: 'invalid'; reason: string };

/**
 * Single-attempt JSON read. A missing file is a legitimate steady state (most
 * repos never compact), so ENOENT must not sleep-retry — that would tax every
 * read on every repo. Transient read errors surface as `invalid` (strict
 * readers fail closed); parse failures are `invalid` regardless.
 */
function readJsonFileWithRetry(target: string): JsonFileRead {
	let raw: string;
	try {
		raw = fs.readFileSync(target, 'utf-8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return { status: 'absent' };
		return {
			status: 'invalid',
			reason: `unreadable (${code ?? 'unknown error'})`,
		};
	}
	try {
		return { status: 'ok', value: JSON.parse(raw) };
	} catch (err) {
		return {
			status: 'invalid',
			reason: `malformed JSON (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}

function readDelegationManifest(
	directory: string,
):
	| { kind: 'absent' }
	| { kind: 'ok'; manifest: BackgroundDelegationManifest }
	| { kind: 'invalid'; reason: string } {
	const read = readJsonFileWithRetry(manifestPath(directory));
	if (read.status === 'absent') return { kind: 'absent' };
	if (read.status === 'invalid')
		return { kind: 'invalid', reason: read.reason };
	const parsed = ManifestSchema.safeParse(read.value);
	if (!parsed.success) {
		return { kind: 'invalid', reason: 'manifest fails schema validation' };
	}
	return { kind: 'ok', manifest: parsed.data };
}

function readDelegationCheckpoint(
	directory: string,
):
	| { kind: 'absent' }
	| { kind: 'ok'; checkpoint: BackgroundDelegationCheckpoint; bytes: number }
	| { kind: 'invalid'; reason: string } {
	let bytes = 0;
	try {
		bytes = fs.statSync(checkpointPath(directory)).size;
	} catch {
		// fall through to the read below; ENOENT surfaces there
	}
	// Reject over-budget files BEFORE reading/parsing them into memory.
	if (bytes > MAX_CHECKPOINT_BYTES) {
		return {
			kind: 'invalid',
			reason: `checkpoint exceeds the ${MAX_CHECKPOINT_BYTES}-byte bound`,
		};
	}
	const read = readJsonFileWithRetry(checkpointPath(directory));
	if (read.status === 'absent') return { kind: 'absent' };
	if (read.status === 'invalid')
		return { kind: 'invalid', reason: read.reason };
	const parsed = CheckpointSchema.safeParse(read.value);
	if (!parsed.success) {
		return { kind: 'invalid', reason: 'checkpoint fails schema validation' };
	}
	return { kind: 'ok', checkpoint: parsed.data, bytes };
}

function sha256Hex(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex');
}

function checkpointPayloadChecksum(
	checkpoint: Omit<BackgroundDelegationCheckpoint, 'payloadChecksum'>,
): string {
	return sha256Hex(
		JSON.stringify([
			checkpoint.schemaVersion,
			checkpoint.sequence,
			checkpoint.writerId,
			checkpoint.rootPath,
			checkpoint.createdAt,
			checkpoint.cutLedgerBytes,
			checkpoint.cutLedgerDigest,
			checkpoint.records,
			checkpoint.closed,
			checkpoint.audit,
		]),
	);
}

const CHECKPOINT_REBIND_HINT =
	'remove .swarm/background-delegations.manifest.json (manifest only) after verifying no in-flight background delegations; recovery then falls back to the full-ledger read. Only if you also want to discard pre-cut closed summaries and audit history — which for a compacted (rolled) ledger exist ONLY in .swarm/background-delegations.checkpoint.json — remove the checkpoint too or use the full reset below';
const CHECKPOINT_RESET_HINT =
	'the rolled tail no longer carries pre-checkpoint state: stop swarm processes, verify no in-flight background delegations, and remove .swarm/background-delegations.manifest.json, .swarm/background-delegations.checkpoint.json, and .swarm/background-delegations.jsonl to reset the store (or restore them from backup)';

type LedgerLoadMode = 'legacy' | 'checkpoint+tail' | 'checkpoint+ledger-suffix';

interface LenientLedgerSkipCounts {
	malformedJson: number;
	invalidRecord: number;
}

const lenientLedgerSignalByRoot = new Map<string, string>();
const lenientLedgerSignalOrder: string[] = [];

type LedgerLoad =
	| {
			status: 'ok';
			mode: LedgerLoadMode;
			records: Map<string, BackgroundDelegationRecord>;
			manifest: BackgroundDelegationManifest | null;
			checkpoint: BackgroundDelegationCheckpoint | null;
	  }
	| { status: 'uncertain'; reason: string; repairHint?: string };

/**
 * Read and fold the applicable ledger region. Shared by every reader; `strict`
 * fails closed on any malformed data in the applicable region (recovery
 * contract), `lenient` skips malformed lines (advisory reader contract).
 *
 * Publication model (issue #2034): a compaction writes checkpoint → manifest →
 * rolled tail, in that order, each an atomic durable rename. The manifest is the
 * publication point — a checkpoint without a manifest is an aborted compaction
 * that readers ignore (the ledger was not rolled yet). Recovery with a valid
 * manifest + checkpoint folds the checkpoint state and then applies only the
 * post-cut tail: when the ledger still holds the pre-cut history (crash between
 * manifest and roll), the verified cut prefix is skipped; when the prefix does
 * not verify (rolled tail that grew past the old cut, or rewritten bytes), a
 * bounded recent window folds under an update-time merge in which pre-cut
 * snapshots lose to the checkpoint entries derived from them. Both crash
 * interpretations converge on the same reconstructed state — recovery can only
 * fail closed on actual corruption (malformed data, checksum/sequence
 * mismatch), never on a legitimate crash window or tail growth.
 */
function loadFoldedState(
	directory: string,
	options: { strict: boolean },
): LedgerLoad {
	const manifestRead = readDelegationManifest(directory);
	if (manifestRead.kind === 'invalid') {
		return {
			status: 'uncertain',
			reason: `background delegation manifest is invalid: ${manifestRead.reason}`,
			// A manifest that existed but cannot be parsed means the publication
			// state is unknown: the ledger may be a rolled tail. Never fall back
			// to the legacy fold here.
			repairHint: CHECKPOINT_RESET_HINT,
		};
	}
	if (manifestRead.kind === 'absent') {
		return loadLegacyLedger(directory, options.strict);
	}
	const manifest = manifestRead.manifest;

	if (manifest.rootPath !== path.resolve(directory)) {
		// Bound to a different project root: whether the ledger is rolled is
		// unknowable from here, so fail closed with the rebind hint. (A copied
		// trio with an unrolled ledger still recovers only if the operator
		// removes the manifest — the conservative direction.)
		return {
			status: 'uncertain',
			reason:
				'background delegation checkpoint is bound to a different project root',
			repairHint: CHECKPOINT_REBIND_HINT,
		};
	}

	const checkpointRead = readDelegationCheckpoint(directory);
	if (checkpointRead.kind === 'invalid' || checkpointRead.kind === 'absent') {
		const detail =
			checkpointRead.kind === 'invalid'
				? `: ${checkpointRead.reason}`
				: ' (file missing)';
		return {
			status: 'uncertain',
			reason: `background delegation checkpoint is invalid${detail} while a manifest is published`,
			repairHint: CHECKPOINT_RESET_HINT,
		};
	}
	const checkpoint = checkpointRead.checkpoint;

	if (
		checkpoint.sequence !== manifest.sequence &&
		checkpoint.sequence !== manifest.sequence + 1
	) {
		return {
			status: 'uncertain',
			reason: `background delegation checkpoint/manifest sequence mismatch (checkpoint ${checkpoint.sequence}, manifest ${manifest.sequence})`,
			repairHint: CHECKPOINT_RESET_HINT,
		};
	}
	if (
		checkpoint.sequence === manifest.sequence &&
		manifest.checkpointChecksum !== checkpoint.payloadChecksum
	) {
		return {
			status: 'uncertain',
			reason:
				'background delegation manifest checksum does not match its checkpoint',
			repairHint: CHECKPOINT_RESET_HINT,
		};
	}
	if (checkpointPayloadChecksum(checkpoint) !== checkpoint.payloadChecksum) {
		return {
			status: 'uncertain',
			reason: 'background delegation checkpoint payload checksum mismatch',
			repairHint: CHECKPOINT_RESET_HINT,
		};
	}

	// Determine the post-cut tail region. The verified-cut prefix is a fast
	// path: when the ledger still holds the pre-cut history (crash between
	// manifest and roll), only the suffix beyond the cut is post-cut state.
	// When the prefix does not match (a rolled tail that grew past the old cut
	// size — normal for force-compacted small ledgers — or rewritten bytes),
	// fold a bounded recent window instead: older lines lose the update-time
	// merge against the checkpoint anyway, so both interpretations converge and
	// no legitimate state fails closed.
	let stat: fs.Stats;
	try {
		stat = fs.statSync(storePath(directory));
	} catch (error) {
		return {
			status: 'uncertain',
			reason: `background delegation ledger metadata is unreadable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	let tail: Buffer;
	let mode: 'checkpoint+tail' | 'checkpoint+ledger-suffix';
	if (stat.size >= checkpoint.cutLedgerBytes && checkpoint.cutLedgerBytes > 0) {
		const prefix = readLedgerRegion(directory, 0, checkpoint.cutLedgerBytes);
		if (sha256Hex(prefix) === checkpoint.cutLedgerDigest) {
			const suffixBytes = stat.size - checkpoint.cutLedgerBytes;
			if (suffixBytes > MAX_RECOVERY_LEDGER_BYTES) {
				return {
					status: 'uncertain',
					reason: `background delegation ledger changed beyond the ${MAX_RECOVERY_LEDGER_BYTES}-byte recovery bound`,
				};
			}
			tail =
				suffixBytes === 0
					? Buffer.alloc(0)
					: readLedgerRegion(directory, checkpoint.cutLedgerBytes, suffixBytes);
			mode = 'checkpoint+ledger-suffix';
		} else {
			tail = readBoundedRecentLedgerWindow(directory, stat.size);
			mode = 'checkpoint+tail';
		}
	} else {
		tail = readBoundedRecentLedgerWindow(directory, stat.size);
		mode = 'checkpoint+tail';
	}

	const records = new Map<string, BackgroundDelegationRecord>();
	for (const record of checkpoint.records) {
		records.set(record.correlationId, record);
	}
	for (const summary of checkpoint.closed) {
		records.set(summary.correlationId, summary);
	}
	const lenientSkips = emptyLenientLedgerSkipCounts();
	const foldError = foldLedgerTail(
		records,
		tail,
		options.strict,
		checkpoint,
		lenientSkips,
	);
	if (foldError) return { status: 'uncertain', reason: foldError };
	if (!options.strict) {
		recordLenientLedgerSkips(directory, mode, lenientSkips);
	}
	return {
		status: 'ok',
		mode,
		records,
		manifest,
		checkpoint,
	};
}

function readLedgerRegion(
	directory: string,
	offset: number,
	length: number,
): Buffer {
	const fd = fs.openSync(storePath(directory), 'r');
	try {
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = fs.readSync(fd, buffer, read, length - read, offset + read);
			if (n <= 0) break;
			read += n;
		}
		return read === length ? buffer : buffer.subarray(0, read);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read at most the last MAX_RECOVERY_LEDGER_BYTES of the ledger, aligned to
 * the first complete line in that window (a truncated leading line belongs to
 * older state that loses the checkpoint merge anyway). Hard read bound for
 * checkpoint-based recovery (issue #2034 requirement 4).
 */
function readBoundedRecentLedgerWindow(
	directory: string,
	size: number,
): Buffer {
	if (size === 0) return Buffer.alloc(0);
	if (size <= MAX_RECOVERY_LEDGER_BYTES) {
		return readLedgerRegion(directory, 0, size);
	}
	const window = readLedgerRegion(
		directory,
		size - MAX_RECOVERY_LEDGER_BYTES,
		MAX_RECOVERY_LEDGER_BYTES,
	);
	const firstNewline = window.indexOf(0x0a);
	return firstNewline === -1
		? Buffer.alloc(0)
		: window.subarray(firstNewline + 1);
}

/**
 * Fold tail lines into the map; returns a strict failure reason or null.
 *
 * With a checkpoint baseline, a tail line replaces the baseline entry only when
 * it is genuinely newer: strictly newer `updatedAt`, or an equal timestamp that
 * post-dates the checkpoint cut. This makes both crash interpretations of the
 * publication sequence converge: pre-cut lines (visible when the ledger was not
 * yet rolled) lose to the checkpoint snapshots derived from them, while
 * post-cut appends always win.
 */
function foldLedgerTail(
	records: Map<string, BackgroundDelegationRecord>,
	tail: Buffer,
	strict: boolean,
	checkpoint?: BackgroundDelegationCheckpoint,
	lenientSkips?: LenientLedgerSkipCounts,
): string | null {
	let lineNumber = 0;
	for (const line of tail.toString('utf-8').split('\n')) {
		lineNumber += 1;
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(trimmed);
		} catch {
			if (strict) {
				return `background delegation ledger has malformed JSON at line ${lineNumber}`;
			}
			if (lenientSkips) lenientSkips.malformedJson += 1;
			continue;
		}
		const parsed = RecordSchema.safeParse(parsedJson);
		if (!parsed.success) {
			if (strict) {
				return `background delegation ledger has an invalid record at line ${lineNumber}`;
			}
			if (lenientSkips) lenientSkips.invalidRecord += 1;
			continue;
		}
		const existing = checkpoint
			? records.get(parsed.data.correlationId)
			: undefined;
		if (
			checkpoint &&
			existing &&
			!(parsed.data.updatedAt > existing.updatedAt) &&
			!(
				parsed.data.updatedAt === existing.updatedAt &&
				parsed.data.updatedAt > checkpoint.createdAt
			)
		) {
			continue;
		}
		records.set(parsed.data.correlationId, parsed.data);
	}
	return null;
}

/**
 * Legacy (pre-checkpoint) fold: exactly the historical behavior of
 * readDelegations (lenient) / scanDelegationsForRecovery (strict), including
 * the reason strings and the stat-before-read / recheck-after-read shape.
 */
function loadLegacyLedger(directory: string, strict: boolean): LedgerLoad {
	if (!strict) {
		let raw: string;
		try {
			raw = fs.readFileSync(storePath(directory), 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn(
					`[background] readDelegations failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return {
				status: 'ok',
				mode: 'legacy',
				records: new Map(),
				manifest: null,
				checkpoint: null,
			};
		}
		const records = new Map<string, BackgroundDelegationRecord>();
		const lenientSkips = emptyLenientLedgerSkipCounts();
		const foldError = foldLedgerTail(
			records,
			Buffer.from(raw, 'utf-8'),
			false,
			undefined,
			lenientSkips,
		);
		void foldError; // lenient never fails
		recordLenientLedgerSkips(directory, 'legacy-ledger', lenientSkips);
		return {
			status: 'ok',
			mode: 'legacy',
			records,
			manifest: null,
			checkpoint: null,
		};
	}

	let absolutePath: string;
	try {
		absolutePath = storePath(directory);
		const stat = fs.statSync(absolutePath);
		if (stat.size > MAX_RECOVERY_LEDGER_BYTES) {
			return {
				status: 'uncertain',
				reason: `background delegation ledger exceeds the ${MAX_RECOVERY_LEDGER_BYTES}-byte recovery bound`,
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				status: 'ok',
				mode: 'legacy',
				records: new Map(),
				manifest: null,
				checkpoint: null,
			};
		}
		return {
			status: 'uncertain',
			reason: `background delegation ledger metadata is unreadable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	let raw: string;
	try {
		raw = fs.readFileSync(absolutePath, 'utf-8');
	} catch (error) {
		return {
			status: 'uncertain',
			reason: `background delegation ledger is unreadable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_LEDGER_BYTES) {
		return {
			status: 'uncertain',
			reason: `background delegation ledger changed beyond the ${MAX_RECOVERY_LEDGER_BYTES}-byte recovery bound`,
		};
	}
	const records = new Map<string, BackgroundDelegationRecord>();
	const foldError = foldLedgerTail(records, Buffer.from(raw, 'utf-8'), true);
	if (foldError) return { status: 'uncertain', reason: foldError };
	return {
		status: 'ok',
		mode: 'legacy',
		records,
		manifest: null,
		checkpoint: null,
	};
}

/**
 * Authoritative load for mutation paths (callers hold the store lock).
 * Returns null when the authoritative state is uncertain — the caller must
 * refuse the mutation (fail closed) rather than append state derived from
 * partial truth.
 */
function loadRecordsForWrite(
	directory: string,
): BackgroundDelegationRecord[] | null {
	const load = loadFoldedState(directory, { strict: false });
	if (load.status === 'uncertain') {
		recordLedgerUncertainty(
			directory,
			load.reason,
			'mutation',
			load.repairHint,
		);
		return null;
	}
	return [...load.records.values()];
}

function findRecordForWrite(
	records: BackgroundDelegationRecord[] | null,
	correlationId: string,
): BackgroundDelegationRecord | null {
	if (!records) return null;
	for (const record of records) {
		if (record.correlationId === correlationId) return record;
	}
	return null;
}

function recordLedgerUncertainty(
	directory: string,
	reason: string,
	source: string,
	repairHint?: string,
): void {
	try {
		writeDelegationHealthArtifact(directory, {
			uncertainty: {
				reason,
				at: Date.now(),
				source,
				...(repairHint ? { repairHint } : {}),
			},
		});
	} catch {
		// The observation sink must never break the store.
	}
}

function emptyLenientLedgerSkipCounts(): LenientLedgerSkipCounts {
	return { malformedJson: 0, invalidRecord: 0 };
}

function shouldEmitLenientLedgerSignal(
	directory: string,
	signature: string,
): boolean {
	const key = canonicalRootKeyFresh(directory);
	const existing = lenientLedgerSignalByRoot.get(key);
	if (existing === signature) return false;
	if (!existing) {
		if (lenientLedgerSignalOrder.length >= MAX_TRACKED_LENIENT_LEDGER_SIGNALS) {
			const evicted = lenientLedgerSignalOrder.shift();
			if (evicted) lenientLedgerSignalByRoot.delete(evicted);
		}
		lenientLedgerSignalOrder.push(key);
	}
	lenientLedgerSignalByRoot.set(key, signature);
	return true;
}

function recordLenientLedgerSkips(
	directory: string,
	source: LedgerLoadMode | 'legacy-ledger',
	counts: LenientLedgerSkipCounts,
): void {
	const skipped = counts.malformedJson + counts.invalidRecord;
	if (skipped <= 0) return;
	const reason =
		`background delegation ledger skipped ${skipped} malformed/invalid row${skipped === 1 ? '' : 's'} ` +
		`during lenient ${source} read (${counts.malformedJson} malformed JSON, ${counts.invalidRecord} invalid records)`;
	const signature = `${source}:${counts.malformedJson}:${counts.invalidRecord}`;
	if (shouldEmitLenientLedgerSignal(directory, signature)) {
		logger.criticalWarn(`[background] ${reason}`);
	}
	try {
		const current = readDelegationHealthArtifact(directory);
		if (
			current?.lastUncertainty &&
			current.lastUncertainty.source !== LENIENT_LEDGER_SIGNAL_SOURCE
		) {
			return;
		}
		writeDelegationHealthArtifact(directory, {
			lastUncertainty: {
				reason,
				at: Date.now(),
				source: LENIENT_LEDGER_SIGNAL_SOURCE,
			},
		});
	} catch {
		// The observation sink must never break the store.
	}
}

/**
 * True when a record still owns an unsettled worktree (mirrors
 * init-orphan-recovery's protection predicate — exported so both sites share
 * ONE definition; drift here changes which worktrees orphan cleanup protects).
 */
export function isUnsettledWorktreeOwner(
	record: BackgroundDelegationRecord,
): boolean {
	return (
		Boolean(record.worktree) &&
		!(
			record.coderSettlement?.state === 'settled' &&
			record.coderSettlement.outcome?.kind === 'standard-worktree' &&
			(record.coderSettlement.outcome.result === 'merged' ||
				record.coderSettlement.outcome.result === 'unchanged')
		)
	);
}

/**
 * A record stays FULL in the checkpoint while any consumer still derives
 * behavior from its bodies: non-terminal, pending advisory, unfinished coder
 * settlement, unsettled worktree ownership, or admission-active coder owner
 * (mirrors isActiveCoderOwner + init-orphan-recovery's unsettled-worktree
 * predicate so compaction never changes a consumer's view of live state).
 */
function isCheckpointLiveRecord(record: BackgroundDelegationRecord): boolean {
	if (!isTerminal(record.status)) return true;
	if (record.advisoryInbox?.state === 'pending') return true;
	// A pending legacy transfer still needs the terminal result body for the
	// observer's durable replay after the WAL becomes writable again.
	if (record.legacyCoderSettlementTransfer) return true;
	const settlement = record.coderSettlement;
	if (settlement && settlement.state !== 'settled') return true;
	if (settlement?.state === 'settled' && isUnsettledWorktreeOwner(record)) {
		return true;
	}
	if (isActiveCoderOwner(record)) return true;
	return false;
}

/**
 * Build a closed-record summary: keep every small field consumers gate on
 * (identity, lane coordinates, workspace, worktree, result scalars) and drop
 * only the large bodies — prompt text, taskChangeContext, and the text/error
 * result bodies (their sha256 `digest` is retained and covers the dropped
 * content). An authenticated, bounded final-line PR-review collection receipt is retained
 * because collection projects accepted/rejected retry IDs from that durable
 * metadata after compaction. Structured PR-review result receipts remain
 * authoritative on `result.prReviewResultReceipt`; closed summaries strip the
 * duplicate `terminalResult.result.prReviewResultReceipt` copy to keep the
 * closed-set byte cost bounded, while live records retain the full terminal
 * payload and are already capped by `MAX_CHECKPOINT_RECORDS`.
 * `coderSettlement.observedFiles` is retained: only SETTLED settlements reach
 * summaries (see isCheckpointLiveRecord), and the settled observed-file list is
 * the executed-contract audit artifact — final and never recomputed. Returns
 * null when the summary would not validate; the caller then keeps the full
 * record instead (safety over size).
 */
function buildClosedSummary(
	record: BackgroundDelegationRecord,
): BackgroundDelegationRecord | null {
	const summary: BackgroundDelegationRecord = { ...record };
	delete summary.prompt;
	delete summary.taskChangeContext;
	if (summary.result) {
		summary.result = stripResultBody(record, summary.result);
	}
	if (summary.terminalResult) {
		summary.terminalResult = {
			...summary.terminalResult,
			// `record.result` is the collection projection source and the
			// structured-receipt authority. Retaining the same projection on the
			// nested terminal copy would double the closed-summary checkpoint cost.
			result: dropTerminalResultBody(summary.terminalResult.result),
		};
	}
	const parsed = RecordSchema.safeParse(summary);
	return parsed.success ? (parsed.data as BackgroundDelegationRecord) : null;
}

function stripResultBody(
	record: BackgroundDelegationRecord,
	result: BackgroundDelegationResult,
): BackgroundDelegationResult {
	const { text: _text, error: _error, ...rest } = result;
	const receipt = parsePrReviewCollectionReceiptFooter(record, result);
	const shedMarker = receipt
		? null
		: parsePrReviewCollectionReceiptShedMarker(record, result);
	const receiptText = receipt
		? `${PR_REVIEW_COLLECTION_RECEIPT_PREFIX}${JSON.stringify(receipt)}`
		: shedMarker
			? `${PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX}${JSON.stringify(shedMarker)}`
			: undefined;
	return receiptText
		? { ...rest, text: receiptText, outputPreviewChars: receiptText.length }
		: rest;
}

function dropResultBody(
	result: BackgroundDelegationResult,
): BackgroundDelegationResult {
	const {
		text: _text,
		error: _error,
		outputPreviewChars: _preview,
		...rest
	} = result;
	return rest;
}

function dropTerminalResultBody(
	result: BackgroundDelegationResult,
): BackgroundDelegationResult {
	const { prReviewResultReceipt: _receipt, ...rest } = dropResultBody(result);
	return rest;
}

function dropRetainedPrReviewReceipt(
	record: BackgroundDelegationRecord,
): BackgroundDelegationRecord {
	const compact = (
		result: BackgroundDelegationResult,
	): BackgroundDelegationResult => {
		const payload = parsePrReviewCollectionReceiptFooter(record, result);
		if (!payload) {
			const marker = parsePrReviewCollectionReceiptShedMarker(record, result);
			if (!marker) return dropResultBody(result);
			const markerText = `${PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX}${JSON.stringify(marker)}`;
			const { text: _text, error: _error, ...rest } = result;
			return {
				...rest,
				text: markerText,
				outputPreviewChars: markerText.length,
			};
		}
		const marker = encodePrReviewCollectionReceiptShedMarker(payload);
		const { text: _text, error: _error, ...rest } = result;
		return { ...rest, text: marker, outputPreviewChars: marker.length };
	};
	return {
		...record,
		...(record.result ? { result: compact(record.result) } : {}),
		...(record.terminalResult
			? {
					terminalResult: {
						...record.terminalResult,
						result: dropTerminalResultBody(record.terminalResult.result),
					},
				}
			: {}),
	};
}

function emptyAudit(): DelegationCheckpointAuditSummary {
	return {
		dispatchCount: 0,
		terminalsByStatus: { completed: 0, error: 0, cancelled: 0, stale: 0 },
		settledCount: 0,
		preservedCount: 0,
		lateTerminalCount: 0,
		compactedTransitionCount: 0,
		compactedRecordCount: 0,
		firstDispatchAt: null,
		lastTerminalAt: null,
		lastCompactionAt: 0,
	};
}

function terminalEventStatusOf(
	record: BackgroundDelegationRecord,
): 'completed' | 'error' | 'cancelled' | 'stale' | null {
	if (record.terminalResult) {
		return record.terminalResult.status;
	}
	if (
		record.status === 'completed' ||
		record.status === 'error' ||
		record.status === 'cancelled' ||
		record.status === 'stale'
	) {
		return record.status;
	}
	// `consumed` is a post-terminal ingestion transition; the originating
	// terminal was counted when it was first observed.
	return null;
}

function mergeCheckpointAudit(
	previous: DelegationCheckpointAuditSummary | null,
	previousCheckpoint: BackgroundDelegationCheckpoint | null,
	folded: BackgroundDelegationRecord[],
	healthLateTerminals: number,
	retiredLineCount: number,
	newlySummarizedCount: number,
	now: number,
): DelegationCheckpointAuditSummary {
	const prev = previous ?? emptyAudit();
	const prevById = new Map<string, BackgroundDelegationRecord>();
	if (previousCheckpoint) {
		for (const record of previousCheckpoint.records) {
			prevById.set(record.correlationId, record);
		}
		for (const summary of previousCheckpoint.closed) {
			prevById.set(summary.correlationId, summary);
		}
	}
	const audit: DelegationCheckpointAuditSummary = {
		dispatchCount: prev.dispatchCount,
		terminalsByStatus: { ...prev.terminalsByStatus },
		settledCount: prev.settledCount,
		preservedCount: prev.preservedCount,
		lateTerminalCount: Math.max(prev.lateTerminalCount, healthLateTerminals),
		compactedTransitionCount: capCounter(
			prev.compactedTransitionCount,
			retiredLineCount,
		),
		compactedRecordCount: capCounter(
			prev.compactedRecordCount,
			newlySummarizedCount,
		),
		firstDispatchAt: prev.firstDispatchAt,
		lastTerminalAt: prev.lastTerminalAt,
		lastCompactionAt: now,
	};
	let minCreated = Number.POSITIVE_INFINITY;
	let maxTerminal = 0;
	for (const record of folded) {
		const prevRecord = prevById.get(record.correlationId);
		if (!prevRecord) {
			audit.dispatchCount += 1;
		}
		// Lifetime counters: a terminal/settled/preserved observation counts
		// exactly once — when this correlation's status first differs from its
		// previous epoch snapshot. Completed→consumed transitions keep the
		// originating terminal status via terminalResult, so they never
		// double-count.
		const terminalStatus = terminalEventStatusOf(record);
		if (terminalStatus) {
			const prevStatus = prevRecord ? terminalEventStatusOf(prevRecord) : null;
			if (prevStatus !== terminalStatus) {
				audit.terminalsByStatus[terminalStatus] += 1;
			}
			maxTerminal = Math.max(
				maxTerminal,
				record.terminalResult?.recordedAt ?? record.completedAt ?? 0,
			);
		}
		if (
			record.coderSettlement?.state === 'settled' &&
			prevRecord?.coderSettlement?.state !== 'settled'
		) {
			audit.settledCount += 1;
		}
		if (
			record.coderSettlement?.state === 'preserved' &&
			prevRecord?.coderSettlement?.state !== 'preserved'
		) {
			audit.preservedCount += 1;
		}
		minCreated = Math.min(minCreated, record.createdAt);
	}
	audit.firstDispatchAt = Number.isFinite(minCreated)
		? Math.min(prev.firstDispatchAt ?? Number.POSITIVE_INFINITY, minCreated)
		: prev.firstDispatchAt;
	audit.lastTerminalAt =
		Math.max(prev.lastTerminalAt ?? 0, maxTerminal) || null;
	return audit;
}

/** Clamp a monotonic counter at MAX_SAFE_INTEGER (operator-facing saturation). */
function capCounter(previous: number, delta: number): number {
	return Number.isSafeInteger(previous + delta)
		? previous + delta
		: Number.MAX_SAFE_INTEGER;
}

export interface CompactBackgroundDelegationsResult {
	status: 'compacted' | 'skipped' | 'uncertain';
	reason?: string;
	sequence?: number;
	tailBytes?: number;
	checkpointBytes?: number;
}

/**
 * Compact the delegation ledger: checkpoint the folded authoritative state,
 * publish it via the manifest, and roll the ledger to the post-cut tail.
 * Runs under the store lock (issue #2034 requirement 1).
 */
export async function compactBackgroundDelegations(
	directory: string,
	options: { force?: boolean } = {},
): Promise<CompactBackgroundDelegationsResult> {
	try {
		let outcome: CompactBackgroundDelegationsResult = {
			status: 'skipped',
			reason: 'not attempted',
		};
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				outcome = compactDelegationsLocked(directory, options);
			},
		);
		return outcome;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`[background] compactBackgroundDelegations failed: ${message}`);
		return { status: 'uncertain', reason: message };
	}
}

function compactDelegationsLocked(
	directory: string,
	options: { force?: boolean },
): CompactBackgroundDelegationsResult {
	const load = loadFoldedState(directory, { strict: false });
	if (load.status === 'uncertain') {
		recordLedgerUncertainty(
			directory,
			load.reason,
			'compaction',
			load.repairHint,
		);
		return { status: 'uncertain', reason: load.reason };
	}

	let ledgerBytes: Buffer;
	try {
		ledgerBytes = fs.readFileSync(storePath(directory));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'skipped', reason: 'no ledger to compact' };
		}
		return {
			status: 'uncertain',
			reason: err instanceof Error ? err.message : String(err),
		};
	}
	if (
		ledgerBytes.length <= DELEGATION_COMPACTION_HIGH_WATER_BYTES &&
		!options.force
	) {
		return {
			status: 'skipped',
			reason: 'ledger below the compaction high-water mark',
		};
	}
	const cutLedgerBytes = ledgerBytes.length;
	const retiredLineCount = countCompleteLines(ledgerBytes);

	const now = Date.now();
	const folded = [...load.records.values()];
	const live: BackgroundDelegationRecord[] = [];
	const closedCandidates: BackgroundDelegationRecord[] = [];
	for (const record of folded) {
		if (isCheckpointLiveRecord(record)) {
			live.push(record);
		} else {
			closedCandidates.push(buildClosedSummary(record) ?? record);
		}
	}
	if (live.length > MAX_CHECKPOINT_RECORDS) {
		recordLedgerUncertainty(
			directory,
			`checkpoint live-record budget exceeded (${live.length} > ${MAX_CHECKPOINT_RECORDS}); compaction skipped`,
			'compaction',
		);
		return {
			status: 'skipped',
			reason: `live record count ${live.length} exceeds the checkpoint budget ${MAX_CHECKPOINT_RECORDS}`,
		};
	}

	// Byte-budget retention, newest-first; young closed summaries are never evicted.
	closedCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
	const baseOverhead = Buffer.byteLength(
		JSON.stringify({
			schemaVersion: 1,
			sequence: 1,
			writerId: WRITER_ID,
			rootPath: path.resolve(directory),
			createdAt: now,
			cutLedgerBytes,
			cutLedgerDigest: sha256Hex(ledgerBytes),
			records: live,
			closed: [],
			audit: emptyAudit(),
			payloadChecksum: '0'.repeat(64),
		}),
		'utf-8',
	);
	let used = baseOverhead;
	const selectionBudget =
		MAX_CHECKPOINT_BYTES - CHECKPOINT_SELECTION_RESERVE_BYTES;
	const keptClosed: BackgroundDelegationRecord[] = [];
	let evicted = 0;
	for (const entry of closedCandidates) {
		let retainedEntry = entry;
		let cost = Buffer.byteLength(JSON.stringify(retainedEntry), 'utf-8') + 1;
		if (used + cost > selectionBudget) {
			if (now - entry.updatedAt < TOMBSTONE_MIN_AGE_MS) {
				retainedEntry = dropRetainedPrReviewReceipt(entry);
				cost = Buffer.byteLength(JSON.stringify(retainedEntry), 'utf-8') + 1;
				if (used + cost <= selectionBudget) {
					used += cost;
					keptClosed.push(retainedEntry);
					continue;
				}
				recordLedgerUncertainty(
					directory,
					'checkpoint byte budget would evict a young closed summary; compaction skipped',
					'compaction',
				);
				return {
					status: 'skipped',
					reason: 'checkpoint byte budget would evict a young closed summary',
				};
			}
			evicted += 1;
			continue;
		}
		used += cost;
		keptClosed.push(retainedEntry);
	}

	const sequence =
		Math.max(load.manifest?.sequence ?? 0, load.checkpoint?.sequence ?? 0, 0) +
		1;
	let healthLateTerminals = 0;
	try {
		const artifact = readDelegationHealthArtifact(directory);
		healthLateTerminals = artifact?.counts.lateTerminals ?? 0;
	} catch {
		healthLateTerminals = 0;
	}
	const previousClosedIds = new Set(
		(load.checkpoint?.closed ?? []).map((entry) => entry.correlationId),
	);
	const newlySummarized = keptClosed.filter(
		(entry) => !previousClosedIds.has(entry.correlationId),
	).length;
	const audit = mergeCheckpointAudit(
		load.checkpoint?.audit ?? null,
		load.checkpoint,
		folded,
		healthLateTerminals,
		retiredLineCount,
		newlySummarized + evicted,
		now,
	);

	const checkpointCandidate: BackgroundDelegationCheckpoint = {
		schemaVersion: 1,
		sequence,
		writerId: WRITER_ID,
		rootPath: path.resolve(directory),
		createdAt: now,
		cutLedgerBytes,
		cutLedgerDigest: sha256Hex(ledgerBytes),
		records: live,
		closed: keptClosed,
		audit,
		payloadChecksum: '0'.repeat(64),
	};
	// Normalize through the same strict schema recovery uses before hashing.
	// Otherwise an optional `undefined` or future schema projection difference
	// can serialize successfully but hash differently after reload.
	const normalizedCheckpoint = CheckpointSchema.safeParse(checkpointCandidate);
	if (!normalizedCheckpoint.success) {
		recordLedgerUncertainty(
			directory,
			'generated checkpoint failed schema normalization; compaction skipped',
			'compaction',
		);
		return {
			status: 'skipped',
			reason: 'generated checkpoint failed schema normalization',
		};
	}
	const checkpoint =
		normalizedCheckpoint.data as BackgroundDelegationCheckpoint;
	checkpoint.payloadChecksum = checkpointPayloadChecksum(checkpoint);
	const checkpointJson = `${JSON.stringify(checkpoint)}\n`;
	if (Buffer.byteLength(checkpointJson, 'utf-8') > MAX_CHECKPOINT_BYTES) {
		recordLedgerUncertainty(
			directory,
			'serialized checkpoint exceeds the byte budget; compaction skipped',
			'compaction',
		);
		return {
			status: 'skipped',
			reason: 'serialized checkpoint exceeds the byte budget',
		};
	}

	// Publication order: checkpoint → manifest → rolled tail, each an atomic
	// durable rename. The manifest is the publication point. Every crash window
	// is covered: before the manifest, readers ignore the checkpoint and fold
	// the intact (unrolled) ledger; after the manifest, recovery folds the
	// checkpoint plus the verified post-cut suffix (unrolled crash window) or
	// the rolled tail — both interpretations converge on the same state.
	writeDurableFileSync(checkpointPath(directory), checkpointJson);
	writeDurableFileSync(
		manifestPath(directory),
		`${JSON.stringify({
			schemaVersion: 1,
			sequence,
			checkpointChecksum: checkpoint.payloadChecksum,
			writerId: WRITER_ID,
			rootPath: checkpoint.rootPath,
			updatedAt: now,
		})}\n`,
	);

	let currentSize: number;
	try {
		currentSize = fs.statSync(storePath(directory)).size;
	} catch (err) {
		return {
			status: 'uncertain',
			reason: `ledger vanished during compaction: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	if (currentSize < cutLedgerBytes) {
		// Foreign interference or another roller finished first. The published
		// checkpoint + manifest remain valid: recovery folds the whole (now
		// smaller) ledger as the tail with the update-time merge.
		return {
			status: 'skipped',
			reason: 'ledger shrank during compaction; checkpoint published unrolled',
		};
	}
	const tailContent =
		currentSize > cutLedgerBytes
			? readLedgerRegion(
					directory,
					cutLedgerBytes,
					currentSize - cutLedgerBytes,
				)
			: Buffer.alloc(0);
	writeDurableFileSync(storePath(directory), tailContent);

	try {
		const pressurePct = Math.min(
			100,
			Math.round((tailContent.length / MAX_RECOVERY_LEDGER_BYTES) * 1000) / 10,
		);
		writeDelegationHealthArtifact(directory, {
			ledger: {
				bytes: tailContent.length,
				limitBytes: MAX_RECOVERY_LEDGER_BYTES,
				pressurePct,
				band:
					tailContent.length > DELEGATION_COMPACTION_HIGH_WATER_BYTES
						? 'compact-overdue'
						: tailContent.length > DELEGATION_COMPACTION_LOW_WATER_BYTES
							? 'nominal'
							: 'ok',
			},
			checkpoint: {
				sequence,
				createdAt: now,
				liveRecords: live.length,
				closedSummaries: keptClosed.length,
				bytes: Buffer.byteLength(checkpointJson, 'utf-8'),
				audit,
			},
			counts: {
				activeOwners: folded.filter((record) => isActiveCoderOwner(record))
					.length,
				pendingAdvisories: folded.filter(
					(record) => record.advisoryInbox?.state === 'pending',
				).length,
				lateTerminals: audit.lateTerminalCount,
				orphanWorktreeOwners: folded.filter(isUnsettledWorktreeOwner).length,
			},
		});
	} catch {
		// observation sink must never fail the compaction
	}

	return {
		status: 'compacted',
		sequence,
		tailBytes: tailContent.length,
		checkpointBytes: Buffer.byteLength(checkpointJson, 'utf-8'),
	};
}

function countCompleteLines(buffer: Buffer): number {
	let count = 0;
	for (const byte of buffer) {
		if (byte === 0x0a) count += 1;
	}
	return count;
}

/**
 * Lazy post-append maintenance (callers hold the store lock). Fails open: the
 * append has already landed, so a compaction failure must not fail the write.
 */
function maybeCompactDelegationsLocked(directory: string): void {
	try {
		const stat = fs.statSync(storePath(directory));
		if (stat.size <= DELEGATION_COMPACTION_HIGH_WATER_BYTES) return;
		const outcome = compactDelegationsLocked(directory, {});
		if (outcome.status === 'uncertain') {
			logger.warn(
				`[background] post-append compaction skipped: ${outcome.reason}`,
			);
		}
	} catch (err) {
		logger.warn(
			`[background] post-append compaction check failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

function ensureSwarmDir(directory: string): void {
	fs.mkdirSync(path.resolve(directory, '.swarm'), { recursive: true });
}

/**
 * Read and fold the store to the latest snapshot per correlationId. Lock-free and
 * defensive: a missing file yields an empty list, and malformed/partial lines are
 * skipped (never throws). Records are returned in first-seen correlationId order.
 *
 * Checkpoint-aware (issue #2034): when a published checkpoint exists, the fold is
 * checkpoint summaries + the bounded transition tail. When the authoritative
 * state is uncertain (invalid checkpoint/manifest with a rolled tail), this
 * returns [] — the strict recovery scan is the fail-closed authority.
 *
 * Cost: O(checkpoint + tail lines) per call. The tail is bounded by the
 * compaction high-water mark in normal operation.
 */
export function readDelegations(
	directory: string,
): BackgroundDelegationRecord[] {
	const load = loadFoldedState(directory, { strict: false });
	if (load.status === 'uncertain') {
		logger.warn(
			`[background] readDelegations: authoritative state uncertain (${load.reason}); returning empty`,
		);
		return [];
	}
	return [...load.records.values()];
}

/**
 * Strict startup-recovery view of the primary store. Unlike the ordinary
 * advisory reader, this never treats unreadable, oversized, or malformed owner
 * data as absence: destructive orphan cleanup must fail closed on uncertainty.
 * Checkpoint-aware: folds checkpoint + the applicable bounded tail region and
 * rejects corrupt or ambiguous cuts (issue #2034). Remains synchronous —
 * callers depend on it.
 */
export function scanDelegationsForRecovery(
	directory: string,
): RecoveryOwnershipScanResult<BackgroundDelegationRecord> {
	const load = loadFoldedState(directory, { strict: true });
	if (load.status === 'uncertain') {
		// Honest failure source (#2034 final-critic #4): a manifest-less store
		// failed in the legacy interpretation; anything else is unknown rather
		// than a wrongly-claimed recovery mode. The repair hint rides along so
		// the durable recovery observation stays actionable.
		const manifestKind = readDelegationManifest(directory).kind;
		return {
			status: 'uncertain',
			reason: load.reason,
			source: manifestKind === 'absent' ? 'legacy-ledger' : 'unknown',
			...(load.repairHint ? { repairHint: load.repairHint } : {}),
		};
	}
	const source =
		load.mode === 'legacy'
			? ('legacy-ledger' as const)
			: (load.mode as 'checkpoint+tail' | 'checkpoint+ledger-suffix');
	return { status: 'ok', owners: [...load.records.values()], source };
}

/** Returns the folded record for a correlationId, or null. Lock-free read. */
export function findByCorrelationId(
	directory: string,
	correlationId: string,
): BackgroundDelegationRecord | null {
	if (!correlationId) return null;
	for (const record of readDelegations(directory)) {
		if (record.correlationId === correlationId) return record;
	}
	return null;
}

function appendRecord(
	directory: string,
	record: BackgroundDelegationRecord,
): void {
	ensureSwarmDir(directory);
	fs.appendFileSync(
		storePath(directory),
		`${JSON.stringify(record)}\n`,
		'utf-8',
	);
}

export interface RecordPendingInput {
	correlationId: string;
	jobId: string | null;
	subagentSessionId: string;
	parentSessionId: string;
	callID: string;
	normalizedAgent: string;
	swarmPrefixedAgent: string;
	planTaskId: string | null;
	evidenceTaskId: string | null;
	batchId?: string;
	laneId?: string;
	mode?: string;
	workflowLane?: string;
	ownedWorkflowLanes?: string[];
	prReviewLegacyTranscriptCompatibility?: boolean;
	promptHash?: string;
	workspace?: BackgroundWorkspaceSnapshot;
	taskChangeContext?: BackgroundTaskChangeContext;
	workflowGeneration?: number;
	worktree?: BackgroundWorktreeDescriptor;
	coderReservationId?: string;
	prompt?: BackgroundPromptSnapshot;
	generation?: number;
}

function buildPendingRecord(
	input: RecordPendingInput,
	now: number,
): BackgroundDelegationRecord {
	return {
		schemaVersion: input.worktree ? 3 : input.batchId ? 2 : 1,
		correlationId: input.correlationId,
		jobId: input.jobId,
		subagentSessionId: input.subagentSessionId,
		parentSessionId: input.parentSessionId,
		callID: input.callID,
		normalizedAgent: input.normalizedAgent,
		swarmPrefixedAgent: input.swarmPrefixedAgent,
		planTaskId: input.planTaskId,
		evidenceTaskId: input.evidenceTaskId,
		status: 'pending',
		createdAt: now,
		updatedAt: now,
		...(input.batchId ? { batchId: input.batchId } : {}),
		...(input.laneId ? { laneId: input.laneId } : {}),
		...(input.mode ? { mode: input.mode } : {}),
		...(input.workflowLane ? { workflowLane: input.workflowLane } : {}),
		...(input.ownedWorkflowLanes?.length
			? { ownedWorkflowLanes: [...input.ownedWorkflowLanes] }
			: {}),
		...(input.prReviewLegacyTranscriptCompatibility !== undefined
			? {
					prReviewLegacyTranscriptCompatibility:
						input.prReviewLegacyTranscriptCompatibility,
				}
			: {}),
		...(input.promptHash ? { promptHash: input.promptHash } : {}),
		...(input.workspace ? { workspace: input.workspace } : {}),
		...(input.taskChangeContext
			? { taskChangeContext: input.taskChangeContext }
			: {}),
		...(input.workflowGeneration !== undefined
			? { workflowGeneration: input.workflowGeneration }
			: {}),
		...(input.worktree ? { worktree: input.worktree } : {}),
		...(input.coderReservationId
			? { coderReservationId: input.coderReservationId }
			: {}),
		...(input.prompt ? { prompt: input.prompt } : {}),
		...(input.generation !== undefined ? { generation: input.generation } : {}),
	};
}

/**
 * Record a `pending` background delegation. Runs the stale sweep first (lazy maintenance,
 * no plugin-init cost), then appends the pending snapshot — all under one lock acquisition
 * so concurrent dispatches cannot interleave. The discriminated outcome lets async
 * launchers distinguish a safe duplicate from a write failure without disrupting
 * the already-owned session.
 */
export type RecordPendingDelegationOutcome =
	| { status: 'recorded'; record: BackgroundDelegationRecord }
	| { status: 'duplicate'; record: BackgroundDelegationRecord }
	| { status: 'conflict'; record: BackgroundDelegationRecord }
	| { status: 'failed'; record: null };

function pendingLaunchIdentity(
	record: BackgroundDelegationRecord,
	summaryAware: boolean,
): object {
	return {
		correlationId: record.correlationId,
		jobId: record.jobId,
		subagentSessionId: record.subagentSessionId,
		parentSessionId: record.parentSessionId,
		callID: record.callID,
		normalizedAgent: record.normalizedAgent,
		swarmPrefixedAgent: record.swarmPrefixedAgent,
		planTaskId: record.planTaskId,
		evidenceTaskId: record.evidenceTaskId,
		batchId: record.batchId,
		laneId: record.laneId,
		mode: record.mode,
		workflowLane: record.workflowLane,
		ownedWorkflowLanes: record.ownedWorkflowLanes,
		promptHash: record.promptHash,
		workspace: record.workspace,
		// Closed-record summaries drop these bodies (issue #2034); comparing
		// them against a replaying dispatch would turn a genuine host replay
		// of a closed session into a `conflict`. When the existing record is a
		// summary (see samePendingLaunchIdentity), project both sides without
		// the strippable bodies.
		...(summaryAware
			? {}
			: {
					taskChangeContext: record.taskChangeContext,
					workflowGeneration: record.workflowGeneration,
					worktree: record.worktree,
					coderReservationId: record.coderReservationId,
					prompt: record.prompt,
					generation: record.generation ?? 1,
				}),
	};
}

function samePendingLaunchIdentity(
	left: BackgroundDelegationRecord,
	right: BackgroundDelegationRecord,
): boolean {
	// `left` is the authoritative existing record. When it is a closed-record
	// summary (terminal, and its strippable bodies were dropped by
	// compaction), comparing the bodies against a replaying dispatch would
	// turn a genuine host replay into a `conflict` — the exact churn the
	// fallback store must not see on every post-restart replay. Live records
	// keep the full projection, so a re-dispatch with a different prompt
	// still conflicts.
	const summaryAware =
		isTerminal(left.status) &&
		left.prompt === undefined &&
		left.taskChangeContext === undefined;
	return isDeepStrictEqual(
		pendingLaunchIdentity(left, summaryAware),
		pendingLaunchIdentity(right, summaryAware),
	);
}

export async function recordPendingDelegationDetailed(
	directory: string,
	input: RecordPendingInput,
	options: { staleTimeoutMs?: number } = {},
): Promise<RecordPendingDelegationOutcome> {
	const now = Date.now();
	const record = buildPendingRecord(input, now);
	const parsedRecord = RecordSchema.safeParse(record);
	if (!parsedRecord.success) {
		logger.warn('[background] recordPendingDelegation rejected invalid input');
		return { status: 'failed', record: null };
	}

	try {
		let outcome: RecordPendingDelegationOutcome = {
			status: 'failed',
			record: null,
		};
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				if (options.staleTimeoutMs && options.staleTimeoutMs > 0) {
					sweepStaleLocked(directory, options.staleTimeoutMs, now);
				}
				// A correlation identifies one durable launch. Check while holding the
				// ledger lock so concurrent pending writers cannot append a fresh
				// snapshot over an already-running or terminal delegation. The
				// for-write load refuses to proceed when the authoritative state
				// (checkpoint + tail) is uncertain (issue #2034).
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const existing = findRecordForWrite(
					records,
					parsedRecord.data.correlationId,
				);
				if (existing) {
					outcome = {
						status: samePendingLaunchIdentity(existing, parsedRecord.data)
							? 'duplicate'
							: 'conflict',
						record: existing,
					};
					return;
				}
				appendRecord(directory, parsedRecord.data);
				maybeCompactDelegationsLocked(directory);
				outcome = { status: 'recorded', record: parsedRecord.data };
			},
		);
		return outcome;
	} catch (err) {
		logger.warn(
			`[background] recordPendingDelegation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { status: 'failed', record: null };
	}
}

/**
 * Idempotent compatibility wrapper. A duplicate returns the authoritative
 * existing record so native Task replay does not create a fallback owner.
 */
export async function recordPendingDelegation(
	directory: string,
	input: RecordPendingInput,
	options: { staleTimeoutMs?: number } = {},
): Promise<BackgroundDelegationRecord | null> {
	const outcome = await recordPendingDelegationDetailed(
		directory,
		input,
		options,
	);
	return outcome.status === 'recorded' || outcome.status === 'duplicate'
		? outcome.record
		: null;
}

export function buildPromptSnapshot(
	text: string,
	maxChars: number,
): BackgroundPromptSnapshot {
	const boundedMax = Math.max(0, Math.min(maxChars, 20_000));
	const truncated = text.length > boundedMax;
	const bounded = truncated ? text.slice(0, boundedMax) : text;
	return {
		text: bounded,
		chars: text.length,
		truncated,
		digest: createHash('sha256').update(text).digest('hex'),
	};
}

export async function appendDelegationTransition(
	directory: string,
	correlationId: string,
	transition: {
		status: BackgroundDelegationStatus;
		result?: BackgroundDelegationResult;
		completedAt?: number;
		expectedCurrentStatuses?: readonly BackgroundDelegationStatus[];
	},
): Promise<BackgroundDelegationRecord | null> {
	const now = Date.now();
	try {
		let next: BackgroundDelegationRecord | null = null;
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (!current) return;
				if (
					transition.expectedCurrentStatuses &&
					!transition.expectedCurrentStatuses.includes(current.status)
				) {
					next = current;
					return;
				}
				if (
					isTerminal(current.status) &&
					transition.status !== 'consumed' &&
					transition.status !== 'ingestion_error' &&
					!(current.status === 'completed' && transition.status === 'stale')
				) {
					next = current;
					return;
				}
				next = {
					...current,
					schemaVersion: transition.result?.prReviewResultReceipt
						? 4
						: current.schemaVersion === 1
							? 2
							: current.schemaVersion,
					status: transition.status,
					updatedAt: now,
					...(transition.completedAt !== undefined
						? { completedAt: transition.completedAt }
						: transition.status === 'completed' || transition.status === 'error'
							? { completedAt: now }
							: {}),
					...(transition.result ? { result: transition.result } : {}),
				};
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
			},
		);
		return next;
	} catch (err) {
		logger.warn(
			`[background] appendDelegationTransition failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export type PublishPrReviewResultReceiptOutcome =
	| { status: 'recorded'; record: BackgroundDelegationRecord }
	| { status: 'duplicate'; record: BackgroundDelegationRecord }
	| { status: 'conflict'; reason: string }
	| { status: 'not_found'; reason: string }
	| { status: 'terminal'; reason: string }
	| { status: 'uncertain'; reason: string };

/**
 * Atomically publish the child-bound PR-review receipt while its delegation is
 * still live. The workflow gate performs the outer session-state validation;
 * this inner transaction rechecks immutable delegation identity under the
 * evidence lock and provides semantic exactly-once behavior.
 */
export async function publishPrReviewResultReceipt(
	directory: string,
	input: {
		parentSessionId: string;
		childSessionId: string;
		batchId: string;
		laneId: string;
		expectedWorkflowInstanceId: string;
		expectedWorkflowRevision: number;
		expectedBaseSha: string;
		receipt: PrReviewResultReceipt;
	},
): Promise<PublishPrReviewResultReceiptOutcome> {
	const parsed = PrReviewResultReceiptSchema.safeParse(input.receipt);
	if (!parsed.success) {
		return { status: 'conflict', reason: 'receipt schema validation failed' };
	}
	let outcome: PublishPrReviewResultReceiptOutcome = {
		status: 'uncertain',
		reason: 'receipt publication did not complete',
	};
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) {
					outcome = {
						status: 'uncertain',
						reason: 'delegation state is uncertain',
					};
					return;
				}
				const target = findReceiptPublicationTarget(records, input);
				if (target.count !== 1 || !target.record) {
					outcome = {
						status: 'not_found',
						reason: `expected one exact delegation record, found ${target.count}`,
					};
					return;
				}
				const current = target.record;
				if (current.result?.prReviewResultReceipt) {
					const existing = current.result.prReviewResultReceipt;
					if (samePrReviewReceiptSemantics(existing, parsed.data)) {
						outcome = { status: 'duplicate', record: current };
					} else {
						outcome = {
							status: 'conflict',
							reason: 'a different bound receipt is already recorded',
						};
					}
					return;
				}
				if (current.status !== 'pending' && current.status !== 'running') {
					outcome = {
						status: 'terminal',
						reason: `delegation is already ${current.status}`,
					};
					return;
				}
				const owned = current.ownedWorkflowLanes?.length
					? current.ownedWorkflowLanes
					: current.workflowLane
						? [current.workflowLane]
						: [];
				const sameOwned =
					owned.length === parsed.data.ownedWorkflowLanes.length &&
					owned.every((lane) => parsed.data.ownedWorkflowLanes.includes(lane));
				if (
					parsed.data.workflowInstanceId !== input.expectedWorkflowInstanceId ||
					parsed.data.workflowRevision !== input.expectedWorkflowRevision ||
					parsed.data.baseSha !== input.expectedBaseSha ||
					current.mode !== parsed.data.mode ||
					current.workflowLane !== parsed.data.workflowLane ||
					!sameOwned ||
					current.workspace?.prHeadSha !== parsed.data.headSha ||
					current.workspace?.gitHead !== parsed.data.headSha ||
					(current.generation ?? 1) !== parsed.data.generation
				) {
					outcome = {
						status: 'conflict',
						reason: 'receipt does not match immutable delegation identity',
					};
					return;
				}
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: 4,
					updatedAt: Date.now(),
					result: {
						...(current.result ?? {
							chars: 0,
							truncated: false,
							digest: createHash('sha256').update('').digest('hex'),
						}),
						prReviewResultReceipt: parsed.data,
					},
				};
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				outcome = { status: 'recorded', record: next };
			},
		);
		return outcome;
	} catch (error) {
		return {
			status: 'uncertain',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface BuildBackgroundCompletionEventIdInput {
	correlationId: string;
	jobId: string | null;
	status: BackgroundTerminalResult['status'];
	resultDigest: string;
}

/** Build the stable inbox/terminal identity without timestamps or process state. */
export function buildBackgroundCompletionEventId(
	input: BuildBackgroundCompletionEventIdInput,
): string {
	const canonical = JSON.stringify([
		input.correlationId,
		input.jobId,
		input.status,
		input.resultDigest,
	]);
	return `bgc1:${createHash('sha256').update(canonical).digest('hex')}`;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalJson).sort((left, right) => {
			const leftJson = JSON.stringify(left);
			const rightJson = JSON.stringify(right);
			return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
		});
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalJson(entry)]),
		);
	}
	return value;
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
	);
}

function samePrReviewReceiptSemantics(
	left: PrReviewResultReceipt,
	right: PrReviewResultReceipt,
): boolean {
	// The digest is derived from the serialized envelope, so a semantically
	// equivalent replay with set-like arrays in another order has a different
	// digest. Compare the validated receipt content without that derived field.
	const { semanticEnvelopeDigest: _leftDigest, ...leftSemantic } = left;
	const { semanticEnvelopeDigest: _rightDigest, ...rightSemantic } = right;
	return sameCanonicalJson(leftSemantic, rightSemantic);
}

/**
 * Terminal-event identity. `result.digest` is sha256 over the full text/error
 * body (see completion-observer's digest(text)), so comparing the digest plus
 * every non-body scalar is equivalent to the historical full-JSON compare —
 * closed-record summaries may drop the bodies but never the digest (issue #2034).
 */
function sameTerminalEvent(
	left: BackgroundTerminalResult,
	right: BackgroundTerminalResult,
): boolean {
	return (
		left.eventId === right.eventId &&
		left.status === right.status &&
		sameRetainedResult(left.result, right.result)
	);
}

function sameRetainedResult(
	left: BackgroundDelegationResult,
	right: BackgroundDelegationResult,
): boolean {
	return (
		left.chars === right.chars &&
		left.truncated === right.truncated &&
		left.digest === right.digest &&
		left.outputRef === right.outputRef &&
		left.outputPreviewChars === right.outputPreviewChars &&
		left.outputDegraded === right.outputDegraded &&
		left.outputArtifactError === right.outputArtifactError &&
		left.transcriptIncomplete === right.transcriptIncomplete &&
		left.messageCount === right.messageCount &&
		sameJson(left.prReviewResultReceipt, right.prReviewResultReceipt) &&
		left.workflowLaneFailureClass === right.workflowLaneFailureClass &&
		sameJson(left.salvagedWorkflowLanes, right.salvagedWorkflowLanes) &&
		sameJson(
			left.salvagedWorkflowLaneRecoveries,
			right.salvagedWorkflowLaneRecoveries,
		)
	);
}

function recordedPrReviewResultReceipt(
	record: BackgroundDelegationRecord,
): PrReviewResultReceipt | undefined {
	return (
		record.result?.prReviewResultReceipt ??
		record.terminalResult?.result.prReviewResultReceipt
	);
}

function mergeRecordedPrReviewResultReceipt(
	record: BackgroundDelegationRecord,
	result: BackgroundDelegationResult,
): BackgroundDelegationResult {
	const existing = recordedPrReviewResultReceipt(record);
	if (!existing || result.prReviewResultReceipt) return result;
	return { ...result, prReviewResultReceipt: existing };
}

function findReceiptPublicationTarget(
	records: readonly BackgroundDelegationRecord[],
	input: {
		parentSessionId: string;
		childSessionId: string;
		batchId: string;
		laneId: string;
	},
): { count: number; record: BackgroundDelegationRecord | null } {
	let count = 0;
	let record: BackgroundDelegationRecord | null = null;
	for (const candidate of records) {
		if (
			candidate.parentSessionId !== input.parentSessionId ||
			candidate.subagentSessionId !== input.childSessionId ||
			candidate.batchId !== input.batchId ||
			candidate.laneId !== input.laneId
		) {
			continue;
		}
		count += 1;
		if (count === 1) record = candidate;
	}
	return { count, record: count === 1 ? record : null };
}

function settlementProvenanceFor(
	record: BackgroundDelegationRecord,
): BackgroundCoderSettlementProvenance | null {
	const baseline = record.taskChangeContext?.baseline;
	if (!baseline) return null;
	return {
		correlationId: record.correlationId,
		parentSessionId: record.parentSessionId,
		callID: record.callID,
		planTaskId: record.planTaskId,
		baseline,
		worktree: record.worktree ?? null,
	};
}

function terminalDisposition(
	record: BackgroundDelegationRecord,
): TerminalClaimDisposition {
	if (record.status === 'consumed') return 'consumed';
	if (record.coderSettlement?.state === 'settling') return 'resume_settlement';
	if (record.coderSettlement?.state === 'preserved') return 'preserved';
	if (record.status === 'ingestion_error') return 'retry_ingestion';
	return 'duplicate';
}

export type TerminalClaimDisposition =
	| 'claimed'
	| 'resume_settlement'
	| 'retry_ingestion'
	| 'preserved'
	| 'consumed'
	| 'duplicate';

export interface TerminalClaim {
	disposition: TerminalClaimDisposition;
	record: BackgroundDelegationRecord;
}

/**
 * Establish an immutable trusted terminal event exactly once.
 *
 * A different event for an already-claimed correlation is rejected. Replays of the
 * same event receive an explicit resume/retry disposition from durable state.
 */
export async function claimTerminalResult(
	directory: string,
	correlationId: string,
	terminalResult: BackgroundTerminalResult,
): Promise<TerminalClaim | null> {
	const parsedTerminal = TerminalResultSchema.safeParse(terminalResult);
	if (!correlationId || !parsedTerminal.success) return null;
	let claim: TerminalClaim | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (!current) return;
				const normalizedResult = mergeRecordedPrReviewResultReceipt(
					current,
					parsedTerminal.data.result,
				);
				const normalizedTerminal =
					normalizedResult === parsedTerminal.data.result
						? parsedTerminal.data
						: { ...parsedTerminal.data, result: normalizedResult };
				if (current.terminalResult) {
					if (!sameTerminalEvent(current.terminalResult, normalizedTerminal)) {
						logger.warn(
							`[background] claimTerminalResult: different terminal event for ` +
								`correlationId=${correlationId}; ` +
								`existing={status: ${current.terminalResult.status}, eventId: ${current.terminalResult.eventId}} ` +
								`incoming={status: ${normalizedTerminal.status}, eventId: ${normalizedTerminal.eventId}}; ` +
								`rejected`,
						);
						incrementLateTerminalCount(directory);
						return;
					}
					claim = {
						disposition: terminalDisposition(current),
						record: current,
					};
					return;
				}
				if (current.status !== 'pending' && current.status !== 'running') {
					return;
				}

				let coderSettlement = current.coderSettlement;
				if (current.normalizedAgent === 'coder' && !coderSettlement) {
					const provenance = settlementProvenanceFor(current);
					if (provenance) {
						coderSettlement = {
							state: 'pending',
							provenance,
							observedFiles: null,
							updatedAt: normalizedTerminal.recordedAt,
						};
					}
				}
				// Monotonic fold baseline (#2034 review PRR-012): recordedAt is
				// caller-supplied and may be backdated; the fold's update-time
				// merge would then drop this terminal against a later checkpoint
				// entry. Clamp updatedAt to at least the current snapshot's.
				const foldUpdatedAt = Math.max(
					normalizedTerminal.recordedAt,
					current.updatedAt,
				);
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: normalizedTerminal.result.prReviewResultReceipt
						? 4
						: current.schemaVersion === 4
							? 4
							: 3,
					status: normalizedTerminal.status,
					terminalResult: normalizedTerminal,
					result: normalizedTerminal.result,
					completedAt: normalizedTerminal.recordedAt,
					updatedAt: foldUpdatedAt,
					...(coderSettlement ? { coderSettlement } : {}),
				};
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				claim = { disposition: 'claimed', record: next };
			},
		);
		return claim;
	} catch (err) {
		logger.warn(
			`[background] claimTerminalResult failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export interface ClaimCoderSettlementInput {
	sourceHeadAfterCommit?: string | null;
	targetHeadBeforeMerge?: string | null;
}

export interface CoderSettlementClaim {
	disposition: 'claimed' | 'resume' | 'settled' | 'preserved';
	record: BackgroundDelegationRecord;
}

/**
 * Record a late/duplicate terminal observation in the durable health artifact.
 * Best-effort: the observation sink must never break the claim path.
 */
function incrementLateTerminalCount(directory: string): void {
	try {
		const artifact = readDelegationHealthArtifact(directory);
		const current = artifact?.counts.lateTerminals ?? 0;
		writeDelegationHealthArtifact(directory, {
			counts: {
				activeOwners: artifact?.counts.activeOwners ?? 0,
				pendingAdvisories: artifact?.counts.pendingAdvisories ?? 0,
				lateTerminals: current + 1,
				orphanWorktreeOwners: artifact?.counts.orphanWorktreeOwners ?? 0,
			},
		});
	} catch {
		// ignore — observation only
	}
}

/**
 * Claim coder settlement under the ledger lock. A `settling` operation may resume only
 * with its original operationId; completed or preserved outcomes are returned unchanged.
 */
export async function claimCoderSettlement(
	directory: string,
	correlationId: string,
	operationId: string,
	input: ClaimCoderSettlementInput = {},
): Promise<CoderSettlementClaim | null> {
	if (!correlationId || !operationId || operationId.length > 256) return null;
	let claim: CoderSettlementClaim | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (
					!current ||
					current.normalizedAgent !== 'coder' ||
					current.terminalResult?.status !== 'completed'
				) {
					return;
				}
				const provenance = settlementProvenanceFor(current);
				if (!provenance) return;
				const existing = current.coderSettlement ?? {
					state: 'pending' as const,
					provenance,
					observedFiles: null,
					updatedAt: current.updatedAt,
				};
				if (existing.state === 'settled' || existing.state === 'preserved') {
					claim = {
						disposition: existing.state,
						record: current,
					};
					return;
				}
				if (
					existing.state === 'settling' &&
					existing.operationId !== operationId
				) {
					return;
				}
				if (
					existing.sourceHeadAfterCommit !== undefined &&
					input.sourceHeadAfterCommit !== undefined &&
					existing.sourceHeadAfterCommit !== input.sourceHeadAfterCommit
				) {
					return;
				}
				if (
					existing.targetHeadBeforeMerge !== undefined &&
					input.targetHeadBeforeMerge !== undefined &&
					existing.targetHeadBeforeMerge !== input.targetHeadBeforeMerge
				) {
					return;
				}

				const settlement: BackgroundCoderSettlement = {
					...existing,
					state: 'settling',
					operationId,
					...(input.sourceHeadAfterCommit !== undefined
						? { sourceHeadAfterCommit: input.sourceHeadAfterCommit }
						: {}),
					...(input.targetHeadBeforeMerge !== undefined
						? { targetHeadBeforeMerge: input.targetHeadBeforeMerge }
						: {}),
					updatedAt: Date.now(),
				};
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: current.schemaVersion === 4 ? 4 : 3,
					coderSettlement: settlement,
					updatedAt: settlement.updatedAt,
				};
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				claim = {
					disposition: existing.state === 'settling' ? 'resume' : 'claimed',
					record: next,
				};
			},
		);
		return claim;
	} catch (err) {
		logger.warn(
			`[background] claimCoderSettlement failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

function normalizeObservedFile(value: string): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().replace(/\\/g, '/');
	if (
		trimmed.length === 0 ||
		trimmed.length > 4_096 ||
		trimmed.includes('\0') ||
		path.posix.isAbsolute(trimmed) ||
		/^[A-Za-z]:\//.test(trimmed)
	) {
		return null;
	}
	const normalized = path.posix.normalize(trimmed).replace(/^\.\//, '');
	if (
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../') ||
		normalized.endsWith('/')
	) {
		return null;
	}
	return normalized;
}

export function normalizeBackgroundObservedFiles(
	files: readonly string[],
): string[] | null {
	if (!Array.isArray(files) || files.length > MAX_BACKGROUND_OBSERVED_FILES) {
		return null;
	}
	const normalized = new Set<string>();
	for (const file of files) {
		const candidate = normalizeObservedFile(file);
		if (!candidate) return null;
		normalized.add(candidate);
	}
	return [...normalized].sort();
}

export interface UpdateCoderSettlementInput {
	operationId: string;
	state: 'settling' | 'settled' | 'preserved';
	sourceHeadAfterCommit?: string | null;
	targetHeadBeforeMerge?: string | null;
	observedFiles?: string[] | null;
	outcome?: BackgroundCoderSettlementOutcome;
}

/**
 * Persist settlement progress or its terminal outcome. Once settled/preserved, every
 * replay returns the original snapshot and ignores recomputation attempts.
 */
export async function updateCoderSettlement(
	directory: string,
	correlationId: string,
	input: UpdateCoderSettlementInput,
): Promise<BackgroundDelegationRecord | null> {
	if (!correlationId || !input.operationId) return null;
	let result: BackgroundDelegationRecord | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				const existing = current?.coderSettlement;
				if (!current || !existing) return;
				if (existing.state === 'settled' || existing.state === 'preserved') {
					result = current;
					return;
				}
				if (
					existing.state !== 'settling' ||
					existing.operationId !== input.operationId
				) {
					return;
				}
				if (
					existing.sourceHeadAfterCommit !== undefined &&
					input.sourceHeadAfterCommit !== undefined &&
					existing.sourceHeadAfterCommit !== input.sourceHeadAfterCommit
				) {
					return;
				}
				if (
					existing.targetHeadBeforeMerge !== undefined &&
					input.targetHeadBeforeMerge !== undefined &&
					existing.targetHeadBeforeMerge !== input.targetHeadBeforeMerge
				) {
					return;
				}
				if (
					(input.state === 'settled' || input.state === 'preserved') &&
					!input.outcome
				) {
					return;
				}
				if (
					input.outcome &&
					((existing.provenance.worktree &&
						input.outcome.kind !== 'standard-worktree') ||
						(!existing.provenance.worktree &&
							input.outcome.kind !== 'shared-root'))
				) {
					return;
				}
				if (
					input.state === 'settled' &&
					input.outcome &&
					(input.outcome.result === 'partial' ||
						input.outcome.result === 'failed')
				) {
					return;
				}
				if (
					input.state === 'preserved' &&
					input.outcome &&
					input.outcome.result !== 'partial' &&
					input.outcome.result !== 'failed'
				) {
					return;
				}
				let observedFiles = existing.observedFiles;
				if (input.observedFiles !== undefined) {
					if (input.observedFiles === null) {
						observedFiles = null;
					} else {
						const normalized = normalizeBackgroundObservedFiles(
							input.observedFiles,
						);
						if (!normalized) return;
						observedFiles = normalized;
					}
				}
				if (input.state === 'settled' && observedFiles === null) return;

				const updatedAt = Date.now();
				const settlement: BackgroundCoderSettlement = {
					...existing,
					state: input.state,
					...(input.sourceHeadAfterCommit !== undefined
						? { sourceHeadAfterCommit: input.sourceHeadAfterCommit }
						: {}),
					...(input.targetHeadBeforeMerge !== undefined
						? { targetHeadBeforeMerge: input.targetHeadBeforeMerge }
						: {}),
					observedFiles,
					...(input.outcome ? { outcome: input.outcome } : {}),
					updatedAt,
				};
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: current.schemaVersion === 4 ? 4 : 3,
					coderSettlement: settlement,
					updatedAt,
				};
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				result = next;
			},
		);
		return result;
	} catch (err) {
		logger.warn(
			`[background] updateCoderSettlement failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export interface LegacyCoderSettlementTransfer {
	taskId: string;
	transitionId: string;
}

export type LegacyCoderSettlementReconciler = (
	record: BackgroundDelegationRecord,
) => Promise<boolean>;

export interface ReplacePendingBackgroundAdvisoryResult {
	advisory: BackgroundAdvisoryInboxEntry;
	replacedMessage?: string;
}

const MAX_LEGACY_CODER_SETTLEMENT_RECONCILERS = 32;
const RETRYABLE_LEGACY_SETTLEMENT_ERROR_CODES = new Set([
	'CODER_SETTLEMENT_LOCKED',
	'EACCES',
	'EBUSY',
	'EIO',
	'EPERM',
	'ETIMEDOUT',
]);
const legacyCoderSettlementReconcilers = new Map<
	string,
	LegacyCoderSettlementReconciler
>();
const legacyCoderSettlementReconcilerOrder: string[] = [];

/**
 * Register the observer-owned replay callback for a project. Maintenance is
 * also invoked by admission and status paths that cannot receive the observer
 * instance directly, so this directory-keyed, bounded registry keeps those
 * backstops wired without retaining unbounded process state.
 */
export function registerLegacyCoderSettlementReconciler(
	directory: string,
	reconciler: LegacyCoderSettlementReconciler,
): void {
	const key = canonicalRootKeyFresh(directory);
	if (legacyCoderSettlementReconcilers.has(key)) {
		const existingIndex = legacyCoderSettlementReconcilerOrder.indexOf(key);
		if (existingIndex >= 0) {
			legacyCoderSettlementReconcilerOrder.splice(existingIndex, 1);
		}
		legacyCoderSettlementReconcilerOrder.push(key);
		legacyCoderSettlementReconcilers.set(key, reconciler);
		return;
	}
	if (
		legacyCoderSettlementReconcilerOrder.length >=
		MAX_LEGACY_CODER_SETTLEMENT_RECONCILERS
	) {
		const evicted = legacyCoderSettlementReconcilerOrder.shift();
		if (evicted) legacyCoderSettlementReconcilers.delete(evicted);
	}
	legacyCoderSettlementReconcilerOrder.push(key);
	legacyCoderSettlementReconcilers.set(key, reconciler);
}

function getLegacyCoderSettlementReconciler(
	directory: string,
): LegacyCoderSettlementReconciler | undefined {
	return legacyCoderSettlementReconcilers.get(canonicalRootKeyFresh(directory));
}

/** Test-only seam for the bounded legacy-settlement reconciler registry. */
export const _internals = {
	getLegacyCoderSettlementReconciler,
	getLegacyCoderSettlementReconcilerOrder: () => [
		...legacyCoderSettlementReconcilerOrder,
	],
	resetLegacyCoderSettlementReconcilers: () => {
		legacyCoderSettlementReconcilers.clear();
		legacyCoderSettlementReconcilerOrder.length = 0;
	},
};

/** Record an exact legacy-WAL transfer that must be retried after contention. */
export async function markLegacyCoderSettlementTransferPending(
	directory: string,
	correlationId: string,
	transfer: LegacyCoderSettlementTransfer,
): Promise<BackgroundDelegationRecord | null> {
	return updateLegacyCoderSettlementTransfer(
		directory,
		correlationId,
		transfer,
	);
}

/** Clear a transfer marker only after the WAL is terminal and any replay succeeds. */
export async function clearLegacyCoderSettlementTransferPending(
	directory: string,
	correlationId: string,
): Promise<BackgroundDelegationRecord | null> {
	return updateLegacyCoderSettlementTransfer(directory, correlationId, null);
}

async function updateLegacyCoderSettlementTransfer(
	directory: string,
	correlationId: string,
	transfer: LegacyCoderSettlementTransfer | null,
): Promise<BackgroundDelegationRecord | null> {
	if (!correlationId) return null;
	let result: BackgroundDelegationRecord | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (!current) return;
				if (
					transfer &&
					(current.status === 'consumed' ||
						(current.legacyCoderSettlementTransfer &&
							(current.legacyCoderSettlementTransfer.taskId !==
								transfer.taskId ||
								current.legacyCoderSettlementTransfer.transitionId !==
									transfer.transitionId)))
				) {
					// A racing observer may already have consumed the terminal, or may
					// own a different exact transfer identity. Never resurrect/overwrite
					// that durable decision from a late failure report.
					result = current;
					return;
				}
				const updatedAt = Date.now();
				const next: BackgroundDelegationRecord = transfer
					? {
							...current,
							schemaVersion: current.schemaVersion === 4 ? 4 : 3,
							legacyCoderSettlementTransfer: {
								...transfer,
								updatedAt,
							},
							updatedAt,
						}
					: (() => {
							const { legacyCoderSettlementTransfer: _pending, ...rest } =
								current;
							return {
								...rest,
								schemaVersion: 3 as const,
								updatedAt,
							};
						})();
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				result = next;
			},
		);
	} catch (error) {
		logger.warn(
			`[background] legacy coder settlement transfer marker update failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return result;
}

export type DelegationIngestionDisposition =
	| 'claimed'
	| 'retry'
	| 'busy'
	| 'not_ready'
	| 'preserved'
	| 'consumed';

export interface DelegationIngestionClaim {
	disposition: DelegationIngestionDisposition;
	record: BackgroundDelegationRecord;
}

export interface ClaimDelegationIngestionOptions {
	claimantId: string;
	now?: number;
	leaseMs?: number;
}

/**
 * Lease-backed CAS claim for ingestion.
 *
 * An interrupted claimant cannot strand the record permanently: after the
 * bounded lease expires, a replay may reclaim and retry the immutable settled
 * input. A still-live claim remains busy and must never be reported as success.
 */
export async function claimDelegationIngestion(
	directory: string,
	correlationId: string,
	options: ClaimDelegationIngestionOptions,
): Promise<DelegationIngestionClaim | null> {
	if (!correlationId || !options.claimantId) return null;
	const now = options.now ?? Date.now();
	const leaseMs = Math.max(
		1_000,
		Math.min(options.leaseMs ?? INGESTION_CLAIM_LEASE_MS, 5 * 60_000),
	);
	let claim: DelegationIngestionClaim | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (!current?.terminalResult) return;
				if (current.status === 'consumed') {
					claim = { disposition: 'consumed', record: current };
					return;
				}
				if (
					current.ingestion?.state === 'claimed' &&
					(current.ingestion.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER) > now
				) {
					claim = { disposition: 'busy', record: current };
					return;
				}
				if (current.coderSettlement?.state === 'preserved') {
					claim = { disposition: 'preserved', record: current };
					return;
				}
				if (
					current.terminalResult.status !== 'completed' ||
					(current.normalizedAgent === 'coder' &&
						current.coderSettlement?.state !== 'settled')
				) {
					claim = { disposition: 'not_ready', record: current };
					return;
				}
				if (
					current.status !== 'completed' &&
					current.status !== 'ingestion_error'
				) {
					claim = { disposition: 'not_ready', record: current };
					return;
				}
				const disposition =
					current.status === 'ingestion_error' ||
					current.ingestion?.state === 'claimed'
						? 'retry'
						: 'claimed';
				const attempt = (current.ingestion?.attempt ?? 0) + 1;
				const claimToken = createHash('sha256')
					.update(
						JSON.stringify([correlationId, options.claimantId, attempt, now]),
					)
					.digest('hex');
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: current.schemaVersion === 4 ? 4 : 3,
					ingestion: {
						state: 'claimed',
						attempt,
						updatedAt: now,
						claimToken,
						leaseExpiresAt: now + leaseMs,
					},
					updatedAt: now,
				};
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				claim = { disposition, record: next };
			},
		);
		return claim;
	} catch (err) {
		logger.warn(
			`[background] claimDelegationIngestion failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/** Commit an ingestion claim to consumed or retryable ingestion_error. */
export async function recordDelegationIngestionResult(
	directory: string,
	correlationId: string,
	claimToken: string,
	success: boolean,
	options: { now?: number } = {},
): Promise<BackgroundDelegationRecord | null> {
	if (!correlationId || !claimToken) return null;
	let result: BackgroundDelegationRecord | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (!current) return;
				if (
					(success &&
						current.status === 'consumed' &&
						current.ingestion?.state === 'consumed' &&
						current.ingestion.claimToken === claimToken) ||
					(!success &&
						current.status === 'ingestion_error' &&
						current.ingestion?.state === 'retryable' &&
						current.ingestion.claimToken === claimToken)
				) {
					result = current;
					return;
				}
				if (
					current.ingestion?.state !== 'claimed' ||
					current.ingestion.claimToken !== claimToken ||
					(current.ingestion.leaseExpiresAt ?? 0) <= (options.now ?? Date.now())
				)
					return;
				const updatedAt = options.now ?? Date.now();
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: current.schemaVersion === 4 ? 4 : 3,
					status: success ? 'consumed' : 'ingestion_error',
					ingestion: {
						state: success ? 'consumed' : 'retryable',
						attempt: current.ingestion.attempt,
						claimToken,
						updatedAt,
					},
					updatedAt,
				};
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				result = next;
			},
		);
		return result;
	} catch (err) {
		logger.warn(
			`[background] recordDelegationIngestionResult failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export interface PutPendingBackgroundAdvisoryInput {
	eventId: string;
	parentSessionId: string;
	message: string;
	createdAt?: number;
}

/** Establish one immutable durable advisory for the terminal event. */
export async function putPendingBackgroundAdvisory(
	directory: string,
	correlationId: string,
	input: PutPendingBackgroundAdvisoryInput,
): Promise<BackgroundAdvisoryInboxEntry | null> {
	const createdAt = input.createdAt ?? Date.now();
	const parsed = AdvisoryInboxSchema.safeParse({
		eventId: input.eventId,
		parentSessionId: input.parentSessionId,
		state: 'pending',
		message: input.message,
		createdAt,
	});
	if (!correlationId || !parsed.success) return null;
	let result: BackgroundAdvisoryInboxEntry | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				if (
					!current?.terminalResult ||
					current.terminalResult.eventId !== parsed.data.eventId ||
					current.parentSessionId !== parsed.data.parentSessionId
				) {
					return;
				}
				if (current.advisoryInbox) {
					if (
						current.advisoryInbox.eventId === parsed.data.eventId &&
						current.advisoryInbox.parentSessionId ===
							parsed.data.parentSessionId &&
						current.advisoryInbox.message === parsed.data.message
					) {
						result = current.advisoryInbox;
					}
					return;
				}
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: current.schemaVersion === 4 ? 4 : 3,
					advisoryInbox: parsed.data,
					updatedAt: createdAt,
				};
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				result = parsed.data;
			},
		);
		return result;
	} catch (err) {
		logger.warn(
			`[background] putPendingBackgroundAdvisory failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/**
 * Replace a pending transfer-warning advisory with the corrected terminal
 * status after durable legacy-WAL reconciliation. The replacement is narrowly
 * gated by the exact terminal identity and the warning marker so the ordinary
 * one-advisory-per-event immutability contract remains intact.
 */
export async function replacePendingBackgroundAdvisory(
	directory: string,
	correlationId: string,
	input: PutPendingBackgroundAdvisoryInput,
): Promise<ReplacePendingBackgroundAdvisoryResult | null> {
	const createdAt = input.createdAt ?? Date.now();
	const parsed = AdvisoryInboxSchema.safeParse({
		eventId: input.eventId,
		parentSessionId: input.parentSessionId,
		state: 'pending',
		message: input.message,
		createdAt,
	});
	if (!correlationId || !parsed.success) return null;
	let result: ReplacePendingBackgroundAdvisoryResult | null = null;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const current = findRecordForWrite(records, correlationId);
				const existing = current?.advisoryInbox;
				if (
					!current?.terminalResult ||
					current.terminalResult.eventId !== parsed.data.eventId ||
					current.parentSessionId !== parsed.data.parentSessionId ||
					!existing ||
					!existing.message.includes(
						LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER,
					) ||
					parsed.data.message.includes(
						LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER,
					)
				) {
					if (
						existing &&
						existing.eventId === parsed.data.eventId &&
						existing.parentSessionId === parsed.data.parentSessionId &&
						existing.message === parsed.data.message
					) {
						result = { advisory: existing };
					}
					return;
				}
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: current.schemaVersion === 4 ? 4 : 3,
					advisoryInbox: parsed.data,
					updatedAt: createdAt,
				};
				appendRecord(directory, next);
				maybeCompactDelegationsLocked(directory);
				result = {
					advisory: parsed.data,
					replacedMessage: existing.message,
				};
			},
		);
		return result;
	} catch (err) {
		logger.warn(
			`[background] replacePendingBackgroundAdvisory failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export interface PreparePendingBackgroundAdvisoriesOptions {
	preparationId: string;
	now?: number;
	leaseMs?: number;
}

/**
 * Lease pending entries for one synchronous message transform. Expired leases are
 * reclaimable after restart; delivery is committed only when a later host
 * transform reflects the injected text back as conversation history.
 */
export async function preparePendingBackgroundAdvisories(
	directory: string,
	parentSessionId: string,
	options: PreparePendingBackgroundAdvisoriesOptions,
): Promise<BackgroundAdvisoryInboxEntry[]> {
	if (!parentSessionId || !options.preparationId) return [];
	const now = options.now ?? Date.now();
	const leaseMs = Math.max(
		1_000,
		Math.min(options.leaseMs ?? ADVISORY_PREPARE_LEASE_MS, 5 * 60_000),
	);
	const prepared: BackgroundAdvisoryInboxEntry[] = [];
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				for (const current of records) {
					// One entry per transaction keeps acknowledgement atomic in the
					// append-only ledger; subsequent turns drain subsequent entries.
					if (prepared.length >= 1) break;
					const advisory = current.advisoryInbox;
					if (
						!advisory ||
						advisory.parentSessionId !== parentSessionId ||
						advisory.state !== 'pending'
					) {
						continue;
					}
					if (
						advisory.preparation &&
						advisory.preparation.id !== options.preparationId &&
						advisory.preparation.leaseExpiresAt > now
					) {
						continue;
					}
					const nextAdvisory: BackgroundAdvisoryInboxEntry = {
						...advisory,
						preparation: {
							id: options.preparationId,
							preparedAt: now,
							leaseExpiresAt: now + leaseMs,
						},
					};
					const next: BackgroundDelegationRecord = {
						...current,
						schemaVersion: current.schemaVersion === 4 ? 4 : 3,
						advisoryInbox: nextAdvisory,
						updatedAt: now,
					};
					appendRecord(directory, next);
					maybeCompactDelegationsLocked(directory);
					prepared.push(nextAdvisory);
				}
			},
		);
		return prepared;
	} catch (err) {
		logger.warn(
			`[background] preparePendingBackgroundAdvisories failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}

async function releaseBackgroundAdvisoryPreparation(
	directory: string,
	parentSessionId: string,
	preparationId: string,
	eventIds: readonly string[],
): Promise<boolean> {
	const uniqueEventIds = [...new Set(eventIds)];
	if (!parentSessionId || !preparationId || uniqueEventIds.length !== 1) {
		return false;
	}
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return false;
				const byEvent = new Map<string, BackgroundDelegationRecord>();
				for (const current of records) {
					const advisory = current.advisoryInbox;
					if (
						advisory?.parentSessionId === parentSessionId &&
						uniqueEventIds.includes(advisory.eventId)
					) {
						byEvent.set(advisory.eventId, current);
					}
				}
				for (const eventId of uniqueEventIds) {
					const advisory = byEvent.get(eventId)?.advisoryInbox;
					if (
						!advisory ||
						advisory.state !== 'pending' ||
						advisory.preparation?.id !== preparationId
					) {
						return false;
					}
				}
				for (const eventId of uniqueEventIds) {
					const current = byEvent.get(eventId);
					if (!current?.advisoryInbox) return false;
					const now = Date.now();
					const next: BackgroundDelegationRecord = {
						...current,
						schemaVersion: current.schemaVersion === 4 ? 4 : 3,
						advisoryInbox: {
							...current.advisoryInbox,
							preparation: undefined,
						},
						updatedAt: now,
					};
					appendRecord(directory, next);
				}
				maybeCompactDelegationsLocked(directory);
				return true;
			},
		);
	} catch (err) {
		logger.warn(
			`[background] releasePreparedBackgroundAdvisories failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

/**
 * Commit delivery only after a later host transform reflects the exact advisory
 * text back in conversation history. This is the first boundary at which the
 * plugin can prove that a prior transform result escaped the process.
 */
export async function acknowledgeObservedBackgroundAdvisories(
	directory: string,
	parentSessionId: string,
	observedTexts: readonly string[],
): Promise<number> {
	if (!parentSessionId || observedTexts.length === 0) return 0;
	let acknowledged = 0;
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const records = loadRecordsForWrite(directory);
				if (records === null) return;
				const now = Date.now();
				for (const current of records) {
					const advisory = current.advisoryInbox;
					if (
						!advisory ||
						advisory.parentSessionId !== parentSessionId ||
						advisory.state !== 'pending' ||
						!observedTexts.some((text) => {
							// Prefer exact advisory-block parsing when the host
							// transform wraps advisories in [ADVISORIES] tags.
							const advisoryBlock = text.match(
								/\[ADVISORIES\]([\s\S]*?)\[\/ADVISORIES\]/,
							);
							if (advisoryBlock) {
								return advisoryBlock[1]
									.split('\n---\n')
									.some((entry) => entry.trim() === advisory.message);
							}
							// Fall back to substring match for host-reflected text
							// that embeds the advisory message naturally (e.g.
							// "host history: <message>"). Advisory messages are
							// full sentences, so false-positive collision risk is low.
							return text.includes(advisory.message);
						})
					) {
						continue;
					}
					const next: BackgroundDelegationRecord = {
						...current,
						schemaVersion: current.schemaVersion === 4 ? 4 : 3,
						advisoryInbox: {
							...advisory,
							state: 'delivered',
							deliveredAt: now,
							preparation: undefined,
						},
						updatedAt: now,
					};
					appendRecord(directory, next);
					acknowledged += 1;
				}
				if (acknowledged > 0) maybeCompactDelegationsLocked(directory);
			},
		);
		return acknowledged;
	} catch (err) {
		logger.warn(
			`[background] acknowledgeObservedBackgroundAdvisories failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 0;
	}
}

export async function releasePreparedBackgroundAdvisories(
	directory: string,
	parentSessionId: string,
	preparationId: string,
	eventIds: readonly string[],
): Promise<boolean> {
	return releaseBackgroundAdvisoryPreparation(
		directory,
		parentSessionId,
		preparationId,
		eventIds,
	);
}

export function findByBatchId(
	directory: string,
	batchId: string,
	opts?: { parentSessionId?: string },
): BackgroundDelegationRecord[] {
	if (!batchId) return [];
	return readDelegations(directory).filter(
		(record) =>
			record.batchId === batchId &&
			(opts?.parentSessionId === undefined ||
				record.parentSessionId === opts.parentSessionId),
	);
}

export function findOpenAsyncLaneBatches(
	directory: string,
): BackgroundDelegationRecord[] {
	return readDelegations(directory).filter(
		(record) =>
			record.batchId !== undefined &&
			(record.status === 'pending' || record.status === 'running'),
	);
}

function isTerminal(status: BackgroundDelegationStatus): boolean {
	return (
		status === 'completed' ||
		status === 'error' ||
		status === 'cancelled' ||
		status === 'stale' ||
		status === 'consumed'
	);
}

/**
 * Public alias of the internal terminal predicate so shared lifecycle callers
 * (issue #2045: `delegation-lifecycle.ts`) classify post-claim re-reads with
 * the exact same status set as the store's own guards — never a second copy.
 */
export function isTerminalDelegationStatus(
	status: BackgroundDelegationStatus,
): boolean {
	return isTerminal(status);
}

/**
 * Mark all overdue records in `statuses` as `stale` (status-only; no gate
 * effect). Called within an already-held store lock.
 *
 * `statuses` defaults to {@link DEFAULT_SWEEPABLE_DELEGATION_STATUSES}, which is
 * exactly the set this sweep has always finalized — the trailing default keeps
 * the pre-existing positional call in `recordPendingDelegation` unchanged.
 *
 * `filters.excludeCorrelationIds` (issue #2251) removes specific records from an
 * otherwise directory-wide sweep. A caller that has already DECIDED a record is
 * not stale — e.g. the PR-workflow gate's liveness probe reported its session
 * still running — must be able to keep this age-only sweep from durably
 * contradicting that decision one line later. Omitting it is the historical
 * behaviour.
 *
 * `filters.includeCorrelationIds` (issue #2251) is its opposite: it narrows the
 * sweep to exactly the named records, so a caller that reasoned about a specific
 * handful of lanes can finalize those and NOTHING else. Both filters compose;
 * the status and age filters still apply on top of either, which is the point —
 * an included record that has since gone `completed` is still spared.
 */
function sweepStaleLocked(
	directory: string,
	timeoutMs: number,
	now: number,
	statuses: ReadonlySet<BackgroundDelegationStatus> = DEFAULT_SWEEPABLE_DELEGATION_STATUSES,
	filters: {
		excludeCorrelationIds?: ReadonlySet<string>;
		includeCorrelationIds?: ReadonlySet<string>;
	} = {},
	limits: { maxSweep?: number } = {},
): number {
	let swept = 0;
	const { excludeCorrelationIds, includeCorrelationIds } = filters;
	const records = loadRecordsForWrite(directory);
	if (records === null) return 0;
	for (const record of records) {
		if (limits.maxSweep !== undefined && swept >= limits.maxSweep) break;
		if (
			includeCorrelationIds !== undefined &&
			!includeCorrelationIds.has(record.correlationId)
		) {
			continue;
		}
		if (excludeCorrelationIds?.has(record.correlationId)) continue;
		if (!statuses.has(record.status)) continue;
		if (now - record.updatedAt <= timeoutMs) continue;
		appendRecord(directory, {
			...record,
			status: 'stale',
			updatedAt: now,
		});
		swept += 1;
	}
	if (swept > 0) maybeCompactDelegationsLocked(directory);
	return swept;
}

/**
 * Public stale sweep: acquires the store lock and marks overdue pendings as `stale`.
 * Best-effort; returns the number swept (0 on lock timeout / error).
 *
 * `options.statuses` narrows which status classes may be finalized; omitting it
 * preserves the historical scope ({@link DEFAULT_SWEEPABLE_DELEGATION_STATUSES}).
 * The sweep is directory-wide with no session or mode filter, so a caller whose
 * own decision covers only some status classes must narrow accordingly rather
 * than finalizing records it never reasoned about.
 *
 * `options.excludeCorrelationIds` (issue #2251) is the per-record counterpart:
 * status narrowing cannot express "this specific overdue record was verified
 * alive". Both filters are AND-ed — an excluded record is spared regardless of
 * status or age.
 *
 * `options.includeCorrelationIds` (issue #2251) inverts that: the sweep visits
 * ONLY the named records. It exists so a caller that decided something about a
 * specific, already-identified handful of lanes can finalize exactly those
 * without a directory-wide pass that would also finalize other sessions' records
 * and retryable `ingestion_error` records it never reasoned about. Passing an
 * empty set sweeps nothing.
 *
 * Narrowing to a record does NOT force it terminal: the status and age filters
 * still apply, so a named record that has since reached a terminal status (a
 * lane that completed between the caller's decision and this call) is spared and
 * its collected output survives. That is deliberate — an unconditional write
 * here would re-introduce the very discard this subsystem exists to prevent.
 */
export async function sweepStaleDelegations(
	directory: string,
	timeoutMs: number,
	options: {
		statuses?: ReadonlySet<SweepableDelegationStatus>;
		excludeCorrelationIds?: ReadonlySet<string>;
		includeCorrelationIds?: ReadonlySet<string>;
	} = {},
): Promise<number> {
	if (!timeoutMs || timeoutMs <= 0) return 0;
	const statuses = options.statuses ?? DEFAULT_SWEEPABLE_DELEGATION_STATUSES;
	const filters = {
		excludeCorrelationIds: options.excludeCorrelationIds,
		includeCorrelationIds: options.includeCorrelationIds,
	};
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () =>
				sweepStaleLocked(directory, timeoutMs, Date.now(), statuses, filters),
		);
	} catch (err) {
		logger.warn(
			`[background] sweepStaleDelegations failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 0;
	}
}

export interface BackgroundDelegationFallbackArtifact {
	schemaVersion: 1;
	correlationId: string;
	createdAt: number;
	record: BackgroundDelegationRecord;
}

function fallbackRelativePath(correlationId: string): string {
	const digest = createHash('sha256').update(correlationId).digest('hex');
	return path.join(BACKGROUND_DELEGATION_FALLBACK_DIR, `${digest}.json`);
}

function fallbackPath(directory: string, correlationId: string): string {
	return validateSwarmPath(directory, fallbackRelativePath(correlationId));
}

function fallbackDirectoryPath(directory: string): string {
	return path.dirname(
		validateSwarmPath(
			directory,
			path.join(BACKGROUND_DELEGATION_FALLBACK_DIR, '.containment-anchor'),
		),
	);
}

async function readFallbackFile(
	directory: string,
	correlationId: string,
): Promise<BackgroundDelegationFallbackArtifact | null> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const raw = await fs.promises.readFile(
				fallbackPath(directory, correlationId),
				'utf-8',
			);
			const parsedJson: unknown = JSON.parse(raw);
			const parsed = FallbackArtifactSchema.safeParse(parsedJson);
			if (!parsed.success || parsed.data.correlationId !== correlationId) {
				return null;
			}
			return parsed.data;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' && attempt < 4) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				continue;
			}
			return null;
		}
	}
	return null;
}

/** Read one exact fallback artifact with bounded post-rename visibility retries. */
export async function readDelegationFallback(
	directory: string,
	correlationId: string,
): Promise<BackgroundDelegationFallbackArtifact | null> {
	if (!correlationId) return null;
	return readFallbackFile(directory, correlationId);
}

/**
 * Enumerate valid live fallback owners for startup orphan recovery. Malformed files are
 * ignored as data but still count toward the fail-closed capacity bound.
 */
export async function listDelegationFallbacks(
	directory: string,
): Promise<BackgroundDelegationFallbackArtifact[]> {
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(fallbackDirectoryPath(directory), {
				withFileTypes: true,
			})
			.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
			.slice(0, MAX_LIVE_BACKGROUND_FALLBACKS);
	} catch {
		return [];
	}
	const artifacts: BackgroundDelegationFallbackArtifact[] = [];
	for (const entry of entries) {
		try {
			const raw = await fs.promises.readFile(
				path.join(fallbackDirectoryPath(directory), entry.name),
				'utf-8',
			);
			const parsed = FallbackArtifactSchema.safeParse(JSON.parse(raw));
			if (parsed.success) artifacts.push(parsed.data);
		} catch {
			// Invalid/unreadable fallback cannot confer ownership.
		}
	}
	return artifacts;
}

/**
 * Strict startup-recovery view of fallback owners. Every candidate must be
 * readable and schema-valid, and overflow is uncertainty rather than
 * truncation, because omitted ownership could make cleanup destructive.
 */
export async function scanDelegationFallbacksForRecovery(
	directory: string,
): Promise<RecoveryOwnershipScanResult<BackgroundDelegationFallbackArtifact>> {
	let fallbackDir: string;
	let entries: fs.Dirent[];
	try {
		fallbackDir = fallbackDirectoryPath(directory);
		entries = fs
			.readdirSync(fallbackDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'ok', owners: [] };
		}
		return {
			status: 'uncertain',
			reason: `background fallback directory is unreadable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (entries.length > MAX_LIVE_BACKGROUND_FALLBACKS) {
		return {
			status: 'uncertain',
			reason: `background fallback owner count exceeds the ${MAX_LIVE_BACKGROUND_FALLBACKS}-artifact safety bound`,
		};
	}

	const artifacts: BackgroundDelegationFallbackArtifact[] = [];
	for (const entry of entries) {
		const artifactPath = path.join(fallbackDir, entry.name);
		let raw: string;
		try {
			const stat = fs.statSync(artifactPath);
			if (stat.size > MAX_RECOVERY_FALLBACK_BYTES) {
				return {
					status: 'uncertain',
					reason: `background fallback artifact "${entry.name}" exceeds the recovery size bound`,
				};
			}
			raw = await fs.promises.readFile(artifactPath, 'utf-8');
		} catch (error) {
			return {
				status: 'uncertain',
				reason: `background fallback artifact "${entry.name}" is unreadable: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
		if (Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_FALLBACK_BYTES) {
			return {
				status: 'uncertain',
				reason: `background fallback artifact "${entry.name}" changed beyond the recovery size bound`,
			};
		}
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw);
		} catch {
			return {
				status: 'uncertain',
				reason: `background fallback artifact "${entry.name}" has malformed JSON`,
			};
		}
		const parsed = FallbackArtifactSchema.safeParse(parsedJson);
		if (!parsed.success) {
			return {
				status: 'uncertain',
				reason: `background fallback artifact "${entry.name}" has an invalid owner record`,
			};
		}
		artifacts.push(parsed.data);
	}
	return { status: 'ok', owners: artifacts };
}

function countFallbackFiles(directory: string): number {
	try {
		return fs
			.readdirSync(fallbackDirectoryPath(directory), {
				withFileTypes: true,
			})
			.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		return MAX_LIVE_BACKGROUND_FALLBACKS;
	}
}

export interface WriteDelegationFallbackOptions {
	/** Testable lower cap; callers cannot raise the production maximum. */
	maxLive?: number;
}

/**
 * Atomically persist a launched-but-unledgered delegation in an independent,
 * per-correlation artifact. Capacity failure never removes another live artifact.
 */
export async function writeDelegationFallback(
	directory: string,
	input: RecordPendingInput,
	options: WriteDelegationFallbackOptions = {},
): Promise<BackgroundDelegationFallbackArtifact | null> {
	const now = Date.now();
	const record: BackgroundDelegationRecord = {
		...buildPendingRecord(input, now),
		schemaVersion: 3,
	};
	const artifact: BackgroundDelegationFallbackArtifact = {
		schemaVersion: 1,
		correlationId: input.correlationId,
		createdAt: now,
		record,
	};
	const parsed = FallbackArtifactSchema.safeParse(artifact);
	if (!parsed.success) return null;
	const requestedCap = Math.floor(
		Math.max(1, options.maxLive ?? MAX_LIVE_BACKGROUND_FALLBACKS),
	);
	const maxLive = Math.min(requestedCap, MAX_LIVE_BACKGROUND_FALLBACKS);
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATION_FALLBACK_DIR,
			STORE_LOCK_AGENT,
			FALLBACK_LOCK_TASK,
			async () => {
				const existing = await readFallbackFile(directory, input.correlationId);
				if (existing) {
					return samePendingRecord(existing.record, parsed.data.record)
						? existing
						: null;
				}
				if (countFallbackFiles(directory) >= maxLive) return null;
				const absPath = fallbackPath(directory, input.correlationId);
				fs.mkdirSync(path.dirname(absPath), { recursive: true });
				await bunWrite(absPath, `${JSON.stringify(parsed.data)}\n`);
				return parsed.data;
			},
		);
	} catch (err) {
		logger.warn(
			`[background] writeDelegationFallback failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/** Idempotently remove one exact fallback after durable primary promotion. */
export async function removeDelegationFallback(
	directory: string,
	correlationId: string,
): Promise<boolean> {
	if (!correlationId) return false;
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATION_FALLBACK_DIR,
			STORE_LOCK_AGENT,
			FALLBACK_LOCK_TASK,
			async () => {
				try {
					await fs.promises.unlink(fallbackPath(directory, correlationId));
					return true;
				} catch (err) {
					return (err as NodeJS.ErrnoException).code === 'ENOENT';
				}
			},
		);
	} catch (err) {
		logger.warn(
			`[background] removeDelegationFallback failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

export interface CompletionDelegationLookup {
	source: 'primary' | 'fallback';
	record: BackgroundDelegationRecord;
	fallback?: BackgroundDelegationFallbackArtifact;
}

/** Lookup used by terminal handling: primary ledger first, exact fallback second. */
export async function findDelegationForCompletion(
	directory: string,
	correlationId: string,
): Promise<CompletionDelegationLookup | null> {
	if (!correlationId) return null;
	const primary = findByCorrelationId(directory, correlationId);
	if (primary) return { source: 'primary', record: primary };
	const fallback = await readDelegationFallback(directory, correlationId);
	return fallback
		? { source: 'fallback', record: fallback.record, fallback }
		: null;
}

function samePromotionIdentity(
	primary: BackgroundDelegationRecord,
	fallback: BackgroundDelegationRecord,
): boolean {
	return (
		primary.correlationId === fallback.correlationId &&
		primary.subagentSessionId === fallback.subagentSessionId &&
		primary.parentSessionId === fallback.parentSessionId &&
		primary.callID === fallback.callID &&
		primary.planTaskId === fallback.planTaskId &&
		primary.coderReservationId === fallback.coderReservationId &&
		sameJson(primary.worktree ?? null, fallback.worktree ?? null) &&
		sameJson(
			primary.taskChangeContext ?? null,
			fallback.taskChangeContext ?? null,
		)
	);
}

function samePendingRecord(
	left: BackgroundDelegationRecord,
	right: BackgroundDelegationRecord,
): boolean {
	const {
		createdAt: _leftCreatedAt,
		updatedAt: _leftUpdatedAt,
		...leftIdentity
	} = left;
	const {
		createdAt: _rightCreatedAt,
		updatedAt: _rightUpdatedAt,
		...rightIdentity
	} = right;
	return sameJson(leftIdentity, rightIdentity);
}

/**
 * Promote one exact fallback into the append-only primary ledger, then remove it.
 * A conflicting primary identity fails closed and leaves the fallback untouched.
 */
export async function promoteDelegationFallback(
	directory: string,
	correlationId: string,
): Promise<CompletionDelegationLookup | null> {
	if (!correlationId) return null;
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATION_FALLBACK_DIR,
			STORE_LOCK_AGENT,
			FALLBACK_LOCK_TASK,
			async () => {
				const fallback = await readFallbackFile(directory, correlationId);
				if (!fallback) {
					const primary = findByCorrelationId(directory, correlationId);
					return primary
						? { source: 'primary' as const, record: primary }
						: null;
				}
				let promoted: BackgroundDelegationRecord | null = null;
				await withEvidenceLock(
					directory,
					BACKGROUND_DELEGATIONS_FILE,
					STORE_LOCK_AGENT,
					STORE_LOCK_TASK,
					async () => {
						const records = loadRecordsForWrite(directory);
						if (records === null) return;
						const current = findRecordForWrite(records, correlationId);
						if (current) {
							if (samePromotionIdentity(current, fallback.record)) {
								promoted = current;
							}
							return;
						}
						appendRecord(directory, fallback.record);
						maybeCompactDelegationsLocked(directory);
						promoted = fallback.record;
					},
				);
				if (!promoted) return null;
				try {
					await fs.promises.unlink(fallbackPath(directory, correlationId));
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
						return null;
					}
				}
				return { source: 'primary' as const, record: promoted };
			},
		);
	} catch (err) {
		logger.warn(
			`[background] promoteDelegationFallback failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

const MAX_BACKGROUND_CODER_RESERVATION_STORE_BYTES = 2 * 1024 * 1024;

function reservationStorePath(directory: string): string {
	return validateSwarmPath(directory, BACKGROUND_CODER_RESERVATIONS_FILE);
}

export function buildBackgroundCoderReservationId(input: {
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
}): string {
	const ownerIdentity =
		input.planTaskId === null
			? ['call', input.parentSessionId, input.callID]
			: ['task', input.parentSessionId, input.planTaskId];
	return `bgcr1:${createHash('sha256')
		.update(JSON.stringify(ownerIdentity))
		.digest('hex')}`;
}

export type BackgroundCoderReservationScanResult =
	| { status: 'ok'; reservations: BackgroundCoderReservation[] }
	| { status: 'uncertain'; reason: string };

/**
 * Strict reservation read for admission. Corruption is uncertainty, never absence.
 */
export function scanBackgroundCoderReservationsForAdmission(
	directory: string,
): BackgroundCoderReservationScanResult {
	let absolutePath: string;
	let raw: string;
	try {
		absolutePath = reservationStorePath(directory);
		const stat = fs.statSync(absolutePath);
		if (stat.size > MAX_BACKGROUND_CODER_RESERVATION_STORE_BYTES) {
			return {
				status: 'uncertain',
				reason: `background coder reservation store exceeds the ${MAX_BACKGROUND_CODER_RESERVATION_STORE_BYTES}-byte safety bound`,
			};
		}
		raw = fs.readFileSync(absolutePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'ok', reservations: [] };
		}
		return {
			status: 'uncertain',
			reason: `background coder reservation store is unreadable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (
		Buffer.byteLength(raw, 'utf8') >
		MAX_BACKGROUND_CODER_RESERVATION_STORE_BYTES
	) {
		return {
			status: 'uncertain',
			reason:
				'background coder reservation store changed beyond its safety bound',
		};
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return {
			status: 'uncertain',
			reason: 'background coder reservation store contains malformed JSON',
		};
	}
	const parsed = BackgroundCoderReservationStoreSchema.safeParse(parsedJson);
	if (!parsed.success) {
		return {
			status: 'uncertain',
			reason:
				'background coder reservation store failed strict schema validation',
		};
	}
	return { status: 'ok', reservations: parsed.data.reservations };
}

async function writeBackgroundCoderReservations(
	directory: string,
	reservations: BackgroundCoderReservation[],
): Promise<boolean> {
	const parsed = BackgroundCoderReservationStoreSchema.safeParse({
		schemaVersion: 1,
		reservations,
	});
	if (!parsed.success) return false;
	try {
		await bunWrite(
			reservationStorePath(directory),
			`${JSON.stringify(parsed.data)}\n`,
		);
		return true;
	} catch (error) {
		logger.warn(
			`[background] reservation write failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function reservationOwnerKey(input: {
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
}): string {
	return input.planTaskId === null
		? `call:${input.parentSessionId}:${input.callID}`
		: `task:${input.parentSessionId}:${input.planTaskId}`;
}

function isActiveCoderOwner(record: BackgroundDelegationRecord): boolean {
	if (record.normalizedAgent !== 'coder' || record.status === 'consumed') {
		return false;
	}
	if (
		record.status === 'pending' ||
		record.status === 'running' ||
		record.status === 'completed' ||
		record.status === 'ingestion_error'
	) {
		return true;
	}
	if (record.coderSettlement?.state === 'preserved') return true;
	return record.worktree !== undefined;
}

type DurableCoderOwnerScan =
	| {
			status: 'ok';
			recordsByCorrelation: Map<string, BackgroundDelegationRecord>;
			primaryByCorrelation: Map<string, BackgroundDelegationRecord>;
			primaryByReservationId: Map<string, BackgroundDelegationRecord[]>;
	  }
	| { status: 'uncertain'; reason: string };

/**
 * Fallback MUST be scanned before primary: promotion appends primary before
 * removing fallback, so this order may double-observe (deduped by correlation)
 * but cannot miss an owner moving between stores.
 */
async function scanDurableCoderOwners(
	directory: string,
): Promise<DurableCoderOwnerScan> {
	const fallbackScan = await scanDelegationFallbacksForRecovery(directory);
	if (fallbackScan.status === 'uncertain') return fallbackScan;
	const primaryScan = scanDelegationsForRecovery(directory);
	if (primaryScan.status === 'uncertain') return primaryScan;
	const recordsByCorrelation = new Map<string, BackgroundDelegationRecord>();
	for (const artifact of fallbackScan.owners) {
		recordsByCorrelation.set(artifact.correlationId, artifact.record);
	}
	const primaryByCorrelation = new Map<string, BackgroundDelegationRecord>();
	const primaryByReservationId = new Map<
		string,
		BackgroundDelegationRecord[]
	>();
	for (const record of primaryScan.owners) {
		primaryByCorrelation.set(record.correlationId, record);
		if (record.coderReservationId) {
			const owners =
				primaryByReservationId.get(record.coderReservationId) ?? [];
			owners.push(record);
			primaryByReservationId.set(record.coderReservationId, owners);
		}
		// Primary is authoritative after a safe promotion.
		recordsByCorrelation.set(record.correlationId, record);
	}
	return {
		status: 'ok',
		recordsByCorrelation,
		primaryByCorrelation,
		primaryByReservationId,
	};
}

function exactReservationOwnerCoordinates(
	reservation: BackgroundCoderReservation,
	record: BackgroundDelegationRecord,
): boolean {
	return (
		record.coderReservationId === reservation.reservationId &&
		record.parentSessionId === reservation.parentSessionId &&
		record.planTaskId === reservation.planTaskId &&
		record.callID === reservation.callID
	);
}

function exactReservationRecordMatch(
	reservation: BackgroundCoderReservation,
	record: BackgroundDelegationRecord,
): boolean {
	return (
		exactReservationOwnerCoordinates(reservation, record) &&
		record.correlationId === reservation.correlationId
	);
}

function findExactPrimaryReservationOwner(
	reservation: BackgroundCoderReservation,
	ownerScan: Extract<DurableCoderOwnerScan, { status: 'ok' }>,
): BackgroundDelegationRecord | null {
	if (reservation.correlationId !== null) {
		const primary = ownerScan.primaryByCorrelation.get(
			reservation.correlationId,
		);
		return primary && exactReservationRecordMatch(reservation, primary)
			? primary
			: null;
	}
	const exactOwners = (
		ownerScan.primaryByReservationId.get(reservation.reservationId) ?? []
	).filter((record) => exactReservationOwnerCoordinates(reservation, record));
	return exactOwners.length === 1 ? exactOwners[0]! : null;
}

function hasProvenReleasedReservationOwner(
	record: BackgroundDelegationRecord,
): boolean {
	if (record.status === 'consumed') return true;
	return (
		record.worktree === undefined &&
		(record.status === 'error' || record.status === 'cancelled') &&
		record.terminalResult?.status === record.status
	);
}

function validateReservationIdentity(input: {
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
}): boolean {
	return (
		typeof input.parentSessionId === 'string' &&
		input.parentSessionId.length > 0 &&
		input.parentSessionId.length <= 256 &&
		input.parentSessionId.trim() === input.parentSessionId &&
		typeof input.callID === 'string' &&
		input.callID.length > 0 &&
		input.callID.length <= 256 &&
		input.callID.trim() === input.callID &&
		(input.planTaskId === null ||
			(typeof input.planTaskId === 'string' &&
				input.planTaskId.length > 0 &&
				input.planTaskId.length <= 256 &&
				input.planTaskId.trim() === input.planTaskId))
	);
}

export interface ReserveBackgroundCoderSlotInput {
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
	maxConcurrent: number;
	occupiedTaskIds?: readonly string[];
	/** Launch generation to seed the reservation with (default 1, issue #2104). */
	generation?: number;
	/** Lease duration; clamped to the documented min/max bounds. */
	leaseMs?: number;
	now?: number;
}

export type ReserveBackgroundCoderSlotResult =
	| {
			ok: true;
			reservation: BackgroundCoderReservation;
			activeCount: number;
	  }
	| {
			ok: false;
			reason:
				| 'invalid'
				| 'duplicate_task'
				| 'duplicate_call'
				| 'capacity'
				| 'uncertain';
			activeCount?: number;
			detail?: string;
			existing?: BackgroundCoderReservation;
	  };

/**
 * Atomically reserve one parent-scoped background coder slot before launch.
 * This has no workflow-state side effect.
 */
export async function reserveBackgroundCoderSlot(
	directory: string,
	input: ReserveBackgroundCoderSlotInput,
): Promise<ReserveBackgroundCoderSlotResult> {
	if (
		!validateReservationIdentity(input) ||
		!Number.isInteger(input.maxConcurrent) ||
		input.maxConcurrent < 1 ||
		input.maxConcurrent > 64 ||
		(input.occupiedTaskIds?.length ?? 0) > 64 ||
		!isValidReservationGeneration(input.generation)
	) {
		return { ok: false, reason: 'invalid' };
	}
	const occupiedTaskIds = new Set<string>();
	for (const taskId of input.occupiedTaskIds ?? []) {
		if (
			typeof taskId !== 'string' ||
			taskId.length === 0 ||
			taskId.length > 256 ||
			taskId.trim() !== taskId
		) {
			return { ok: false, reason: 'invalid' };
		}
		occupiedTaskIds.add(taskId);
	}
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_CODER_RESERVATIONS_FILE,
			STORE_LOCK_AGENT,
			RESERVATION_LOCK_TASK,
			async () => {
				const reservationScan =
					scanBackgroundCoderReservationsForAdmission(directory);
				if (reservationScan.status === 'uncertain') {
					return {
						ok: false as const,
						reason: 'uncertain' as const,
						detail: reservationScan.reason,
					};
				}
				const ownerScan = await scanDurableCoderOwners(directory);
				if (ownerScan.status === 'uncertain') {
					return {
						ok: false as const,
						reason: 'uncertain' as const,
						detail: ownerScan.reason,
					};
				}

				// Reconcile only an exact primary owner that durably proves the slot is
				// finished. The reservation may still be unbound when a crash occurs
				// after primary persistence, so reservation id + parent/task/call are
				// the recovery identity. Ambiguous matches remain fail-closed.
				const reservations = reservationScan.reservations.filter(
					(reservation) => {
						const primary = findExactPrimaryReservationOwner(
							reservation,
							ownerScan,
						);
						return !(primary && hasProvenReleasedReservationOwner(primary));
					},
				);
				if (
					reservations.length !== reservationScan.reservations.length &&
					!(await writeBackgroundCoderReservations(directory, reservations))
				) {
					return {
						ok: false as const,
						reason: 'uncertain' as const,
						detail:
							'finished reservation reconciliation could not be persisted',
					};
				}

				const activeOwnerKeys = new Set<string>();
				for (const taskId of occupiedTaskIds) {
					activeOwnerKeys.add(
						reservationOwnerKey({
							parentSessionId: input.parentSessionId,
							planTaskId: taskId,
							callID: '',
						}),
					);
				}
				for (const reservation of reservations) {
					if (reservation.parentSessionId === input.parentSessionId) {
						activeOwnerKeys.add(reservationOwnerKey(reservation));
					}
				}
				for (const record of ownerScan.recordsByCorrelation.values()) {
					if (
						record.parentSessionId === input.parentSessionId &&
						isActiveCoderOwner(record)
					) {
						activeOwnerKeys.add(
							reservationOwnerKey({
								parentSessionId: record.parentSessionId,
								planTaskId: record.planTaskId,
								callID: record.callID,
							}),
						);
					}
				}

				const reservationId = buildBackgroundCoderReservationId(input);
				const existing = reservations.find(
					(reservation) => reservation.reservationId === reservationId,
				);
				if (existing) {
					return {
						ok: false as const,
						reason:
							input.planTaskId === null
								? ('duplicate_call' as const)
								: ('duplicate_task' as const),
						activeCount: activeOwnerKeys.size,
						existing,
					};
				}
				const incomingOwnerKey = reservationOwnerKey(input);
				if (
					input.planTaskId !== null &&
					activeOwnerKeys.has(incomingOwnerKey)
				) {
					return {
						ok: false as const,
						reason: 'duplicate_task' as const,
						activeCount: activeOwnerKeys.size,
					};
				}
				if (activeOwnerKeys.size >= input.maxConcurrent) {
					return {
						ok: false as const,
						reason: 'capacity' as const,
						activeCount: activeOwnerKeys.size,
					};
				}
				if (reservations.length >= MAX_LIVE_BACKGROUND_CODER_RESERVATIONS) {
					return {
						ok: false as const,
						reason: 'capacity' as const,
						activeCount: activeOwnerKeys.size,
						detail: 'durable reservation store is at its hard safety cap',
					};
				}
				const now = input.now ?? Date.now();
				// The lease is created only after every admission/capacity check
				// above has passed (issue #2104): a denied call never mints a lease.
				const leaseMs = clampReservationLeaseMs(input.leaseMs);
				const reservation: BackgroundCoderReservation = {
					reservationId,
					parentSessionId: input.parentSessionId,
					planTaskId: input.planTaskId,
					callID: input.callID,
					state: 'reserved',
					correlationId: null,
					generation: input.generation ?? 1,
					leaseExpiresAt: now + leaseMs,
					createdAt: now,
					updatedAt: now,
				};
				if (
					!(await writeBackgroundCoderReservations(directory, [
						...reservations,
						reservation,
					]))
				) {
					return {
						ok: false as const,
						reason: 'uncertain' as const,
						detail: 'durable reservation claim could not be persisted',
					};
				}
				return {
					ok: true as const,
					reservation,
					activeCount: activeOwnerKeys.size + 1,
				};
			},
		);
	} catch (error) {
		return {
			ok: false,
			reason: 'uncertain',
			detail: `background coder reservation lock failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

export interface BindBackgroundCoderReservationInput {
	reservationId: string;
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
	correlationId: string;
	/**
	 * Launch generation of the dispatch being bound (issue #2104). May move
	 * the reservation's generation FORWARD only (a session.create retry after
	 * PR #2091 relaunches under a newer generation); an older generation can
	 * never rebind. Absent keeps the current generation.
	 */
	generation?: number;
	/** Lease duration for the renewal implied by this verified launch; clamped. */
	leaseMs?: number;
	now?: number;
}

/** Bind the pre-launch owner to the exact trusted completion correlation. */
export async function bindBackgroundCoderReservation(
	directory: string,
	input: BindBackgroundCoderReservationInput,
): Promise<BackgroundCoderReservation | null> {
	if (
		!validateReservationIdentity(input) ||
		!input.reservationId ||
		!input.correlationId ||
		input.correlationId.length > 256 ||
		input.correlationId.trim() !== input.correlationId ||
		input.reservationId !== buildBackgroundCoderReservationId(input) ||
		!isValidReservationGeneration(input.generation)
	) {
		return null;
	}
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_CODER_RESERVATIONS_FILE,
			STORE_LOCK_AGENT,
			RESERVATION_LOCK_TASK,
			async () => {
				const scan = scanBackgroundCoderReservationsForAdmission(directory);
				if (scan.status === 'uncertain') return null;
				const index = scan.reservations.findIndex(
					(reservation) => reservation.reservationId === input.reservationId,
				);
				if (index < 0) return null;
				const current = scan.reservations[index]!;
				if (
					current.parentSessionId !== input.parentSessionId ||
					current.planTaskId !== input.planTaskId ||
					current.callID !== input.callID
				) {
					return null;
				}
				if (current.state === 'bound') {
					if (current.correlationId !== input.correlationId) return null;
					// Idempotent rebind of the same correlation is verified activity
					// for the bound owner (e.g. the completion observer's repair
					// path): refresh the lease so status never shows a live bound
					// reservation as 'expired' between terminal events. Generation
					// never moves on a rebind — only a reserved→bound transition may
					// couple to a newer launch generation.
					const now = input.now ?? Date.now();
					const leaseMs = clampReservationLeaseMs(input.leaseMs);
					const next: BackgroundCoderReservation = {
						...current,
						leaseExpiresAt: now + leaseMs,
						updatedAt: now,
					};
					const reservations = [...scan.reservations];
					reservations[index] = next;
					return (await writeBackgroundCoderReservations(
						directory,
						reservations,
					))
						? next
						: current;
				}
				const currentGeneration = current.generation ?? 1;
				if (
					input.generation !== undefined &&
					input.generation < currentGeneration
				) {
					// An older generation must never rebind (issue #2104): the
					// reservation is owned by a newer launch.
					return null;
				}
				const now = input.now ?? Date.now();
				// Binding IS verified launch activity: it (re)news the lease. A
				// legacy reservation without a lease gains one here — protective,
				// never a reclaim.
				const leaseMs = clampReservationLeaseMs(input.leaseMs);
				const next: BackgroundCoderReservation = {
					...current,
					state: 'bound',
					correlationId: input.correlationId,
					...(input.generation !== undefined || current.generation === undefined
						? { generation: input.generation ?? currentGeneration }
						: {}),
					leaseExpiresAt: now + leaseMs,
					updatedAt: now,
				};
				const reservations = [...scan.reservations];
				reservations[index] = next;
				return (await writeBackgroundCoderReservations(directory, reservations))
					? next
					: null;
			},
		);
	} catch {
		return null;
	}
}

export interface ReleaseBackgroundCoderReservationInput {
	reservationId: string;
	parentSessionId: string;
	planTaskId: string | null;
	callID: string;
	correlationId: string | null;
	/**
	 * Generation of the terminal claiming this release (issue #2104). When
	 * both this and the stored generation are present and differ, the release
	 * is refused: a terminal for generation N must never release the
	 * generation N+1 reservation.
	 */
	generation?: number;
	reason: 'consumed' | 'recovered';
}

/**
 * Release only an exact owner. `consumed` is independently proven from the strict
 * primary ledger; `recovered` is reserved for a caller that completed recovery.
 */
export async function releaseBackgroundCoderReservation(
	directory: string,
	input: ReleaseBackgroundCoderReservationInput,
): Promise<boolean> {
	if (
		!validateReservationIdentity(input) ||
		!input.reservationId ||
		input.reservationId !== buildBackgroundCoderReservationId(input) ||
		(input.correlationId !== null &&
			(input.correlationId.length === 0 ||
				input.correlationId.length > 256 ||
				input.correlationId.trim() !== input.correlationId)) ||
		!isValidReservationGeneration(input.generation)
	) {
		return false;
	}
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_CODER_RESERVATIONS_FILE,
			STORE_LOCK_AGENT,
			RESERVATION_LOCK_TASK,
			async () => {
				const scan = scanBackgroundCoderReservationsForAdmission(directory);
				if (scan.status === 'uncertain') return false;
				const index = scan.reservations.findIndex(
					(reservation) => reservation.reservationId === input.reservationId,
				);
				if (index < 0) return false;
				const current = scan.reservations[index]!;
				if (
					current.parentSessionId !== input.parentSessionId ||
					current.planTaskId !== input.planTaskId ||
					current.callID !== input.callID ||
					current.correlationId !== input.correlationId
				) {
					return false;
				}
				if (
					input.generation !== undefined &&
					current.generation !== undefined &&
					input.generation !== current.generation
				) {
					// A terminal for generation N must never release the
					// reservation currently owned by generation N+1 (issue #2104).
					logger.warn(
						`[background] refusing reservation release: terminal generation ${input.generation} does not match owned generation ${current.generation} for ${input.reservationId}`,
					);
					return false;
				}
				if (input.reason === 'consumed') {
					if (current.state !== 'bound' || !current.correlationId) {
						return false;
					}
					const ownerScan = await scanDurableCoderOwners(directory);
					if (ownerScan.status === 'uncertain') return false;
					const primary = ownerScan.primaryByCorrelation.get(
						current.correlationId,
					);
					if (
						!primary ||
						primary.status !== 'consumed' ||
						!exactReservationRecordMatch(current, primary)
					) {
						return false;
					}
				}
				const reservations = scan.reservations.filter(
					(_, reservationIndex) => reservationIndex !== index,
				);
				return writeBackgroundCoderReservations(directory, reservations);
			},
		);
	} catch {
		return false;
	}
}

export interface MaintainBackgroundDelegationsOptions {
	/** Stale-delegation corroboration timeout (default 30 min). */
	staleTimeoutMs?: number;
	/** Per-invocation bound on swept records and reconciled reservations. */
	maxRecords?: number;
	/** Lock wait bound. Short values let callers (status, admission) proceed. */
	lockTimeoutMs?: number;
	/** Typed label of the maintenance point invoking this run. */
	reason?: string;
	now?: number;
	/** Replay a terminal after its exact legacy WAL transfer succeeds. */
	onLegacyCoderSettlementReconciled?: (
		record: BackgroundDelegationRecord,
	) => Promise<boolean>;
	/** Notify the live observer after replacing a queued transfer advisory. */
	onLegacyCoderSettlementAdvisoryReplaced?: (
		record: BackgroundDelegationRecord,
		replacement: ReplacePendingBackgroundAdvisoryResult,
	) => void | Promise<void>;
	/** Skip legacy coder WAL replay when this pass is already handling that path. */
	skipLegacyCoderSettlementReconciliation?: boolean;
}

export interface MaintainBackgroundDelegationsResult {
	status: 'ok' | 'contention' | 'failure';
	reason?: string;
	sweptStale: number;
	released: Array<{
		reservationId: string;
		generation: number;
		reason: string;
	}>;
	renewed: Array<{ reservationId: string; generation: number }>;
	retained: Array<{ reservationId: string; reason: string }>;
	examinedReservations: number;
}

const DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_MAINTENANCE_BATCH = 256;

/**
 * Retry retiring legacy foreground coder WALs after a background terminal was
 * already durably recorded. This runs outside the delegation/reservation locks
 * so settlement-lock contention cannot deadlock maintenance. Missing or
 * already-terminal WALs are harmless: pure background launches have no legacy
 * WAL, and a successful transfer is idempotent.
 */
async function reconcileLegacyCoderSettlements(
	directory: string,
	maxRecords: number,
	onReconciled?: MaintainBackgroundDelegationsOptions['onLegacyCoderSettlementReconciled'],
	onAdvisoryReplaced?: MaintainBackgroundDelegationsOptions['onLegacyCoderSettlementAdvisoryReplaced'],
): Promise<number> {
	const reconciler =
		onReconciled ?? getLegacyCoderSettlementReconciler(directory);
	const candidates = readDelegations(directory)
		.filter(
			(record) =>
				record.normalizedAgent === 'coder' &&
				Boolean(record.legacyCoderSettlementTransfer) &&
				Boolean(record.terminalResult),
		)
		.slice(0, maxRecords);
	if (candidates.length === 0) return 0;

	const { transferCoderSettlementToBackground } = await import(
		'../workflow/coder-settlement.js'
	);
	let transferred = 0;
	for (const record of candidates) {
		try {
			const outcome = await transferCoderSettlementToBackground({
				directory,
				taskId: record.legacyCoderSettlementTransfer!.taskId,
				transitionId: record.legacyCoderSettlementTransfer!.transitionId,
			});
			if (
				(outcome === 'transferred' ||
					outcome === 'already-terminal' ||
					outcome === 'missing') &&
				reconciler
			) {
				if (await reconciler(record)) {
					await clearLegacyCoderSettlementTransferPending(
						directory,
						record.correlationId,
					);
				}
			}
			if (outcome === 'transferred') transferred += 1;
		} catch (error) {
			const code = legacySettlementErrorCode(error);
			if (!RETRYABLE_LEGACY_SETTLEMENT_ERROR_CODES.has(code ?? '')) {
				const advisory = record.advisoryInbox;
				const manualMessage =
					`[BACKGROUND COMPLETION ${record.terminalResult?.eventId ?? record.correlationId}] ` +
					`coder task ${record.evidenceTaskId ?? record.planTaskId ?? 'unknown'} ` +
					'legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session).';
				let advisoryRecorded = false;
				if (advisory?.state === 'pending') {
					const replaced = await replacePendingBackgroundAdvisory(
						directory,
						record.correlationId,
						{
							eventId: advisory.eventId,
							parentSessionId: advisory.parentSessionId,
							message: manualMessage,
						},
					);
					advisoryRecorded = replaced !== null;
					if (replaced) {
						try {
							await onAdvisoryReplaced?.(record, replaced);
						} catch (callbackError) {
							logger.warn(
								`[background] legacy coder settlement advisory replacement notification failed for ${record.correlationId}: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
							);
						}
					}
				} else if (record.terminalResult) {
					const stored = await putPendingBackgroundAdvisory(
						directory,
						record.correlationId,
						{
							eventId: record.terminalResult.eventId,
							parentSessionId: record.parentSessionId,
							message: manualMessage,
						},
					);
					advisoryRecorded = stored !== null;
				}
				if (advisoryRecorded) {
					await clearLegacyCoderSettlementTransferPending(
						directory,
						record.correlationId,
					);
				}
				logger.warn(
					`[background] legacy coder settlement reconciliation requires manual recovery for ${record.correlationId}: ${code ?? 'unknown transfer failure'}`,
				);
				continue;
			}
			logger.warn(
				`[background] legacy coder settlement reconciliation deferred for ${record.correlationId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return transferred;
}

function legacySettlementErrorCode(error: unknown): string | null {
	if (
		error &&
		typeof error === 'object' &&
		'code' in error &&
		typeof (error as NodeJS.ErrnoException).code === 'string'
	) {
		return (error as NodeJS.ErrnoException).code ?? null;
	}
	const detail = error instanceof Error ? error.message : String(error);
	const match = /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(detail.trim());
	return match?.[1] ?? null;
}

/**
 * Shared background maintenance service (issue #2104): one bounded,
 * event-driven pass that sweeps stale delegation records and reconciles
 * expired coder-reservation leases with corroborated owner evidence.
 *
 * Lock-ordering invariant: this is the ONLY site that touches both store
 * locks, and it takes them SEQUENTIALLY — the delegations STORE lock first,
 * fully released, then the RESERVATION lock. Never nested. No code path may
 * acquire the RESERVATION lock and then the STORE lock.
 *
 * Per invocation the work is bounded (maxRecords sweeps / reconciliations;
 * the underlying reads are already bounded by the checkpoint machinery and
 * the 4 MiB recovery window). Every release, retained ambiguity, renewal,
 * contention, and failure emits a durable operator fact into the health
 * artifact's bounded maintenance ring. Expiry alone never releases: reclaim
 * requires corroborated owner absence (stale exact owner record, or no owner
 * record at all beyond the stale timeout), and any uncertainty retains the
 * reservation fail-closed.
 */
export async function maintainBackgroundDelegations(
	directory: string,
	options: MaintainBackgroundDelegationsOptions = {},
): Promise<MaintainBackgroundDelegationsResult> {
	const now = options.now ?? Date.now();
	const staleTimeoutMs =
		options.staleTimeoutMs ?? DEFAULT_STALE_DELEGATION_TIMEOUT_MS;
	const maxRecords = options.maxRecords ?? DEFAULT_MAINTENANCE_BATCH;
	const lockTimeoutMs =
		options.lockTimeoutMs ?? DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS;
	const reason = options.reason ?? 'manual';
	const result: MaintainBackgroundDelegationsResult = {
		status: 'ok',
		sweptStale: 0,
		released: [],
		renewed: [],
		retained: [],
		examinedReservations: 0,
	};
	const facts: DelegationMaintenanceFact[] = [];
	const emitObservation = (
		status: 'ok' | 'contention' | 'failure',
		failureReason?: string,
	): MaintainBackgroundDelegationsResult => {
		appendDelegationMaintenanceObservation(directory, {
			at: now,
			status,
			reason: failureReason,
			summary:
				status === 'ok'
					? {
							sweptStale: result.sweptStale,
							released: result.released.length,
							renewed: result.renewed.length,
							retained: result.retained.length,
						}
					: undefined,
			facts,
		});
		return {
			...result,
			status,
			...(failureReason ? { reason: failureReason } : {}),
		};
	};

	// Phase A — sweep stale delegation records under the STORE lock.
	try {
		result.sweptStale = await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () =>
				sweepStaleLocked(
					directory,
					staleTimeoutMs,
					now,
					DEFAULT_SWEEPABLE_DELEGATION_STATUSES,
					{},
					{ maxSweep: maxRecords },
				),
			lockTimeoutMs,
		);
	} catch (error) {
		if (error instanceof EvidenceLockTimeoutError) {
			facts.push({
				at: now,
				kind: 'lock-contention',
				reason: `maintenance point '${reason}' skipped: delegations store lock contended`,
			});
			return emitObservation('contention', error.message);
		}
		facts.push({
			at: now,
			kind: 'maintenance-failure',
			reason: `maintenance point '${reason}' sweep failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
		return emitObservation(
			'failure',
			error instanceof Error ? error.message : String(error),
		);
	}

	// Phase B — reconcile reservation leases under the RESERVATION lock.
	// The decision is re-derived from a FRESH owner scan here; the phase-A
	// sweep only durably marks records stale, it is not trusted as evidence.
	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_CODER_RESERVATIONS_FILE,
			STORE_LOCK_AGENT,
			RESERVATION_LOCK_TASK,
			async () => {
				const reservationScan =
					scanBackgroundCoderReservationsForAdmission(directory);
				if (reservationScan.status === 'uncertain') {
					result.status = 'failure';
					result.reason = reservationScan.reason;
					facts.push({
						at: now,
						kind: 'maintenance-failure',
						reason: `reservation store uncertain: ${reservationScan.reason}`,
					});
					return;
				}
				const ownerScan = await scanDurableCoderOwners(directory);
				if (ownerScan.status === 'uncertain') {
					result.status = 'failure';
					result.reason = ownerScan.reason;
					facts.push({
						at: now,
						kind: 'maintenance-failure',
						reason: `owner evidence uncertain; all reservations retained: ${ownerScan.reason}`,
					});
					return;
				}
				const batch = reservationScan.reservations.slice(0, maxRecords);
				result.examinedReservations = batch.length;
				const next: BackgroundCoderReservation[] = [];
				let mutated = false;
				for (const reservation of batch) {
					const generation = reservation.generation ?? 1;
					const primary = findExactPrimaryReservationOwner(
						reservation,
						ownerScan,
					);
					if (primary && hasProvenReleasedReservationOwner(primary)) {
						if ((primary.generation ?? 1) !== generation) {
							// Proven-terminal owner, but for an OLDER generation: a
							// newer launch may still own this reservation (issue
							// #2104 — a terminal for generation N must never release
							// generation N+1). Retain fail-closed.
							result.retained.push({
								reservationId: reservation.reservationId,
								reason: 'owner-terminal-older-generation',
							});
							facts.push({
								at: now,
								kind: 'retained-ambiguity',
								reservationId: reservation.reservationId,
								correlationId: reservation.correlationId ?? undefined,
								generation,
								reason: `proven-terminal owner is generation ${primary.generation ?? 1}, reservation owns ${generation}`,
							});
							next.push(reservation);
							continue;
						}
						// Proof-based release (no age involved) — also the only path
						// that may release a legacy, lease-less reservation.
						mutated = true;
						result.released.push({
							reservationId: reservation.reservationId,
							generation,
							reason: 'proven-terminal-owner',
						});
						facts.push({
							at: now,
							kind: 'release',
							reservationId: reservation.reservationId,
							correlationId: reservation.correlationId ?? undefined,
							generation,
							reason: 'proven-terminal-owner',
						});
						continue;
					}
					if (reservation.leaseExpiresAt === undefined) {
						// Legacy reservation without a lease: protected until
						// corroborated reconciliation; age never releases it.
						result.retained.push({
							reservationId: reservation.reservationId,
							reason: 'protected-legacy-no-lease',
						});
						facts.push({
							at: now,
							kind: 'retained-protected-legacy',
							reservationId: reservation.reservationId,
							generation,
							reason: 'legacy reservation without leaseExpiresAt',
						});
						next.push(reservation);
						continue;
					}
					const leaseExpired = reservation.leaseExpiresAt <= now;
					if (!leaseExpired) {
						next.push(reservation);
						continue;
					}
					if (primary) {
						if ((primary.generation ?? 1) !== generation) {
							// Owner evidence from an older generation can neither
							// release nor renew a newer reservation.
							result.retained.push({
								reservationId: reservation.reservationId,
								reason: 'owner-older-generation',
							});
							facts.push({
								at: now,
								kind: 'retained-ambiguity',
								reservationId: reservation.reservationId,
								correlationId: reservation.correlationId ?? undefined,
								generation,
								reason: `owner record is generation ${primary.generation ?? 1}, reservation owns ${generation}`,
							});
							next.push(reservation);
							continue;
						}
						if (primary.status === 'stale') {
							// Corroborated owner verdict: the delegation record itself
							// was finalized stale (by a sweep under the store lock).
							mutated = true;
							result.released.push({
								reservationId: reservation.reservationId,
								generation,
								reason: 'owner-swept-stale',
							});
							facts.push({
								at: now,
								kind: 'release',
								reservationId: reservation.reservationId,
								correlationId: reservation.correlationId ?? undefined,
								generation,
								reason: 'owner record durably stale',
							});
							continue;
						}
						if (isActiveCoderOwner(primary)) {
							// Fresh durable owner activity: verified evidence of live
							// work — renew the lease for the same generation only.
							mutated = true;
							result.renewed.push({
								reservationId: reservation.reservationId,
								generation,
							});
							facts.push({
								at: now,
								kind: 'lease-renewed',
								reservationId: reservation.reservationId,
								correlationId: reservation.correlationId ?? undefined,
								generation,
								reason: 'exact owner record still active',
							});
							next.push({
								...reservation,
								leaseExpiresAt: now + BACKGROUND_CODER_RESERVATION_LEASE_MS,
								updatedAt: now,
							});
							continue;
						}
						// Terminal-but-unproven owner (e.g. preserved worktree lane):
						// ambiguity retains the reservation fail-closed.
						result.retained.push({
							reservationId: reservation.reservationId,
							reason: 'owner-terminal-unproven',
						});
						facts.push({
							at: now,
							kind: 'retained-ambiguity',
							reservationId: reservation.reservationId,
							correlationId: reservation.correlationId ?? undefined,
							generation,
							reason: `owner status '${primary.status}' does not prove release`,
						});
						next.push(reservation);
						continue;
					}
					// No exact primary owner. A record at this correlation with a
					// DIFFERENT identity is an ownership ambiguity → retain.
					if (
						reservation.correlationId !== null &&
						ownerScan.recordsByCorrelation.has(reservation.correlationId)
					) {
						result.retained.push({
							reservationId: reservation.reservationId,
							reason: 'owner-identity-mismatch',
						});
						facts.push({
							at: now,
							kind: 'retained-ambiguity',
							reservationId: reservation.reservationId,
							correlationId: reservation.correlationId ?? undefined,
							generation,
							reason: 'correlation exists under a different owner identity',
						});
						next.push(reservation);
						continue;
					}
					if (now - reservation.createdAt > staleTimeoutMs) {
						// Every authoritative owner source available to this
						// subsystem agrees there is no owner: no primary record, no
						// fallback record, lease expired, and the pre-launch window
						// exceeded the stale timeout. Reclaim.
						mutated = true;
						result.released.push({
							reservationId: reservation.reservationId,
							generation,
							reason: 'unbound-orphan',
						});
						facts.push({
							at: now,
							kind: 'release',
							reservationId: reservation.reservationId,
							generation,
							reason:
								'no durable owner anywhere and pre-launch window exceeded',
						});
						continue;
					}
					result.retained.push({
						reservationId: reservation.reservationId,
						reason: 'unbound-within-stale-window',
					});
					facts.push({
						at: now,
						kind: 'retained-ambiguity',
						reservationId: reservation.reservationId,
						generation,
						reason:
							'no owner record yet; still inside the pre-launch stale window',
					});
					next.push(reservation);
				}
				// Reservations beyond the batch stay untouched.
				next.push(...reservationScan.reservations.slice(maxRecords));
				if (mutated) {
					const written = await writeBackgroundCoderReservations(
						directory,
						next,
					);
					if (!written) {
						result.status = 'failure';
						result.reason = 'reservation reconciliation could not be persisted';
						facts.push({
							at: now,
							kind: 'maintenance-failure',
							reason: 'reservation store write failed during reconciliation',
						});
					}
				}
			},
			lockTimeoutMs,
		);
	} catch (error) {
		if (error instanceof EvidenceLockTimeoutError) {
			facts.push({
				at: now,
				kind: 'lock-contention',
				reason: `maintenance point '${reason}' skipped: reservation store lock contended`,
			});
			return emitObservation('contention', error.message);
		}
		facts.push({
			at: now,
			kind: 'maintenance-failure',
			reason: `maintenance point '${reason}' reconciliation failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
		return emitObservation(
			'failure',
			error instanceof Error ? error.message : String(error),
		);
	}

	// A terminal observer may have completed ingestion while legacy WAL transfer
	// was temporarily unavailable. Reconcile those exact task/call identities at
	// every successful maintenance point, including admission before the next
	// coder dispatch. The work is bounded by the same maintenance batch.
	if (!options.skipLegacyCoderSettlementReconciliation) {
		try {
			await reconcileLegacyCoderSettlements(
				directory,
				maxRecords,
				options.onLegacyCoderSettlementReconciled ??
					getLegacyCoderSettlementReconciler(directory),
				options.onLegacyCoderSettlementAdvisoryReplaced,
			);
		} catch (error) {
			logger.warn(
				`[background] legacy coder settlement reconciliation pass failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (result.status === 'failure') {
		return emitObservation('failure', result.reason);
	}
	return emitObservation('ok');
}
