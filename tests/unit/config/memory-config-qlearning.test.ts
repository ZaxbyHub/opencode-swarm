import { describe, expect, test } from 'bun:test';
import {
	MemoryConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';
import {
	COUNCIL_VERDICT_REWARDS,
	DEFAULT_QLEARNING_CONFIG,
	type MemoryConfig,
	resolveMemoryConfig,
} from '../../../src/memory/config';

// ---------------------------------------------------------------------------
// Task A.1 — Q-learning-style utility tracking config (schema + defaults).
// ---------------------------------------------------------------------------

describe('MemoryConfigSchema — qLearning defaults (task A.1)', () => {
	test('an empty memory block resolves qLearning to the exact DEFAULT_QLEARNING_CONFIG literal', () => {
		const parsed = MemoryConfigSchema.parse({});

		// Load-bearing assertion: the schema's inline defaults (schema.ts) and
		// the standalone DEFAULT_QLEARNING_CONFIG (config.ts) are two
		// separately-maintained literals. A deep-equal against the real
		// constant — not a copy-pasted object literal — catches drift between
		// the two if either is edited without the other.
		expect(parsed.qLearning).toEqual(DEFAULT_QLEARNING_CONFIG);
	});

	test('representative fields resolve to their documented defaults', () => {
		const parsed = MemoryConfigSchema.parse({});

		expect(parsed.qLearning.learningRate).toBe(0.1);
		expect(parsed.qLearning.suppressionThreshold).toBe(0.15);
		expect(parsed.qLearning.promotionThreshold).toBe(0.85);
		expect(parsed.qLearning.initialQValue).toBe(0.5);
		expect(parsed.qLearning.promotionMinRetrievals).toBe(5);
		expect(parsed.qLearning.propagationFanoutCap).toBe(20);
		expect(parsed.qLearning.verdictPayloadCapBytes).toBe(8192);
		expect(parsed.qLearning.propagationRelatednessThreshold).toBe(0.7);
	});

	test('memory config is optional at the plugin level — omitting it entirely does not force qLearning defaults', () => {
		const parsed = PluginConfigSchema.parse({});
		expect(parsed.memory).toBeUndefined();
	});

	test('minimal explicit memory config (only "enabled") still fills in qLearning defaults', () => {
		const parsed = MemoryConfigSchema.parse({ enabled: true });
		expect(parsed.qLearning).toEqual(DEFAULT_QLEARNING_CONFIG);
	});
});

describe('ADVERSARIAL — MemoryConfigSchema rejects out-of-range qLearning values (task A.1)', () => {
	test('learningRate above 1 (2) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { learningRate: 2 },
		});
		expect(result.success).toBe(false);
	});

	test('learningRate below 0 (-0.1) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { learningRate: -0.1 },
		});
		expect(result.success).toBe(false);
	});

	test('promotionMinRetrievals as a non-integer (1.5) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { promotionMinRetrievals: 1.5 },
		});
		expect(result.success).toBe(false);
	});

	test('verdictPayloadCapBytes below 0 (-1) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { verdictPayloadCapBytes: -1 },
		});
		expect(result.success).toBe(false);
	});

	test('promotionThreshold above 1 (1.01) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { promotionThreshold: 1.01 },
		});
		expect(result.success).toBe(false);
	});

	test('propagationFanoutCap as a non-integer (3.2) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { propagationFanoutCap: 3.2 },
		});
		expect(result.success).toBe(false);
	});

	test('propagationRelatednessThreshold above 1 (1.01) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { propagationRelatednessThreshold: 1.01 },
		});
		expect(result.success).toBe(false);
	});

	test('propagationRelatednessThreshold below 0 (-0.1) is rejected', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { propagationRelatednessThreshold: -0.1 },
		});
		expect(result.success).toBe(false);
	});

	test('a single valid override is accepted while other fields keep their defaults', () => {
		const result = MemoryConfigSchema.safeParse({
			qLearning: { suppressionThreshold: 0.3 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.qLearning.suppressionThreshold).toBe(0.3);
			expect(result.data.qLearning.learningRate).toBe(
				DEFAULT_QLEARNING_CONFIG.learningRate,
			);
		}
	});
});

describe('COUNCIL_VERDICT_REWARDS (task A.1)', () => {
	test('is importable and equals the documented [0,1]-scale reward map', () => {
		expect(COUNCIL_VERDICT_REWARDS).toEqual({
			APPROVE: 1.0,
			CONCERNS: 0.5,
			REJECT: 0.0,
		});
	});

	test('every reward value is within the [0, 1] utility scale', () => {
		for (const [verdict, reward] of Object.entries(COUNCIL_VERDICT_REWARDS)) {
			expect(reward).toBeGreaterThanOrEqual(0);
			expect(reward).toBeLessThanOrEqual(1);
			// Sanity: no reward is accidentally NaN/undefined-coerced.
			expect(Number.isFinite(reward)).toBe(true);
			void verdict;
		}
	});

	test('APPROVE strictly outranks CONCERNS, which strictly outranks REJECT', () => {
		expect(COUNCIL_VERDICT_REWARDS.APPROVE).toBeGreaterThan(
			COUNCIL_VERDICT_REWARDS.CONCERNS,
		);
		expect(COUNCIL_VERDICT_REWARDS.CONCERNS).toBeGreaterThan(
			COUNCIL_VERDICT_REWARDS.REJECT,
		);
	});
});

describe('resolveMemoryConfig — qLearning partial override merge (task A.1)', () => {
	test('a partial qLearning override returns the overridden field and preserves sibling defaults', () => {
		const resolved = resolveMemoryConfig({
			qLearning: { suppressionThreshold: 0.3 } as MemoryConfig['qLearning'],
		});

		// The overridden field took effect.
		expect(resolved.qLearning.suppressionThreshold).toBe(0.3);

		// At least two untouched sibling fields still resolve to their defaults
		// — proves the merge is a shallow-spread-over-defaults, not a full
		// replacement of the qLearning block by the partial input.
		expect(resolved.qLearning.learningRate).toBe(
			DEFAULT_QLEARNING_CONFIG.learningRate,
		);
		expect(resolved.qLearning.promotionThreshold).toBe(
			DEFAULT_QLEARNING_CONFIG.promotionThreshold,
		);
		expect(resolved.qLearning.initialQValue).toBe(
			DEFAULT_QLEARNING_CONFIG.initialQValue,
		);
	});

	test('resolveMemoryConfig with no input returns the full qLearning defaults', () => {
		const resolved = resolveMemoryConfig(undefined);
		expect(resolved.qLearning).toEqual(DEFAULT_QLEARNING_CONFIG);
	});

	test('resolveMemoryConfig with an empty object returns the full qLearning defaults', () => {
		const resolved = resolveMemoryConfig({});
		expect(resolved.qLearning).toEqual(DEFAULT_QLEARNING_CONFIG);
	});

	test('resolveMemoryConfig preserves unrelated top-level defaults when only qLearning is overridden', () => {
		const resolved = resolveMemoryConfig({
			qLearning: { explorationRate: 0.2 } as MemoryConfig['qLearning'],
		});
		expect(resolved.qLearning.explorationRate).toBe(0.2);
		// Unrelated top-level blocks are untouched by the qLearning merge branch.
		expect(resolved.provider).toBe('sqlite');
		expect(resolved.recall.defaultMaxItems).toBe(8);
	});
});
