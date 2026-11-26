/**
 * #3844 closeout round 3: the shared evidence redactor must reach a FIXED
 * POINT, and it must not lose a multi-line credential span to a placeholder.
 *
 * The same value is redacted more than once on the persisted paths (the
 * review evidence at assembly and again at persistence, the receipt again
 * when it is persisted, the forge queue on every rewrite), and the evidence
 * copy and the receipt copy of one finding must be byte-identical. A
 * redactor that changes its output on the second pass breaks both.
 *
 * Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import {
	clampRedactedText,
	redactEvidenceText,
} from '../../../src/security/evidence-redaction';

const GH = `ghp_${'q'.repeat(30)}`;
const ANTHROPIC = `sk-ant-${'a'.repeat(24)}`;

describe('#3844 the evidence redactor reaches a fixed point', () => {
	const corpus = [
		'x password=hunter2',
		'value; token=abcdef',
		'api_key=XYZ123',
		'Authorization: Bearer abcdefghijklmnopqrst',
		'https://user:pass@example.com/path',
		'see https://example.com/x?token=abc end',
		'"password":"hunter2"',
		`literal ${GH} here`,
		`literal ${ANTHROPIC} here`,
		// A credential GLUED to a preceding word character has no word
		// boundary, so the bare arm skips it on the first pass; the corpus
		// then ends the neighbouring word, and the next pass sees the
		// boundary the credential needed.
		`creds AKIAABCDEFGHIJKLMNOP${ANTHROPIC} end`,
		`prefix${GH} suffix`,
	];

	test('a second pass changes nothing', () => {
		for (const value of corpus) {
			const once = redactEvidenceText(value);
			expect(redactEvidenceText(once)).toBe(once);
		}
	});

	test('a glued credential is redacted', () => {
		const glued = `creds AKIAABCDEFGHIJKLMNOP${ANTHROPIC} end`;
		const out = redactEvidenceText(glued);
		expect(out.includes(ANTHROPIC)).toBe(false);
		expect(out.includes('AKIAABCDEFGHIJKLMNOP')).toBe(false);
	});

	test('a private-key block is removed whole even when a bare arm matched inside it', () => {
		// The corpus arm needs BOTH delimiters in one match, so a
		// placeholder inserted in the middle of the block must not break
		// the match — the corpus has to see the whole text.
		const block = [
			'-----BEGIN RSA PRIVATE KEY-----',
			`body ${GH} more body`,
			'-----END RSA PRIVATE KEY-----',
		].join('\n');
		const out = redactEvidenceText(`before\n${block}\nafter`);
		expect(out.includes('PRIVATE KEY')).toBe(false);
		expect(out.includes(GH)).toBe(false);
	});
});

describe('#3844 the clamp drops a one-character marker fragment', () => {
	test('a cut that lands right after the opening delimiter drops it', () => {
		// The redacted value is 'x' * 190 + ' token=[REDACTED]', so a cut
		// that ends at index 198 lands exactly on the marker's opening
		// delimiter: the persisted value must not keep a bare '['.
		const value = `${'x'.repeat(190)} token=a`;
		const redacted = redactEvidenceText(value);
		expect(redacted).toBe(`${'x'.repeat(190)} token=[REDACTED]`);
		const clamped = clampRedactedText(redacted, 198);
		expect(clamped.endsWith('[')).toBe(false);
		expect(clamped).toBe(`${'x'.repeat(190)} token=`);
	});
});
