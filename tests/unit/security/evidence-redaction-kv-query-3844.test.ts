/**
 * #3844 rounds 9-12: the URL query arm and the key/value arm of the shared
 * evidence redactor — idempotency, the fragment/prose delimiters, the
 * composite-value consumption and the placeholder fixed points. Split from
 * evidence-redaction-3844.test.ts for the FR-006 500-line new-file cap.
 * Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { redactEvidenceText } from '../../../src/security/evidence-redaction';

describe('#3844 the shared redactor is idempotent and covers the training families', () => {
	// The review evidence is redacted at assembly AND at persistence, and the
	// forge queue re-redacts a message on every rewrite. A redactor that is
	// not idempotent grows the value by one character per pass and makes the
	// evidence copy and the receipt copy of one finding DIFFER — which the
	// auto-review evidence integrity check rejects.
	const corpus = [
		'x password=hunter2',
		'the token=abcdef',
		'api_key=XYZ123',
		'Authorization: Bearer abcdefghijklmnopqrst',
		'https://user:pass@example.com/path',
		'see https://example.com/x?token=abc end',
		'"password":"hunter2"',
		`literal ghp_${'g'.repeat(30)} here`,
		`literal sk-ant-${'a'.repeat(24)} here`,
	];

	test('applying the redactor twice changes nothing', () => {
		for (const value of corpus) {
			const once = redactEvidenceText(value);
			expect(redactEvidenceText(once)).toBe(once);
		}
	});

	test('a URL query credential is redacted', () => {
		// The training redactor replaces a whole URL; the evidence path
		// redacts the credential PARAMETER, so the parameter names have to
		// be covered.
		for (const url of [
			'https://example.com/login?user=bob&password=Hunter2Synthetic',
			'https://example.com/blob?sv=2024&sig=AbCdEf0123456789',
			'https://example.com/bucket?X-Amz-Signature=Fedcba9876543210',
			'https://example.com/bucket?X-Amz-Security-Token=Token0123456789',
			'https://example.com/bucket?X-Goog-Signature=GoogSig0123456789',
			// Round-9: the additional vendor-agnostic parameter names.
			'https://example.com/api?api-key=KeyValue123456',
			'https://example.com/api?x-api-key=XKey7890abcdef',
			'https://example.com/db?pwd=Pwd1234567890',
			'https://example.com/db?pass=Pass1234567890',
			'https://example.com/oauth?auth=Auth1234567890',
			'https://example.com/jwt?jwt=Jwt1234567890ab',
		]) {
			const out = redactEvidenceText(url);
			expect(out).not.toContain('Hunter2Synthetic');
			expect(out).not.toContain('AbCdEf0123456789');
			expect(out).not.toContain('Fedcba9876543210');
			expect(out).not.toContain('Token0123456789');
			expect(out).not.toContain('GoogSig0123456789');
			expect(out).not.toContain('KeyValue123456');
			expect(out).not.toContain('XKey7890abcdef');
			expect(out).not.toContain('Pwd1234567890');
			expect(out).not.toContain('Pass1234567890');
			expect(out).not.toContain('Auth1234567890');
			expect(out).not.toContain('Jwt1234567890ab');
		}
	});

	test('a benign fragment AFTER a credential parameter survives', () => {
		// The value class stops at the fragment delimiter, so a location
		// hash after a redacted parameter keeps its anchor.
		const fragmented = redactEvidenceText(
			'https://example.invalid/?token=abc#section',
		);
		expect(fragmented).not.toContain('abc');
		expect(fragmented).toContain('#section');
		// Round 10: the class keeps ONLY the fragment delimiter. A value
		// that legally contains `)`, a backtick or `]` is consumed WHOLE
		// (the round-9 delimiters leaked `)def` from `?pwd=abc)def`);
		// surrounding prose that runs into the value is consumed with it
		// (a cosmetic over-redaction, disclosed).
		const inner = redactEvidenceText('https://x.invalid/?pwd=abc)def');
		expect(inner).not.toContain('abc');
		expect(inner).not.toContain(')def');
		// An apostrophe is an RFC-legal sub-delimiter too (round 11): a
		// value containing one is consumed whole.
		const quoted = redactEvidenceText("https://x.invalid/?pwd=abc'def");
		expect(quoted).not.toContain('abc');
		expect(quoted).not.toContain("'def");
		// A COMPOSITE value (a family token followed by more secret
		// material) is consumed whole: the family arm labels its token and
		// the query arm then consumes the placeholder together with the
		// tail into its own generic placeholder (round 10; the round-9
		// guard used to skip the arm and leak the tail).
		const composite = redactEvidenceText(
			`https://x.invalid/?token=ghp_${'g'.repeat(30)}.ExtraSecretTail42`,
		);
		expect(composite).not.toContain('ghp_');
		expect(composite).not.toContain('ExtraSecretTail42');
		// Re-applying the redactor is a fixed point (the generic
		// placeholder is not grown or re-consumed).
		expect(redactEvidenceText(composite)).toBe(composite);
	});

	test('the key/value arm preserves the separator it consumed', () => {
		// The separator used to be part of the match but not of the
		// replacement, so the words were glued together. The fixture puts
		// the key AFTER a word the key class cannot swallow, so the arm
		// starts at the separator (and consumes it) rather than at the
		// string start — the shape that loses the separator.
		expect(redactEvidenceText('value; token=abcdef')).toBe(
			'value; token=[REDACTED]',
		);
		expect(redactEvidenceText('password=hunter2')).toBe('password=[REDACTED]');
		// Round 11: a COMPOSITE value (a family placeholder followed by
		// more secret material) is consumed whole, and a bare placeholder
		// is a fixed point.
		const composite = `password=ghp_${'k'.repeat(30)}.TailSecret99`;
		const once = redactEvidenceText(composite);
		expect(once).toBe('password=[REDACTED]');
		expect(redactEvidenceText(once)).toBe(once);
		expect(redactEvidenceText('password=[REDACTED]')).toBe(
			'password=[REDACTED]',
		);
		// Round 12: BOTH placeholder vocabularies consume, anywhere in the
		// value, and a bare placeholder is a fixed point. The aca8f1183
		// interim guard leaked the tail of a composite <redacted> value
		// (442d08ddd redacted it whole); the consuming repetition closes
		// that regression and the class it names.
		expect(redactEvidenceText('password=<redacted>Hunter2Secret')).toBe(
			'password=[REDACTED]',
		);
		expect(redactEvidenceText('password=<redacted:github>.TailSecret')).toBe(
			'password=[REDACTED]',
		);
		expect(redactEvidenceText('password=x-[REDACTED:github].Tail')).toBe(
			'password=[REDACTED]',
		);
		expect(
			redactEvidenceText(
				`password=ghp_${'k'.repeat(30)}.ghp_${'k'.repeat(30)}.Tail`,
			),
		).toBe('password=[REDACTED]');
		// An EMPTY value matches nothing (no placeholder appended to prose).
		expect(redactEvidenceText('Reset your password:')).toBe(
			'Reset your password:',
		);
		expect(redactEvidenceText('token=,next')).toBe('token=,next');
	});

	test('the >=80-char mixed-class base64 family is redacted (the training superset contract)', () => {
		const secret = 'Ab3'.repeat(30);
		const out = redactEvidenceText(`blob ${secret} end`);
		expect(out.includes(secret)).toBe(false);
		expect(out).toContain('[REDACTED:base64]');
	});

	test('a hex-only run stays visible (the base64 arm keeps the #3712 guard)', () => {
		const digest = 'a1'.repeat(40);
		expect(redactEvidenceText(`digest ${digest}`)).toBe(`digest ${digest}`);
	});
});
