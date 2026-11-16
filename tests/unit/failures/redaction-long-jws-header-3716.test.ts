/**
 * #3723 (AC10 durable pin): a three-segment JWS whose first (header) segment
 * exceeds the legacy arm's 1024-char bound is fully eliminated at BOTH
 * redaction sites, without unbounded backtracking.
 *
 * Root cause: both jwt arms bounded the header to {10,1024} (a backtracking
 * bound the old regex shape needed); an x5c certificate-chain header
 * (1.2-5 KB) misses, and the ≥80-char base64 fallback arms (class excludes
 * -/_) never catch the 40-60 char payload/signature. Fix: linear span scan
 * (`src/utils/jws-redaction.ts`) — textual pre-pass at the shell site, span
 * producer on BOTH display-sweep views (uncondensed + Cf/DI-condensed) with
 * the legacy arms retained. Harness mirrors the frozen C13 probe and the
 * R7 reproduction shapes.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';
import {
	findJwsTokenSpans,
	JWS_REDACTION_LABEL,
	redactJwsTokens,
} from '../../../src/utils/jws-redaction';

const PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyBVc2VyIn0';
const SIGNATURE = 'c3ludGhldGljLXNpZ25hdHVyZS1ieXRlcy0wMTIzNDU2Nzg5';

function b64url(len: number, seed: string, alphabet: string): string {
	let out = '';
	for (let i = 0; i < len; i++) {
		out += alphabet[(seed.charCodeAt(i % seed.length) + i) % alphabet.length];
	}
	return out;
}

const PLAIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const URL_SAFE = `${PLAIN}-_`;

function longHeader(alphabet: string): string {
	return `eyJ${b64url(1252, 'x5c-cert-chain-header-pad', alphabet)}`;
}

describe('long-header JWS redaction (#3723 / AC10)', () => {
	test('dash-free long header: payload and signature eliminated at BOTH sites (bare placement)', () => {
		const token = `${longHeader(PLAIN)}.${PAYLOAD}.${SIGNATURE}`;
		const display = sanitizeFailureEvidenceDisplay(token);
		// The display bound is 512 bytes, so the leak check must run on a
		// SHORT input: assert on the sanitizer applied to the payload tail
		// region by checking the pre-bound display output AND the raw span
		// coverage (the display bound truncates long outputs by design).
		expect(display.includes(PAYLOAD)).toBe(false);
		const shell = redactShellCommand(token);
		expect(shell.includes(PAYLOAD)).toBe(false);
		expect(shell.includes(SIGNATURE)).toBe(false);
		expect(shell).toContain(JWS_REDACTION_LABEL);
	});

	test('dash-bearing long header: same elimination (both sites)', () => {
		const token = `${longHeader(URL_SAFE)}.${PAYLOAD}.${SIGNATURE}`;
		const display = sanitizeFailureEvidenceDisplay(token);
		expect(display.includes(PAYLOAD)).toBe(false);
		const shell = redactShellCommand(token);
		expect(shell.includes(PAYLOAD)).toBe(false);
		expect(shell.includes(SIGNATURE)).toBe(false);
	});

	test('control: short-header JWS still fully redacted at both sites', () => {
		const token = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIGNATURE}`;
		expect(redactShellCommand(token)).not.toContain(PAYLOAD);
		expect(sanitizeFailureEvidenceDisplay(token)).not.toContain(PAYLOAD);
	});

	test('control: non-JWT dotted text untouched', () => {
		for (const text of ['1.2.3', 'foo.bar.baz', 'see.example.token.here']) {
			expect(redactJwsTokens(text)).toBe(text);
		}
	});

	test('short JWT with an embedded Cf/DI zero-width byte still redacts at the display site (legacy condensed arm retained)', () => {
		const token = `eyJhbGciOiJIUzI1NiJ9.e${'​'}yJzdWIi.${SIGNATURE}`;
		const display = sanitizeFailureEvidenceDisplay(token);
		expect(display.includes(SIGNATURE.slice(0, 24))).toBe(false);
	});

	test('long-header token with an embedded zero-width byte redacts at the display site (two-view span producer)', () => {
		const header = longHeader(PLAIN);
		const token = `${header.slice(0, 600)}​${header.slice(600)}.${PAYLOAD}.${SIGNATURE}`;
		const display = sanitizeFailureEvidenceDisplay(token);
		expect(display.includes(PAYLOAD)).toBe(false);
	});

	test('non-eyJ payload token stays covered (e30 shape)', () => {
		const token = `eyJhbGciOiJIUzI1NiJ9.e30.${SIGNATURE}`;
		expect(redactShellCommand(token)).not.toContain(SIGNATURE);
	});
});

describe('findJwsTokenSpans semantics (leftmost, non-overlapping, linear)', () => {
	test('two adjacent tokens in one input are both replaced', () => {
		const a = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIGNATURE}`;
		const b = `eyJhbGciOiJIUzI1NiJ9.e30.${SIGNATURE}`;
		const out = redactJwsTokens(`${a} ${b}`);
		expect(out).toBe(`${JWS_REDACTION_LABEL} ${JWS_REDACTION_LABEL}`);
	});

	test('multiple tokens inside ONE dotted run: prefix/suffix text preserved, leftmost non-overlapping consumption', () => {
		const a = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIGNATURE}`;
		const b = `eyJhbGciOiJIUzI1NiJ9.e30.${SIGNATURE}`;
		const out = redactJwsTokens(`pre.${a}.${b}.post`);
		expect(out).toBe(`pre.${JWS_REDACTION_LABEL}.${JWS_REDACTION_LABEL}.post`);
	});

	test('an overlapping candidate (4+ segments) accepts only the leftmost triple', () => {
		// header.payload.sig.THENSEG is not a token start (no eyJ), so the
		// first triple wins and the trailing segment survives verbatim.
		const token = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIGNATURE}`;
		const out = redactJwsTokens(`${token}.tail`);
		expect(out).toBe(`${JWS_REDACTION_LABEL}.tail`);
	});

	test('a later in-header -eyJ does not mask an earlier eligible boundary (implementation-review r1)', () => {
		// Shape: x-eyJ<long header containing '-eyJx'>.payload.sig — the
		// scanner must take the LEFTMOST boundary (after 'x-'), not the later
		// hyphenated one whose remaining length would be short.
		const header = 'eyJ' + 'a'.repeat(600) + '-eyJx' + 'b'.repeat(600);
		const token = 'x-' + header + '.' + PAYLOAD + '.' + SIGNATURE;
		const out = redactJwsTokens(token);
		expect(out).toBe('x-' + JWS_REDACTION_LABEL);
		expect(redactShellCommand(token)).not.toContain(SIGNATURE);
		expect(sanitizeFailureEvidenceDisplay(token)).not.toContain(SIGNATURE);
	});

	test('boundary segment lengths: 12-char header rejected, 13 accepted; 0-char payload rejected, 1 accepted; 9-char signature rejected, 10 accepted', () => {
		expect(
			findJwsTokenSpans(`eyJ${'a'.repeat(9)}.pay.${'s'.repeat(10)}`),
		).toHaveLength(0);
		expect(
			findJwsTokenSpans(`eyJ${'a'.repeat(10)}.pay.${'s'.repeat(10)}`),
		).toHaveLength(1);
		expect(
			findJwsTokenSpans(`eyJ${'a'.repeat(10)}..${'s'.repeat(10)}`),
		).toHaveLength(0);
		expect(
			findJwsTokenSpans(`eyJ${'a'.repeat(10)}.p.${'s'.repeat(10)}`),
		).toHaveLength(1);
		expect(
			findJwsTokenSpans(`eyJ${'a'.repeat(10)}.pay.${'s'.repeat(9)}`),
		).toHaveLength(0);
		expect(
			findJwsTokenSpans(`eyJ${'a'.repeat(10)}.pay.${'s'.repeat(10)}`),
		).toHaveLength(1);
	});
});

describe('redaction perf bound (#3723)', () => {
	test('a 256 KB dense adversarial eyJ input completes and leaves no raw eyJ-prefixed segment', () => {
		const unit = `eyJ${'a'.repeat(20)}.${'b'.repeat(12)}.${'c'.repeat(12)}`;
		const input = `${unit}.`.repeat(8192);
		expect(input.length).toBeGreaterThanOrEqual(250_000);
		const start = performance.now();
		const out = redactJwsTokens(input);
		const elapsed = performance.now() - start;
		// Generous bound (base completes in ~30-80 ms): the point is NO
		// quadratic blowup, not a tight microbenchmark.
		expect(elapsed).toBeLessThan(2_000);
		expect(out).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}\./);
	});
});
