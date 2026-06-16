/**
 * PR Event Bus Subscribers — Advisory notification delivery.
 *
 * Subscribes to PR events on the global event bus and delivers structured
 * advisory messages to ALL active sessions that are subscribed to the
 * relevant PR. Each event type is gated by a config flag from PrMonitorConfig.
 *
 * Fail-open: errors in delivery never crash the event bus.
 * Dedup: advisories are deduped per session per PR+event type.
 */

import type { PrMonitorConfig } from '../config/schema';
import { getAgentSession } from '../state';
import { log } from '../utils';
import type { AutomationEventType, EventListener } from './event-bus';
import { getGlobalEventBus } from './event-bus';
import { listActive } from './pr-subscriptions';

export interface PrEventSubscriberOptions {
	directory: string;
	config: PrMonitorConfig;
}

/**
 * DI seam for testability. Exposes internal functions that are replaced
 * in tests via the _internals object.
 */
export const _internals: {
	handlePrEvent: typeof handlePrEvent;
	getGlobalEventBus: typeof getGlobalEventBus;
	listActive: typeof listActive;
	getAgentSession: typeof getAgentSession;
	log: typeof log;
} = {
	handlePrEvent,
	getGlobalEventBus,
	listActive,
	getAgentSession,
	log,
} as const;

/** Event types eligible for auto PR_FEEDBACK mode injection. */
const AUTO_PR_FEEDBACK_EVENTS = new Set(['pr.ci.failed', 'pr.merge.conflict']);

/** Map of event type → config flag name for notification gating. */
const EVENT_CONFIG_MAP: Record<string, keyof PrMonitorConfig> = {
	'pr.ci.failed': 'notify_ci_failure',
	'pr.new.comment': 'notify_new_comments',
	'pr.merge.conflict': 'notify_merge_conflict',
};

/**
 * Expected payload shape for subscribed PR event types.
 * Each event type uses a subset of these fields.
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
}

/**
 * Register subscribers on the global event bus for the three gated PR event
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
 * repo+PR, format an advisory, and push it to every matching session.
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

	// Deliver to each subscribed session
	for (const sub of matching) {
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
		const dedupToken = `[pr-monitor:${event.type}:${payload.repoFullName}#${payload.prNumber}]`;
		const isDuplicate = session.pendingAdvisoryMessages.some((msg) =>
			msg.includes(dedupToken),
		);
		if (isDuplicate) {
			continue;
		}
		session.pendingAdvisoryMessages.push(message);
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
 * Format a structured advisory message for the given PR event type.
 * Returns null for unknown event types.
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

		default:
			return null;
	}
}
