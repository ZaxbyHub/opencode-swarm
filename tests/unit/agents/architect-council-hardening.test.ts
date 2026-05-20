import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * Hardening regression: custom architect prompt override must not silently
 * strip the council workflow when council.enabled === true.
 *
 * Before the hardening, a user-supplied ~/.config/opencode/prompts/architect.md
 * replaced ARCHITECT_PROMPT wholesale. The later
 * `prompt.replace('{{COUNCIL_WORKFLOW}}', councilBlock)` became a no-op because
 * the placeholder was absent from the custom prompt. Council was silently
 * disabled even though config said otherwise — the same class of silent
 * failure as the original missing-tool-registration bug.
 *
 * Fix: when council is enabled and the rendered prompt has no placeholder,
 * append the council block instead of no-oping.
 */
describe('architect custom prompt override + council hardening', () => {
	test('custom prompt without {{COUNCIL_WORKFLOW}} still receives council block when enabled', () => {
		const customPrompt = 'YOUR CUSTOM PROMPT\n\nNo placeholder here.';
		const agent = createArchitectAgent(
			'test-model',
			customPrompt,
			undefined,
			undefined,
			{ enabled: true },
		);
		const rendered =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		expect(rendered.startsWith(customPrompt)).toBe(true);
		expect(rendered).toContain('COUNCIL WORKFLOW');
		expect(rendered).toContain('submit_phase_council_verdicts');
		expect(rendered).toContain('phase council');
	});

	test('custom prompt without placeholder stays clean when council disabled', () => {
		const customPrompt = 'YOUR CUSTOM PROMPT';
		const agent = createArchitectAgent(
			'test-model',
			customPrompt,
			undefined,
			undefined,
			{ enabled: false },
		);
		const rendered =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		expect(rendered).not.toContain('COUNCIL WORKFLOW');
		expect(rendered).not.toContain('{{COUNCIL_WORKFLOW}}');
	});

	test('default (no custom prompt) + council enabled still substitutes placeholder in place', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true },
		);
		const rendered =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		expect(rendered).toContain('COUNCIL WORKFLOW');
		expect(rendered).not.toContain('{{COUNCIL_WORKFLOW}}');
	});

	test('append prompt path preserves placeholder and council block is injected', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			'APPENDED NOTES',
			undefined,
			{ enabled: true },
		);
		const rendered =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		expect(rendered).toContain('COUNCIL WORKFLOW');
		expect(rendered).toContain('APPENDED NOTES');
		expect(rendered).not.toContain('{{COUNCIL_WORKFLOW}}');
	});
});
