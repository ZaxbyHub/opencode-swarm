import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/**
 * #3710/#3712 swarm-pr-review round-1 regression pins.
 *
 * R-19: the JWT arm's unbounded header segment made the SHELL site quadratic
 * on a dense `eyJ-` run (measured: 64KB -> 1.5-2.1s, 256KB -> 30.7-33.3s),
 * and the shell site has no input-length bound and redacts BEFORE the audit
 * truncation, so a large shell command froze the default-on shell-audit path.
 * The header segment is now bounded; these rows pin both the bound and the
 * continued redaction of a real JWT.
 *
 * R-06: the azure contextual arm was case-sensitive, so `accountKey=` (Azure
 * parses connection-string keys case-insensitively) survived at the shell site
 * in CLEAR TEXT while the display site's generic KV arm redacted it.
 *
 * Synthetic material only.
 */

const SYNTH_JWT =
	'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJTeW50aGV0aWNUb2tlbiJ9.c2lnbmF0dXJlQWxQaGFzaHZhbHVlVmFsdWVUb2tlbg';
const SYNTH_AZURE_KEY = 'c3luTHNvbWVLZXlWYWx1ZTEyMzQ1Njc4OWFiY2RlZg';

describe('JWT arm is bounded at the shell site (#3710 review R-19)', () => {
	test('a dense eyJ- run is scanned within a bounded time budget', () => {
		const dense = 'eyJ-'.repeat(64_000);
		const started = performance.now();
		const out = redactShellCommand(dense);
		const elapsedMs = performance.now() - started;
		// The unbounded arm took ~30s on this input; the bounded arm is
		// sub-second. The budget is generous for a loaded CI host. A run
		// that never terminates fails the test by the per-test timeout.
		expect(elapsedMs).toBeLessThan(5_000);
		// The run is NOT a credential (no dot-separated segments, and the
		// base64 arm's class excludes '-'), so it stays visible — the point
		// of the row is the scan cost, not the elimination.
		expect(out.length).toBeGreaterThan(0);
	}, 30_000);

	test('a real JWT is still redacted at both sites', () => {
		expect(sanitizeFailureEvidenceDisplay(SYNTH_JWT)).toContain(
			'[REDACTED:jwt]',
		);
		expect(redactShellCommand(SYNTH_JWT)).toContain('[REDACTED:jwt]');
	}, 30_000);

	test('a JWT with a non-object payload (empty claims, e30) is redacted at both sites', () => {
		// An EMPTY claims object encodes as `e30`, not `eyJ` — the payload
		// segment of a JWT is any base64url run, not only a JSON object. An
		// arm that required the payload to start with `eyJ` missed this shape
		// (and a `null`/string payload encodes as `bnVsbA`/`Ingi`).
		const emptyClaimsJwt =
			'eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJlU2lnbmF0dXJlVmFsdWUxMjM0NTY3ODkw';
		expect(sanitizeFailureEvidenceDisplay(emptyClaimsJwt)).toContain(
			'[REDACTED:jwt]',
		);
		expect(redactShellCommand(emptyClaimsJwt)).toContain('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(emptyClaimsJwt)).not.toContain(
			'e30.',
		);
	}, 30_000);

	test('a JWT with a long-but-bounded header is still redacted at both sites', () => {
		// The header segment bound is 1024 chars; a token just under it must
		// still be eliminated (the bound must not cost realistic coverage).
		const longHeaderJwt = `eyJ${'A'.repeat(1000)}.eyJ${'b'.repeat(40)}.${'c'.repeat(40)}`;
		expect(sanitizeFailureEvidenceDisplay(longHeaderJwt)).toContain(
			'[REDACTED:jwt]',
		);
		expect(redactShellCommand(longHeaderJwt)).toContain('[REDACTED:jwt]');
	}, 30_000);

	test('the over-long-header residual is the DISCLOSED bound, not an accident', () => {
		// The bound is a deliberate, disclosed trade: a JWT whose header
		// segment exceeds 1024 chars is NOT matched by the jwt arm. This row
		// uses the REAL shape that exceeds the bound — a JWS carrying an
		// `x5c` certificate chain (RFC 7515 §4.1.6; e.g. an Apple App Store
		// Server or Android attestation signed payload) has a header of
		// 1.2-5 KB, so it IS produced in practice. The header itself is
		// still caught by the base64 arm, but the PAYLOAD and the
		// SIGNATURE survive in clear text in a bare placement at both
		// sites. The row pins that residual so a future change to the
		// bound is a deliberate decision and the release fragment's
		// disclosed bound stays true.
		const x5cHeader = Buffer.from(
			JSON.stringify({
				alg: 'RS256',
				typ: 'JWT',
				x5c: ['MII' + 'A'.repeat(900)],
			}),
			'utf8',
		).toString('base64url');
		expect(x5cHeader.length).toBeGreaterThan(1024);
		const overLongHeaderJwt = `${x5cHeader}.eyJ${'b'.repeat(40)}.${'c'.repeat(40)}`;
		expect(sanitizeFailureEvidenceDisplay(overLongHeaderJwt)).not.toContain(
			'[REDACTED:jwt]',
		);
		expect(redactShellCommand(overLongHeaderJwt)).not.toContain(
			'[REDACTED:jwt]',
		);
	}, 30_000);
});

describe('azure contextual arm is case-insensitive at both sites (#3710 review R-06)', () => {
	for (const key of ['AccountKey', 'accountKey', 'ACCOUNTKEY']) {
		test(`${key}= is redacted at both sites`, () => {
			const input = `DefaultEndpointsProtocol=https;${key}=${SYNTH_AZURE_KEY};EndpointSuffix=core.windows.net`;
			const display = sanitizeFailureEvidenceDisplay(input);
			const shell = redactShellCommand(input);
			expect(display).not.toContain(SYNTH_AZURE_KEY);
			expect(shell).not.toContain(SYNTH_AZURE_KEY);
			expect(display).toContain('[REDACTED:azure]');
			expect(shell).toContain('[REDACTED:azure]');
		}, 30_000);
	}
});
