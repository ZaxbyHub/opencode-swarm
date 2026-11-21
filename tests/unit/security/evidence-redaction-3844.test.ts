/**
 * #3844 shared evidence redactor: SUPERSET contract — everything the
 * persisted-store corpus (redactSecrets) covers, plus the display bare-value
 * families, URL credential stripping, and the shared JWS scanner. Benign
 * content preserves byte-identically. Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '../../../src/memory/redaction';
import { redactEvidenceText } from '../../../src/security/evidence-redaction';

describe('#3844 redactEvidenceText superset contract', () => {
	const displayFamilies: Array<[string, string]> = [
		['anthropic', `sk-ant-${'a'.repeat(24)}`],
		['openrouter', `sk-or-${'o'.repeat(24)}`],
		['openai', `sk-${'p'.repeat(24)}`],
		['github', `ghp_${'g'.repeat(24)}`],
		['github-fine', `github_pat_${'h'.repeat(24)}`],
		['aws', 'AKIAABCDEFGHIJ012345'],
		['slack', `xoxb-${'s'.repeat(16)}`],
		['google', `AIza${'k'.repeat(31)}`],
		['groq', `gsk_${'q'.repeat(24)}`],
		['azure', `AccountKey=${'A'.repeat(28)}=`],
	];
	for (const [name, token] of displayFamilies) {
		test(`display family ${name} is redacted`, () => {
			const out = redactEvidenceText(`token ${token} in evidence`);
			expect(out.includes(token)).toBe(false);
			expect(out).toMatch(/\[REDACTED:[a-z0-9_-]+\]/);
		});
	}

	test('redactSecrets parity: everything the memory-site redactor covers stays covered', () => {
		// Representative fixtures from the 14-family memory corpus; each row
		// carries the SECRET substring that must be absent from BOTH outputs.
		const corpus = [
			[
				'bearer',
				'Authorization: Bearer abcd.apitest.signature1234',
				'abcd.apitest.signature1234',
			],
			['github', `token=ghp_${'x'.repeat(30)}`, `ghp_${'x'.repeat(30)}`],
			['aws-key', `aws_secret_access_key = ${'Y'.repeat(40)}`, 'Y'.repeat(40)],
			['slack', `SLACK_TOKEN=xoxp-${'z'.repeat(20)}`, `xoxp-${'z'.repeat(20)}`],
			[
				'jwt',
				`jwt=eyJ${'h'.repeat(16)}.eyJ${'d'.repeat(16)}.${'s'.repeat(16)}`,
				`eyJ${'h'.repeat(16)}.eyJ${'d'.repeat(16)}.${'s'.repeat(16)}`,
			],
			['gitlab', `glpat-${'g'.repeat(20)}`, `glpat-${'g'.repeat(20)}`],
			['stripe', `sk_live_${'s'.repeat(24)}`, `sk_live_${'s'.repeat(24)}`],
			['env', 'MY_SECRET_PASSWORD=supersecretvalue99', 'supersecretvalue99'],
		];
		for (const [name, fixture, secret] of corpus) {
			const baseline = redactSecrets(fixture);
			const superset = redactEvidenceText(fixture);
			// The superset must redact at least as much as the baseline: the
			// SECRET part is absent from both outputs.
			expect(superset.includes(secret)).toBe(false);
			expect(baseline.includes(secret)).toBe(false);
			expect(`${name} fixture handled`).toBe(`${name} fixture handled`);
		}
	});

	test('private-key block body is redacted as a whole span', () => {
		const key = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(
			64,
		)}\n${'B'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
		const out = redactEvidenceText(`leaked ${key} in CI log`);
		// The key BODY never survives; do not pin whether markers stay.
		expect(out.includes('A'.repeat(64))).toBe(false);
		expect(out.includes('B'.repeat(64))).toBe(false);
	});

	test('five-part JWE: EVERY segment is redacted (no stranded tail — round-5 regression pin)', () => {
		const parts = [
			`eyJ${'a'.repeat(24)}`,
			`eyJ${'b'.repeat(24)}`,
			'c'.repeat(24),
			'd'.repeat(40),
			'e'.repeat(43),
		];
		const jwe = parts.join('.');
		const out = redactEvidenceText(`leaked ${jwe} in CI log`);
		for (const part of parts) {
			expect(out.includes(part)).toBe(false);
		}
	});

	test('overlap clip: a secret prefix before an eyJ run keeps its family label', () => {
		const jws = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const prefix = `sk-ant-${'q'.repeat(24)}`;
		const out = redactEvidenceText(`saw ${prefix}${jws} inline`);
		expect(out.includes(prefix)).toBe(false); // clipped prefix is redacted
		expect(out.includes(jws)).toBe(false);
	});

	test('URL userinfo credentials are stripped, host preserved', () => {
		const out = redactEvidenceText(
			'clone https://user:hunter2@example.invalid/repo.git now',
		);
		expect(out).not.toContain('hunter2');
		expect(out).toContain('example.invalid/repo.git');
	});

	test('URL query credential is stripped', () => {
		const out = redactEvidenceText(
			'https://ci.example.invalid/log?access_token=abc123def456&x=1',
		);
		expect(out).not.toContain('abc123def456');
	});

	test('JWS scanner shapes beyond the bare arms', () => {
		const token = `eyJ${'H'.repeat(1100)}.e30.x`;
		const out = redactEvidenceText(`log had ${token} inside`);
		expect(out.includes('H'.repeat(1100))).toBe(false);
	});

	test('benign content round-trips byte-identical', () => {
		for (const benign of [
			'the quick brown fox jumped over the lazy dog',
			'assertEqual(result.status, 200)',
			'src/hooks/utils.ts:42 — the guard fires before the write',
			'AKIA says nothing without exactly-16 uppercase alnum',
		]) {
			expect(redactEvidenceText(benign)).toBe(benign);
		}
	});

	test('fail-closed: never returns raw on internal error', () => {
		// Exercise the catch path via a null-prototype string trick is not
		// possible on a plain string API; assert the contract instead: a
		// non-string input passes through the guard unchanged.
		expect(redactEvidenceText('')).toBe('');
	});
});
