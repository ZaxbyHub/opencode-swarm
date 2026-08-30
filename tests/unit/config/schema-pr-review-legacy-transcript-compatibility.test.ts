import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_PR_REVIEW_LEGACY_TRANSCRIPT_COMPATIBILITY,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('PluginConfigSchema pr_review_legacy_transcript_compatibility', () => {
	it('defaults to the exported resolved policy when omitted', () => {
		const parsed = PluginConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.pr_review_legacy_transcript_compatibility).toBe(
				undefined,
			);
			expect(
				parsed.data.pr_review_legacy_transcript_compatibility ??
					DEFAULT_PR_REVIEW_LEGACY_TRANSCRIPT_COMPATIBILITY,
			).toBe(false);
		}
	});

	it('accepts explicit boolean opt-in and opt-out', () => {
		for (const value of [true, false]) {
			const parsed = PluginConfigSchema.safeParse({
				pr_review_legacy_transcript_compatibility: value,
			});
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.pr_review_legacy_transcript_compatibility).toBe(
					value,
				);
			}
		}
	});

	it('rejects non-boolean values', () => {
		for (const value of ['true', 1, null, {}, []]) {
			expect(
				PluginConfigSchema.safeParse({
					pr_review_legacy_transcript_compatibility: value,
				}).success,
			).toBe(false);
		}
	});
});
