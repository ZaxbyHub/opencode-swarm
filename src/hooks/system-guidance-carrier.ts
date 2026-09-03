/**
 * System-guidance carrier (issue #2526).
 *
 * The OpenCode host's `toModelMessagesEffect` (pinned @opencode-ai 1.18.3 —
 * anomalyco/opencode@v1.18.3, packages/opencode/src/session/message-v2.ts:195-244,
 * commit 127bdb30784d508cc556c71a0f32b508a3061517) branches ONLY on `user` and
 * `assistant` with no `else`, and dereferences `msg.parts` unconditionally.
 * Synthetic `role:'system'` entries spliced into `experimental.chat.messages.transform`
 * were therefore silently discarded (and flat entries without `parts` crashed the
 * host prompt build with a TypeError) while delivery telemetry recorded them as
 * delivered.
 *
 * This module is the single source of truth for the fix: model-only guidance rides
 * a USER-role message — which the host renders unconditionally — carrying an explicit
 * provenance fence so the model can tell injected directives apart from real user
 * speech. Detection is by `info.id` prefix, never by text sniffing.
 *
 * Host-render contract for a carrier (message-v2.ts user branch, :198-242):
 *   - `info.role === 'user'` and `info.id` a string (copied verbatim; treated as opaque)
 *   - ≥1 part `{type:'text', text !== ''}` (empty-string text parts are dropped; a
 *     message whose every part is dropped is not pushed)
 *   - `parts.length === 0` entries are skipped before the role branch — an EMPTY
 *     carrier (zero parts) is therefore truly inert and never renders.
 *
 * Carriers live only inside a single request's transform array: the host rebuilds
 * that array from persisted (user/assistant-only) messages each turn, so carriers
 * never persist, accumulate, or pollute the stored conversation.
 */

/**
 * Structural message shape the carrier helpers operate on. Every consumer's
 * local message type (knowledge `MessageWithParts`, the guardrails transform's
 * local shape, memory's cast arrays) is assignable to this; arrays are passed
 * BY REFERENCE and mutated in place (issue #1619 discipline).
 */
export interface GuidanceMessage {
	info: {
		role?: string;
		/** String when plugin-built; every read goes through a typeof check. */
		id?: unknown;
	};
	parts: Array<{ type: string; text?: string }>;
}

/** Identity prefix for guidance carriers. Detection = role user + this id prefix. */
export const GUIDANCE_CARRIER_ID_PREFIX = 'swarm-guidance:';

const FENCE_SOURCE = 'opencode-swarm';

function fenceOpen(kind: string): string {
	return `<swarm_system_directive source="${FENCE_SOURCE}" kind="${kind}">`;
}

const FENCE_CLOSE = '</swarm_system_directive>';

export function guidanceCarrierId(kind: string): string {
	return `${GUIDANCE_CARRIER_ID_PREFIX}${kind}`;
}

/**
 * Wrap guidance text in the provenance fence (null for empty/whitespace text).
 * Shared by every carrier-construction path so the fence format cannot drift.
 */
export function fenceGuidanceText(kind: string, text: string): string | null {
	if (!nonEmptyText(text)) return null;
	return `${fenceOpen(kind)}\n${text}\n${FENCE_CLOSE}`;
}

/**
 * True for a guidance carrier entry (role user + id prefix — no text
 * sniffing). Accepts `unknown` so every consumer's local message type can be
 * tested without casts.
 */
export function isGuidanceCarrier(message: unknown): boolean {
	const info = (message as { info?: unknown } | null | undefined)?.info as
		| { role?: unknown; id?: unknown }
		| null
		| undefined;
	return (
		typeof info === 'object' &&
		info !== null &&
		info.role === 'user' &&
		typeof info.id === 'string' &&
		info.id.startsWith(GUIDANCE_CARRIER_ID_PREFIX)
	);
}

/** All guidance carriers in the array, in order. */
export function findGuidanceCarriers(
	messages: GuidanceMessage[],
): GuidanceMessage[] {
	return messages.filter((m) => isGuidanceCarrier(m));
}

/**
 * Joined text of a message's text parts (empty string when none). Used by
 * dedupe predicates that must not re-inject a block already present in the
 * carrier body.
 */
export function messageTextOf(
	message: GuidanceMessage | undefined | null,
): string {
	if (!message) return '';
	return (message.parts ?? [])
		.map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
		.join('\n');
}

function nonEmptyText(text: string | undefined | null): boolean {
	return typeof text === 'string' && text.trim().length > 0;
}

/**
 * Build a filled carrier. Returns null for empty/whitespace text — there is
 * nothing to deliver, and an empty carrier must not be created by value sites
 * (find-or-create sites use {@link ensureGuidanceCarrier} instead).
 *
 * `extraInfo` (e.g. agent/sessionID) is merged into info alongside id/role.
 */
export function buildGuidanceCarrier(
	kind: string,
	text: string,
	extraInfo?: Record<string, unknown>,
): GuidanceMessage | null {
	const fenced = fenceGuidanceText(kind, text);
	if (fenced === null) return null;
	return {
		info: { id: guidanceCarrierId(kind), role: 'user', ...extraInfo },
		parts: [{ type: 'text', text: fenced }],
	};
}

/**
 * Find the first guidance carrier, or `unshift` a new EMPTY one (zero parts —
 * inert under the host's `parts.length === 0` continue; it renders nothing until
 * a producer fills it, and it is never fence-only, because a fence-only text part
 * WOULD render).
 */
export function ensureGuidanceCarrier(
	messages: GuidanceMessage[],
	kind: string,
): GuidanceMessage {
	const existing = messages.find((m) => isGuidanceCarrier(m));
	if (existing) return existing;
	const carrier: GuidanceMessage = {
		info: { id: guidanceCarrierId(kind), role: 'user' },
		parts: [],
	};
	messages.unshift(carrier);
	return carrier;
}

/**
 * Prepend a block to the carrier's directive body (top-of-body, preserving the
 * historical `block + existing` order the system-message sites used). The first
 * fill creates the single text part with fence + body + close; later prepends
 * insert inside the existing fence. Never produces a second fence.
 *
 * Returns the delivered block, or null when the block is empty/whitespace
 * (nothing changed — the carrier stays exactly as it was).
 */
export function prependGuidanceText(
	carrier: GuidanceMessage,
	kind: string,
	block: string,
): string | null {
	if (!nonEmptyText(block)) return null;
	const textPart = carrier.parts.find((p) => p.type === 'text');
	if (textPart === undefined) {
		carrier.parts.push({
			type: 'text',
			text: `${fenceOpen(kind)}\n${block}\n${FENCE_CLOSE}`,
		});
		return block;
	}
	const current = typeof textPart.text === 'string' ? textPart.text : '';
	// Insert at the TOP of the directive body (right after the opening fence
	// tag) so the newest, most urgent block reads first — the same ordering the
	// pre-#2526 sites produced with `textPart.text = block + textPart.text`.
	// slice-based splicing, not String.replace: `$` sequences in the block must
	// never be interpreted as replacement patterns.
	const openMatch = current.match(/<swarm_system_directive[^>]*>\n?/);
	if (openMatch !== null && openMatch.index !== undefined) {
		const at = openMatch.index + openMatch[0].length;
		textPart.text = `${current.slice(0, at)}${block}\n${current.slice(at)}`;
	} else {
		// Defensive: a carrier text without an open fence (hand-built or legacy)
		// gets the block wrapped in a fresh fence.
		textPart.text = `${fenceOpen(kind)}\n${block}\n${current}\n${FENCE_CLOSE}`;
	}
	return block;
}

/**
 * Splice a filled carrier at `atIndex`. Returns the inserted entry, or null when
 * the text is empty/whitespace (nothing inserted).
 */
export function insertGuidanceCarrier(
	messages: GuidanceMessage[],
	kind: string,
	text: string,
	atIndex: number,
	extraInfo?: Record<string, unknown>,
): GuidanceMessage | null {
	const carrier = buildGuidanceCarrier(kind, text, extraInfo);
	if (carrier === null) return null;
	messages.splice(atIndex, 0, carrier);
	return carrier;
}

/** Push a filled carrier at the end. Returns the appended entry or null (empty text). */
export function appendGuidanceCarrier(
	messages: GuidanceMessage[],
	kind: string,
	text: string,
	extraInfo?: Record<string, unknown>,
): GuidanceMessage | null {
	const carrier = buildGuidanceCarrier(kind, text, extraInfo);
	if (carrier === null) return null;
	messages.push(carrier);
	return carrier;
}

/**
 * Host-render SHAPE predicate: the entry is in the exact shape the pinned host
 * renders into the model request (user branch of toModelMessagesEffect).
 */
export function isRenderableGuidance(
	entry: GuidanceMessage | null | undefined,
): boolean {
	if (entry === null || entry === undefined) return false;
	if (!isGuidanceCarrier(entry)) return false;
	if (entry.info.id === undefined || String(entry.info.id).length === 0) {
		return false;
	}
	return entry.parts.some((p) => p.type === 'text' && nonEmptyText(p.text));
}

/**
 * Delivery gate for producer telemetry (replaces the pre-#2526 self-referential
 * "I appended it to my own array" predicate). Delivery is recorded only when
 * this call produced a non-empty (trimmed) delta AND the resulting entry is in
 * the host-renderable shape. Pinned end-to-end by the host-contract tests.
 */
export function deliveredGuidanceDelta(
	entry: GuidanceMessage | null | undefined,
	delta: string | null,
): boolean {
	if (entry === null || entry === undefined) return false;
	if (delta === null || delta.trim().length === 0) return false;
	return isRenderableGuidance(entry);
}
