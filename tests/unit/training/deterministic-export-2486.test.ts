/**
 * Acceptance checks for issue #2486 — AC5 (deterministic export).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * buildTrainingExportBundle must be PURE and DETERMINISTIC: identical records
 * and filters produce byte-identical bundles regardless of input order; the
 * train/validation split is session-coherent per the documented digest
 * algorithm; content-digest dedup keeps the first occurrence; manifest sha256
 * checksums are recomputed locally with node:crypto.
 *
 * Session ids below are chosen so that at validationRatio 0.5 one session
 * lands on each side of the documented split digest (see splitSideOf).
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { grantTrainingConsent } from '../../../src/training/consent.js';
import { buildTrainingExportBundle } from '../../../src/training/exporter.js';
import { buildTrainingVaultRecord } from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Consent = ReturnType<typeof grantTrainingConsent>;
type VaultRecord = ReturnType<typeof buildTrainingVaultRecord>;

const T1 = new Date('2026-06-01T10:00:00.000Z');
const T2 = new Date('2026-06-01T11:00:00.000Z');
const T3 = new Date('2026-06-02T09:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function codeUnitCmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The split assignment documented by the frozen contract, recomputed locally. */
function splitSideOf(sessionId: string, ratio: number): 'train' | 'validation' {
	const key = sha256(`training-split-v1\0${sessionId}`);
	return (Number.parseInt(key.slice(0, 8), 16) % 10_000) / 10_000 < ratio
		? 'validation'
		: 'train';
}

function rec(
	dir: string,
	consent: Consent,
	sessionId: string,
	kind: 'user_message' | 'assistant_message' | 'tool_call',
	role: string,
	content: string,
	now: Date,
): VaultRecord {
	return buildTrainingVaultRecord({
		directory: dir,
		kind,
		role,
		content,
		sessionId,
		pluginVersion: 'test-0.0.0',
		source: 'chat',
		consent,
		now,
	});
}

function fixtureRecords(dir: string, consent: Consent): VaultRecord[] {
	return [
		rec(dir, consent, 'session-alpha', 'user_message', 'user', 'alpha one', T1),
		// a2 and a2dup share the content digest (same text, different kind) — the
		// dedup target; both belong to session-alpha so side math stays simple.
		rec(
			dir,
			consent,
			'session-alpha',
			'assistant_message',
			'assistant',
			'alpha two',
			T2,
		),
		rec(dir, consent, 'session-alpha', 'tool_call', 'tool', 'alpha two', T2),
		rec(dir, consent, 'session-delta', 'user_message', 'user', 'delta one', T3),
	];
}

/** Sort + dedup per the contract, recomputed locally to derive expectations. */
function expectedKept(records: VaultRecord[]): VaultRecord[] {
	const sorted = [...records].sort(
		(a, b) =>
			codeUnitCmp(a.lineage.captured_at, b.lineage.captured_at) ||
			codeUnitCmp(a.record_id, b.record_id),
	);
	const seen = new Set<string>();
	const kept: VaultRecord[] = [];
	for (const r of sorted) {
		if (seen.has(r.content_digest)) continue;
		seen.add(r.content_digest);
		kept.push(r);
	}
	return kept;
}

function parseJsonl(text: string): VaultRecord[] {
	return text
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe('AC5 deterministic export - byte-identical bundles, stable order', () => {
	test('shuffling the input record order leaves the bundle byte-identical', () => {
		const dir = canonicalMkdtemp('training-ac5-det-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: T1,
				quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			const records = fixtureRecords(dir, consent);
			const filters = { validationRatio: 0.5 };

			const baseline = buildTrainingExportBundle(records, filters);
			const reversed = buildTrainingExportBundle(
				[...records].reverse(),
				filters,
			);
			const rotated = buildTrainingExportBundle(
				[records[2], records[0], records[3], records[1]],
				filters,
			);

			expect(reversed.exportId).toBe(baseline.exportId);
			expect(rotated.exportId).toBe(baseline.exportId);
			for (const name of [
				'records.jsonl',
				'train.jsonl',
				'validation.jsonl',
				'manifest.json',
			]) {
				expect(reversed.files[name]).toBe(baseline.files[name]);
				expect(rotated.files[name]).toBe(baseline.files[name]);
			}
			expect(baseline.exportId).toMatch(/^[0-9a-f]{16}$/);
		} finally {
			rmDir(dir);
		}
	});

	test('records.jsonl is sorted by (captured_at, record_id) with digests deduped', () => {
		const dir = canonicalMkdtemp('training-ac5-sort-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: T1,
				quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			const records = fixtureRecords(dir, consent);
			const kept = expectedKept(records);

			const bundle = buildTrainingExportBundle(records, {
				validationRatio: 0.5,
			});
			const lines = parseJsonl(bundle.files['records.jsonl']);
			expect(lines.map((r) => r.record_id)).toEqual(
				kept.map((r) => r.record_id),
			);
			// The duplicate digest survives exactly once.
			const dupDigest = sha256('alpha two');
			expect(lines.filter((r) => r.content_digest === dupDigest)).toHaveLength(
				1,
			);
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC5 deterministic export - manifest, checksums, and split', () => {
	test('manifest carries counts, echoed filters, lineage summary, and correct sha256 checksums', () => {
		const dir = canonicalMkdtemp('training-ac5-manifest-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: T1,
				quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			const records = fixtureRecords(dir, consent);
			const filters = { validationRatio: 0.5 };
			const bundle = buildTrainingExportBundle(records, filters);
			const manifest = JSON.parse(bundle.files['manifest.json']);

			expect(manifest.schema_version).toBe(1);
			expect(manifest.export_id).toBe(bundle.exportId);
			expect(manifest.filters).toEqual(filters);
			expect(manifest.counts.total).toBe(3);
			expect(manifest.counts.train).toBe(2);
			expect(manifest.counts.validation).toBe(1);
			expect(manifest.counts.deduped).toBe(1);
			expect(manifest.counts.quarantined_excluded).toBe(0);
			expect(manifest.counts.expired_excluded).toBe(0);
			expect(manifest.redaction_version).toBe(1);
			expect(manifest.consent_version).toBe(1);
			expect(manifest.split).toEqual({
				method: 'session-digest-v1',
				ratio: 0.5,
			});
			expect(manifest.lineage_summary.sessions).toBe(2);
			expect(manifest.lineage_summary.first_captured_at).toBe(T1.toISOString());
			expect(manifest.lineage_summary.last_captured_at).toBe(T3.toISOString());

			// Checksums are recomputed locally — not trusted from the manifest.
			expect(manifest.checksums['records.jsonl']).toBe(
				sha256(bundle.files['records.jsonl']),
			);
			expect(manifest.checksums['train.jsonl']).toBe(
				sha256(bundle.files['train.jsonl']),
			);
			expect(manifest.checksums['validation.jsonl']).toBe(
				sha256(bundle.files['validation.jsonl']),
			);
		} finally {
			rmDir(dir);
		}
	});

	test('split is session-coherent per the documented digest algorithm', () => {
		const dir = canonicalMkdtemp('training-ac5-split-');
		try {
			// Stability guards: these sessions were chosen because they straddle
			// 0.5 under the contract's own digest formula.
			expect(splitSideOf('session-alpha', 0.5)).toBe('train');
			expect(splitSideOf('session-delta', 0.5)).toBe('validation');

			const consent = grantTrainingConsent(dir, {
				now: T1,
				quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			const records = fixtureRecords(dir, consent);
			const kept = expectedKept(records);
			const bundle = buildTrainingExportBundle(records, {
				validationRatio: 0.5,
			});

			const trainLines = parseJsonl(bundle.files['train.jsonl']);
			const validationLines = parseJsonl(bundle.files['validation.jsonl']);
			expect(trainLines).toHaveLength(2);
			expect(validationLines).toHaveLength(1);

			// Every kept record lands on exactly one side, matching its session's
			// documented assignment (train XOR validation).
			const trainIds = new Set(trainLines.map((r) => r.record_id));
			const validationIds = new Set(validationLines.map((r) => r.record_id));
			for (const r of kept) {
				expect(
					trainIds.has(r.record_id) !== validationIds.has(r.record_id),
				).toBe(true);
				const expectedSide = splitSideOf(r.lineage.session_id, 0.5);
				if (expectedSide === 'train')
					expect(trainIds.has(r.record_id)).toBe(true);
				else expect(validationIds.has(r.record_id)).toBe(true);
			}
			// No session is split across both files.
			const trainSessions = new Set(
				trainLines.map((r) => r.lineage.session_id),
			);
			const validationSessions = new Set(
				validationLines.map((r) => r.lineage.session_id),
			);
			for (const s of trainSessions)
				expect(validationSessions.has(s)).toBe(false);
		} finally {
			rmDir(dir);
		}
	});

	test('different filters produce a different exportId (canonical filters are hashed in)', () => {
		const dir = canonicalMkdtemp('training-ac5-id-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: T1,
				quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			const records = fixtureRecords(dir, consent);
			const a = buildTrainingExportBundle(records, { validationRatio: 0.5 });
			const b = buildTrainingExportBundle(records, { validationRatio: 0.25 });
			expect(b.exportId).not.toBe(a.exportId);
			// Same filters twice is still the same id (purity).
			expect(
				buildTrainingExportBundle(records, { validationRatio: 0.5 }).exportId,
			).toBe(a.exportId);
		} finally {
			rmDir(dir);
		}
	});
});
