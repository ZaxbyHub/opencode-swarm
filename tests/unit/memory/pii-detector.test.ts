import { describe, expect, test } from 'bun:test';
import {
	computePiiScore,
	type PiiFinding,
	RegexPiiDetector,
	summarizePiiFindings,
} from '../../../src/memory/pii';

describe('RegexPiiDetector (#1466)', () => {
	const detector = new RegexPiiDetector();

	test('detects email addresses', async () => {
		const findings = await detector.detect(
			'Contact brett.jordan@example-corp.com for details.',
		);
		expect(findings.some((f) => f.type === 'email')).toBe(true);
	});

	test('does not flag bare @ mentions or ordinary words', async () => {
		const findings = await detector.detect(
			'The @router middleware uses handleRequest at path src/router.ts.',
		);
		expect(findings).toEqual([]);
	});

	test('detects Luhn-valid credit cards', async () => {
		// 4111111111111111 is Luhn-valid.
		const findings = await detector.detect(
			'card number 4111 1111 1111 1111 on file',
		);
		expect(findings.some((f) => f.type === 'credit_card')).toBe(true);
	});

	test('rejects Luhn-invalid digit runs as credit cards', async () => {
		// Same length, broken checksum.
		const findings = await detector.detect('ref 4111 1111 1111 1112 ended');
		expect(findings.some((f) => f.type === 'credit_card')).toBe(false);
	});

	test('detects separator-structured phone numbers', async () => {
		const findings = await detector.detect('call +1 (555) 123-4567 tomorrow');
		expect(findings.some((f) => f.type === 'phone')).toBe(true);
	});

	test('does not flag hex shas or bare digit runs as phones', async () => {
		const findings = await detector.detect(
			'commit a1b2c3d4e5f6071829384a5b run 12345678901234',
		);
		expect(findings.some((f) => f.type === 'phone')).toBe(false);
	});

	test('detects SSNs', async () => {
		const findings = await detector.detect('SSN 123-45-6789 on the form');
		expect(findings.some((f) => f.type === 'ssn')).toBe(true);
	});

	test('does not flag date-like or version-like triples as SSNs', async () => {
		const findings = await detector.detect('version 1.2.3456 and 2026-08-22');
		expect(findings.some((f) => f.type === 'ssn')).toBe(false);
	});

	test('detects valid IPv4 addresses', async () => {
		const findings = await detector.detect('server at 192.168.1.42 responded');
		expect(findings.some((f) => f.type === 'ip_address')).toBe(true);
	});

	test('rejects invalid octets', async () => {
		const findings = await detector.detect('build 999.999.1.1 failed');
		expect(findings.some((f) => f.type === 'ip_address')).toBe(false);
	});

	test('ip findings stay below the default rejection threshold', async () => {
		const findings = await detector.detect('host 10.0.0.5 and host 8.8.8.8');
		expect(computePiiScore(findings)).toBeLessThanOrEqual(0.7);
	});

	test('score model: max finding confidence', () => {
		const findings: PiiFinding[] = [
			{ type: 'ip_address', match: '10.0.0.1', confidence: 0.5 },
			{ type: 'email', match: 'a@b.co', confidence: 0.9 },
		];
		expect(computePiiScore(findings)).toBe(0.9);
		expect(computePiiScore([])).toBe(0);
	});

	test('summary carries counts only — no matched text', () => {
		const summary = summarizePiiFindings([
			{ type: 'email', match: 'secret@example.com', confidence: 0.9 },
			{ type: 'email', match: 'other@example.com', confidence: 0.9 },
		]);
		expect(summary.score).toBe(0.9);
		expect(summary.countsByType).toEqual({ email: 2 });
		expect(JSON.stringify(summary)).not.toContain('example.com');
	});

	test('ordinary technical memory text yields no findings', async () => {
		const findings = await detector.detect(
			'The provider pool reuses the sqlite handle; migrations are idempotent (see src/memory/sqlite-provider.ts:1980).',
		);
		expect(findings).toEqual([]);
	});

	// PR #2310 feedback FB-4: Unicode evasion — normalization is for
	// detection only; the raw text is never altered.
	test('fullwidth digits do not evade SSN detection (NFKC normalization)', async () => {
		// '123-45-6789' with fullwidth digits/spaces.
		const findings = await detector.detect(
			'SSN \uFF11\uFF12\uFF13\uFF0D\uFF14\uFF15\uFF0D\uFF16\uFF17\uFF18\uFF19 on the form',
		);
		expect(findings.some((f) => f.type === 'ssn')).toBe(true);
	});

	test('zero-width characters do not break digit grouping', async () => {
		// 4111 1111 1111 1111 with zero-width spaces interleaved.
		const zwsp = '\u200B';
		const obfuscated = `card 4${zwsp}111 1111 1111 1111 on file`;
		const findings = await detector.detect(obfuscated);
		expect(findings.some((f) => f.type === 'credit_card')).toBe(true);
	});

	test('fullwidth digits do not evade IPv4 detection', async () => {
		const findings = await detector.detect(
			'server \uFF11\uFF19\uFF12.\uFF11\uFF16\uFF18.\uFF11.\uFF14\uFF12 responded',
		);
		expect(findings.some((f) => f.type === 'ip_address')).toBe(true);
	});

	test('zero-width space in an email domain does not evade detection', async () => {
		const findings = await detector.detect(
			'contact a@b\u200Bc.example.com please',
		);
		// Either email or (after stripping) another type — the point is the
		// address does not sail through completely undetected as an email
		// when it would otherwise match.
		expect(findings.length).toBeGreaterThan(0);
	});
});
