import { describe, expect, it } from 'bun:test';
import { createCoderAgent } from '../../../src/agents/coder';

/**
 * M15 (superseded by issue #1687 task 2.1): the coder INPUT FORMAT block must
 * document the ACCEPTANCE line so structured acceptance / FR / SC criteria
 * reach the delegated coder instead of being lost as architect free-text.
 * Per #1687 FR-004/FR-005, the field is now REQUIRED and never empty: it
 * carries verbatim FR/SC text when the task maps to a spec requirement, or a
 * task-derived restatement of DONE when it does not — either way ACCEPTANCE
 * is always populated, never omitted.
 */
describe('M15: coder INPUT FORMAT carries ACCEPTANCE criteria', () => {
	const prompt = (
		createCoderAgent('anthropic/claude-x').config as { prompt: string }
	).prompt;

	it('INPUT FORMAT block includes an ACCEPTANCE line', () => {
		const inputFormatIndex = prompt.indexOf('INPUT FORMAT:');
		const acceptanceIndex = prompt.indexOf('ACCEPTANCE:');
		expect(inputFormatIndex).toBeGreaterThanOrEqual(0);
		expect(acceptanceIndex).toBeGreaterThan(inputFormatIndex);
	});

	it('ACCEPTANCE line sits inside INPUT FORMAT (before SKILLS)', () => {
		const acceptanceIndex = prompt.indexOf('ACCEPTANCE:');
		const skillsIndex = prompt.indexOf('SKILLS:');
		expect(acceptanceIndex).toBeGreaterThan(0);
		expect(skillsIndex).toBeGreaterThan(acceptanceIndex);
	});

	it('ACCEPTANCE references the FR/SC/acceptance criteria contract', () => {
		const acceptanceLine = prompt
			.split('\n')
			.find((line) => line.startsWith('ACCEPTANCE:'));
		expect(acceptanceLine).toBeDefined();
		expect(acceptanceLine).toContain('FR');
		expect(acceptanceLine).toContain('SC');
	});

	it('ACCEPTANCE is declared required and never empty (supersedes M15 "optional" wording)', () => {
		const acceptanceLine = prompt
			.split('\n')
			.find((line) => line.startsWith('ACCEPTANCE:'));
		// #1687 FR-004: absence of a spec mapping is normal, but the field itself
		// must never be empty — a coder never gets to treat ACCEPTANCE as optional.
		expect(acceptanceLine?.toLowerCase()).toContain('never empty');
		expect(acceptanceLine?.toLowerCase()).not.toContain('optional');
	});
});
