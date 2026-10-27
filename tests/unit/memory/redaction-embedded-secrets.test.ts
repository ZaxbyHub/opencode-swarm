/**
 * Issue #3382: credential tokens EMBEDDED inside longer charset-clean tokens
 * must be detected and redacted. The fixed-length families (AWS access key
 * id, Google API key, the 40-char AWS-secret value arms) are deliberately
 * not \b-anchored, and the AWS-secret arms run BEFORE the bare access-key arm
 * because redactSecrets applies patterns sequentially (the bare arm would
 * otherwise destroy the context arm's AKIA anchor and leak the 40-char
 * secret — a pre-existing leak this change also closes).
 *
 * Also pins the exported egress choke point: an embedded-credential
 * verdict-row id renders as the '(redacted)' sentinel in
 * analyzePrReviewVerdictRowContract's actual output, never the raw token.
 * RED at base, GREEN after the fix (frozen trace check C6 is the same
 * contract; this is the CI-tracked twin).
 */

import { describe, expect, test } from 'bun:test';
import {
	containsSecret,
	redactSecrets,
} from '../../../src/memory/redaction.js';
import { analyzePrReviewVerdictRowContract } from '../../../src/pr-review/legacy-transcript-adapter.js';

const AWS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const GOOGLE_KEY = 'AIza' + 'A'.repeat(35);
const SECRET_40 = 'AbCdEfGhIjKlMnOpQrSt01234567890123456789';

const EMBEDDED_SHAPES: Array<[string, string, string]> = [
	[
		'aws key id embedded in word chars',
		'X'.repeat(34) + AWS_KEY_ID + 'Y'.repeat(34),
		AWS_KEY_ID,
	],
	[
		'google api key past the exact window',
		GOOGLE_KEY + 'Z'.repeat(10),
		GOOGLE_KEY,
	],
	[
		'aws key id continued by lowercase',
		AWS_KEY_ID + 'lowercasecontinuation',
		AWS_KEY_ID,
	],
	[
		'aws secret (labeled) running past 40 chars',
		`SecretAccessKey": "${SECRET_40}extraBase64Tail`,
		SECRET_40,
	],
	[
		'aws secret context: embedded AKIA id near a delimited 40-char secret',
		'X'.repeat(10) + AWS_KEY_ID + 'X'.repeat(10) + '  ' + SECRET_40,
		SECRET_40,
	],
];

const BENIGN_CONTROLS: Array<[string, string]> = [
	['task-id shape', 'task-1234567890abcdefABCD'],
	['60-char hex without a credential prefix', 'a1'.repeat(30)],
	['risk-analysis prose', 'risk-analysis-of-something-long'],
];

describe('embedded secret shapes are redacted and removed (#3382)', () => {
	test.each(EMBEDDED_SHAPES)(
		'%s is detected and fully redacted',
		(_name, sample, credential) => {
			expect(containsSecret(sample)).toBe(true);
			const redacted = redactSecrets(sample);
			expect(redacted.includes('[REDACTED:')).toBe(true);
			expect(redacted.includes(credential)).toBe(false);
		},
		30000,
	);

	test.each(BENIGN_CONTROLS)(
		'%s stays unreducted and undetected',
		(_name, sample) => {
			expect(containsSecret(sample)).toBe(false);
			expect(redactSecrets(sample)).toBe(sample);
		},
		30000,
	);

	test('egress: embedded-credential verdict-row id renders as the (redacted) sentinel', () => {
		const embeddedId = 'X'.repeat(34) + AWS_KEY_ID + 'Y'.repeat(10);
		const row =
			`[REVIEWED] | ${embeddedId} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | no | ` +
			'src/a.ts:1 | evidence text here | falsifier text | notes | UNKNOWN |';
		const analysis = analyzePrReviewVerdictRowContract(row, ['c1'], 'reviewer');
		expect(analysis.actual.includes('(redacted)')).toBe(true);
		expect(analysis.actual.includes(AWS_KEY_ID)).toBe(false);
	}, 30000);
});
