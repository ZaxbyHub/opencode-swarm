/**
 * Per-pattern-class coverage for src/training/redact.ts (PR #2637 feedback
 * findings PRR-003/PRR-020). The pre-existing redaction assertions in
 * consent-and-record-metadata-2486.test.ts use a URL fixture that URL_PATTERN
 * alone satisfies — this file gives EVERY pattern class its own fixture with
 * no co-occurring pattern, and asserts the literal secret is ABSENT from the
 * redacted content (not just that a counter incremented).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 */
import { describe, expect, test } from 'bun:test';
import {
	redactTrainingContent,
	TRAINING_REDACTION_VERSION,
} from '../../../src/training/redact.js';

describe('PRR-003 - quoted JSON credential forms are redacted', () => {
	test('"key": "Bearer token" (spaced JSON) is redacted', () => {
		const r = redactTrainingContent('{"Authorization": "Bearer abc123secret"}');
		expect(r.content).not.toContain('abc123secret');
		expect(r.redactions).toBeGreaterThanOrEqual(1);
	});

	test('"key":"value" (compact JSON) is redacted', () => {
		const r = redactTrainingContent('{"api_key":"sk-live-999-secret"}');
		expect(r.content).not.toContain('sk-live-999-secret');
		expect(r.redactions).toBeGreaterThanOrEqual(1);
	});

	test('api_key="value" (quoted value, unquoted key) is redacted', () => {
		const r = redactTrainingContent('api_key="secret123"');
		expect(r.content).not.toContain('secret123');
		expect(r.redactions).toBeGreaterThanOrEqual(1);
	});
});

describe('PRR-003 - the scheme token itself is consumed, not just the word', () => {
	test('Authorization: Bearer <token> leaves no token fragment', () => {
		const r = redactTrainingContent('Authorization: Bearer abc123secret');
		expect(r.content).not.toContain('abc123secret');
		expect(r.content).not.toContain('Bearer abc123secret');
	});

	test('bare Bearer <jwt> with no key morpheme is redacted', () => {
		const r = redactTrainingContent('Bearer eyJhbGciOiJIUzI1NiJ9.sig-part');
		expect(r.content).not.toContain('eyJhbGciOiJIUzI1NiJ9');
	});
});

describe('each remaining pattern class keeps its own fixture', () => {
	test('loose key=value (no URL, no quotes) is redacted', () => {
		const r = redactTrainingContent('password: hunter2');
		expect(r.content).not.toContain('hunter2');
	});

	test('URL class is redacted (fixture has no credential morpheme)', () => {
		const r = redactTrainingContent(
			'see https://internal.example.invalid/p?token=abc123def456 for details',
		);
		expect(r.content).not.toContain('internal.example.invalid');
		expect(r.content).not.toContain('abc123def456');
	});

	test('benign content is untouched (applied false, identity)', () => {
		const plain = 'a plain sentence with no secrets at all';
		const r = redactTrainingContent(plain);
		expect(r.applied).toBe(false);
		expect(r.content).toBe(plain);
	});
});

test('redaction version stays 1 (pre-release pattern extension, no migration)', () => {
	expect(TRAINING_REDACTION_VERSION).toBe(1);
});
