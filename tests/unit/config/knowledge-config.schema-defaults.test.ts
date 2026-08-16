/**
 * Schema default and custom value tests for KnowledgeConfigSchema.
 * Part 1 of 2 for knowledge-config.test.ts.
 *
 * Note: This file is a direct split of the original test sections.
 * The defaults-expected object matches the original test file exactly.
 */
import { describe, expect, it } from 'bun:test';
import {
	KnowledgeConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema.js';

describe('KnowledgeConfigSchema — defaults and custom values', () => {
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
				receipt_close_grace_days: 7,
				promoted_demotion_min_negative_phases: 3,
				promoted_demotion_signal_threshold: -0.3,
				promotion_min_terminal_applications: 0,
				promotion_min_distinct_cohorts: 0,
				promotion_require_actionable: true,
				schema_version: 1,
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
				confidence_floor_action: 'demote',
				confidence_floor_min_outcomes: 3,
				confidence_floor_signal_threshold: 0,
				contradiction_threshold_action: 'quarantine',
				contradiction_quarantine_threshold: 3,
				contradiction_quarantine_window_days: 30,
				realtime_learning_nudge: {
					enabled: true,
					first_after_tool_calls: 10,
					repeat_after_tool_calls: 25,
				},
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
			expect(result.swarm_max_entries).toBe(100);
			expect(result.dedup_threshold).toBe(0.6);
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
				receipt_close_grace_days: 14,
				promoted_demotion_min_negative_phases: 5,
				promoted_demotion_signal_threshold: -0.5,
				promotion_min_terminal_applications: 2,
				promotion_min_distinct_cohorts: 2,
				promotion_require_actionable: false,
				schema_version: 2,
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
				confidence_floor_action: 'quarantine',
				confidence_floor_min_outcomes: 5,
				confidence_floor_signal_threshold: -0.1,
				contradiction_threshold_action: 'tag_only',
				contradiction_quarantine_threshold: 5,
				contradiction_quarantine_window_days: 14,
				realtime_learning_nudge: {
					enabled: false,
					first_after_tool_calls: 5,
					repeat_after_tool_calls: 15,
				},
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
				swarm_max_entries: 1,
				hive_max_entries: 100000,
				auto_promote_days: 3650,
				max_inject_count: 0,
				dedup_threshold: 0,
				rejected_max_entries: 1,
				evergreen_confidence: 1,
				evergreen_utility: 1,
				low_utility_threshold: 0,
				min_retrievals_for_utility: 1,
				schema_version: 1,
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
			expect(result.knowledge!.swarm_max_entries).toBe(100);
			expect(result.knowledge!.dedup_threshold).toBe(0.6);
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
					receipt_close_grace_days: 14,
					promoted_demotion_min_negative_phases: 5,
					promoted_demotion_signal_threshold: -0.5,
					promotion_min_terminal_applications: 2,
					promotion_min_distinct_cohorts: 2,
					promotion_require_actionable: false,
					schema_version: 2,
					same_project_weight: 1.0,
					cross_project_weight: 0.5,
					min_encounter_score: 0.1,
					initial_encounter_score: 1.0,
					encounter_increment: 0.1,
					max_encounter_score: 10.0,
					default_max_phases: 10,
					todo_max_phases: 3,
					sweep_enabled: true,
					confidence_floor_action: 'quarantine',
					confidence_floor_min_outcomes: 5,
					confidence_floor_signal_threshold: -0.1,
					contradiction_threshold_action: 'tag_only',
					contradiction_quarantine_threshold: 5,
					contradiction_quarantine_window_days: 14,
					realtime_learning_nudge: {
						enabled: false,
						first_after_tool_calls: 5,
						repeat_after_tool_calls: 15,
					},
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
			const config: Parameters<typeof KnowledgeConfigSchema.parse>[0] = {
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
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
				confidence_floor_action: 'demote',
				confidence_floor_min_outcomes: 3,
				confidence_floor_signal_threshold: 0,
				contradiction_threshold_action: 'quarantine',
				contradiction_quarantine_threshold: 3,
				contradiction_quarantine_window_days: 30,
				realtime_learning_nudge: {
					enabled: true,
					first_after_tool_calls: 10,
					repeat_after_tool_calls: 25,
				},
				directive_min_confidence: 0.75,
				enrichment: {
					max_calls_per_day: 30,
					quota_window: 'utc',
				},
			};

			expect(config).toBeDefined();
		});

		it('should accept parsed config as KnowledgeConfig type', () => {
			const parsed = KnowledgeConfigSchema.parse({});
			const typed = parsed;
			expect(typed.enabled).toBe(true);
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

	describe('real-time learning nudge config', () => {
		it('should use real-time learning nudge defaults when not provided', () => {
			const result = KnowledgeConfigSchema.parse({});

			expect(result.realtime_learning_nudge).toEqual({
				enabled: true,
				first_after_tool_calls: 10,
				repeat_after_tool_calls: 25,
			});
		});

		it('should preserve custom real-time learning nudge values', () => {
			const result = KnowledgeConfigSchema.parse({
				realtime_learning_nudge: {
					enabled: false,
					first_after_tool_calls: 3,
					repeat_after_tool_calls: 7,
				},
			});

			expect(result.realtime_learning_nudge).toEqual({
				enabled: false,
				first_after_tool_calls: 3,
				repeat_after_tool_calls: 7,
			});
		});

		it('should reject non-positive real-time learning nudge thresholds', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({
					realtime_learning_nudge: { first_after_tool_calls: 0 },
				});
			}).toThrow();

			expect(() => {
				KnowledgeConfigSchema.parse({
					realtime_learning_nudge: { repeat_after_tool_calls: 0 },
				});
			}).toThrow();
		});

		it('should accept and reject boundary values for tool-call thresholds', () => {
			const result1 = KnowledgeConfigSchema.parse({
				realtime_learning_nudge: { first_after_tool_calls: 1000 },
			});
			expect(result1.realtime_learning_nudge.first_after_tool_calls).toBe(1000);

			expect(() => {
				KnowledgeConfigSchema.parse({
					realtime_learning_nudge: { first_after_tool_calls: 1001 },
				});
			}).toThrow();

			const result2 = KnowledgeConfigSchema.parse({
				realtime_learning_nudge: { repeat_after_tool_calls: 1000 },
			});
			expect(result2.realtime_learning_nudge.repeat_after_tool_calls).toBe(
				1000,
			);

			expect(() => {
				KnowledgeConfigSchema.parse({
					realtime_learning_nudge: { repeat_after_tool_calls: 1001 },
				});
			}).toThrow();
		});
	});
});
