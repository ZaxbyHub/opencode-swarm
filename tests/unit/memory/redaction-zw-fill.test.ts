/**
 * #3743 item 1 (J1/AC1): the memory-storage secret scanner (findSecrets /
 * containsSecret / redactSecrets in src/memory/redaction.ts) must tolerate a
 * Cf/DI invisible byte (U+200B zero-width space, U+00AD soft hyphen, U+FE0F
 * variation selector) inside a bare credential token the same way the two
 * failure-evidence sites already do (#3730/#3736 condensed-view union —
 * src/failures/invocation-failure.ts, src/hooks/guardrails/helpers.ts): the
 * split form reports the SAME finding type as the plain form, containsSecret
 * is true for the split form, and benign prose carrying an invisible byte
 * passes through byte-identical.
 *
 * RED at base 6864cd83b (split forms missed across every probed family; this
 * file does not exist there), GREEN after the fix. Behavioral base evidence:
 * repro/C1.staged-base.log — every split row and the policy row RED at base;
 * every plain, benign-control, and base-equivalence row GREEN at base.
 *
 * Round-1 amendments (plan v2 R10):
 * - Coverage widened to ALL 14 SECRET_PATTERNS families: the seven core
 *   families (FAMILY_TOKENS) plus the seven EXTRA_FAMILY_ROWS below (bearer
 *   header, labeled AWS secret, context AWS secret, env-var secret, RSA
 *   private-key block, OpenSSH private-key block, stripe secret key).
 * - Judgment calls per family (a split that base already absorbs would be a
 *   vacuous row): the two PEM families split INSIDE the
 *   `-----BEGIN ... PRIVATE KEY-----` delimiter text (their `[\s\S]*?` body
 *   is already Cf-tolerant); env_secret splits in the NAME (its non-space
 *   value class already absorbs a Cf byte inside the value); the bearer
 *   split keeps both body halves under the arm's {12,} floor.
 * - Two ordering base-equivalence rows (R2) pin the ACTUAL base output
 *   bytes for the labeled-AWS two-placeholder shape and the github/slack
 *   overlap shape; they must pass at base AND head (sequential priority
 *   over the raw spans is preserved by the two-view fix).
 * - The policy row pins the POST-fix literals 4_000_029/4_000_028 (R1 bumps
 *   REDACTION_POLICY_SALT 3 -> 4): RED at base (salt 3 computes 3_000_029),
 *   GREEN after the fix. (#3893/#3915 update: salt is now 5 and the family
 *   count is 15 — the PEM no-END fallback joined — so the row pins
 *   5_000_031/5_000_030.)
 *
 * Family-count freeze: SECRET_PATTERNS stays at 15 families (14 through
 * #3743; #3893/#3915 added the private_key_block_nogap no-END PEM fallback) —
 * the computeRedactionPolicyVersion pin below (mirroring
 * tests/unit/memory/redaction-policy-version-bump.test.ts:60-67) fails if a
 * family is added or removed while riding a fix.
 *
 * Round-2 amendments (plan v3 R13, critic-round-2.md "Test Gaps"):
 * - redactSecrets SPLIT-FORM assertions for EVERY family (previously only
 *   findSecrets/containsSecret were asserted on split rows — a broken or
 *   still-raw redactSecrets could pass them). Each row asserts the family's
 *   own [REDACTED:<type>] placeholder appears AND the split token's payload
 *   bytes do not survive (neither piece of the split, nor the invisible byte
 *   itself). RED at base (redactSecrets misses split forms there).
 * - Cf-bearing variants of the two R2 ordering base-equivalence rows: same
 *   inputs with a U+200B inside one token; RED at base (the split token is
 *   missed — or matches only a truncated raw span), GREEN at head, and the
 *   head output must equal the non-Cf twin byte-for-byte (same placeholder
 *   structure).
 * - A same-pattern raw/condensed overlap fixture (critic "Edge Cases" R2
 *   bullet): an openai token whose raw match is SHORTER than its condensed
 *   match at the same start; the head must redact the LONGER span in one
 *   piece (leftmost-longest per-pattern selection, R13 step 3). RED at base
 *   (the condensed tail stays visible behind the raw placeholder).
 *
 * All tokens are synthetic; none are real credentials.
 */
import { describe, expect, test } from 'bun:test';
import {
	computeRedactionPolicyVersion,
	containsSecret,
	findSecrets,
	redactSecrets,
} from '../../../src/memory/redaction';

const ZWSP = '\u200B';
const SHY = '\u00AD';
const VS16 = '\uFE0F';

/** Synthetic 40-char value for the AWS-secret arms (the exact {40} length). */
const AWS40 = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3A';

/** [family label, expected finding type, synthetic plain token] */
const FAMILY_TOKENS: Array<[string, string, string]> = [
	['openai sk-', 'openai_api_key', 'sk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8'],
	['github ghp_', 'github_token', 'ghp_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'],
	['gitlab glpat-', 'gitlab_token', 'glpat-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'],
	['slack xoxb-', 'slack_token', 'xoxb-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr'],
	[
		'google AIza',
		'google_api_key',
		'AIza' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
	],
	['aws AKIA', 'aws_access_key_id', 'AKIA' + 'IOSFODNN7EXAMPLE'],
	[
		'jwt',
		'jwt_token',
		'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2Nzg5MGFi',
	],
];

const RSA_BODY = 'MIIBSyntheticBodyNotARealKey0123456789ABCDEF';
const OPENSSH_BODY = 'b3BlbnNzaC1zeW50aGV0aWMta2V5LW5vdC1yZWFs';

/**
 * [R10] The remaining seven families, each with an explicit hand-built split
 * (a midpoint split is wrong for most of these — see the per-row comments):
 * [family label, expected finding type, synthetic plain form, split form].
 */
const EXTRA_FAMILY_ROWS: Array<[string, string, string, string]> = [
	// Bearer body split 10/10: both halves stay under the arm's {12,} floor,
	// so nothing matches at base (a longer body would leave a >=12-char
	// truncated match and the row would be vacuous).
	[
		'authorization bearer',
		'authorization_bearer',
		'Authorization: Bearer Ab1Cd2Ef3Gh4Ij5Kl6Mn',
		'Authorization: Bearer Ab1Cd2Ef3G' + ZWSP + 'h4Ij5Kl6Mn',
	],
	// Labeled AWS secret: value split 20/20 breaks the exact-{40} arm.
	[
		'aws labeled SecretAccessKey=',
		'aws_secret_access_key',
		'SecretAccessKey=' + AWS40,
		'SecretAccessKey=Ab1Cd2Ef3Gh4Ij5Kl6Mn' + ZWSP + '7Op8Qr9St0Uv1Wx2Yz3A',
	],
	// Context AWS secret: the value split breaks the context arm's {40} tail;
	// at base only the bare aws_access_key_id finding survives (wrong type —
	// the row stays RED through its type assertion, not containsSecret).
	[
		'aws context AKIA...secret',
		'aws_secret_access_key_context',
		'AKIAIOSFODNN7EXAMPLE svc ' + AWS40,
		'AKIAIOSFODNN7EXAMPLE svc Ab1Cd2Ef3Gh4Ij5Kl6Mn' +
			ZWSP +
			'7Op8Qr9St0Uv1Wx2Yz3A',
	],
	// env_secret: split in the NAME (right before the KEY suffix) — the
	// arm's non-space value class already absorbs a Cf byte inside the value,
	// so a value split would be vacuous at base.
	[
		'env var secret',
		'env_secret',
		'MY_SERVICE_API_KEY=Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr',
		'MY_SERVICE_API_' + ZWSP + 'KEY=Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr',
	],
	// RSA PEM: the `[\s\S]*?` body is already Cf-tolerant, so the split goes
	// INSIDE the BEGIN delimiter text ("PRIVATE K<EY>") — at base the
	// `PRIVATE KEY-----` literal cannot match across the ZWSP.
	[
		'rsa private key block',
		'private_key_block',
		'-----BEGIN RSA PRIVATE KEY-----\n' +
			RSA_BODY +
			'\n-----END RSA PRIVATE KEY-----',
		'-----BEGIN RSA PRIVATE K' +
			ZWSP +
			'EY-----\n' +
			RSA_BODY +
			'\n-----END RSA PRIVATE KEY-----',
	],
	// OpenSSH PEM: same delimiter-split judgment. At base BOTH the OPENSSH
	// literal arm and the generic [A-Z ]* arm break; at head the condensed
	// view must restore the openssh_private_key_block finding.
	[
		'openssh private key block',
		'openssh_private_key_block',
		'-----BEGIN OPENSSH PRIVATE KEY-----\n' +
			OPENSSH_BODY +
			'\n-----END OPENSSH PRIVATE KEY-----',
		'-----BEGIN OPENSSH PRIVATE K' +
			ZWSP +
			'EY-----\n' +
			OPENSSH_BODY +
			'\n-----END OPENSSH PRIVATE KEY-----',
	],
	// Stripe: body split 10/19 keeps both halves under the {24,} floor.
	// #3743: the plain token is runtime-constructed so no literal
	// secret-shaped string is committed (GitHub push protection); the
	// scanner matches the shape, so the value is semantically identical.
	[
		'stripe sk_live_',
		'stripe_secret_key',
		'sk_' + 'live_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St',
		'sk_live_Ab1Cd2Ef3G' + ZWSP + 'h4Ij5Kl6Mn7Op8Qr9St',
	],
];

/** Insert an invisible fill byte at the token's midpoint (mid-run split). */
function splitToken(token: string, fill: string): string {
	const mid = Math.floor(token.length / 2);
	return token.slice(0, mid) + fill + token.slice(mid);
}

/**
 * Insert an invisible fill byte inside the token at an explicit offset. Used
 * for the slack family: its arm is unanchored with a {10,} body minimum, so a
 * midpoint split still leaves a >=10-char truncated match at base — an early
 * split (offset 6, one body char before the fill) keeps that row
 * discriminating at base like every other family.
 */
function splitTokenAt(token: string, fill: string, cut: number): string {
	return token.slice(0, cut) + fill + token.slice(cut);
}

const BENIGN_CONTROLS: Array<[string, string]> = [
	[
		'ordinary prose with a zero-width space inside a word',
		'ordinary pro' + ZWSP + 'se stays as-is',
	],
	[
		'ordinary prose with a soft hyphen inside a word',
		'hyphen' + SHY + 'ated prose stays as-is',
	],
	[
		'ordinary prose with a variation selector',
		'text' + VS16 + ' with a selector stays as-is',
	],
	// #3382 retained-anchor controls (redaction-embedded-secrets.test.ts:96-124
	// discipline): the anchors on stripe/jwt/openai families must survive the
	// condensed-view change — these rows fail if the fix de-anchors an arm.
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
	['openai anchor kept: task- shape prose', 'task-1234567890abcdefABCD'],
	['snake_case with a ghs_ subword', 'load_ghs_metadata_from_cache_store'],
];

describe('astral-boundary spans (#3743 implementation review R3)', () => {
	function hasLoneSurrogate(str: string): boolean {
		for (let i = 0; i < str.length; i += 1) {
			const code = str.charCodeAt(i);
			const prev = i > 0 ? str.charCodeAt(i - 1) : 0;
			const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
			const isHigh = code >= 0xd800 && code <= 0xdbff;
			const isLow = code >= 0xdc00 && code <= 0xdfff;
			const prevIsHigh = prev >= 0xd800 && prev <= 0xdbff;
			const nextIsLow = next >= 0xdc00 && next <= 0xdfff;
			if ((isHigh && !nextIsLow) || (isLow && !prevIsHigh)) return true;
		}
		return false;
	}

	test('condensed match ending in an astral char never splits the surrogate pair', () => {
		const input =
			'note MY_API_' + ZWSP + 'KEY=' + '\u{1F600}'.repeat(9) + ' end';
		const out = redactSecrets(input);
		expect(out).toContain('[REDACTED:env_secret]');
		expect(hasLoneSurrogate(out)).toBe(false);
	});

	test('astral char after a split token stays intact (no lone surrogate)', () => {
		const token = 'sk-' + 'A'.repeat(10) + ZWSP + 'B'.repeat(12) + '\u{1F600}';
		const out = redactSecrets(`x ${token} y`);
		expect(hasLoneSurrogate(out)).toBe(false);
	});
});

describe('memory secret scanner: Cf/DI zero-width split tolerance (#3743 AC1)', () => {
	test.each(FAMILY_TOKENS)(
		'%s plain form is detected (control)',
		(_family, type, token) => {
			expect(containsSecret(`note ${token} end`)).toBe(true);
			expect(
				findSecrets(`note ${token} end`).map((finding) => finding.type),
			).toContain(type);
		},
		30_000,
	);

	test.each(FAMILY_TOKENS)(
		'%s U+200B-split form yields the same finding and containsSecret=true',
		(_family, type, token) => {
			const split = token.startsWith('xoxb-')
				? splitTokenAt(token, ZWSP, 6)
				: splitToken(token, ZWSP);
			expect(containsSecret(`note ${split} end`)).toBe(true);
			expect(
				findSecrets(`note ${split} end`).map((finding) => finding.type),
			).toContain(type);
		},
		30_000,
	);

	test.each(EXTRA_FAMILY_ROWS)(
		'%s plain form is detected (control)',
		(_family, type, plain) => {
			expect(containsSecret(`note ${plain} end`)).toBe(true);
			expect(
				findSecrets(`note ${plain} end`).map((finding) => finding.type),
			).toContain(type);
		},
		30_000,
	);

	test.each(EXTRA_FAMILY_ROWS)(
		'%s U+200B-split form yields the same finding and containsSecret=true',
		(_family, type, _plain, split) => {
			expect(containsSecret(`note ${split} end`)).toBe(true);
			expect(
				findSecrets(`note ${split} end`).map((finding) => finding.type),
			).toContain(type);
		},
		30_000,
	);

	// [R13] redactSecrets split-form coverage, core families: the family's own
	// placeholder must appear and the split token's payload bytes must not
	// survive — neither piece of the split nor the invisible byte itself.
	// RED at base (redactSecrets misses split forms there).
	test.each(FAMILY_TOKENS)(
		'%s U+200B-split form is redacted whole by redactSecrets',
		(_family, type, token) => {
			const cut = token.startsWith('xoxb-') ? 6 : Math.floor(token.length / 2);
			const redacted = redactSecrets(
				`note ${splitTokenAt(token, ZWSP, cut)} end`,
			);
			expect(redacted).toContain(`[REDACTED:${type}]`);
			expect(redacted).not.toContain(token.slice(0, cut));
			expect(redacted).not.toContain(token.slice(cut));
			expect(redacted).not.toContain(ZWSP);
		},
		30_000,
	);

	// [R13] redactSecrets split-form coverage, hand-built-split families. The
	// pieces are the two substrings around the U+200B; both must be gone.
	test.each(EXTRA_FAMILY_ROWS)(
		'%s U+200B-split form is redacted whole by redactSecrets',
		(_family, type, plain, split) => {
			const redacted = redactSecrets(`note ${split} end`);
			// Sequential-priority contract (#3743 R2): the placeholder is
			// whatever the PLAIN form of this family produces under
			// redactSecrets — for the PEM families the generic
			// private_key_block arm runs before the openssh literal arm, so
			// both plain and split forms carry [REDACTED:private_key_block]
			// (findSecrets still reports BOTH types — pinned in the
			// detection rows above).
			const expected = redactSecrets(`note ${plain} end`);
			expect(redacted).toBe(expected);
			expect(redacted).toContain(
				`[REDACTED:${type === 'openssh_private_key_block' ? 'private_key_block' : type}]`,
			);
			for (const piece of split.split(ZWSP)) {
				expect(redacted).not.toContain(piece);
			}
			expect(redacted).not.toContain(ZWSP);
		},
		30_000,
	);

	test.each([
		['openai sk-', 'sk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8'],
		['gitlab glpat-', 'glpat-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'],
	] as Array<[string, string]>)(
		'%s U+00AD (soft hyphen) split form is detected',
		(_family, token) => {
			expect(containsSecret(`note ${splitToken(token, SHY)} end`)).toBe(true);
		},
		30_000,
	);

	test.each([
		['openai sk-', 'sk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8'],
		['slack xoxb-', 'xoxb-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr'],
	] as Array<[string, string]>)(
		'%s U+FE0F (variation selector) split form is detected',
		(_family, token) => {
			const split = token.startsWith('xoxb-')
				? splitTokenAt(token, VS16, 6)
				: splitToken(token, VS16);
			expect(containsSecret(`note ${split} end`)).toBe(true);
		},
		30_000,
	);

	test.each(BENIGN_CONTROLS)(
		'%s stays undetected and byte-identical under redactSecrets',
		(_name, sample) => {
			expect(containsSecret(sample)).toBe(false);
			expect(redactSecrets(sample)).toBe(sample);
		},
		30_000,
	);

	// R2 base-equivalence rows: ordering counterexamples whose ACTUAL base
	// (6864cd83b) output bytes were captured from a base checkout run on
	// 2026-11-19 and pinned verbatim. They must pass at base AND head — the
	// two-view fix must reproduce the sequential chain byte-for-byte for
	// non-Cf inputs (pattern ORDER stays the authority; a blanket
	// leftmost-longest splice would emit ONE merged placeholder instead).
	test('base-equivalence: labeled AWS id + SecretAccessKey keeps the sequential two-placeholder output', () => {
		const input = `AKIAIOSFODNN7EXAMPLE SecretAccessKey=${AWS40}`;
		expect(redactSecrets(input)).toBe(
			'[REDACTED:aws_access_key_id] [REDACTED:aws_secret_access_key]',
		);
	}, 30_000);

	test('base-equivalence: github/slack span overlap keeps the github-priority output', () => {
		// The github body's greedy tail ("xoxb") IS the slack token's prefix,
		// so the two arms' raw spans overlap. Sequentially, github_token (#3)
		// fires first; the slack arm then finds no "xoxb-" left to match and
		// the tail stays visible — the base quirk being pinned.
		const input =
			'gh' +
			's_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qrxo' +
			'xb-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9';
		expect(redactSecrets(input)).toBe(
			'[REDACTED:github_token]-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9',
		);
	}, 30_000);

	// [R13] Cf-bearing variants of the two ordering rows above: same inputs
	// with a U+200B inside one token. RED at base (the split token is missed —
	// at base a DIFFERENT arm fires or nothing does, so the output diverges),
	// GREEN at head, and the head output must equal the non-Cf twin
	// byte-for-byte — the two-view fix preserves the sequential chain's
	// placeholder structure for Cf inputs too, it only widens coverage.
	test('base-equivalence (Cf variant): labeled AWS id + ZWSP-split SecretAccessKey keeps the same two-placeholder output', () => {
		// The ZWSP sits inside the 40-char secret VALUE (20/20): at base the
		// labeled arm's exact-{40} and the context arm's {40} tail both break,
		// so only the bare AKIA arm fires and the split value stays visible;
		// at head the labeled arm's condensed match covers the whole
		// SecretAccessKey=... span (ZWSP included) and the twin output is
		// restored exactly.
		const input = `AKIAIOSFODNN7EXAMPLE SecretAccessKey=${AWS40.slice(0, 20)}${ZWSP}${AWS40.slice(20)}`;
		expect(redactSecrets(input)).toBe(
			'[REDACTED:aws_access_key_id] [REDACTED:aws_secret_access_key]',
		);
	}, 30_000);

	test('base-equivalence (Cf variant): github/slack overlap with a ZWSP-split github token keeps the github-priority output', () => {
		// The ZWSP sits inside the github token's "ghs_" PREFIX: at base the
		// unanchored github arm cannot match across it (no ghp_/ghs_/... run),
		// so the intact slack token fires instead and the split github token
		// stays visible; at head the github arm's condensed match covers the
		// whole ghs_...xoxb span (ZWSP included), the slack arm then finds no
		// "xoxb-" left, and the twin output is restored exactly.
		const input = `gh${ZWSP}s_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qrxo${'xb-'}Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9`;
		expect(redactSecrets(input)).toBe(
			'[REDACTED:github_token]-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9',
		);
	}, 30_000);

	// [R13] Same-pattern raw/condensed overlap (critic "Edge Cases" R2
	// bullet): the raw openai arm matches exactly the 20-char body floor
	// (sk- + 20 chars), while the condensed arm matches the whole 25-char
	// body at the SAME start. Per-pattern leftmost-longest selection must
	// redact the LONGER span in ONE piece — splicing both by original
	// offsets would corrupt the string, and choosing the raw span would
	// leave the condensed tail (ZWSP + 5 chars) visible. RED at base (the
	// tail IS visible behind the raw placeholder), GREEN at head.
	test('same-pattern raw/condensed overlap: the longer condensed span is redacted in one piece', () => {
		const token = `sk-${'A'.repeat(20)}${ZWSP}${'B'.repeat(5)}`;
		expect(redactSecrets(`note ${token} end`)).toBe(
			'note [REDACTED:openai_api_key] end',
		);
	}, 30_000);

	test('policy version bumps to salt 5 with 15 families (#3893/#3915: PEM nogap fallback; salt 4/14 families computed 4_000_029 — R1)', () => {
		expect(computeRedactionPolicyVersion({ rejectDurableSecrets: true })).toBe(
			5_000_031,
		);
		expect(computeRedactionPolicyVersion({ rejectDurableSecrets: false })).toBe(
			5_000_030,
		);
	});
});
