import { afterEach, describe, expect, test } from 'bun:test';
import {
	advanceScopedModelSelection,
	clearScopedModelSelectionsForSession,
	getScopedModelSelectionSnapshot,
	normalizeModelChain,
	resetScopedModelSelection,
	resetScopedModelSelectionStateForTests,
	resolveScopedModelSelection,
} from '../../../src/models/model-override-state';

afterEach(() => {
	resetScopedModelSelectionStateForTests();
});

describe('model override state', () => {
	test('normalizes, validates, and deduplicates the model chain', () => {
		const chain = normalizeModelChain('prov/primary', [
			'prov/primary',
			'bad',
			'prov/fb1',
			'prov/fb1',
			'prov/fb2',
		]);

		expect(chain.primary?.modelString).toBe('prov/primary');
		expect(chain.fallbacks.map((entry) => entry.modelString)).toEqual([
			'prov/fb1',
			'prov/fb2',
		]);
		expect(chain.totalModels).toBe(3);
	});

	test('advances by exact generation and fails closed on stale generations', () => {
		const scope = {
			sessionID: 'sess-1',
			invocationID: 'inv-1',
			role: 'critic',
			swarmID: 'swarm-a',
		} as const;
		const chain = normalizeModelChain('prov/primary', ['prov/fb1']);
		const primary = resolveScopedModelSelection(scope, chain, 1);
		expect(primary.fallbackIndex).toBe(0);

		const advanced = advanceScopedModelSelection(
			scope,
			chain,
			primary.generation,
			2,
		);
		expect(advanced.accepted).toBe(true);
		expect(advanced.selection.fallbackIndex).toBe(1);
		expect(advanced.selection.modelString).toBe('prov/fb1');

		const changedChain = normalizeModelChain('prov/primary', ['prov/fb2']);
		const refreshed = resolveScopedModelSelection(scope, changedChain, 3);
		const staleAdvance = advanceScopedModelSelection(
			scope,
			chain,
			primary.generation,
			3,
		);
		expect(staleAdvance.accepted).toBe(false);
		expect(refreshed.generation).toBeGreaterThan(primary.generation);
		expect(staleAdvance.selection.fallbackIndex).toBe(0);
	});

	test('resets only the exact generation', () => {
		const scope = {
			sessionID: 'sess-1',
			invocationID: 'inv-1',
			role: 'critic',
		} as const;
		const chain = normalizeModelChain('prov/primary', ['prov/fb1']);
		const selection = resolveScopedModelSelection(scope, chain, 1);
		expect(resetScopedModelSelection(scope, selection.generation + 1)).toBe(
			false,
		);
		expect(resetScopedModelSelection(scope, selection.generation)).toBe(true);
		expect(getScopedModelSelectionSnapshot()).toEqual([]);
	});

	test('keeps session-scoped state isolated and clears one session only', () => {
		const chain = normalizeModelChain('prov/primary', ['prov/fb1']);
		resolveScopedModelSelection(
			{ sessionID: 'sess-a', invocationID: 'inv', role: 'critic' },
			chain,
			1,
		);
		resolveScopedModelSelection(
			{ sessionID: 'sess-b', invocationID: 'inv', role: 'critic' },
			chain,
			1,
		);

		clearScopedModelSelectionsForSession('sess-a');

		expect(
			getScopedModelSelectionSnapshot().map((entry) => entry.key.sessionID),
		).toEqual(['sess-b']);
	});
});
