/**
 * v2 guidance delivery — the session `context` hook (issue #3151, 8.x port
 * of the 7.x #3004 / #2910 adapter).
 *
 * Transport mapping:
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
 * name before any v1 agent comparison.
 *
 * Part-kind mapping: text parts map 1:1; non-text content kinds (media,
 * tool-call, tool-result, reasoning, step-start, compaction, effort) are
 * preserved untouched on their message — the v1 chain's steps only read and
 * write `type === 'text'` parts. This is the ordering-regression contract
 * pinned by tests/host/v2/ordering-regression.test.ts: no part dropped, no
 * reorder, injected text only appended at a message's tail.
 */

import { log } from '@opencode-swarm/core';
import { seedV1SessionState } from './setup';
import { withTimeout } from './timeout';
import type {
	V1HooksSubset,
	V2Message,
	V2PluginContext,
	V2Registration,
	V2SessionContextEvent,
} from './types';

// inlined from 7.x src/hooks/system-guidance-carrier.ts:48 (8.x has no carrier
// module; the prefix partition fails open when no carriers exist)
const GUIDANCE_CARRIER_ID_PREFIX = 'swarm-guidance:';

/** Guidance-chain budget: these are in-memory transforms over a session view. */
const V2_GUIDANCE_CHAIN_TIMEOUT_MS = 30_000;

interface V1PartsMessageView {
	info: { id?: string; role?: string; sessionID?: string; agent?: string };
	parts: Array<{ type: string; text?: string }>;
}

/** Translate v2 messages into the v1 parts view the chain expects. */
function toV1MessageView(
	message: V2Message,
	sessionID: string,
): V1PartsMessageView {
	const textParts: Array<{ type: string; text?: string }> = [];
	for (const part of message.content ?? []) {
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
			// FB-004: the v2 SDK UserMessage carries the producing agent's id;
			// surface it on the view so the v1 chain's agent-gated consumers
			// (context-budget agent-switch detection, pipeline-tracker
			// architect gating) see the same identity the v1 host provided.
			agent: typeof message.agent === 'string' ? message.agent : undefined,
		},
		parts: textParts,
	};
}

/** Write the (non-carrier) transformed text parts back onto a v2 message. */
function writeBackTextParts(
	message: V2Message,
	parts: Array<{ type: string; text?: string }>,
): void {
	const kept = (message.content ?? []).filter(
		(part) => !(part && typeof part === 'object' && part.type === 'text'),
	);
	const texts = parts
		.filter((p) => p.type === 'text' && typeof p.text === 'string')
		.map((p) => ({ type: 'text' as const, text: p.text as string }));
	message.content = [...kept, ...texts];
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

	const messagesTransform = hooks['experimental.chat.messages.transform'];
	if (typeof messagesTransform === 'function') {
		const views = (event.messages ?? []).map((m) =>
			toV1MessageView(m, sessionID),
		);
		const originalMessages = [...(event.messages ?? [])];
		await withTimeout(
			messagesTransform({}, { messages: views as unknown as unknown[] }),
			V2_GUIDANCE_CHAIN_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: messages transform exceeded budget'),
		).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			// Ungated (FB-014/M-16): silent guidance loss must be visible
			// without OPENCODE_SWARM_DEBUG. One line, no stack.
			console.warn(
				'[opencode-swarm] v2 messages transform failed (non-fatal):',
				message,
			);
			log(
				'v2 messages transform failed (non-fatal; original messages retained)',
				{ error: message },
			);
			// Restore the pre-transform views so a partial failure cannot corrupt content.
			for (let i = 0; i < originalMessages.length; i += 1) {
				views[i] = toV1MessageView(originalMessages[i], sessionID);
			}
		});

		// Partition carriers vs kept messages, then re-home the carriers.
		// Pair views with their original v2 messages by IDENTITY, not position:
		// the v1 chain can insert carriers (unshift/splice) or rebuild the
		// array, so positional pairing would write one message's transformed
		// text back onto a different message.
		const originalById = new Map<string, V2Message>();
		const originalsWithoutId: V2Message[] = [];
		for (const message of originalMessages) {
			const id = typeof message.id === 'string' ? message.id : undefined;
			if (id !== undefined && id.length > 0) originalById.set(id, message);
			else originalsWithoutId.push(message);
		}
		const usedIds = new Set<string>();
		let nextIdless = 0;
		const keptParts: Array<{
			message: V2Message;
			parts: Array<{ type: string; text?: string }>;
		}> = [];
		event.system = event.system ?? [];
		for (const view of views) {
			const id = view.info.id;
			if (typeof id === 'string' && id.startsWith(GUIDANCE_CARRIER_ID_PREFIX)) {
				// Re-homed carrier: fenced text becomes a system part.
				for (const part of view.parts) {
					if (
						part.type === 'text' &&
						typeof part.text === 'string' &&
						part.text.length > 0
					) {
						event.system.push({ type: 'text', text: part.text });
					}
				}
				continue;
			}
			let message: V2Message | undefined;
			if (
				typeof id === 'string' &&
				id.length > 0 &&
				originalById.has(id) &&
				!usedIds.has(id)
			) {
				message = originalById.get(id);
				usedIds.add(id);
			} else if (
				(id === undefined || id.length === 0) &&
				nextIdless < originalsWithoutId.length
			) {
				// Id-less views pair positionally with id-less originals only.
				message = originalsWithoutId[nextIdless];
				nextIdless += 1;
			}
			if (message) {
				keptParts.push({ message, parts: view.parts });
			}
			// Views with no identity match are dropped from the pairing (their
			// write-back is skipped) rather than written onto a wrong message.
		}
		// Write the (non-carrier) transformed text parts back onto their
		// identity-paired v2 messages, then reassign the array in place.
		for (const { message, parts } of keptParts) {
			writeBackTextParts(message, parts);
		}
		// In-place contract: the host reads its own arrays after the hook.
		event.messages.length = 0;
		event.messages.push(...keptParts.map((k) => k.message));
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
			const message = err instanceof Error ? err.message : String(err);
			// Ungated (FB-014/M-16): system-prompt surface loss must be visible
			// without OPENCODE_SWARM_DEBUG. One line, no stack.
			console.warn(
				'[opencode-swarm] v2 system transform failed (non-fatal):',
				message,
			);
			log('v2 system transform failed (non-fatal)', { error: message });
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
	const registration: Promise<V2Registration> = ctx.session.hook(
		'context',
		(async (event: unknown) => {
			return onV2ContextEvent(event as V2SessionContextEvent, hooks, directory);
		}) as never,
	);
	// Track the registration the moment it resolves (M-7): if the timeout
	// below wins the race, a late-resolving registration must still reach the
	// cleanup list instead of leaking. Rejection pushes nothing.
	registration
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		registration,
		V2_GUIDANCE_CHAIN_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: context hook registration exceeded budget'),
	);
}
