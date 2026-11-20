/**
 * Opt-in OpenCode v2 tool timing trace. Emits metadata only: no tool arguments,
 * prompts, model output, filenames, or results. Set SWARM_TIMING_TRACE=1.
 *
 * Each record has a UTC wall-clock timestamp, tool call id, parent session id,
 * event phase, and per-phase latency (milliseconds). The intervals between
 * tools are NOT proven idle time: LLM generation and scheduling occur there.
 * All diagnostic state is bounded and entirely disabled by default.
 */

import type { V2ToolHookInput } from './types';

type TimingPhase =
	| 'tool_before_begin'
	| 'tool_before_end'
	| 'tool_before_error'
	| 'tool_after_begin'
	| 'tool_after_end';

type ToolStamp = {
	beforeBeginMs: number;
	beforeEndMs?: number;
};

const MAX_TIMING_CALLS = 4096;
const MAX_TIMING_SESSIONS = 1024;
const pending = new Map<string, ToolStamp>();
const lastSessionStamp = new Map<string, number>();
let peakPendingCalls = 0;

export function recordV2ToolTiming(
	event: Pick<V2ToolHookInput, 'id' | 'tool' | 'sessionID' | 'agent'>,
	phase: TimingPhase,
	extra: { translatedState?: string; resultStatus?: string } = {},
): void {
	if (process.env.SWARM_TIMING_TRACE !== '1') return;
	try {
		const now = Date.now();
		const key = `${event.sessionID}:${event.id}`;
		const prior = pending.get(key);
		const last = lastSessionStamp.get(event.sessionID);
		const data: Record<string, unknown> = {
			at: new Date(now).toISOString(),
			event: phase,
			callID: event.id,
			tool: event.tool,
			sessionID: event.sessionID,
			agent: typeof event.agent === 'string' ? event.agent : null,
		};
		if (last !== undefined) data.sinceLastSessionEventMs = Math.max(0, now - last);
		if (phase === 'tool_before_begin') {
			if (pending.size >= MAX_TIMING_CALLS) {
				// Strict cap: a missing tool-after must not grow diagnostic memory.
				const first = pending.keys().next().value;
				if (first !== undefined) pending.delete(first);
			}
			pending.set(key, { beforeBeginMs: now });
		} else if (phase === 'tool_before_end' || phase === 'tool_before_error') {
			if (prior) {
				data.beforeHookMs = Math.max(0, now - prior.beforeBeginMs);
				prior.beforeEndMs = now;
			}
			if (phase === 'tool_before_error') pending.delete(key);
		} else if (phase === 'tool_after_begin') {
			if (prior) {
				data.fromBeforeStartMs = Math.max(0, now - prior.beforeBeginMs);
				if (prior.beforeEndMs !== undefined)
					data.hostToolMs = Math.max(0, now - prior.beforeEndMs);
			}
		} else if (phase === 'tool_after_end') {
			if (prior) data.totalCallMs = Math.max(0, now - prior.beforeBeginMs);
			pending.delete(key);
		}
		if (extra.translatedState !== undefined) data.translatedState = extra.translatedState;
		if (extra.resultStatus !== undefined) data.resultStatus = extra.resultStatus;
		peakPendingCalls = Math.max(peakPendingCalls, pending.size);
		data.pendingToolCalls = pending.size;
		data.peakPendingToolCalls = peakPendingCalls;
		if (!lastSessionStamp.has(event.sessionID) && lastSessionStamp.size >= MAX_TIMING_SESSIONS) {
			const first = lastSessionStamp.keys().next().value;
			if (first !== undefined) lastSessionStamp.delete(first);
		}
		lastSessionStamp.delete(event.sessionID);
		lastSessionStamp.set(event.sessionID, now);
		console.error('[SWARM_TIMING_TRACE] ' + JSON.stringify(data));
	} catch {
		// Diagnostic output must never alter the authorization or dispatch path.
	}
}

/** Lightweight prompt/compaction marks to expose long pauses before a tool. */
export function recordV2SessionTiming(
	sessionID: string,
	event: 'prompt_begin' | 'prompt_end' | 'compaction_begin' | 'compaction_end'
		| 'native_child_verified' | 'execution_succeeded' | 'execution_interrupted'
		| 'execution_failed' | 'execution_ignored',
): void {
	if (process.env.SWARM_TIMING_TRACE !== '1') return;
	try {
		const now = Date.now();
		const last = lastSessionStamp.get(sessionID);
		const data: Record<string, unknown> = {
			at: new Date(now).toISOString(), event, sessionID,
		};
		if (last !== undefined) data.sinceLastSessionEventMs = Math.max(0, now - last);
		if (!lastSessionStamp.has(sessionID) && lastSessionStamp.size >= MAX_TIMING_SESSIONS) {
			const first = lastSessionStamp.keys().next().value;
			if (first !== undefined) lastSessionStamp.delete(first);
		}
		lastSessionStamp.delete(sessionID);
		lastSessionStamp.set(sessionID, now);
		console.error('[SWARM_TIMING_TRACE] ' + JSON.stringify(data));
	} catch {
		// Best-effort only.
	}
}
