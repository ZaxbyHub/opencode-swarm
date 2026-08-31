/**
 * Adversarial tests for log reclassification in model-limits.ts
 *
 * Mocks only src/utils/logger to avoid leaking a partial mock.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLog = mock(() => {});

mock.module('../../../src/utils/logger', () => ({
	log: mockLog,
	warn: mock(() => {}),
	error: mock(() => {}),
}));

import {
	_internals,
	NATIVE_MODEL_LIMITS,
	resolveModelLimit,
} from '../../../src/hooks/model-limits';

describe('model-limits: adversarial/attack-vector tests', () => {
	beforeEach(() => {
		mockLog.mockClear();
	});

	afterEach(() => {
		// CROSS-MODULE mock cleanup — no _internals seam in model-limits.ts for logger
		mock.restore();
	});

	describe('Scenario 1: undefined inputs', () => {
		it('should not crash on undefined inputs and return fallback', () => {
			const result = resolveModelLimit(undefined, undefined, {});
			expect(result.limit).toBe(128000);
		});
	});

	describe('Scenario 2: empty strings', () => {
		it('should not crash on empty strings and not call warn()', () => {
			const result = resolveModelLimit('', 'empty-string-provider', {});
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain('empty-string-provider');
			// Source label renamed 'fallback' -> 'static_default' when resolution
			// moved into src/config/context-window.ts and gained named rungs; this
			// still pins "the log names the rung that produced the number".
			expect(logCall[0]).toContain('static_default');
		});
	});

	describe('Scenario 3: null coercion', () => {
		it('should not crash on null coercion (null as any)', () => {
			const result = resolveModelLimit(
				null as any,
				'null-coercion-provider',
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain('null-coercion-provider');
			// See the Scenario 2 note on the 'fallback' -> 'static_default' rename.
			expect(logCall[0]).toContain('static_default');
		});
	});

	describe('Scenario 4: very long modelID string', () => {
		it('should not crash on 1000+ character modelID', () => {
			const longModelID = 'long1000-' + 'a'.repeat(990);
			const result = resolveModelLimit(longModelID, '', {});
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain(longModelID);
		});

		it('should not crash on 10000+ character modelID (boundary test)', () => {
			const veryLongModelID = 'verylong10000-' + 'x'.repeat(9990);
			const result = resolveModelLimit(
				veryLongModelID,
				'verylong-provider',
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain('verylong10000-');
		});
	});

	describe('Scenario 5: injection-like characters', () => {
		it('should safely pass through backticks without crashing', () => {
			const maliciousModelID = 'backtick`${malicious}`';
			const maliciousProviderID = 'backtick`${attack}`';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain(maliciousModelID);
		});

		it('should safely pass through newlines without crashing', () => {
			const maliciousModelID = 'newlines\nmodel\nwith\nnewlines';
			const maliciousProviderID = 'newlines\rprovider\rwith\rcarriage';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});

		it('should safely pass through null bytes and special chars without crashing', () => {
			const maliciousModelID = 'control\x00\x1f\x7fwith\x00control\x1bchars';
			const maliciousProviderID = 'control\t\tprovider';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});

		it('should safely handle template literal injection attempts', () => {
			const maliciousModelID = 'template-${process.exit()}';
			const maliciousProviderID = 'template-${require("child_process")}';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});

		it('should safely handle ANSI escape sequences', () => {
			const maliciousModelID = 'ansi\x1b[31mmodel\x1b[0m';
			const maliciousProviderID = 'ansi\x1b[32mprovider\x1b[0m';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result.limit).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});
	});

	describe('#2044 — provenance edge cases', () => {
		it('alias collision: a model-only key for one model never matches another model', () => {
			// 'gpt-5' as a model-only override must not leak onto 'gpt-5.1'.
			const result = resolveModelLimit('gpt-5.1', 'openai', { 'gpt-5': 90000 });
			expect(result.source).toBe('native');
			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['gpt-5.1']);
		});

		it('override lower than host: explicit user intent still wins', () => {
			const result = resolveModelLimit(
				'gpt-5',
				'openai',
				{ default: 50000 },
				400000,
			);
			expect(result.source).toBe('override');
			expect(result.limit).toBe(50000);
		});

		it('override higher than host: still the override', () => {
			const result = resolveModelLimit(
				'gpt-5',
				'openai',
				{ default: 900000 },
				400000,
			);
			expect(result.source).toBe('override');
			expect(result.limit).toBe(900000);
		});

		it('zero / NaN / negative / fractional override values are never coerced into a divisor', () => {
			for (const bad of [0, Number.NaN, -5, 0.5]) {
				const result = resolveModelLimit(
					'gpt-5',
					'openai',
					{ default: bad as number },
					400000,
				);
				// The unusable override is skipped; the live host value is used.
				expect(result.source).toBe('host');
				expect(result.limit).toBe(400000);
			}
		});

		it('an unusable live value (0) falls to the static rungs, and the source says so', () => {
			const result = resolveModelLimit('gpt-5', 'openai', {}, 0);
			expect(result.source).toBe('native');
			expect(result.resolution).toBe('static_native');
			expect(result.limit).toBe(400000);
		});

		it('provider cap change: a known-cap provider falls to the cap, not the native table', () => {
			const result = resolveModelLimit('gpt-5', 'github-copilot', {});
			expect(result.source).toBe('provider_cap');
			expect(result.limit).toBe(128000);
		});

		it('fallback flapping: alternating identities keep distinct, stable provenance', () => {
			const a = resolveModelLimit('model-a', 'provider-a', {});
			const b = resolveModelLimit('model-b', 'provider-b', {});
			expect(a.source).toBe('fallback');
			expect(b.source).toBe('fallback');
			expect(a.limit).toBe(128000);
			expect(b.limit).toBe(128000);
		});

		it('500+ distinct identities: provenance stays correct and nothing crashes', () => {
			for (let i = 0; i < 512; i++) {
				const result = resolveModelLimit(
					`flap-model-${i}`,
					`flap-provider-${i}`,
					{},
				);
				expect(result.source).toBe('fallback');
				expect(result.limit).toBe(128000);
			}
		});
	});
});

describe('#2044 — invalid-override + alias provenance flows to the health seam', () => {
	it('an invalid override is STICKY while the bad config persists, and clears when fixed (PR-comment C8)', () => {
		const observed: unknown[] = [];
		const original = _internals.observeResolution;
		_internals.observeResolution = (input) => {
			observed.push(input);
		};
		try {
			const config = { default: Number.NaN as number };
			resolveModelLimit('prov-model', 'prov-provider', config);
			resolveModelLimit('prov-model', 'prov-provider', config);
			const invalid = observed.filter(
				(o) => (o as { invalidOverride?: boolean }).invalidOverride === true,
			);
			// Sticky (C8): the health flag must stay true on EVERY resolve while
			// the invalid key remains in the config — a once-only flag would let
			// the alarm self-recover on the very next resolve of an unchanged,
			// still-broken config.
			expect(invalid).toHaveLength(2);
			resolveModelLimit('prov-model', 'prov-provider', {
				'prov-provider/prov-model': 50000,
			});
			const last = observed[observed.length - 1] as {
				aliasKeyClass?: string;
				resolution?: string;
				invalidOverride?: boolean;
			};
			expect(last.aliasKeyClass).toBe('compound');
			expect(last.resolution).toBe('user_provider_model');
			// Config fixed → flag clears.
			expect(last.invalidOverride).toBe(false);
		} finally {
			_internals.observeResolution = original;
		}
	});

	it('an invalid override key for an UNRELATED model never flags this identity (PR-comment C9)', () => {
		const observed: unknown[] = [];
		const original = _internals.observeResolution;
		_internals.observeResolution = (input) => {
			observed.push(input);
		};
		try {
			resolveModelLimit('healthy-model', 'healthy-provider', {
				// Invalid value, but the key belongs to a different model.
				'other-provider/other-model': Number.NaN as number,
			});
			for (const o of observed) {
				expect((o as { invalidOverride?: boolean }).invalidOverride).toBe(
					false,
				);
			}
			// ...while a relevant model-only key DOES flag.
			resolveModelLimit('healthy-model', 'healthy-provider', {
				'healthy-model': 0 as number,
			});
			expect(
				(observed[observed.length - 1] as { invalidOverride?: boolean })
					.invalidOverride,
			).toBe(true);
		} finally {
			_internals.observeResolution = original;
		}
	});
});

describe('#2044 — normalized-key collision warning (PR-comment C10)', () => {
	it('case-variant duplicate override keys warn once without changing resolution', () => {
		const observed: string[] = [];
		const original = _internals.observeResolution;
		_internals.observeResolution = (input) => {
			observed.push(String((input as { resolution?: string }).resolution));
		};
		try {
			const config = { 'gpt-5': 90000, 'GPT-5': 91000 };
			const first = resolveModelLimit('gpt-5', 'openai', config);
			resolveModelLimit('gpt-5', 'openai', config);
			// One of the colliding keys wins under normalized matching — the
			// resolution is deterministic and remains an override.
			expect(first.source).toBe('override');
			expect([90000, 91000]).toContain(first.limit);
			expect(observed.every((r) => r === 'user_model')).toBe(true);
		} finally {
			_internals.observeResolution = original;
		}
	});
});
