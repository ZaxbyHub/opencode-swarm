/**
 * v2 guidance delivery — the session `context` hook (issue #3004 / #2910, R1
 * in ADR-0003).
 *
 * Transport mapping (docs/host/v2-hook-inventory.md row 6/7):
 *
 *   - The v1 MESSAGES transform chain runs first against a translated view of
 *     `event.messages`. On v1 its guidance injections ride USER-role carrier
 *     messages (`swarm-guidance:*` ids, fenced text) because the v1 host drops
 *     role:'system' entries (#2526). The v2 host renders `event.system`
 *     natively, so those carriers are RE-HOMED here into `event.system` as
 *     text parts and removed from the message list — each guidance unit has
 *     exactly one destination.
 *   - The v1 SYSTEM transform chain then runs with a translated input and its
 *     (unfenced) strings are appended as further `event.system` text parts —
 *     exactly what the v1 system surface receives.
 *
 * `event.agent` is an Agent.Info-shaped object on v2; it is normalized to a
 * name before any v1 agent comparison (frozen C4 header requirement).
 *
 * View -> original pairing: every v1 view is stamped `info.swarmV2Origin` (its
 * index in the original `event.messages`). Kept views are paired by object
 * identity, then `id`, then that stamp (role-checked for non-carriers); there
 * is no positional fallback. Views the chain INSERTS carry no stamp and are
 * dropped — on v2, id-less chain inserts (full-auto verdict/continuation
 * messages) are therefore not delivered.
 *
 * Part-kind mapping (R10): text parts map 1:1; non-text content kinds
 * (media, tool-call, tool-result, reasoning, step-start, compaction, effort)
 * are preserved untouched on their message — the v1 chain's steps only read
 * and write `type === 'text'` parts.
 */

import { GUIDANCE_CARRIER_ID_PREFIX } from '../../hooks/system-guidance-carrier';
import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import { normalizeV2AgentRef, seedV1SessionState } from './setup';
import type {
	V1HooksSubset,
	V2Message,
	V2PluginContext,
	V2Registration,
	V2SessionContextEvent,
} from './types';

/** Guidance-chain budget: these are in-memory transforms over a session view. */
const V2_GUIDANCE_CHAIN_TIMEOUT_MS = 30_000;

interface V1PartsMessageView {
	info: {
		id?: string;
		role?: string;
		sessionID?: string;
		/**
		 * Index of the source message in the ORIGINAL `event.messages` array. A
		 * plain enumerable string key so it survives `structuredClone` and
		 * `{...info}` spreads (the guardrails rollback clones views; stages such
		 * as convertSystemEntryInPlace rebuild `info`). Views a chain INSERTS
		 * never carry it.
		 */
		swarmV2Origin?: number;
	};
	parts: Array<{ type: string; text?: string }>;
}

/** `V2Message.content` is typed as an array; tolerate (never split) anything else. */
function contentParts(message: V2Message): V2Message['content'] {
	return Array.isArray(message.content) ? message.content : [];
}

/** Translate v2 messages into the v1 parts view the chain expects. */
function toV1MessageView(
	message: V2Message,
	sessionID: string,
	originIndex: number,
	agentName?: string,
): V1PartsMessageView {
	const textParts: Array<{ type: string; text?: string }> = [];
	for (const part of contentParts(message)) {
		if (
			part &&
			typeof part === 'object' &&
			part.type === 'text' &&
			typeof part.text === 'string'
		) {
			textParts.push({ type: 'text', text: part.text });
		}
	}
	return {
		info: {
			id: typeof message.id === 'string' ? message.id : undefined,
			role: message.role,
			sessionID,
			swarmV2Origin: originIndex,
			// #3320: stamp the session's agent on USER views so the v1 message
			// stages (which key on info.agent) can tell a plan/build turn from
			// the architect main session. Absent when the event carries no agent
			// — the main session keeps identity-absent semantics.
			// #3320 review round (PRR-011): USER views only. The v1 SDK shape
			// carries `agent` on UserMessage and NOT on AssistantMessage; stamping
			// assistant views fabricated that field and made the role-unfiltered
			// consumers (delegation-sanitizer, knowledge-application-gate,
			// skill-propagation-gate) match the session agent's own ASSISTANT
			// output — rewriting gate agents' verdict text and letting an
			// architect's reply satisfy ack/verdict scans.
			...(message.role === 'user' && agentName !== undefined
				? { agent: agentName }
				: {}),
		},
		parts: textParts,
	};
}

/**
 * Write the (non-carrier) transformed text parts back onto a v2 message.
 *
 * Text parts are replaced IN POSITION: the v1 chain only sees text, so every
 * non-text part (tool-call, tool-result, media, reasoning) keeps its slot
 * relative to the text around it — an assistant's preamble stays before its
 * tool call. Extra texts follow the last original text part (or lead the
 * message when it had none); missing texts drop the trailing text slots.
 */
function writeBackTextParts(
	message: V2Message,
	parts: Array<{ type: string; text?: string }>,
): void {
	// Out-of-contract (non-array) content is left untouched, never split.
	if (!Array.isArray(message.content)) return;
	const texts = parts
		.filter((p) => p.type === 'text' && typeof p.text === 'string')
		.map((p) => ({ type: 'text' as const, text: p.text as string }));
	const content: V2Message['content'] = [];
	let nextText = 0;
	let afterLastText = 0;
	for (const part of message.content) {
		if (part && typeof part === 'object' && part.type === 'text') {
			if (nextText < texts.length) content.push(texts[nextText++]);
			afterLastText = content.length;
		} else {
			content.push(part);
		}
	}
	content.splice(afterLastText, 0, ...texts.slice(nextText));
	message.content = content;
}

/** True when a message carries anything the v1 text-only view cannot see. */
function hasNonTextParts(message: V2Message): boolean {
	if (message.content === undefined) return false;
	// Opaque (non-array) content is kept, not dropped.
	if (!Array.isArray(message.content)) return true;
	return message.content.some(
		(part) => !(part && typeof part === 'object' && part.type === 'text'),
	);
}

/** Map the v2 model ref onto the v1 {providerID, modelID} shape. */
function toV1ModelInput(
	model: V2SessionContextEvent['model'],
): Record<string, unknown> {
	if (model && typeof model === 'object') {
		return {
			providerID:
				typeof model.providerID === 'string' ? model.providerID : 'unknown',
			modelID: typeof model.id === 'string' ? model.id : 'unknown',
		};
	}
	return { providerID: 'unknown', modelID: 'unknown' };
}

/** The v2 context hook body. */
export async function onV2ContextEvent(
	event: V2SessionContextEvent,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const sessionID = event.sessionID;
	seedV1SessionState(sessionID, event.agent, directory);
	const eventAgentName = normalizeV2AgentRef(event.agent);

	const messagesTransform = hooks['experimental.chat.messages.transform'];
	if (typeof messagesTransform === 'function') {
		const originalMessages = [...(event.messages ?? [])];
		const views = originalMessages.map((m, i) =>
			toV1MessageView(m, sessionID, i, eventAgentName),
		);
		// The v2 host's context messages carry no `id`, and the v1 chain changes
		// the view count (carrier materialization, verdict inserts). Every view is
		// stamped with its original index (`info.swarmV2Origin`); pairing below is
		// object identity (stages convert views in place) -> `id` -> that stamp.
		const originalByView = new Map<V1PartsMessageView, V2Message>();
		for (let i = 0; i < views.length; i += 1) {
			originalByView.set(views[i], originalMessages[i]);
		}
		await withTimeout(
			messagesTransform({}, { messages: views as unknown as unknown[] }),
			V2_GUIDANCE_CHAIN_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: messages transform exceeded budget'),
		).catch((err: unknown) => {
			log(
				'v2 messages transform failed (non-fatal; original messages retained)',
				{
					error: err instanceof Error ? err.message : String(err),
				},
			);
			// Restore the pre-transform views so a partial failure cannot corrupt content.
			views.length = 0;
			originalByView.clear();
			originalMessages.forEach((message, i) => {
				const view = toV1MessageView(message, sessionID, i, eventAgentName);
				views.push(view);
				originalByView.set(view, message);
			});
		});

		// Pair each kept view with its original, in TWO passes so an exact match
		// (object identity, then `id`) always outranks the weaker origin stamp:
		//   pass 1: identity, then `id`;
		//   pass 2: for still-unresolved views, `info.swarmV2Origin` (an integer in
		//           range; non-carrier views must also match the original's role).
		// First claim wins: an original already claimed by an earlier resolution is
		// never reassigned and a later duplicate view is dropped. There is NO
		// positional pairing. Views with no resolution — chain inserts, which carry
		// no stamp — are dropped, so on v2 id-less chain inserts (full-auto verdict
		// and continuation messages) are NOT delivered to the model.
		const originalById = new Map<string, V2Message>();
		for (const message of originalMessages) {
			if (typeof message.id === 'string' && message.id.length > 0) {
				originalById.set(message.id, message);
			}
		}
		const isCarrier = (view: V1PartsMessageView): boolean =>
			typeof view.info.id === 'string' &&
			view.info.id.startsWith(GUIDANCE_CARRIER_ID_PREFIX);
		const resolved = new Map<V1PartsMessageView, V2Message>();
		const taken = new Set<V2Message>();
		const resolve = (view: V1PartsMessageView, message: V2Message): void => {
			if (taken.has(message)) return;
			taken.add(message);
			resolved.set(view, message);
		};
		const unresolved: V1PartsMessageView[] = [];
		for (const view of views) {
			const id = view.info.id;
			const exact =
				originalByView.get(view) ??
				(typeof id === 'string' && id.length > 0
					? originalById.get(id)
					: undefined);
			if (exact) resolve(view, exact);
			else unresolved.push(view);
		}
		for (const view of unresolved) {
			const origin: unknown = view.info.swarmV2Origin;
			if (
				typeof origin !== 'number' ||
				!Number.isInteger(origin) ||
				origin < 0 ||
				origin >= originalMessages.length
			) {
				continue;
			}
			const original = originalMessages[origin];
			if (!isCarrier(view) && view.info.role !== original.role) continue;
			resolve(view, original);
		}

		const consumed = new Set<V2Message>();
		const claimed = new Map<
			V2Message,
			Array<{ type: string; text?: string }>
		>();
		event.system = event.system ?? [];
		for (const view of views) {
			const source = resolved.get(view);
			if (isCarrier(view)) {
				// Re-homed carrier (R1): fenced text becomes a system part.
				for (const part of view.parts) {
					if (
						part.type === 'text' &&
						typeof part.text === 'string' &&
						part.text.length > 0
					) {
						event.system.push({ type: 'text', text: part.text });
					}
				}
				if (source) consumed.add(source);
			} else if (source) {
				claimed.set(source, view.parts);
			}
		}

		// Rebuild in the HOST's order. A message whose view the chain dropped is
		// removed when it is text-only or was consumed as a carrier source (its
		// text now lives in event.system — one destination per guidance unit).
		// Otherwise it is kept: tool calls/results and media are invisible to the
		// v1 chain and removing them orphans tool pairs.
		const kept: V2Message[] = [];
		for (const message of originalMessages) {
			const parts = claimed.get(message);
			if (parts) {
				writeBackTextParts(message, parts);
				kept.push(message);
			} else if (!consumed.has(message) && hasNonTextParts(message)) {
				kept.push(message);
			}
		}
		// In-place contract: the host reads its own arrays after the hook.
		event.messages.length = 0;
		for (const message of kept) event.messages.push(message);
	}

	const systemTransform = hooks['experimental.chat.system.transform'];
	if (typeof systemTransform === 'function') {
		const output = { system: [] as string[] };
		await withTimeout(
			systemTransform(
				{ sessionID, model: toV1ModelInput(event.model) },
				output,
			),
			V2_GUIDANCE_CHAIN_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: system transform exceeded budget'),
		).catch((err: unknown) => {
			log('v2 system transform failed (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		});
		for (const text of output.system) {
			if (typeof text === 'string' && text.length > 0) {
				event.system.push({ type: 'text', text });
			}
		}
	}
}

/** Register the context hook on the v2 session domain. */
export async function registerV2ContextHook(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	const registration = await withTimeout(
		ctx.session.hook('context', (async (event: unknown) => {
			return onV2ContextEvent(event as V2SessionContextEvent, hooks, directory);
		}) as never),
		V2_GUIDANCE_CHAIN_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: context hook registration exceeded budget'),
	);
	registrations.push(registration);
}
