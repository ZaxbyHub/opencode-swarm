/**
 * Durable pending background-delegation store (issue #1151, PR 2 Stage A).
 *
 * Append-only JSONL event log under project-root `.swarm/background-delegations.jsonl`.
 * Each line is a full record snapshot; readers fold to the latest snapshot per
 * `correlationId`. This tracks native background `Task` dispatches and deterministic
 * async advisory lanes so trusted completions can be correlated to a real dispatch.
 * The stale sweep bounds the number of permanently-running entries by transitioning
 * them to `stale`, so the folded in-memory view stays bounded by distinct correlationIds.
 * The on-disk log itself is append-only and is NOT compacted; each dispatch leaves a
 * small, fixed number of lines.
 *
 * Scope: dispatch records `pending`/`running` snapshots, collection or trusted synthetic
 * completions record terminal snapshots, and the stale sweep records `stale` snapshots.
 * This store itself has no gate-advancement side effect. Stage B gate ingestion is a
 * separate consumer of trusted terminal snapshots.
 *
 * Concurrency: all writes (append, sweep) run under a single project-scoped lock via
 * `withEvidenceLock`, so concurrent dispatches/sweeps cannot interleave appends. Reads are
 * lock-free (line-oriented; partial trailing lines are skipped defensively).
 *
 * Containment: the path is validated with `validateSwarmPath`, so it can never escape
 * `.swarm/` (Invariant 4).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { withEvidenceLock } from '../evidence/lock.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { bunWrite } from '../utils/bun-compat.js';
import * as logger from '../utils/logger.js';

export const BACKGROUND_DELEGATIONS_FILE = 'background-delegations.jsonl';
export const BACKGROUND_DELEGATION_FALLBACK_DIR =
	'background-delegation-fallback';
export const BACKGROUND_CODER_RESERVATIONS_FILE =
	'background-coder-reservations.json';
export const MAX_LIVE_BACKGROUND_FALLBACKS = 256;
export const MAX_LIVE_BACKGROUND_CODER_RESERVATIONS = 256;
export const MAX_BACKGROUND_OBSERVED_FILES = 5_000;
export const MAX_BACKGROUND_ADVISORY_CHARS = 4_000;
const MAX_RECOVERY_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_RECOVERY_FALLBACK_BYTES = 1024 * 1024;

export type RecoveryOwnershipScanResult<T> =
	| { status: 'ok'; owners: T[] }
	| { status: 'uncertain'; reason: string };

/** Lock + diagnostics identity for the project-scoped store lock. */
const STORE_LOCK_AGENT = 'background';
const STORE_LOCK_TASK = 'background-delegations';
const FALLBACK_LOCK_TASK = 'background-delegation-fallback';
const RESERVATION_LOCK_TASK = 'background-coder-reservations';
const ADVISORY_PREPARE_LEASE_MS = 30_000;
const INGESTION_CLAIM_LEASE_MS = 30_000;

/** An abandoned ingestion lease may be reclaimed after this bounded interval. */
export const BACKGROUND_INGESTION_LEASE_MS = 30_000;

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

export interface BackgroundDelegationRecord {
	schemaVersion: 1 | 2 | 3;
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
	/** Canonical hash of prompt/provenance inputs captured at dispatch time. */
	promptHash?: string;
	/** Project/root provenance captured at dispatch time. */
	workspace?: BackgroundWorkspaceSnapshot;
	/** Immutable pre-coder provenance for doc-only gate classification. */
	taskChangeContext?: BackgroundTaskChangeContext;
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
}

export interface BackgroundPromptSnapshot {
	text: string;
	chars: number;
	truncated: boolean;
	digest: string;
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
	createdAt: number;
	updatedAt: number;
}

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
	})
	.strict();

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
		schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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
		promptHash: z.string().optional(),
		workspace: WorkspaceSchema.optional(),
		taskChangeContext: TaskChangeContextSchema.optional(),
		worktree: WorktreeDescriptorSchema.optional(),
		coderReservationId: z.string().min(1).max(256).optional(),
		prompt: PromptSchema.optional(),
		generation: z.number().optional(),
		terminalResult: TerminalResultSchema.optional(),
		coderSettlement: CoderSettlementSchema.optional(),
		advisoryInbox: AdvisoryInboxSchema.optional(),
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

function ensureSwarmDir(directory: string): void {
	fs.mkdirSync(path.resolve(directory, '.swarm'), { recursive: true });
}

/**
 * Read and fold the store to the latest snapshot per correlationId. Lock-free and
 * defensive: a missing file yields an empty list, and malformed/partial lines are skipped
 * (never throws). Records are returned in first-seen correlationId order.
 *
 * Cost: O(lines on disk) per call — a full read + parse + fold with no in-memory cache.
 * This is intentionally simple and acceptable at advisory-lane volumes (a swarm has few
 * concurrent background delegations, and the on-disk log is small).
 */
export function readDelegations(
	directory: string,
): BackgroundDelegationRecord[] {
	let raw: string;
	try {
		raw = fs.readFileSync(storePath(directory), 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		// Unexpected read error — treat as empty but record under debug.
		logger.warn(
			`[background] readDelegations failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}

	const folded = new Map<string, BackgroundDelegationRecord>();
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(trimmed);
		} catch {
			continue; // skip malformed/partial line
		}
		const result = RecordSchema.safeParse(parsedJson);
		if (!result.success) continue;
		folded.set(result.data.correlationId, result.data);
	}
	return [...folded.values()];
}

/**
 * Strict startup-recovery view of the primary ledger. Unlike the ordinary
 * advisory reader, this never treats unreadable, oversized, or malformed owner
 * data as absence: destructive orphan cleanup must fail closed on uncertainty.
 */
export function scanDelegationsForRecovery(
	directory: string,
): RecoveryOwnershipScanResult<BackgroundDelegationRecord> {
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
			return { status: 'ok', owners: [] };
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

	const folded = new Map<string, BackgroundDelegationRecord>();
	let lineNumber = 0;
	for (const line of raw.split('\n')) {
		lineNumber += 1;
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(trimmed);
		} catch {
			return {
				status: 'uncertain',
				reason: `background delegation ledger has malformed JSON at line ${lineNumber}`,
			};
		}
		const parsed = RecordSchema.safeParse(parsedJson);
		if (!parsed.success) {
			return {
				status: 'uncertain',
				reason: `background delegation ledger has an invalid record at line ${lineNumber}`,
			};
		}
		folded.set(parsed.data.correlationId, parsed.data);
	}
	return { status: 'ok', owners: [...folded.values()] };
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
	promptHash?: string;
	workspace?: BackgroundWorkspaceSnapshot;
	taskChangeContext?: BackgroundTaskChangeContext;
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
		...(input.promptHash ? { promptHash: input.promptHash } : {}),
		...(input.workspace ? { workspace: input.workspace } : {}),
		...(input.taskChangeContext
			? { taskChangeContext: input.taskChangeContext }
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
 * so concurrent dispatches cannot interleave. Best-effort: returns null on lock timeout or
 * write failure. Async advisory launchers must treat null as a launch failure so they do
 * not create untracked background work.
 */
export async function recordPendingDelegation(
	directory: string,
	input: RecordPendingInput,
	options: { staleTimeoutMs?: number } = {},
): Promise<BackgroundDelegationRecord | null> {
	const now = Date.now();
	const record = buildPendingRecord(input, now);
	const parsedRecord = RecordSchema.safeParse(record);
	if (!parsedRecord.success) {
		logger.warn('[background] recordPendingDelegation rejected invalid input');
		return null;
	}

	try {
		await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				if (options.staleTimeoutMs && options.staleTimeoutMs > 0) {
					sweepStaleLocked(directory, options.staleTimeoutMs, now);
				}
				appendRecord(directory, parsedRecord.data);
			},
		);
		return parsedRecord.data;
	} catch (err) {
		logger.warn(
			`[background] recordPendingDelegation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
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
				const current = findByCorrelationId(directory, correlationId);
				if (!current) return;
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
					schemaVersion:
						current.schemaVersion === 1 ? 2 : current.schemaVersion,
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

function sameTerminalEvent(
	left: BackgroundTerminalResult,
	right: BackgroundTerminalResult,
): boolean {
	return (
		left.eventId === right.eventId &&
		left.status === right.status &&
		sameJson(left.result, right.result)
	);
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
				const current = findByCorrelationId(directory, correlationId);
				if (!current) return;
				if (current.terminalResult) {
					if (!sameTerminalEvent(current.terminalResult, parsedTerminal.data)) {
						logger.warn(
							`[background] claimTerminalResult: different terminal event for ` +
								`correlationId=${correlationId}; ` +
								`existing={status: ${current.terminalResult.status}, eventId: ${current.terminalResult.eventId}} ` +
								`incoming={status: ${parsedTerminal.data.status}, eventId: ${parsedTerminal.data.eventId}}; ` +
								`rejected`,
						);
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
							updatedAt: parsedTerminal.data.recordedAt,
						};
					}
				}
				const next: BackgroundDelegationRecord = {
					...current,
					schemaVersion: 3,
					status: parsedTerminal.data.status,
					terminalResult: parsedTerminal.data,
					result: parsedTerminal.data.result,
					completedAt: parsedTerminal.data.recordedAt,
					updatedAt: parsedTerminal.data.recordedAt,
					...(coderSettlement ? { coderSettlement } : {}),
				};
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
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
				const current = findByCorrelationId(directory, correlationId);
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
					schemaVersion: 3,
					coderSettlement: settlement,
					updatedAt: settlement.updatedAt,
				};
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
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
				const current = findByCorrelationId(directory, correlationId);
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
					schemaVersion: 3,
					coderSettlement: settlement,
					updatedAt,
				};
				if (!RecordSchema.safeParse(next).success) return;
				appendRecord(directory, next);
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
				const current = findByCorrelationId(directory, correlationId);
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
					schemaVersion: 3,
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
				const current = findByCorrelationId(directory, correlationId);
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
					schemaVersion: 3,
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
				const current = findByCorrelationId(directory, correlationId);
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
					schemaVersion: 3,
					advisoryInbox: parsed.data,
					updatedAt: createdAt,
				};
				appendRecord(directory, next);
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
				for (const current of readDelegations(directory)) {
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
						schemaVersion: 3,
						advisoryInbox: nextAdvisory,
						updatedAt: now,
					};
					appendRecord(directory, next);
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
				const byEvent = new Map<string, BackgroundDelegationRecord>();
				for (const current of readDelegations(directory)) {
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
						schemaVersion: 3,
						advisoryInbox: {
							...current.advisoryInbox,
							preparation: undefined,
						},
						updatedAt: now,
					};
					appendRecord(directory, next);
				}
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
				const now = Date.now();
				for (const current of readDelegations(directory)) {
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
						schemaVersion: 3,
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
 * Mark all `pending` records older than `timeoutMs` as `stale` (status-only; no gate
 * effect). Called within an already-held store lock.
 */
function sweepStaleLocked(
	directory: string,
	timeoutMs: number,
	now: number,
): number {
	let swept = 0;
	for (const record of readDelegations(directory)) {
		if (
			record.status !== 'pending' &&
			record.status !== 'running' &&
			record.status !== 'ingestion_error'
		)
			continue;
		if (now - record.updatedAt <= timeoutMs) continue;
		appendRecord(directory, {
			...record,
			status: 'stale',
			updatedAt: now,
		});
		swept += 1;
	}
	return swept;
}

/**
 * Public stale sweep: acquires the store lock and marks overdue pendings as `stale`.
 * Best-effort; returns the number swept (0 on lock timeout / error).
 */
export async function sweepStaleDelegations(
	directory: string,
	timeoutMs: number,
): Promise<number> {
	if (!timeoutMs || timeoutMs <= 0) return 0;
	try {
		return await withEvidenceLock(
			directory,
			BACKGROUND_DELEGATIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => sweepStaleLocked(directory, timeoutMs, Date.now()),
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
						const current = findByCorrelationId(directory, correlationId);
						if (current) {
							if (samePromotionIdentity(current, fallback.record)) {
								promoted = current;
							}
							return;
						}
						appendRecord(directory, fallback.record);
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
		(input.occupiedTaskIds?.length ?? 0) > 64
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
				const reservation: BackgroundCoderReservation = {
					reservationId,
					parentSessionId: input.parentSessionId,
					planTaskId: input.planTaskId,
					callID: input.callID,
					state: 'reserved',
					correlationId: null,
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
		input.reservationId !== buildBackgroundCoderReservationId(input)
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
					return current.correlationId === input.correlationId ? current : null;
				}
				const next: BackgroundCoderReservation = {
					...current,
					state: 'bound',
					correlationId: input.correlationId,
					updatedAt: input.now ?? Date.now(),
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
				input.correlationId.trim() !== input.correlationId))
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
