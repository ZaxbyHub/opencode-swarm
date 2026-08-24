/**
 * Shared model-dispatch fallback helper coverage:
 * - parse + malformed handling
 * - bounded same-model retries independent of fallback advancement
 * - scoped selection reset/isolation
 * - absolute total deadline across dispatch + backoff, even when the callee ignores it
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
	getScopedModelSelectionSnapshot,
	resetScopedModelSelectionStateForTests,
} from '../../../src/models/model-override-state';
import {
	_internals,
	dispatchWithModelFallback,
	ModelDispatchTimeoutError,
	parseModelString,
} from '../../../src/utils/model-dispatch-fallback';
import { withFrozenClock } from '../../helpers/test-clock.js';

const noWait = async () => {};

afterEach(() => {
	resetScopedModelSelectionStateForTests();
});

describe('parseModelString', () => {
	it('splits a provider/model string', () => {
		expect(parseModelString('anthropic/claude-x')).toEqual({
			providerID: 'anthropic',
			modelID: 'claude-x',
		});
	});

	it('returns undefined for empty/blank', () => {
		expect(parseModelString('')).toBeUndefined();
		expect(parseModelString('   ')).toBeUndefined();
	});

	it('throws on malformed values', () => {
		expect(() => parseModelString('noSlash')).toThrow();
		expect(() => parseModelString('provider/')).toThrow();
		expect(() => parseModelString('/model')).toThrow();
	});

	it('keeps extra slashes in the model segment', () => {
		expect(parseModelString('openrouter/vendor/model')).toEqual({
			providerID: 'openrouter',
			modelID: 'vendor/model',
		});
	});
});

describe('dispatchWithModelFallback', () => {
	const alwaysTransient = () => 'transient' as const;

	it('uses the primary model when it succeeds (no fallback consulted)', async () => {
		let resolveCalls = 0;
		const out = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				expect(model).toBeUndefined();
				return 'ok';
			},
			resolveFallback: () => {
				resolveCalls++;
				return null;
			},
			classify: alwaysTransient,
			sleep: noWait,
		});
		expect(out.result).toBe('ok');
		expect(out.fallbackIndex).toBe(0);
		expect(out.modelUsed).toBeUndefined();
		expect(resolveCalls).toBe(0);
	});

	it('advances to the first fallback on a transient primary failure', async () => {
		const seen: (string | undefined)[] = [];
		const out = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				seen.push(model ? `${model.providerID}/${model.modelID}` : undefined);
				if (model === undefined) throw new Error('429 rate limit');
				return 'recovered';
			},
			resolveFallback: (i) => (i === 1 ? 'prov/fb1' : null),
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 0,
			sleep: noWait,
		});
		expect(out.result).toBe('recovered');
		expect(out.fallbackIndex).toBe(1);
		expect(out.modelUsed).toBe('prov/fb1');
		expect(seen).toEqual([undefined, 'prov/fb1']);
	});

	it('throws immediately on a permanent error — no retry, no fallback', async () => {
		let dispatches = 0;
		await expect(
			dispatchWithModelFallback<string>({
				dispatch: async () => {
					dispatches++;
					throw new Error('401 unauthorized');
				},
				resolveFallback: () => 'prov/fb1',
				classify: () => 'permanent',
				sleep: noWait,
			}),
		).rejects.toThrow('401 unauthorized');
		expect(dispatches).toBe(1);
	});

	it('does bounded same-model retries before advancing', async () => {
		const attemptsPerModel: Record<string, number> = {};
		const out = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				const key = model ? `${model.providerID}/${model.modelID}` : 'primary';
				attemptsPerModel[key] = (attemptsPerModel[key] ?? 0) + 1;
				if (key === 'primary') throw new Error('503 unavailable');
				return 'ok-on-fallback';
			},
			resolveFallback: (i) => (i === 1 ? 'prov/fb1' : null),
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 2,
			sleep: noWait,
		});
		expect(attemptsPerModel.primary).toBe(3);
		expect(attemptsPerModel['prov/fb1']).toBe(1);
		expect(out.fallbackIndex).toBe(1);
	});

	it('skips malformed fallback entries and tries the next', async () => {
		const out = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				if (model === undefined) throw new Error('timeout');
				return `used:${model.providerID}/${model.modelID}`;
			},
			resolveFallback: (i) =>
				i === 1 ? 'malformed-no-slash' : i === 2 ? 'prov/fb2' : null,
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 0,
			sleep: noWait,
		});
		expect(out.result).toBe('used:prov/fb2');
		expect(out.fallbackIndex).toBe(2);
	});

	it('keeps scoped model selection isolated per session/invocation/role and resets on success', async () => {
		const scope = {
			sessionID: 'sess-1',
			invocationID: 'inv-1',
			role: 'critic',
			swarmID: 'swarm-a',
		} as const;
		const seen: (string | undefined)[] = [];

		const first = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				seen.push(model ? `${model.providerID}/${model.modelID}` : undefined);
				if (seen.length === 1) throw new Error('429 rate limit');
				return 'ok';
			},
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 0,
			scope,
			primaryModel: 'prov/primary',
			fallbackModels: ['prov/fb1'],
			sleep: noWait,
		});

		expect(first.fallbackIndex).toBe(1);
		expect(first.modelUsed).toBe('prov/fb1');
		expect(getScopedModelSelectionSnapshot()).toEqual([]);

		const second = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				expect(model).toEqual({
					providerID: 'prov',
					modelID: 'primary',
				});
				return 'fresh-primary';
			},
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 0,
			scope,
			primaryModel: 'prov/primary',
			fallbackModels: ['prov/fb1'],
			sleep: noWait,
		});

		expect(second.result).toBe('fresh-primary');
		expect(second.fallbackIndex).toBe(0);
	});

	it('throws a recognizable timeout error when dispatch ignores the deadline', async () =>
		withFrozenClock(
			async () => {
				const originalSetTimeout = _internals.setTimeout;
				const originalClearTimeout = _internals.clearTimeout;
				try {
					_internals.setTimeout = ((callback: () => void, _ms: number) => {
						const token = { unref() {} };
						queueMicrotask(callback);
						return token;
					}) as typeof setTimeout;
					_internals.clearTimeout = (() => undefined) as typeof clearTimeout;
					await expect(
						dispatchWithModelFallback<string>({
							dispatch: async () => await new Promise<never>(() => {}),
							classify: alwaysTransient,
							deadlineAtMs: Date.now() + 20,
							maxTransientRetriesPerModel: 0,
						}),
					).rejects.toBeInstanceOf(ModelDispatchTimeoutError);
					await expect(
						dispatchWithModelFallback<string>({
							dispatch: async () => await new Promise<never>(() => {}),
							classify: alwaysTransient,
							deadlineAtMs: Date.now() + 20,
							maxTransientRetriesPerModel: 0,
						}),
					).rejects.toHaveProperty('name', 'TimeoutError');
				} finally {
					_internals.setTimeout = originalSetTimeout;
					_internals.clearTimeout = originalClearTimeout;
				}
			},
			{ tickMs: 5 },
		));

	it('clamps retry backoff to the remaining total deadline', async () =>
		withFrozenClock(
			async () => {
				let nowMs = 0;
				const slept: number[] = [];
				await expect(
					dispatchWithModelFallback<string>({
						dispatch: async () => {
							nowMs += 3;
							throw new Error('503 unavailable');
						},
						classify: alwaysTransient,
						maxTransientRetriesPerModel: 2,
						backoffMs: () => 50,
						deadlineAtMs: 10,
						now: () => nowMs,
						sleep: async (ms) => {
							slept.push(ms);
							nowMs += ms;
						},
					}),
				).rejects.toBeInstanceOf(ModelDispatchTimeoutError);
				expect(slept).toEqual([7]);
			},
			{ tickMs: 1 },
		));

	it('clears outer timeout timers on success and timeout', async () =>
		withFrozenClock(
			async () => {
				const originalSetTimeout = _internals.setTimeout;
				const originalClearTimeout = _internals.clearTimeout;
				const cleared: unknown[] = [];
				let nextTimer = 0;
				try {
					_internals.setTimeout = ((callback: () => void, ms: number) => {
						const token = { id: ++nextTimer, unref() {} };
						if (ms <= 1) {
							queueMicrotask(callback);
						}
						return token;
					}) as typeof setTimeout;
					_internals.clearTimeout = ((timer: unknown) => {
						cleared.push(timer);
					}) as typeof clearTimeout;

					await expect(
						dispatchWithModelFallback<string>({
							dispatch: async () => 'ok',
							classify: alwaysTransient,
							deadlineAtMs: Date.now() + 50,
						}),
					).resolves.toMatchObject({ result: 'ok' });

					await expect(
						dispatchWithModelFallback<string>({
							dispatch: async () => await new Promise<never>(() => {}),
							classify: alwaysTransient,
							deadlineAtMs: Date.now() + 1,
							maxTransientRetriesPerModel: 0,
						}),
					).rejects.toBeInstanceOf(ModelDispatchTimeoutError);

					expect(cleared.length).toBeGreaterThanOrEqual(2);
				} finally {
					_internals.setTimeout = originalSetTimeout;
					_internals.clearTimeout = originalClearTimeout;
				}
			},
			{ tickMs: 1 },
		));
});
