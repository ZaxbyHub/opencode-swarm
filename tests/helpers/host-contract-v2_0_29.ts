/**
 * Pinned v2 host-contract fixture (issue #2910, residual scope item 2).
 *
 * This is a PROVENANCE-HEADED distillation of the OpenCode 2 host's
 * post-context-hook event → model-request conversion, the v2 dual of
 * `tests/helpers/host-contract-v1_18_3.ts`:
 *
 *   repo:   sst/opencode
 *   tag:    v2.0.29
 *   files (fetched 2026-10-24):
 *     - https://raw.githubusercontent.com/sst/opencode/v2.0.29/packages/core/src/session/model-request.ts
 *     - https://raw.githubusercontent.com/sst/opencode/v2.0.29/packages/core/src/session/context.ts
 *
 * Distilled structure (verbatim claims from the v2.0.29 source):
 *
 *   1. `SessionModelRequest.prepare(kind, input, shape)` builds the plugin
 *      event as the DRAFT ITSELF:
 *        `{ sessionID, model, system: input.system, messages: input.messages,
 *           options, tools }`
 *      and runs the plugin `session.context` hook against it
 *      (`agentHook("context", agent)` → `hooks.trigger("session", "context",
 *      {...draft, agent, tools})`). The hook output `shaped` is the mutated
 *      event — the host reads its own object after the hook (the same
 *      mutate-IN-PLACE contract class as the v1 `output` rule, AGENTS.md
 *      invariant 10).
 *   2. The final provider request carries `shaped.system` VERBATIM:
 *        `LLM.request({ ..., system: shaped.system,
 *                       messages: boundImages(unsupportedParts(shaped.messages,
 *                                              model.capabilities, provider)) })`
 *      — every `SystemPart` the hook left on `event.system` reaches the
 *      provider request's system prompt in array order.
 *   3. `unsupportedParts`/`boundImages` rewrite ONLY media and tool-result
 *      file parts (replacing unsupported/oversized media with bounded error
 *      text); TEXT parts pass through unchanged, and no message is dropped
 *      for its text content. The distilled renderer therefore models text
 *      pass-through and treats media rewriting as out of scope (the seeds
 *      under test carry no media).
 *   4. `SessionContext.select` (context.ts) resolves the pre-hook system as
 *      `SystemPart` text parts (`baseTranscript`: `[agent.system ?? …,
 *      initial].filter(…).map(SystemPart.make)`) — so the pre-hook
 *      `event.system` is a non-empty array of `{type:'text', text}` parts,
 *      exactly the surface `src/host/v2/guidance.ts` appends to.
 *
 * The published `@opencode/plugin`/`@opencode/schema` packages do NOT ship
 * this conversion code — it lives only in the host repo — which is why this
 * fixture distills it instead of importing it. Drift guard: the #2910 CI leg
 * (`scripts/check-host-contract-v2.ts`, weekly `host-contract-check.yml`)
 * compares this digest against the host source at the tracked v2 tag /
 * npm-latest; `src/host/v2/types.ts` pins the vendored schema provenance.
 */

export const PINNED_V2_HOST_VERSION = '2.0.29';

/** Post-context-hook event system part (the surface guidance re-homes into). */
export interface V2EventSystemPart {
	type: 'text';
	text: string;
	[key: string]: unknown;
}

/** Post-context-hook event message (abbreviated to the text-relevant surface). */
export interface V2EventMessage {
	id?: string;
	role: string;
	content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
}

/** A post-context-hook session event, as the host reads it after the hook. */
export interface V2PostContextEvent {
	sessionID?: string;
	system: V2EventSystemPart[];
	messages: V2EventMessage[];
	[key: string]: unknown;
}

/** Distilled provider-request view: what `LLM.request` receives. */
export interface V2RenderedModelRequest {
	/** Every system text part's text, in event.system array order (verbatim). */
	system: string[];
	/** Every message with its role and its text parts' text joined in order. */
	messages: Array<{ id?: string; role: string; text: string }>;
}

/**
 * Distill the host's event → model-request conversion for the text-relevant
 * surface (see the header's four verbatim claims). Text passes through
 * verbatim on both surfaces; nothing is dropped, reordered, or rewritten
 * except what the plugin hook itself did to the event.
 */
export function hostV2ToModelRequest(
	event: V2PostContextEvent,
): V2RenderedModelRequest {
	// Verbatim claim 2: `system: shaped.system` — array order preserved, one
	// entry per part. Empty-text parts are kept by the host too (SystemPart is
	// opaque to the request builder), but the renderer keeps them out of the
	// joined-text helpers' way by preserving them here as-is.
	const system = (event.system ?? [])
		.filter(
			(part) => part && part.type === 'text' && typeof part.text === 'string',
		)
		.map((part) => part.text);

	// Verbatim claim 3: text parts pass through; media-only rewriting is out
	// of scope (no message is dropped for text content; roles are preserved).
	const messages = (event.messages ?? []).map((message) => {
		const text = (message.content ?? [])
			.filter(
				(part) =>
					part &&
					typeof part === 'object' &&
					part.type === 'text' &&
					typeof part.text === 'string',
			)
			.map((part) => part.text as string)
			.join('\n');
		return {
			id: typeof message.id === 'string' ? message.id : undefined,
			role: message.role,
			text,
		};
	});

	return { system, messages };
}

/** Joined rendered text of the full request (system parts + message texts). */
export function renderedV2RequestText(request: V2RenderedModelRequest): string {
	return [...request.system, ...request.messages.map((m) => m.text)].join('\n');
}

/** Joined rendered SYSTEM-surface text only (the v2 carrier destination). */
export function renderedV2SystemText(request: V2RenderedModelRequest): string {
	return request.system.join('\n');
}
