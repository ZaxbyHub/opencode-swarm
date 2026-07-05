/**
 * Schema validation failure tests for KnowledgeConfigSchema.
 * Part 2 of 2 for knowledge-config.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
	KnowledgeConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema.js';

describe('KnowledgeConfigSchema — schema validation failures', () => {
	describe('adversarial cases - schema validation failures', () => {
		it('should FAIL when schema_version is 0 (min: 1)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ schema_version: 0 });
			}).toThrow();
		});

		it('should FAIL when swarm_max_entries is 0 (min: 1)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ swarm_max_entries: 0 });
			}).toThrow();
		});

		it('should FAIL when dedup_threshold is 1.5 (max: 1)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ dedup_threshold: 1.5 });
			}).toThrow();
		});

		it('should FAIL when dedup_threshold is -0.1 (min: 0)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ dedup_threshold: -0.1 });
			}).toThrow();
		});

		it('should FAIL when max_inject_count is -1 (min: 0)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ max_inject_count: -1 });
			}).toThrow();
		});

		it('should FAIL when hive_max_entries is 100001 (max: 100000)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ hive_max_entries: 100001 });
			}).toThrow();
		});

		it('should FAIL when schema_version is 1.5 (.int() constraint)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ schema_version: 1.5 });
			}).toThrow();
		});

		it('should FAIL when scope_filter is a string instead of array', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ scope_filter: 'global' as any });
			}).toThrow();
		});

		it('should FAIL when enabled is a string instead of boolean', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ enabled: 'yes' as any });
			}).toThrow();
		});

		it('should FAIL when knowledge is null in PluginConfig (optional means undefined, not null)', () => {
			expect(() => {
				PluginConfigSchema.parse({ knowledge: null as any });
			}).toThrow();
		});
	});

	describe('inject_char_budget and max_lesson_display_chars', () => {
		it('should default inject_char_budget to 2000', () => {
			const result = KnowledgeConfigSchema.parse({});
			expect(result.inject_char_budget).toBe(2_000);
		});

		it('should default max_lesson_display_chars to 120', () => {
			const result = KnowledgeConfigSchema.parse({});
			expect(result.max_lesson_display_chars).toBe(120);
		});

		it('should accept inject_char_budget override of 500', () => {
			const result = KnowledgeConfigSchema.parse({ inject_char_budget: 500 });
			expect(result.inject_char_budget).toBe(500);
		});

		it('should FAIL when inject_char_budget is below min (200)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ inject_char_budget: 100 });
			}).toThrow();
		});

		it('should FAIL when inject_char_budget exceeds max (10000)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ inject_char_budget: 10_001 });
			}).toThrow();
		});

		it('should FAIL when max_lesson_display_chars exceeds max (280)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ max_lesson_display_chars: 300 });
			}).toThrow();
		});

		it('should FAIL when max_lesson_display_chars is below min (40)', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ max_lesson_display_chars: 30 });
			}).toThrow();
		});

		it('should accept boundary values for inject_char_budget', () => {
			expect(
				KnowledgeConfigSchema.parse({ inject_char_budget: 200 })
					.inject_char_budget,
			).toBe(200);
			expect(
				KnowledgeConfigSchema.parse({ inject_char_budget: 10_000 })
					.inject_char_budget,
			).toBe(10_000);
		});

		it('should accept boundary values for max_lesson_display_chars', () => {
			expect(
				KnowledgeConfigSchema.parse({ max_lesson_display_chars: 40 })
					.max_lesson_display_chars,
			).toBe(40);
			expect(
				KnowledgeConfigSchema.parse({ max_lesson_display_chars: 280 })
					.max_lesson_display_chars,
			).toBe(280);
		});
	});
});
