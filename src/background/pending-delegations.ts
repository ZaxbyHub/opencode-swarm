/**
 * Durable pending background-delegation store (issue #1151, PR 2 Stage A).
 *
 * Append-only JSONL event log under project-root `.swarm/background-delegations.jsonl`.
 * Each line is a full record snapshot; readers fold to the latest snapshot per
 * `correlationId`. This tracks background swarm `Task` dispatches so a later (Stage B)
 * trusted completion can be correlated to a real dispatch. The stale sweep bounds the
 * number of permanently-running (unresolved) entries by transitioning them to `stale`, so
 * the folded in-memory view stays bounded by distinct correlationIds. Note: the on-disk
 * log itself is append-only and is NOT compacted in Stage A — each dispatch leaves a small,
 * fixed number of lines; on-disk compaction of dropped/stale records is a future stage.
 *
 * Stage A scope: dispatch records a `pending` snapshot and the stale sweep records
 * `stale` snapshots. There is NO gate advancement and NO completion mutation here — the
 * completion observer (Stage A) is read-only. Gate-affecting completion ingestion is
 * Stage B, gated on runtime confirmation of the upstream completion signal.
 *
 * Concurrency: all writes (append, sweep) run under a single project-scoped lock via
 * `withEvidenceLock`, so concurrent dispatches/sweeps cannot interleave appends. Reads are
 * lock-free (line-oriented; partial trailing lines are skipped defensively).
 *
 * Containment: the path is validated with `validateSwarmPath`, so it can never escape
 * `.swarm/` (Invariant 4).
 */

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
	| 'completed'
	| 'error'
	| 'stale';

export interface BackgroundDelegationRecord {
	schemaVersion: 1;
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
}

const RecordSchema = z
	.object({
		schemaVersion: z.literal(1),
		correlationId: z.string().min(1),
		jobId: z.string().nullable(),
		subagentSessionId: z.string().min(1),
		parentSessionId: z.string().min(1),
		callID: z.string(),
		normalizedAgent: z.string(),
		swarmPrefixedAgent: z.string(),
		planTaskId: z.string().nullable(),
		evidenceTaskId: z.string().nullable(),
		status: z.enum(['pending', 'completed', 'error', 'stale']),
		createdAt: z.number(),
		updatedAt: z.number(),
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
 * This is intentionally simple and acceptable at Stage A volumes (a swarm has few concurrent
 * background delegations, and the on-disk log is small). If sustained high-throughput
 * background load ever makes this hot, a future stage should add a stat-invalidated in-memory
 * cache and/or JSONL compaction (the same future-compaction work noted in the module header).
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
}

/**
 * Record a `pending` background delegation. Runs the stale sweep first (lazy maintenance,
 * no plugin-init cost), then appends the pending snapshot — all under one lock acquisition
 * so concurrent dispatches cannot interleave. Best-effort: returns null on lock timeout or
 * write failure (Stage A has no gate effects, so a missed record is non-fatal).
 */
export async function recordPendingDelegation(
	directory: string,
	input: RecordPendingInput,
	options: { staleTimeoutMs?: number } = {},
): Promise<BackgroundDelegationRecord | null> {
	const now = Date.now();
	const record: BackgroundDelegationRecord = {
		schemaVersion: 1,
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
		if (record.status !== 'pending') continue;
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
