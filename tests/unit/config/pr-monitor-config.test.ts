/**
 * Phase 1 PR Monitor infrastructure — PrMonitorConfigSchema validation tests.
 * Tests: valid configs parse, invalid configs reject, defaults are correct.
 */
import { describe, expect, test } from 'bun:test';
import {
	PluginConfigSchema,
	type PrMonitorConfig,
	PrMonitorConfigSchema,
} from '../../../src/config/schema';

describe('PrMonitorConfigSchema', () => {
	describe('valid configs parse correctly', () => {
		test('empty object uses all defaults', () => {
			const result = PrMonitorConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (!result.success) return;
			const cfg = result.data;
			expect(cfg.enabled).toBe(false);
			expect(cfg.poll_interval_seconds).toBe(60);
			expect(cfg.max_subscriptions).toBe(20);
			expect(cfg.max_prs_per_cycle).toBe(5);
			expect(cfg.max_concurrent_pr_polls).toBe(3);
			expect(cfg.poll_timeout_ms).toBe(30_000);
			expect(cfg.failure_threshold).toBe(5);
			expect(cfg.cooldown_seconds).toBe(30);
			expect(cfg.max_cooldown_seconds).toBe(300);
			expect(cfg.cleanup_ttl_days).toBe(7);
			expect(cfg.auto_unsubscribe_on_merge).toBe(true);
			expect(cfg.auto_unsubscribe_on_close).toBe(true);
			expect(cfg.notify_ci_failure).toBe(true);
			expect(cfg.notify_new_comments).toBe(true);
			expect(cfg.notify_merge_conflict).toBe(true);
			expect(cfg.auto_pr_feedback).toBe(false);
		});

		test('all fields provided parse correctly', () => {
			const input = {
				enabled: true,
				poll_interval_seconds: 120,
				max_subscriptions: 50,
				max_prs_per_cycle: 10,
				max_concurrent_pr_polls: 5,
				poll_timeout_ms: 60_000,
				failure_threshold: 10,
				cooldown_seconds: 60,
				max_cooldown_seconds: 600,
				cleanup_ttl_days: 14,
				auto_unsubscribe_on_merge: false,
				auto_unsubscribe_on_close: false,
				notify_ci_failure: false,
				notify_new_comments: false,
				notify_merge_conflict: false,
				auto_pr_feedback: true,
			};
			const result = PrMonitorConfigSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data).toEqual(input);
		});

		test('auto_pr_feedback defaults to false when config is empty', () => {
			const result = PrMonitorConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.auto_pr_feedback).toBe(false);
		});

		test('auto_pr_feedback can be set to true', () => {
			const result = PrMonitorConfigSchema.safeParse({
				auto_pr_feedback: true,
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.auto_pr_feedback).toBe(true);
		});

		test('partial input merges with defaults', () => {
			const result = PrMonitorConfigSchema.safeParse({ enabled: true });
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.enabled).toBe(true);
			expect(result.data.poll_interval_seconds).toBe(60); // default
			expect(result.data.max_subscriptions).toBe(20); // default
		});
	});

	describe('boundary values', () => {
		test('poll_interval_seconds min boundary (30)', () => {
			const result = PrMonitorConfigSchema.safeParse({
				poll_interval_seconds: 30,
			});
			expect(result.success).toBe(true);
		});

		test('poll_interval_seconds max boundary (300)', () => {
			const result = PrMonitorConfigSchema.safeParse({
				poll_interval_seconds: 300,
			});
			expect(result.success).toBe(true);
		});

		test('poll_interval_seconds below min (29) rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({
				poll_interval_seconds: 29,
			});
			expect(result.success).toBe(false);
		});

		test('poll_interval_seconds above max (301) rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({
				poll_interval_seconds: 301,
			});
			expect(result.success).toBe(false);
		});

		test('max_subscriptions min boundary (1)', () => {
			const result = PrMonitorConfigSchema.safeParse({ max_subscriptions: 1 });
			expect(result.success).toBe(true);
		});

		test('max_subscriptions max boundary (100)', () => {
			const result = PrMonitorConfigSchema.safeParse({
				max_subscriptions: 100,
			});
			expect(result.success).toBe(true);
		});

		test('poll_timeout_ms min boundary (5000)', () => {
			const result = PrMonitorConfigSchema.safeParse({ poll_timeout_ms: 5000 });
			expect(result.success).toBe(true);
		});

		test('poll_timeout_ms max boundary (120000)', () => {
			const result = PrMonitorConfigSchema.safeParse({
				poll_timeout_ms: 120_000,
			});
			expect(result.success).toBe(true);
		});

		test('cleanup_ttl_days min boundary (1)', () => {
			const result = PrMonitorConfigSchema.safeParse({ cleanup_ttl_days: 1 });
			expect(result.success).toBe(true);
		});

		test('cleanup_ttl_days max boundary (90)', () => {
			const result = PrMonitorConfigSchema.safeParse({ cleanup_ttl_days: 90 });
			expect(result.success).toBe(true);
		});
	});

	describe('invalid configs reject correctly', () => {
		test('unknown field rejects (strict mode)', () => {
			const result = PrMonitorConfigSchema.safeParse({
				enabled: true,
				unknown_field: 'invalid',
			});
			expect(result.success).toBe(false);
		});

		test('poll_interval_seconds as string rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({
				poll_interval_seconds: '60',
			});
			expect(result.success).toBe(false);
		});

		test('enabled as number rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({ enabled: 1 });
			expect(result.success).toBe(false);
		});

		test('negative max_subscriptions rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({ max_subscriptions: -1 });
			expect(result.success).toBe(false);
		});

		test('cooldown_seconds as float rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({
				cooldown_seconds: 30.5,
			});
			expect(result.success).toBe(false);
		});

		test('notify_ci_failure as string rejects', () => {
			const result = PrMonitorConfigSchema.safeParse({
				notify_ci_failure: 'true',
			});
			expect(result.success).toBe(false);
		});
	});

	describe('PluginConfigSchema integration', () => {
		test('pr_monitor field accepted in plugin config', () => {
			const result = PluginConfigSchema.safeParse({
				pr_monitor: {
					enabled: true,
					poll_interval_seconds: 45,
				},
			});
			expect(result.success).toBe(true);
		});

		test('pr_monitor field omitted uses defaults', () => {
			const result = PluginConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.pr_monitor).toBeUndefined();
		});

		test('pr_monitor field with invalid nested config rejects', () => {
			const result = PluginConfigSchema.safeParse({
				pr_monitor: { poll_interval_seconds: 500 },
			});
			expect(result.success).toBe(false);
		});
	});
});
