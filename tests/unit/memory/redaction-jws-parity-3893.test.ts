/**
 * #3893 AC10 / F5 — the MEMORY secret scanner (findSecrets / containsSecret /
 * redactSecrets in src/memory/redaction.ts) reaches JWS-scanner parity.
 *
 * Root cause (04-root-cause.md AC10): the memory site never imported the
 * shared JWS scanner; its own `jwt_token` family requires an `eyJ`-prefixed
 * payload segment, so widened shapes (5-part dir-JWE, unsigned JWT with a
 * trailing dot, e30-payload JWT) were invisible to containsSecret AND
 * redactSecrets, while the SHELL scanner redacted the same shapes.
 *
 * The fix unions `findRedactableTokenSpans` (`src/utils/jws-redaction.ts`)
 * into the memory scanner as type 'jws_span', over the raw text AND the
 * fill-deleted condensed view, through the site's selectedSecretSpans
 * machinery. Every leg below asserts BOTH detection (containsSecret === true)
 * AND redaction (redactSecrets changed, the specific synthetic secret part
 * ABSENT, the site placeholder present) — no detection-without-redaction
 * false green.
 *
 * RED at base (17ebef6c7), GREEN after the F5 union. All tokens are synthetic;
 * none are real credentials.
 */
import { describe, expect, test } from 'bun:test';
import {
	containsSecret,
	findSecrets,
	redactSecrets,
} from '../../../src/memory/redaction';

/**
 * Assembled by concatenation so no full token-shaped literal sits in source
 * (the redaction-zw-fill.test.ts precedent).
 */
const DIR_JWE = [
	'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
	'',
	'eyJzdWIiOiJ4In0',
	'ab',
	'cde',
].join('.');
const UNSIGNED = ['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJ4In0', ''].join('.');
const E30_PAYLOAD = ['eyJhbGciOiJIUzI1NiJ9', 'e30', 'S'.repeat(34)].join('.');

/**
 * The scanner-covered distinctive part of each shape — the substring whose
 * absence proves the WHOLE span redacted (the claims payload / the signature
 * run; the dir-JWE's leading JOSE header segment stays visible by the shared
 * scanner's own span decision, identical to the shell site — parity is the
 * contract, and the header alone carries no signed claims).
 */
const SECRET_PARTS: Array<[string, string, string[]]> = [
	['5-part dir-JWE', DIR_JWE, ['eyJzdWIiOiJ4In0', '.ab.cde']],
	['unsigned JWT (trailing dot)', UNSIGNED, ['eyJzdWIiOiJ4In0']],
	['e30-payload JWT', E30_PAYLOAD, ['e30', 'S'.repeat(34)]],
];

describe('#3893 AC10 — memory scanner JWS parity (F5)', () => {
	test.each(SECRET_PARTS)(
		'%s is detected by containsSecret',
		(_name, token) => {
			const probe = `authorization header carried ${token} verbatim`;
			expect(containsSecret(probe)).toBe(true);
			expect(findSecrets(probe).map((f) => f.type)).toContain('jws_span');
		},
		30_000,
	);

	test.each(SECRET_PARTS)(
		'%s is redacted: specific secret parts absent, jws_span placeholder present',
		(_name, token, parts) => {
			const out = redactSecrets(`authorization header carried ${token} end`);
			expect(out).toContain('[REDACTED:jws_span]');
			expect(out).not.toBe(`authorization header carried ${token} end`);
			for (const part of parts) {
				expect(out).not.toContain(part);
			}
		},
		30_000,
	);

	test('a full eyJ triple yields BOTH the jwt_token family finding and the jws_span union', () => {
		// The legacy family arm still fires (placeholder byte-identity is
		// pinned by redaction.test.ts); the F5 union ADDS coverage, it does not
		// replace it. findSecrets reports both types for the same span.
		const token = [
			'eyJhbGciOiJIUzI1NiJ9',
			'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
			'c2lnbmF0dXJlMTIzNDU2Nzg5MGFi',
		].join('.');
		const probe = `session resume ${token} done`;
		const types = findSecrets(probe).map((f) => f.type);
		expect(types).toContain('jwt_token');
		expect(types).toContain('jws_span');
		// Sequential priority is unchanged: the family placeholder wins the
		// bytes (the JWS sweep runs last and cannot match the placeholder).
		expect(redactSecrets(probe)).toBe(
			'session resume [REDACTED:jwt_token] done',
		);
	}, 30_000);

	// Preserving leg (frozen check AC10): a plain 40-hex commit digest in
	// prose must NOT be flagged — the union must not over-redact.
	test('40-hex commit digest prose stays undetected and byte-identical', () => {
		const digestSentence =
			'The build succeeded and commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d4e5f6a7b8 was pushed to main by the release bot.';
		expect(containsSecret(digestSentence)).toBe(false);
		expect(findSecrets(digestSentence)).toEqual([]);
		expect(redactSecrets(digestSentence)).toBe(digestSentence);
	}, 30_000);
});
