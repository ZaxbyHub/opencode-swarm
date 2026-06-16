import { describe, expect, it } from 'vitest';
import {
	type KnowledgeConfig,
	KnowledgeConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema.js';

describe('KnowledgeConfigSchema', () => {
	describe('default values', () => {
		it('should produce all defaults when parsing empty object', () => {
			const result = KnowledgeConfigSchema.parse({});

			expect(result).toEqual({
				enabled: true,
				swarm_max_entries: 100,
				hive_max_entries: 200,
				auto_promote_days: 90,
				max_inject_count: 5,
				delegate_max_inject_count: 8,
				inject_char_budget: 2_000,
				max_lesson_display_chars: 120,
				dedup_threshold: 0.6,
				scope_filter: ['global'],
				hive_enabled: true,
				rejected_max_entries: 20,
				validation_enabled: true,
				evergreen_confidence: 0.9,
				evergreen_utility: 0.8,
				low_utility_threshold: 0.3,
				min_retrievals_for_utility: 3,
				schema_version: 1,
				// v6.17+ encounter scoring fields
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
				// v6.71+ decay config fields
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
				// v7.10.0+ directive retrieval threshold
				directive_min_confidence: 0.75,
				enrichment: {
					max_calls_per_day: 30,
					quota_window: 'utc',
				},
			});
		});

		it('should accept partial overrides and merge with defaults', () => {
			const result = KnowledgeConfigSchema.parse({
				enabled: false,
				max_inject_count: 10,
			});

			expect(result.enabled).toBe(false);
			expect(result.max_inject_count).toBe(10);
			expect(result.swarm_max_entries).toBe(100); // default
			expect(result.dedup_threshold).toBe(0.6); // default
		});
	});

	describe('custom values', () => {
		it('should succeed when parsing a full config with all fields set', () => {
			const fullConfig = {
				enabled: false,
				swarm_max_entries: 500,
				hive_max_entries: 1000,
				auto_promote_days: 30,
				max_inject_count: 10,
				delegate_max_inject_count: 6,
				inject_char_budget: 3_000,
				max_lesson_display_chars: 200,
				dedup_threshold: 0.8,
				scope_filter: ['global', 'project'],
				hive_enabled: false,
				rejected_max_entries: 50,
				validation_enabled: false,
				evergreen_confidence: 0.95,
				evergreen_utility: 0.85,
				low_utility_threshold: 0.25,
				min_retrievals_for_utility: 5,
				schema_version: 2,
				// v6.17+ encounter scoring fields
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
				// v6.71+ decay config fields
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
				// v7.10.0+ directive retrieval threshold
				directive_min_confidence: 0.75,
				enrichment: {
					max_calls_per_day: 30,
					quota_window: 'utc',
				},
			};

			const result = KnowledgeConfigSchema.parse(fullConfig);

			expect(result).toEqual(fullConfig);
		});

		it('should accept valid boundary values', () => {
			const boundaryConfig = {
				enabled: false,
				swarm_max_entries: 1, // min
				hive_max_entries: 100000, // max
				auto_promote_days: 3650, // max
				max_inject_count: 0, // min
				dedup_threshold: 0, // min
				rejected_max_entries: 1, // min
				evergreen_confidence: 1, // max
				evergreen_utility: 1, // max
				low_utility_threshold: 0, // min
				min_retrievals_for_utility: 1, // min
				schema_version: 1, // min
			};

			const result = KnowledgeConfigSchema.parse(boundaryConfig);

			expect(result.swarm_max_entries).toBe(1);
			expect(result.hive_max_entries).toBe(100000);
			expect(result.auto_promote_days).toBe(3650);
			expect(result.max_inject_count).toBe(0);
			expect(result.dedup_threshold).toBe(0);
			expect(result.rejected_max_entries).toBe(1);
			expect(result.evergreen_confidence).toBe(1);
			expect(result.evergreen_utility).toBe(1);
			expect(result.low_utility_threshold).toBe(0);
			expect(result.min_retrievals_for_utility).toBe(1);
			expect(result.schema_version).toBe(1);
		});
	});

	describe('PluginConfig integration', () => {
		it('should succeed when knowledge field is omitted (optional)', () => {
			const result = PluginConfigSchema.parse({});

			expect(result.knowledge).toBeUndefined();
		});

		it('should succeed when knowledge field is undefined', () => {
			const result = PluginConfigSchema.parse({
				knowledge: undefined,
			});

			expect(result.knowledge).toBeUndefined();
		});

		it('should not break existing PluginConfig fields', () => {
			const result = PluginConfigSchema.parse({
				max_iterations: 7,
				inject_phase_reminders: false,
			});

			expect(result.max_iterations).toBe(7);
			expect(result.inject_phase_reminders).toBe(false);
			expect(result.knowledge).toBeUndefined();
		});
	});

	describe('PluginConfig with knowledge', () => {
		it('should merge defaults when knowledge is provided with partial values', () => {
			const result = PluginConfigSchema.parse({
				knowledge: {
					enabled: false,
					max_inject_count: 0,
				},
			});

			expect(result.knowledge).toBeDefined();
			expect(result.knowledge!.enabled).toBe(false);
			expect(result.knowledge!.max_inject_count).toBe(0);
			expect(result.knowledge!.swarm_max_entries).toBe(100); // default
			expect(result.knowledge!.dedup_threshold).toBe(0.6); // default
		});

		it('should accept full knowledge config', () => {
			const fullConfig = {
				knowledge: {
					enabled: false,
					swarm_max_entries: 500,
					hive_max_entries: 1000,
					auto_promote_days: 30,
					max_inject_count: 10,
					delegate_max_inject_count: 6,
					inject_char_budget: 3_000,
					max_lesson_display_chars: 200,
					dedup_threshold: 0.8,
					scope_filter: ['global', 'project'],
					hive_enabled: false,
					rejected_max_entries: 50,
					validation_enabled: false,
					evergreen_confidence: 0.95,
					evergreen_utility: 0.85,
					low_utility_threshold: 0.25,
					min_retrievals_for_utility: 5,
					schema_version: 2,
					// v6.17+ encounter scoring fields
					same_project_weight: 1.0,
					cross_project_weight: 0.5,
					min_encounter_score: 0.1,
					initial_encounter_score: 1.0,
					encounter_increment: 0.1,
					max_encounter_score: 10.0,
					// v6.71+ decay config fields
					default_max_phases: 10,
					todo_max_phases: 3,
					sweep_enabled: true,
					// v7.10.0+ directive retrieval threshold
					directive_min_confidence: 0.75,
					enrichment: {
						max_calls_per_day: 30,
						quota_window: 'utc',
					},
				},
			};

			const result = PluginConfigSchema.parse(fullConfig);

			expect(result.knowledge).toEqual(fullConfig.knowledge);
		});
	});

	describe('type export', () => {
		it('should allow KnowledgeConfig as a TypeScript type annotation', () => {
			const config: KnowledgeConfig = {
				enabled: true,
				swarm_max_entries: 100,
				hive_max_entries: 200,
				auto_promote_days: 90,
				max_inject_count: 5,
				dedup_threshold: 0.6,
				scope_filter: ['global'],
				hive_enabled: true,
				rejected_max_entries: 20,
				validation_enabled: true,
				evergreen_confidence: 0.9,
				evergreen_utility: 0.8,
				low_utility_threshold: 0.3,
				min_retrievals_for_utility: 3,
				schema_version: 1,
			};

			// Type check - this should compile
			expect(config).toBeDefined();
		});

		it('should accept parsed config as KnowledgeConfig type', () => {
			const parsed = KnowledgeConfigSchema.parse({});

			// Type check - this should compile
			const typed: KnowledgeConfig = parsed;
			expect(typed.enabled).toBe(true);
		});
	});

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

	describe('additional edge cases', () => {
		it('should accept empty scope_filter array', () => {
			const result = KnowledgeConfigSchema.parse({
				scope_filter: [],
			});

			expect(result.scope_filter).toEqual([]);
		});

		it('should accept multiple scope tags', () => {
			const result = KnowledgeConfigSchema.parse({
				scope_filter: ['global', 'project', 'module', 'function'],
			});

			expect(result.scope_filter).toEqual([
				'global',
				'project',
				'module',
				'function',
			]);
		});

		it('should accept swarm_max_entries at max value (10000)', () => {
			const result = KnowledgeConfigSchema.parse({
				swarm_max_entries: 10000,
			});

			expect(result.swarm_max_entries).toBe(10000);
		});

		it('should accept rejected_max_entries at max value (1000)', () => {
			const result = KnowledgeConfigSchema.parse({
				rejected_max_entries: 1000,
			});

			expect(result.rejected_max_entries).toBe(1000);
		});

		it('should accept min_retrievals_for_utility at max value (100)', () => {
			const result = KnowledgeConfigSchema.parse({
				min_retrievals_for_utility: 100,
			});

			expect(result.min_retrievals_for_utility).toBe(100);
		});

		it('should accept max_inject_count at max value (50)', () => {
			const result = KnowledgeConfigSchema.parse({
				max_inject_count: 50,
			});

			expect(result.max_inject_count).toBe(50);
		});
	});

	describe('decay config keys (v6.71+)', () => {
		it('should preserve default_max_phases, todo_max_phases, sweep_enabled in round-trip', () => {
			const input = {
				enabled: true,
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
			};

			const parsed = KnowledgeConfigSchema.parse(input);

			expect(parsed.default_max_phases).toBe(10);
			expect(parsed.todo_max_phases).toBe(3);
			expect(parsed.sweep_enabled).toBe(true);
		});

		it('should use decay config defaults when not provided', () => {
			const result = KnowledgeConfigSchema.parse({});

			expect(result.default_max_phases).toBe(10);
			expect(result.todo_max_phases).toBe(3);
			expect(result.sweep_enabled).toBe(true);
		});

		it('should accept custom decay values', () => {
			const result = KnowledgeConfigSchema.parse({
				default_max_phases: 20,
				todo_max_phases: 5,
				sweep_enabled: false,
			});

			expect(result.default_max_phases).toBe(20);
			expect(result.todo_max_phases).toBe(5);
			expect(result.sweep_enabled).toBe(false);
		});
	});
});
