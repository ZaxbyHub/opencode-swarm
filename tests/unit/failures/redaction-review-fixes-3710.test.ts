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

	test('a JWT with a long-but-bounded header is still redacted at both sites', () => {
		// The header segment bound is 1024 chars; a token just under it must
		// still be eliminated (the bound must not cost realistic coverage).
		const longHeaderJwt = `eyJ${'A'.repeat(1000)}.eyJ${'b'.repeat(40)}.${'c'.repeat(40)}`;
		expect(sanitizeFailureEvidenceDisplay(longHeaderJwt)).toContain(
			'[REDACTED:jwt]',
		);
		expect(redactShellCommand(longHeaderJwt)).toContain('[REDACTED:jwt]');
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
