import { beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	advanceModelFallback,
	clearModelFallbacksForSession,
	peekModelFallbackIndex,
	peekModelOverride,
	resetModelFallback,
} from '../../../src/agents/model-override';

describe('per-session model override store (issue #2103 workstream E)', () => {
	beforeEach(() => {
		for (const key of [..._internals.store.keys()]) {
			_internals.store.delete(key);
		}
	});

	test('advance/peek/reset lifecycle', () => {
		const next = advanceModelFallback('s1', 'default', 'coder', 2);
		expect(next).toBe(1);
		expect(peekModelFallbackIndex('s1', 'default', 'coder')).toBe(1);
		expect(peekModelOverride('s1', 'default', 'coder', ['m/a', 'm/b'])).toBe(
			'm/a',
		);
		advanceModelFallback('s1', 'default', 'coder', 2);
		expect(peekModelOverride('s1', 'default', 'coder', ['m/a', 'm/b'])).toBe(
			'm/b',
		);
		// Exhaustion is explicit and does not wrap.
		expect(advanceModelFallback('s1', 'default', 'coder', 2)).toBeNull();
		resetModelFallback('s1', 'default', 'coder');
		expect(peekModelFallbackIndex('s1', 'default', 'coder')).toBe(0);
		expect(
			peekModelOverride('s1', 'default', 'coder', ['m/a']),
		).toBeUndefined();
	});

	test("two sessions cannot observe each other's overrides", () => {
		advanceModelFallback('s1', 'default', 'coder', 1);
		expect(peekModelFallbackIndex('s2', 'default', 'coder')).toBe(0);
	});

	test("two swarms and two roles cannot observe each other's overrides", () => {
		advanceModelFallback('s1', 'local', 'coder', 1);
		expect(peekModelFallbackIndex('s1', 'mega', 'coder')).toBe(0);
		expect(peekModelFallbackIndex('s1', 'local', 'reviewer')).toBe(0);
	});

	test('clearModelFallbacksForSession removes the whole session', () => {
		advanceModelFallback('s1', 'default', 'coder', 1);
		clearModelFallbacksForSession('s1');
		expect(peekModelFallbackIndex('s1', 'default', 'coder')).toBe(0);
	});

	test('store stays bounded with LRU eviction at 64 sessions', () => {
		for (let i = 0; i < 70; i++) {
			advanceModelFallback(`sess-${i}`, 'default', 'coder', 3);
		}
		expect(_internals.store.size).toBeLessThanOrEqual(
			_internals.MAX_TRACKED_SESSIONS,
		);
		expect(peekModelFallbackIndex('sess-0', 'default', 'coder')).toBe(0);
		expect(peekModelFallbackIndex('sess-69', 'default', 'coder')).toBe(1);
	});
});

describe('dispatchWithModelFallback startFallbackIndex (#2103 E)', () => {
	test('the recorded override reaches the actual dispatch call (request-level proof)', async () => {
		const { dispatchWithModelFallback } = await import(
			'../../../src/utils/model-dispatch-fallback.js'
		);
		advanceModelFallback('sx', 'default', 'coder', 1);
		const usedModels: Array<string | undefined> = [];
		const result = await dispatchWithModelFallback<string>({
			startFallbackIndex: peekModelFallbackIndex('sx', 'default', 'coder'),
			dispatch: async (model) => {
				usedModels.push(
					model ? `${model.providerID}/${model.modelID}` : undefined,
				);
				return 'ok';
			},
			resolveFallback: (index) => (index === 1 ? 'provider/fallback-1' : null),
			classify: () => 'transient',
		});
		expect(result.result).toBe('ok');
		expect(result.fallbackIndex).toBe(1);
		expect(usedModels).toEqual(['provider/fallback-1']);
	});

	test('without an override the first dispatch uses the primary (undefined model)', async () => {
		const { dispatchWithModelFallback } = await import(
			'../../../src/utils/model-dispatch-fallback.js'
		);
		const usedModels: Array<string | undefined> = [];
		await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				usedModels.push(
					model ? `${model.providerID}/${model.modelID}` : undefined,
				);
				return 'ok';
			},
			resolveFallback: () => 'provider/fallback-1',
			classify: () => 'transient',
		});
		expect(usedModels).toEqual([undefined]);
	});
});
