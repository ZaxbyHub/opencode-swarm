import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from './architect';

describe('createArchitectAgent — designer gate (ui_review)', () => {
	describe('when ui_review is not enabled (default)', () => {
		const agent = createArchitectAgent('test-model');
		const prompt = agent.config.prompt ?? '';

		it('excludes designer from the "Your agents" identity line', () => {
			const agentsLine = prompt
				.split('\n')
				.find((l) => l.startsWith('Your agents:'));
			expect(agentsLine).toBeDefined();
			expect(agentsLine).not.toContain('designer');
		});

		it('excludes designer from the ## AGENTS section', () => {
			expect(prompt).not.toContain('designer - UI/UX design specs');
		});

		it('excludes Rule 9 (UI/UX DESIGN GATE) from behavioral rules', () => {
			expect(prompt).not.toContain('UI/UX DESIGN GATE');
		});

		it('excludes the designer delegation example', () => {
			expect(prompt).not.toContain(
				'TASK: Design specification for user settings page',
			);
		});

		it('excludes the 5a pipeline step', () => {
			expect(prompt).not.toContain('5a. **UI DESIGN GATE**');
		});

		it('removes designer scaffold mention from coder step 5b', () => {
			expect(prompt).not.toContain(
				'if designer scaffold produced, include it as INPUT',
			);
		});

		it('simplifies the step-5a transition instruction', () => {
			expect(prompt).not.toContain(
				'After step 5a (or immediately if no UI task applies)',
			);
		});
	});

	describe('when ui_review is explicitly disabled', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			undefined,
			{
				enabled: false,
			},
		);
		const prompt = agent.config.prompt ?? '';

		it('excludes designer from the "Your agents" identity line', () => {
			const agentsLine = prompt
				.split('\n')
				.find((l) => l.startsWith('Your agents:'));
			expect(agentsLine).not.toContain('designer');
		});

		it('excludes Rule 9 (UI/UX DESIGN GATE)', () => {
			expect(prompt).not.toContain('UI/UX DESIGN GATE');
		});
	});

	describe('when ui_review.enabled is true', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			undefined,
			{
				enabled: true,
			},
		);
		const prompt = agent.config.prompt ?? '';

		it('includes designer in the "Your agents" identity line', () => {
			const agentsLine = prompt
				.split('\n')
				.find((l) => l.startsWith('Your agents:'));
			expect(agentsLine).toBeDefined();
			expect(agentsLine).toContain('designer');
		});

		it('includes designer in the ## AGENTS section', () => {
			expect(prompt).toContain('designer - UI/UX design specs');
		});

		it('includes Rule 9 (UI/UX DESIGN GATE)', () => {
			expect(prompt).toContain('UI/UX DESIGN GATE');
		});

		it('includes the 5a pipeline step', () => {
			expect(prompt).toContain('5a. **UI DESIGN GATE**');
		});
	});
});
