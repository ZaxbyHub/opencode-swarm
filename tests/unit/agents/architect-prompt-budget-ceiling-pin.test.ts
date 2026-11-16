/**
 * PRR-013c: the prompt-budget ceiling constant lost its value ratchet — the
 * frozen C26 budget-matrix test derives all its bounds FROM the constant, so
 * a silent change of `ARCHITECT_PROMPT_BUDGET_CHARS` (163,000 → 164,000
 * happened exactly that way in #3315) moves every derived bound with it and
 * nothing anywhere fails. This pin asserts the literal ceiling AND that the
 * public documentation in docs/configuration.md still names the same value,
 * so constant drift and doc drift each fail here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHITECT_PROMPT_BUDGET_CHARS } from '../../../src/agents/architect';

describe('architect prompt budget ceiling pin (PRR-013c)', () => {
	test('the ceiling constant is pinned to the 165,000 literal', () => {
		// #3312/#3313 rebase bump: our honest-INCOMPLETE guidance + #3419's
		// recovery guidance measured 164,188 together; +1,000 round-step per
		// the documented precedent (#2703/#2971/#2946/#3315).
		expect(ARCHITECT_PROMPT_BUDGET_CHARS).toBe(165_000);
	});

	test('docs/configuration.md documents the same ceiling value', () => {
		const doc = readFileSync(
			join(import.meta.dir, '..', '..', '..', 'docs', 'configuration.md'),
			'utf8',
		);
		expect(doc).toMatch(
			new RegExp(
				`${ARCHITECT_PROMPT_BUDGET_CHARS.toLocaleString('en-US')} chars`,
			),
		);
	});
});
