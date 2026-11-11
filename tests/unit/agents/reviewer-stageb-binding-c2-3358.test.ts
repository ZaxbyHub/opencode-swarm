// AC2 (trace 3358-3337-3341; #3337 AC1 reviewer leg): the reviewer Stage-B
// exemption must not key on a literal phrase in the default reviewer prompt.
//
// Pins:
// - The default reviewer agent prompt (createReviewerAgent('m').config.prompt,
//   src/agents/reviewer.ts — no exported prompt const, so the factory is the
//   seam) carries no literal-phrase "CONTROLLER-BOUND PR WORKFLOW CONTRACT"
//   Stage-B exemption: the phrase must not appear anywhere in the static
//   reviewer prompt, and no Stage-B suspension clause keyed on prompt text
//   may remain. The factory is mode-less, so any static exemption clause is
//   either unconditional or prose-triggered — both wrong; the PR-lane
//   suppression belongs to the controller-composed lane channel.
// - The Stage-B "STRUCTURED VERDICT LINE" mandate itself (the per-task
//   [REVIEWED] | task-<taskId> | VERDICT | summary row contract) remains
//   intact in the default reviewer prompt for non-PR reviews and its
//   consumer.
//
// RED at base, GREEN after the fix.
import { describe, expect, test } from 'bun:test';
import * as reviewerModule from '../../../src/agents/reviewer.js';

type ReviewerFactory = (
	model: string,
	customPrompt?: string,
) => { config?: { prompt?: string } };

const mod = reviewerModule as unknown as {
	createReviewerAgent?: ReviewerFactory;
};

function defaultReviewerPrompt(): string {
	expect(typeof mod.createReviewerAgent).toBe('function');
	const agent = mod.createReviewerAgent?.('m');
	const prompt = agent?.config?.prompt;
	expect(typeof prompt).toBe('string');
	expect((prompt ?? '').length).toBeGreaterThan(0);
	return prompt ?? '';
}

describe('AC2 — reviewer Stage-B exemption is not literal-phrase keyed (#3337)', () => {
	test('seam: createReviewerAgent factory yields a non-empty config prompt', () => {
		const prompt = defaultReviewerPrompt();
		expect(prompt.length).toBeGreaterThan(0);
	});

	test('default reviewer prompt carries no literal-phrase CONTROLLER-BOUND PR WORKFLOW CONTRACT exemption', () => {
		const prompt = defaultReviewerPrompt();
		// The defect: the Stage-B exemption activated when the model judged the
		// literal phrase present in its prompt, so any operator text quoting the
		// phrase suspended the Stage-B row. A static reviewer prompt that never
		// contains the phrase has no prose channel to trigger.
		expect(prompt).not.toContain('CONTROLLER-BOUND PR WORKFLOW CONTRACT');
		// And no Stage-B suspension clause may remain in the mode-less factory
		// prompt at all (the base text pairs "Stage-B task row is suspended").
		expect(prompt).not.toMatch(/Stage-B[^\n]{0,160}suspend/i);
	});

	test('Stage-B STRUCTURED VERDICT LINE mandate remains in the default reviewer prompt', () => {
		const prompt = defaultReviewerPrompt();
		expect(prompt).toContain('STRUCTURED VERDICT LINE');
		expect(prompt).toMatch(/\[REVIEWED\]/);
		expect(prompt).toContain('task-<taskId>');
	});
});
