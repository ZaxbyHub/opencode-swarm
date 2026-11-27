/**
 * #3840: bare well-known credential VALUE families + shared JWS scanner in
 * the training redactor — unit-level pin beside the frozen checks. Synthetic
 * tokens only.
 */
import { describe, expect, test } from 'bun:test';
import {
	_internals,
	redactTrainingContent,
	TRAINING_REDACTION_VERSION,
} from '../../../src/training/redact';

function needle(run: string, n: number): string {
	return `${run.padEnd(20 - run.length, 'x')}${String(n).padEnd(8, 'y')}`;
}

describe('#3840 training redaction families', () => {
	test('version is 3 (#3893 AC4 added the redactSecrets floor; #3840 added the bare families)', () => {
		expect(TRAINING_REDACTION_VERSION).toBe(3);
	});

	const families: Array<[string, (i: number) => string]> = [
		['anthropic', (i) => `sk-ant-${needle('a', i)}`],
		['openrouter', (i) => `sk-or-${needle('o', i)}`],
		['openai', (i) => `sk-${needle('p', i)}`],
		['github-classic', (i) => `ghp_${needle('g', i)}`],
		['github-fine', (i) => `github_pat_${needle('h', i)}`],
		['aws', () => 'AKIAABCDEFGHIJ012345'],
		['slack', (i) => `xoxb-${needle('s', i)}`],
		['google', () => `AIza${'k'.repeat(31)}`],
		['groq', (i) => `gsk_${needle('q', i)}`],
		['azure', (i) => `AccountKey=${needle('z', i).replace(/[^a-z]/g, 'A')}`],
	];
	for (const [name, make] of families) {
		test(`bare ${name} token in prose is redacted with a family label`, () => {
			const token = make(1);
			const result = redactTrainingContent(
				`the key ${token} was pasted in prose`,
			);
			expect(result.applied).toBe(true);
			expect(result.content.includes(token)).toBe(false);
			expect(result.content).toMatch(/<redacted:[a-z0-9]+>/);
		});
	}

	test('JWS shapes: scanner covers what the regex list cannot', () => {
		// Long header (>1024) + real base64url payload + signature — beyond
		// the bare jwt arm's bounds, inside the scanner's (same shape family
		// as the frozen C1 fixture).
		const longHeader = `eyJ${'A'.repeat(1100)}`;
		const token = `${longHeader}.cGF5bG9hZA.c2lnbmF0dXJlMTIzNDU2Nzg5`;
		const result = redactTrainingContent(`chain token ${token} landed`);
		expect(result.content.includes(longHeader)).toBe(false);
		expect(result.content).toContain('<redacted:jwt>');
		expect(result.content).toContain('<redacted:jwt>');
	});

	test('JWE five-part compact serialization is fully redacted', () => {
		const parts = [
			`eyJ${'a'.repeat(24)}`,
			'b'.repeat(40),
			'c'.repeat(24),
			'd'.repeat(40),
			'e'.repeat(43),
		];
		const token = parts.join('.');
		const result = redactTrainingContent(`jwe ${token} tail`);
		for (const part of parts) {
			expect(result.content.includes(part)).toBe(false);
		}
	});

	test('glued family+JWS composition: every secret-bearing segment absent', () => {
		const jwt = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const glued = `sk-ant-${needle('u', 1)}${jwt}`;
		const result = redactTrainingContent(`saw ${glued} inline`);
		expect(result.content.includes(glued)).toBe(false);
		expect(result.content).not.toContain(jwt);
	});

	test('overlap: a credential family arm that starts INSIDE a scanner span does not strand its tail', () => {
		// The azure AccountKey value is the third segment of an eyJ-shaped run.
		// The arm match starts inside the scanner span and extends past it, so
		// a policy that DROPS an overlapping arm match would leave the key
		// value in the clear.
		const keyValue = 'Zm9vYmFy+mF6c29tZS1rZXktdmFsdWUtMDAwMDA=';
		const result = redactTrainingContent(
			`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.AccountKey=${keyValue}`,
		);
		expect(result.content).not.toContain(keyValue);
		expect(result.content).not.toContain('Zm9vYmFy');
	});

	test('overlap: a short credential family prefix before a scanner span is redacted', () => {
		// The prefix is shorter than the old 12-character clip floor, so a
		// policy that dropped a clipped head would leave it visible.
		const prefix = 'sk-ant-abc_';
		const jws = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const result = redactTrainingContent(`saw ${prefix}${jws} inline`);
		expect(result.content).not.toContain(prefix);
		expect(result.content).not.toContain('sk-ant-abc');
	});

	test('overlap: two arms matching the same text emit ONE placeholder', () => {
		// The anthropic and openai arms both match this shape. Two overlapping
		// planned ranges used to be spliced in reverse order, eating the first
		// placeholder and leaving a malformed marker in the output.
		const jws = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const result = redactTrainingContent(`sk-ant-api03-abcd_${jws}`);
		expect(result.content).not.toContain('sk-ant-api03');
		expect(result.content).not.toContain('redacted:jwt]REDACTED:');
		expect(result.content).not.toContain('>REDACTED');
	});

	test('fail-closed: an internal failure withholds the content instead of storing it raw', () => {
		// The catch path is unreachable through the public API, so the seam
		// injects the failure. A variant that returned the RAW content on an
		// internal error would fail this assertion.
		const real = _internals.redactBareValueShapes;
		_internals.redactBareValueShapes = () => {
			throw new Error('injected bare-value failure');
		};
		try {
			const result = redactTrainingContent(
				'credential material that must not survive',
			);
			expect(result.content).toBe('<redacted:redaction-failed>');
			expect(result.content).not.toContain('credential material');
		} finally {
			_internals.redactBareValueShapes = real;
		}
	});

	test('near-misses stay visible (no over-redaction)', () => {
		for (const benign of [
			'the skateboard rolled downhill',
			'sk- short fragment stays',
			'A plain sentence with no secrets.',
			'AKIA says nothing',
		]) {
			const result = redactTrainingContent(benign);
			expect(result.content).toBe(benign);
		}
	});

	test('hex-only 80-char digest stays visible (base64 guard)', () => {
		const digest = 'a'.repeat(90);
		const result = redactTrainingContent(`sha ${digest} end`);
		expect(result.content).toContain(digest);
	});

	test('mixed-class 80+ base64 run is redacted', () => {
		const run = 'AbCdEf1234'.repeat(10);
		const result = redactTrainingContent(`b64 ${run} end`);
		expect(result.content.includes(run)).toBe(false);
	});

	test('context arms still precede bare arms (Bearer context keeps generic output)', () => {
		const token = `sk-${needle('c', 7)}`;
		const result = redactTrainingContent(`Authorization: Bearer ${token}`);
		expect(result.content.includes(token)).toBe(false);
		expect(result.content).not.toMatch(/<redacted:[a-z0-9]+>/);
		expect(result.content).toContain('<redacted>');
	});

	// ── #3893 AC9 (F2 fill-split re-link at the training site) ────────────
	// Zero-width fill SPLITS of well-known credential families were invisible
	// to the training arms at base (they match raw text only). The F2 floor
	// composition (redactSecrets after the bare pass) re-links them through
	// the memory site's fill-class condensed view. Methodology matches the
	// frozen check-ac9: fill code units are stripped from BOTH the secret
	// projection and the output before the substring check, so the assertion
	// tests RE-LINKING, not raw byte survival — and the SPECIFIC synthetic
	// secret must be absent (never just output-changed). All tokens synthetic.
	test('AC9: a ghp_ token split by ZWSP after "gh" does not survive', () => {
		const token = `gh${String.fromCharCode(0x200b)}p_${'A'.repeat(36)}`;
		const result = redactTrainingContent(`ci log carried ${token}`);
		const stripped = result.content.replace(/\u200b|\u200c|\u0301|\u2800/g, '');
		expect(stripped.includes(`ghp_${'A'.repeat(36)}`)).toBe(false);
		expect(result.redactions).toBeGreaterThan(0);
	});

	test('AC9: an sk-ant- token split by ZWSP inside the prefix does not survive', () => {
		const token = `sk-a${String.fromCharCode(0x200b)}nt-${'B'.repeat(24)}`;
		const result = redactTrainingContent(`trace showed ${token}`);
		const stripped = result.content.replace(/\u200b|\u200c|\u0301|\u2800/g, '');
		expect(stripped.includes(`sk-ant-${'B'.repeat(24)}`)).toBe(false);
		expect(result.redactions).toBeGreaterThan(0);
	});

	test('AC9: an AKIA key split by ZWNJ inside the prefix does not survive', () => {
		const token = `AK${String.fromCharCode(0x200c)}IA${'ABCDEFGHIJKLMNOP'}`;
		const result = redactTrainingContent(`env dump had ${token}`);
		const stripped = result.content.replace(/\u200b|\u200c|\u0301|\u2800/g, '');
		expect(stripped.includes('AKIAABCDEFGHIJKLMNOP')).toBe(false);
		expect(result.redactions).toBeGreaterThan(0);
	});
});
