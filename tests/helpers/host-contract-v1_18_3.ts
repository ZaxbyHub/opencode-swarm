/**
 * Pinned host-contract fixture (issue #2526).
 *
 * This is a PROVENANCE-HEADED distillation of the OpenCode host's
 * message→model-request conversion loop:
 *
 *   repo:   anomalyco/opencode
 *   tag:    v1.18.3
 *   commit: 127bdb30784d508cc556c71a0f32b508a3061517
 *   file:   packages/opencode/src/session/message-v2.ts
 *   lines:  195-244 (`toModelMessagesEffect` loop head + user branch)
 *
 * The host packages (`@opencode-ai/plugin`, `@opencode-ai/sdk`) are version-
 * locked to the host (the audit resolved the host ref through them), but they
 * do NOT ship the conversion code — it lives only in the host repo. This
 * fixture reproduces the loop's verbatim STRUCTURE:
 *
 *   - `if (msg.parts.length === 0) continue` — parts dereferenced
 *     UNCONDITIONALLY (a flat entry without `parts` throws TypeError);
 *   - the user branch copies `msg.info.id`, keeps text parts only when
 *     `type === 'text' && !part.ignored && part.text !== ''`, and pushes the
 *     message only when at least one part survived;
 *   - the assistant branch exists (abbreviated here — irrelevant to the
 *     role-set contract under test);
 *   - NO else/default: any role other than `user`/`assistant` falls through
 *     both branches and is never pushed.
 *
 * `tests/unit/hooks/host-message-role-contract-2526.test.ts` pins the
 * installed package versions to `PINNED_HOST_PACKAGE_VERSION` so a lockfile
 * bump fails loudly and forces re-verification of this fixture against the
 * new host source.
 */

export const PINNED_HOST_PACKAGE_VERSION = '1.18.3';

export interface HostPartsMessage {
	info: { id?: string; role: string; [key: string]: unknown };
	parts: Array<{
		type: string;
		text?: string;
		ignored?: boolean;
		[key: string]: unknown;
	}>;
}

export interface RenderedModelMessage {
	id: unknown;
	role: 'user' | 'assistant';
	parts: Array<{ type: string; text?: string }>;
}

/**
 * Distilled `toModelMessagesEffect` role branching. Throws on flat entries
 * exactly like the host (the `msg.parts.length` dereference).
 */
export function hostToModelMessages(
	input: Array<HostPartsMessage | Record<string, unknown>>,
): RenderedModelMessage[] {
	const result: RenderedModelMessage[] = [];
	for (const raw of input) {
		// Verbatim: unconditional parts dereference at the loop head.
		const msg = raw as HostPartsMessage;
		if (msg.parts.length === 0) continue;

		if (msg.info.role === 'user') {
			const userMessage: RenderedModelMessage = {
				id: msg.info.id,
				role: 'user',
				parts: [],
			};
			for (const part of msg.parts) {
				if (part.type === 'text' && !part.ignored && part.text !== '') {
					userMessage.parts.push({ type: 'text', text: part.text });
				}
			}
			if (userMessage.parts.length > 0) result.push(userMessage);
		}

		if (msg.info.role === 'assistant') {
			// The assistant branch exists in the host; its internal filtering is
			// not part of the role-set contract under test. It renders.
			result.push({
				id: msg.info.id,
				role: 'assistant',
				parts: msg.parts
					.filter((p) => p.type === 'text' && p.text !== '')
					.map((p) => ({ type: 'text', text: p.text })),
			});
		}
		// Verbatim: no else — any other role (system) is silently dropped.
	}
	return result;
}

/** Joined rendered text of a hostToModelMessages result. */
export function renderedText(rendered: RenderedModelMessage[]): string {
	return rendered.flatMap((m) => m.parts.map((p) => p.text ?? '')).join('\n');
}
