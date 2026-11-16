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
	findSecrets,
	redactSecrets,
} from '../../../src/memory/redaction.js';
import { analyzePrReviewVerdictRowContract } from '../../../src/pr-review/legacy-transcript-adapter.js';

const AWS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const GOOGLE_KEY = 'AIza' + 'A'.repeat(35);
const SECRET_40 = 'AbCdEfGhIjKlMnOpQrSt01234567890123456789';
/** Assembled by concatenation so no full token-shaped literal sits in source. */
const PAT_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

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
	[
		'github PAT embedded in word chars (#3382 AC1 names the PAT family)',
		'X'.repeat(20) + PAT_TOKEN + 'Y'.repeat(10),
		PAT_TOKEN,
	],
	// F-005: every named github/gitlab prefix family gets its own embedded
	// leg — reverting any single prefix family must flip this suite.
	...(['gho_', 'ghu_', 'ghs_', 'ghr_'].map((prefix) => [
		`github ${prefix} embedded in word chars`,
		'X'.repeat(20) +
			prefix +
			'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' +
			'Y'.repeat(10),
		prefix + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
	]) as Array<[string, string, string]>),
	[
		'github fine-grained pat embedded in word chars',
		'X'.repeat(8) +
			'github_pat_11AAAAAAAA0bbbbbbbbbbbbbb_ccccccccccccccccccccccccccccccvvvvvvvvvvv' +
			'Y'.repeat(6),
		'github_pat_11AAAAAAAA0bbbbbbbbbbbbbb_ccccccccccccccccccccccccccccccvvvvvvvvvvv',
	],
	[
		'gitlab glpat- token embedded in word chars',
		'q'.repeat(12) + 'glpat-' + 'AbCdEfGhIjKlMnOpQrStUvWx' + 'z'.repeat(8),
		'glpat-AbCdEfGhIjKlMnOpQrStUvWx',
	],
	[
		'gitlab glptt- token embedded in word chars',
		'q'.repeat(12) + 'glptt-' + 'AbCdEfGhIjKlMnOpQrStUvWx' + 'z'.repeat(8),
		'glptt-AbCdEfGhIjKlMnOpQrStUvWx',
	],
	[
		'slack token embedded in word chars (PRR-007: the de-anchored slack arm must stay)',
		'w'.repeat(9) + 'xoxb-' + '1234567890abcdefghij' + 'v'.repeat(6),
		'xoxb-1234567890abcdefghij',
	],
];

const BENIGN_CONTROLS: Array<[string, string]> = [
	['task-id shape', 'task-1234567890abcdefABCD'],
	['60-char hex without a credential prefix', 'a1'.repeat(30)],
	['risk-analysis prose', 'risk-analysis-of-something-long'],
	// F-002: the de-anchored github short prefixes must not fire inside
	// benign snake_case identifiers (the underscore-free token body is what
	// keeps these clean).
	['snake_case with a ghs_ subword', 'load_ghs_metadata_from_cache_store'],
	['snake_case with highs_and_lows', 'weekly_highs_and_lows_for_the_quarter'],
	['snake_case with a ghp_ subword', 'reset_ghp_session_token_refresh_handler'],
	// PRR-011: these two pin the KEPT anchors — the de-anchoring mutant
	// (dropping the word-boundary anchor from the stripe/jwt arms) makes
	// both MATCH, so each control fails if the anchor is dropped.
	[
		'stripe anchor kept: risk_live_ prose shape',
		'risk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
	],
	[
		'jwt anchor kept: two eyJ segments inside a base64 blob',
		'w'.repeat(10) +
			'eyJ' +
			'a'.repeat(20) +
			'.eyJ' +
			'b'.repeat(15) +
			'.' +
			'c'.repeat(20) +
			'w'.repeat(10),
	],
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

	// F-005: the context arm's window is bounded — a 40-char token more than
	// 200 chars after the AKIA id (this fixture: 210 filler chars AND a
	// newline the window's character class cannot cross) must not be dragged
	// into the span. The bare AKIA id itself still detects (the access-key
	// arm), so the pin is on the CONTEXT type being absent and the 40-char
	// token surviving redaction — the same shape redaction.test.ts pins at
	// the 200-char boundary.
	test('context arm window: a 40-char token beyond 200 chars + a newline is not dragged into the span', () => {
		const token40 = 'AbCdEfGhIjKlMnOpQrSt01234567890123456789';
		// Newline built from char codes: the window's character class cannot
		// cross it. (Escapes in heredoc-written fixtures collapse on this
		// host, so no \n literal here.)
		const newline = String.fromCharCode(10);
		const sample =
			`AKIAIOSFODNN7EXAMPLE ${'x'.repeat(210)}` + newline + token40;
		const types = findSecrets(sample).map((f) => f.type);
		expect(types).not.toContain('aws_secret_access_key_context');
		expect(redactSecrets(sample).includes(token40)).toBe(true);
	}, 30000);

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
