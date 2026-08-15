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
	parseDirectivesToVerifyBlock,
} from '../../../src/agents/reviewer-directive-compliance.js';

describe('buildDirectiveComplianceBlock', () => {
	it('renders a deterministic block (priority then id) with predicate instructions', () => {
		const directives: DirectiveToVerify[] = [
			{
				trace_id: 'trace-med',
				entry_id: 'd-med',
				session_id: 'session-1',
				priority: 'medium',
				lesson: 'Document edge cases',
			},
			{
				trace_id: 'trace-crit',
				entry_id: 'd-crit',
				session_id: 'session-1',
				priority: 'critical',
				lesson: 'No async iterators in hot paths',
				verification_predicate: 'grep:async iterator:src/**/*.ts',
			},
			{
				trace_id: 'trace-high',
				entry_id: 'd-high',
				session_id: 'session-1',
				priority: 'high',
				lesson: 'Validate at the edge',
			},
		];

		const block = buildDirectiveComplianceBlock(directives);

		const expected = [
			'<directives_to_verify>',
			'Produce a DIRECTIVE_COMPLIANCE verdict for EVERY trace_id + entry_id pair below. Copy the encoded tokens exactly and run any verification_predicate provided.',
			'- trace_id: trace-crit',
			'  entry_id: d-crit',
			'  session_id: session-1',
			'  priority: critical',
			'  lesson: "No async iterators in hot paths"',
			'  verification_predicate: "grep:async iterator:src/**/*.ts"',
			'- trace_id: trace-high',
			'  entry_id: d-high',
			'  session_id: session-1',
			'  priority: high',
			'  lesson: "Validate at the edge"',
			'- trace_id: trace-med',
			'  entry_id: d-med',
			'  session_id: session-1',
			'  priority: medium',
			'  lesson: "Document edge cases"',
			'</directives_to_verify>',
			'',
			'DIRECTIVE_COMPLIANCE: one line per retrieval membership shown during this phase. Copy the encoded trace_id and entry_id tokens exactly from the DIRECTIVES TO VERIFY block. Use exactly one of:',
			'  VERIFIED:<trace_id>:<entry_id> evidence=<file:line | predicate_passed>',
			'  VIOLATED:<trace_id>:<entry_id> evidence=<file:line | failing_predicate>',
			'  N/A:<trace_id>:<entry_id> reason=<why it does not apply to this change>',
			'Every listed trace_id + entry_id pair MUST appear exactly once. The same entry_id may appear under more than one trace_id and requires one verdict per pair. If a directive carries a verification_predicate, you MUST run it and report predicate_passed / failing_predicate as the evidence. Omitting a listed CRITICAL pair is itself a VIOLATED verdict.',
		].join('\n');

		expect(block).toBe(expected);
	});

	it('returns null when there are no directives to verify', () => {
		expect(buildDirectiveComplianceBlock([])).toBeNull();
	});

	it('omits optional fields that are absent', () => {
		const block = buildDirectiveComplianceBlock([
			{
				trace_id: 'trace-1',
				entry_id: 'd-1',
				session_id: 'session-1',
				priority: 'high',
			},
		]);
		expect(block).toContain('- trace_id: trace-1');
		expect(block).toContain('  entry_id: d-1');
		expect(block).toContain('  priority: high');
		expect(block).not.toContain('lesson:');
		expect(block).not.toContain('verification_predicate:');
	});

	it('round-trips every exact trace-entry pair, including repeated entries', () => {
		const directives: DirectiveToVerify[] = [
			{
				trace_id: 'trace:a with spaces',
				entry_id: 'shared:entry',
				session_id: 'session:a',
				cohort_id: 'cohort:a',
				source_link_id: 'link:a',
				prior_terminal_outcome: 'violated',
				prior_terminal_event_id: 'terminal:event:a',
				priority: 'critical',
				lesson: 'A lesson\nthat cannot inject a fake record',
			},
			{
				trace_id: 'trace:b',
				entry_id: 'shared:entry',
				session_id: 'session:b',
				priority: 'high',
				verification_predicate: 'grep:value:src/**/*.ts',
			},
		];

		const block = buildDirectiveComplianceBlock(directives);
		expect(block).not.toBeNull();
		expect(parseDirectivesToVerifyBlock(block ?? '')).toEqual(directives);
	});

	it('rejects an incomplete or malformed correlation record', () => {
		const prompt = [
			'<directives_to_verify>',
			'- trace_id: bad%ZZ',
			'  entry_id: entry-1',
			'  session_id: session-1',
			'  priority: critical',
			'- trace_id: trace-2',
			'  entry_id: entry-2',
			'  priority: high',
			'- trace_id: trace-3',
			'  entry_id: entry-3',
			'  session_id: session-3',
			'  prior_terminal_outcome: violated',
			'  priority: high',
			'</directives_to_verify>',
		].join('\n');

		expect(parseDirectivesToVerifyBlock(prompt)).toEqual([]);
	});
});

describe('reviewer prompt — DIRECTIVE_COMPLIANCE output section', () => {
	const prompt = createReviewerAgent('test-model').config.prompt as string;

	it('documents the DIRECTIVE_COMPLIANCE output section', () => {
		expect(prompt).toContain('DIRECTIVE_COMPLIANCE:');
		expect(prompt).toContain('VERIFIED:<trace_id>:<entry_id>');
		expect(prompt).toContain('VIOLATED:<trace_id>:<entry_id>');
		expect(prompt).toContain('N/A:<trace_id>:<entry_id>');
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
