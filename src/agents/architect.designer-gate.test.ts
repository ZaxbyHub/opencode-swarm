import { describe, expect, it, spyOn } from 'bun:test';
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

		it('excludes designer from knowledge directive delegation list', () => {
			expect(prompt).not.toContain(', or designer');
		});

		it('excludes designer from SKILL AGENT TARGET RENDERING section', () => {
			expect(prompt).not.toContain(
				"the active swarm's designer agent = @",
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

		it('excludes designer from knowledge directive delegation list', () => {
			expect(prompt).not.toContain(', or designer');
		});

		it('excludes designer from SKILL AGENT TARGET RENDERING section', () => {
			expect(prompt).not.toContain(
				"the active swarm's designer agent = @",
			);
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

		it('includes designer in knowledge directive delegation list', () => {
			expect(prompt).toContain(', or designer');
		});

		it('includes designer in SKILL AGENT TARGET RENDERING section', () => {
			expect(prompt).toContain(
				"the active swarm's designer agent = @",
			);
		});
	});

	describe('custom prompt designer-reference warning (issue #653)', () => {
		it('emits console.warn when custom prompt retains designer refs after stripping', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const customPrompt =
				'You are an architect. Delegate UI tasks to @designer for scaffold generation.';
			createArchitectAgent('test-model', customPrompt, undefined, undefined, undefined, {
				enabled: false,
			});
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('Custom architect prompt may still contain designer references'),
			);
			warnSpy.mockRestore();
		});

		it('emits console.warn when ui_review is absent (default) and custom prompt has designer refs', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const customPrompt = 'Architect prompt that mentions @designer agent.';
			createArchitectAgent('test-model', customPrompt);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[swarm] WARNING'),
			);
			warnSpy.mockRestore();
		});

		it('does NOT emit console.warn when ui_review is enabled, even with designer refs in custom prompt', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const customPrompt = 'Architect prompt that mentions @designer agent.';
			createArchitectAgent('test-model', customPrompt, undefined, undefined, undefined, {
				enabled: true,
			});
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Custom architect prompt may still contain designer references'),
			);
			warnSpy.mockRestore();
		});

		it('does NOT emit console.warn when default prompt is used and ui_review is disabled (stripping succeeds)', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			createArchitectAgent('test-model');
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Custom architect prompt may still contain designer references'),
			);
			warnSpy.mockRestore();
		});
	});
});
