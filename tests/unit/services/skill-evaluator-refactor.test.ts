/**
 * Parity test proving the factored-out `scoreSkillPhrases` pure function
 * matches the original inline `evaluateContent` behavior (D1 refactor, issue
 * #1822). This is the regression guard that justifies "no duplicate scorer":
 * the substrate's project-scorer wrapper calls the SAME function the internal
 * gate uses.
 */

import { describe, expect, it } from 'bun:test';
import { scoreSkillPhrases } from '../../../src/services/skill-evaluator.js';

describe('scoreSkillPhrases parity (D1 refactor)', () => {
	it('scores 1 when all required phrases are present and no forbidden', () => {
		const r = scoreSkillPhrases({
			content: 'use the trigger when delegating',
			required: ['trigger', 'when'],
			forbidden: [],
		});
		expect(r.score).toBe(1);
		expect(r.failures).toHaveLength(0);
	});

	it('scores proportionally when some required phrases are missing', () => {
		const r = scoreSkillPhrases({
			content: 'use the trigger',
			required: ['trigger', 'when', 'how'],
			forbidden: [],
		});
		// 1 hit / 3 required = 0.333...
		expect(r.score).toBeCloseTo(1 / 3, 5);
		expect(r.failures).toHaveLength(2);
	});

	it('scores 1 when there are no required phrases and no forbidden', () => {
		const r = scoreSkillPhrases({
			content: 'anything',
			required: [],
			forbidden: [],
		});
		expect(r.score).toBe(1);
	});

	it('applies a 1-point penalty (clamped to 0) when a forbidden phrase is present', () => {
		const r = scoreSkillPhrases({
			content: 'use the trigger when delegating',
			required: ['trigger', 'when'],
			forbidden: ['shortcut'],
		});
		expect(r.score).toBe(1);
		const r2 = scoreSkillPhrases({
			content: 'use the trigger shortcut when delegating',
			required: ['trigger', 'when'],
			forbidden: ['shortcut'],
		});
		expect(r2.score).toBe(0);
		expect(r2.failures.some((f) => f.includes('forbidden'))).toBe(true);
	});

	it('matches phrases case-insensitively as substrings', () => {
		const r = scoreSkillPhrases({
			content: 'REVIEWER must CHECK',
			required: ['reviewer', 'check'],
			forbidden: [],
		});
		expect(r.score).toBe(1);
	});

	it('clamps a partial-plus-forbidden to 0, never negative', () => {
		const r = scoreSkillPhrases({
			content: 'use the shortcut',
			required: ['trigger', 'when'],
			forbidden: ['shortcut'],
		});
		// requiredScore = 0/2 = 0, minus 1 penalty = -1, clamped to 0.
		expect(r.score).toBe(0);
	});
});
