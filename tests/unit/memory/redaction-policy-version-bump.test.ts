import { describe, expect, test } from 'bun:test';
import { computeRedactionPolicyVersion } from '../../../src/memory/redaction';

/**
 * #1466: unit coverage for the policy-version function that feeds the cohort
 * fingerprint. Split from cohort-config-fingerprint.test.ts (FR-006 line cap).
 * The function takes a policy OBJECT since #1466 (REDACTION_POLICY_SALT 1→2
 * with the PII fields joining the input); every PII setting must shift the
 * version so cohort members with different privacy policies fail closed at
 * link time instead of silently sharing.
 */
describe('computeRedactionPolicyVersion (#1466 object form)', () => {
	test('is deterministic', () => {
		const a = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		const b = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		expect(a).toBe(b);
	});

	test('rejectDurableSecrets=true differs from false', () => {
		const withReject = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
		});
		const withoutReject = computeRedactionPolicyVersion({
			rejectDurableSecrets: false,
		});
		expect(withReject).not.toBe(withoutReject);
		expect(withReject).toBeGreaterThan(withoutReject);
	});

	test('version is a positive integer', () => {
		const v = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		expect(Number.isInteger(v)).toBe(true);
		expect(v).toBeGreaterThan(0);
	});

	test('#1466 PII settings change the policy version', () => {
		const base = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		const withDetect = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
			detectPii: true,
		});
		const withReject = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
			rejectDurablePii: true,
		});
		const withNer = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
			piiDetector: 'ner',
		});
		expect(withDetect).not.toBe(base);
		expect(withReject).not.toBe(base);
		expect(withNer).not.toBe(base);
		expect(withDetect).not.toBe(withReject);
	});
});
