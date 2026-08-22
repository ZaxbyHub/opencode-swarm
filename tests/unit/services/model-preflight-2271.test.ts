/**
 * Agent model-resolution preflight — issue #2271 bug 4.
 *
 * The preflight validates configured agent model ids against the live
 * provider catalog via client.provider.list(). Every catalog failure is
 * FAIL-OPEN ('unknown'): the preflight only acts on a POSITIVE confirmation
 * that a model does not resolve.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { PluginConfig } from '../../../src/config';
import {
	_internals,
	checkSingleModelResolution,
	collectConfiguredAgentModels,
	fetchProviderCatalog,
	invalidateProviderCatalogCache,
	resolveAgainstCatalog,
	runModelPreflight,
	splitModelId,
} from '../../../src/services/model-preflight';

interface FakeProvider {
	id: string;
	models: Record<string, { id: string }>;
}

function fakeClient(
	providers: FakeProvider[],
	options?: { fail?: boolean },
): OpencodeClient {
	return {
		provider: {
			list: async () => {
				if (options?.fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: providers.map((provider) => ({
							id: provider.id,
							name: provider.id,
							models: provider.models,
						})),
					},
				};
			},
		},
	} as unknown as OpencodeClient;
}

const CATALOG: FakeProvider[] = [
	{
		id: 'opencode',
		models: {
			// The complete set referenced by DEFAULT_MODELS so a healthy
			// default-only config resolves 'ok'.
			'big-pickle': { id: 'big-pickle' },
			'minimax-m2.5-free': { id: 'minimax-m2.5-free' },
			'gpt-5-nano': { id: 'gpt-5-nano' },
		},
	},
	{ id: 'anthropic', models: { 'claude-x': { id: 'claude-x' } } },
];

describe('issue #2271 bug 4 — agent model-resolution preflight', () => {
	beforeEach(() => {
		// The catalog TTL cache is module state; reset it so each test fetches.
		invalidateProviderCatalogCache();
	});

	afterEach(() => {
		invalidateProviderCatalogCache();
	});

	test('splitModelId splits provider/model and rejects degenerate ids', () => {
		expect(splitModelId('opencode/big-pickle')).toEqual({
			provider: 'opencode',
			model: 'big-pickle',
		});
		expect(splitModelId('bare-model')).toBeNull();
		expect(splitModelId('/leading')).toBeNull();
		expect(splitModelId('trailing/')).toBeNull();
	});

	test('collectConfiguredAgentModels includes defaults, overrides, and fallbacks', () => {
		const config = {
			agents: {
				critic: { model: 'opencode/nonexistent-model' },
				coder: {
					model: 'opencode/minimax-m2.5-free',
					fallback_models: ['anthropic/claude-x'],
				},
			},
		} as unknown as PluginConfig;
		const collected = collectConfiguredAgentModels(config);
		const byKey = new Map(
			collected.map((entry) => [`${entry.agent}:${entry.model}`, entry]),
		);
		// Override replaces the critic default.
		expect(byKey.get('critic:opencode/nonexistent-model')?.source).toBe(
			'override',
		);
		expect(byKey.has('critic:opencode/big-pickle')).toBe(false);
		// Fallbacks collected alongside the override.
		expect(byKey.get('coder:anthropic/claude-x')?.source).toBe('fallback');
		// Non-overridden defaults survive.
		expect(byKey.get('reviewer:opencode/big-pickle')?.source).toBe('default');
	});

	test('resolveAgainstCatalog marks missing provider and missing model unresolved', () => {
		const models = [
			{
				agent: 'critic',
				model: 'opencode/big-pickle',
				source: 'default' as const,
			},
			{ agent: 'critic', model: 'opencode/nope', source: 'override' as const },
			{
				agent: 'coder',
				model: 'missing-provider/model-x',
				source: 'override' as const,
			},
			{ agent: 'sme', model: 'bare-model', source: 'override' as const },
		];
		const catalog = new Map(
			CATALOG.map((provider) => [
				provider.id,
				new Set(Object.keys(provider.models)),
			]),
		);
		const result = resolveAgainstCatalog(models, catalog);
		expect(result.catalogAvailable).toBe(true);
		expect(result.resolutions[0]?.status).toBe('ok');
		expect(result.resolutions[1]?.status).toBe('unresolved');
		expect(result.resolutions[1]?.detail).toContain(
			'does not list model "nope"',
		);
		expect(result.resolutions[2]?.status).toBe('unresolved');
		expect(result.resolutions[2]?.detail).toContain(
			'provider "missing-provider" is not present',
		);
		// No provider prefix → cannot validate → unknown (fail-open).
		expect(result.resolutions[3]?.status).toBe('unknown');
	});

	test('null catalog fails open: everything unknown, nothing unresolved', async () => {
		const result = await runModelPreflight(undefined, null);
		expect(result.catalogAvailable).toBe(false);
		expect(result.resolutions.length).toBeGreaterThan(0);
		expect(
			result.resolutions.every((entry) => entry.status === 'unknown'),
		).toBe(true);
	});

	test('catalog fetch error fails open', async () => {
		const client = fakeClient([], { fail: true });
		expect(await fetchProviderCatalog(client)).toBeNull();
		expect(await checkSingleModelResolution('opencode/nope', client)).toBe(
			'unknown',
		);
	});

	test('checkSingleModelResolution: positive miss on healthy catalog', async () => {
		const client = fakeClient(CATALOG);
		expect(
			await checkSingleModelResolution('opencode/big-pickle', client),
		).toBe('ok');
		expect(
			await checkSingleModelResolution(
				'opencode/deepseek-v4-flash-free',
				client,
			),
		).toBe('unresolved');
	});

	test('providerList seam timeout rejects instead of hanging (bounded catalog call)', async () => {
		const hangingClient = {
			provider: {
				list: () => new Promise(() => {}),
			},
		} as unknown as OpencodeClient;
		// fetchProviderCatalog catches seam errors and fails open.
		const catalog = await fetchProviderCatalog(hangingClient);
		expect(catalog).toBeNull();
	});

	test('runModelPreflight end-to-end on a healthy catalog finds the broken override', async () => {
		const config = {
			agents: { critic: { model: 'opencode/nemotron-3-ultra-free' } },
		} as unknown as PluginConfig;
		const result = await runModelPreflight(config, fakeClient(CATALOG));
		expect(result.catalogAvailable).toBe(true);
		const unresolved = result.resolutions.filter(
			(entry) => entry.status === 'unresolved',
		);
		expect(unresolved.length).toBe(1);
		expect(unresolved[0]?.model).toBe('opencode/nemotron-3-ultra-free');
	});

	test('seam override is used by fetchProviderCatalog (DI contract)', async () => {
		const original = _internals.providerList;
		let called = false;
		_internals.providerList = async (client) => {
			called = true;
			return client.provider.list();
		};
		try {
			await fetchProviderCatalog(fakeClient(CATALOG));
			expect(called).toBe(true);
		} finally {
			_internals.providerList = original;
		}
	});

	test('catalog cache serves repeat lookups within the TTL and invalidates on demand', async () => {
		let calls = 0;
		const countingClient = {
			provider: {
				list: async () => {
					calls++;
					return fakeClient(CATALOG).provider.list();
				},
			},
		} as unknown as OpencodeClient;
		await fetchProviderCatalog(countingClient);
		await fetchProviderCatalog(countingClient);
		expect(calls).toBe(1);
		invalidateProviderCatalogCache();
		await fetchProviderCatalog(countingClient);
		expect(calls).toBe(2);
	});
});
