/**
 * PR Monitor Worker
 *
 * Background polling worker that periodically checks subscribed PRs for status
 * changes (CI, comments, merge conflicts, merge/close events) and publishes
 * automation events. Follows the PlanSyncWorker standalone class pattern with
 * start/stop/dispose lifecycle and bounded, fail-open operation.
 */

import type { PrMonitorConfig } from '../config/schema';
import {
	getMergeState,
	getPRComments,
	getPRReviewState,
	getPRStatus,
	type MergeStateResult,
	type PRCommentResult,
	type PRStatusResult,
	type ReviewStateResult,
} from '../git/pr';
import { log } from '../utils';
import { type AutomationEventType, getGlobalEventBus } from './event-bus';
import {
	listActive,
	type PrSubscriptionRecord,
	sweepStale,
	unsubscribe,
	updateSnapshot,
} from './pr-subscriptions';

// ── Types ────────────────────────────────────────────────────────────

/** Configuration options for PrMonitorWorker construction. */
export interface PrMonitorWorkerOptions {
	/** Project root directory (parent of .swarm/). */
	directory: string;
	/** Parsed pr_monitor config from schema. */
	config: PrMonitorConfig;
	/** Optional callback for emitted events (in addition to event bus). */
	onEvent?: (event: AutomationEvent<unknown>) => void;
}

/** Worker status machine states. */
export type PrMonitorWorkerStatus =
	| 'stopped'
	| 'starting'
	| 'running'
	| 'stopping';

/** Typed wrapper around AutomationEvent for PR monitor payloads. */
export interface AutomationEvent<T = unknown> {
	type: AutomationEventType;
	timestamp: number;
	payload: T;
	source: string;
}

/** Per-PR circuit-breaker suspension metadata (tracked in memory, not persisted). */
interface CircuitBreakerState {
	errorCount: number;
	suspendedUntil: number;
	cooldownLevel: number;
}

/** Aggregated fetch results for a single PR (used internally by computeChanges). */
interface PrFetchResult {
	status: PRStatusResult;
	comments: PRCommentResult[];
	merge: MergeStateResult;
	review: ReviewStateResult;
}

/** Computed changes from comparing current PR state against the last snapshot. */
interface ComputedChanges {
	/** Events to emit (in order). */
	events: Array<{ type: AutomationEventType; payload: unknown }>;
	/** Snapshot field updates to apply. */
	snapshotUpdates: Partial<PrSubscriptionRecord>;
	/** Whether the PR was detected as merged. */
	isMerged: boolean;
	/** Whether the PR was detected as closed. */
	isClosed: boolean;
	/** New review decision to record (empty string if no change). */
	newReviewDecision: string;
}

// ── Worker ──────────────────────────────────────────────────────────

/**
 * PR Monitor Worker.
 *
 * Standalone class that polls GitHub PRs for status changes using the gh CLI
 * wrappers. Publishes typed automation events for CI failures, new comments,
 * merge conflicts, merge/close transitions, and head-branch updates.
 *
 * Lifecycle: start() → running → stop() → stopped → dispose().
 * Fail-open: construction and poll-cycle errors are logged, never thrown.
 */
export class PrMonitorWorker {
	private readonly directory: string;
	private readonly config: PrMonitorConfig;
	private readonly onEvent?: (event: AutomationEvent<unknown>) => void;

	private status: PrMonitorWorkerStatus = 'stopped';
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	/** In-memory circuit-breaker state per PR correlationId. */
	private readonly circuitBreakerMap = new Map<string, CircuitBreakerState>();

	/** In-memory review decision per PR correlationId (not persisted). */
	private readonly reviewStateMap = new Map<string, string>();

	/** Accumulates merged/closed PR keys during the current poll cycle for sweep cleanup. */
	private mergedOrClosedKeys: Set<string> = new Set();

	constructor(options: PrMonitorWorkerOptions) {
		this.directory = options.directory;
		this.config = options.config;
		this.onEvent = options.onEvent;
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/**
	 * Start the polling worker. Fail-open: logs and returns on bad state
	 * instead of throwing.
	 */
	start(): void {
		if (this.disposed) {
			log('[PrMonitorWorker] Cannot start — worker has been disposed');
			return;
		}

		if (!this.directory) {
			log('[PrMonitorWorker] Cannot start — no directory provided');
			return;
		}

		if (!this.config.enabled) {
			log('[PrMonitorWorker] Cannot start — pr_monitor.enabled is false');
			return;
		}

		if (this.status === 'running' || this.status === 'starting') {
			log('[PrMonitorWorker] Already running or starting');
			return;
		}

		this.status = 'starting';
		log('[PrMonitorWorker] Starting...');

		this.pollTimer = setInterval(() => {
			if (this.disposed || this.status !== 'running') {
				return;
			}
			this.executePollCycle().catch((err) => {
				log('[PrMonitorWorker] Unhandled poll cycle error', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, this.config.poll_interval_seconds * 1000);

		this.status = 'running';
		log('[PrMonitorWorker] Started polling', {
			intervalSeconds: this.config.poll_interval_seconds,
		});
	}

	/**
	 * Stop the polling worker. Clears the interval timer but does not
	 * interrupt an in-flight poll cycle — it will complete and the result
	 * is discarded.
	 */
	stop(): void {
		if (this.status === 'stopped' || this.status === 'stopping') {
			return;
		}

		this.status = 'stopping';
		log('[PrMonitorWorker] Stopping...');

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		this.status = 'stopped';
		this.circuitBreakerMap.clear();
		this.reviewStateMap.clear();
		log('[PrMonitorWorker] Stopped');
	}

	/**
	 * Stop and permanently prevent restart.
	 */
	dispose(): void {
		this.stop();
		this.disposed = true;
		log('[PrMonitorWorker] Disposed');
	}

	/**
	 * Get current worker status.
	 */
	getStatus(): PrMonitorWorkerStatus {
		return this.status;
	}

	/**
	 * Check if worker is currently running.
	 */
	isRunning(): boolean {
		return this.status === 'running';
	}

	// ── Poll Cycle ───────────────────────────────────────────────────

	/**
	 * Public entry point for a single poll cycle. Checks only disposed
	 * state (not running status) so it can be invoked directly in tests
	 * or manual polling scenarios.
	 */
	async pollCycle(): Promise<void> {
		if (this.disposed) {
			return;
		}
		await this.executePollCycle();
	}

	/**
	 * Internal poll cycle implementation: fetch subscriptions, detect
	 * changes, publish events, update snapshots, run sweep.
	 */
	private async executePollCycle(): Promise<void> {
		log('[PrMonitorWorker] Poll cycle starting');

		try {
			const activeSubs = await _internals.listActive(this.directory);

			if (activeSubs.length === 0) {
				log('[PrMonitorWorker] No active subscriptions');
				await this.runSweep();
				return;
			}

			const toPoll = activeSubs.slice(0, this.config.max_prs_per_cycle);
			const concurrencyLimit = this.config.max_concurrent_pr_polls;

			await this.processWithConcurrency(toPoll, concurrencyLimit);
			await this.runSweep();
		} catch (err) {
			log('[PrMonitorWorker] Poll cycle error', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Process subscriptions with a concurrency limit using a sliding window.
	 */
	private async processWithConcurrency(
		subs: readonly PrSubscriptionRecord[],
		concurrencyLimit: number,
	): Promise<void> {
		let index = 0;

		const runNext = async (): Promise<void> => {
			while (index < subs.length) {
				const currentIndex = index;
				index++;

				if (this.disposed) {
					return;
				}

				await this.pollWithTimeout(subs[currentIndex]);
			}
		};

		const workers = Array.from(
			{ length: Math.min(concurrencyLimit, subs.length) },
			() => runNext(),
		);

		await Promise.all(workers);
	}

	/**
	 * Wrap a single PR poll with a configurable timeout.
	 * If the poll exceeds poll_timeout_ms, the timeout error is
	 * delegated to handlePollError (circuit-breaker accounting) and
	 * the method resolves — it never rethrows.
	 */
	private async pollWithTimeout(sub: PrSubscriptionRecord): Promise<void> {
		const timeoutMs = this.config.poll_timeout_ms;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				reject(
					new Error(
						`PR poll timed out after ${timeoutMs}ms for ${sub.repoFullName}#${sub.prNumber}`,
					),
				);
			}, timeoutMs);
		});

		try {
			await Promise.race([
				this.pollSinglePr(sub, () => timedOut),
				timeoutPromise,
			]);
		} catch (err) {
			// Timeout or pollSinglePr error — handle per-PR so the cycle continues.
			// NOTE: pollSinglePr already catches its own errors and delegates to
			// handlePollError, so under normal operation this catch fires only for
			// timeout errors. If pollSinglePr somehow lets an error escape in the
			// future, the double delegation to handlePollError is a safe no-op
			// (circuit-breaker already tripped from the first call).
			await this.handlePollError(
				sub,
				err instanceof Error ? err : new Error(String(err)),
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Poll a single PR subscription: fetch current state, detect changes,
	 * publish events, and update the snapshot. Handles circuit-breaking.
	 */
	private async pollSinglePr(
		sub: PrSubscriptionRecord,
		isTimedOut?: () => boolean,
	): Promise<void> {
		const correlationId = sub.correlationId;

		// Initialize or retrieve circuit-breaker state from subscription snapshot
		if (!this.circuitBreakerMap.has(correlationId) && sub.errorCount > 0) {
			this.circuitBreakerMap.set(correlationId, {
				errorCount: sub.errorCount,
				suspendedUntil: 0,
				cooldownLevel: 0,
			});
		}

		// Check circuit-breaker suspension
		const cb = this.circuitBreakerMap.get(correlationId);
		if (cb && cb.suspendedUntil > Date.now()) {
			log('[PrMonitorWorker] PR suspended by circuit breaker', {
				correlationId,
				suspendedUntil: new Date(cb.suspendedUntil).toISOString(),
			});
			return;
		}

		try {
			const [statusResult, commentsResult, mergeResult, reviewResult] =
				await Promise.all([
					_internals.getPRStatus(
						sub.prNumber,
						sub.repoFullName,
						this.directory,
					),
					_internals.getPRComments(
						sub.prNumber,
						sub.repoFullName,
						this.directory,
					),
					_internals.getMergeState(
						sub.prNumber,
						sub.repoFullName,
						this.directory,
					),
					_internals.getPRReviewState(
						sub.prNumber,
						sub.repoFullName,
						this.directory,
					),
				]);

			// Abort if pollWithTimeout already fired — don't mutate state after timeout
			if (isTimedOut?.()) {
				log('[PrMonitorWorker] Skipping late result — poll already timed out', {
					correlationId: sub.correlationId,
				});
				return;
			}

			// Phase 1: pure computation (no side effects, no await)
			const changes = this.computeChanges(sub, {
				status: statusResult,
				comments: commentsResult,
				merge: mergeResult,
				review: reviewResult,
			});

			// Phase 2: apply changes with single timeout guard
			await this.applyChanges(sub, changes, isTimedOut);

			// Reset circuit breaker on success
			if (!isTimedOut?.()) {
				this.circuitBreakerMap.delete(correlationId);
				await _internals.updateSnapshot(this.directory, correlationId, {
					errorCount: 0,
					lastCheckedAt: Date.now(),
				});
			}
		} catch (err) {
			// Skip error handling if timeout already recorded this failure
			if (isTimedOut?.()) {
				log('[PrMonitorWorker] Skipping late error — poll already timed out', {
					correlationId: sub.correlationId,
				});
				return;
			}
			await this.handlePollError(
				sub,
				err instanceof Error ? err : new Error(String(err)),
			);
		}
	}

	// ── Change Detection ────────────────────────────────────────────

	/**
	 * Pure computation: compare current fetch results against the subscription
	 * snapshot and return all events/mutations to apply. No side effects.
	 */
	private computeChanges(
		sub: PrSubscriptionRecord,
		current: PrFetchResult,
	): ComputedChanges {
		const events: Array<{ type: AutomationEventType; payload: unknown }> = [];
		const snapshotUpdates: Partial<PrSubscriptionRecord> = {
			headRefOid: current.status.headRefOid,
			mergeableState: current.merge.mergeable,
			lastCheckedAt: Date.now(),
		};
		let isMerged = false;
		let isClosed = false;
		let newReviewDecision = '';

		// ── Head ref change ──
		if (current.status.headRefOid !== sub.headRefOid) {
			events.push({
				type: 'pr.status.updated',
				payload: {
					prNumber: sub.prNumber,
					repoFullName: sub.repoFullName,
					prUrl: sub.prUrl,
					previousOid: sub.headRefOid,
					currentOid: current.status.headRefOid,
				},
			});
		}

		// ── CI status change ──
		const currentCheckSet = this.serializeChecks(
			current.status.statusCheckRollup,
		);
		if (
			sub.lastCheckRunSet !== undefined &&
			currentCheckSet !== sub.lastCheckRunSet
		) {
			const prevChecks = this.parseCheckSet(sub.lastCheckRunSet);
			this.computeCIEvents(
				sub,
				prevChecks,
				current.status.statusCheckRollup,
				events,
			);
		}
		snapshotUpdates.lastCheckRunSet = currentCheckSet;

		// ── New comments ──
		// Sort by createdAt ascending so ordering is deterministic regardless
		// of how getPRComments() concatenated issue + review comments.
		if (current.comments.length > 0) {
			const sorted = [...current.comments].sort((a, b) =>
				a.createdAt.localeCompare(b.createdAt),
			);

			let newComments: PRCommentResult[];
			if (sub.lastCommentId === undefined) {
				// First poll — all comments are "new"
				newComments = sorted;
			} else {
				// Find the index of the last-seen comment and take everything after it
				const lastIdx = sorted.findIndex((c) => c.id === sub.lastCommentId);
				newComments = lastIdx >= 0 ? sorted.slice(lastIdx + 1) : sorted;
			}

			for (const comment of newComments) {
				events.push({
					type: 'pr.new.comment',
					payload: {
						prNumber: sub.prNumber,
						repoFullName: sub.repoFullName,
						prUrl: sub.prUrl,
						commentId: comment.id,
						author: comment.author,
						body: comment.body,
						createdAt: comment.createdAt,
						isReviewComment: comment.isReviewComment,
					},
				});
			}

			// Update to the true newest comment ID (last in sorted order)
			snapshotUpdates.lastCommentId = sorted[sorted.length - 1].id;
		}

		// ── Merge conflict detection ──
		if (
			current.merge.mergeable === 'CONFLICTING' &&
			sub.mergeableState !== 'CONFLICTING'
		) {
			events.push({
				type: 'pr.merge.conflict',
				payload: {
					prNumber: sub.prNumber,
					repoFullName: sub.repoFullName,
					prUrl: sub.prUrl,
					mergeableState: current.merge.mergeable,
				},
			});
		} else if (
			sub.mergeableState === 'CONFLICTING' &&
			current.merge.mergeable !== 'CONFLICTING'
		) {
			events.push({
				type: 'pr.merge.conflict_resolved',
				payload: {
					prNumber: sub.prNumber,
					repoFullName: sub.repoFullName,
					prUrl: sub.prUrl,
					mergeableState: current.merge.mergeable,
				},
			});
		}

		// ── Review state change ──
		const prevReviewDecision = this.reviewStateMap.get(sub.correlationId) ?? '';
		if (
			current.review.reviewDecision &&
			current.review.reviewDecision !== prevReviewDecision
		) {
			if (
				current.review.reviewDecision === 'CHANGES_REQUESTED' &&
				prevReviewDecision !== 'CHANGES_REQUESTED'
			) {
				events.push({
					type: 'pr.review.changes_requested',
					payload: {
						prNumber: sub.prNumber,
						repoFullName: sub.repoFullName,
						prUrl: sub.prUrl,
						reviewDecision: current.review.reviewDecision,
					},
				});
			} else if (
				current.review.reviewDecision === 'APPROVED' &&
				prevReviewDecision !== 'APPROVED'
			) {
				events.push({
					type: 'pr.review.approved',
					payload: {
						prNumber: sub.prNumber,
						repoFullName: sub.repoFullName,
						prUrl: sub.prUrl,
						reviewDecision: current.review.reviewDecision,
					},
				});
			}
			newReviewDecision = current.review.reviewDecision;
		}

		// ── PR merged ──
		if (current.status.state === 'MERGED') {
			isMerged = true;
			events.push({
				type: 'pr.merged',
				payload: {
					prNumber: sub.prNumber,
					repoFullName: sub.repoFullName,
					prUrl: sub.prUrl,
					headRefOid: current.status.headRefOid,
				},
			});
			snapshotUpdates.isWatching = false;
		}

		// ── PR closed ──
		if (current.status.state === 'CLOSED') {
			isClosed = true;
			events.push({
				type: 'pr.closed',
				payload: {
					prNumber: sub.prNumber,
					repoFullName: sub.repoFullName,
					prUrl: sub.prUrl,
				},
			});
			snapshotUpdates.isWatching = false;
		}

		// Set hasUnaddressedEvents flag so the sweep logic protects
		// subscriptions that have pending events from being swept.
		snapshotUpdates.hasUnaddressedEvents = events.length > 0;

		return { events, snapshotUpdates, isMerged, isClosed, newReviewDecision };
	}

	/**
	 * Pure computation: detect CI transitions and push events into the array.
	 */
	private computeCIEvents(
		sub: PrSubscriptionRecord,
		prevChecks: Array<{ name: string; conclusion: string | null }>,
		currentChecks: Array<{
			name: string;
			status: string;
			conclusion: string | null;
		}>,
		events: Array<{ type: AutomationEventType; payload: unknown }>,
	): void {
		let allPassed = true;
		const prevMap = new Map(prevChecks.map((c) => [c.name, c.conclusion]));

		for (const check of currentChecks) {
			if (check.conclusion === 'failure' || check.conclusion === 'FAILURE') {
				const prev = prevMap.get(check.name);
				if (prev !== 'failure' && prev !== 'FAILURE') {
					events.push({
						type: 'pr.ci.failed',
						payload: {
							prNumber: sub.prNumber,
							repoFullName: sub.repoFullName,
							prUrl: sub.prUrl,
							checkName: check.name,
							checkUrl: null,
							conclusion: check.conclusion,
						},
					});
				}
			}

			if (check.conclusion !== 'success' && check.conclusion !== 'SUCCESS') {
				allPassed = false;
			}
		}

		if (allPassed && currentChecks.length > 0) {
			const prevHadIssues = prevChecks.some(
				(c) => c.conclusion !== 'success' && c.conclusion !== 'SUCCESS',
			);
			if (prevHadIssues || prevChecks.length === 0) {
				events.push({
					type: 'pr.ci.passed',
					payload: {
						prNumber: sub.prNumber,
						repoFullName: sub.repoFullName,
						prUrl: sub.prUrl,
						checkCount: currentChecks.length,
					},
				});
			}
		}
	}

	/**
	 * Apply computed changes: emit events, update merged/closed tracking,
	 * unsubscribe, and update snapshot. Checks isTimedOut before each
	 * state mutation to prevent stale writes after timeout.
	 */
	private async applyChanges(
		sub: PrSubscriptionRecord,
		changes: ComputedChanges,
		isTimedOut?: () => boolean,
	): Promise<void> {
		// Early exit if already timed out
		if (isTimedOut?.()) {
			log(
				'[PrMonitorWorker] Skipping change application — poll already timed out',
				{ correlationId: sub.correlationId },
			);
			return;
		}

		// Emit all computed events (idempotent fire-and-forget notifications)
		for (const { type, payload } of changes.events) {
			await this.emitEvent(type, payload);
		}

		// Re-check after event emission — timeout may have fired during awaits
		if (isTimedOut?.()) {
			log(
				'[PrMonitorWorker] Skipping state mutations — poll timed out during event emission',
				{ correlationId: sub.correlationId },
			);
			return;
		}

		// Record review decision in memory (after timeout guards)
		if (changes.newReviewDecision) {
			this.reviewStateMap.set(sub.correlationId, changes.newReviewDecision);
		}

		// Track merged/closed keys for sweep (idempotent Set.add)
		// Only add to sweep set when the corresponding auto-unsubscribe flag is enabled,
		// so merged/closed PRs are not swept if the user has not opted into auto-unsubscribe.
		if (
			(changes.isMerged && this.config.auto_unsubscribe_on_merge) ||
			(changes.isClosed && this.config.auto_unsubscribe_on_close)
		) {
			this.mergedOrClosedKeys.add(`${sub.repoFullName}::${sub.prNumber}`);
		}

		// Auto-unsubscribe merged PR
		if (changes.isMerged && this.config.auto_unsubscribe_on_merge) {
			await _internals.unsubscribe(this.directory, sub.correlationId);
			this.reviewStateMap.delete(sub.correlationId);
			this.circuitBreakerMap.delete(sub.correlationId);
			log('[PrMonitorWorker] Auto-unsubscribed merged PR', {
				correlationId: sub.correlationId,
			});
			return;
		}

		// Auto-unsubscribe closed PR
		if (changes.isClosed && this.config.auto_unsubscribe_on_close) {
			await _internals.unsubscribe(this.directory, sub.correlationId);
			this.reviewStateMap.delete(sub.correlationId);
			this.circuitBreakerMap.delete(sub.correlationId);
			log('[PrMonitorWorker] Auto-unsubscribed closed PR', {
				correlationId: sub.correlationId,
			});
			return;
		}

		// Final check before snapshot write — prevents stale regression
		if (isTimedOut?.()) {
			log(
				'[PrMonitorWorker] Skipping snapshot update — poll timed out before write',
				{ correlationId: sub.correlationId },
			);
			return;
		}

		await _internals.updateSnapshot(
			this.directory,
			sub.correlationId,
			changes.snapshotUpdates,
		);
	}

	// ── Error Handling & Circuit Breaker ─────────────────────────────

	/**
	 * Handle a poll error for a single PR: increment error count, apply
	 * circuit-breaker suspension with exponential backoff.
	 */
	private async handlePollError(
		sub: PrSubscriptionRecord,
		error: Error,
	): Promise<void> {
		const correlationId = sub.correlationId;

		const cb = this.circuitBreakerMap.get(correlationId) ?? {
			errorCount: 0,
			suspendedUntil: 0,
			cooldownLevel: 0,
		};

		cb.errorCount++;

		await _internals.updateSnapshot(this.directory, correlationId, {
			errorCount: cb.errorCount,
			lastCheckedAt: Date.now(),
		});

		if (cb.errorCount >= this.config.failure_threshold) {
			cb.cooldownLevel++;
			const cooldownSeconds = Math.min(
				this.config.cooldown_seconds * 2 ** (cb.cooldownLevel - 1),
				this.config.max_cooldown_seconds,
			);
			cb.suspendedUntil = Date.now() + cooldownSeconds * 1000;

			this.circuitBreakerMap.set(correlationId, cb);

			log('[PrMonitorWorker] Circuit breaker tripped for PR', {
				correlationId,
				errorCount: cb.errorCount,
				cooldownSeconds,
			});

			await this.emitEvent('pr.error', {
				prNumber: sub.prNumber,
				repoFullName: sub.repoFullName,
				prUrl: sub.prUrl,
				reason: 'circuit_breaker',
				errorCount: cb.errorCount,
				cooldownSeconds,
			});
		} else {
			this.circuitBreakerMap.set(correlationId, cb);
			log('[PrMonitorWorker] Poll error for PR', {
				correlationId,
				errorCount: cb.errorCount,
				error: error.message,
			});
		}
	}

	// ── Event Publishing ─────────────────────────────────────────────

	/**
	 * Publish an event to the global event bus and optional callback.
	 */
	private async emitEvent(
		type: AutomationEventType,
		payload: unknown,
	): Promise<void> {
		const event: AutomationEvent<unknown> = {
			type,
			timestamp: Date.now(),
			payload,
			source: 'pr-monitor-worker',
		};

		try {
			const bus = _internals.getGlobalEventBus();
			await bus.publish(type, payload, 'pr-monitor-worker');
		} catch (err) {
			log('[PrMonitorWorker] Event publish failed', {
				type,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (this.onEvent) {
			try {
				this.onEvent(event);
			} catch {
				// Callback errors must not affect worker stability
			}
		}
	}

	// ── Sweep ───────────────────────────────────────────────────────

	/**
	 * Run stale subscription sweep if cleanup_ttl_days > 0.
	 * Passes any merged/closed PR keys observed during the poll cycle
	 * so that sweepStale can remove subscriptions for those PRs.
	 */
	private async runSweep(): Promise<void> {
		if (this.config.cleanup_ttl_days > 0) {
			try {
				const keysToPass =
					this.mergedOrClosedKeys.size > 0
						? this.mergedOrClosedKeys
						: undefined;
				await _internals.sweepStale(
					this.directory,
					this.config.cleanup_ttl_days,
					keysToPass,
				);
			} catch (err) {
				log('[PrMonitorWorker] Sweep failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				this.mergedOrClosedKeys.clear();
			}
		} else {
			// Clear even when sweep is disabled to prevent unbounded growth
			this.mergedOrClosedKeys.clear();
		}
	}

	// ── Serialization Helpers ──────────────────────────────────────

	/**
	 * Serialize statusCheckRollup to a stable string for snapshot comparison.
	 */
	private serializeChecks(
		checks: Array<{ name: string; status: string; conclusion: string | null }>,
	): string {
		return JSON.stringify(checks.map((c) => ({ n: c.name, c: c.conclusion })));
	}

	/**
	 * Parse a serialized check set back into an array.
	 */
	private parseCheckSet(
		serialized: string,
	): Array<{ name: string; conclusion: string | null }> {
		try {
			const parsed: Array<{ n: string; c: string | null }> =
				JSON.parse(serialized);
			return parsed.map((p) => ({ name: p.n, conclusion: p.c }));
		} catch {
			return [];
		}
	}
}

// ── DI Seam for Testability ─────────────────────────────────────────

export const _internals = {
	getPRStatus,
	getPRComments,
	getMergeState,
	getPRReviewState,
	listActive,
	updateSnapshot,
	unsubscribe,
	sweepStale,
	getGlobalEventBus,
};
