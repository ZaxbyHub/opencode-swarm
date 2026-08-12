/**
 * Consolidates multiple system messages into a single system message at index 0.
 *
 * Note: Merged content order matches original insertion order (OpenCode base prompt
 * first, then swarm agent prompt) - this assumes sequential message construction.
 *
 * Dual-shape (issue #1778 H1): the OpenCode `messages.transform` hook delivers
 * items shaped `{ info: { role, ... }, parts: [{ type: 'text', text }] }`, while
 * unit fixtures and some callers use the flat `{ role, content }` shape. Both
 * must be handled — reading role from `info.role` OR top-level `role`, and text
 * from `parts[].text` OR `content` — or the consolidation (and the invariant-10
 * safety-net that strips system messages at index > 0 for local models) becomes
 * a silent no-op on production data.
 */

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
		// then throw on `.parts.filter(...)`. The function must stay total on any
		// input (issue #1778 H1 review F1).
		Array.isArray((message as PartsMessage).parts)
	);
}

function getRole(message: Message): string | undefined {
	if (isPartsShape(message)) return message.info.role;
	return (message as FlatMessage).role;
}

/**
 * True for system messages that are really misclassified tool-result messages
 * (they carry tool_call_id / name). These are removed, not merged. Only the
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

/** True for a system message whose content is present but whitespace-only. */
function isWhitespaceOnlySystem(message: Message): boolean {
	if (getRole(message) !== 'system') return false;
	if (isPartsShape(message)) {
		return (
			message.parts.length > 0 &&
			message.parts.every(
				(part) =>
					part.type !== 'text' ||
					typeof part.text !== 'string' ||
					part.text.trim().length === 0,
			)
		);
	}
	const content = (message as FlatMessage).content;
	return typeof content === 'string' && content.trim().length === 0;
}

/**
 * Build the single consolidated system message, preserving the SHAPE of the
 * first system message (so a `{info,parts}` payload stays `{info,parts}` and a
 * flat payload stays flat) and its metadata (id/sessionID/time, etc.).
 */
function buildConsolidatedSystem(
	firstSystem: Message,
	mergedText: string,
): Message {
	if (isPartsShape(firstSystem)) {
		return {
			...firstSystem,
			info: { ...firstSystem.info, role: 'system' },
			parts: [{ type: 'text', text: mergedText }],
		};
	}
	return {
		role: 'system',
		content: mergedText,
		...Object.fromEntries(
			Object.entries(firstSystem).filter(
				([key]) =>
					key !== 'role' &&
					key !== 'content' &&
					key !== 'name' &&
					key !== 'tool_call_id',
			),
		),
	};
}

export function consolidateSystemMessages(messages: Message[]): Message[] {
	// Fast path: exactly one system message, at index 0, already in canonical
	// form (parts shape, or flat shape with a plain non-empty string content).
	// Flat array-content (Anthropic-style) is intentionally excluded so it is
	// normalized to a single string below.
	if (
		messages.length > 0 &&
		getRole(messages[0]) === 'system' &&
		getSystemText(messages[0]) !== null &&
		(isPartsShape(messages[0]) ||
			typeof (messages[0] as FlatMessage).content === 'string')
	) {
		const totalSystemCount = messages.filter(
			(m) => getRole(m) === 'system',
		).length;
		if (totalSystemCount === 1) {
			return [...messages];
		}
	}

	// Collect indices and contents of system messages to merge.
	const systemMessageIndices: number[] = [];
	const systemContents: string[] = [];

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];

		if (getRole(message) !== 'system') continue;

		// Skip misclassified tool-result messages — they are removed, not merged.
		if (isToolResultSystemMessage(message)) continue;

		const textContent = getSystemText(message);

		systemMessageIndices.push(i);
		if (textContent) {
			systemContents.push(textContent);
		}
	}

	// If there are no system messages to merge, remove all system messages
	// except the one at index 0 (local models crash on system messages at index > 0).
	if (systemContents.length === 0) {
		return messages.filter((m, idx) => {
			if (getRole(m) !== 'system') return true;
			return idx === 0;
		});
	}

	// Join system contents (base prompt first, then swarm agent prompt).
	const mergedSystemContent = systemContents.join('\n\n');

	const result: Message[] = [];

	// Consolidated system message at index 0, preserving the first system
	// message's shape and metadata.
	result.push(
		buildConsolidatedSystem(
			messages[systemMessageIndices[0]],
			mergedSystemContent,
		),
	);

	// Add all non-merged messages in their original order.
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];

		if (systemMessageIndices.includes(i)) continue;

		// Skip whitespace-only system messages that were not merged.
		if (isWhitespaceOnlySystem(message)) continue;

		// Shallow copy to avoid mutating the original.
		result.push({ ...message });
	}

	// Safety net: strip any system message that slipped past merge logic.
	// Local models (Qwen, Gemma) crash on system messages at index > 0.
	return result.filter((msg, idx) => {
		if (idx === 0) return true;
		return getRole(msg) !== 'system';
	});
}

/**
 * In-place variant of {@link consolidateSystemMessages} for use inside an
 * `experimental.chat.messages.transform` handler.
 *
 * The OpenCode host invokes each plugin hook as `M(input, output)`, **discards
 * the handler's return value**, and afterwards reads its OWN local message
 * array (host binary offset ~100,667,665:
 * `yield* d.trigger("experimental.chat.messages.transform",{},{messages:C})`
 * followed by `Me.toModelMessagesEffect(C,Z)`). Therefore
 * `output.messages = consolidateSystemMessages(output.messages)` is a *rebind*
 * that the host never observes — it silently did nothing in production from the
 * day it was written until issue #1619. Only mutating the array the host handed
 * us is observable.
 *
 * The consolidated result is computed BEFORE the array is cleared, because
 * `consolidateSystemMessages` reads the same array it is passed.
 */
export function consolidateSystemMessagesInPlace(messages: Message[]): void {
	const consolidated = consolidateSystemMessages(messages);
	messages.length = 0;
	// Deliberately a loop, not `messages.push(...consolidated)`: chat history
	// length is user-controlled and unbounded, and spreading a large array into
	// an argument list can exceed the engine's argument limit
	// (`RangeError: Maximum call stack size exceeded`). `splice(0, n, ...arr)`
	// has the same ceiling and is avoided for the same reason.
	for (const message of consolidated) {
		messages.push(message);
	}
}
