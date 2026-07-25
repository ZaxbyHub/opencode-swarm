/**
 * Session-keyed bounded candidate queue (issue #1821, Workstream B).
 *
 * The micro-reflector emits insight candidates while a session is live. Before
 * this module they were only readable at a phase boundary, so a lesson learned
 * in step 3 could not help step 40 of the same session. This queue is the
 * in-memory hand-off that makes same-session admission possible: the reflector
 * enqueues, and the `Task`-tool drain adapter admits.
 *
 * Everything here is bounded on purpose (AGENTS.md invariant 8):
 *
 * - the KEY count is capped at `MAX_TRACKED_SESSIONS` with FIFO eviction,
 *   mirroring `recentToolCallsBySession` in `src/hooks/adversarial-detector.ts`;
 * - each session's item list is capped at `max_queue_size` with drop-oldest
 *   plus a `dropped` counter, so a flood is observable rather than silent;
 * - the LLM-call, token, and retry budgets are per-session ceilings that only
 *   ever count up within a session and are released wholesale on reset.
 *
 * This module performs NO I/O and holds no clock dependency beyond `Date.now`
 * (injectable through `_internals` for deterministic tests). The admission side
 * effects live in `./admission.ts`; keeping them apart lets the queue be tested
 * without touching the knowledge store.
 */

import type { InsightCandidate } from '../hooks/micro-reflector.js';

/**
 * Hard ceiling on distinct sessions tracked at once. Copied deliberately from
 * `adversarial-detector.ts` so every module-level session map in the plugin
 * evicts on the same rule.
 */
export const MAX_TRACKED_SESSIONS = 500;

/**
 * Hard ceiling on how many drain cycles a single candidate may be claimed by.
 *
 * A candidate deferred by the wall-clock budget is requeued for the next drain.
 * Without this bound a session whose budget always expires would bounce the same
 * candidate forever, so the per-candidate retry cap would be satisfied while the
 * queue still never made progress (AGENTS.md invariant 8).
 */
export const MAX_CANDIDATE_DRAIN_ATTEMPTS = 5;

/** Per-session ceilings applied when a candidate is enqueued or budget is spent. */
export interface CandidateQueueLimits {
	/** Hard cap on pending candidates; the OLDEST is dropped past this. */
	maxQueueSize: number;
	/** Per-session ceiling on admission LLM calls. 0 disables LLM admission. */
	maxLlmCallsPerSession: number;
	/** Per-session ceiling on admission tokens. */
	maxTokensPerSession: number;
}

/** Inputs to the adaptive drain sizer. Mirrors `learning.realtime_admission`. */
export interface DrainSizeLimits {
	/** Minimum candidates drained per cycle. */
	minDrain: number;
	/** Maximum candidates drained per cycle. */
	maxDrain: number;
	/** Weight of queue depth when sizing a drain (0 = ignore depth). */
	drainDepthFactor: number;
	/** Weight of arrival velocity when sizing a drain (0 = ignore rate). */
	drainVelocityFactor: number;
}

/** One queued candidate plus the bookkeeping the drain needs. */
export interface QueuedCandidate {
	candidate: InsightCandidate;
	/** Epoch millis the candidate entered the queue. */
	enqueuedAt: number;
	/** How many drain attempts this candidate has already survived. */
	attempts: number;
}

interface SessionQueue {
	items: QueuedCandidate[];
	/** Count of candidates evicted by the `maxQueueSize` cap. Never reset by a drain. */
	dropped: number;
	llmCallsUsed: number;
	tokensUsed: number;
	retriesUsed: number;
	/** Epoch millis of the last drain, or of session creation before the first. */
	lastDrainAt: number;
	/** Arrivals since `lastDrainAt`, the numerator of the velocity estimate. */
	enqueuedSinceLastDrain: number;
}

/** Read-only projection of a session's queue state. Test/observability seam. */
export interface QueueStats {
	depth: number;
	dropped: number;
	llmCallsUsed: number;
	tokensUsed: number;
	retriesUsed: number;
	lastDrainAt: number;
	enqueuedSinceLastDrain: number;
}

export interface EnqueueResult {
	/** False only when the candidate was rejected outright (invalid session id). */
	enqueued: boolean;
	/** Queue depth AFTER the enqueue (and after any drop-oldest eviction). */
	depth: number;
	/** Cumulative drop count for the session. */
	dropped: number;
	/** True when this enqueue evicted the oldest pending candidate. */
	evictedOldest: boolean;
}

const queuesBySession = new Map<string, SessionQueue>();

/** Injectable clock — tests pin time instead of sleeping. */
export const _internals: { now: () => number } = { now: () => Date.now() };

function createQueue(now: number): SessionQueue {
	return {
		items: [],
		dropped: 0,
		llmCallsUsed: 0,
		tokensUsed: 0,
		retriesUsed: 0,
		lastDrainAt: now,
		enqueuedSinceLastDrain: 0,
	};
}

/**
 * Fetch (or create) a session queue, FIFO-evicting the oldest KEY past
 * `MAX_TRACKED_SESSIONS`. Skips evicting the entry just created, matching
 * `adversarial-detector.ts` exactly.
 */
function getOrCreateQueue(sessionID: string): SessionQueue {
	let queue = queuesBySession.get(sessionID);
	if (!queue) {
		queue = createQueue(_internals.now());
		queuesBySession.set(sessionID, queue);
		// FIFO-cap the KEY count to bound memory. The per-session item array is
		// separately bounded by `maxQueueSize`; this bounds the number of distinct
		// session keys. Skip evicting the entry we just created.
		while (queuesBySession.size > MAX_TRACKED_SESSIONS) {
			const oldest = queuesBySession.keys().next().value;
			if (oldest === undefined || oldest === sessionID) break;
			queuesBySession.delete(oldest);
		}
	}
	return queue;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return Number.isFinite(value) && Number(value) > 0
		? Math.floor(Number(value))
		: fallback;
}

/**
 * Enqueue one candidate for same-session admission.
 *
 * Drop-oldest (not drop-newest) on overflow: a flood of candidates is far more
 * likely to be a repeating failure mode, and the NEWEST observation is the one
 * most likely to reflect the agent's current state. The `dropped` counter makes
 * the loss observable to `getQueueStats` rather than silent.
 */
export function enqueueCandidate(
	sessionID: string,
	candidate: InsightCandidate,
	limits: Pick<CandidateQueueLimits, 'maxQueueSize'>,
): EnqueueResult {
	if (typeof sessionID !== 'string' || sessionID.length === 0) {
		return { enqueued: false, depth: 0, dropped: 0, evictedOldest: false };
	}
	const queue = getOrCreateQueue(sessionID);
	const maxQueueSize = positiveIntOr(limits.maxQueueSize, 50);
	queue.items.push({
		candidate,
		enqueuedAt: _internals.now(),
		attempts: 0,
	});
	queue.enqueuedSinceLastDrain++;
	let evictedOldest = false;
	while (queue.items.length > maxQueueSize) {
		queue.items.shift();
		queue.dropped++;
		evictedOldest = true;
	}
	return {
		enqueued: true,
		depth: queue.items.length,
		dropped: queue.dropped,
		evictedOldest,
	};
}

/**
 * Adaptive drain size (AC9). Pure: no module state is read, so it is unit
 * testable in isolation.
 *
 *   size = ceil(minDrain + depthFactor * depth + velocityFactor * velocity)
 *
 * then clamped into `[minDrain, maxDrain]` and finally capped by the actual
 * depth — a drain never claims more than exists. `ceil` (rather than `round`)
 * biases marginally toward draining, because a candidate left in the queue is
 * a lesson the current session cannot use yet.
 *
 * @param depth     Pending candidates in the queue.
 * @param velocity  Arrivals per second since the last drain.
 */
export function computeDrainSize(
	depth: number,
	velocity: number,
	limits: DrainSizeLimits,
): number {
	if (!Number.isFinite(depth) || depth <= 0) return 0;
	const minDrain = positiveIntOr(limits.minDrain, 1);
	// maxDrain can never be below minDrain: a config with max < min would
	// otherwise make the clamp order decide the result.
	const maxDrain = Math.max(minDrain, positiveIntOr(limits.maxDrain, minDrain));
	const depthFactor = clampUnit(limits.drainDepthFactor);
	const velocityFactor = clampUnit(limits.drainVelocityFactor);
	const safeVelocity = Number.isFinite(velocity) && velocity > 0 ? velocity : 0;
	const adaptive =
		minDrain + depthFactor * depth + velocityFactor * safeVelocity;
	const bounded = Math.min(Math.max(Math.ceil(adaptive), minDrain), maxDrain);
	return Math.min(bounded, Math.floor(depth));
}

function clampUnit(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return n > 1 ? 1 : n;
}

/**
 * Arrivals per second since the session's last drain. Returns 0 for a session
 * that has never been drained within the same millisecond as its first
 * enqueue, so velocity can never be infinite.
 */
export function computeArrivalVelocity(stats: QueueStats, now: number): number {
	const elapsedMs = now - stats.lastDrainAt;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
	return (stats.enqueuedSinceLastDrain * 1000) / elapsedMs;
}

/**
 * Remove and return up to `size` oldest candidates, marking the drain point.
 * Resets the velocity numerator so the next cycle measures a fresh interval.
 */
export function takeDrainBatch(
	sessionID: string,
	size: number,
): QueuedCandidate[] {
	const queue = queuesBySession.get(sessionID);
	if (!queue || queue.items.length === 0) return [];
	const count = Math.max(0, Math.min(Math.floor(size), queue.items.length));
	const batch = queue.items.splice(0, count);
	queue.lastDrainAt = _internals.now();
	queue.enqueuedSinceLastDrain = 0;
	for (const item of batch) item.attempts++;
	return batch;
}

/**
 * Return an unfinished candidate to the FRONT of the queue so the next drain
 * retries it before newer arrivals. Respects `maxQueueSize` by dropping the
 * newest tail entry rather than the requeued item — the item already consumed
 * budget, so discarding it would waste that spend.
 */
export function requeueCandidate(
	sessionID: string,
	item: QueuedCandidate,
	limits: Pick<CandidateQueueLimits, 'maxQueueSize'>,
): void {
	const queue = queuesBySession.get(sessionID);
	if (!queue) return;
	const maxQueueSize = positiveIntOr(limits.maxQueueSize, 50);
	queue.items.unshift(item);
	while (queue.items.length > maxQueueSize) {
		queue.items.pop();
		queue.dropped++;
	}
}

/** O(1) pending-work probe used by the hot-path drain adapter. */
export function getQueueDepth(sessionID?: string): number {
	if (!sessionID) return 0;
	return queuesBySession.get(sessionID)?.items.length ?? 0;
}

/**
 * Reserve LLM budget for one admission call. Returns false when either the
 * call ceiling or the token ceiling would be exceeded; the caller then admits
 * without LLM assistance rather than failing the candidate.
 */
export function reserveLlmBudget(
	sessionID: string,
	estimatedTokens: number,
	limits: Pick<
		CandidateQueueLimits,
		'maxLlmCallsPerSession' | 'maxTokensPerSession'
	>,
): boolean {
	const queue = queuesBySession.get(sessionID);
	if (!queue) return false;
	const maxCalls = Math.max(
		0,
		Math.floor(Number(limits.maxLlmCallsPerSession) || 0),
	);
	const maxTokens = Math.max(
		0,
		Math.floor(Number(limits.maxTokensPerSession) || 0),
	);
	if (maxCalls === 0 || maxTokens === 0) return false;
	const tokens = Math.max(0, Math.floor(Number(estimatedTokens) || 0));
	if (queue.llmCallsUsed + 1 > maxCalls) return false;
	if (queue.tokensUsed + tokens > maxTokens) return false;
	queue.llmCallsUsed++;
	queue.tokensUsed += tokens;
	return true;
}

/**
 * Record that a retry was spent, returning the session's running total.
 *
 * The BOUND lives on the admission side, per candidate
 * (`max_retries_per_candidate`); this counter is the session-wide observability
 * view. Total retries per drain is therefore bounded by
 * `max_retries_per_candidate * batchSize`, and `batchSize` is itself bounded by
 * `max_drain`, so the product is bounded without a second cap here.
 */
export function recordRetry(sessionID: string): number {
	const queue = queuesBySession.get(sessionID);
	if (!queue) return 0;
	queue.retriesUsed++;
	return queue.retriesUsed;
}

/** Read-only stats for a session. Returns a zeroed record for unknown ids. */
export function getQueueStats(sessionID?: string): QueueStats {
	const queue = sessionID ? queuesBySession.get(sessionID) : undefined;
	if (!queue) {
		return {
			depth: 0,
			dropped: 0,
			llmCallsUsed: 0,
			tokensUsed: 0,
			retriesUsed: 0,
			lastDrainAt: 0,
			enqueuedSinceLastDrain: 0,
		};
	}
	return {
		depth: queue.items.length,
		dropped: queue.dropped,
		llmCallsUsed: queue.llmCallsUsed,
		tokensUsed: queue.tokensUsed,
		retriesUsed: queue.retriesUsed,
		lastDrainAt: queue.lastDrainAt,
		enqueuedSinceLastDrain: queue.enqueuedSinceLastDrain,
	};
}

/** Drop one session's queue, or every session when `sessionID` is omitted. */
export function resetSessionQueue(sessionID?: string): void {
	if (sessionID === undefined) {
		queuesBySession.clear();
		return;
	}
	queuesBySession.delete(sessionID);
}

/** Number of distinct sessions currently tracked. Bound-eviction test seam. */
export function getTrackedSessionCount(): number {
	return queuesBySession.size;
}

/**
 * Tier-0 pure-function seam (see the writing-tests skill).
 *
 * `clampUnit` is defensive: `computeDrainSize` caps its result by the actual
 * depth, so an un-clamped factor is not observable through the public function
 * and could be deleted with the whole suite green. Exporting it here lets the
 * clamp be asserted directly instead of being untestable dead defence.
 */
export const _test_exports = { clampUnit };
