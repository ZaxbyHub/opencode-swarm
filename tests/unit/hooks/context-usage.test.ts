import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/hooks/context-usage';

const {
	computeContextUsage,
	estimateMessageTokens,
	estimateToolInputTokens,
	readProviderPromptTokens,
	serializeToolInput,
} = _test_exports;

function makeMessage(
	overrides: {
		role?: string;
		text?: string;
		tokens?: {
			input?: unknown;
			cache?: { read?: unknown; write?: unknown };
		};
		toolOutput?: string;
		toolError?: string;
		toolInput?: unknown;
	} = {},
) {
	const parts: Array<Record<string, unknown>> = [];
	if (overrides.text !== undefined) {
		parts.push({ type: 'text', text: overrides.text });
	}
	if (overrides.toolOutput !== undefined) {
		parts.push({
			type: 'tool',
			tool: 'bash',
			state: {
				status: 'completed',
				...(overrides.toolInput !== undefined
					? { input: overrides.toolInput }
					: {}),
				output: overrides.toolOutput,
			},
		});
	}
	if (overrides.toolError !== undefined) {
		parts.push({
			type: 'tool',
			tool: 'bash',
			state: {
				status: 'error',
				...(overrides.toolInput !== undefined
					? { input: overrides.toolInput }
					: {}),
				error: overrides.toolError,
			},
		});
	}
	return {
		info: {
			role: overrides.role ?? 'user',
			...(overrides.tokens ? { tokens: overrides.tokens } : {}),
		},
		parts,
	};
}

class CountingMap<K, V> extends Map<K, V> {
	entryPulls = 0;

	override entries(): MapIterator<[K, V]> {
		const iterator = super.entries();
		const parent = this;
		return {
			[Symbol.iterator]() {
				return this;
			},
			next() {
				parent.entryPulls++;
				return iterator.next();
			},
		} as MapIterator<[K, V]>;
	}
}

class CountingSet<T> extends Set<T> {
	valuePulls = 0;

	override values(): SetIterator<T> {
		const iterator = super.values();
		const parent = this;
		return {
			[Symbol.iterator]() {
				return this;
			},
			next() {
				parent.valuePulls++;
				return iterator.next();
			},
		} as SetIterator<T>;
	}
}

describe('context-usage helper', () => {
	test('falls back to estimated usage when no assistant prompt accounting exists', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'hello world' }),
			makeMessage({ role: 'assistant', text: 'reply' }),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('estimated');
		expect(result.tokensUsed).toBe(
			estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[1]),
		);
		expect(result.assistantAnchorIndex).toBeNull();
	});

	test('uses the latest valid assistant prompt accounting and adds visible assistant content plus later messages', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'before' }),
			makeMessage({
				role: 'assistant',
				text: 'older reply',
				tokens: { input: 10, cache: { read: 2, write: 1 } },
			}),
			makeMessage({
				role: 'assistant',
				text: 'latest reply',
				toolOutput: 'tool output',
				tokens: { input: 120, cache: { read: 30, write: 10 } },
			}),
			makeMessage({ role: 'user', text: 'follow up' }),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.assistantAnchorIndex).toBe(2);
		expect(result.tokensUsed).toBe(
			160 +
				estimateMessageTokens(messages[2]) +
				estimateMessageTokens(messages[3]),
		);
	});

	test('counts bounded serialized tool input on the anchor assistant message', () => {
		const cyclicInput: Record<string, unknown> = { b: 2, a: 1 };
		cyclicInput.self = cyclicInput;
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'reply',
				toolInput: cyclicInput,
				tokens: { input: 100, cache: { read: 20, write: 10 } },
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.tokensUsed).toBe(130 + estimateMessageTokens(messages[0]));
	});

	test('counts bounded serialized tool input from later messages after the provider anchor', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'reply',
				tokens: { input: 80, cache: { read: 10, write: 10 } },
			}),
			makeMessage({
				role: 'assistant',
				toolInput: new Map([
					['z', 1],
					['a', 2],
				]),
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.tokensUsed).toBe(
			100 +
				estimateMessageTokens(messages[0]) +
				estimateMessageTokens(messages[1]),
		);
	});

	test('counts the full size of large tool input strings at the provider anchor and later messages', () => {
		const largeCommand = 'x'.repeat(10_000);
		const anchor = makeMessage({
			role: 'assistant',
			toolInput: { command: largeCommand },
			toolOutput: '',
			tokens: { input: 100, cache: { read: 20, write: 10 } },
		});
		const later = makeMessage({
			role: 'assistant',
			toolInput: { task: largeCommand },
			toolOutput: '',
		});

		const result = computeContextUsage([anchor, later]);
		expect(estimateToolInputTokens({ command: largeCommand })).toBeGreaterThan(
			3_000,
		);
		expect(result.tokensUsed).toBe(
			130 + estimateMessageTokens(anchor) + estimateMessageTokens(later),
		);
		expect(result.tokensUsed).toBeGreaterThan(6_000);
		expect(
			serializeToolInput({ command: largeCommand }).length,
		).toBeLessThanOrEqual(2_001);
	});

	test('counts visible tool error text on the anchor assistant message', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'reply',
				toolError: 'tool failed loudly',
				tokens: { input: 100, cache: { read: 20, write: 10 } },
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.tokensUsed).toBe(130 + estimateMessageTokens(messages[0]));
	});

	test('counts visible tool error text from later messages after the provider anchor', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'reply',
				tokens: { input: 80, cache: { read: 10, write: 10 } },
			}),
			makeMessage({
				role: 'assistant',
				toolError: 'later tool failure details',
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.tokensUsed).toBe(
			100 +
				estimateMessageTokens(messages[0]) +
				estimateMessageTokens(messages[1]),
		);
	});

	test('skips malformed assistant token payloads and keeps searching backward', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'older valid',
				tokens: { input: 40, cache: { read: 10, write: 5 } },
			}),
			makeMessage({
				role: 'assistant',
				text: 'newer invalid',
				tokens: { input: 50, cache: { read: -1, write: 5 } },
			}),
			makeMessage({ role: 'user', text: 'after' }),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.assistantAnchorIndex).toBe(0);
		expect(result.tokensUsed).toBe(
			55 +
				estimateMessageTokens(messages[0]) +
				estimateMessageTokens(messages[1]) +
				estimateMessageTokens(messages[2]),
		);
	});

	test('reads provider prompt tokens only when all fields are finite and nonnegative', () => {
		expect(
			readProviderPromptTokens(
				makeMessage({
					role: 'assistant',
					tokens: { input: 12, cache: { read: 3, write: 4 } },
				}),
			),
		).toBe(19);
		expect(
			readProviderPromptTokens(
				makeMessage({
					role: 'assistant',
					tokens: { input: Infinity, cache: { read: 3, write: 4 } },
				}),
			),
		).toBeUndefined();
		expect(
			readProviderPromptTokens(
				makeMessage({
					role: 'assistant',
					tokens: { input: 12, cache: { read: 3, write: -4 } },
				}),
			),
		).toBeUndefined();
	});

	test('falls back to estimated usage when provider prompt accounting overflows', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'anchor',
				tokens: {
					input: Number.MAX_VALUE,
					cache: { read: Number.MAX_VALUE, write: 1 },
				},
			}),
			makeMessage({ role: 'user', text: 'after overflow' }),
		];

		expect(readProviderPromptTokens(messages[0])).toBeUndefined();
		expect(computeContextUsage(messages)).toEqual({
			tokensUsed:
				estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[1]),
			source: 'estimated',
			assistantAnchorIndex: null,
		});
	});

	test('serializes tool input deterministically, boundedly, and without throwing on cycles', () => {
		const first: Record<string, unknown> = {
			b: 'x'.repeat(500),
			a: [3, 2, 1],
		};
		first.self = first;
		const second: Record<string, unknown> = {
			a: [3, 2, 1],
			b: 'x'.repeat(500),
		};
		second.self = second;

		const firstSerialized = serializeToolInput(first);
		const secondSerialized = serializeToolInput(second);

		expect(firstSerialized).toBe(secondSerialized);
		expect(firstSerialized).toContain('[Circular]');
		expect(firstSerialized.length).toBeLessThanOrEqual(2001);
	});

	test('bounds map and set iterator pulls during serialization and estimation', () => {
		const countedMap = new CountingMap<string, number>();
		const countedSet = new CountingSet<number>();
		for (let i = 0; i < 100; i++) {
			countedMap.set(`k${i}`, i);
			countedSet.add(i);
		}

		const serializedMap = serializeToolInput({ countedMap });
		expect(countedMap.entryPulls).toBeLessThanOrEqual(21);
		expect(serializedMap).toContain('[+80 more]');

		countedMap.entryPulls = 0;
		expect(estimateToolInputTokens({ countedMap })).toBeGreaterThan(0);
		expect(countedMap.entryPulls).toBeLessThanOrEqual(21);

		const serializedSet = serializeToolInput({ countedSet });
		expect(countedSet.valuePulls).toBeLessThanOrEqual(21);
		expect(serializedSet).toContain('[+80 more]');

		countedSet.valuePulls = 0;
		expect(estimateToolInputTokens({ countedSet })).toBeGreaterThan(0);
		expect(countedSet.valuePulls).toBeLessThanOrEqual(21);
	});

	test('serializes object keys with a bounded deterministic preview marker', () => {
		const manyKeys: Record<string, number> = {};
		for (let i = 0; i < 100; i++) {
			manyKeys[`k${String(100 - i).padStart(3, '0')}`] = i;
		}

		const serialized = serializeToolInput(manyKeys);

		expect(serialized).toContain('"k081"');
		expect(serialized).toContain('"k100"');
		expect(serialized).toContain('"$truncatedKeys":"[+more keys]"');
		expect(serialized).not.toContain('"k001"');
	});

	test('bounds huge key serialization while estimating the full key size', () => {
		const hugeKey = `${'k'.repeat(200)}TAIL${'z'.repeat(20_000)}`;
		const serialized = serializeToolInput({ [hugeKey]: 'value' });
		const estimatedTokens = estimateToolInputTokens({ [hugeKey]: 'value' });

		expect(serialized).toContain(`"${'k'.repeat(200)}…":"value"`);
		expect(serialized).not.toContain('TAIL');
		expect(serialized.length).toBeLessThanOrEqual(240);
		expect(Number.isFinite(estimatedTokens)).toBe(true);
		expect(estimatedTokens).toBeGreaterThan(6_000);
	});

	test('estimates large JSON-escaped keys and values without materializing them', () => {
		const escaped = '\0'.repeat(10_000);
		const escapedKeyTokens = estimateToolInputTokens({ [escaped]: 'value' });
		const escapedValueTokens = estimateToolInputTokens({ value: escaped });
		const serialized = serializeToolInput({ [escaped]: escaped });

		expect(escapedKeyTokens).toBeGreaterThan(19_000);
		expect(escapedValueTokens).toBeGreaterThan(19_000);
		expect(serialized.length).toBeLessThanOrEqual(2_001);
	});

	test('counts lone-surrogate escapes but keeps valid pairs as two code units', () => {
		const loneSurrogates = '\ud800'.repeat(1_000);
		const validPairs = '😀'.repeat(1_000);

		expect(estimateToolInputTokens(loneSurrogates)).toBeGreaterThan(1_900);
		expect(estimateToolInputTokens(validPairs)).toBeLessThan(700);
	});

	test('serializes binary input with a capped byte preview and size-based estimation', () => {
		const bytes = new Uint8Array(64);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = i;
		}

		const serializedView = serializeToolInput(bytes);
		const serializedBuffer = serializeToolInput(bytes.buffer);

		expect(serializedView).toContain('"$typedArray":"Uint8Array"');
		expect(serializedView).toContain('[+44 more bytes]');
		expect(serializedView).not.toContain('63');
		expect(serializedBuffer).toContain('[+44 more bytes]');
		expect(estimateToolInputTokens(bytes)).toBeGreaterThan(20);
	});
});
