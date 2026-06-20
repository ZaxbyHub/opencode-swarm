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
import * as logger from '../utils/logger.js';

export const BACKGROUND_DELEGATIONS_FILE = 'background-delegations.jsonl';

/** Lock + diagnostics identity for the project-scoped store lock. */
const STORE_LOCK_AGENT = 'background';
const STORE_LOCK_TASK = 'background-delegations';

export type BackgroundDelegationStatus =
	| 'pending'
	| 'running'
	| 'ingestion_error'
	| 'completed'
	| 'error'
	| 'cancelled'
	| 'stale'
	| 'consumed';

export interface BackgroundDelegationRecord {
	schemaVersion: 1 | 2;
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
	/** Canonical hash of prompt/provenance inputs captured at dispatch time. */
	promptHash?: string;
	/** Project/root provenance captured at dispatch time. */
	workspace?: BackgroundWorkspaceSnapshot;
	prompt?: BackgroundPromptSnapshot;
	generation?: number;
	result?: BackgroundDelegationResult;
	completedAt?: number;
}

export interface BackgroundWorkspaceSnapshot {
	directory: string;
	gitHead: string | null;
	dirtyHash: string | null;
	prHeadSha: string | null;
	scope: string | null;
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
}

const ResultSchema = z
	.object({
		text: z.string().optional(),
		error: z.string().optional(),
		chars: z.number(),
		truncated: z.boolean(),
		digest: z.string(),
	})
	.strict();

const WorkspaceSchema = z
	.object({
		directory: z.string(),
		gitHead: z.string().nullable(),
		dirtyHash: z.string().nullable(),
		prHeadSha: z.string().nullable(),
		scope: z.string().nullable(),
	})
	.strict();

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
		schemaVersion: z.union([z.literal(1), z.literal(2)]),
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
		promptHash: z.string().optional(),
		workspace: WorkspaceSchema.optional(),
		prompt: PromptSchema.optional(),
		generation: z.number().optional(),
		result: ResultSchema.optional(),
		completedAt: z.number().optional(),
	})
	.strict();

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
	promptHash?: string;
	workspace?: BackgroundWorkspaceSnapshot;
	prompt?: BackgroundPromptSnapshot;
	generation?: number;
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
	const record: BackgroundDelegationRecord = {
		schemaVersion: input.batchId ? 2 : 1,
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
		...(input.promptHash ? { promptHash: input.promptHash } : {}),
		...(input.workspace ? { workspace: input.workspace } : {}),
		...(input.prompt ? { prompt: input.prompt } : {}),
		...(input.generation !== undefined ? { generation: input.generation } : {}),
	};

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
				appendRecord(directory, record);
			},
		);
		return record;
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
					transition.status !== 'ingestion_error'
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
