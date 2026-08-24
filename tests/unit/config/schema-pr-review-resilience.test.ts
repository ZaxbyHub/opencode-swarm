import { describe, expect, it } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema';

describe('PluginConfigSchema pr_review_resilience', () => {
	it('keeps the policy optional and applies defaults when configured', () => {
		const absent = PluginConfigSchema.safeParse({});
		expect(absent.success).toBe(true);
		if (absent.success) {
			expect(absent.data.pr_review_resilience).toBeUndefined();
		}

		const enabled = PluginConfigSchema.safeParse({ pr_review_resilience: {} });
		expect(enabled.success).toBe(true);
		if (enabled.success) {
			expect(enabled.data.pr_review_resilience).toEqual({
				enabled: true,
				canary_probe_ms: 300_000,
				status_probe_timeout_ms: 2_000,
				correlated_failure_threshold: 2,
				max_retry_attempts_after_initial: 2,
			});
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
