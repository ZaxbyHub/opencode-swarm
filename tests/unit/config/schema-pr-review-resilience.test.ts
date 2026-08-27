import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('PluginConfigSchema pr_review_resilience', () => {
	it('keeps the policy optional and applies defaults when configured', () => {
		const absent = PluginConfigSchema.safeParse({});
		expect(absent.success).toBe(true);
		if (absent.success) {
			expect(absent.data.pr_review_resilience).toBeUndefined();
		}

		// Issue #2381: staged PR-review resilience defaults OFF. A project that
		// declares the block without an explicit `enabled` gets the legacy
		// single-wave base dispatch, not staged canary/fanout.
		const defaulted = PluginConfigSchema.safeParse({
			pr_review_resilience: {},
		});
		expect(defaulted.success).toBe(true);
		if (defaulted.success) {
			expect(defaulted.data.pr_review_resilience).toEqual({
				enabled: false,
				canary_probe_ms: 300_000,
				status_probe_timeout_ms: 2_000,
				correlated_failure_threshold: 2,
				max_retry_attempts_after_initial: 2,
			});
		}

		// Issue #2381: an explicit opt-in is still fully honored — the default flip
		// must not become an unconditional disable.
		const enabled = PluginConfigSchema.safeParse({
			pr_review_resilience: { enabled: true },
		});
		expect(enabled.success).toBe(true);
		if (enabled.success) {
			expect(enabled.data.pr_review_resilience?.enabled).toBe(true);
			expect(
				enabled.data.pr_review_resilience?.max_retry_attempts_after_initial,
			).toBe(2);
		}

		const disabled = PluginConfigSchema.safeParse({
			pr_review_resilience: { enabled: false },
		});
		expect(disabled.success).toBe(true);
		if (disabled.success) {
			expect(disabled.data.pr_review_resilience?.enabled).toBe(false);
			expect(
				disabled.data.pr_review_resilience?.max_retry_attempts_after_initial,
			).toBe(2);
		}
	});

	it('exports a default constant whose enabled flag matches the schema default', () => {
		// Issue #2381: the constant and the Zod default are two separate surfaces
		// that both feed production. A flip applied to only one of them would leave
		// staged resilience silently enabled on whichever path reads the other.
		expect(DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.enabled).toBe(false);
		const parsed = PluginConfigSchema.safeParse({ pr_review_resilience: {} });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.pr_review_resilience?.enabled).toBe(
				DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.enabled,
			);
		}
	});

	it('rejects malformed policy instead of silently weakening it', () => {
		for (const pr_review_resilience of [
			{ correlated_failure_threshold: 1 },
			{ max_retry_attempts_after_initial: 3 },
			{ status_probe_timeout_ms: 0 },
			{ unexpected_override: true },
		]) {
			expect(
				PluginConfigSchema.safeParse({ pr_review_resilience }).success,
			).toBe(false);
		}
	});
});
