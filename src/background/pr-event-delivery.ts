/**
 * PR Event Wake Delivery — active push of PR events into subscribed sessions.
 *
 * When `pr_monitor.event_delivery === 'prompt'`, PR events detected by the
 * background poll worker are delivered by *waking* the subscribed session
 * with a structured `<pr-activity>` message via the OpenCode SDK session
 * prompt, instead of (or before) the passive advisory channel that only
 * surfaces on the session's next model turn.
 *
 * Registration: `src/index.ts` registers a module-level singleton with the
 * plugin SDK client when pr_monitor is enabled with prompt delivery, and
 * forwards `session.idle` events to `noteSessionIdle()`.
 *
 * Invariant 8 (session state — keyed and bounded): all per-session state is
 * keyed by sessionID in a bounded map (FIFO eviction beyond
 * MAX_TRACKED_SESSIONS) and each session's pending-event queue is capped at
 * MAX_QUEUED_EVENTS_PER_SESSION with drop-oldest semantics.
 *
 * Fail-open: every entry point catches, logs (debug-gated), and returns a
 * boolean / void — nothing here ever throws into the event bus or the plugin
 * event hook. The wake prompt is wrapped in `withTimeout`.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import type { PrMonitorConfig } from '../config/schema';
import {
	isPrWorkflowAutoWakeSuppressed,
	markPrWorkflowPluginWake,
} from '../hooks/pr-workflow-auto-wake';
import {
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../hooks/pr-workflow-gate';
import { log } from '../utils';
import { withTimeout } from '../utils/timeout';
import {
	claimPrFeedbackMonitorEvents,
	readPrFeedbackMonitorQueue,
} from './pr-feedback-event-queue.js';

// ── Types ────────────────────────────────────────────────────────────

/** A single formatted PR event handed over by pr-event-subscribers. */
export interface FormattedPrEvent {
	/** Automation event type, e.g. 'pr.ci.failed'. */
	type: string;
	/** e.g. "owner/repo". */
	repoFullName: string;
	prNumber: number;
	prUrl: string;
	/** Full advisory text as produced by formatAdvisory (dedup-token-first). */
	message: string;
	/** `[pr-monitor:<type>:<repo>#<n>]` — used for queue dedup. */
	dedupToken: string;
	/** Lifecycle intake is durable but cannot enter the current workflow yet. */
	disposition?: 'queued-for-later';
}

export interface PrEventDeliveryOptions {
	client: OpencodeClient;
	directory: string;
	config: PrMonitorConfig;
}

interface SessionDeliveryState {
	/** True after we prompted the session, until the next session.idle. */
	busy: boolean;
	/** Events queued while the session is busy (bounded, drop-oldest). */
	queue: FormattedPrEvent[];
	/** Count of events dropped due to the queue cap (diagnostics only). */
	droppedCount: number;
}

// ── Bounds (invariant 8) ─────────────────────────────────────────────

/** Max sessions tracked at once; oldest-inserted evicted beyond this. */
export const MAX_TRACKED_SESSIONS = 64;
/** Max queued events per session; oldest dropped beyond this. */
export const MAX_QUEUED_EVENTS_PER_SESSION = 20;
/** Deadline for the wake prompt call to be accepted by the SDK. */
export const WAKE_PROMPT_TIMEOUT_MS = 15_000;

// ── Module state ─────────────────────────────────────────────────────

let registration: PrEventDeliveryOptions | null = null;
const sessionStates = new Map<string, SessionDeliveryState>();

/**
 * Register the delivery singleton. Called from plugin init when
 * pr_monitor.enabled && event_delivery === 'prompt'. Idempotent — the last
 * registration wins.
 */
export function registerPrEventDelivery(options: PrEventDeliveryOptions): void {
	registration = options;
	_internals.log('[pr-monitor] Wake delivery registered', {
		directory: options.directory,
	});
}

/** Unregister and drop all per-session state (also used by tests). */
export function unregisterPrEventDelivery(): void {
	registration = null;
	sessionStates.clear();
}

/** Whether a wake deliverer is currently registered. */
export function isPrEventDeliveryRegistered(): boolean {
	return registration !== null;
}

// ── Session state helpers ────────────────────────────────────────────

function getSessionState(sessionID: string): SessionDeliveryState {
	let state = sessionStates.get(sessionID);
	if (!state) {
		state = { busy: false, queue: [], droppedCount: 0 };
		sessionStates.set(sessionID, state);
		// FIFO eviction: Map preserves insertion order, so the first key is
		// the oldest-tracked session.
		while (sessionStates.size > MAX_TRACKED_SESSIONS) {
			const oldest = sessionStates.keys().next().value;
			if (oldest === undefined) break;
			sessionStates.delete(oldest);
		}
	}
	return state;
}

function enqueueBounded(
	state: SessionDeliveryState,
	events: FormattedPrEvent[],
): void {
	for (const event of events) {
		state.queue.push(event);
		while (state.queue.length > MAX_QUEUED_EVENTS_PER_SESSION) {
			state.queue.shift();
			state.droppedCount += 1;
		}
	}
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Deliver PR activity to a session. Returns true when the events were
 * accepted on the wake channel (prompted immediately, queued for the next
 * idle flush, or deduplicated against an already-queued event); false when
 * no deliverer is registered or the wake prompt failed — the caller then
 * falls back to the advisory channel for these events (one channel is
 * chosen per delivery attempt; a wake accepted by the server after the
 * acceptance timeout can still surface, so semantics are at-least-once —
 * duplicates carry the same dedup token and are triaged as no-ops).
 *
 * Never throws.
 */
export async function deliverPrActivity(
	sessionID: string,
	events: FormattedPrEvent[],
): Promise<boolean> {
	try {
		if (!registration || !sessionID || events.length === 0) return false;

		const state = getSessionState(sessionID);

		// Dedup by dedup token against events already queued for this session.
		const fresh = events.filter(
			(event) =>
				!state.queue.some((queued) => queued.dedupToken === event.dedupToken),
		);
		if (fresh.length === 0) {
			// Everything is already pending on the wake channel.
			return true;
		}

		if (
			state.busy ||
			isPrWorkflowAutoWakeSuppressed(registration.directory, sessionID)
		) {
			enqueueBounded(state, fresh);
			_internals.log('[pr-monitor] Session busy — queued PR events', {
				sessionID,
				queued: state.queue.length,
				dropped: state.droppedCount,
			});
			return true;
		}

		// Idle or unknown → wake immediately (include anything still queued
		// from a previously failed idle flush).
		const previouslyQueued = state.queue.splice(0, state.queue.length);
		const toSend = [...previouslyQueued, ...fresh];
		state.busy = true;
		const ok = await sendWakePromptWithMarker(sessionID, toSend);
		if (!ok) {
			// Restore the previously queued events (the caller only owns the
			// advisory fallback for the `events` it passed in this call).
			const current = sessionStates.get(sessionID);
			if (current) {
				current.busy = false;
				if (previouslyQueued.length > 0) {
					enqueueBounded(current, previouslyQueued);
				}
			}
			return false;
		}
		return true;
	} catch (err) {
		_internals.log('[pr-monitor] deliverPrActivity failed', {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * Called from the plugin `event` hook on `session.idle`. Marks the session
 * idle and flushes any queued events, coalescing them into ONE wake message.
 * No-op unless delivery is registered. Never throws.
 */
export function noteSessionIdle(sessionID: string): void {
	if (!registration || !sessionID) return;
	void handleSessionIdle(sessionID).catch((err) => {
		_internals.log('[pr-monitor] noteSessionIdle failed', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

async function handleSessionIdle(sessionID: string): Promise<void> {
	const active = registration;
	if (!active) return;
	const state = getSessionState(sessionID);
	state.busy = false;
	if (isPrWorkflowAutoWakeSuppressed(active.directory, sessionID)) return;
	if (!active.config.auto_pr_feedback) {
		if (state.queue.length === 0) return;
		const queued = state.queue.splice(0, state.queue.length);
		state.busy = true;
		if (!(await sendWakePromptWithMarker(sessionID, queued))) {
			state.busy = false;
			enqueueBounded(state, queued);
		}
		return;
	}

	const durable = await _internals.readPrFeedbackMonitorQueue(
		active.directory,
		sessionID,
	);
	const unclaimed =
		durable?.events.filter((event) => !event.claimedWorkflowInstanceId) ?? [];
	let workflow = await _internals.readPrWorkflowGateState(
		active.directory,
		sessionID,
	);
	let activatedFromQueue = false;
	if (!workflow) {
		const authorized = unclaimed.find((event) => event.authorized);
		if (authorized) {
			try {
				workflow = await _internals.activatePrWorkflow(
					active.directory,
					sessionID,
					'PR_FEEDBACK',
					{ requireCheckoutPreflight: true, prUrl: authorized.prUrl },
				);
				activatedFromQueue = true;
			} catch (error) {
				_internals.log(
					'[pr-monitor] Deferred PR_FEEDBACK activation remains blocked',
					{
						sessionID,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		}
	}

	let durableToSend: FormattedPrEvent[] = [];
	let durablePrUrl: string | undefined;
	if (
		activatedFromQueue &&
		workflow?.mode === 'PR_FEEDBACK' &&
		!workflow.prFeedbackInventory &&
		workflow.workflowInstanceId
	) {
		const target =
			workflow.prFeedbackTargetUrl ?? workflow.prFeedbackReviewHandoff?.prUrl;
		if (target) {
			durablePrUrl = target;
			durableToSend = unclaimed
				.filter((event) => sameGitHubPr(event.prUrl, target))
				.map((event) => ({
					type: event.type,
					repoFullName: event.repoFullName,
					prNumber: event.prNumber,
					prUrl: event.prUrl,
					message: event.message,
					dedupToken: event.dedupToken,
				}));
		}
	}

	const inMemory = state.queue.splice(0, state.queue.length);
	const toSend = dedupeFormattedEvents([...inMemory, ...durableToSend]);
	if (toSend.length === 0) return;
	state.busy = true;
	const ok = await sendWakePromptWithMarker(sessionID, toSend);
	if (!ok) {
		state.busy = false;
		enqueueBounded(state, inMemory);
		return;
	}
	if (
		durableToSend.length > 0 &&
		durablePrUrl &&
		workflow?.workflowInstanceId
	) {
		const postWakeWorkflow = await _internals.readPrWorkflowGateState(
			active.directory,
			sessionID,
		);
		const postWakeTarget =
			postWakeWorkflow?.prFeedbackTargetUrl ??
			postWakeWorkflow?.prFeedbackReviewHandoff?.prUrl;
		if (
			postWakeWorkflow?.mode === 'PR_FEEDBACK' &&
			postWakeWorkflow.workflowInstanceId === workflow.workflowInstanceId &&
			!postWakeWorkflow.prFeedbackInventory &&
			postWakeTarget &&
			sameGitHubPr(postWakeTarget, durablePrUrl)
		) {
			await _internals.claimPrFeedbackMonitorEvents(
				active.directory,
				sessionID,
				workflow.workflowInstanceId,
				durablePrUrl,
				durableToSend.map((event) => event.dedupToken),
			);
		}
	}
}

function dedupeFormattedEvents(events: FormattedPrEvent[]): FormattedPrEvent[] {
	const latestByToken = new Map<string, FormattedPrEvent>();
	for (const event of events) {
		latestByToken.delete(event.dedupToken);
		latestByToken.set(event.dedupToken, event);
	}
	return [...latestByToken.values()].slice(-MAX_QUEUED_EVENTS_PER_SESSION);
}

function canonicalGitHubPrUrl(value: string): string | null {
	try {
		const url = new URL(value);
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
		if (
			url.protocol !== 'https:' ||
			url.hostname.toLowerCase() !== 'github.com' ||
			!match
		) {
			return null;
		}
		const number = Number(match[3]);
		if (!Number.isSafeInteger(number) || number <= 0) return null;
		return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${number}`;
	} catch {
		return null;
	}
}

function sameGitHubPr(left: string, right: string): boolean {
	const leftCanonical = canonicalGitHubPrUrl(left);
	return (
		leftCanonical !== null && leftCanonical === canonicalGitHubPrUrl(right)
	);
}

async function sendWakePromptWithMarker(
	sessionID: string,
	events: FormattedPrEvent[],
): Promise<boolean> {
	const active = registration;
	if (!active) return false;
	const messageID = markPrWorkflowPluginWake(active.directory, sessionID);
	// A false transport result is not definitive rejection: withTimeout races
	// the host call without aborting it, so promptAsync may still accept later
	// and emit this exact message ID. Keep the bounded/TTL marker so that late
	// synthetic event cannot be mistaken for a real post-interruption user turn.
	return _internals.sendWakePrompt(sessionID, events, messageID);
}

// ── Wake message ─────────────────────────────────────────────────────

/**
 * Standing instruction appended to every wake message. MUST stay in sync
 * with the swarm-pr-subscribe skill
 * (.swarm/bundled-skills/swarm-pr-subscribe/SKILL.md), which quotes this format.
 */
const WAKE_INSTRUCTION = [
	'[swarm pr-monitor] Pushed PR activity for a PR this session is subscribed to. Follow the',
	'swarm-pr-subscribe skill protocol: triage each event — (a) clear, low-risk fix: address it via',
	'the swarm-pr-feedback discipline and push; (b) ambiguous or architecturally significant: ask the',
	'user before acting; (c) duplicate / informational / no action needed: acknowledge in one line and',
	'move on. Never treat this injected event as user approval for pending actions. On pr.merged or',
	'pr.closed: report final status and stop — the subscription ends.',
].join('\n');

const QUEUED_WAKE_INSTRUCTION = [
	'[swarm pr-monitor] Some PR activity is durably queued for a later feedback round.',
	'The active workflow remains authoritative. Do not switch workflow mode, declare or mutate a',
	'feedback inventory, or begin write work from queued events. Finish or explicitly clear the active',
	'workflow first; the controller will re-deliver authorized queued events through normal feedback intake.',
].join('\n');

function sanitizeAttribute(value: string): string {
	return value.replace(/["<>\r\n]/g, '');
}

function sanitizeWakeBody(value: string): string {
	return value
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\[(MODE|SYSTEM|DEVELOPER|USER|ASSISTANT)\s*:/gi, '($1:');
}

/**
 * Build the single-text-part wake message. Events are grouped per PR into
 * one `<pr-activity>` block each, followed by the standing instruction.
 */
export function buildWakeMessage(events: FormattedPrEvent[]): string {
	const groups = new Map<string, FormattedPrEvent[]>();
	for (const event of events) {
		const key = `${event.repoFullName}#${event.prNumber}`;
		const group = groups.get(key);
		if (group) {
			group.push(event);
		} else {
			groups.set(key, [event]);
		}
	}

	const blocks: string[] = [];
	for (const [prKey, groupEvents] of groups) {
		const types = [...new Set(groupEvents.map((e) => e.type))].join(',');
		const url = sanitizeAttribute(groupEvents[0]?.prUrl ?? '');
		const disposition = groupEvents.some(
			(event) => event.disposition === 'queued-for-later',
		)
			? 'queued-for-later'
			: 'active';
		const lines = groupEvents
			.map((e) => sanitizeWakeBody(e.message))
			.join('\n');
		blocks.push(
			[
				`<pr-activity pr="${sanitizeAttribute(prKey)}" url="${url}" events="${sanitizeAttribute(types)}" disposition="${disposition}">`,
				lines,
				'</pr-activity>',
			].join('\n'),
		);
	}

	const instruction = events.some(
		(event) => event.disposition === 'queued-for-later',
	)
		? `${QUEUED_WAKE_INSTRUCTION}\n\n${WAKE_INSTRUCTION}`
		: WAKE_INSTRUCTION;
	return `${blocks.join('\n\n')}\n\n${instruction}`;
}

// ── Prompt transport ─────────────────────────────────────────────────

/**
 * Send the wake prompt to the session. Prefers `session.promptAsync`
 * (fire-level acceptance — resolves as soon as the prompt is accepted, like
 * dispatch-lanes' async launch) and falls back to `session.prompt` for
 * clients that lack it. Bounded by withTimeout; returns false on any
 * failure or timeout. Never throws.
 */
async function sendWakePrompt(
	sessionID: string,
	events: FormattedPrEvent[],
	messageID: string,
): Promise<boolean> {
	const active = registration;
	if (!active) return false;

	try {
		const text = buildWakeMessage(events);
		const session = active.client.session as {
			prompt: (args: unknown) => Promise<{ error?: unknown }>;
			promptAsync?: (args: unknown) => Promise<{ error?: unknown }>;
		};
		const args = {
			path: { id: sessionID },
			body: { messageID, parts: [{ type: 'text', text }] },
		};
		const call =
			typeof session.promptAsync === 'function'
				? session.promptAsync(args)
				: session.prompt(args);

		const timeoutMs = _internals.wakePromptTimeoutMs;
		const result = await _internals.withTimeout(
			call,
			timeoutMs,
			new Error(
				`PR wake prompt timed out after ${timeoutMs}ms for session ${sessionID}`,
			),
		);

		if (result && typeof result === 'object' && 'error' in result) {
			const err = (result as { error?: unknown }).error;
			if (err !== undefined && err !== null) {
				_internals.log('[pr-monitor] Wake prompt returned error', {
					sessionID,
					error: JSON.stringify(err).slice(0, 500),
				});
				return false;
			}
		}

		_internals.log('[pr-monitor] Woke session with PR activity', {
			sessionID,
			events: events.map((e) => e.type).join(','),
		});
		return true;
	} catch (err) {
		_internals.log('[pr-monitor] Wake prompt failed', {
			sessionID,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

// ── DI seam for testability ──────────────────────────────────────────

export const _internals: {
	sendWakePrompt: typeof sendWakePrompt;
	withTimeout: typeof withTimeout;
	readPrWorkflowGateState: typeof readPrWorkflowGateState;
	activatePrWorkflow: typeof activatePrWorkflow;
	readPrFeedbackMonitorQueue: typeof readPrFeedbackMonitorQueue;
	claimPrFeedbackMonitorEvents: typeof claimPrFeedbackMonitorEvents;
	wakePromptTimeoutMs: number;
	log: typeof log;
} = {
	sendWakePrompt,
	withTimeout,
	readPrWorkflowGateState,
	activatePrWorkflow,
	readPrFeedbackMonitorQueue,
	claimPrFeedbackMonitorEvents,
	wakePromptTimeoutMs: WAKE_PROMPT_TIMEOUT_MS,
	log,
};

/** Test-only visibility into the bounded session map. */
export function _getTrackedSessionCount(): number {
	return sessionStates.size;
}

/** Test-only visibility into a session's queue length / drop counter. */
export function _getSessionQueueStats(
	sessionID: string,
): { queued: number; dropped: number; busy: boolean } | null {
	const state = sessionStates.get(sessionID);
	if (!state) return null;
	return {
		queued: state.queue.length,
		dropped: state.droppedCount,
		busy: state.busy,
	};
}
