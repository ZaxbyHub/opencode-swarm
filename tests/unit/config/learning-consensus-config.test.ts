/**
 * Schema tests for the top-level `learning` and `consensus` config blocks and
 * the `knowledge.promotion_require_actionable` gate (issue #1821, Lane 0a).
 *
 * The high-value property here is that the *nested* blocks actually materialize
 * their inner defaults. Zod 4 returns a `.default(value)` verbatim without
 * parsing it, so a `.default({})` on a nested object yields `{}` and silently
 * drops every inner default — a real footgun this suite pins against.
 */
import { describe, expect, it } from 'bun:test';
import {
	ConsensusConfigSchema,
	KnowledgeConfigSchema,
	LearningConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema.js';

describe('LearningConfigSchema', () => {
	it('materializes every nested block default from an empty object', () => {
		expect(LearningConfigSchema.parse({})).toEqual({
			realtime_admission: {
				enabled: true,
				max_queue_size: 50,
				min_drain: 1,
				max_drain: 10,
				drain_depth_factor: 0.5,
				drain_velocity_factor: 0.25,
				max_llm_calls_per_session: 20,
				max_tokens_per_session: 50_000,
				max_concurrent_admissions: 2,
				max_retries_per_candidate: 1,
				per_candidate_llm_timeout_ms: 60_000,
				max_drain_wall_time_ms: 10_000,
				supersede_nudge: true,
			},
			prm_persistence: {
				enabled: true,
				min_support: 3,
				cooldown_ms: 900_000,
			},
			dedup_sweep: {
				enabled: true,
				max_comparisons: 2_000,
				max_merges_per_sweep: 10,
			},
		});
	});

	it('merges a partial nested block with that block defaults', () => {
		const parsed = LearningConfigSchema.parse({
			realtime_admission: { enabled: false, max_drain: 4 },
		});
		expect(parsed.realtime_admission.enabled).toBe(false);
		expect(parsed.realtime_admission.max_drain).toBe(4);
		expect(parsed.realtime_admission.max_queue_size).toBe(50);
		expect(parsed.prm_persistence.min_support).toBe(3);
		expect(parsed.dedup_sweep.max_comparisons).toBe(2_000);
	});

	it('enforces the documented realtime_admission bounds', () => {
		const shouldFail: Record<string, unknown>[] = [
			{ max_queue_size: 0 },
			{ max_queue_size: 501 },
			{ min_drain: 0 },
			{ min_drain: 51 },
			{ max_drain: 0 },
			{ max_drain: 101 },
			{ drain_depth_factor: -0.1 },
			{ drain_depth_factor: 1.1 },
			{ drain_velocity_factor: 1.5 },
			{ max_llm_calls_per_session: -1 },
			{ max_llm_calls_per_session: 501 },
			{ max_concurrent_admissions: 0 },
			{ max_concurrent_admissions: 17 },
			{ max_retries_per_candidate: -1 },
			{ max_retries_per_candidate: 6 },
			{ max_queue_size: 12.5 },
		];
		for (const override of shouldFail) {
			expect(
				LearningConfigSchema.safeParse({ realtime_admission: override })
					.success,
			).toBe(false);
		}
	});

	it('accepts the realtime_admission boundary values', () => {
		const parsed = LearningConfigSchema.parse({
			realtime_admission: {
				max_queue_size: 500,
				min_drain: 50,
				max_drain: 100,
				drain_depth_factor: 0,
				drain_velocity_factor: 1,
				max_llm_calls_per_session: 0,
				max_concurrent_admissions: 16,
				max_retries_per_candidate: 5,
			},
		});
		expect(parsed.realtime_admission.max_queue_size).toBe(500);
		expect(parsed.realtime_admission.drain_depth_factor).toBe(0);
		expect(parsed.realtime_admission.max_llm_calls_per_session).toBe(0);
	});

	it('enforces prm_persistence and dedup_sweep bounds', () => {
		expect(
			LearningConfigSchema.safeParse({ prm_persistence: { min_support: 0 } })
				.success,
		).toBe(false);
		expect(
			LearningConfigSchema.safeParse({ prm_persistence: { min_support: 21 } })
				.success,
		).toBe(false);
		expect(
			LearningConfigSchema.safeParse({ prm_persistence: { cooldown_ms: -1 } })
				.success,
		).toBe(false);
		expect(
			LearningConfigSchema.safeParse({ dedup_sweep: { max_comparisons: -1 } })
				.success,
		).toBe(false);
		expect(
			LearningConfigSchema.safeParse({
				dedup_sweep: { max_merges_per_sweep: -1 },
			}).success,
		).toBe(false);
	});
});

describe('ConsensusConfigSchema', () => {
	it('produces all defaults from an empty object', () => {
		expect(ConsensusConfigSchema.parse({})).toEqual({
			enabled: true,
			default_min_support: 3,
			default_min_successful_runs: 2,
			default_max_evidence_items: 50,
			max_excerpt_chars: 500,
			llm_summarization_enabled: true,
			llm_timeout_ms: 60_000,
			report_retention: 50,
		});
	});

	it('accepts partial overrides and merges the rest', () => {
		const parsed = ConsensusConfigSchema.parse({
			enabled: false,
			default_min_support: 7,
		});
		expect(parsed.enabled).toBe(false);
		expect(parsed.default_min_support).toBe(7);
		expect(parsed.max_excerpt_chars).toBe(500);
		expect(parsed.llm_summarization_enabled).toBe(true);
	});

	it('rejects out-of-range and non-integer values', () => {
		const shouldFail: Record<string, unknown>[] = [
			{ default_min_support: 0 },
			{ default_min_successful_runs: -1 },
			{ default_max_evidence_items: 0 },
			{ max_excerpt_chars: 0 },
			{ llm_timeout_ms: -1 },
			{ report_retention: -1 },
			{ default_min_support: 3.5 },
			{ enabled: 'yes' },
		];
		for (const override of shouldFail) {
			expect(ConsensusConfigSchema.safeParse(override).success).toBe(false);
		}
	});
});

describe('PluginConfigSchema — learning and consensus registration', () => {
	it('leaves both blocks undefined when omitted (optional)', () => {
		const parsed = PluginConfigSchema.parse({});
		expect(parsed.learning).toBeUndefined();
		expect(parsed.consensus).toBeUndefined();
	});

	it('applies nested defaults when the blocks are present but empty', () => {
		const parsed = PluginConfigSchema.parse({ learning: {}, consensus: {} });
		expect(parsed.learning?.realtime_admission.max_queue_size).toBe(50);
		expect(parsed.learning?.prm_persistence.enabled).toBe(true);
		expect(parsed.learning?.dedup_sweep.max_merges_per_sweep).toBe(10);
		expect(parsed.consensus?.default_min_support).toBe(3);
	});

	it('does not disturb the unrelated memory.learning (Q-learning) block', () => {
		// `memory.learning` is memory's Q-learning block and is a different key
		// at a different level from the new top-level `learning`.
		const parsed = PluginConfigSchema.parse({
			learning: { dedup_sweep: { enabled: false } },
			memory: {},
		});
		expect(parsed.learning?.dedup_sweep.enabled).toBe(false);
		expect(parsed.memory?.learning).toBeDefined();
		expect(
			(parsed.memory?.learning as Record<string, unknown> | undefined) ?? {},
		).not.toHaveProperty('dedup_sweep');
	});

	it('rejects an invalid nested learning value at the plugin level', () => {
		expect(
			PluginConfigSchema.safeParse({
				learning: { realtime_admission: { max_drain: 0 } },
			}).success,
		).toBe(false);
	});
});

describe('KnowledgeConfigSchema — promotion_require_actionable (#1821)', () => {
	it('defaults to true', () => {
		expect(KnowledgeConfigSchema.parse({}).promotion_require_actionable).toBe(
			true,
		);
	});

	it('accepts an explicit false override', () => {
		expect(
			KnowledgeConfigSchema.parse({ promotion_require_actionable: false })
				.promotion_require_actionable,
		).toBe(false);
	});

	it('rejects a non-boolean value', () => {
		expect(
			KnowledgeConfigSchema.safeParse({ promotion_require_actionable: 'yes' })
				.success,
		).toBe(false);
	});

	it('applies the default through PluginConfigSchema', () => {
		const parsed = PluginConfigSchema.parse({ knowledge: {} });
		expect(parsed.knowledge?.promotion_require_actionable).toBe(true);
	});
});
