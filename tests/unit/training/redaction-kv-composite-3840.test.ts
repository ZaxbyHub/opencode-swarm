/**
 * #3840 (PR #3905 closeout, self-caught in the disposition audit): the
 * training key/value arm consumes a COMPOSITE value whole and treats a value
 * made only of placeholders as a fixed point.
 *
 * The placeholder guard this PR first added made the arm skip any value that
 * STARTS with `<redacted` — so `password=<redacted:github>.TailSecret` kept
 * its tail, where the merge-base arm consumed the whole value. The arm now
 * exempts only a value that is nothing but complete placeholders (either
 * vocabulary), which keeps the export re-redaction idempotent AND keeps the
 * redaction count honest (a placeholder re-match removes nothing).
 *
 * Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { redactTrainingContent } from '../../../src/training/redact';

const GH = `ghp_${'k'.repeat(30)}`;

function redact(text: string) {
	return redactTrainingContent(text);
}

describe('#3840 the training key/value arm consumes composite values whole', () => {
	test('a placeholder followed by more secret material leaves no tail', () => {
		const cases: Array<[string, string]> = [
			['password=<redacted>Hunter2Secret', 'password=<redacted>'],
			['password=<redacted:github>.TailSecret', 'password=<redacted>'],
			['password=[REDACTED:github].TailSecret', 'password=<redacted>'],
			// Two placeholders joined by a separator: the separator is not a
			// placeholder, so the value is consumed (the conservative side).
			['password=<redacted>.<redacted:github>', 'password=<redacted>'],
			['password=x-[REDACTED:github].Tail', 'password=<redacted>'],
			[`password=${GH}.${GH}.TailSecret`, 'password=<redacted>'],
			['token=<redacted>TokenTail42;next=1', 'token=<redacted>;next=1'],
		];
		for (const [input, expected] of cases) {
			const out = redact(input);
			expect(out.content).toBe(expected);
			expect(out.applied).toBe(true);
			expect(out.redactions).toBe(1);
			// A fixed point.
			expect(redact(out.content).content).toBe(out.content);
		}
	});

	test('the quoted JSON form consumes a composite value whole too', () => {
		const out = redact('"password": "<redacted:github>.TailSecret"');
		expect(out.content).toBe('"password": "<redacted>"');
		expect(out.redactions).toBe(1);
	});

	test('a value made ONLY of placeholders is a fixed point and is not counted', () => {
		const cases = [
			'password=<redacted>',
			'password=<redacted:github>',
			'password=<redacted:url>',
			'password="<redacted>"',
			"password='<redacted:url>'",
			'password=[REDACTED]',
			'password=[REDACTED:aws]',
			// The value ends at the space: the prose after it is not part of
			// the value.
			'password=<redacted:url> and TailSecret',
		];
		for (const input of cases) {
			const out = redact(input);
			expect(out.content).toBe(input);
			expect(out.applied).toBe(false);
			// The count contract: a re-match removes nothing, so it counts nothing.
			expect(out.redactions).toBe(0);
		}
	});

	test('every other value is still redacted (the arm is unchanged for them)', () => {
		const cases: Array<[string, string]> = [
			['password=hunter2', 'password=<redacted>'],
			[`password=${GH}.TailSecret99`, 'password=<redacted>'],
			['value; token=abcdef', 'value; token=<redacted>'],
			['api_key: s3cr3t-value', 'api_key: <redacted>'],
			// The frozen preserving contract: a quoted loose value stores the
			// UNQUOTED placeholder, exactly as the merge base did.
			['api_key="s3cr3t"', 'api_key=<redacted>'],
			["api_key='s3cr3t'", 'api_key=<redacted>'],
		];
		for (const [input, expected] of cases) {
			const out = redact(input);
			expect(out.content).toBe(expected);
			expect(out.applied).toBe(true);
			expect(out.redactions).toBeGreaterThanOrEqual(1);
		}
	});

	test('prose and empty values are left alone', () => {
		for (const input of [
			'Reset your password:',
			'token=,next',
			'password=',
			'the API key: ',
		]) {
			const out = redact(input);
			expect(out.content).toBe(input);
			expect(out.redactions).toBe(0);
		}
	});

	test('a run of unclosed placeholder openers stays LINEAR', () => {
		// The placeholder bodies are bounded at 64 characters: unbounded, an
		// attempt at every opener scanned to the end of the run and the arm
		// went quadratic.
		for (const opener of ['[REDACTED', '<redacted']) {
			const input = `password=${opener.repeat(8000)}`;
			const started = performance.now();
			const out = redact(input);
			const elapsed = performance.now() - started;
			expect(elapsed).toBeLessThan(250);
			// The run contains no COMPLETE placeholder, so it is one
			// un-redacted value and is consumed whole.
			expect(out.content).toBe('password=<redacted>');
			expect(out.redactions).toBe(1);
		}
	});
});
