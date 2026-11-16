/**
 * v2 event subscription pump (issue #3004 / #2910).
 *
 * Consumes the v2 host's event stream (async iterable from
 * `ctx.event.subscribe()`) and maps host events onto the plugin's existing v1
 * event handler. The pump runs detached; the returned stop function breaks
 * iteration (called by the v2 cleanup).
 *
 * Event-name map (full table in docs/host/v2-hook-inventory.md row 14):
 *
 *   v2 event                → v1 handler input
 *   ------------------------+-------------------------------------------
 *   session.idle            → { type: 'session.idle', properties }
 *   session.status.updated  → { type: 'session.idle', properties } (state watch)
 *   session.status          → { type: 'session.status', properties } (type-preserving; #3022)
 *   session.text.delta      → { type: 'message.part.updated', properties }
 *   session.text.ended      → { type: 'message.updated', properties }
 *   session.tool.called     → { type: 'message.part.updated', properties }
 *   session.tool.success    → { type: 'message.updated', properties }
 *   session.tool.failed     → { type: 'message.updated', properties }
 *   session.execution.failed → { type: 'session.error', properties }
 *   session.error           → { type: 'session.error', properties } (SDK dialect; #3022)
 *   session.deleted / session.created → same-name v1 types
 *
 * Payload dialect (#3022 D3 live capture): plugin-stream envelopes carry the
 * payload under `data` (live 2.0.21 emits `session.execution.failed` with
 * `data:{sessionID, error:{...}}`); the @opencode-ai/sdk SSE/REST dialect
 * carries it under `properties` with the error event named `session.error`.
 * Both names and both payload keys are accepted.
 *
 * Unmapped event types are counted in a bounded debug log, never silently
 * assumed. This module is named deferred-/startDeferred- per the C6 await
 * convention (its awaits live in deferred-named helpers).
 */

import { recordSessionChatAgent } from '../../models/task-model-routing';
import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import { isPlainObject, isV2SubagentToolId } from './hooks.js';
import { recordV2SessionErrorFromEnvelope } from './session-client';
import type { V1HooksSubset, V2EventEnvelope, V2PluginContext } from './types';

const V2_EVENT_BATCH_TIMEOUT_MS = 60_000;
const UNMAPPED_LOG_LIMIT = 20;

interface MappedEvent {
	type: string;
	properties: Record<string, unknown>;
}

/**
 * Host event names this pump reads OUTSIDE the mapper switch (issue #3401,
 * PR #3402 review PRR-004). The frozen `#3022` event-name contract test pins
 * only mapper `case` labels, so a name read pump-side must be pinned here or a
 * host rename/omission silently disables the feature with every test green —
 * the exact defect class that contract exists to prevent. `input.started` is
 * the sole source of the subagent gate below; `agent.selected` seeds v1
 * session identity.
 */
export const PUMP_SIDE_READ_EVENT_NAMES = [
	'session.tool.input.started',
	'session.agent.selected',
] as const;

/**
 * Shared payload extraction (#3022 dialect rule): live plugin-stream
 * envelopes carry the payload under `data`; the SDK SSE/REST dialect under
 * `properties`. Every reader of an envelope's fields must go through this.
 */
function envelopePayload(envelope: V2EventEnvelope): Record<string, unknown> {
	return (
		(envelope as { data?: Record<string, unknown> }).data ??
		(envelope as { properties?: Record<string, unknown> }).properties ??
		{}
	);
}

/**
 * Bounds for host-supplied identifiers recorded or forwarded by this module.
 * Sibling schemas already bound comparable ids (MAX_ID_CHARS in
 * src/evidence/phase-participation.ts; MAX_V2_WRAPPER_INNER_CHARS in
 * hooks.ts); an unbounded id would let one envelope retain arbitrary memory
 * in the registry or flow downstream.
 */
const MAX_TRACKED_TOOL_NAME_CHARS = 256;
const MAX_DISPATCH_ID_CHARS = 256;

function isBoundedId(value: string): boolean {
	return value.trim() !== '' && value.length <= MAX_DISPATCH_ID_CHARS;
}

/**
 * Pump-side tool-name registry (issue #3401). The v2 tool events carry the
 * dispatch identity as `(sessionID, id)` but only `session.tool.input.started`
 * carries the tool NAME — and the scope-activation synthesis below must be
 * gated on the call actually being the subagent tool. Bounded per AGENTS.md
 * invariant 8: FIFO eviction, per-(session,call) keys so sessions never mix;
 * an evicted or never-recorded name degrades to today's fail-closed drop.
 * Only subagent names are stored (PR #3402 Copilot review): non-subagent
 * names are never usable at the gate, so storing them would only consume
 * eviction budget.
 */
const MAX_TRACKED_TOOL_NAMES = 512;
const toolNameByDispatchKey = new Map<string, string>();

function rememberToolNameFromEnvelope(envelope: V2EventEnvelope): void {
	if (envelope?.type !== 'session.tool.input.started') return;
	const payload = envelopePayload(envelope);
	const name = typeof payload.name === 'string' ? payload.name : undefined;
	if (!name || name.length > MAX_TRACKED_TOOL_NAME_CHARS) return;
	if (!isV2SubagentToolId(name)) return;
	const sessionID =
		typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
	const callID = typeof payload.id === 'string' ? payload.id : undefined;
	if (!sessionID || !callID) return;
	if (!isBoundedId(sessionID) || !isBoundedId(callID)) return;
	const key = dispatchKey(sessionID, callID);
	// Refresh insertion order so a re-observed dispatch is not evicted ahead
	// of newer entries (Map.set alone preserves the original position).
	toolNameByDispatchKey.delete(key);
	if (toolNameByDispatchKey.size >= MAX_TRACKED_TOOL_NAMES) {
		const oldest = toolNameByDispatchKey.keys().next().value;
		if (oldest !== undefined) toolNameByDispatchKey.delete(oldest);
	}
	toolNameByDispatchKey.set(key, name);
}

/**
 * Length-prefixed so no (sessionID, callID) pair can alias onto another pair's
 * key regardless of the id characters the host mints.
 */
function dispatchKey(sessionID: string, callID: string): string {
	return `${sessionID.length}#${sessionID}${callID}`;
}

function lookupToolNameForDispatch(
	sessionID: string,
	callID: string,
): string | undefined {
	return toolNameByDispatchKey.get(dispatchKey(sessionID, callID));
}

/** Drop the pump-side tool-name registry. Called by the v2 plugin cleanup so a
 * re-setup in the same process starts without stale (session,call)→name
 * residue, and exported through `_internals` for test isolation (AGENTS.md
 * invariant 7/8). */
export function clearToolNameRegistry(): void {
	toolNameByDispatchKey.clear();
}

export const _internals = {
	clearToolNameRegistry,
};

/**
 * Guarded read of the child session id from a progress envelope (issue #3401,
 * PR #3402 review PRR-012). `isPlainObject` rejects arrays and null, and the
 * whole read — including the `metadata` property access itself — is wrapped so
 * a throwing accessor cannot escape into the pump loop (which would terminate
 * the pump). Class instances and prototype-inherited `sessionID` values still
 * read through — they grant nothing on their own, because the durable claim
 * (claimScopeBindingForChildDurably) remains the sole authority for whatever
 * child id is delivered.
 */
function readProgressChildSessionID(
	data: Record<string, unknown>,
): string | undefined {
	try {
		const metadata = data.metadata;
		if (!isPlainObject(metadata)) return undefined;
		const child = metadata.sessionID;
		return typeof child === 'string' ? child : undefined;
	} catch {
		// A throwing accessor on `metadata` or `metadata.sessionID` must not
		// escape into the pump loop (which would terminate the pump).
		return undefined;
	}
}

/** Map a v2 event envelope onto the v1 handler input (or undefined). */
export function mapV2EventToV1(
	envelope: V2EventEnvelope,
	lookupToolName?: (sessionID: string, callID: string) => string | undefined,
): MappedEvent | undefined {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type === undefined) return undefined;
	// #3022: live plugin-stream envelopes carry the payload under `data`; the
	// SDK SSE/REST dialect carries it under `properties`. Accept both.
	const data = envelopePayload(envelope);
	const sessionID =
		typeof data.sessionID === 'string' ? data.sessionID : undefined;
	switch (type) {
		case 'session.idle':
		case 'session.status.updated':
			return {
				type: 'session.idle',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.status':
			// #3022 plan-critic blocker 1: type-preserving. The v1 handler's
			// terminalization predicate filters `session.status` on
			// status === 'idle' or status.type === 'idle'|'error'
			// (src/index.ts isTerminalSessionEvent), so live `busy`/`retry`
			// transitions can never terminalize a running session the way a
			// premature `session.idle` mapping would.
			return {
				type: 'session.status',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.error':
		case 'session.execution.failed':
			// v1 consumers key on 'session.error' (the src/index.ts session.error
			// branch: model-fallback advance, pr-workflow auto-wake). Live hosts
			// emit 'session.execution.failed' (D3 capture); the SDK dialect
			// names it 'session.error' — both map here.
			return {
				type: 'session.error',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.deleted':
			// v1 terminal cleanup (delegation-gate sessionEnded, owner cleanup,
			// pr-workflow gate terminalization) keys on 'session.deleted'.
			return {
				type: 'session.deleted',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.created':
			// v1 pr-workflow session resolver keys on 'session.created'.
			return {
				type: 'session.created',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.text.delta':
		case 'session.tool.called':
		case 'session.tool.input.delta':
			return {
				type: 'message.part.updated',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.tool.progress': {
			// Issue #3401: the v2 subagent tool publishes the CHILD session id
			// as live progress metadata (`metadata.sessionID`, emitted right
			// after child-session creation, before the child runs — host
			// packages/core/src/tool/plugin/subagent.ts). Synthesize the v1
			// ToolPart shape the scope-activation handler requires
			// (src/index.ts ~3884: part.type/callID/sessionID/state.metadata.
			// sessionId). Gated on the tracked tool name so a non-subagent
			// tool's progress metadata can never masquerade as a Task dispatch;
			// empty or self-referencing ids fail closed (and the v1 guard
			// re-checks parent ≠ child before claiming). The durable claim
			// (claimScopeBindingForChildDurably) remains the sole authority.
			const callID = typeof data.id === 'string' ? data.id : undefined;
			const childSessionID = readProgressChildSessionID(data);
			const drop = (reason: string): undefined => {
				// Distinct from the pump's "not mapped" line: the type IS mapped;
				// this gate rejected it. A recurrence of #3401 must be
				// diagnosable, not silent (PR #3402 review PRR-008).
				log('v2 subagent progress dropped', { reason });
				return undefined;
			};
			if (!lookupToolName) return drop('no-tool-name-lookup');
			if (typeof sessionID !== 'string' || !isBoundedId(sessionID))
				return drop('invalid-parent-session');
			if (!callID || !isBoundedId(callID)) return drop('invalid-call-id');
			if (!childSessionID || !isBoundedId(childSessionID))
				return drop('invalid-child-session');
			if (childSessionID === sessionID) return drop('self-referencing-child');
			const toolName = lookupToolName(sessionID, callID);
			if (!toolName) return drop('untracked-tool-name');
			if (!isV2SubagentToolId(toolName)) return drop('non-subagent-tool');
			return {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						// Collapses to the bare v1 id, mirroring the #3169/#3180
						// tool-boundary translation policy (hooks.ts).
						tool: 'task',
						callID,
						sessionID,
						state: { metadata: { sessionId: childSessionID } },
					},
				},
			};
		}
		case 'session.text.ended':
		case 'session.tool.success':
		case 'session.tool.failed':
			return {
				type: 'message.updated',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		default:
			return undefined;
	}
}

/** Dispatch one mapped event through the v1 handler (deferred-named). */
async function deferredDispatch(
	hooks: V1HooksSubset,
	mapped: MappedEvent,
): Promise<void> {
	const handler = hooks.event;
	if (typeof handler !== 'function') return;
	await withTimeout(
		Promise.resolve(
			handler({ event: { type: mapped.type, properties: mapped.properties } }),
		),
		V2_EVENT_BATCH_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: event dispatch exceeded budget'),
	).catch((err: unknown) => {
		log('v2 event dispatch failed (non-fatal)', {
			type: mapped.type,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

/**
 * Seed v1 session identity from identity-bearing v2 envelopes (issue #3022 D1).
 *
 * Live capture (d3/run2.log): `session.created` and `session.agent.selected`
 * carry `data.agent`. This runs PUMP-SIDE (not as mapper case labels — those
 * names are in neither the SDK union nor the mapper's legacy allowlist, and
 * Branch B of the v1 session.error arm resolves identity through
 * `recordSessionChatAgent`'s map, the same bounded store the v1 chat boundary
 * writes). Fail-open by construction: non-string fields are ignored.
 */
export function seedSessionIdentityFromEnvelope(
	envelope: V2EventEnvelope,
): void {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type !== 'session.created' && type !== 'session.agent.selected') return;
	const payload = envelopePayload(envelope);
	const sessionID =
		typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
	const agent = typeof payload.agent === 'string' ? payload.agent : undefined;
	if (sessionID && agent) recordSessionChatAgent(sessionID, agent);
}

/** Start the detached event pump. Returns a stop function. Named per the C6
 * convention (deferred).
 */
export function startDeferredEventPump(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
): () => void {
	let stopped = false;
	const unmappedSeen = new Set<string>();
	void (async () => {
		try {
			const subscribe = ctx?.event?.subscribe;
			if (typeof subscribe !== 'function') {
				log(
					'v2 event subscribe surface absent; event pump idle (non-fatal)',
					{},
				);
				return;
			}
			const iterable = await withTimeout(
				Promise.resolve(subscribe()),
				V2_EVENT_BATCH_TIMEOUT_MS,
				new Error('[opencode-swarm] v2: event subscribe exceeded budget'),
			);
			if (
				!iterable ||
				typeof (iterable as AsyncIterable<V2EventEnvelope>)[
					Symbol.asyncIterator
				] !== 'function'
			) {
				log(
					'v2 event subscribe returned a non-iterable; event pump idle (non-fatal)',
					{},
				);
				return;
			}
			for await (const envelope of iterable as AsyncIterable<V2EventEnvelope>) {
				if (stopped) break;
				seedSessionIdentityFromEnvelope(envelope);
				// #3169 Phase 2 (C4): v2 surfaces provider errors only via the
				// event stream (no error text in context()); record them for the
				// session-client shim's result translation. Sync, bounded, O(1).
				recordV2SessionErrorFromEnvelope(envelope);
				// #3401: remember tool names for dispatch-gated synthesis below.
				rememberToolNameFromEnvelope(envelope);
				const mapped = mapV2EventToV1(envelope, lookupToolNameForDispatch);
				if (mapped === undefined) {
					const t =
						typeof envelope?.type === 'string' ? envelope.type : '(no type)';
					if (!unmappedSeen.has(t) && unmappedSeen.size < UNMAPPED_LOG_LIMIT) {
						unmappedSeen.add(t);
						log('v2 event type not mapped (ignored)', { type: t });
					}
					continue;
				}
				await deferredDispatch(hooks, mapped);
			}
		} catch (err) {
			if (!stopped) {
				log('v2 event pump stopped on error (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	})();
	return () => {
		stopped = true;
	};
}
