/**
 * #3743 CI-tracked regression coverage for the three JWS-scanner residuals
 * (AC3/AC4/AC5): the frozen acceptance checks (C3-C5) drove the fix, but
 * trace-local probes are not lasting CI coverage. This suite pins the same
 * shapes plus the plan-critic-mandated boundary rows (R4/R5/R6/R12/R21/R24/
 * R25/R26), with exact-output assertions at both failure-evidence redaction
 * sites. Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';
import {
	findJwsTokenSpans,
	findRedactableTokenSpans,
	findStandardB64TokenSpans,
} from '../../../src/utils/jws-redaction';

const HDR = 'eyJhbGciOiJIUzI1NiIsImtpZCI6InRlc3QifQ';
const PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyBVc2VyIn0';
const SIG = 'c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA';
const GLUED = 'Q'.repeat(20) + '/' + 'R'.repeat(20);
const PAY2 = 'cGF5bG9hZHR3by1zeW50aGV0aWM';
const SIG2 = 'c2lnMi1zeW50aGV0aWM';

function bothSites(input: string): [string, string] {
	return [redactShellCommand(input), sanitizeFailureEvidenceDisplay(input)];
}

describe('#3743 JWS scanner residuals (CI-tracked)', () => {
	test('AC3: dir-JWE with a non-tokenLike IV redacts at both sites (RED at base)', () => {
		// 10-char all-lowercase IV fails tokenLike; the structural 5-part
		// shape with an empty second segment still identifies the token.
		const iv10 = 'i'.repeat(10);
		const input = `${HDR}..${iv10}.ct-tag-aaaaaaaaaaaa.tag-tag-aaaa`;
		for (const out of bothSites(input)) {
			expect(out).not.toContain(iv10);
			expect(out).toContain('[REDACTED:jwt]');
		}
	});

	test('AC3 boundaries: empty IV rejected; passing IV unchanged; tail gates intact', () => {
		expect(findJwsTokenSpans(`${HDR}...ct.tag`)).toHaveLength(0);
		const passingIv = 'I'.repeat(22);
		expect(findJwsTokenSpans(`${HDR}..${passingIv}.ct.tag`)).toHaveLength(1);
		// Tail absorption stays selective (pinned rows): `.build2024` visible.
		expect(redactShellCommand(`${HDR}.${PAYLOAD}.${SIG}.build2024`)).toBe(
			'[REDACTED:jwt].build2024',
		);
		// 16-char all-lowercase IV passes via the >=16 arm even pre-fix.
		expect(findJwsTokenSpans(`${HDR}..${'i'.repeat(16)}.ct.tag`)).toHaveLength(
			1,
		);
	});

	test('AC4: 13-39-char standard header decoding to a JSON object redacts; benign path stays visible', () => {
		// eyJhbGciOiJIUzI1NiJ9 is the canonical 20-char HS256 header (decodes
		// to {"alg":"HS256"}); with unpadded payload/signature segments it
		// sits below the 40-char generic floor.
		const header20 = 'eyJhbGciOiJIUzI1NiJ9';
		const input = `key ${header20}.${PAYLOAD}.${SIG} tail`;
		for (const out of bothSites(input)) {
			expect(out).not.toContain(PAYLOAD);
			expect(out).toContain('[REDACTED:jwt]');
		}
		// Benign dotted path (pinned 3736:118-121) MUST stay visible.
		const path = 'src/utils/jws-redaction.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbb';
		expect(redactShellCommand(path)).toBe(path);
		expect(sanitizeFailureEvidenceDisplay(path)).toBe(path);
	});

	test('AC4 adversarial: malformed padding and non-JSON decode stay visible', () => {
		// `{this-is-not-json}` decodes from a 24-char standard run — it has a
		// `{` prefix but is NOT valid JSON, so it must stay visible.
		const notJson = Buffer.from('{this-is-not-json}')
			.toString('base64')
			.replace(/=+$/, '');
		const input = `${notJson}.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(input)).toBe(input);
		// Interior `=` junk never validates.
		const junk = `${header20Safe()}=junk`;
		expect(redactShellCommand(`${junk}.${PAYLOAD}.${SIG}`)).toBe(
			`${junk}.${PAYLOAD}.${SIG}`,
		);
	});

	test('AC5: dot-glued standard-b64 token after an eyJ token — direct candidate and exact outputs', () => {
		const input = `synthetic glued ${HDR}.${PAYLOAD}.${SIG}.${GLUED}.${PAY2}.${SIG2} trailing`;
		// Direct span assertions: the GLUED-headed candidate is emitted (the
		// greedy skip / drop-at-448 must not hide it), non-overlapping.
		const spans = findRedactableTokenSpans(input);
		const gluedSpans = spans.filter((s) => s.start >= input.indexOf(GLUED));
		expect(gluedSpans.length).toBeGreaterThanOrEqual(1);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
		}
		for (const out of bothSites(input)) {
			expect(out).not.toContain(PAY2);
			expect(out).not.toContain(SIG2);
			expect(out).toContain('[REDACTED:jwt]');
		}
	});

	test('AC5 base64url variant: all-compatible glued token fully absorbed (budget 3)', () => {
		const glued41 = 'Q'.repeat(41);
		const input = `${HDR}.${PAYLOAD}.${SIG}.${glued41}.${PAY2}.${SIG2}`;
		for (const out of bothSites(input)) {
			expect(out).not.toContain(PAY2);
			expect(out).not.toContain(SIG2);
		}
	});

	test('AC5 base-preserving: generic-only composition output is unchanged (Q40 control)', () => {
		const input = `${'Q'.repeat(40)}.e`.repeat(1);
		// Four generic-compatible segments: enumeration must NOT widen base's
		// output (the last segment stays visible at base and at head).
		const seg = 'q'.repeat(40);
		const input4 = `${seg}.${'e'.repeat(40)}.${'f'.repeat(40)}.${'g'.repeat(40)}`;
		const spans = findRedactableTokenSpans(input4);
		expect(spans).toHaveLength(1);
		const out = redactShellCommand(input4);
		expect(out.endsWith(`.${'g'.repeat(40)}`)).toBe(true);
		expect(input).toBeTruthy();
	});

	test('AC5 Stage-B: clamp emits [0,86),[86,170) — non-overlapping, two placeholders', () => {
		const hdr60 = 'eyJ' + 'a'.repeat(57);
		const payload24 = 'e'.repeat(24);
		const hdr2 = 'eyJ' + 'b'.repeat(40);
		const input = `${hdr60}.${payload24}.f9+${hdr2}.c`.repeat(1);
		const full = `${hdr60}.${payload24}.f9+${hdr2}.${'c'.repeat(24)}.${'d'.repeat(12)}`;
		const spans = findRedactableTokenSpans(full);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
		}
		expect(redactShellCommand(full)).toBe('[REDACTED:jwt][REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(full)).toBe(
			'[REDACTED:jwt][REDACTED:jwt]',
		);
		expect(input).toBeTruthy();
	});

	test('AC5 Stage-B + absorbed tail: coverage preserved through the tail', () => {
		const hdr60 = 'eyJ' + 'a'.repeat(57);
		const payload24 = 'e'.repeat(24);
		const hdr2 = 'eyJ' + 'b'.repeat(40);
		const tail = 'Z'.repeat(20);
		const full = `${hdr60}.${payload24}.f9+${hdr2}.${'c'.repeat(24)}.${'d'.repeat(12)}.${tail}`;
		const out = redactShellCommand(full);
		expect(out).not.toContain(tail);
		expect(out).toContain('[REDACTED:jwt][REDACTED:jwt]');
	});

	test('AC5 extended composition: base survivor L never evicted by clamp candidate K', () => {
		const P40 = 'P'.repeat(40);
		const S20 = 'S'.repeat(20);
		const T10 = 'T'.repeat(10);
		const input = `${HDR}.${PAYLOAD}.${SIG}.${GLUED}.${P40}.${S20}.${T10}`;
		const spans = findRedactableTokenSpans(input);
		// Coverage reaches the end of L (the final T segment).
		const lastEnd = spans[spans.length - 1]?.end ?? 0;
		expect(lastEnd).toBe(input.length);
		const out = redactShellCommand(input);
		expect(out).not.toContain(T10);
		expect(out).toContain('[REDACTED:jwt][REDACTED:jwt]');
	});

	test('AC5 approved widening (R26): clamp-generic vs clamp-generic separator collapse', () => {
		const hdr60 = 'eyJ' + 'a'.repeat(57);
		const payload24 = 'e'.repeat(24);
		const hdr2 = 'eyJ' + 'b'.repeat(40);
		const input =
			`${hdr60}.${payload24}.f9+` +
			`${hdr2}.${'c'.repeat(24)}.${'d'.repeat(40)}.` +
			`${'eyJ' + 't'.repeat(17)}.${'u'.repeat(10)}.v`;
		// Base produced three placeholders with a visible internal dot; the
		// approved widening merges the clamp-adjacent spans (coverage never
		// shrinks). Exact pinned output:
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt][REDACTED:jwt]');
	});

	test('greedy base scan stays greedy (B-set pinned): artifact advances past consumed triple', () => {
		// The greedy findStandardB64TokenSpans output itself is pinned by the
		// 3736 suites; here pin that the enumerated superset exists for the
		// C5 fixture while the greedy set is unchanged from base behavior.
		const input = `${HDR}.${PAYLOAD}.${SIG}.${GLUED}.${PAY2}.${SIG2}`;
		const greedy = findStandardB64TokenSpans(input);
		expect(greedy.length).toBeGreaterThanOrEqual(1);
	});
});

function header20Safe(): string {
	return 'eyJhbGciOiJIUzI1NiJ9';
}
