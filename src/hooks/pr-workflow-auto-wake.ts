import * as path from 'node:path';
import { readPrWorkflowGateState } from './pr-workflow-gate.js';

export const _internals: {
	readPrWorkflowGateState: typeof readPrWorkflowGateState;
} = {
	readPrWorkflowGateState,
};

/** Bound module state: every entry is keyed by project plus parent session. */
export const MAX_TRACKED_PR_WORKFLOW_WAKE_STATES = 200;
export const PLUGIN_WAKE_MARKER_TTL_MS = 60_000;

type PausePhase = 'awaiting-idle' | 'paused' | 'resuming';

interface PauseState {
	phase: PausePhase;
	pausedAt: number;
}

interface PluginWakeMarker {
	messageID: string;
	createdAt: number;
}

export interface PrWorkflowAutoWakeDecision {
	sessionID?: string;
	suppressWake: boolean;
}

const pauseStates = new Map<string, PauseState>();
const pluginWakeMarkers = new Map<string, PluginWakeMarker[]>();
let nextMarkerID = 0;

function projectSessionKey(directory: string, sessionID: string): string {
	return `${path.resolve(directory)}\0${sessionID.trim()}`;
}

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > MAX_TRACKED_PR_WORKFLOW_WAKE_STATES) {
		const oldest = map.keys().next().value;
		if (typeof oldest !== 'string') break;
		map.delete(oldest);
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function eventEnvelope(
	event: Record<string, unknown>,
): Record<string, unknown> {
	return asRecord(event.properties) ?? asRecord(event.data) ?? {};
}

function eventSessionID(event: Record<string, unknown>): string | undefined {
	const envelope = eventEnvelope(event);
	const info = asRecord(envelope.info);
	const candidate =
		envelope.sessionID ??
		envelope.sessionId ??
		info?.sessionID ??
		info?.sessionId ??
		(event.type === 'session.deleted' || event.type === 'session.removed'
			? info?.id
			: undefined);
	return typeof candidate === 'string' && candidate.trim()
		? candidate.trim()
		: undefined;
}

function isExactAbortEvent(event: Record<string, unknown>): boolean {
	const envelope = eventEnvelope(event);
	if (event.type === 'session.error') {
		return asRecord(envelope.error)?.name === 'MessageAbortedError';
	}
	if (event.type !== 'message.updated') return false;
	const info = asRecord(envelope.info);
	return (
		info?.role === 'assistant' &&
		asRecord(info.error)?.name === 'MessageAbortedError'
	);
}

function isUserMessageEvent(event: Record<string, unknown>): boolean {
	if (event.type !== 'message.updated') return false;
	return asRecord(eventEnvelope(event).info)?.role === 'user';
}

function pruneMarkers(key: string, now = Date.now()): PluginWakeMarker[] {
	const current = pluginWakeMarkers.get(key) ?? [];
	const live = current.filter(
		(marker) => now - marker.createdAt <= PLUGIN_WAKE_MARKER_TTL_MS,
	);
	if (live.length === 0) pluginWakeMarkers.delete(key);
	else if (live.length !== current.length) pluginWakeMarkers.set(key, live);
	return live;
}

function consumePluginWakeMarker(key: string, messageID: string): boolean {
	const live = pruneMarkers(key);
	const markerIndex = live.findIndex(
		(marker) => marker.messageID === messageID,
	);
	if (markerIndex < 0) return false;
	live.splice(markerIndex, 1);
	if (live.length === 0) pluginWakeMarkers.delete(key);
	else rememberBounded(pluginWakeMarkers, key, live);
	return true;
}

/** Mark a plugin-authored prompt until its synthetic user event is observed. */
export function markPrWorkflowPluginWake(
	directory: string,
	sessionID: string,
): string {
	const key = projectSessionKey(directory, sessionID);
	// OpenCode accepts caller-supplied message IDs and emits the same ID on the
	// resulting user-role message.updated event. Exact identity is required here:
	// timing/order heuristics can otherwise mistake a real user turn for a
	// plugin-authored wake (or re-awaken a session immediately after Esc).
	const messageID = `msg_swarm_wake_${Date.now().toString(36)}_${(++nextMarkerID).toString(36)}`;
	const markers = pruneMarkers(key);
	markers.push({ messageID, createdAt: Date.now() });
	rememberBounded(pluginWakeMarkers, key, markers);
	return messageID;
}

/** Remove a marker only when the host definitively rejected the prompt. */
export function cancelPrWorkflowPluginWake(
	directory: string,
	sessionID: string,
	messageID: string,
): void {
	const key = projectSessionKey(directory, sessionID);
	const remaining = pruneMarkers(key).filter(
		(marker) => marker.messageID !== messageID,
	);
	if (remaining.length === 0) pluginWakeMarkers.delete(key);
	else rememberBounded(pluginWakeMarkers, key, remaining);
}

export function isPrWorkflowAutoWakeSuppressed(
	directory: string,
	sessionID: string,
): boolean {
	return pauseStates.has(projectSessionKey(directory, sessionID));
}

export function clearPrWorkflowAutoWakeState(
	directory: string,
	sessionID: string,
): void {
	pauseStates.delete(projectSessionKey(directory, sessionID));
}

function clearPrWorkflowAutoWakeSession(
	directory: string,
	sessionID: string,
): void {
	const key = projectSessionKey(directory, sessionID);
	pauseStates.delete(key);
	pluginWakeMarkers.delete(key);
}

/**
 * Observe host events that distinguish a user interruption from an ordinary
 * idle boundary. The durable workflow gate remains intact; only automatic
 * prompts pause. A later real user turn re-enables wakes after that turn's
 * idle boundary.
 */
export async function observePrWorkflowAutoWakeEvent(
	directory: string,
	rawEvent: unknown,
): Promise<PrWorkflowAutoWakeDecision> {
	const event = asRecord(rawEvent);
	if (!event) return { suppressWake: false };
	const sessionID = eventSessionID(event);
	if (!sessionID) return { suppressWake: false };
	const key = projectSessionKey(directory, sessionID);

	if (event.type === 'session.deleted' || event.type === 'session.removed') {
		clearPrWorkflowAutoWakeSession(directory, sessionID);
		return { sessionID, suppressWake: false };
	}

	if (isExactAbortEvent(event)) {
		// OpenCode dispatches event hooks without awaiting the prior hook call.
		// Publish the pause before durable I/O so a following idle event cannot
		// overtake this abort and enter an automatic wake path.
		rememberBounded(pauseStates, key, {
			phase: 'awaiting-idle',
			pausedAt: Date.now(),
		});
		// Child-lane aborts must never pause the parent: only the exact session
		// owning a durable gate is eligible. A transient read failure is
		// ambiguous, so preserve the pause and fail closed toward less automation.
		try {
			if (await _internals.readPrWorkflowGateState(directory, sessionID)) {
				return { sessionID, suppressWake: true };
			}
			clearPrWorkflowAutoWakeState(directory, sessionID);
			return { sessionID, suppressWake: false };
		} catch {
			return { sessionID, suppressWake: true };
		}
	}

	const paused = pauseStates.get(key);
	if (isUserMessageEvent(event)) {
		const info = asRecord(eventEnvelope(event).info);
		const messageID = typeof info?.id === 'string' ? info.id : undefined;
		if (messageID && consumePluginWakeMarker(key, messageID)) {
			// promptAsync produces a user-role message too. Only the exact
			// caller-supplied message ID proves this event is synthetic.
			return { sessionID, suppressWake: Boolean(paused) };
		}
		if (paused) {
			// A non-matching user message is an explicit user turn. Accept it even
			// if it races the first post-abort idle boundary.
			rememberBounded(pauseStates, key, { ...paused, phase: 'resuming' });
			return { sessionID, suppressWake: true };
		}
		return { sessionID, suppressWake: false };
	}

	if (event.type === 'session.idle' && paused) {
		try {
			if (!(await _internals.readPrWorkflowGateState(directory, sessionID))) {
				clearPrWorkflowAutoWakeState(directory, sessionID);
				return { sessionID, suppressWake: false };
			}
		} catch {
			// Preserve the existing pause on transient durable-state read failures.
			return { sessionID, suppressWake: true };
		}
		// The durable read yields to concurrently dispatched host events. Use the
		// current phase so a real user turn observed during that read cannot be
		// overwritten by this idle handler's stale pre-read snapshot. If another
		// event cleared the state, suppress this already-in-flight idle once
		// without resurrecting it.
		const currentPause = pauseStates.get(key);
		if (!currentPause) return { sessionID, suppressWake: true };
		if (currentPause.phase === 'awaiting-idle') {
			rememberBounded(pauseStates, key, {
				...currentPause,
				phase: 'paused',
			});
			return { sessionID, suppressWake: true };
		}
		if (currentPause.phase === 'resuming') {
			pauseStates.delete(key);
			return { sessionID, suppressWake: true };
		}
		return { sessionID, suppressWake: true };
	}

	return { sessionID, suppressWake: Boolean(paused) };
}

export const _test_exports = {
	reset(): void {
		pauseStates.clear();
		pluginWakeMarkers.clear();
		nextMarkerID = 0;
	},
	getPausePhase(directory: string, sessionID: string): PausePhase | undefined {
		return pauseStates.get(projectSessionKey(directory, sessionID))?.phase;
	},
	getPluginWakeMarkerCount(
		directory: string,
		sessionID: string,
		now = Date.now(),
	): number {
		return pruneMarkers(projectSessionKey(directory, sessionID), now).length;
	},
};
