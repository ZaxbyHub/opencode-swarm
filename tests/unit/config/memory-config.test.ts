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
			writes: { mode: 'propose' },
			redaction: { rejectDurableSecrets: true },
			maintenance: {
				lowUtilityMaxConfidence: 0.45,
				lowUtilityMinAgeDays: 30,
			},
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

		expect(parsed.maintenance).toEqual({
			lowUtilityMaxConfidence: 0.2,
			lowUtilityMinAgeDays: 90,
		});
		expect(() =>
			MemoryConfigSchema.parse({
				maintenance: { lowUtilityMinAgeDays: 0 },
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
