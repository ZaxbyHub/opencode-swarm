import { describe, expect, test } from 'bun:test';
import {
	type MemoryConfig,
	MemoryConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';
import {
	DEFAULT_EMBEDDINGS_CONFIG,
	DEFAULT_MEMORY_CONFIG,
	DEFAULT_RETRIEVAL_CONFIG,
	resolveMemoryConfig,
} from '../../../src/memory/config';

describe('MemoryConfigSchema — embeddings + retrieval defaults (FR-002, FR-005, FR-007, FR-008, FR-009)', () => {
	// -----------------------------------------------------------------------
	// FR-002: embeddings.enabled MUST default to false (critical opt-in default)
	// -----------------------------------------------------------------------
	test('embeddings.enabled defaults to false (critical opt-in, FR-002)', () => {
		const parsed = MemoryConfigSchema.parse({});
		expect(parsed.embeddings.enabled).toBe(false);
	});

	// -----------------------------------------------------------------------
	// All embeddings fields have stated defaults
	// -----------------------------------------------------------------------
	test('embeddings fields have the stated defaults', () => {
		const parsed = MemoryConfigSchema.parse({});
		expect(parsed.embeddings).toEqual({
			enabled: false,
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
			version: undefined,
			cacheSize: 256,
		});
	});

	// -----------------------------------------------------------------------
	// FR-005 + FR-008: retrieval fields have stated defaults
	// -----------------------------------------------------------------------
	test('retrieval fields have the stated defaults', () => {
		const parsed = MemoryConfigSchema.parse({});
		expect(parsed.retrieval).toEqual({
			rrfK: 60,
			weights: {
				lexical: 0.5,
				dense: 0.4,
				metadata: 0.1,
			},
			rerank: {
				enabled: false,
			},
			latencyBudgetMs: 250,
		});
	});

	// -----------------------------------------------------------------------
	// Backward-compat: a config WITHOUT embeddings/retrieval blocks validates
	// (existing configs with just memory:{} are not broken)
	// -----------------------------------------------------------------------
	test('config WITHOUT embeddings/retrieval blocks validates — defaults apply', () => {
		const minimalConfig = {
			enabled: true,
			provider: 'sqlite',
		};
		const parsed = MemoryConfigSchema.parse(minimalConfig);
		// Defaults are filled in
		expect(parsed.embeddings.enabled).toBe(false);
		expect(parsed.embeddings.model).toBe('Xenova/all-MiniLM-L6-v2');
		expect(parsed.embeddings.dimension).toBe(384);
		expect(parsed.embeddings.cacheSize).toBe(256);
		expect(parsed.retrieval.rrfK).toBe(60);
		expect(parsed.retrieval.weights.lexical).toBe(0.5);
		expect(parsed.retrieval.weights.dense).toBe(0.4);
		expect(parsed.retrieval.weights.metadata).toBe(0.1);
		expect(parsed.retrieval.rerank.enabled).toBe(false);
		expect(parsed.retrieval.latencyBudgetMs).toBe(250);
	});

	// -----------------------------------------------------------------------
	// User-supplied embeddings/retrieval values are accepted
	// -----------------------------------------------------------------------
	test('config WITH embeddings/retrieval blocks validates — user values accepted', () => {
		const userConfig = {
			embeddings: {
				enabled: true,
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
				version: 'v1.0',
				cacheSize: 512,
			},
			retrieval: {
				rrfK: 30,
				weights: {
					lexical: 0.3,
					dense: 0.6,
					metadata: 0.1,
				},
				rerank: {
					enabled: true,
					model: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
				},
				latencyBudgetMs: 500,
			},
		};
		const parsed = MemoryConfigSchema.parse(userConfig);
		expect(parsed.embeddings.enabled).toBe(true);
		expect(parsed.embeddings.version).toBe('v1.0');
		expect(parsed.embeddings.cacheSize).toBe(512);
		expect(parsed.retrieval.rrfK).toBe(30);
		expect(parsed.retrieval.weights.lexical).toBe(0.3);
		expect(parsed.retrieval.weights.dense).toBe(0.6);
		expect(parsed.retrieval.rerank.enabled).toBe(true);
		expect(parsed.retrieval.rerank.model).toBe(
			'cross-encoder/ms-marco-MiniLM-L-6-v2',
		);
		expect(parsed.retrieval.latencyBudgetMs).toBe(500);
	});

	// -----------------------------------------------------------------------
	// Partial embeddings override — only specified fields change
	// -----------------------------------------------------------------------
	test('partial embeddings override merges correctly', () => {
		const parsed = MemoryConfigSchema.parse({
			embeddings: { enabled: true, cacheSize: 128 },
		});
		// Specified fields override, rest use defaults
		expect(parsed.embeddings.enabled).toBe(true);
		expect(parsed.embeddings.cacheSize).toBe(128);
		expect(parsed.embeddings.model).toBe('Xenova/all-MiniLM-L6-v2');
		expect(parsed.embeddings.dimension).toBe(384);
	});

	// -----------------------------------------------------------------------
	// Partial retrieval override — only specified fields change
	// -----------------------------------------------------------------------
	test('partial retrieval override merges correctly', () => {
		const parsed = MemoryConfigSchema.parse({
			retrieval: { rrfK: 120, latencyBudgetMs: 100 },
		});
		expect(parsed.retrieval.rrfK).toBe(120);
		expect(parsed.retrieval.latencyBudgetMs).toBe(100);
		// Weights still have their defaults
		expect(parsed.retrieval.weights.lexical).toBe(0.5);
		expect(parsed.retrieval.weights.dense).toBe(0.4);
		expect(parsed.retrieval.rerank.enabled).toBe(false);
	});
});

describe('resolveMemoryConfig — embeddings + retrieval merge correctness', () => {
	// -----------------------------------------------------------------------
	// resolveMemoryConfig merges embeddings user overrides over defaults
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig merges embeddings user overrides over defaults', () => {
		const resolved = resolveMemoryConfig({
			embeddings: { enabled: true, cacheSize: 512 },
		});
		expect(resolved.embeddings.enabled).toBe(true);
		expect(resolved.embeddings.cacheSize).toBe(512);
		// Unspecified fields fall back to DEFAULT_EMBEDDINGS_CONFIG
		expect(resolved.embeddings.model).toBe(DEFAULT_EMBEDDINGS_CONFIG.model);
		expect(resolved.embeddings.dimension).toBe(
			DEFAULT_EMBEDDINGS_CONFIG.dimension,
		);
	});

	// -----------------------------------------------------------------------
	// resolveMemoryConfig merges retrieval user overrides over defaults
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig merges retrieval user overrides over defaults', () => {
		const resolved = resolveMemoryConfig({
			retrieval: { rrfK: 30, latencyBudgetMs: 500 },
		});
		expect(resolved.retrieval.rrfK).toBe(30);
		expect(resolved.retrieval.latencyBudgetMs).toBe(500);
		// Unspecified fields fall back to DEFAULT_RETRIEVAL_CONFIG
		expect(resolved.retrieval.weights.lexical).toBe(
			DEFAULT_RETRIEVAL_CONFIG.weights.lexical,
		);
		expect(resolved.retrieval.weights.dense).toBe(
			DEFAULT_RETRIEVAL_CONFIG.weights.dense,
		);
		expect(resolved.retrieval.rerank.enabled).toBe(
			DEFAULT_RETRIEVAL_CONFIG.rerank.enabled,
		);
	});

	// -----------------------------------------------------------------------
	// resolveMemoryConfig with no input returns full DEFAULT_MEMORY_CONFIG
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig with no input returns full defaults', () => {
		const resolved = resolveMemoryConfig(undefined);
		expect(resolved.embeddings).toEqual(DEFAULT_MEMORY_CONFIG.embeddings);
		expect(resolved.retrieval).toEqual(DEFAULT_MEMORY_CONFIG.retrieval);
	});

	// -----------------------------------------------------------------------
	// resolveMemoryConfig with empty object returns full DEFAULT_MEMORY_CONFIG
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig with empty object returns full defaults', () => {
		const resolved = resolveMemoryConfig({});
		expect(resolved.embeddings).toEqual(DEFAULT_MEMORY_CONFIG.embeddings);
		expect(resolved.retrieval).toEqual(DEFAULT_MEMORY_CONFIG.retrieval);
	});

	// -----------------------------------------------------------------------
	// resolveMemoryConfig preserves non-embeddings/retrieval defaults
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig preserves all other DEFAULT_MEMORY_CONFIG fields', () => {
		const resolved = resolveMemoryConfig({ enabled: true });
		expect(resolved.enabled).toBe(true);
		expect(resolved.provider).toBe('sqlite');
		expect(resolved.recall.defaultMaxItems).toBe(8);
		expect(resolved.consolidation.enabled).toBe(false);
		expect(resolved.writes.mode).toBe('propose');
	});

	// -----------------------------------------------------------------------
	// resolveMemoryConfig with retrieval weights partial override
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig merges nested retrieval.weights correctly', () => {
		const resolved = resolveMemoryConfig({
			retrieval: { weights: { dense: 0.9 } },
		});
		// Only dense is overridden, lexical and metadata stay at defaults
		expect(resolved.retrieval.weights.dense).toBe(0.9);
		expect(resolved.retrieval.weights.lexical).toBe(0.5);
		expect(resolved.retrieval.weights.metadata).toBe(0.1);
	});

	// -----------------------------------------------------------------------
	// resolveMemoryConfig with retrieval rerank partial override
	// -----------------------------------------------------------------------
	test('resolveMemoryConfig merges nested retrieval.rerank correctly', () => {
		const resolved = resolveMemoryConfig({
			retrieval: { rerank: { enabled: true } },
		});
		expect(resolved.retrieval.rerank.enabled).toBe(true);
		expect(resolved.retrieval.rerank.model).toBeUndefined(); // not overridden
	});
});

describe('MemoryConfig type is usable at runtime', () => {
	test('MemoryConfig type can be instantiated with embeddings + retrieval', () => {
		const config: MemoryConfig = {
			enabled: true,
			provider: 'sqlite',
			storageDir: '.swarm/memory',
			sqlite: { path: '.swarm/memory/memory.db', busyTimeoutMs: 5000 },
			recall: {
				defaultMaxItems: 8,
				defaultTokenBudget: 1200,
				minScore: 0.05,
				injection: {
					enabled: true,
					minScore: 0.25,
					requireQuerySignal: true,
					maxItems: 6,
					tokenBudget: 1000,
				},
			},
			writes: { mode: 'propose' },
			redaction: { rejectDurableSecrets: true },
			maintenance: {
				lowUtilityMaxConfidence: 0.45,
				lowUtilityMinAgeDays: 30,
				importance: {
					wRecency: 0.2,
					wFrequency: 0.2,
					wFreshness: 0.15,
					wConfidence: 0.25,
					lambda: 0.05,
					mu: 0.01,
					n: 50,
					threshold: 0.2,
				},
			},
			consolidation: {
				enabled: false,
				maxClustersPerPass: 10,
				jaccardThreshold: 0.3,
				autoApplyMinConfidence: 0.6,
				decayHalfLifeDays: {
					scratch: 7,
					todo: 30,
					code_pattern: 90,
					test_pattern: 90,
					failure_pattern: 90,
					api_finding: 180,
					evidence: 180,
					architecture_decision: 0,
					repo_convention: 0,
					project_fact: 0,
					security_note: 0,
					user_preference: 0,
				},
			},
			hardDelete: false,
			embeddings: {
				enabled: true,
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
				version: 'v1',
				cacheSize: 256,
			},
			retrieval: {
				rrfK: 60,
				weights: { lexical: 0.5, dense: 0.4, metadata: 0.1 },
				rerank: { enabled: false },
				latencyBudgetMs: 250,
			},
		};
		expect(config.embeddings.enabled).toBe(true);
		expect(config.embeddings.version).toBe('v1');
		expect(config.retrieval.weights.dense).toBe(0.4);
	});
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — schema input rejection (task 1.1)
// These tests verify that the schema REJECTS malformed inputs.
// A test that "fails" means the schema incorrectly ACCEPTED bad input —
// that is a bug to be fixed by the coder.
// ---------------------------------------------------------------------------
describe('ADVERSARIAL — MemoryConfigSchema rejects malformed embeddings inputs', () => {
	// embeddings.enabled — must be strict boolean, not coerceable
	test('embeddings.enabled as string "true" → MUST reject (not coerce)', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { enabled: 'true' as unknown as boolean },
			}),
		).toThrow();
	});

	test('embeddings.enabled as integer 1 → MUST reject (not coerce)', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { enabled: 1 as unknown as boolean },
			}),
		).toThrow();
	});

	test('embeddings.enabled as null → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { enabled: null as unknown as boolean },
			}),
		).toThrow();
	});

	// embeddings.dimension — must reject non-positive values
	test('embeddings.dimension as negative number -1 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ embeddings: { dimension: -1 } }),
		).toThrow();
	});

	test('embeddings.dimension as zero 0 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ embeddings: { dimension: 0 } }),
		).toThrow();
	});

	test('embeddings.dimension as non-number string "384" → MUST reject (no coercion on dimension)', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { dimension: '384' as unknown as number },
			}),
		).toThrow();
	});

	// embeddings.cacheSize — must reject non-positive integers
	test('embeddings.cacheSize as negative -1 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ embeddings: { cacheSize: -1 } }),
		).toThrow();
	});

	test('embeddings.cacheSize as zero 0 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ embeddings: { cacheSize: 0 } }),
		).toThrow();
	});

	test('embeddings.cacheSize as non-number string → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { cacheSize: '256' as unknown as number },
			}),
		).toThrow();
	});

	// embeddings.model — must be strict string
	test('embeddings.model as number → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { model: 42 as unknown as string },
			}),
		).toThrow();
	});

	test('embeddings.model as object → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				embeddings: { model: { foo: 'bar' } as unknown as string },
			}),
		).toThrow();
	});
});

describe('ADVERSARIAL — MemoryConfigSchema rejects malformed retrieval inputs', () => {
	// retrieval.rrfK — must reject non-positive integers
	test('retrieval.rrfK as negative -5 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ retrieval: { rrfK: -5 } }),
		).toThrow();
	});

	test('retrieval.rrfK as zero 0 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ retrieval: { rrfK: 0 } }),
		).toThrow();
	});

	test('retrieval.rrfK as non-number string → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				retrieval: { rrfK: '60' as unknown as number },
			}),
		).toThrow();
	});

	// retrieval.weights — must be bounded [0, 1]
	test('retrieval.weights.lexical as negative -0.1 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ retrieval: { weights: { lexical: -0.1 } } }),
		).toThrow();
	});

	test('retrieval.weights.dense as > 1 (e.g. 1.5) → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ retrieval: { weights: { dense: 1.5 } } }),
		).toThrow();
	});

	test('retrieval.weights.metadata as non-number string → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				retrieval: { weights: { metadata: '0.1' as unknown as number } },
			}),
		).toThrow();
	});

	// retrieval.rerank.enabled — must be strict boolean
	test('retrieval.rerank.enabled as string "true" → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				retrieval: { rerank: { enabled: 'true' as unknown as boolean } },
			}),
		).toThrow();
	});

	test('retrieval.rerank.enabled as integer 1 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				retrieval: { rerank: { enabled: 1 as unknown as boolean } },
			}),
		).toThrow();
	});

	// retrieval.latencyBudgetMs — must reject negative and non-integer
	test('retrieval.latencyBudgetMs as negative -1 → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({ retrieval: { latencyBudgetMs: -1 } }),
		).toThrow();
	});

	test('retrieval.latencyBudgetMs as non-number string → MUST reject', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				retrieval: { latencyBudgetMs: '250' as unknown as number },
			}),
		).toThrow();
	});
});

describe('ADVERSARIAL — MemoryConfigSchema unknown-field behavior (safe stripped vs strict)', () => {
	// Zod's default behavior is to STRIP unknown keys (not reject them).
	// This test documents the actual behavior — extra keys are silently removed.
	// If the intent is to reject unknown keys, the schema needs .strict() added.
	test('extra unknown keys under embeddings are STRIPPED (not rejected) — documents current behavior', () => {
		const result = MemoryConfigSchema.parse({
			embeddings: {
				enabled: true,
				unknownExtraField: 'should be stripped',
				anotherBadKey: 123,
			},
		});
		// Zod strips unknown keys silently — they are absent from the result
		expect(
			(result.embeddings as Record<string, unknown>).unknownExtraField,
		).toBeUndefined();
		expect(
			(result.embeddings as Record<string, unknown>).anotherBadKey,
		).toBeUndefined();
		// Valid keys still work
		expect(result.embeddings.enabled).toBe(true);
	});

	test('extra unknown keys under retrieval are STRIPPED (not rejected) — documents current behavior', () => {
		const result = MemoryConfigSchema.parse({
			retrieval: {
				rrfK: 30,
				unknownRerankField: true,
			},
		});
		expect(
			(result.retrieval as Record<string, unknown>).unknownRerankField,
		).toBeUndefined();
		expect(result.retrieval.rrfK).toBe(30);
	});
});
