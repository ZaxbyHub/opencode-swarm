/**
 * Snapshot/contract test for the reviewer DIRECTIVE_COMPLIANCE surface
 * (Swarm Learning System, Change 2 / Task 2.1).
 *
 * Verifies (a) the dynamic "directives to verify" block is deterministic and
 * carries the verdict grammar + predicate-run instruction, and (b) the static
 * reviewer prompt documents the DIRECTIVE_COMPLIANCE output section while leaving
 * SKILL_COMPLIANCE intact.
 */

import { describe, expect, it } from 'bun:test';
import { createReviewerAgent } from '../../../src/agents/reviewer.js';
import {
	buildDirectiveComplianceBlock,
	type DirectiveToVerify,
} from '../../../src/agents/reviewer-directive-compliance.js';

describe('buildDirectiveComplianceBlock', () => {
	it('renders a deterministic block (priority then id) with predicate instructions', () => {
		const directives: DirectiveToVerify[] = [
			{ id: 'd-med', priority: 'medium', lesson: 'Document edge cases' },
			{
				id: 'd-crit',
				priority: 'critical',
				lesson: 'No async iterators in hot paths',
				verification_predicate: 'grep:async iterator:src/**/*.ts',
			},
			{ id: 'd-high', priority: 'high', lesson: 'Validate at the edge' },
		];

		const block = buildDirectiveComplianceBlock(directives);

		const expected = [
			'<directives_to_verify>',
			'Produce a DIRECTIVE_COMPLIANCE verdict for EVERY id below. Run any verification_predicate provided.',
			'- id: d-crit',
			'  priority: critical',
			'  lesson: No async iterators in hot paths',
			'  verification_predicate: grep:async iterator:src/**/*.ts',
			'- id: d-high',
			'  priority: high',
			'  lesson: Validate at the edge',
			'- id: d-med',
			'  priority: medium',
			'  lesson: Document edge cases',
			'</directives_to_verify>',
			'',
			'DIRECTIVE_COMPLIANCE: one line per knowledge directive shown during this phase (the IDs are listed in the DIRECTIVES TO VERIFY block of your prompt). Use exactly one of:',
			'  VERIFIED:<id> evidence=<file:line | predicate_passed>',
			'  VIOLATED:<id> evidence=<file:line | failing_predicate>',
			'  N/A:<id> reason=<why it does not apply to this change>',
			'Every listed directive ID MUST appear exactly once. If a directive carries a verification_predicate, you MUST run it and report predicate_passed / failing_predicate as the evidence. Omitting a listed directive ID is itself a VIOLATED verdict.',
		].join('\n');

		expect(block).toBe(expected);
	});

	it('returns null when there are no directives to verify', () => {
		expect(buildDirectiveComplianceBlock([])).toBeNull();
	});

	it('omits optional fields that are absent', () => {
		const block = buildDirectiveComplianceBlock([
			{ id: 'd-1', priority: 'high' },
		]);
		expect(block).toContain('- id: d-1');
		expect(block).toContain('  priority: high');
		expect(block).not.toContain('lesson:');
		expect(block).not.toContain('verification_predicate:');
	});
});

describe('reviewer prompt — DIRECTIVE_COMPLIANCE output section', () => {
	const prompt = createReviewerAgent('test-model').config.prompt as string;

	it('documents the DIRECTIVE_COMPLIANCE output section', () => {
		expect(prompt).toContain('DIRECTIVE_COMPLIANCE:');
		expect(prompt).toContain('VERIFIED:<id>');
		expect(prompt).toContain('VIOLATED:<id>');
		expect(prompt).toContain('N/A:<id>');
	});

	it('instructs the reviewer to run a verification_predicate', () => {
		expect(prompt).toContain('verification_predicate');
		expect(prompt.toLowerCase()).toContain('run it');
	});

	it('leaves the existing SKILL_COMPLIANCE section intact', () => {
		expect(prompt).toContain(
			'SKILL_COMPLIANCE: COMPLIANT | PARTIAL | VIOLATED',
		);
	});

	it('keeps VERDICT as the leading output field', () => {
		expect(prompt).toContain('VERDICT: APPROVED | REJECTED');
	});
});
