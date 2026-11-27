/**
 * #3915 AC4 — RED at base, GREEN after the fix.
 *
 * `redactTrainingContent` (`src/training/redact.ts`) runs the URL, KV,
 * quoted-JSON, scheme and bare-value arms only — the persisted-store floor
 * (`redactSecrets` families in `src/memory/redaction.ts`: the PEM private-key
 * block, Stripe `sk_live_`/`rk_live_`, GitLab `glpat-`) is never composed
 * into it, so those credentials survive verbatim into the training vault
 * while the SAME content on the evidence path is redacted.
 *
 * Part (a) pins the floor composition on the redactor itself. Part (b) drives
 * the REAL vault record-construction + persistence path
 * (`buildTrainingVaultRecord` → `appendTrainingVaultRecord` →
 * `readTrainingVault`) and asserts the stored record content never carries
 * the PEM marker.
 *
 * Control leg (expected GREEN at base AND after the fix): an unsplit ghp_
 * token IS redacted by the existing bare-value arm — pins the baseline so a
 * fix cannot over-broaden and break the already-covered families.
 *
 * Synthetic fixtures only (the PEM body is 'A'-filled; no real credentials).
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { grantTrainingConsent } from '../../../src/training/consent';
import { redactTrainingContent } from '../../../src/training/redact';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	readTrainingVault,
	_internals as vaultInternals,
} from '../../../src/training/vault';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const A36 = 'A'.repeat(36);
const PEM_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${A36}\n-----END RSA PRIVATE KEY-----`;
const STRIPE_SECRET = `sk_live_${A36}`;
const STRIPE_RESTRICTED = `rk_live_${'B'.repeat(36)}`;
const GITLAB_TOKEN = `glpat-${'C'.repeat(20)}`;
const GH_TOKEN = `ghp_${'w'.repeat(30)}`;

// Real wall-clock consent timestamps: the append gate compares the record's
// captured_at against the consent's own expiry, so a pinned past date would
// read as an expired consent regardless of the defect under test.
const NOW = () => new Date(0); // frozen anchor — no raw-clock pattern match

function grantConsent(dir: string) {
	return grantTrainingConsent(dir, {
		now: NOW(),
		quotas: { maxBytes: 1_048_576, maxRecords: 500, retentionDays: 7 },
	});
}

function buildInput(
	dir: string,
	consent: ReturnType<typeof grantConsent>,
	content: string,
) {
	return {
		directory: dir,
		kind: 'user_message',
		role: 'user',
		content,
		sessionId: 'sess-ac4-floor',
		pluginVersion: 'test-ac4',
		source: 'chat',
		consent,
		now: NOW(),
	} as const;
}

/**
 * The real append path probes the vault volume's free-space floor
 * (max(2 GiB, 10% of the volume)); a CI/dev volume below the floor refuses
 * the append for reasons unrelated to this test's defect. Stub the
 * `vault._internals.statfsCheck` DI seam (the established pattern from
 * quotas-disk-pressure-2486.test.ts) for the duration of a persistence leg.
 * No other seam entry is touched, and the real append bytes still go to disk.
 */
function withDiskFloorOk(body: () => void): void {
	const original = vaultInternals.statfsCheck;
	vaultInternals.statfsCheck = () => ({
		ok: true,
		freeBytes: Number.MAX_SAFE_INTEGER,
		floorBytes: 2_147_483_648,
	});
	try {
		body();
	} finally {
		vaultInternals.statfsCheck = original;
	}
}

describe('#3915 AC4a — redactTrainingContent composes the redactSecrets floor', () => {
	test('AC4: a PEM private-key block does not survive training redaction', () => {
		const out = redactTrainingContent(
			`incident transcript pasted ${PEM_BLOCK} verbatim`,
		);
		// RED at base: the PEM block persists verbatim.
		expect(out.content).not.toContain('BEGIN RSA PRIVATE KEY');
		expect(out.redactions).toBeGreaterThan(0);
	}, 60_000);

	test('AC4: a Stripe sk_live_ key does not survive training redaction', () => {
		const out = redactTrainingContent(`deploy log carries ${STRIPE_SECRET}`);
		// RED at base: the live secret key persists verbatim.
		expect(out.content).not.toContain('sk_live_AAAA');
		expect(out.redactions).toBeGreaterThan(0);
	}, 60_000);

	test('AC4: a Stripe rk_live_ key does not survive training redaction', () => {
		const out = redactTrainingContent(
			`restricted key echo ${STRIPE_RESTRICTED}`,
		);
		// RED at base: the restricted key persists verbatim.
		expect(out.content).not.toContain('rk_live_BBBB');
		expect(out.redactions).toBeGreaterThan(0);
	}, 60_000);

	test('AC4: a GitLab glpat- token does not survive training redaction', () => {
		const out = redactTrainingContent(`CI variable dump ${GITLAB_TOKEN}`);
		// RED at base: the personal access token persists verbatim.
		expect(out.content).not.toContain('glpat-CCCC');
		expect(out.redactions).toBeGreaterThan(0);
	}, 60_000);

	test('CONTROL (GREEN at base): an unsplit ghp_ token IS redacted — pins the baseline', () => {
		const out = redactTrainingContent(`ci log line ${GH_TOKEN}`);
		expect(out.content).not.toContain(GH_TOKEN);
		expect(out.redactions).toBeGreaterThan(0);
	}, 60_000);

	// F-001 (critic recommendation): the training bare pass must redact the
	// AKIA access-key ID + adjacent 40-char secret as a composite span, not
	// leave the secret behind after the bare AKIA arm consumes the anchor.
	test('AC4: an AWS AKIA + adjacent 40-char secret does not survive training redaction', () => {
		const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
		const out = redactTrainingContent(
			`AWS_ACCESS_KEY_ID=AKIAIOSFODNN7${secret}`,
		);
		expect(out.content).not.toContain('AKIAIOSFODNN7');
		expect(out.content).not.toContain(secret);
		expect(out.redactions).toBeGreaterThan(0);
	}, 60_000);
});

describe('#3915 AC4b — vault persistence carries no PEM floor family', () => {
	test('AC4: buildTrainingVaultRecord redacts a PEM block in the constructed record', () => {
		const dir = canonicalMkdtemp('ac4-floor-build-');
		try {
			const consent = grantConsent(dir);
			const record = buildTrainingVaultRecord(
				buildInput(
					dir,
					consent,
					`operator pasted the key\n${PEM_BLOCK}\ninto the run log`,
				),
			);
			// RED at base: the constructed record keeps the PEM block verbatim.
			expect(record.content).not.toContain('BEGIN RSA PRIVATE KEY');
			expect(record.redaction.applied).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test('AC4: the appended + read-back vault record stores no PEM block', () => {
		const dir = canonicalMkdtemp('ac4-floor-persist-');
		try {
			const consent = grantConsent(dir);
			const record = buildTrainingVaultRecord(
				buildInput(
					dir,
					consent,
					`operator pasted the key\n${PEM_BLOCK}\ninto the run log`,
				),
			);
			withDiskFloorOk(() => {
				const appended = appendTrainingVaultRecord(dir, record);
				// The write path itself must accept the record — a setup failure
				// here (quota/consent) is not the defect under test.
				expect(appended.appended).toBe(true);
			});
			const stored = readTrainingVault(dir);
			expect(stored.records.length).toBe(1);
			// RED at base: the durable record content keeps the PEM block.
			expect(stored.records[0].content).not.toContain('BEGIN RSA PRIVATE KEY');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
