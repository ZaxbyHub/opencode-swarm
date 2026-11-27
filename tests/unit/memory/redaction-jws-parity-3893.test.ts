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

// ---------------------------------------------------------------------------
// #3952 F-009 — regression: quadratic JWS arbitration on token-dense input.
//
// Prior behavior: findSecrets unions the shared JWS scanner
// (jwsSpanSelection -> findRedactableTokenSpans,
// src/utils/jws-redaction.ts) whose clamp arbitration tested EVERY
// enumerated generic candidate against the ENTIRE eyJ span array
// (isClampEligible's eyJ.some(...) plus the inner eyJ rescan) —
// O(candidates x eyJ), and both counts grow with input length, so
// token-dense input was quadratic: the pre-fix scanner measured 394 ms ->
// 16.6 s (ratio 42) for an 8x input growth on the interleaved shape below,
// dragging the memory scanner with it. The fix observes that eyJ spans are
// pairwise disjoint and start-sorted while the clamp predicate reduces to
// "the head strictly contains the candidate's start" — at most ONE head can
// qualify per candidate — so a monotonic pointer sweep (O(candidates + eyJ))
// replaces the nested scans with byte-identical output (verified against the
// pre-fix module across 400 randomized token-dense fuzz inputs plus the
// #3736/#3743 exact-output suites).
// ---------------------------------------------------------------------------
/**
 * Minimal eyJ-anchored triple (13-char header, 1-char payload and signature —
 * the D6-rev floor) and minimal generic standard-base64 candidate (40-char
 * header, 20-char payload, 10-char signature — the D4-rev3 floor). One of
 * each per unit maximizes the spans-per-byte density of the adversarial
 * input: the arbitration cost per unit pair is fixed, so total work tracks
 * units^2 in the quadratic regime.
 */
const F009_EYJ_MIN = `eyJ${'a'.repeat(10)}.b.c`;
const F009_GEN_MIN = `${'H'.repeat(40)}.${'P'.repeat(20)}.${'S'.repeat(10)}`;

function f009DenseInput(units: number): string {
	const parts: string[] = [];
	for (let i = 0; i < units; i++)
		parts.push(F009_EYJ_MIN, ' ', F009_GEN_MIN, ' ');
	return parts.join('');
}

describe('#3952 F-009 — memory scanner JWS arbitration stays bounded on token-dense input', () => {
	test('detection correctness is preserved at scale: every span found, redacted, no raw material left', () => {
		const input = f009DenseInput(400);
		// One jws_span finding per token (the minimal eyJ triple's payload is
		// not eyJ-prefixed, so the legacy jwt_token family arm leaves it to
		// the JWS sweep; the generic candidate is eyJ-free entirely).
		const findings = findSecrets(input).filter((f) => f.type === 'jws_span');
		expect(findings).toHaveLength(800);
		const out = redactSecrets(input);
		expect((out.match(/\[REDACTED:jws_span\]/g) ?? []).length).toBe(800);
		expect(out).not.toContain(F009_EYJ_MIN);
		expect(out).not.toContain(F009_GEN_MIN);
	}, 30_000);

	test('clamp (glued-header) arbitration stays exact at scale through the bounded sweep', () => {
		// The #3743 glued composition drives the clamp path — the eyJ span's
		// absorbed tail overreaches into a glued standard-b64 header, and the
		// candidate clamps the head's end. 500 compositions grow BOTH the
		// candidate and the eyJ collections; the bounded sweep must keep the
		// per-unit output byte-identical to the quadratic arbitration.
		const unit = [
			'eyJhbGciOiJIUzI1NiIsImtpZCI6InRlc3QifQ',
			'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyBVc2VyIn0',
			'c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA',
			`${'Q'.repeat(20)}/${'R'.repeat(20)}`,
			'cGF5bG9hZHR3by1zeW50aGV0aWM',
			'c2lnMi1zeW50aGV0aWM',
		].join('.');
		const parts: string[] = [];
		const expected: string[] = [];
		for (let i = 0; i < 500; i++) {
			parts.push(`leak ${i} `, unit, ' ');
			// Family placeholder takes the leading eyJ triple; the JWS sweep
			// takes the clamped glued-candidate remainder (pinned above).
			expected.push(`leak ${i} [REDACTED:jwt_token].[REDACTED:jws_span] `);
		}
		const out = redactSecrets(parts.join(''));
		expect(out).toBe(expected.join(''));
	}, 30_000);

	test('arbitration grows linearly, not quadratically (8x input growth-ratio bound)', () => {
		// Machine-speed-invariant discriminator: an 8x input growth makes
		// linear work ~8x slower and the pre-fix quadratic ~42x (measured;
		// through findSecrets the linear regex families only dilute that to
		// ~30x). The fixed scanner measures ~7.5-8x; the threshold 20 fails
		// the quadratic regime outright while leaving >2x margin above the
		// linear one. The count assertions keep an early-exit "optimization"
		// (returning early to game the clock) from passing the timing check.
		const small = f009DenseInput(8_000);
		const large = f009DenseInput(64_000);
		// Warm both paths so JIT compilation does not inflate the small leg.
		findSecrets(small);
		findSecrets(large);
		let t0 = performance.now();
		const smallFindings = findSecrets(small).length;
		const smallMs = performance.now() - t0;
		t0 = performance.now();
		const largeFindings = findSecrets(large).length;
		const largeMs = performance.now() - t0;
		expect(smallFindings).toBe(16_000);
		expect(largeFindings).toBe(128_000);
		expect(largeMs / smallMs).toBeLessThan(20);
	}, 30_000);
});
