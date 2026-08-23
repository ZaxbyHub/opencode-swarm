import { describe, expect, test } from 'bun:test';
import {
	type MemoryConfig,
	MemoryConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('MemoryConfigSchema', () => {
	test('memory config is optional and omitted config preserves current behavior', () => {
		const parsed = PluginConfigSchema.parse({});

		expect(parsed.memory).toBeUndefined();
	});

	test('parses defaults when memory block is present', () => {
		const parsed = MemoryConfigSchema.parse({});

		expect(parsed).toEqual({
			enabled: false,
			provider: 'sqlite',
			qLearning: {
				learningRate: 0.1,
				qValueBoostWeight: 0.1,
				suppressionThreshold: 0.15,
				promotionThreshold: 0.85,
				promotionMinRetrievals: 5,
				propagationFraction: 0.3,
				propagationFanoutCap: 20,
				propagationWindowDays: 30,
				propagationRelatednessThreshold: 0.7,
				explorationRate: 0.05,
				verdictPayloadCapBytes: 8192,
				initialQValue: 0.5,
			},
			storageDir: '.swarm/memory',
			sqlite: {
				path: '.swarm/memory/memory.db',
				busyTimeoutMs: 5000,
			},
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
			reflection: {
				enabled: false,
				halfLifeDays: 30,
			},
			learning: {
				learningRate: 0.1,
				propagationFactor: 0.3,
				qValueBoostWeight: 0.1,
				suppressionThreshold: 0.15,
				promotionThreshold: 0.85,
				propagationTokenOverlapThreshold: 0.4,
				propagationEmbeddingCosineThreshold: 0.7,
				propagationFanout: 20,
				propagationLookbackDays: 30,
			},
			writes: { mode: 'propose' },
			redaction: {
				rejectDurableSecrets: true,
				detectPii: false,
				piiDetector: "regex",
				rejectDurablePii: false,
				piiThreshold: 0.7,
			},
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
					user_preference: 0,
					project_fact: 0,
					architecture_decision: 0,
					repo_convention: 0,
					api_finding: 180,
					code_pattern: 90,
					test_pattern: 90,
					failure_pattern: 90,
					security_note: 0,
					evidence: 180,
					todo: 30,
					scratch: 7,
				},
			},
			embeddings: {
				enabled: false,
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
				cacheSize: 256,
			},
			retrieval: {
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
			},
			// #1850: cohort memory sharing default-off.
			link: { enabled: false },
			hardDelete: false,
		});
	});

	test('accepts bounded recall overrides', () => {
		const parsed = MemoryConfigSchema.parse({
			enabled: true,
			recall: { defaultMaxItems: 3, defaultTokenBudget: 500, minScore: 0.2 },
		});

		expect(parsed.enabled).toBe(true);
		expect(parsed.recall.defaultMaxItems).toBe(3);
		expect(parsed.recall.defaultTokenBudget).toBe(500);
		expect(parsed.recall.minScore).toBe(0.2);
	});

	test('reflection is default-off and deep-merges bounded overrides', () => {
		const parsed = MemoryConfigSchema.parse({
			reflection: { enabled: true },
		});

		expect(parsed.reflection).toEqual({ enabled: true, halfLifeDays: 30 });
		expect(() =>
			MemoryConfigSchema.parse({ reflection: { halfLifeDays: 0 } }),
		).toThrow();
	});

	test('accepts bounded learning overrides', () => {
		const parsed = MemoryConfigSchema.parse({
			learning: {
				learningRate: 0.2,
				qValueBoostWeight: 0.25,
				suppressionThreshold: 0.1,
				promotionThreshold: 0.9,
				propagationFanout: 4,
			},
		});

		expect(parsed.learning.learningRate).toBe(0.2);
		expect(parsed.learning.qValueBoostWeight).toBe(0.25);
		expect(parsed.learning.suppressionThreshold).toBe(0.1);
		expect(parsed.learning.promotionThreshold).toBe(0.9);
		expect(parsed.learning.propagationFanout).toBe(4);
		expect(parsed.learning.propagationFactor).toBe(0.3);
		expect(() =>
			MemoryConfigSchema.parse({ learning: { learningRate: 2 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { propagationFanout: -1 } }),
		).toThrow();
	});

	test('accepts the propagationEmbeddingCosineThreshold override', () => {
		const parsed = MemoryConfigSchema.parse({
			learning: { propagationEmbeddingCosineThreshold: 0.8 },
		});
		expect(parsed.learning.propagationEmbeddingCosineThreshold).toBe(0.8);
	});

	test('rejects a negative learningRate (previously untested lower bound)', () => {
		expect(() =>
			MemoryConfigSchema.parse({ learning: { learningRate: -0.1 } }),
		).toThrow();
	});

	test('rejects out-of-bounds values for every remaining learning.* field', () => {
		// Each of these fields is bounded [0,1] in the schema; the "accepts
		// bounded learning overrides" test above only exercised learningRate's
		// upper bound and propagationFanout's lower bound — every other field
		// had zero bounds-rejection coverage.
		expect(() =>
			MemoryConfigSchema.parse({ learning: { propagationFactor: 1.5 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { propagationFactor: -0.1 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { qValueBoostWeight: 1.5 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { qValueBoostWeight: -0.1 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { suppressionThreshold: 1.5 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { suppressionThreshold: -0.1 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { promotionThreshold: 1.5 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { promotionThreshold: -0.1 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				learning: { propagationTokenOverlapThreshold: 1.5 },
			}),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				learning: { propagationTokenOverlapThreshold: -0.1 },
			}),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				learning: { propagationEmbeddingCosineThreshold: 1.5 },
			}),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				learning: { propagationEmbeddingCosineThreshold: -0.1 },
			}),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { propagationFanout: 1001 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ learning: { propagationLookbackDays: 0 } }),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				learning: { propagationLookbackDays: 3651 },
			}),
		).toThrow();
	});

	test('accepts bounded injection overrides while preserving tool recall defaults', () => {
		const parsed = MemoryConfigSchema.parse({
			recall: {
				defaultMaxItems: 8,
				defaultTokenBudget: 1200,
				minScore: 0.05,
				injection: {
					enabled: false,
					minScore: 0.4,
					requireQuerySignal: false,
					maxItems: 4,
					tokenBudget: 700,
				},
			},
		});

		expect(parsed.recall.defaultMaxItems).toBe(8);
		expect(parsed.recall.minScore).toBe(0.05);
		expect(parsed.recall.injection).toEqual({
			enabled: false,
			minScore: 0.4,
			requireQuerySignal: false,
			maxItems: 4,
			tokenBudget: 700,
		});
	});

	test('rejects unsupported providers and direct write modes', () => {
		expect(() => MemoryConfigSchema.parse({ provider: 'qdrant' })).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({ writes: { mode: 'direct' } }),
		).toThrow();
	});

	test('accepts explicit maintenance thresholds for low-utility reporting', () => {
		const parsed = MemoryConfigSchema.parse({
			maintenance: {
				lowUtilityMaxConfidence: 0.2,
				lowUtilityMinAgeDays: 90,
			},
		});

		expect(parsed.maintenance.lowUtilityMaxConfidence).toBe(0.2);
		expect(parsed.maintenance.lowUtilityMinAgeDays).toBe(90);
		// Importance defaults are still filled in when not overridden.
		expect(parsed.maintenance.importance.threshold).toBe(0.2);
		expect(() =>
			MemoryConfigSchema.parse({
				maintenance: { lowUtilityMinAgeDays: 0 },
			}),
		).toThrow();
	});

	test('fills importance and consolidation defaults and preserves nested overrides (issue #1464)', () => {
		const parsed = MemoryConfigSchema.parse({
			maintenance: { importance: { threshold: 0.4, wConfidence: 0.3 } },
			consolidation: {
				jaccardThreshold: 0.5,
				decayHalfLifeDays: { todo: 14 },
			},
		});

		// Overridden nested values survive zod parsing (the dual-config blocker).
		expect(parsed.maintenance.importance.threshold).toBe(0.4);
		expect(parsed.maintenance.importance.wConfidence).toBe(0.3);
		// Sibling defaults inside the same nested object are preserved.
		expect(parsed.maintenance.importance.wRecency).toBe(0.2);
		expect(parsed.consolidation.jaccardThreshold).toBe(0.5);
		// Opt-in default (MED-04): not enabled unless explicitly set.
		expect(parsed.consolidation.enabled).toBe(false);
		expect(parsed.consolidation.decayHalfLifeDays.todo).toBe(14);
		expect(parsed.consolidation.decayHalfLifeDays.scratch).toBe(7);
	});

	test('rejects out-of-range importance weights and consolidation bounds', () => {
		expect(() =>
			MemoryConfigSchema.parse({
				maintenance: { importance: { wConfidence: 2 } },
			}),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				consolidation: { jaccardThreshold: 1.5 },
			}),
		).toThrow();
		expect(() =>
			MemoryConfigSchema.parse({
				consolidation: { maxClustersPerPass: 0 },
			}),
		).toThrow();
	});

	test('accepts sqlite provider settings and uses sqlite as the default provider', () => {
		const parsed = MemoryConfigSchema.parse({
			provider: 'sqlite',
			sqlite: {
				path: '.swarm/memory/custom.db',
				busyTimeoutMs: 2500,
			},
		});

		expect(parsed.provider).toBe('sqlite');
		expect(parsed.sqlite).toEqual({
			path: '.swarm/memory/custom.db',
			busyTimeoutMs: 2500,
		});
		expect(MemoryConfigSchema.parse({}).provider).toBe('sqlite');
	});

	test('exports a usable MemoryConfig type', () => {
		const config: MemoryConfig = MemoryConfigSchema.parse({ enabled: true });

		expect(config.provider).toBe('sqlite');
		expect(config.sqlite.path).toBe('.swarm/memory/memory.db');
	});
});
