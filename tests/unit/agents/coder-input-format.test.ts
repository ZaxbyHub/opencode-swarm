import { describe, expect, it } from 'bun:test';
import { createCoderAgent } from '../../../src/agents/coder';

/**
 * M15: the coder INPUT FORMAT block must document the optional ACCEPTANCE line
 * so structured acceptance / FR / SC criteria reach the delegated coder instead
 * of being lost as architect free-text. The field is optional — its absence is
 * explicitly declared non-blocking.
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
		expect(acceptanceLine).toContain('optional');
		expect(acceptanceLine).toContain('FR');
		expect(acceptanceLine).toContain('SC');
	});

	it('ACCEPTANCE is declared non-blocking when absent', () => {
		const acceptanceLine = prompt
			.split('\n')
			.find((line) => line.startsWith('ACCEPTANCE:'));
		// Absence must be explicitly normal so a coder never blocks on a missing field.
		expect(acceptanceLine?.toLowerCase()).toContain('absent');
	});
});
