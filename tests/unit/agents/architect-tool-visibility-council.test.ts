import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * Tool visibility sync — council-only tools (submit_council_verdicts and
 * declare_council_criteria) must only appear in YOUR TOOLS and Available
 * Tools when council.enabled === true. Otherwise the runtime gate at
 * src/hooks/convene-council.ts will reject any model attempt to call them.
 */

function getYourToolsSection(prompt: string): string {
	const match = prompt.match(/YOUR TOOLS:\s*(.+?)(?:\n|$)/);
	return match?.[1] ?? '';
}

function getAvailableToolsSection(prompt: string): string {
	const match = prompt.match(/Available Tools:\s*([\s\S]*?)(?:\n##|$)/);
	return match?.[1] ?? '';
}

describe('architect prompt — council tool visibility', () => {
	describe('council undefined (config key absent)', () => {
		const agent = createArchitectAgent('test-model');
		const prompt = (agent.config as Record<string, unknown>).prompt as string;

		test('YOUR TOOLS does not contain submit_council_verdicts', () => {
			expect(getYourToolsSection(prompt)).not.toContain(
				'submit_council_verdicts',
			);
		});

		test('YOUR TOOLS does not contain declare_council_criteria', () => {
			expect(getYourToolsSection(prompt)).not.toContain(
				'declare_council_criteria',
			);
		});

		test('Available Tools does not contain submit_council_verdicts', () => {
			expect(getAvailableToolsSection(prompt)).not.toContain(
				'submit_council_verdicts',
			);
		});

		test('Available Tools does not contain declare_council_criteria', () => {
			expect(getAvailableToolsSection(prompt)).not.toContain(
				'declare_council_criteria',
			);
		});
	});

	describe('council.enabled === false', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: false },
		);
		const prompt = (agent.config as Record<string, unknown>).prompt as string;

		test('YOUR TOOLS does not contain submit_council_verdicts', () => {
			expect(getYourToolsSection(prompt)).not.toContain(
				'submit_council_verdicts',
			);
		});

		test('YOUR TOOLS does not contain declare_council_criteria', () => {
			expect(getYourToolsSection(prompt)).not.toContain(
				'declare_council_criteria',
			);
		});

		test('Available Tools does not contain submit_council_verdicts', () => {
			expect(getAvailableToolsSection(prompt)).not.toContain(
				'submit_council_verdicts',
			);
		});

		test('Available Tools does not contain declare_council_criteria', () => {
			expect(getAvailableToolsSection(prompt)).not.toContain(
				'declare_council_criteria',
			);
		});
	});

	describe('council.enabled === true', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true },
		);
		const prompt = (agent.config as Record<string, unknown>).prompt as string;

		test('YOUR TOOLS contains submit_council_verdicts', () => {
			expect(getYourToolsSection(prompt)).toContain('submit_council_verdicts');
		});

		test('YOUR TOOLS contains declare_council_criteria', () => {
			expect(getYourToolsSection(prompt)).toContain('declare_council_criteria');
		});

		test('Available Tools contains submit_council_verdicts', () => {
			expect(getAvailableToolsSection(prompt)).toContain(
				'submit_council_verdicts',
			);
		});

		test('Available Tools contains declare_council_criteria', () => {
			expect(getAvailableToolsSection(prompt)).toContain(
				'declare_council_criteria',
			);
		});
	});
});
