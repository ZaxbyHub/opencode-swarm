import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	ensurePrWorkflowSafeParentDirectory,
	prWorkflowSessionFileStem,
	writePrWorkflowAtomicJson,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';

const PR_FEEDBACK_EVENT_QUEUE_DIR = 'pr-feedback-events';
export const MAX_PR_FEEDBACK_MONITOR_EVENTS = 20;
const MAX_QUEUE_BYTES = 512 * 1024;
const MAX_TRACKED_SESSIONS = 200;
const LOCK_MAX_ATTEMPTS = 50;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_UNINITIALIZED_STALE_MS = 30_000;

export interface PrFeedbackMonitorEvent {
	type: string;
	repoFullName: string;
	prNumber: number;
	prUrl: string;
	message: string;
	dedupToken: string;
	authorized: boolean;
	queuedAt: string;
	/** Head authenticated by the monitor when this event was emitted. */
	headRefOid?: string;
	claimedWorkflowInstanceId?: string;
	/** Exact process owner paired with the workflow instance id. */
	claimedOwnerPid?: number;
	claimedAt?: string;
}

export interface PrFeedbackMonitorQueueRecord {
	schemaVersion: 1;
	revision: number;
	sessionID: string;
	events: PrFeedbackMonitorEvent[];
}

interface QueueLockRecord {
	ownerToken: string;
	pid: number;
	createdAtMs: number;
}

const PrFeedbackMonitorEventSchema = z
	.object({
		type: z.string().min(1).max(128),
		repoFullName: z.string().min(1).max(512),
		prNumber: z.number().int().positive(),
		prUrl: z.string().url().max(2000),
		message: z.string().min(1).max(20_000),
		dedupToken: z.string().min(1).max(512),
		authorized: z.boolean(),
		queuedAt: z.string().min(1),
		headRefOid: z.string().min(1).max(256).optional(),
		claimedWorkflowInstanceId: z.string().min(1).max(128).optional(),
		claimedOwnerPid: z.number().int().positive().optional(),
		claimedAt: z.string().min(1).optional(),
	})
	.strict();

/**
 * The queue file is also read by older plugin versions. Keep its persisted
 * event shape limited to fields those versions understand; fields added for
 * the current worker's provenance and process fencing live in the paired
 * metadata sidecar below. This lets a downgrade continue to read and clear a
 * queue without giving an older worker a new strict-schema record to parse.
 */
const PrFeedbackMonitorEventDiskSchema = z
	.object({
		type: z.string().min(1).max(128),
		repoFullName: z.string().min(1).max(512),
		prNumber: z.number().int().positive(),
		prUrl: z.string().url().max(2000),
		message: z.string().min(1).max(20_000),
		dedupToken: z.string().min(1).max(512),
		authorized: z.boolean(),
		queuedAt: z.string().min(1),
		claimedWorkflowInstanceId: z.string().min(1).max(128).optional(),
		claimedAt: z.string().min(1).optional(),
	})
	.strict();

const QueueRecordSchema = z
	.object({
		schemaVersion: z.literal(1),
		revision: z.number().int().nonnegative(),
		sessionID: z.string().min(1),
		events: z
			.array(PrFeedbackMonitorEventSchema)
			.max(MAX_PR_FEEDBACK_MONITOR_EVENTS),
	})
	.strict();

const QueueRecordDiskSchema = z
	.object({
		schemaVersion: z.literal(1),
		revision: z.number().int().nonnegative(),
		sessionID: z.string().min(1),
		events: z
			.array(PrFeedbackMonitorEventDiskSchema)
			.max(MAX_PR_FEEDBACK_MONITOR_EVENTS),
	})
	.strict();

const QueueMetadataRecordSchema = z
	.object({
		schemaVersion: z.literal(1),
		revision: z.number().int().nonnegative(),
		sessionID: z.string().min(1),
		events: z
			.array(
				z
					.object({
						dedupToken: z.string().min(1).max(512),
						headRefOid: z.string().min(1).max(256).optional(),
						claimedOwnerPid: z.number().int().positive().optional(),
					})
					.strict(),
			)
			.max(MAX_PR_FEEDBACK_MONITOR_EVENTS),
	})
	.strict();

const trackedQueuesByProjectSession = new Map<
	string,
	PrFeedbackMonitorQueueRecord | null
>();
const pendingQueueMutationsByProjectSession = new Map<string, Promise<void>>();

export async function enqueuePrFeedbackMonitorEvent(
	directory: string,
	sessionID: string,
	event: Omit<
		PrFeedbackMonitorEvent,
		'claimedWorkflowInstanceId' | 'claimedAt' | 'claimedOwnerPid'
	>,
): Promise<PrFeedbackMonitorQueueRecord> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const normalizedEvent = normalizeEvent(event);
	return withQueueMutation(directory, normalizedSessionID, async () => {
		const current =
			(await readPrFeedbackMonitorQueueFromDisk(
				directory,
				normalizedSessionID,
			)) ?? emptyQueueRecord(normalizedSessionID);
		const deduped = current.events.filter(
			(existing) => existing.dedupToken !== normalizedEvent.dedupToken,
		);
		const events = [...deduped, normalizedEvent].slice(
			-MAX_PR_FEEDBACK_MONITOR_EVENTS,
		);
		const nextRecord = QueueRecordSchema.parse({
			...current,
			revision: current.revision + 1,
			events,
		});
		await writeQueueRecord(directory, nextRecord);
		return nextRecord;
	});
}

export async function readPrFeedbackMonitorQueue(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackMonitorQueueRecord | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const record = await readPrFeedbackMonitorQueueFromDisk(
		directory,
		normalizedSessionID,
	);
	rememberQueue(directory, normalizedSessionID, record);
	return record;
}

export async function claimPrFeedbackMonitorEvents(
	directory: string,
	sessionID: string,
	workflowInstanceId: string,
	prUrl: string,
	dedupTokens?: readonly string[],
	ownerPid = process.pid,
): Promise<PrFeedbackMonitorEvent[]> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const normalizedWorkflowInstanceId = workflowInstanceId.trim();
	if (!normalizedWorkflowInstanceId) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue claim requires a workflow instance id',
		);
	}
	if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue claim requires a positive owner PID',
		);
	}
	const canonicalPrUrl = canonicalGitHubPrUrl(prUrl);
	if (!canonicalPrUrl) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue claim requires a canonical GitHub PR URL',
		);
	}
	const selectedTokens = dedupTokens
		? new Set(dedupTokens.map((token) => token.trim()).filter(Boolean))
		: null;
	if (selectedTokens && selectedTokens.size === 0) return [];
	return withQueueMutation(directory, normalizedSessionID, async () => {
		const current = await readPrFeedbackMonitorQueueFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!current || current.events.length === 0) {
			return [];
		}
		const claimedAt = new Date().toISOString();
		let changed = false;
		const claimedEvents = current.events.map((event) => {
			if (
				canonicalGitHubPrUrl(event.prUrl) !== canonicalPrUrl ||
				(selectedTokens && !selectedTokens.has(event.dedupToken))
			) {
				return event;
			}
			if (
				event.claimedWorkflowInstanceId === normalizedWorkflowInstanceId &&
				event.claimedOwnerPid === ownerPid
			) {
				return event;
			}
			const hasClaimMetadata =
				event.claimedWorkflowInstanceId !== undefined ||
				event.claimedOwnerPid !== undefined ||
				event.claimedAt !== undefined;
			if (hasClaimMetadata && !canReclaimDeadClaim(event)) {
				return event;
			}
			changed = true;
			return {
				...event,
				claimedWorkflowInstanceId: normalizedWorkflowInstanceId,
				claimedOwnerPid: ownerPid,
				claimedAt,
			};
		});
		if (!changed) {
			return claimedEvents.filter(
				(event) =>
					event.claimedWorkflowInstanceId === normalizedWorkflowInstanceId &&
					event.claimedOwnerPid === ownerPid &&
					canonicalGitHubPrUrl(event.prUrl) === canonicalPrUrl &&
					(!selectedTokens || selectedTokens.has(event.dedupToken)),
			);
		}
		const nextRecord = QueueRecordSchema.parse({
			...current,
			revision: current.revision + 1,
			events: claimedEvents,
		});
		await writeQueueRecord(directory, nextRecord);
		return nextRecord.events.filter(
			(event) =>
				event.claimedWorkflowInstanceId === normalizedWorkflowInstanceId &&
				event.claimedOwnerPid === ownerPid &&
				canonicalGitHubPrUrl(event.prUrl) === canonicalPrUrl &&
				(!selectedTokens || selectedTokens.has(event.dedupToken)),
		);
	});
}

function canReclaimDeadClaim(event: PrFeedbackMonitorEvent): boolean {
	const workflowInstanceId = event.claimedWorkflowInstanceId?.trim();
	const ownerPid = event.claimedOwnerPid;
	// A legacy or malformed claim has no trustworthy owner boundary. Keep it
	// claimed forever rather than using age or an incomplete identity to risk a
	// duplicate feedback action.
	if (
		!workflowInstanceId ||
		typeof ownerPid !== 'number' ||
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0
	)
		return false;
	return !_internals.isProcessAlive(ownerPid);
}

/**
 * Remove queued events by dedup token (#2502 loop cancellation). Claimed but
 * unsettled events otherwise stay in the queue forever — a claim alone never
 * settles or removes them. Runs under the same queue mutation serialization as
 * every other write; returns the tokens actually removed.
 */
export async function clearPrFeedbackMonitorEvents(
	directory: string,
	sessionID: string,
	dedupTokens: readonly string[],
): Promise<string[]> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const selected = new Set(
		dedupTokens.map((token) => token.trim()).filter(Boolean),
	);
	if (selected.size === 0) return [];
	return withQueueMutation(directory, normalizedSessionID, async () => {
		const current = await readPrFeedbackMonitorQueueFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!current || current.events.length === 0) return [];
		const remaining = current.events.filter(
			(event) => !selected.has(event.dedupToken),
		);
		const removed = current.events
			.filter((event) => selected.has(event.dedupToken))
			.map((event) => event.dedupToken);
		if (removed.length === 0) return [];
		const nextRecord = QueueRecordSchema.parse({
			...current,
			revision: current.revision + 1,
			events: remaining,
		});
		await writeQueueRecord(directory, nextRecord);
		return removed;
	});
}

/**
 * Release one exact workflow-instance claim so a retryable pre-settlement
 * admission failure does not strand the event. The token, workflow id, and
 * owner PID are all required: a later worker must never be able to release
 * another worker's claim (or an unrelated event with the same PR URL).
 */
export async function releasePrFeedbackMonitorEventClaim(
	directory: string,
	sessionID: string,
	dedupToken: string,
	workflowInstanceId: string,
	ownerPid = process.pid,
): Promise<boolean> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const normalizedToken = dedupToken.trim();
	const normalizedWorkflowInstanceId = workflowInstanceId.trim();
	if (
		!normalizedToken ||
		!normalizedWorkflowInstanceId ||
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0
	)
		return false;
	return withQueueMutation(directory, normalizedSessionID, async () => {
		const current = await readPrFeedbackMonitorQueueFromDisk(
			directory,
			normalizedSessionID,
		);
		if (!current || current.events.length === 0) return false;
		let released = false;
		const events = current.events.map((event) => {
			if (
				event.dedupToken !== normalizedToken ||
				event.claimedWorkflowInstanceId !== normalizedWorkflowInstanceId ||
				event.claimedOwnerPid !== ownerPid
			) {
				return event;
			}
			released = true;
			const {
				claimedWorkflowInstanceId: _,
				claimedOwnerPid: ___,
				claimedAt: __,
				...unclaimed
			} = event;
			return unclaimed;
		});
		if (!released) return false;
		await writeQueueRecord(
			directory,
			QueueRecordSchema.parse({
				...current,
				revision: current.revision + 1,
				events,
			}),
		);
		return true;
	});
}

export const _internals = {
	queueRelativePath,
	queueMetadataRelativePath,
	queueLockRelativePath,
	resetQueueCache: () => {
		trackedQueuesByProjectSession.clear();
		pendingQueueMutationsByProjectSession.clear();
		_internals.beforeQueueFileOpen = undefined;
		_internals.beforeQueueLockWrite = undefined;
	},
	rename: fsp.rename,
	nowMs: () => Date.now(),
	isProcessAlive,
	beforeQueueFileOpen: undefined as (() => Promise<void>) | undefined,
	beforeQueueLockWrite: undefined as (() => Promise<void>) | undefined,
};

function normalizeEvent(
	event: Omit<
		PrFeedbackMonitorEvent,
		'claimedWorkflowInstanceId' | 'claimedAt'
	>,
): PrFeedbackMonitorEvent {
	const parsed = PrFeedbackMonitorEventSchema.parse(event);
	if (!canonicalGitHubPrUrl(parsed.prUrl)) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue events require a canonical GitHub PR URL',
		);
	}
	return parsed;
}

function emptyQueueRecord(sessionID: string): PrFeedbackMonitorQueueRecord {
	return {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		events: [],
	};
}

async function writeQueueRecord(
	directory: string,
	record: PrFeedbackMonitorQueueRecord,
): Promise<void> {
	await ensureQueueDirectory(directory, true);
	const filePath = validateSwarmPath(
		directory,
		queueRelativePath(record.sessionID),
	);
	const diskRecord = QueueRecordDiskSchema.parse({
		...record,
		events: record.events.map(
			({ headRefOid: _, claimedOwnerPid: __, ...event }) => event,
		),
	});
	// Write the sidecar first. If the legacy-compatible primary write fails (or
	// a process dies between the two atomic renames), its newer revision will not
	// match the old primary and the extended fields are ignored fail-closed.
	await writeQueueMetadata(directory, record);
	await writePrWorkflowAtomicJson(directory, filePath, diskRecord);
	rememberQueue(directory, record.sessionID, record);
}

/**
 * Extended queue fields are persisted separately so the primary queue record
 * remains readable by the version-1 strict schema shipped by older peers.
 * A revision/session binding makes a stale sidecar fail closed after a legacy
 * peer mutates the primary queue.
 */
async function writeQueueMetadata(
	directory: string,
	record: PrFeedbackMonitorQueueRecord,
): Promise<void> {
	const metadata = QueueMetadataRecordSchema.parse({
		schemaVersion: 1,
		revision: record.revision,
		sessionID: record.sessionID,
		events: record.events
			.filter(
				(event) =>
					event.headRefOid !== undefined || event.claimedOwnerPid !== undefined,
			)
			.map((event) => ({
				dedupToken: event.dedupToken,
				...(event.headRefOid !== undefined
					? { headRefOid: event.headRefOid }
					: {}),
				...(event.claimedOwnerPid !== undefined
					? { claimedOwnerPid: event.claimedOwnerPid }
					: {}),
			})),
	});
	const filePath = validateSwarmPath(
		directory,
		queueMetadataRelativePath(record.sessionID),
	);
	await writePrWorkflowAtomicJson(directory, filePath, metadata);
}

async function withQueueMutation<T>(
	directory: string,
	sessionID: string,
	action: () => Promise<T>,
): Promise<T> {
	const cacheKey = queueCacheKey(directory, sessionID);
	const previous =
		pendingQueueMutationsByProjectSession.get(cacheKey) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	pendingQueueMutationsByProjectSession.set(cacheKey, queued);
	await previous;
	try {
		const lock = await acquireQueueLock(directory, sessionID);
		try {
			return await action();
		} finally {
			await releaseQueueLock(lock);
		}
	} finally {
		release();
		if (pendingQueueMutationsByProjectSession.get(cacheKey) === queued) {
			pendingQueueMutationsByProjectSession.delete(cacheKey);
		}
	}
}

async function acquireQueueLock(
	directory: string,
	sessionID: string,
): Promise<{ path: string; ownerToken: string }> {
	const verifiedQueueDirectory = await ensureQueueDirectory(directory, true);
	if (!verifiedQueueDirectory) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue directory is unavailable',
		);
	}
	const lockPath = validateSwarmPath(
		directory,
		queueLockRelativePath(sessionID),
	);
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await fsp.open(lockPath, 'wx');
			const lock: QueueLockRecord = {
				ownerToken: randomUUID(),
				pid: process.pid,
				createdAtMs: _internals.nowMs(),
			};
			let writeError: unknown;
			try {
				await _internals.beforeQueueLockWrite?.();
				const [openedStat, postQueueDirectory, pathStat, realLockPath] =
					await Promise.all([
						handle.stat({ bigint: true }),
						ensureQueueDirectory(directory, false),
						fsp.lstat(lockPath, { bigint: true }),
						fsp.realpath(lockPath),
					]);
				if (
					!postQueueDirectory ||
					!openedStat.isFile() ||
					pathStat.isSymbolicLink() ||
					!pathStat.isFile() ||
					!sameFileIdentity(openedStat, pathStat) ||
					normalizeComparablePath(postQueueDirectory) !==
						normalizeComparablePath(verifiedQueueDirectory) ||
					normalizeComparablePath(path.dirname(realLockPath)) !==
						normalizeComparablePath(verifiedQueueDirectory)
				) {
					throw new Error(
						'BLOCKED: PR feedback monitor queue lock changed or escaped before initialization',
					);
				}
				await handle.writeFile(JSON.stringify(lock), 'utf-8');
			} catch (error) {
				writeError = error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (writeError) {
				await removeQueueLockIfOwned(lockPath, lock.ownerToken);
				throw writeError;
			}
			return { path: lockPath, ownerToken: lock.ownerToken };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await reclaimAbandonedQueueLock(lockPath)) continue;
			if (attempt < LOCK_MAX_ATTEMPTS - 1) {
				await delay(LOCK_RETRY_DELAY_MS);
			}
		}
	}
	throw new Error(
		'BLOCKED: PR feedback monitor queue is being mutated by another process; retry after that transition finishes',
	);
}

async function releaseQueueLock(lock: {
	path: string;
	ownerToken: string;
}): Promise<void> {
	try {
		await removeQueueLockIfOwned(lock.path, lock.ownerToken);
	} catch {
		// best effort
	}
}

async function reclaimAbandonedQueueLock(lockPath: string): Promise<boolean> {
	const lock = await readQueueLock(lockPath);
	if (lock) {
		if (_internals.isProcessAlive(lock.pid)) return false;
		return removeQueueLockIfOwned(lockPath, lock.ownerToken);
	}
	try {
		const stat = await fsp.stat(lockPath);
		if (_internals.nowMs() - stat.mtimeMs < LOCK_UNINITIALIZED_STALE_MS) {
			return false;
		}
		await fsp.rm(lockPath, { force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

async function readQueueLock(
	lockPath: string,
): Promise<QueueLockRecord | null> {
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
			typeof (parsed as QueueLockRecord).ownerToken === 'string' &&
			(parsed as QueueLockRecord).ownerToken.length > 0 &&
			typeof (parsed as QueueLockRecord).pid === 'number' &&
			Number.isInteger((parsed as QueueLockRecord).pid) &&
			(parsed as QueueLockRecord).pid > 0 &&
			typeof (parsed as QueueLockRecord).createdAtMs === 'number' &&
			Number.isFinite((parsed as QueueLockRecord).createdAtMs)
		) {
			return parsed as QueueLockRecord;
		}
	} catch {
		// recovered below
	}
	return null;
}

async function removeQueueLockIfOwned(
	lockPath: string,
	ownerToken: string,
): Promise<boolean> {
	const lock = await readQueueLock(lockPath);
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
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

async function readPrFeedbackMonitorQueueFromDisk(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackMonitorQueueRecord | null> {
	const verifiedQueueDirectory = await ensureQueueDirectory(directory, false);
	if (!verifiedQueueDirectory) return null;
	const filePath = validateSwarmPath(directory, queueRelativePath(sessionID));
	let handle: Awaited<ReturnType<typeof fsp.open>>;
	let fileIdentity: BigIntStats;
	try {
		const lstat = await fsp.lstat(filePath, { bigint: true });
		if (
			lstat.isSymbolicLink() ||
			!lstat.isFile() ||
			lstat.size > BigInt(MAX_QUEUE_BYTES)
		) {
			throw new Error(
				`BLOCKED: PR feedback monitor queue for session "${sessionID}" must be a bounded regular file`,
			);
		}
		fileIdentity = lstat;
		await _internals.beforeQueueFileOpen?.();
		handle = await fsp.open(filePath, 'r');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let raw: string;
	try {
		const stat = await handle.stat({ bigint: true });
		if (
			!stat.isFile() ||
			stat.size > BigInt(MAX_QUEUE_BYTES) ||
			!sameFileIdentity(fileIdentity, stat)
		) {
			throw new Error(
				`BLOCKED: PR feedback monitor queue for session "${sessionID}" changed during its bounded read`,
			);
		}
		const [postQueueDirectory, postPathStat, postRealPath] = await Promise.all([
			ensureQueueDirectory(directory, false),
			fsp.lstat(filePath, { bigint: true }),
			fsp.realpath(filePath),
		]);
		if (
			!postQueueDirectory ||
			normalizeComparablePath(postQueueDirectory) !==
				normalizeComparablePath(verifiedQueueDirectory) ||
			postPathStat.isSymbolicLink() ||
			!postPathStat.isFile() ||
			!sameFileIdentity(fileIdentity, postPathStat) ||
			!sameFileIdentity(stat, postPathStat) ||
			normalizeComparablePath(path.dirname(postRealPath)) !==
				normalizeComparablePath(verifiedQueueDirectory)
		) {
			throw new Error(
				`BLOCKED: PR feedback monitor queue for session "${sessionID}" changed or escaped during its bounded read`,
			);
		}
		const buffer = Buffer.allocUnsafe(MAX_QUEUE_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_QUEUE_BYTES) {
			throw new Error(
				`BLOCKED: PR feedback monitor queue for session "${sessionID}" exceeds its size limit`,
			);
		}
		raw = buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		throw new Error(
			`BLOCKED: PR feedback monitor queue for session "${sessionID}" is not valid JSON`,
		);
	}
	const parsed = QueueRecordDiskSchema.safeParse(parsedJson);
	if (parsed.success) {
		return mergeQueueMetadata(directory, parsed.data);
	}
	// A newer worker may have written the extended fields before this
	// compatibility projection was installed. Read that one-generation shape
	// so the next mutation can rewrite the primary file in the old-peer format;
	// never accept an arbitrary unknown schema.
	const extended = QueueRecordSchema.safeParse(parsedJson);
	if (!extended.success) {
		throw new Error(
			`BLOCKED: PR feedback monitor queue for session "${sessionID}" is invalid`,
		);
	}
	return extended.data;
}

async function mergeQueueMetadata(
	directory: string,
	record: z.infer<typeof QueueRecordDiskSchema>,
): Promise<PrFeedbackMonitorQueueRecord> {
	const metadata = await readQueueMetadata(directory, record.sessionID);
	if (
		!metadata ||
		metadata.revision !== record.revision ||
		metadata.sessionID !== record.sessionID
	) {
		return record;
	}
	const metadataByToken = new Map(
		metadata.events.map((event) => [event.dedupToken, event]),
	);
	return {
		...record,
		events: record.events.map((event) => {
			const extended = metadataByToken.get(event.dedupToken);
			if (!extended) return event;
			return {
				...event,
				...(extended.headRefOid !== undefined
					? { headRefOid: extended.headRefOid }
					: {}),
				...(extended.claimedOwnerPid !== undefined
					? { claimedOwnerPid: extended.claimedOwnerPid }
					: {}),
			};
		}),
	};
}

async function readQueueMetadata(
	directory: string,
	sessionID: string,
): Promise<z.infer<typeof QueueMetadataRecordSchema> | null> {
	const queueDirectory = await ensureQueueDirectory(directory, false);
	if (!queueDirectory) return null;
	const filePath = validateSwarmPath(
		directory,
		queueMetadataRelativePath(sessionID),
	);
	let stat: Awaited<ReturnType<typeof fsp.lstat>>;
	try {
		stat = await fsp.lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let realPath: string;
	try {
		realPath = await fsp.realpath(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		stat.size > MAX_QUEUE_BYTES ||
		normalizeComparablePath(path.dirname(realPath)) !==
			normalizeComparablePath(queueDirectory)
	) {
		throw new Error(
			`BLOCKED: PR feedback monitor queue metadata for session "${sessionID}" must be a bounded regular file`,
		);
	}
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		throw new Error(
			`BLOCKED: PR feedback monitor queue metadata for session "${sessionID}" is not valid JSON`,
		);
	}
	const parsed = QueueMetadataRecordSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(
			`BLOCKED: PR feedback monitor queue metadata for session "${sessionID}" is invalid`,
		);
	}
	return parsed.data;
}

function sameFileIdentity(
	left: Pick<BigIntStats, 'dev' | 'ino'>,
	right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function ensureQueueDirectory(
	directory: string,
	create: boolean,
): Promise<string | null> {
	const swarmRoot = path.resolve(directory, '.swarm');
	const queueDirectory = path.join(swarmRoot, PR_FEEDBACK_EVENT_QUEUE_DIR);
	if (create) {
		await ensurePrWorkflowSafeParentDirectory(
			directory,
			path.join(queueDirectory, '.containment-probe'),
		);
	} else {
		try {
			await rejectUnsafeDirectory(swarmRoot, '.swarm');
			await rejectUnsafeDirectory(
				queueDirectory,
				`.swarm/${PR_FEEDBACK_EVENT_QUEUE_DIR}`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}
	await rejectUnsafeDirectory(
		queueDirectory,
		`.swarm/${PR_FEEDBACK_EVENT_QUEUE_DIR}`,
	);
	const [realRoot, realQueue] = await Promise.all([
		fsp.realpath(swarmRoot),
		fsp.realpath(queueDirectory),
	]);
	const expectedParent = normalizeComparablePath(realRoot);
	if (normalizeComparablePath(path.dirname(realQueue)) !== expectedParent) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue directory escapes the project .swarm root',
		);
	}
	return realQueue;
}

async function rejectUnsafeDirectory(
	directoryPath: string,
	label: string,
): Promise<void> {
	const stat = await fsp.lstat(directoryPath);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(
			`BLOCKED: PR feedback monitor queue ${label} path must be a real directory`,
		);
	}
}

function normalizeComparablePath(value: string): string {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function rememberQueue(
	directory: string,
	sessionID: string,
	record: PrFeedbackMonitorQueueRecord | null,
): void {
	const cacheKey = queueCacheKey(directory, sessionID);
	trackedQueuesByProjectSession.delete(cacheKey);
	trackedQueuesByProjectSession.set(cacheKey, record);
	while (trackedQueuesByProjectSession.size > MAX_TRACKED_SESSIONS) {
		const oldestKey = trackedQueuesByProjectSession.keys().next().value;
		if (!oldestKey) break;
		trackedQueuesByProjectSession.delete(oldestKey);
	}
}

function queueCacheKey(directory: string, sessionID: string): string {
	return `${canonicalRootKeyFresh(directory)}\u0000${sessionID}`;
}

function normalizeSessionID(sessionID: string): string {
	const normalized = sessionID.trim();
	if (!normalized || normalized.length > 512) {
		throw new Error(
			'BLOCKED: PR feedback monitor queue requires a non-empty sessionID',
		);
	}
	return normalized;
}

function canonicalGitHubPrUrl(value: string): string | null {
	try {
		const url = new URL(value);
		const matched = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
		if (
			url.protocol !== 'https:' ||
			url.hostname.toLowerCase() !== 'github.com' ||
			!matched
		) {
			return null;
		}
		const prNumber = Number(matched[3]);
		if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
		return `github.com/${matched[1].toLowerCase()}/${matched[2].toLowerCase()}/pull/${prNumber}`;
	} catch {
		return null;
	}
}

function queueRelativePath(sessionID: string): string {
	return path.join(
		PR_FEEDBACK_EVENT_QUEUE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.json`,
	);
}

function queueMetadataRelativePath(sessionID: string): string {
	return path.join(
		PR_FEEDBACK_EVENT_QUEUE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.meta.json`,
	);
}

function queueLockRelativePath(sessionID: string): string {
	return path.join(
		PR_FEEDBACK_EVENT_QUEUE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.lock`,
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
