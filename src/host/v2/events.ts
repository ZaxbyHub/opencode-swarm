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
 *   session.status.updated  → { type: 'session.status', properties } (type-preserving)
 *   session.status          → { type: 'session.status', properties } (type-preserving; #3022)
 *   session.inbox.enqueued (verified subagent synthetic) → { type: 'message.part.updated', properties: {part} }
 *   session.synthetic (verified subagent synthetic) → same (SDK fallback)
 *   session.text.delta      → ignored (ephemeral fragment)
 *   session.text.ended      → { type: 'message.part.updated', properties.part: text }
 *   session.tool.called     → { type: 'message.part.updated', properties.part: tool running }
 *   session.tool.success    → { type: 'message.part.updated', properties.part: tool completed }
 *   session.tool.failed     → { type: 'message.part.updated', properties.part: tool error }
 *   session.execution.succeeded (verified child) → { type: 'session.idle', properties }
 *   session.execution.interrupted (user/inactivity, verified child) → { type: 'session.status', status idle }
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

import { noteChildSessionEvent } from '../../background/child-activity';
import { recordSessionChatAgent } from '../../models/task-model-routing';
import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import {
	noteDelegationHostEvent,
	noteDelegationToolEvent,
} from './delegation-trace';
import {
	isPlainObject,
	isV2SubagentToolId,
	renderV1TaskEnvelopeFromV2,
} from './hooks.js';
import {
	isTrackedNativeChildSession,
	rememberVerifiedNativeChild,
	verifiedNativeChildParent,
} from './native-async-mode';
import { recordV2SessionErrorFromEnvelope } from './session-client';
import { recordV2SessionTiming } from './timing-trace';
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
 * All bounded tool names are recorded for v1 tool-state translation. Scope
 * activation still explicitly rejects every non-subagent name and happens
 * ONLY via the host's trusted session.tool.progress identity path.
 */
const MAX_TRACKED_TOOL_NAMES = 512;
const toolNameByDispatchKey = new Map<string, string>();

/**
 * 2026-11-26 (task 2.15 liveness wedge): feed the child-activity registry
 * from every session-scoped host event. Metadata only — the session id and
 * the event type; never payload text. The registry is what the background
 * delegation stale sweep consults before flipping a `pending`/`running`
 * record to `stale`: a child with a recent event or an OPEN tool call (a
 * single long execution emits `session.tool.called` at its start and nothing
 * until it completes) is alive and must not be swept on store-write age.
 */
function noteChildActivityFromEnvelope(envelope: V2EventEnvelope): void {
	try {
		const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
		if (type === undefined) return;
		const payload = envelopePayload(envelope);
		const sessionID =
			typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
		if (!sessionID) return;
		switch (type) {
			case 'session.tool.called':
				noteChildSessionEvent(sessionID, 'tool_open');
				return;
			case 'session.tool.success':
			case 'session.tool.failed':
				noteChildSessionEvent(sessionID, 'tool_close');
				return;
			case 'session.execution.succeeded':
			case 'session.execution.interrupted':
			case 'session.execution.failed':
				noteChildSessionEvent(sessionID, 'session_end');
				return;
			default:
				noteChildSessionEvent(sessionID, 'event');
		}
	} catch {
		/* best-effort only — the registry must never break the pump */
	}
}

/**
 * r17 §8: feed host session events into the opt-in delegation tracer.
 * Metadata only — sessionID, event type, and (for tool events) the tool
 * NAME resolved through the same bounded lookup the dispatch synthesis
 * uses. Never payload text, arguments, results, or model output.
 */
function noteDelegationTraceEnvelope(
	envelope: V2EventEnvelope,
	lookupToolName: (sessionID: string, callID: string) => string | undefined,
): void {
	if (process.env.SWARM_DELEGATION_TRACE !== '1') return;
	try {
		const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
		if (type === undefined) return;
		const payload = envelopePayload(envelope);
		const sessionID =
			typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
		if (!sessionID) return;
		switch (type) {
			case 'session.created':
			case 'session.text.delta':
			case 'session.step.ended':
			case 'session.inbox.enqueued':
			case 'session.execution.succeeded':
			case 'session.execution.interrupted':
			case 'session.execution.failed':
			case 'session.error':
				noteDelegationHostEvent(
					sessionID,
					type as Parameters<typeof noteDelegationHostEvent>[1],
				);
				return;
			case 'session.tool.called':
			case 'session.tool.success':
			case 'session.tool.failed': {
				const callID = typeof payload.id === 'string' ? payload.id : undefined;
				const tool =
					(callID !== undefined
						? lookupToolName(sessionID, callID)
						: undefined) ??
					(typeof payload.name === 'string' ? payload.name : 'unknown');
				noteDelegationToolEvent(
					sessionID,
					tool,
					type === 'session.tool.called'
						? 'called'
						: type === 'session.tool.success'
							? 'success'
							: 'failed',
				);
				return;
			}
			default:
				return;
		}
	} catch {
		/* the tracer must never alter the event pump */
	}
}

/**
 * The tool-name gate is checked before this mapping is produced. Only the
 * emitted trusted tool-progress shape can register a child identity.
 */
function rememberNativeChildFromProgress(mapped: MappedEvent): void {
	const part = mapped.properties.part;
	if (!isPlainObject(part) || part.tool !== 'task') return;
	const state = part.state;
	if (!isPlainObject(state) || !isPlainObject(state.metadata)) return;
	const child = state.metadata.sessionId;
	const parent = part.sessionID;
	if (typeof child !== 'string' || typeof parent !== 'string') return;
	rememberVerifiedNativeChild(child, parent);
}

function rememberToolNameFromEnvelope(envelope: V2EventEnvelope): void {
	if (envelope?.type !== 'session.tool.input.started') return;
	const payload = envelopePayload(envelope);
	const name = typeof payload.name === 'string' ? payload.name : undefined;
	if (!name || name.length > MAX_TRACKED_TOOL_NAME_CHARS) return;
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

/**
 * OpenCode 2.3 sends a completed subagent's output to its parent through
 * `session.inbox.enqueued` (a durable synthetic item), followed by
 * `session.inbox.delivered` when the parent consumes it. Only the enqueued
 * event contains the synthetic item and can be translated without a lookup;
 * delivered has only inboxID and is intentionally not interpreted as terminal.
 * Observe enqueued so a parent that never wakes cannot strand a completed coder. Older SDKs may
 * expose the same notification as `session.synthetic` instead. Neither event
 * is a v1 `message.part.updated`, so the background completion observer never
 * saw it and left both the coder and critic on pending forever.
 *
 * Convert ONLY host-labelled, structurally consistent subagent notices for a
 * host-verified child of the exact receiving parent. The downstream observer
 * additionally checks the durable (parent, child) dispatch record and claims
 * the terminal event idempotently before touching settlement or gates.
 * Model text, ordinary synthetic messages and wrong-parent notices do not
 * produce a terminal result. Do not use session.execution.succeeded itself as
 * completion evidence: it has no final agent result/verdict text.
 */
export function mapV2NativeSubagentCompletion(
	envelope: V2EventEnvelope,
	getVerifiedParent: (
		child: string,
	) => string | undefined = verifiedNativeChildParent,
): MappedEvent | undefined {
	const type = envelope?.type;
	if (type !== 'session.inbox.enqueued' && type !== 'session.synthetic')
		return undefined;
	// A throwing metadata/text accessor must not terminate the detached
	// event pump; fail closed for this notification and continue the stream.
	try {
		const data = envelopePayload(envelope);
		const parent = data.sessionID;
		if (typeof parent !== 'string' || !isBoundedId(parent)) return undefined;

		let message: Record<string, unknown>;
		if (type === 'session.inbox.enqueued') {
			const item = data.item;
			if (
				!isPlainObject(item) ||
				item.type !== 'synthetic' ||
				!isPlainObject(item.payload)
			)
				return undefined;
			message = item.payload;
		} else {
			message = data;
		}
		const metadata = message.metadata;
		if (!isPlainObject(metadata) || metadata.source !== 'subagent')
			return undefined;
		const child = metadata.childID;
		const state = metadata.state;
		const text = message.text;
		if (typeof child !== 'string' || !/^ses_[A-Za-z0-9_-]{1,252}$/.test(child))
			return undefined;
		if (state !== 'completed' && state !== 'error' && state !== 'cancelled')
			return undefined;
		if (typeof text !== 'string' || text.length > 131_072) return undefined;
		if (getVerifiedParent(child) !== parent) return undefined;

		// The host's notification has ordered sessionID/state attributes and an
		// optional description; its body is result text, not status evidence.
		const wrapper =
			/^<subagent sessionID="(ses_[A-Za-z0-9_-]{1,252})" state="(completed|error|cancelled)"(?: [a-zA-Z][\w-]*="[^"<>\r\n]*")*>\r?\n?([\s\S]*?)\r?\n?<\/subagent>\s*$/.exec(
				text,
			);
		if (!wrapper || wrapper[1] !== child || wrapper[2] !== state)
			return undefined;

		// Reuse the EXACT legacy renderer, including truncation and escaping of
		// structural task_result/task_error/summary tokens from model output.
		const normalized = renderV1TaskEnvelopeFromV2({
			sessionID: child,
			state,
			inner: wrapper[3],
		});
		return {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parent,
					text: normalized,
				},
			},
		};
	} catch {
		return undefined;
	}
}

/** Map a v2 event envelope onto the v1 handler input (or undefined). */
export function mapV2EventToV1(
	envelope: V2EventEnvelope,
	lookupToolName?: (sessionID: string, callID: string) => string | undefined,
	isTrackedNativeChild: (
		sessionID: string,
	) => boolean = isTrackedNativeChildSession,
): MappedEvent | undefined {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type === undefined) return undefined;
	// #3022: live plugin-stream envelopes carry the payload under `data`; the
	// SDK SSE/REST dialect carries it under `properties`. Accept both.
	const data = envelopePayload(envelope);
	const sessionID =
		typeof data.sessionID === 'string' ? data.sessionID : undefined;
	switch (type) {
		case 'session.inbox.enqueued':
		case 'session.synthetic':
			return mapV2NativeSubagentCompletion(envelope);
		case 'session.execution.succeeded':
			if (!sessionID || !isTrackedNativeChild(sessionID)) return undefined;
			// OpenCode 2.3.x emits this durable terminal event, but not always
			// session.idle. Do not treat a tool-launch success as child completion;
			// only the CHILD execution-succeeded event may terminalize the child.
			return sessionID && isBoundedId(sessionID)
				? { type: 'session.idle', properties: { sessionID } }
				: undefined;
		case 'session.execution.interrupted':
			if (!sessionID || !isTrackedNativeChild(sessionID)) return undefined;
			// OpenCode keeps an execution claim on `shutdown`, to be resumed
			// after restart. `superseded` means a replacement turn is running.
			// Neither is a terminal child result: revocation here would strand
			// an authorized task and reintroduce SCOPE_BINDING_EXPIRED.
			if (data.reason === 'superseded' || data.reason === 'shutdown')
				return undefined;
			return sessionID &&
				isBoundedId(sessionID) &&
				(data.reason === 'user' || data.reason === 'inactivity')
				? {
						type: 'session.status',
						properties: {
							sessionID,
							status: { type: 'idle' },
							interrupted: true,
							reason: data.reason,
						},
					}
				: undefined;
		case 'session.step.ended':
		case 'session.step.failed': {
			// Durable per-step usage. Never translate session.usage.updated (an
			// ephemeral SESSION total) or session.usage.recorded (an internal
			// accounting record), since either could double-count these steps.
			// Reject partial failed steps lacking both cost and tokens.
			try {
				if (!sessionID || !isBoundedId(sessionID)) return undefined;
				const stepID = envelope.id;
				const assistantMessageID = data.assistantMessageID;
				const tokens = data.tokens;
				const good = (v: unknown): v is number =>
					typeof v === 'number' && Number.isFinite(v) && v >= 0;
				if (
					typeof stepID !== 'string' ||
					!isBoundedId(stepID) ||
					typeof assistantMessageID !== 'string' ||
					!isBoundedId(assistantMessageID) ||
					!isPlainObject(tokens) ||
					!isPlainObject(tokens.cache) ||
					!good(data.cost) ||
					!good(tokens.input) ||
					!good(tokens.output) ||
					!good(tokens.reasoning) ||
					!good(tokens.cache.read) ||
					!good(tokens.cache.write)
				)
					return undefined;
				return {
					type: 'message.part.updated',
					properties: {
						part: {
							type: 'step-finish',
							sessionID,
							assistantMessageID,
							swarmV2UsageStep: true,
							swarmV2EventId: stepID,
							cost: data.cost,
							tokens: {
								input: tokens.input,
								output: tokens.output,
								reasoning: tokens.reasoning,
								cache: { read: tokens.cache.read, write: tokens.cache.write },
							},
						},
					},
				};
			} catch {
				return undefined;
			}
		}
		case 'session.idle':
			return {
				type: 'session.idle',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.status.updated':
		case 'session.status':
			// #3022 plan-critic blocker 1: type-preserving. The v1 handler's
			// #scope-fix: status.updated is also a status transition, NOT an
			// idle event. Mapping busy/retry to session.idle prematurely runs
			// terminal session cleanup and revokes an active coder scope lease.
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
		case 'session.tool.input.delta':
			// Ephemeral fragments have no full part; forwarding them as v1
			// message.part.updated merely queues expensive no-op dispatches.
			// The durable text.ended and tool.called/success/failed boundaries
			// below provide the complete payloads a v1 consumer can use.
			return undefined;
		case 'session.text.ended': {
			try {
				const msg = data.assistantMessageID;
				const ordinal = data.ordinal;
				const text = data.text;
				if (
					!sessionID ||
					!isBoundedId(sessionID) ||
					typeof msg !== 'string' ||
					!isBoundedId(msg) ||
					typeof ordinal !== 'number' ||
					!Number.isSafeInteger(ordinal) ||
					ordinal < 0 ||
					typeof text !== 'string' ||
					text.length > 131_072
				)
					return undefined;
				return {
					type: 'message.part.updated',
					properties: {
						part: {
							type: 'text',
							sessionID,
							id: `${msg}:${ordinal}`,
							text,
							synthetic: false,
						},
					},
				};
			} catch {
				return undefined;
			}
		}
		case 'session.tool.called':
		case 'session.tool.success':
		case 'session.tool.failed': {
			// OpenCode 2.3's called/success/failed omit the tool name; it
			// originates at session.tool.input.started for the same session/call.
			// Missing/evicted names fail closed. Never use these TOOL events to
			// synthesize an agent completion or child scope activation.
			try {
				const callID = data.id;
				if (
					!sessionID ||
					!isBoundedId(sessionID) ||
					typeof callID !== 'string' ||
					!isBoundedId(callID) ||
					!lookupToolName
				)
					return undefined;
				const tool = lookupToolName(sessionID, callID);
				if (
					!tool ||
					tool.length > MAX_TRACKED_TOOL_NAME_CHARS ||
					isV2SubagentToolId(tool)
				)
					return undefined;
				const status =
					type === 'session.tool.called'
						? 'running'
						: type === 'session.tool.success'
							? 'completed'
							: 'error';
				return {
					type: 'message.part.updated',
					properties: {
						part: { type: 'tool', tool, callID, sessionID, state: { status } },
					},
				};
			} catch {
				return undefined;
			}
		}
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
				// 2026-11-26 (task 2.15): child-activity registry feed (metadata
				// only) — the stale sweep's observed-liveness signal.
				noteChildActivityFromEnvelope(envelope);
				// r17 §8: opt-in delegation critical-path tracer (metadata only:
				// sessionID + event type + tool NAME; never payload text).
				noteDelegationTraceEnvelope(envelope, lookupToolNameForDispatch);
				// #3169 Phase 2 (C4): v2 surfaces provider errors only via the
				// event stream (no error text in context()); record them for the
				// session-client shim's result translation. Sync, bounded, O(1).
				recordV2SessionErrorFromEnvelope(envelope);
				// #3401: remember tool names for dispatch-gated synthesis below.
				rememberToolNameFromEnvelope(envelope);
				const mapped = mapV2EventToV1(envelope, lookupToolNameForDispatch);
				// Host event timestamps: distinguish a slow child from a slow host
				// tool hook. No prompts, results, filenames, or child content logged.
				const hostType = envelope.type;
				if (
					typeof hostType === 'string' &&
					hostType.startsWith('session.execution.')
				) {
					const payload = envelopePayload(envelope);
					if (typeof payload.sessionID === 'string') {
						const kind =
							hostType === 'session.execution.succeeded'
								? 'execution_succeeded'
								: hostType === 'session.execution.interrupted'
									? 'execution_interrupted'
									: hostType === 'session.execution.failed'
										? 'execution_failed'
										: 'execution_ignored';
						recordV2SessionTiming(
							payload.sessionID,
							mapped ? kind : 'execution_ignored',
						);
					}
				}
				if (envelope.type === 'session.tool.progress' && mapped !== undefined) {
					rememberNativeChildFromProgress(mapped);
				}
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
