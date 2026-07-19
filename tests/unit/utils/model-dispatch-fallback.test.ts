/**
 * Issue #1896 (sub-issue 3): the shared model-fallback dispatch helper used by
 * the critic/reviewer/lane dispatch stages. Verifies the primary→fallback advance
 * on transient errors, immediate throw on permanent errors (no failover), bounded
 * same-model retry (independent of the fallback advance, per invariant #9), and
 * exhaustion behavior. All timing is injected so tests never really wait.
 */

import { describe, expect, it } from 'bun:test';
import {
	dispatchWithModelFallback,
	parseModelString,
} from '../../../src/utils/model-dispatch-fallback';

const noWait = async () => {};

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
				expect(model).toBeUndefined(); // primary = registered model
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
		const fallbacks: Record<number, string> = { 1: 'prov/fb1' };
		const onFallback: { toModel: string; fallbackIndex: number }[] = [];
		const out = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				seen.push(model ? `${model.providerID}/${model.modelID}` : undefined);
				if (model === undefined) throw new Error('429 rate limit');
				return 'recovered';
			},
			resolveFallback: (i) => fallbacks[i] ?? null,
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 0, // advance immediately on transient
			onFallback: (info) => onFallback.push(info),
			sleep: noWait,
		});
		expect(out.result).toBe('recovered');
		expect(out.fallbackIndex).toBe(1);
		expect(out.modelUsed).toBe('prov/fb1');
		expect(seen).toEqual([undefined, 'prov/fb1']);
		expect(onFallback).toEqual([{ toModel: 'prov/fb1', fallbackIndex: 1 }]);
	});

	it('throws IMMEDIATELY on a permanent error — no retry, no fallback', async () => {
		let dispatches = 0;
		let resolveCalls = 0;
		await expect(
			dispatchWithModelFallback<string>({
				dispatch: async () => {
					dispatches++;
					throw new Error('401 unauthorized');
				},
				resolveFallback: () => {
					resolveCalls++;
					return 'prov/fb1';
				},
				classify: () => 'permanent',
				sleep: noWait,
			}),
		).rejects.toThrow('401 unauthorized');
		expect(dispatches).toBe(1);
		expect(resolveCalls).toBe(0);
	});

	it('does bounded same-model retries before advancing (independent of fallback)', async () => {
		const attemptsPerModel: Record<string, number> = {};
		const label = (m: { providerID: string; modelID: string } | undefined) =>
			m ? `${m.providerID}/${m.modelID}` : 'primary';
		const out = await dispatchWithModelFallback<string>({
			dispatch: async (model) => {
				const key = label(model);
				attemptsPerModel[key] = (attemptsPerModel[key] ?? 0) + 1;
				if (key === 'primary') throw new Error('503 unavailable');
				return 'ok-on-fallback';
			},
			resolveFallback: (i) => (i === 1 ? 'prov/fb1' : null),
			classify: alwaysTransient,
			maxTransientRetriesPerModel: 2, // 1 initial + 2 retries = 3 primary tries
			sleep: noWait,
		});
		expect(attemptsPerModel.primary).toBe(3);
		expect(attemptsPerModel['prov/fb1']).toBe(1);
		expect(out.fallbackIndex).toBe(1);
	});

	it('rethrows the last error when every model is exhausted transiently', async () => {
		await expect(
			dispatchWithModelFallback<string>({
				dispatch: async () => {
					throw new Error('529 overloaded');
				},
				resolveFallback: (i) => (i === 1 ? 'prov/fb1' : null),
				classify: alwaysTransient,
				maxTransientRetriesPerModel: 0,
				sleep: noWait,
			}),
		).rejects.toThrow('529 overloaded');
	});

	it('skips a malformed fallback config entry and tries the next', async () => {
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
});
