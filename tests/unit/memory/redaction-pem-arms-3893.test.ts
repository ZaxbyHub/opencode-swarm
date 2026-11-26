/**
 * #3893/#3915 F11 (PEM part, batch A scope: the memory SECRET_PATTERNS arms)
 * — the two PEM arms are REPLACED with bounded-WORK whole-secret scans:
 *
 * 1. END-delimited with a bounded gap `[\s\S]{0,8192}` (byte-identical
 *    behavior for real blocks — a real PEM body is far below the bound).
 * 2. A no-END fallback consuming the MAXIMAL key-material run
 *    `-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*` (linear
 *    character-class scan; stops at the first character OUTSIDE the class —
 *    letters, digits, the base64 symbols and whitespace are all key material,
 *    so glued words are consumed and punctuation ends the run; no output
 *    cap; runs LAST under sequential priority).
 *
 * Base defect (plan v3 F11): the lazy `[\s\S]*?` arm scanned unbounded when
 * no END delimiter existed (quadratic across multiple BEGIN markers), and
 * BEGIN-only input kept its entire key material in cleartext.
 *
 * Every leg asserts substring absence of the SPECIFIC synthetic key material
 * (never just output-changed). All bodies are 'A'-filled synthetic material;
 * no real keys.
 */
import { describe, expect, test } from 'bun:test';
import {
	containsSecret,
	findSecrets,
	redactSecrets,
} from '../../../src/memory/redaction';

const RSA_BODY = `MIIEowIBAAKCAQEA${'A'.repeat(96)}`;
const OPENSSH_BODY = `b3BlbnNzaC1zeW50aGV0aWMta2V5LW5vdC1yZWFs${'A'.repeat(64)}`;
const MATERIAL_RUN = 'A1b2C3d4E5f6'.repeat(180); // 2160 chars of key material

function rsaBlock(body: string): string {
	return `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
}

function opensshBlock(body: string): string {
	return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
}

describe('#3893/#3915 PEM arms — bounded END-delimited scans (F11)', () => {
	// Byte-identical for real blocks: the whole block collapses to exactly one
	// placeholder (the same pins redaction.test.ts carries — re-pinned here
	// beside the new adversarial legs).
	test('a real RSA block redacts whole to the single generic placeholder', () => {
		const out = redactSecrets(`pasted ${rsaBlock(RSA_BODY)} verbatim`);
		expect(out).toBe('pasted [REDACTED:private_key_block] verbatim');
		expect(out).not.toContain('MIIEowIBAAKCAQEA');
		expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
	});

	test('a real OPENSSH block redacts whole (generic arm wins under sequential priority)', () => {
		const out = redactSecrets(`pasted ${rsaBlock(OPENSSH_BODY)} verbatim`);
		expect(out).toBe('pasted [REDACTED:private_key_block] verbatim');
		expect(out).not.toContain(OPENSSH_BODY.slice(0, 24));
	});

	test('findSecrets still reports the openssh family for an OPENSSH-delimited block', () => {
		const types = findSecrets(opensshBlock(OPENSSH_BODY)).map((f) => f.type);
		expect(types).toContain('openssh_private_key_block');
		expect(types).toContain('private_key_block');
	});
});

describe('#3893/#3915 PEM arms — no-END fallback (F11)', () => {
	test('a lone BEGIN with no END redacts the ENTIRE key material run', () => {
		const input = `-----BEGIN RSA PRIVATE KEY-----\n${MATERIAL_RUN}\n${'Z'.repeat(40)} truncated`;
		const out = redactSecrets(input);
		expect(out).toContain('[REDACTED:private_key_block_nogap]');
		expect(out).not.toContain('A1b2C3d4E5f6');
		// The material run is consumed up to the first non-key character; the
		// 'Z'.repeat(40) filler is INSIDE the key-material class and must be
		// gone with the rest.
		expect(out).not.toContain('ZZZZ');
		expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
	});

	test('the fallback stops at the first non-key character after the material run', () => {
		// The fallback's class is [A-Za-z0-9+/=\s] — letters, digits, the
		// base64 symbols and whitespace. ANY punctuation ends the maximal run,
		// so prose separated from the material by a sentence boundary
		// survives; prose glued directly after the marker does not (documented
		// over-redaction direction — the safe side).
		const input = `-----BEGIN PRIVATE KEY-----${'A'.repeat(80)}. The incident notes continue here.`;
		const out = redactSecrets(input);
		expect(out).toBe(
			'[REDACTED:private_key_block_nogap]. The incident notes continue here.',
		);
		expect(out).not.toContain('AAAA');
	});

	test('an over-8192-gap malformed block still redacts ALL key material via the fallback', () => {
		// The bounded END-delimited arm cannot span an 8300-char gap; the
		// fallback consumes the maximal material run (up to the END marker's
		// hyphen) — every byte of key material is gone, the stray delimiter
		// residue is not a secret.
		const body = 'A1b2C3d4E5f6'.repeat(700); // 8400 chars
		const input = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
		expect(containsSecret(input)).toBe(true);
		const out = redactSecrets(input);
		expect(out).not.toContain('A1b2C3d4E5f6');
		expect(out).toContain('private_key_block');
	});

	test('multi-BEGIN no-END input completes linearly under a time bound', () => {
		// At base the lazy `[\s\S]*?` arm retried the unbounded scan from every
		// BEGIN marker (quadratic across a dense multi-BEGIN blob). The new
		// arms are linear character-class scans; pin completion with a wall
		// clock bound AND full redaction of every BEGIN marker's material.
		const chunk = `-----BEGIN RSA PRIVATE KEY-----\n${'A1b2C3d4E5f6'.repeat(40)}\n`;
		const input = chunk.repeat(40); // ~180 KB, 40 BEGIN markers, no END
		const started = Date.now();
		const out = redactSecrets(input);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(5_000);
		expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
		expect(out).not.toContain('A1b2C3d4E5f6');
	}, 30_000);

	// Negative: words glued directly after a bare BEGIN marker are INSIDE the
	// maximal key-material class (letters + whitespace) and are consumed —
	// the documented fail-closed over-redaction direction; punctuation ends
	// the run, so text after a sentence boundary survives.
	test('a BEGIN marker consumes glued words but preserves post-punctuation prose', () => {
		const text =
			'the log mentioned -----BEGIN PRIVATE KEY----- and, afterwards, nothing followed it';
		const out = redactSecrets(text);
		expect(out).toContain(', afterwards, nothing followed it');
		expect(out).toContain('[REDACTED:private_key_block_nogap]');
		expect(out).not.toContain('BEGIN PRIVATE KEY');
	});
});
