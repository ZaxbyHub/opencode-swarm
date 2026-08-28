import { estimateTokens, estimateTokensFromCharCount } from './utils';

const MAX_TOOL_INPUT_DEPTH = 4;
const MAX_TOOL_INPUT_COLLECTION_ITEMS = 20;
const MAX_TOOL_INPUT_STRING_CHARS = 200;
const MAX_TOOL_INPUT_TOTAL_CHARS = 2000;
const TRUNCATED_COLLECTION_FALLBACK = '[+more]';
const TRUNCATED_OBJECT_KEYS_FALLBACK = '[+more keys]';

export interface ContextUsageMessageInfo {
	role?: string;
	tokens?: {
		input?: unknown;
		cache?: {
			read?: unknown;
			write?: unknown;
		};
	};
	[key: string]: unknown;
}

export interface ContextUsageMessagePart {
	type?: string;
	text?: string;
	state?: {
		status?: string;
		input?: unknown;
		output?: string;
		error?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface ContextUsageMessage {
	info?: ContextUsageMessageInfo;
	parts?: ContextUsageMessagePart[];
}

export type ContextUsageSource = 'provider' | 'estimated';

export interface ContextUsageResult {
	tokensUsed: number;
	source: ContextUsageSource;
	assistantAnchorIndex: number | null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function truncateString(
	value: string,
	maxChars = MAX_TOOL_INPUT_STRING_CHARS,
): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…`;
}

function serializeBoundedObjectKey(key: string): string {
	return JSON.stringify(truncateString(key));
}

/** Count JSON.stringify(string) output without allocating the escaped string. */
function estimateJsonStringCharacters(value: string): number {
	let characters = 2; // surrounding quotes
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x22 || code === 0x5c) {
			characters += 2;
			continue;
		}
		if (
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			characters += 2;
			continue;
		}
		if (code < 0x20) {
			characters += 6;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				characters += 2;
				index++;
			} else {
				characters += 6;
			}
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			characters += 6;
			continue;
		}
		characters++;
	}
	return characters;
}

function estimateBoundedObjectKeyCharacters(key: string): number {
	return estimateJsonStringCharacters(key);
}

function getBoundedCollectionMarker(omittedCount: number | null): string {
	if (omittedCount !== null && omittedCount > 0) {
		return `[+${omittedCount} more]`;
	}
	return TRUNCATED_COLLECTION_FALLBACK;
}

function getExactOmittedCount(
	totalCount: unknown,
	visibleCount: number,
): number | null {
	if (
		typeof totalCount !== 'number' ||
		!Number.isFinite(totalCount) ||
		totalCount <= visibleCount
	) {
		return null;
	}
	return Math.floor(totalCount - visibleCount);
}

function collectBoundedIterator<T>(
	iterator: Iterator<T>,
	limit: number,
): {
	items: T[];
	hasOmittedItems: boolean;
} {
	const items: T[] = [];
	while (items.length < limit) {
		const next = iterator.next();
		if (next.done) {
			return { items, hasOmittedItems: false };
		}
		items.push(next.value);
	}
	const extra = iterator.next();
	return {
		items,
		hasOmittedItems: !extra.done,
	};
}

function collectBoundedOwnEnumerableKeys(
	obj: Record<string, unknown>,
	limit: number,
): {
	keys: string[];
	hasOmittedKeys: boolean;
} {
	const keys: string[] = [];
	let visitedKeys = 0;
	for (const key in obj) {
		visitedKeys++;
		if (visitedKeys > limit) {
			return { keys, hasOmittedKeys: true };
		}
		if (!Object.hasOwn(obj, key)) continue;
		if (keys.length >= limit) {
			return { keys, hasOmittedKeys: true };
		}
		keys.push(key);
	}
	return { keys, hasOmittedKeys: false };
}

function serializeBinaryPreview(
	byteLength: number,
	getByte: (index: number) => number,
): string {
	const visibleBytes = Math.min(byteLength, MAX_TOOL_INPUT_COLLECTION_ITEMS);
	let bytes = '';
	for (let i = 0; i < visibleBytes; i++) {
		if (i > 0) bytes += ',';
		bytes += String(getByte(i));
	}
	if (byteLength <= MAX_TOOL_INPUT_COLLECTION_ITEMS) {
		return bytes;
	}
	return `${bytes},${JSON.stringify(`[+${byteLength - visibleBytes} more bytes]`)}`;
}

function serializeToolInputValue(
	value: unknown,
	depth: number,
	activeObjects: WeakSet<object>,
): string {
	if (depth >= MAX_TOOL_INPUT_DEPTH) return '"[MaxDepth]"';
	if (value === null) return 'null';

	switch (typeof value) {
		case 'string':
			return JSON.stringify(truncateString(value));
		case 'number':
			return Number.isFinite(value)
				? JSON.stringify(value)
				: JSON.stringify(String(value));
		case 'boolean':
			return JSON.stringify(value);
		case 'undefined':
			return '"[Undefined]"';
		case 'bigint':
			return `{"$bigint":${JSON.stringify(value.toString())}}`;
		case 'symbol':
			return `{"$symbol":${JSON.stringify(String(value))}}`;
		case 'function':
			return `{"$function":${JSON.stringify(value.name || 'anonymous')}}`;
	}

	if (typeof value !== 'object') {
		return JSON.stringify(String(value));
	}

	if (activeObjects.has(value)) {
		return '"[Circular]"';
	}
	activeObjects.add(value);
	try {
		if (Array.isArray(value)) {
			const items = value
				.slice(0, MAX_TOOL_INPUT_COLLECTION_ITEMS)
				.map((item) => serializeToolInputValue(item, depth + 1, activeObjects));
			if (value.length > MAX_TOOL_INPUT_COLLECTION_ITEMS) {
				items.push(
					JSON.stringify(
						`[+${value.length - MAX_TOOL_INPUT_COLLECTION_ITEMS} more]`,
					),
				);
			}
			return `[${items.join(',')}]`;
		}

		if (value instanceof Date) {
			const iso = Number.isNaN(value.getTime())
				? 'Invalid Date'
				: value.toISOString();
			return `{"$date":${JSON.stringify(iso)}}`;
		}

		if (value instanceof Map) {
			const { items, hasOmittedItems } = collectBoundedIterator(
				value.entries(),
				MAX_TOOL_INPUT_COLLECTION_ITEMS,
			);
			const entries = items
				.map(
					([key, mapValue]) =>
						[
							serializeToolInputValue(key, depth + 1, activeObjects),
							serializeToolInputValue(mapValue, depth + 1, activeObjects),
						] as const,
				)
				.sort(([a], [b]) => a.localeCompare(b));
			const serializedEntries = entries.map(
				([key, mapValue]) => `[${key},${mapValue}]`,
			);
			if (hasOmittedItems) {
				serializedEntries.push(
					JSON.stringify(
						getBoundedCollectionMarker(
							getExactOmittedCount(value.size, items.length),
						),
					),
				);
			}
			return `{"$map":[${serializedEntries.join(',')}]}`;
		}

		if (value instanceof Set) {
			const { items, hasOmittedItems } = collectBoundedIterator(
				value.values(),
				MAX_TOOL_INPUT_COLLECTION_ITEMS,
			);
			const entries = items
				.map((entry) =>
					serializeToolInputValue(entry, depth + 1, activeObjects),
				)
				.sort();
			if (hasOmittedItems) {
				entries.push(
					JSON.stringify(
						getBoundedCollectionMarker(
							getExactOmittedCount(value.size, items.length),
						),
					),
				);
			}
			return `{"$set":[${entries.join(',')}]}`;
		}

		if (ArrayBuffer.isView(value)) {
			const bytes = new Uint8Array(
				value.buffer,
				value.byteOffset,
				Math.min(value.byteLength, MAX_TOOL_INPUT_COLLECTION_ITEMS),
			);
			return `{"$typedArray":"${value.constructor.name}","data":[${serializeBinaryPreview(
				value.byteLength,
				(index) => bytes[index] ?? 0,
			)}]}`;
		}

		if (value instanceof ArrayBuffer) {
			const bytes = new Uint8Array(
				value,
				0,
				Math.min(value.byteLength, MAX_TOOL_INPUT_COLLECTION_ITEMS),
			);
			return `{"$arrayBuffer":[${serializeBinaryPreview(
				value.byteLength,
				(index) => bytes[index] ?? 0,
			)}]}`;
		}

		const obj = value as Record<string, unknown>;
		const { keys, hasOmittedKeys } = collectBoundedOwnEnumerableKeys(
			obj,
			MAX_TOOL_INPUT_COLLECTION_ITEMS,
		);
		keys.sort();
		const entries = keys.map(
			(key) =>
				`${serializeBoundedObjectKey(key)}:${serializeToolInputValue(
					obj[key],
					depth + 1,
					activeObjects,
				)}`,
		);
		if (hasOmittedKeys) {
			entries.push(
				`${JSON.stringify('$truncatedKeys')}:${JSON.stringify(TRUNCATED_OBJECT_KEYS_FALLBACK)}`,
			);
		}
		return `{${entries.join(',')}}`;
	} finally {
		activeObjects.delete(value);
	}
}

export function serializeToolInput(input: unknown): string {
	try {
		const serialized = serializeToolInputValue(input, 0, new WeakSet<object>());
		return truncateString(serialized, MAX_TOOL_INPUT_TOTAL_CHARS);
	} catch {
		return '"[Unserializable]"';
	}
}

/**
 * Estimate provider-visible tool-call input without materializing an unbounded
 * JSON string. Collection traversal is deliberately capped, but the complete
 * length of every visited string is retained so a single large command,
 * patch, or task prompt is not reduced to the serializer's 200-character
 * diagnostic preview.
 */
function estimateToolInputCharacters(
	value: unknown,
	depth: number,
	activeObjects: WeakSet<object>,
): number {
	if (depth >= MAX_TOOL_INPUT_DEPTH) return '"[MaxDepth]"'.length;
	if (value === null) return 4;

	switch (typeof value) {
		case 'string':
			return estimateJsonStringCharacters(value);
		case 'number':
			return (
				Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
			).length;
		case 'boolean':
			return value ? 4 : 5;
		case 'undefined':
			return '"[Undefined]"'.length;
		case 'bigint':
			return value.toString().length + '{"$bigint":""}'.length;
		case 'symbol':
			return (
				estimateJsonStringCharacters(String(value)) + '{"$symbol":}'.length
			);
		case 'function':
			return (
				estimateJsonStringCharacters(value.name || 'anonymous') +
				'{"$function":}'.length
			);
	}

	if (typeof value !== 'object') return String(value).length + 2;
	if (activeObjects.has(value)) return '"[Circular]"'.length;
	activeObjects.add(value);

	try {
		if (Array.isArray(value)) {
			const visible = value.slice(0, MAX_TOOL_INPUT_COLLECTION_ITEMS);
			let chars = 2 + Math.max(0, visible.length - 1);
			for (const item of visible) {
				chars += estimateToolInputCharacters(item, depth + 1, activeObjects);
			}
			if (value.length > visible.length) {
				chars +=
					1 + JSON.stringify(`[+${value.length - visible.length} more]`).length;
			}
			return chars;
		}

		if (value instanceof Date) {
			const iso = Number.isNaN(value.getTime())
				? 'Invalid Date'
				: value.toISOString();
			return estimateJsonStringCharacters(iso) + '{"$date":}'.length;
		}

		if (value instanceof Map) {
			const { items, hasOmittedItems } = collectBoundedIterator(
				value.entries(),
				MAX_TOOL_INPUT_COLLECTION_ITEMS,
			);
			let chars = '{"$map":[]}'.length + Math.max(0, items.length - 1);
			for (const [key, mapValue] of items) {
				chars +=
					3 +
					estimateToolInputCharacters(key, depth + 1, activeObjects) +
					estimateToolInputCharacters(mapValue, depth + 1, activeObjects);
			}
			if (hasOmittedItems) {
				chars +=
					1 +
					JSON.stringify(
						getBoundedCollectionMarker(
							getExactOmittedCount(value.size, items.length),
						),
					).length;
			}
			return chars;
		}

		if (value instanceof Set) {
			const { items, hasOmittedItems } = collectBoundedIterator(
				value.values(),
				MAX_TOOL_INPUT_COLLECTION_ITEMS,
			);
			let chars = '{"$set":[]}'.length + Math.max(0, items.length - 1);
			for (const entry of items) {
				chars += estimateToolInputCharacters(entry, depth + 1, activeObjects);
			}
			if (hasOmittedItems) {
				chars +=
					1 +
					JSON.stringify(
						getBoundedCollectionMarker(
							getExactOmittedCount(value.size, items.length),
						),
					).length;
			}
			return chars;
		}

		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
			// NOT a char→token estimation: this is a conservative
			// serialization-size heuristic for binary tool input (a binary
			// payload's worst-case JSON-escaped char cost). It is deliberately
			// exempt from the canonical estimator and allowlisted in
			// scripts/check-invariants.ts's inline-token-formula check.
			const byteLength = value.byteLength;
			return Math.max(
				byteLength * 4,
				JSON.stringify(`[${byteLength} binary bytes]`).length,
			);
		}

		const obj = value as Record<string, unknown>;
		const { keys, hasOmittedKeys } = collectBoundedOwnEnumerableKeys(
			obj,
			MAX_TOOL_INPUT_COLLECTION_ITEMS,
		);
		keys.sort();
		let chars = 2 + Math.max(0, keys.length - 1);
		for (const key of keys) {
			chars +=
				estimateBoundedObjectKeyCharacters(key) +
				1 +
				estimateToolInputCharacters(obj[key], depth + 1, activeObjects);
		}
		if (hasOmittedKeys) {
			chars +=
				1 +
				JSON.stringify('$truncatedKeys').length +
				1 +
				JSON.stringify(TRUNCATED_OBJECT_KEYS_FALLBACK).length;
		}
		return chars;
	} finally {
		activeObjects.delete(value);
	}
}

export function estimateToolInputTokens(input: unknown): number {
	try {
		return estimateTokensFromCharCount(
			estimateToolInputCharacters(input, 0, new WeakSet<object>()),
		);
	} catch {
		return estimateTokens('"[Unserializable]"');
	}
}

export function getVisibleToolPartText(part: ContextUsageMessagePart): string {
	if (part?.type !== 'tool') return '';

	const chunks: string[] = [];
	if (part.state && 'input' in part.state) {
		const serializedInput = serializeToolInput(part.state.input);
		if (serializedInput) {
			chunks.push(serializedInput);
		}
	}

	if (
		part.state?.status === 'completed' &&
		typeof part.state.output === 'string'
	) {
		chunks.push(part.state.output);
	}

	if (part.state?.status === 'error' && typeof part.state.error === 'string') {
		chunks.push(part.state.error);
	}

	return chunks.join('\n');
}

export function estimateVisibleToolPartTokens(
	part: ContextUsageMessagePart,
): number {
	if (part?.type !== 'tool') return 0;

	let totalTokens = 0;
	if (part.state && 'input' in part.state) {
		totalTokens += estimateToolInputTokens(part.state.input);
	}
	if (
		part.state?.status === 'completed' &&
		typeof part.state.output === 'string'
	) {
		totalTokens += estimateTokens(part.state.output);
	}
	if (part.state?.status === 'error' && typeof part.state.error === 'string') {
		totalTokens += estimateTokens(part.state.error);
	}
	return totalTokens;
}

export function estimateMessageTokens(message: ContextUsageMessage): number {
	if (!message?.parts || !Array.isArray(message.parts)) return 0;

	let totalTokens = 0;
	for (const part of message.parts) {
		if (part?.type === 'text' && typeof part.text === 'string') {
			totalTokens += estimateTokens(part.text);
			continue;
		}

		if (part?.type !== 'tool') continue;
		totalTokens += estimateVisibleToolPartTokens(part);
	}

	return totalTokens;
}

export function readProviderPromptTokens(
	message: ContextUsageMessage | undefined,
): number | undefined {
	const tokens = message?.info?.tokens;
	const input = tokens?.input;
	const cacheRead = tokens?.cache?.read;
	const cacheWrite = tokens?.cache?.write;

	if (
		!isFiniteNonNegativeNumber(input) ||
		!isFiniteNonNegativeNumber(cacheRead) ||
		!isFiniteNonNegativeNumber(cacheWrite)
	) {
		return undefined;
	}

	const total = input + cacheRead + cacheWrite;
	if (!Number.isFinite(total)) {
		return undefined;
	}
	return Math.floor(total);
}

export function computeContextUsage(
	messages: ContextUsageMessage[] | undefined,
): ContextUsageResult {
	if (!messages || messages.length === 0) {
		return {
			tokensUsed: 0,
			source: 'estimated',
			assistantAnchorIndex: null,
		};
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.info?.role !== 'assistant') continue;

		const providerPromptTokens = readProviderPromptTokens(message);
		if (providerPromptTokens === undefined) continue;

		let totalTokens = providerPromptTokens + estimateMessageTokens(message);
		for (let j = i + 1; j < messages.length; j++) {
			totalTokens += estimateMessageTokens(messages[j]);
		}

		return {
			tokensUsed: totalTokens,
			source: 'provider',
			assistantAnchorIndex: i,
		};
	}

	let totalTokens = 0;
	for (const message of messages) {
		totalTokens += estimateMessageTokens(message);
	}

	return {
		tokensUsed: totalTokens,
		source: 'estimated',
		assistantAnchorIndex: null,
	};
}

export const _test_exports = {
	computeContextUsage,
	estimateToolInputTokens,
	estimateVisibleToolPartTokens,
	estimateMessageTokens,
	readProviderPromptTokens,
	serializeToolInput,
};
