import { describe, expect, test } from 'bun:test';
import { parseCriticResponseFields } from '../../../src/full-auto/critic-response-parser';

const FULL_RESPONSE = `VERDICT: APPROVED
REASONING: All checks passed
EVIDENCE_CHECKED: diff,tests
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

describe('parseCriticResponseFields', () => {
	describe('default verdict allowlist', () => {
		test('accepts all default verdicts', () => {
			const verdicts = [
				'APPROVED',
				'NEEDS_REVISION',
				'REJECTED',
				'BLOCKED',
				'ANSWER',
				'ESCALATE_TO_HUMAN',
				'REPHRASE',
				'PENDING',
			];
			for (const v of verdicts) {
				const r = parseCriticResponseFields(
					`VERDICT: ${v}\nREASONING: ok\nESCALATION_NEEDED: NO`,
				);
				expect(r.verdict).toBe(v);
			}
		});

		test('rejects unknown verdict and defaults to NEEDS_REVISION', () => {
			const r = parseCriticResponseFields(
				'VERDICT: TOTALLY_UNKNOWN\nREASONING: x\nESCALATION_NEEDED: NO',
			);
			expect(r.verdict).toBe('NEEDS_REVISION');
		});
	});

	describe('validVerdicts override', () => {
		test('accepts only verdicts in the custom list', () => {
			const r = parseCriticResponseFields(
				'VERDICT: APPROVED\nREASONING: ok\nESCALATION_NEEDED: NO',
				{ validVerdicts: ['CUSTOM_OK'] },
			);
			expect(r.verdict).toBe('NEEDS_REVISION');
		});

		test('accepts a verdict that is in the custom list but not the default', () => {
			const r = parseCriticResponseFields(
				'VERDICT: CUSTOM_OK\nREASONING: ok\nESCALATION_NEEDED: NO',
				{ validVerdicts: ['CUSTOM_OK'] },
			);
			expect(r.verdict).toBe('CUSTOM_OK');
		});

		test('rejects PENDING when not in custom validVerdicts', () => {
			const r = parseCriticResponseFields(
				'VERDICT: PENDING\nREASONING: waiting\nESCALATION_NEEDED: NO',
				{ validVerdicts: ['APPROVED', 'NEEDS_REVISION'] },
			);
			expect(r.verdict).toBe('NEEDS_REVISION');
		});
	});

	describe('onUnknownVerdict callback', () => {
		test('invoked with raw value on unknown verdict', () => {
			const captured: string[] = [];
			parseCriticResponseFields(
				'VERDICT: BAD_VALUE\nREASONING: x\nESCALATION_NEEDED: NO',
				{ onUnknownVerdict: (v) => captured.push(v) },
			);
			expect(captured).toHaveLength(1);
			expect(captured[0]).toContain('BAD_VALUE');
		});

		test('not invoked for a valid verdict', () => {
			const captured: string[] = [];
			parseCriticResponseFields(FULL_RESPONSE, {
				onUnknownVerdict: (v) => captured.push(v),
			});
			expect(captured).toHaveLength(0);
		});

		test('invoked for unknown verdict even when custom validVerdicts is supplied', () => {
			const captured: string[] = [];
			parseCriticResponseFields(
				'VERDICT: APPROVED\nREASONING: x\nESCALATION_NEEDED: NO',
				{
					validVerdicts: ['NEEDS_REVISION'],
					onUnknownVerdict: (v) => captured.push(v),
				},
			);
			expect(captured).toHaveLength(1);
		});
	});

	describe('field parsing', () => {
		test('parses all fields from a complete response', () => {
			const r = parseCriticResponseFields(FULL_RESPONSE);
			expect(r.verdict).toBe('APPROVED');
			expect(r.reasoning).toBe('All checks passed');
			expect(r.evidenceChecked).toEqual(['diff', 'tests']);
			expect(r.antiPatternsDetected).toHaveLength(0);
			expect(r.escalationNeeded).toBe(false);
			expect(r.rawResponse).toBe(FULL_RESPONSE);
		});

		test('parses ESCALATION_NEEDED YES', () => {
			const r = parseCriticResponseFields(
				'VERDICT: ESCALATE_TO_HUMAN\nREASONING: risky\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: YES',
			);
			expect(r.escalationNeeded).toBe(true);
		});

		test('treats "none" evidence as empty array', () => {
			const r = parseCriticResponseFields(
				'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
			);
			expect(r.evidenceChecked).toHaveLength(0);
			expect(r.antiPatternsDetected).toHaveLength(0);
		});

		test('preserves multi-line reasoning', () => {
			const r = parseCriticResponseFields(
				'VERDICT: APPROVED\nREASONING: first line\n  continuation\nEVIDENCE_CHECKED: none\nESCALATION_NEEDED: NO',
			);
			expect(r.reasoning).toContain('first line');
			expect(r.reasoning).toContain('continuation');
		});

		test('strips backticks and asterisks from verdict', () => {
			const r = parseCriticResponseFields(
				'VERDICT: **APPROVED**\nREASONING: ok\nESCALATION_NEEDED: NO',
			);
			expect(r.verdict).toBe('APPROVED');
		});

		test('defaults verdict to NEEDS_REVISION when VERDICT field is absent', () => {
			const r = parseCriticResponseFields(
				'REASONING: no verdict here\nESCALATION_NEEDED: NO',
			);
			expect(r.verdict).toBe('NEEDS_REVISION');
		});

		test('preserves rawResponse field unchanged', () => {
			const raw = 'VERDICT: APPROVED\nREASONING: test';
			const r = parseCriticResponseFields(raw);
			expect(r.rawResponse).toBe(raw);
		});
	});
});
