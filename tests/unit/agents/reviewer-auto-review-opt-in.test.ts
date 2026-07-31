import { describe, expect, test } from 'bun:test';
import { createAgents } from '../../../src/agents';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';

function reviewerPrompt(autoReview: PluginConfig['auto_review']): string {
	const reviewer = createAgents({
		auto_review: autoReview,
	} as PluginConfig).find((agent) => agent.name === 'reviewer');
	return reviewer?.config.prompt ?? '';
}

describe('reviewer structured-output opt-in', () => {
	test('v7 omitted enabled preserves the legacy reviewer prompt', () => {
		const config = resolveAutoReviewConfig({}, { packageVersion: '7.99.0' });
		const prompt = reviewerPrompt(config);

		expect(config.enabled).toBe(false);
		expect(prompt).toContain(
			'ISSUES: list with line numbers, grouped by CHECK dimension',
		);
		expect(prompt).not.toContain('```json');
	});

	test('v7 explicit enabled requests structured reviewer findings', () => {
		const config = resolveAutoReviewConfig(
			{ enabled: true },
			{ packageVersion: '7.99.0' },
		);
		const prompt = reviewerPrompt(config);

		expect(prompt).toContain('ISSUES: none (see structured findings JSON)');
		expect(prompt).toContain('```json');
		expect(prompt).toContain('"confidence": 0.0');
	});

	test('approved v8 default requests structured reviewer findings', () => {
		const config = resolveAutoReviewConfig(
			{},
			{
				packageVersion: '8.0.0',
				burnInDecision: AUTO_REVIEW_V8_BURN_IN_DECISION,
			},
		);
		const prompt = reviewerPrompt(config);

		expect(config.enabled).toBe(true);
		expect(prompt).toContain('```json');
	});
});
