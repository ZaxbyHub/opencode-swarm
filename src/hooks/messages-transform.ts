/**
 * Materialize legacy `role:'system'` entries into guidance carriers (issue #2526).
 *
 * The OpenCode host's `toModelMessagesEffect` (pinned @opencode-ai 1.18.3 —
 * anomalyco/opencode@v1.18.3, packages/opencode/src/session/message-v2.ts:195-244)
 * branches only on `user` and `assistant` with no `else`, so a `role:'system'`
 * entry inside `experimental.chat.messages.transform` output is silently
 * discarded, and a flat entry without `parts` crashes the host prompt build
 * (`msg.parts.length` TypeError).
 *
 * This module replaces the pre-#2526 consolidation pass
 * (`consolidateSystemMessages*`, which merged every system entry into one
 * index-0 system message the host then dropped). Every plugin producer now
 * splices user-role guidance carriers directly (see
 * `system-guidance-carrier.ts`); this boundary pass is the defense-in-depth
 * net that converts — or drops — any system entry that still reaches the
 * array from an un-migrated or third-party injector:
 *
 *   - misclassified tool-result system entries (flat `tool_call_id`/`name`)
 *     are dropped (pre-existing semantics);
 *   - whitespace-only / textless system entries are dropped (they can never
 *     render, and a fence-only carrier body would be noise);
 *   - every other system entry is converted IN PLACE to a guidance carrier,
 *     preserving array position, entry reference identity (issue #1619 —
 *     other handlers may hold references to the same entry object), and any
 *     metadata on `info`.
 *
 * After the pass the array contains ZERO `role:'system'` entries, which makes
 * the historical local-model guarantee ("no system message at index > 0" —
 * Qwen/Gemma, issue #608/#628) absolute: the only system messages in the model
 * request come from the separate `experimental.chat.system.transform` string
 * surface, which the host renders itself.
 *
 * Dual-shape totality (issue #1778 H1) is preserved: entries arrive shaped
 * `{ info: { role, ... }, parts: [...] }` (production) or flat
 * `{ role, content }` (fixtures/legacy); both are handled, and malformed
 * entries whose role cannot be read pass through untouched.
 */

import {
	fenceGuidanceText,
	type GuidanceMessage,
	guidanceCarrierId,
} from './system-guidance-carrier.js';

type FlatMessage = {
	role: string;
	content: unknown;
	[key: string]: unknown;
};

type PartsMessage = {
	info: { role: string; [key: string]: unknown };
	parts: Array<{ type?: string; text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
};

export type Message = FlatMessage | PartsMessage;

function isPartsShape(message: Message): message is PartsMessage {
	const info = (message as PartsMessage).info;
	return (
		typeof info === 'object' &&
		info !== null &&
		typeof (info as { role?: unknown }).role === 'string' &&
		// Require parts to be an array too — otherwise a malformed info-shaped
		// item (info.role set, no parts) would be narrowed to PartsMessage and
		// then throw on `.parts.filter(...)`. The function must stay total on
		// any input (issue #1778 H1 review F1).
		Array.isArray((message as PartsMessage).parts)
	);
}

function getRole(message: Message): string | undefined {
	if (isPartsShape(message)) return message.info.role;
	const flat = message as FlatMessage;
	return typeof flat.role === 'string' ? flat.role : undefined;
}

/**
 * True for system messages that are really misclassified tool-result messages
 * (they carry tool_call_id / name). These are removed, not converted. Only the
 * flat shape carries these fields.
 */
function isToolResultSystemMessage(message: Message): boolean {
	if (isPartsShape(message)) return false;
	const flat = message as FlatMessage;
	return flat.tool_call_id !== undefined || flat.name !== undefined;
}

/** Extract the trimmed text of a system message, or null if it has none. */
function getSystemText(message: Message): string | null {
	if (isPartsShape(message)) {
		const texts = message.parts
			.filter((part) => part.type === 'text' && typeof part.text === 'string')
			.map((part) => (part.text as string).trim())
			.filter((t) => t.length > 0);
		return texts.length > 0 ? texts.join('\n') : null;
	}

	const content = (message as FlatMessage).content;
	if (typeof content === 'string') {
		const trimmed = content.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (Array.isArray(content)) {
		// Anthropic-style content: [{ type: "text", text: "..." }]
		const texts = (content as Array<{ type?: string; text?: string }>)
			.filter((part) => part.type === 'text' && typeof part.text === 'string')
			.map((part) => (part.text as string).trim())
			.filter((t) => t.length > 0);
		return texts.length > 0 ? texts.join('\n') : null;
	}
	return null;
}

/**
 * Convert a system entry to a guidance carrier IN PLACE: wipe the entry's own
 * properties and refill it, so the array slot, the entry reference, and any
 * `info` metadata survive. Returns the converted entry (or null when the text
 * is empty/whitespace — the caller drops those).
 */
function convertSystemEntryInPlace(message: Message, text: string): Message {
	const fenced = fenceGuidanceText('legacy-system', text);
	if (fenced === null) return message;
	const info: Record<string, unknown> = isPartsShape(message)
		? { ...(message as PartsMessage).info }
		: {};
	info.id = guidanceCarrierId('legacy-system');
	info.role = 'user';
	const carrier: GuidanceMessage = {
		info,
		parts: [{ type: 'text', text: fenced }],
	};
	const target = message as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		delete target[key];
	}
	Object.assign(target, carrier);
	return message;
}

export function materializeSystemGuidance(messages: Message[]): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		if (getRole(message) !== 'system') {
			result.push(message);
			continue;
		}
		// Misclassified tool results are removed, not converted.
		if (isToolResultSystemMessage(message)) continue;
		const text = getSystemText(message);
		// Whitespace-only / textless system entries can never render; dropped.
		if (text === null) continue;
		result.push(convertSystemEntryInPlace(message, text));
	}
	return result;
}

/**
 * In-place variant of {@link materializeSystemGuidance} for use inside an
 * `experimental.chat.messages.transform` handler.
 *
 * The OpenCode host invokes each plugin hook as `M(input, output)`, **discards
 * the handler's return value**, and afterwards reads its OWN local message
 * array. Therefore `output.messages = materializeSystemGuidance(...)` is a
 * *rebind* the host never observes (issue #1619). Only mutating the array the
 * host handed us is observable.
 *
 * The materialized result is computed BEFORE the array is cleared, because
 * `materializeSystemGuidance` reads the same array it is passed, and entries
 * are converted in place so references held elsewhere stay valid.
 */
export function materializeSystemGuidanceInPlace(messages: Message[]): void {
	const materialized = materializeSystemGuidance(messages);
	messages.length = 0;
	// Deliberately a loop, not `messages.push(...materialized)`: chat history
	// length is user-controlled and unbounded, and spreading a large array into
	// an argument list can exceed the engine's argument limit
	// (`RangeError: Maximum call stack size exceeded`). `splice(0, n, ...arr)`
	// has the same ceiling and is avoided for the same reason.
	for (const message of materialized) {
		messages.push(message);
	}
}
