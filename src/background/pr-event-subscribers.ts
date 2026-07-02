/**
 * PR Event Bus Subscribers — PR event delivery to subscribed sessions.
 *
 * Subscribes to PR events on the global event bus and delivers structured
 * messages to ALL active sessions that are subscribed to the relevant PR.
 * Each event type is gated by a config flag from PrMonitorConfig.
 *
 * Delivery channels (one chosen per delivery attempt; at-least-once under
 * wake acceptance-timeout races — duplicates share a dedup token):
 *   - 'prompt' mode (default) with a registered wake deliverer
 *     (src/background/pr-event-delivery.ts): the subscribed session is woken
 *     with a structured <pr-activity> message so idle sessions act
 *     immediately. On wake failure the event falls back to the advisory push.
 *   - 'advisory' mode (legacy) or no deliverer: the event is queued in
 *     session.pendingAdvisoryMessages and surfaces on the next model turn.
 *
 * After a successful delivery to a session, the subscription's
 * `hasUnaddressedEvents` flag is cleared (deferred — see
 * scheduleClearUnaddressed) so delivered events no longer make the
 * subscription immune to the TTL sweep forever.
 *
 * Fail-open: errors in delivery never crash the event bus.
 * Dedup: advisories are deduped per session per PR+event type; wake events
 * are deduped by token inside the delivery queue.
 */

import type { PrMonitorConfig } from '../config/schema';
import { getAgentSession } from '../state';
import { log } from '../utils';
import type { AutomationEventType, EventListener } from './event-bus';
import { getGlobalEventBus } from './event-bus';
import {
	deliverPrActivity,
	type FormattedPrEvent,
	isPrEventDeliveryRegistered,
} from './pr-event-delivery';
import { listActive, updateSnapshot } from './pr-subscriptions';

export interface PrEventSubscriberOptions {
	directory: string;
	config: PrMonitorConfig;
}

/**
 * Delay before clearing `hasUnaddressedEvents` after a successful delivery.
 *
 * Why deferred: the poll worker emits events (awaiting bus listeners —
 * including this module) and THEN writes its own snapshot with
 * `hasUnaddressedEvents: true`. A synchronous clear inside the listener
 * would be overwritten milliseconds later by that worker write. Deferring
 * the clear past the worker's write fixes the sweep-immunity leak: the
 * final folded state records the events as addressed. If the deferred
 * write ever loses the race (slow lock), the next delivered event clears
 * it again — and the TTL sweep only matters on a scale of days.
 */
const CLEAR_UNADDRESSED_DELAY_MS = 2_000;

/** Bound on concurrently pending deferred clears (invariant 8). */
const MAX_PENDING_CLEARS = 200;

const pendingClears = new Set<string>();

/**
 * DI seam for testability. Exposes internal functions that are replaced
 * in tests via the _internals object.
 */
export const _internals: {
	handlePrEvent: typeof handlePrEvent;
	getGlobalEventBus: typeof getGlobalEventBus;
	listActive: typeof listActive;
	updateSnapshot: typeof updateSnapshot;
	getAgentSession: typeof getAgentSession;
	deliverPrActivity: typeof deliverPrActivity;
	isPrEventDeliveryRegistered: typeof isPrEventDeliveryRegistered;
	scheduleClearUnaddressed: typeof scheduleClearUnaddressed;
	clearUnaddressedDelayMs: number;
	log: typeof log;
} = {
	handlePrEvent,
	getGlobalEventBus,
	listActive,
	updateSnapshot,
	getAgentSession,
	deliverPrActivity,
	isPrEventDeliveryRegistered,
	scheduleClearUnaddressed,
	clearUnaddressedDelayMs: CLEAR_UNADDRESSED_DELAY_MS,
	log,
};

/** Event types eligible for auto PR_FEEDBACK mode injection. */
const AUTO_PR_FEEDBACK_EVENTS = new Set(['pr.ci.failed', 'pr.merge.conflict']);

/** Map of event type → config flag name for notification gating. */
const EVENT_CONFIG_MAP: Record<string, keyof PrMonitorConfig> = {
	'pr.ci.failed': 'notify_ci_failure',
	'pr.ci.passed': 'notify_ci_success',
	'pr.new.comment': 'notify_new_comments',
	'pr.merge.conflict': 'notify_merge_conflict',
	'pr.merge.conflict_resolved': 'notify_merge_conflict',
	'pr.review.changes_requested': 'notify_review_activity',
	'pr.review.approved': 'notify_review_activity',
	'pr.merged': 'notify_merged',
	'pr.closed': 'notify_closed',
};

/**
 * Expected payload shape for subscribed PR event types.
 * Each event type uses a subset of these fields (see the payloads published
 * by src/background/pr-monitor-worker.ts computeChanges/computeCIEvents).
 */
interface PrEventPayload {
	prNumber: number;
	repoFullName: string;
	prUrl?: string;
	checkName?: string;
	checkState?: string;
	errorMessage?: string;
	author?: string;
	body?: string;
	/** pr.ci.passed */
	checkCount?: number;
	/** pr.review.* */
	reviewDecision?: string;
	/** pr.merge.conflict_resolved */
	mergeableState?: string;
}

/**
 * Register subscribers on the global event bus for all gated PR event
 * types. Returns a cleanup function that unsubscribes all listeners.
 *
 * Skips event types whose config flag is disabled (false).
 */
export function registerPrEventSubscribers(
	options: PrEventSubscriberOptions,
): () => void {
	const { directory, config } = options;
	const bus = _internals.getGlobalEventBus();
	const unsubscribers: Array<() => void> = [];

	for (const [eventType, configFlag] of Object.entries(EVENT_CONFIG_MAP)) {
		if (!config[configFlag]) {
			_internals.log(
				`[pr-monitor] Skipping ${eventType} subscriber (disabled by config)`,
			);
			continue;
		}

		const listener: EventListener = async (event) => {
			try {
				await _internals.handlePrEvent(event, directory, config);
			} catch (err) {
				_internals.log(`[pr-monitor] Error handling ${eventType}`, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		const unsub = bus.subscribe(eventType as AutomationEventType, listener);
		unsubscribers.push(unsub);
		_internals.log(`[pr-monitor] Registered subscriber for ${eventType}`);
	}

	return () => {
		for (const unsub of unsubscribers) {
			unsub();
		}
		_internals.log('[pr-monitor] Unregistered all PR event subscribers');
	};
}

/**
 * Handle a single PR event: look up active subscriptions matching the event's
 * repo+PR, format the event, and deliver it to every matching session via
 * the wake channel (prompt mode) or the advisory queue.
 */
async function handlePrEvent(
	event: { type: string; payload: unknown },
	directory: string,
	config: PrMonitorConfig,
): Promise<void> {
	const payload = event.payload as PrEventPayload;
	if (!payload?.prNumber || !payload?.repoFullName) return;

	// Find all active subscriptions for this PR across all sessions
	const subscriptions = await _internals.listActive(directory);
	const matching = subscriptions.filter(
		(sub) =>
			sub.prNumber === payload.prNumber &&
			sub.repoFullName === payload.repoFullName,
	);

	if (matching.length === 0) return;

	const message = formatAdvisory(event.type, payload);
	if (!message) return;

	const dedupToken = `[pr-monitor:${event.type}:${payload.repoFullName}#${payload.prNumber}]`;

	// Build optional MODE signal when auto_pr_feedback is enabled
	const modeSignal =
		config.auto_pr_feedback &&
		AUTO_PR_FEEDBACK_EVENTS.has(event.type) &&
		payload.prUrl
			? (() => {
					const safePrUrl = String(payload.prUrl).replace(/["\]]/g, '');
					return `[MODE: PR_FEEDBACK pr="${safePrUrl}"]`;
				})()
			: null;

	const usePromptDelivery =
		config.event_delivery === 'prompt' &&
		_internals.isPrEventDeliveryRegistered();

	// Deliver to each subscribed session
	for (const sub of matching) {
		if (usePromptDelivery) {
			const formatted: FormattedPrEvent = {
				type: event.type,
				repoFullName: payload.repoFullName,
				prNumber: payload.prNumber,
				prUrl: payload.prUrl ?? sub.prUrl,
				message,
				dedupToken,
			};
			let wakeOk = false;
			try {
				wakeOk = await _internals.deliverPrActivity(sub.sessionID, [formatted]);
			} catch {
				wakeOk = false;
			}
			if (wakeOk) {
				// Best-effort: `true` means the wake channel ACCEPTED the event
				// (sent immediately, queued for idle flush, or deduped) — not
				// that the session has acted on it. A lost queue entry only
				// delays the day-scale TTL sweep; the worker refreshes the flag
				// on every poll that emits events.
				_internals.scheduleClearUnaddressed(directory, sub.correlationId);
				_internals.log(
					`[pr-monitor] Delivered ${event.type} wake event to session ${sub.sessionID}`,
				);
				continue;
			}
			_internals.log(
				`[pr-monitor] Wake delivery failed for session ${sub.sessionID} — falling back to advisory`,
			);
		}

		const session = _internals.getAgentSession(sub.sessionID);
		if (!session) {
			_internals.log(
				`[pr-monitor] Session ${sub.sessionID} not found — skipping advisory delivery`,
			);
			continue;
		}

		session.pendingAdvisoryMessages ??= [];
		// Dedup: skip if the advisory for this PR+event type was already delivered.
		// The advisory body always starts with the dedupToken, so scanning all
		// pending messages detects duplicates regardless of interleaving order.
		const isDuplicate = session.pendingAdvisoryMessages.some((msg) =>
			msg.includes(dedupToken),
		);
		if (isDuplicate) {
			continue;
		}
		session.pendingAdvisoryMessages.push(message);
		_internals.scheduleClearUnaddressed(directory, sub.correlationId);
		_internals.log(
			`[pr-monitor] Delivered ${event.type} advisory to session ${sub.sessionID}`,
		);

		// Inject MODE signal alongside the advisory
		if (modeSignal) {
			session.pendingAdvisoryMessages.push(modeSignal);
			_internals.log(
				`[pr-monitor] Injected PR_FEEDBACK mode signal for session ${sub.sessionID} (${event.type})`,
			);
		}
	}
}

/**
 * Schedule a deferred clear of `hasUnaddressedEvents` for a subscription
 * after a successful event delivery. Deferred and deduped per correlationId
 * (see CLEAR_UNADDRESSED_DELAY_MS for the rationale). Timers are unref'd so
 * they never hold the process open. Fail-open: store errors are swallowed.
 */
function scheduleClearUnaddressed(
	directory: string,
	correlationId: string,
): void {
	if (!correlationId) return;
	if (pendingClears.has(correlationId)) return;
	if (pendingClears.size >= MAX_PENDING_CLEARS) return;
	pendingClears.add(correlationId);

	const timer = setTimeout(() => {
		pendingClears.delete(correlationId);
		void Promise.resolve()
			.then(() =>
				_internals.updateSnapshot(directory, correlationId, {
					hasUnaddressedEvents: false,
				}),
			)
			.catch((err) => {
				_internals.log('[pr-monitor] Failed to clear hasUnaddressedEvents', {
					correlationId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}, _internals.clearUnaddressedDelayMs);
	if (typeof (timer as { unref?: () => void }).unref === 'function') {
		(timer as unknown as { unref: () => void }).unref();
	}
}

/**
 * Format a structured advisory message for the given PR event type.
 * Returns null for unknown event types. The first token is always the
 * dedup token `[pr-monitor:<type>:<repo>#<n>]`.
 */
function formatAdvisory(type: string, payload: PrEventPayload): string | null {
	const dedupToken = `[pr-monitor:${type}:${payload.repoFullName}#${payload.prNumber}]`;

	switch (type) {
		case 'pr.ci.failed':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — CI check "${payload.checkName || 'unknown'}" failed`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Check: ${payload.checkName || 'unknown'} — ${payload.checkState || 'failure'}`,
				payload.errorMessage ? `  Details: ${payload.errorMessage}` : '',
			]
				.filter(Boolean)
				.join('\n');

		case 'pr.ci.passed':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — CI checks passed`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Checks: ${typeof payload.checkCount === 'number' ? payload.checkCount : 'all'} passing`,
			].join('\n');

		case 'pr.new.comment':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — New comment by @${payload.author || 'unknown'}`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Comment: ${(payload.body || '').slice(0, 200)}`,
			].join('\n');

		case 'pr.merge.conflict':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — Merge conflict detected`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Status: CONFLICTING`,
			].join('\n');

		case 'pr.merge.conflict_resolved':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — Merge conflict resolved`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Status: ${payload.mergeableState || 'MERGEABLE'}`,
			].join('\n');

		case 'pr.review.changes_requested':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — Review: changes requested`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Review state: ${payload.reviewDecision || 'CHANGES_REQUESTED'}`,
			].join('\n');

		case 'pr.review.approved':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — Review: approved`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Review state: ${payload.reviewDecision || 'APPROVED'}`,
			].join('\n');

		case 'pr.merged':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — PR merged (TERMINAL)`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Monitoring ends: report final status and stop — the subscription is complete.`,
			].join('\n');

		case 'pr.closed':
			return [
				`${dedupToken} (advisory) PR #${payload.prNumber} — PR closed without merge (TERMINAL)`,
				`  Repository: ${payload.repoFullName}`,
				`  URL: ${payload.prUrl || ''}`,
				`  Monitoring ends: report final status and stop — the subscription is complete.`,
			].join('\n');

		default:
			return null;
	}
}
