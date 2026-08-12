/**
 * The single context-window derivation (`src/config/context-window.ts`).
 *
 * The budget denominator used to be a hardcoded 128000. These tests pin the
 * replacement contract: the denominator is DERIVED, the live
 * `model.limit.context` beats the hand-maintained static table, explicit user
 * config beats the live value, and no untrusted input can produce a divisor
 * that yields NaN/Infinity.
 *
 * Real-world numbers are used deliberately (200k / 1M / a Copilot entry /
 * `limit.context: 0`), because the whole point of the change is that a
 * hardcoded number is wrong for real models. The Copilot figures come from the
 * host's on-disk model catalog, which lists `github-copilot`'s
 * `claude-sonnet-4.5` at 200000 while `anthropic`'s `claude-sonnet-4-5` is
 * 1000000 — i.e. per-provider caps are already baked into `limit.context`.
 */
import { describe, expect, test } from 'bun:test';
import {
	isUsableConfiguredWindow,
	isUsableContextWindow,
	MIN_PLAUSIBLE_CONTEXT_TOKENS,
	readModelContextLimit,
	readModelIdentity,
	resolveContextWindow,
	resolveContextWindowTokens,
} from '../../../src/config/context-window';
import { DEFAULT_MODEL_CONTEXT_TOKENS } from '../../../src/config/schema';
import { lookupStaticModelLimit } from '../../../src/hooks/model-limits';

/** A `Model` as the host hands it to experimental.chat.system.transform. */
function modelOf(
	id: string,
	providerID: string,
	context: unknown,
): Record<string, unknown> {
	return { id, providerID, limit: { context, output: 32000 } };
}

describe('readModelContextLimit / readModelIdentity — host-boundary reads', () => {
	test('reads limit.context and identity off a well-formed Model', () => {
		const model = modelOf('claude-sonnet-4.5', 'github-copilot', 200000);
		expect(readModelContextLimit(model)).toBe(200000);
		expect(readModelIdentity(model, 'id')).toBe('claude-sonnet-4.5');
		expect(readModelIdentity(model, 'providerID')).toBe('github-copilot');
	});

	test('returns undefined instead of throwing for every malformed shape', () => {
		// The plugin .d.ts declares `model: Model` (non-optional), but a throw in
		// system.transform kills ALL system enhancement for the turn, so the read
		// never trusts the declared shape.
		for (const bad of [undefined, null, 42, 'model', [], {}, { limit: null }]) {
			expect(readModelContextLimit(bad)).toBeUndefined();
			expect(readModelIdentity(bad, 'id')).toBeUndefined();
		}
		expect(readModelContextLimit({ limit: {} })).toBeUndefined();
	});

	test('normalises an empty identity to undefined', () => {
		// An empty string would build the lookup key "/" and match a config entry
		// no user ever wrote.
		const model = { id: '', providerID: '', limit: { context: 200000 } };
		expect(readModelIdentity(model, 'id')).toBeUndefined();
		expect(readModelIdentity(model, 'providerID')).toBeUndefined();
	});
});

describe('isUsableContextWindow — untrusted (live catalog / static table)', () => {
	test('accepts plausible windows', () => {
		expect(isUsableContextWindow(MIN_PLAUSIBLE_CONTEXT_TOKENS)).toBe(true);
		expect(isUsableContextWindow(128000)).toBe(true);
		expect(isUsableContextWindow(1_000_000)).toBe(true);
	});

	test('rejects every shape that breaks the percentage arithmetic', () => {
		// `limit.context: 0` is not hypothetical — 124 of 6244 entries in the
		// host's model catalog ship it. 1300 / 0 * 100 === Infinity, which would
		// fire the EMERGENCY compaction tier on turn one.
		for (const bad of [
			0,
			-1,
			-200000,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			undefined,
			null,
			'200000',
			{},
			[],
		]) {
			expect(isUsableContextWindow(bad)).toBe(false);
		}
	});

	test('rejects an implausibly small window', () => {
		expect(isUsableContextWindow(MIN_PLAUSIBLE_CONTEXT_TOKENS - 1)).toBe(false);
	});
});

describe('isUsableConfiguredWindow — user-authored config', () => {
	test('honours any positive finite value, including below the plausibility floor', () => {
		// Deliberately weaker than isUsableContextWindow. ContextBudgetConfigSchema
		// already enforces z.number().min(1000) on model_limits, so a smaller value
		// cannot reach here via a parsed config — and silently DISCARDING a number
		// a user explicitly wrote would be worse than honouring it.
		expect(isUsableConfiguredWindow(100)).toBe(true);
		expect(isUsableConfiguredWindow(60000)).toBe(true);
	});

	test('still rejects the arithmetic-breaking set', () => {
		for (const bad of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			undefined,
			null,
			'100',
		]) {
			expect(isUsableConfiguredWindow(bad)).toBe(false);
		}
	});

	// #1619 review round 4. The bar used to be `> 0`, and `resolveContextWindow`
	// floors whatever this admits — so a fractional value in (0, 1) passed the
	// guard and floored to a ZERO denominator, i.e. `Infinity %` and a
	// turn-one EMERGENCY compaction directive: exactly the failure this guard
	// exists to prevent.
	test('rejects fractional values below 1, which would floor to a zero denominator', () => {
		for (const bad of [0.5, 0.999, Number.MIN_VALUE]) {
			expect(
				isUsableConfiguredWindow(bad),
				`${bad} floors to ${Math.floor(bad as number)}`,
			).toBe(false);
		}
		// 1 is the smallest value that survives Math.floor as a usable divisor.
		expect(isUsableConfiguredWindow(1)).toBe(true);
	});

	test('resolveContextWindow never returns a zero denominator for a fractional user value', () => {
		const resolved = resolveContextWindow({ userLimits: { default: 0.5 } });
		expect(resolved.tokens).toBeGreaterThanOrEqual(1);
		// Falls through the user rung to the last-resort constant instead.
		expect(resolved).toEqual({
			tokens: DEFAULT_MODEL_CONTEXT_TOKENS,
			source: 'static_default',
		});
	});
});

describe('resolveContextWindow — resolution order', () => {
	test('a 1M-window model resolves to 1M, not the 128000 constant', () => {
		expect(
			resolveContextWindow({
				modelID: 'claude-sonnet-4-5',
				providerID: 'anthropic',
				liveContextLimit: 1_000_000,
				fallbackLookup: lookupStaticModelLimit,
			}),
		).toEqual({ tokens: 1_000_000, source: 'live_model_limit' });
	});

	test('a 200k-window model resolves to 200k', () => {
		expect(
			resolveContextWindow({
				modelID: 'gpt-5.2',
				providerID: 'openai',
				liveContextLimit: 200000,
				fallbackLookup: lookupStaticModelLimit,
			}),
		).toEqual({ tokens: 200000, source: 'live_model_limit' });
	});

	test('a provider-capped entry uses the cap the HOST reports, not the local table', () => {
		// This is the load-bearing case. PROVIDER_CAPS still claims Copilot caps
		// everything at 128000; the live catalog reports 200000 for this exact
		// provider/model pair. The live value must win outright — min-capping it
		// against the stale table would reintroduce the too-small denominator.
		const resolution = resolveContextWindow({
			modelID: 'claude-sonnet-4.5',
			providerID: 'github-copilot',
			liveContextLimit: 200000,
			fallbackLookup: lookupStaticModelLimit,
		});
		expect(resolution).toEqual({ tokens: 200000, source: 'live_model_limit' });
		expect(lookupStaticModelLimit('claude-sonnet-4.5', 'github-copilot')).toBe(
			128000,
		);
	});

	test('a genuinely 128k-capped provider entry still resolves to 128k', () => {
		// `gpt-4.1` on github-copilot IS 128000 in the live catalog. Same rung,
		// same mechanism — the number just happens to match the old constant.
		expect(
			resolveContextWindow({
				modelID: 'gpt-4.1',
				providerID: 'github-copilot',
				liveContextLimit: 128000,
				fallbackLookup: lookupStaticModelLimit,
			}),
		).toEqual({ tokens: 128000, source: 'live_model_limit' });
	});

	test('an explicit provider/model override beats the live value', () => {
		expect(
			resolveContextWindow({
				userLimits: { 'github-copilot/claude-sonnet-4.5': 60000 },
				modelID: 'claude-sonnet-4.5',
				providerID: 'github-copilot',
				liveContextLimit: 200000,
				fallbackLookup: lookupStaticModelLimit,
			}),
		).toEqual({ tokens: 60000, source: 'user_provider_model' });
	});

	test('an explicit model-only override beats the live value', () => {
		expect(
			resolveContextWindow({
				userLimits: { 'claude-sonnet-4.5': 60000 },
				modelID: 'claude-sonnet-4.5',
				providerID: 'github-copilot',
				liveContextLimit: 200000,
			}),
		).toEqual({ tokens: 60000, source: 'user_model' });
	});

	test('an explicit default beats the live value — the user wants a smaller working budget', () => {
		expect(
			resolveContextWindow({
				userLimits: { default: 50000 },
				modelID: 'claude-sonnet-4-5',
				providerID: 'anthropic',
				liveContextLimit: 1_000_000,
			}),
		).toEqual({ tokens: 50000, source: 'user_default' });
	});

	test('the more specific user key wins over the less specific one', () => {
		expect(
			resolveContextWindow({
				userLimits: {
					'anthropic/claude-sonnet-4-5': 30000,
					'claude-sonnet-4-5': 40000,
					default: 50000,
				},
				modelID: 'claude-sonnet-4-5',
				providerID: 'anthropic',
				liveContextLimit: 1_000_000,
			}).source,
		).toBe('user_provider_model');
		expect(
			resolveContextWindow({
				userLimits: { 'claude-sonnet-4-5': 40000, default: 50000 },
				modelID: 'claude-sonnet-4-5',
				providerID: 'anthropic',
			}).tokens,
		).toBe(40000);
	});

	test('falls back to the static table when NO model info is available', () => {
		expect(
			resolveContextWindow({
				modelID: 'claude-sonnet-4-6-20260301',
				providerID: 'anthropic',
				fallbackLookup: lookupStaticModelLimit,
			}),
		).toEqual({ tokens: 200000, source: 'static_table' });
	});

	test('falls back to the static default when nothing at all is known', () => {
		expect(resolveContextWindow({})).toEqual({
			tokens: DEFAULT_MODEL_CONTEXT_TOKENS,
			source: 'static_default',
		});
		expect(
			resolveContextWindow({
				modelID: 'some-model-nobody-has-heard-of',
				providerID: 'some-provider',
				fallbackLookup: lookupStaticModelLimit,
			}),
		).toEqual({
			tokens: DEFAULT_MODEL_CONTEXT_TOKENS,
			source: 'static_default',
		});
	});

	test('an empty model_limits record is treated as "no opinion"', () => {
		// This is what ContextBudgetConfigSchema now injects by default. It MUST
		// fall through to the live value; the old `{ default: 128000 }` schema
		// default would have shadowed it for every user with a context_budget
		// block.
		expect(
			resolveContextWindow({
				userLimits: {},
				modelID: 'claude-sonnet-4-5',
				providerID: 'anthropic',
				liveContextLimit: 1_000_000,
			}),
		).toEqual({ tokens: 1_000_000, source: 'live_model_limit' });
	});
});

describe('resolveContextWindow — adversarial live values never break arithmetic', () => {
	const SWARM_TOKENS = 1300;

	test.each([
		['zero (124 real catalog entries ship this)', 0],
		['negative', -200000],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['a numeric string', '200000'],
		['an object', { context: 200000 }],
		['null', null],
		['undefined', undefined],
		['below the plausibility floor', 1],
	])('a live limit of %s is skipped and the percentage stays finite', (_label, liveContextLimit) => {
		const tokens = resolveContextWindowTokens({
			modelID: 'unknown-model',
			providerID: 'unknown-provider',
			liveContextLimit,
		});
		expect(tokens).toBe(DEFAULT_MODEL_CONTEXT_TOKENS);

		const pct = (SWARM_TOKENS / tokens) * 100;
		expect(Number.isFinite(pct)).toBe(true);
		expect(Number.isNaN(pct)).toBe(false);
		expect(pct).toBeGreaterThan(0);
	});

	test('a missing limit object on the model degrades to the fallback rungs', () => {
		const tokens = resolveContextWindowTokens({
			modelID: 'claude-sonnet-4-6',
			providerID: 'anthropic',
			liveContextLimit: readModelContextLimit({ id: 'claude-sonnet-4-6' }),
			fallbackLookup: lookupStaticModelLimit,
		});
		expect(tokens).toBe(200000);
	});

	test('a malformed user override is skipped rather than used as a divisor', () => {
		const tokens = resolveContextWindowTokens({
			userLimits: {
				default: Number.NaN as number,
				'anthropic/claude-sonnet-4-5': 0,
			},
			modelID: 'claude-sonnet-4-5',
			providerID: 'anthropic',
			liveContextLimit: 1_000_000,
		});
		expect(tokens).toBe(1_000_000);
	});

	test('the resolved value is always a finite positive integer', () => {
		for (const live of [200000.7, 1_000_000, 0, Number.NaN, undefined]) {
			const tokens = resolveContextWindowTokens({ liveContextLimit: live });
			expect(Number.isInteger(tokens)).toBe(true);
			expect(tokens).toBeGreaterThan(0);
		}
	});
});
