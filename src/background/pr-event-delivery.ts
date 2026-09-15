/**
 * PR Event Wake Delivery — active push of PR events into subscribed sessions.
 *
 * When `pr_monitor.event_delivery === 'prompt'`, PR events detected by the
 * background poll worker are delivered by *waking* the subscribed session
 * with a structured `<pr-activity>` message via the OpenCode SDK session
 * prompt, instead of (or before) the passive advisory channel that only
 * surfaces on the session's next model turn.
 *
 * Registration: `src/index.ts` registers one owner per canonical project root
 * with the plugin SDK client when pr_monitor is enabled with prompt delivery,
 * and forwards `session.idle` events to `noteSessionIdle()` with that root.
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

import { randomUUID } from 'node:crypto';
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
import {
	canonicalRootKeyFresh,
	canonicalRootKeyFreshAsync,
	canonicalRootKeyLexical,
} from '../utils/canonical-root.js';
import { withTimeout } from '../utils/timeout';
import {
	claimPrFeedbackMonitorEvents,
	readPrFeedbackMonitorQueue,
} from './pr-feedback-event-queue.js';
import { notifyPrFeedbackLoop } from './pr-feedback-loop.js';

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
	/** Trusted mode marker produced by the subscriber for prompt delivery. */
	modeSignal?: string;
	/** Lifecycle intake is durable but cannot enter the current workflow yet. */
	disposition?: 'queued-for-later';
}

export interface PrEventDeliveryOptions {
	client: OpencodeClient;
	directory: string;
	config: PrMonitorConfig;
}

interface RegisteredDelivery extends PrEventDeliveryOptions {
	ownerToken: string;
	lexicalKey: string;
	canonicalKey?: string;
	sequence: number;
}

export type PrEventDeliveryRegistration = (() => void) & {
	promote: () => Promise<void>;
};

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

const registrationsByLexical = new Map<string, RegisteredDelivery>();
const registrationsByCanonical = new Map<string, RegisteredDelivery>();
const sessionStates = new Map<string, SessionDeliveryState>();
const MAX_REGISTRATIONS = 64;
let nextRegistrationSequence = 0;

function removeRegistration(entry: RegisteredDelivery): void {
	if (registrationsByLexical.get(entry.lexicalKey) === entry) {
		registrationsByLexical.delete(entry.lexicalKey);
	}
	if (
		entry.canonicalKey &&
		registrationsByCanonical.get(entry.canonicalKey) === entry
	) {
		registrationsByCanonical.delete(entry.canonicalKey);
	}
}

function rootKey(entry: RegisteredDelivery): string {
	return entry.canonicalKey ?? entry.lexicalKey;
}

function sessionKey(entry: RegisteredDelivery, sessionID: string): string {
	return `${rootKey(entry)}\u0000${sessionID}`;
}

/** Resolve an owner without silently routing a multi-root call to another root. */
function resolveRegistration(directory?: string): RegisteredDelivery | null {
	if (directory) {
		const lexical = canonicalRootKeyLexical(directory);
		try {
			const freshKey = _internals.canonicalRootKeyFresh(directory);
			const canonical = registrationsByCanonical.get(freshKey);
			if (canonical) return canonical;
			const direct = registrationsByLexical.get(lexical);
			// A promoted registration whose path was physically retargeted must not
			// be recovered through its stale lexical spelling. Unpromoted entries
			// remain available during the bounded init-to-promotion handoff.
			if (
				direct &&
				(!direct.canonicalKey || direct.canonicalKey === freshKey)
			) {
				return direct;
			}
			return null;
		} catch {
			return null;
		}
	}
	if (registrationsByLexical.size !== 1) return null;
	return registrationsByLexical.values().next().value ?? null;
}

function clearSessionStatesForKey(key: string): void {
	const statePrefix = `${key}\u0000`;
	for (const stateKey of sessionStates.keys()) {
		if (stateKey.startsWith(statePrefix)) sessionStates.delete(stateKey);
	}
}

function clearSessionStatesForEntry(entry: RegisteredDelivery): void {
	clearSessionStatesForKey(entry.lexicalKey);
	if (entry.canonicalKey) clearSessionStatesForKey(entry.canonicalKey);
}

function migrateSessionStates(fromKey: string, toKey: string): void {
	if (fromKey === toKey) return;
	const fromPrefix = `${fromKey}\u0000`;
	for (const [stateKey, state] of sessionStates) {
		if (!stateKey.startsWith(fromPrefix)) continue;
		const sessionID = stateKey.slice(fromPrefix.length);
		const targetKey = `${toKey}\u0000${sessionID}`;
		if (!sessionStates.has(targetKey)) sessionStates.set(targetKey, state);
		sessionStates.delete(stateKey);
	}
}

async function promoteRegistration(
	entry: RegisteredDelivery,
	directory: string,
): Promise<void> {
	if (registrationsByLexical.get(entry.lexicalKey) !== entry) return;
	let canonicalKey: string;
	try {
		canonicalKey = await _internals.canonicalRootKeyFreshAsync(directory);
	} catch (error) {
		_internals.log('[pr-monitor] Wake delivery root promotion failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	// Never allow an async promotion from a disposed/replaced owner to mutate
	// the current root's registration or session state.
	if (registrationsByLexical.get(entry.lexicalKey) !== entry) return;
	const existing = registrationsByCanonical.get(canonicalKey);
	if (existing && existing !== entry) {
		if (existing.sequence > entry.sequence) {
			removeRegistration(entry);
			clearSessionStatesForEntry(entry);
			return;
		}
		removeRegistration(existing);
		clearSessionStatesForEntry(existing);
	}
	const oldKey = rootKey(entry);
	if (
		entry.canonicalKey &&
		entry.canonicalKey !== canonicalKey &&
		registrationsByCanonical.get(entry.canonicalKey) === entry
	) {
		registrationsByCanonical.delete(entry.canonicalKey);
	}
	entry.canonicalKey = canonicalKey;
	registrationsByCanonical.set(canonicalKey, entry);
	migrateSessionStates(oldKey, canonicalKey);
}

/**
 * Register a delivery owner. Called from plugin init when
 * pr_monitor.enabled && event_delivery === 'prompt'. A same-root re-init
 * replaces only that root; different roots coexist. The returned cleanup is
 * owner-guarded so stale disposal cannot remove a replacement.
 */
export function registerPrEventDelivery(
	options: PrEventDeliveryOptions,
): PrEventDeliveryRegistration {
	const lexicalKey = canonicalRootKeyLexical(options.directory);
	const prior = registrationsByLexical.get(lexicalKey);
	if (prior) {
		removeRegistration(prior);
		clearSessionStatesForEntry(prior);
	}
	while (
		registrationsByLexical.size >= MAX_REGISTRATIONS &&
		!registrationsByLexical.has(lexicalKey)
	) {
		const oldest = registrationsByLexical.values().next().value;
		if (oldest === undefined) break;
		removeRegistration(oldest);
		clearSessionStatesForEntry(oldest);
	}
	const ownerToken = randomUUID();
	const entry: RegisteredDelivery = {
		...options,
		ownerToken,
		lexicalKey,
		sequence: ++nextRegistrationSequence,
	};
	registrationsByLexical.set(lexicalKey, entry);
	_internals.log('[pr-monitor] Wake delivery registered', {
		directory: options.directory,
	});
	const unregister = (() => {
		const current = registrationsByLexical.get(lexicalKey);
		if (current?.ownerToken !== ownerToken) return;
		removeRegistration(entry);
		clearSessionStatesForEntry(entry);
	}) as PrEventDeliveryRegistration;
	unregister.promote = () => promoteRegistration(entry, options.directory);
	return unregister;
}

/**
 * Unregister one owner. The no-argument form is retained for tests and
 * process teardown; an owner token prevents a stale cleanup from removing a
 * newer registration for the same canonical root.
 */
export function unregisterPrEventDelivery(
	directory?: string,
	expectedOwnerToken?: string,
): void {
	if (!directory) {
		registrationsByLexical.clear();
		registrationsByCanonical.clear();
		sessionStates.clear();
		return;
	}
	const current = resolveRegistration(directory);
	if (
		!current ||
		(expectedOwnerToken !== undefined &&
			current.ownerToken !== expectedOwnerToken)
	)
		return;
	removeRegistration(current);
	clearSessionStatesForEntry(current);
}

/** Whether a wake deliverer is currently registered. */
export function isPrEventDeliveryRegistered(directory?: string): boolean {
	return resolveRegistration(directory) !== null;
}

// ── Session state helpers ────────────────────────────────────────────

function getSessionState(
	entry: RegisteredDelivery,
	sessionID: string,
): SessionDeliveryState {
	const key = sessionKey(entry, sessionID);
	let state = sessionStates.get(key);
	if (!state) {
		state = { busy: false, queue: [], droppedCount: 0 };
		sessionStates.set(key, state);
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
	directory?: string,
): Promise<boolean> {
	try {
		const active = resolveRegistration(directory);
		if (!active || !sessionID || events.length === 0) return false;

		const state = getSessionState(active, sessionID);

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
			isPrWorkflowAutoWakeSuppressed(active.directory, sessionID)
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
		const ok = await sendWakePromptWithMarker(active, sessionID, toSend);
		if (!ok) {
			// Restore the previously queued events (the caller only owns the
			// advisory fallback for the `events` it passed in this call).
			const current = sessionStates.get(sessionKey(active, sessionID));
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
export function noteSessionIdle(
	sessionID: string,
	directory?: string,
): Promise<void> {
	if (!sessionID) return Promise.resolve();
	return handleSessionIdle(sessionID, directory).catch((err) => {
		_internals.log('[pr-monitor] noteSessionIdle failed', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

async function handleSessionIdle(
	sessionID: string,
	directory?: string,
): Promise<void> {
	const active = resolveRegistration(directory);
	if (!active) return;
	const state = getSessionState(active, sessionID);
	state.busy = false;
	if (isPrWorkflowAutoWakeSuppressed(active.directory, sessionID)) return;
	if (!active.config.auto_pr_feedback) {
		if (state.queue.length === 0) return;
		const queued = state.queue.splice(0, state.queue.length);
		state.busy = true;
		if (!(await sendWakePromptWithMarker(active, sessionID, queued))) {
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
	// Durable events are an intake signal, not approval to switch modes. Keep
	// them queued until the feedback loop's independent oversight gate approves
	// an action; the idle wake only tells the active workflow/user what is waiting.
	const durableToSend: FormattedPrEvent[] = unclaimed.map((event) => ({
		type: event.type,
		repoFullName: event.repoFullName,
		prNumber: event.prNumber,
		prUrl: event.prUrl,
		message: event.message,
		dedupToken: event.dedupToken,
		disposition: 'queued-for-later',
	}));

	const inMemory = state.queue.splice(0, state.queue.length);
	const toSend = dedupeFormattedEvents([...inMemory, ...durableToSend]);
	if (toSend.length === 0) return;
	state.busy = true;
	const ok = await sendWakePromptWithMarker(active, sessionID, toSend);
	if (!ok) {
		state.busy = false;
		enqueueBounded(state, inMemory);
		return;
	}
	// Only an idle session with no active PR_REVIEW is eligible for the loop's
	// post-wake settlement notification. PR_REVIEW remains authoritative, so a
	// queued event must not be claimed or acted on from this wake.
	const postWakeWorkflow = await _internals.readPrWorkflowGateState(
		active.directory,
		sessionID,
	);
	if (!postWakeWorkflow || postWakeWorkflow.mode === 'PR_FEEDBACK') {
		_internals.notifyPrFeedbackLoop(active.directory, sessionID);
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

async function sendWakePromptWithMarker(
	active: RegisteredDelivery,
	sessionID: string,
	events: FormattedPrEvent[],
): Promise<boolean> {
	const messageID = markPrWorkflowPluginWake(active.directory, sessionID);
	// A false transport result is not definitive rejection: withTimeout races
	// the host call without aborting it, so promptAsync may still accept later
	// and emit this exact message ID. Keep the bounded/TTL marker so that late
	// synthetic event cannot be mistaken for a real post-interruption user turn.
	return _internals.sendWakePrompt(
		sessionID,
		events,
		messageID,
		active.directory,
	);
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

function sanitizeModeSignal(value: string | undefined): string | null {
	if (!value) return null;
	const match = value.match(/^\[MODE: PR_FEEDBACK pr="([^"<>\r\n[\]]*)"\]$/);
	return match ? `[MODE: PR_FEEDBACK pr="${match[1]}"]` : null;
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
		// A mixed group must remain mode-neutral: a queued event means the
		// active workflow is still authoritative, so do not let a trusted
		// signal from a different event in the same PR group switch modes.
		const trustedModeSignals =
			disposition === 'active'
				? [
						...new Set(
							groupEvents
								.map((event) => sanitizeModeSignal(event.modeSignal))
								.filter((signal): signal is string => signal !== null),
						),
					]
				: [];
		const lines = groupEvents
			.map((event) => {
				const withoutTrustedSignal = event.modeSignal
					? event.message.split(event.modeSignal).join('')
					: event.message;
				return sanitizeWakeBody(withoutTrustedSignal).trim();
			})
			.join('\n');
		blocks.push(
			[
				`<pr-activity pr="${sanitizeAttribute(prKey)}" url="${url}" events="${sanitizeAttribute(types)}" disposition="${disposition}">`,
				lines,
				...trustedModeSignals,
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
	directory?: string,
): Promise<boolean> {
	const active = resolveRegistration(directory);
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
	notifyPrFeedbackLoop: typeof notifyPrFeedbackLoop;
	canonicalRootKeyFresh: typeof canonicalRootKeyFresh;
	canonicalRootKeyFreshAsync: typeof canonicalRootKeyFreshAsync;
	wakePromptTimeoutMs: number;
	log: typeof log;
} = {
	sendWakePrompt,
	withTimeout,
	readPrWorkflowGateState,
	activatePrWorkflow,
	readPrFeedbackMonitorQueue,
	claimPrFeedbackMonitorEvents,
	notifyPrFeedbackLoop,
	canonicalRootKeyFresh,
	canonicalRootKeyFreshAsync,
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
	directory?: string,
): { queued: number; dropped: number; busy: boolean } | null {
	let state: SessionDeliveryState | undefined;
	if (directory) {
		const active = resolveRegistration(directory);
		if (active) state = sessionStates.get(sessionKey(active, sessionID));
	} else {
		for (const [key, candidate] of sessionStates) {
			if (key.endsWith(`\u0000${sessionID}`)) {
				state = candidate;
				break;
			}
		}
	}
	if (!state) return null;
	return {
		queued: state.queue.length,
		dropped: state.droppedCount,
		busy: state.busy,
	};
}
