import { describe, expect, test } from 'bun:test';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	type AutoReviewBurnInDecision,
	AutoReviewConfigSchema,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';

const APPROVED_DECISION: AutoReviewBurnInDecision = {
	...AUTO_REVIEW_V8_BURN_IN_DECISION,
};

describe('auto-review compatibility matrix', () => {
	test('current v7 schema remains opt-in with proposal defaults available', () => {
		const parsed = AutoReviewConfigSchema.parse({});
		expect(parsed.enabled).toBe(false);
		expect(parsed.trigger).toBe('phase_boundary');
		expect(parsed.min_confidence).toBe(0.7);
		expect(parsed.structured_findings).toBe(true);
		expect(parsed.validate_findings).toBe(false);
		expect(parsed.final_review).toEqual({
			on_phase_complete: true,
			on_plan_complete: true,
			model: null,
			mode: 'advisory',
			max_diff_bytes: 262_144,
			timeout_ms: 300_000,
		});
	});

	test('omitted enabled activates only for v8 plus a valid approved burn-in decision', () => {
		expect(
			resolveAutoReviewConfig(
				{},
				{ packageVersion: '7.999.0', burnInDecision: APPROVED_DECISION },
			).enabled,
		).toBe(false);
		expect(
			resolveAutoReviewConfig(
				{},
				{
					packageVersion: '8.0.0',
					burnInDecision: { ...APPROVED_DECISION, approved: false },
				},
			).enabled,
		).toBe(false);
		expect(
			resolveAutoReviewConfig(
				{},
				{
					packageVersion: '8.0.0',
					burnInDecision: {
						...APPROVED_DECISION,
						artifact_sha256: '0'.repeat(64),
					},
				},
			).enabled,
		).toBe(false);
		expect(
			resolveAutoReviewConfig(
				{},
				{ packageVersion: '8.0.0', burnInDecision: APPROVED_DECISION },
			).enabled,
		).toBe(true);
	});

	test('[review finding] rejects a syntactically valid hash that is not the pinned artifact identity', () => {
		const unpinnedDecision: AutoReviewBurnInDecision = {
			...APPROVED_DECISION,
			artifact_sha256: 'f'.repeat(64),
		};
		expect(
			resolveAutoReviewConfig(
				{},
				{ packageVersion: '8.0.0', burnInDecision: unpinnedDecision },
			).enabled,
		).toBe(false);
	});

	test('explicit enabled false always overrides the v8 derived default', () => {
		expect(
			resolveAutoReviewConfig(
				{ enabled: false },
				{ packageVersion: '8.0.0', burnInDecision: APPROVED_DECISION },
			).enabled,
		).toBe(false);
	});

	test('legacy limits feed final-review limits only when nested values are omitted', () => {
		const inherited = resolveAutoReviewConfig(
			{ timeout_ms: 45_000, max_diff_kb: 128 },
			{ packageVersion: '7.130.2', burnInDecision: APPROVED_DECISION },
		);
		expect(inherited.timeout_ms).toBe(45_000);
		expect(inherited.max_diff_kb).toBe(128);
		expect(inherited.final_review.timeout_ms).toBe(45_000);
		expect(inherited.final_review.max_diff_bytes).toBe(128 * 1024);

		const overridden = resolveAutoReviewConfig(
			{
				timeout_ms: 45_000,
				max_diff_kb: 128,
				final_review: {
					timeout_ms: 90_000,
					max_diff_bytes: 64_000,
				},
			},
			{ packageVersion: '7.130.2', burnInDecision: APPROVED_DECISION },
		);
		expect(overridden.final_review.timeout_ms).toBe(90_000);
		expect(overridden.final_review.max_diff_bytes).toBe(64_000);
	});

	test('trigger ownership and phase toggles remain explicit', () => {
		expect(
			resolveAutoReviewConfig({ trigger: 'task_completion' }).trigger,
		).toBe('task_completion');
		expect(resolveAutoReviewConfig({ trigger: 'both' }).trigger).toBe('both');
		expect(
			resolveAutoReviewConfig({
				trigger: 'phase_boundary',
				final_review: {
					on_phase_complete: false,
					on_plan_complete: true,
				},
			}).final_review,
		).toMatchObject({
			on_phase_complete: false,
			on_plan_complete: true,
		});
	});

	test('gate mode rejects legacy-only output configuration', () => {
		expect(() =>
			resolveAutoReviewConfig({
				structured_findings: false,
				final_review: { mode: 'gate' },
			}),
		).toThrow(/structured_findings/i);
	});
});
