/**
 * Durable PR monitoring subscription store.
 *
 * Append-only JSONL event log under project-root
 * `.swarm/pr-monitor/subscriptions.jsonl`. Each line is a full record snapshot;
 * readers fold to the latest snapshot per `correlationId`. This tracks which PRs
 * are actively being monitored by which sessions so the background poller knows
 * what to watch.
 *
 * Concurrency: all writes (subscribe, unsubscribe, update, sweep) run under a
 * single project-scoped lock via `withEvidenceLock`, so concurrent callers cannot
 * interleave appends. Reads are lock-free (line-oriented; partial trailing lines
 * are skipped defensively).
 *
 * Containment: the path is validated with `validateSwarmPath`, so it can never
 * escape `.swarm/` (Invariant 4).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { withEvidenceLock } from '../evidence/lock.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { log } from '../utils';

export const PR_SUBSCRIPTIONS_FILE = 'pr-monitor/subscriptions.jsonl';

/** Lock + diagnostics identity for the project-scoped store lock. */
const STORE_LOCK_AGENT = 'pr-monitor';
const STORE_LOCK_TASK = 'pr-subscriptions';

/**
 * Lazy-start callback — set by plugin init to start the PR monitor worker
 * when the first subscription is created. Decouples pr-subscriptions from
 * src/index.ts to avoid circular dependencies. Receives the full record so
 * the worker can extract session context for lazy initialization.
 */
let onSubscriptionCreated:
	| ((directory: string, record: PrSubscriptionRecord) => void)
	| null = null;

/**
 * Register the lazy-start callback invoked after a successful subscription.
 * Called once during plugin init to wire the PR monitor worker lifecycle.
 */
export function setOnSubscriptionCreated(
	callback: (directory: string, record: PrSubscriptionRecord) => void,
): void {
	onSubscriptionCreated = callback;
}

export type PrSubscriptionStatus = 'active' | 'removed' | 'expired';

/**
 * A durable PR monitoring subscription record. Each append to the JSONL log
 * is a full snapshot; readers fold by correlationId (last-write-wins).
 */
export interface PrSubscriptionRecord {
	/** Composite key: `${sessionID}::${repoFullName}::${prNumber}`. */
	correlationId: string;
	sessionID: string;
	prNumber: number;
	/** e.g. "owner/repo". */
	repoFullName: string;
	prUrl: string;
	headRefOid?: string;
	/** Epoch ms — last time the poller checked this PR. */
	lastCheckedAt: number;
	lastCommentId?: string;
	/** JSON stringified array of check names + conclusions. */
	lastCheckRunSet?: string;
	mergeableState?: string;
	isWatching: boolean;
	/** Guard for cleanup sweep — subscriptions with unaddressed events are retained. */
	hasUnaddressedEvents: boolean;
	status: PrSubscriptionStatus;
	/** Epoch ms — when the subscription was first created. */
	createdAt: number;
	/** Epoch ms — when this snapshot was written. */
	updatedAt: number;
	errorCount: number;
	/** Per-PR poll-interval override (FR-017). */
	customPollIntervalSeconds?: number;
	customFailureThreshold?: number;
	customCooldownSeconds?: number;
}

export interface SubscribeInput {
	sessionID: string;
	prNumber: number;
	repoFullName: string;
	prUrl: string;
	/** Max active subscriptions allowed (for limit enforcement). */
	maxSubscriptions?: number;
}

const RecordSchema = z
	.object({
		correlationId: z.string().min(1),
		sessionID: z.string().min(1),
		prNumber: z.number().int().positive(),
		repoFullName: z.string().min(1),
		prUrl: z.string().min(1),
		headRefOid: z.string().optional(),
		lastCheckedAt: z.number(),
		lastCommentId: z.string().optional(),
		lastCheckRunSet: z.string().optional(),
		mergeableState: z.string().optional(),
		isWatching: z.boolean(),
		hasUnaddressedEvents: z.boolean(),
		status: z.enum(['active', 'removed', 'expired']),
		createdAt: z.number(),
		updatedAt: z.number(),
		errorCount: z.number().int().min(0),
		customPollIntervalSeconds: z.number().int().positive().optional(),
		customFailureThreshold: z.number().int().min(0).optional(),
		customCooldownSeconds: z.number().int().min(0).optional(),
	})
	.strict();

function storePath(directory: string): string {
	return validateSwarmPath(directory, PR_SUBSCRIPTIONS_FILE);
}

function ensureSwarmDir(directory: string): void {
	fs.mkdirSync(path.resolve(directory, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
}

/**
 * Build the composite correlation key from session, repo, and PR number.
 */
export function buildCorrelationId(
	sessionID: string,
	repoFullName: string,
	prNumber: number,
): string {
	return `${sessionID}::${repoFullName}::${prNumber}`;
}

/**
 * Read and fold the store to the latest snapshot per correlationId. Lock-free
 * and defensive: a missing file yields an empty list, and malformed/partial
 * lines are skipped (never throws). Records are returned in first-seen
 * correlationId order.
 */
function readAllRecords(directory: string): PrSubscriptionRecord[] {
	let raw: string;
	try {
		raw = fs.readFileSync(storePath(directory), 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		log(
			`[pr-monitor] readAllRecords failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}

	const folded = new Map<string, PrSubscriptionRecord>();
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

function appendRecord(directory: string, record: PrSubscriptionRecord): void {
	ensureSwarmDir(directory);
	fs.appendFileSync(
		storePath(directory),
		`${JSON.stringify(record)}\n`,
		'utf-8',
	);
}

/**
 * Subscribe to PR monitoring. Appends a new `active` subscription record. If an
 * active subscription with the same correlationId already exists, returns the
 * existing record (idempotent). Throws if the number of active subscriptions
 * exceeds `input.maxSubscriptions` (when provided).
 *
 * Runs a lazy stale sweep before the append (same pattern as
 * pending-delegations.ts).
 */
export async function subscribe(
	directory: string,
	input: SubscribeInput,
): Promise<PrSubscriptionRecord> {
	// Validate required inputs
	if (!directory || directory.trim() === '') {
		throw new Error('directory is required');
	}
	if (!input.sessionID || input.sessionID.trim() === '') {
		throw new Error('sessionID is required and must be non-empty');
	}
	if (!input.repoFullName || input.repoFullName.trim() === '') {
		throw new Error('repoFullName is required and must be non-empty');
	}
	if (!input.prUrl || input.prUrl.trim() === '') {
		throw new Error('prUrl is required and must be non-empty');
	}
	if (
		!input.prNumber ||
		!Number.isInteger(input.prNumber) ||
		input.prNumber <= 0
	) {
		throw new Error('prNumber is required and must be a positive integer');
	}

	const correlationId = buildCorrelationId(
		input.sessionID,
		input.repoFullName,
		input.prNumber,
	);
	const now = Date.now();

	return withEvidenceLock(
		directory,
		PR_SUBSCRIPTIONS_FILE,
		STORE_LOCK_AGENT,
		STORE_LOCK_TASK,
		async () => {
			const existing = readAllRecords(directory);
			const match = existing.find(
				(r) => r.correlationId === correlationId && r.status === 'active',
			);
			if (match) {
				// Lazy-start trigger for existing subscription (e.g., after plugin restart)
				onSubscriptionCreated?.(directory, match);
				return match;
			}

			// Enforce max-subscription limit when configured
			if (input.maxSubscriptions !== undefined && input.maxSubscriptions > 0) {
				const activeCount = existing.filter(
					(r) => r.status === 'active',
				).length;
				if (activeCount >= input.maxSubscriptions) {
					throw new Error(
						`PR subscription limit reached: ${activeCount}/${input.maxSubscriptions}`,
					);
				}
			}

			const record: PrSubscriptionRecord = {
				correlationId,
				sessionID: input.sessionID,
				prNumber: input.prNumber,
				repoFullName: input.repoFullName,
				prUrl: input.prUrl,
				lastCheckedAt: now,
				isWatching: true,
				hasUnaddressedEvents: false,
				status: 'active',
				createdAt: now,
				updatedAt: now,
				errorCount: 0,
			};

			appendRecord(directory, record);

			// Lazy-start trigger: ensure the PR monitor worker is running
			// now that we have at least one active subscription.
			onSubscriptionCreated?.(directory, record);

			return record;
		},
	);
}

/**
 * Unsubscribe from PR monitoring. Appends a new record with `status='removed'`
 * for the given correlationId. Correlation-key folding means the latest record
 * wins. Returns the folded record after the write, or null if no active
 * subscription was found.
 */
export async function unsubscribe(
	directory: string,
	correlationId: string,
): Promise<PrSubscriptionRecord | null> {
	if (!correlationId) return null;

	return withEvidenceLock(
		directory,
		PR_SUBSCRIPTIONS_FILE,
		STORE_LOCK_AGENT,
		STORE_LOCK_TASK,
		async () => {
			const existing = readAllRecords(directory);
			const match = existing.find(
				(r) => r.correlationId === correlationId && r.status === 'active',
			);
			if (!match) return null;

			const now = Date.now();
			const removed: PrSubscriptionRecord = {
				...match,
				status: 'removed',
				isWatching: false,
				updatedAt: now,
			};
			appendRecord(directory, removed);
			return removed;
		},
	);
}

/**
 * List all active subscriptions. Lock-free read that folds the JSONL and
 * returns only records with `status='active'`.
 */
export async function listActive(
	directory: string,
): Promise<PrSubscriptionRecord[]> {
	return readAllRecords(directory).filter((r) => r.status === 'active');
}

/**
 * Look up an active subscription for a specific PR. Lock-free read.
 */
export async function lookupByPr(
	directory: string,
	repoFullName: string,
	prNumber: number,
): Promise<PrSubscriptionRecord | null> {
	for (const record of readAllRecords(directory)) {
		if (
			record.status === 'active' &&
			record.repoFullName === repoFullName &&
			record.prNumber === prNumber
		) {
			return record;
		}
	}
	return null;
}

/**
 * Update the snapshot for a given correlationId. Merges `updates` into the
 * existing active record and appends the new snapshot. Returns the merged
 * record, or null if no active subscription was found.
 */
export async function updateSnapshot(
	directory: string,
	correlationId: string,
	updates: Partial<PrSubscriptionRecord>,
): Promise<PrSubscriptionRecord | null> {
	if (!correlationId) return null;

	return withEvidenceLock(
		directory,
		PR_SUBSCRIPTIONS_FILE,
		STORE_LOCK_AGENT,
		STORE_LOCK_TASK,
		async () => {
			const existing = readAllRecords(directory);
			const match = existing.find(
				(r) => r.correlationId === correlationId && r.status === 'active',
			);
			if (!match) return null;

			const updated: PrSubscriptionRecord = {
				...match,
				...updates,
				// Preserve all identity/lookup fields — never allow mutation via updates
				correlationId,
				sessionID: match.sessionID,
				repoFullName: match.repoFullName,
				prNumber: match.prNumber,
				prUrl: match.prUrl,
				createdAt: match.createdAt,
				updatedAt: Date.now(),
			};
			appendRecord(directory, updated);
			return updated;
		},
	);
}

/**
 * Sweep stale subscriptions. Marks subscriptions as `expired` when:
 *   (a) They are `active` AND appear in the `mergedPrs` set (PR was merged/closed), OR
 *   (b) They have had no state change for `ttlDays` AND `hasUnaddressedEvents` is false.
 *
 * Subscriptions with `hasUnaddressedEvents === true` are NEVER swept unless the
 * PR is in the merged/closed set.
 *
 * @param directory - Project root directory
 * @param ttlDays - Days of inactivity before considering a subscription stale
 * @param mergedPrs - Set of "repoFullName::prNumber" strings for merged/closed PRs
 * @returns Number of subscriptions swept
 */
export async function sweepStale(
	directory: string,
	ttlDays: number,
	mergedPrs?: ReadonlySet<string>,
): Promise<number> {
	if (!ttlDays || ttlDays <= 0) return 0;
	const ttlMs = ttlDays * 86_400_000;
	const now = Date.now();

	try {
		return await withEvidenceLock(
			directory,
			PR_SUBSCRIPTIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				let swept = 0;
				for (const record of readAllRecords(directory)) {
					if (record.status !== 'active') continue;

					const prKey = `${record.repoFullName}::${record.prNumber}`;
					const isMerged = mergedPrs?.has(prKey) ?? false;
					const isStale = now - record.updatedAt > ttlMs;

					// Sweep merged/closed PRs regardless of events
					if (isMerged) {
						appendRecord(directory, {
							...record,
							status: 'expired',
							isWatching: false,
							updatedAt: now,
						});
						swept += 1;
						log(`[pr-monitor] Swept subscription: merged/closed: ${prKey}`);
						continue;
					}

					// Sweep stale subscriptions only if no unaddressed events
					if (isStale && !record.hasUnaddressedEvents) {
						appendRecord(directory, {
							...record,
							status: 'expired',
							isWatching: false,
							updatedAt: now,
						});
						swept += 1;
						log(
							`[pr-monitor] Swept subscription: stale (TTL ${ttlDays}d): ${prKey}`,
						);
					}
				}
				return swept;
			},
		);
	} catch (err) {
		log(
			`[pr-monitor] sweepStale failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 0;
	}
}
