/**
 * Acceptance checks for issue #2486 — AC7 (withdrawal + tombstones;
 * withdrawal after export).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * Withdrawal must stop capture immediately, physically delete vault content,
 * write a durable tombstone (with the recomputed purged-record-ids digest),
 * revoke prior exports with REVOKED.json manifests, and tombstones must never
 * be deleted by later vault operations.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTrainingCaptureObserver } from '../../../src/training/capture.js';
import {
	grantTrainingConsent,
	readActiveTrainingConsent,
	revokeTrainingConsent,
} from '../../../src/training/consent.js';
import {
	executeTrainingExport,
	issueTrainingConfirmToken,
	previewTrainingExport,
} from '../../../src/training/exporter.js';
import {
	trainingConsentPath,
	trainingTombstonesPath,
	trainingVaultRecordsPath,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	getTrainingVaultStatus,
	listTrainingTombstones,
	purgeTrainingVaultContent,
	readTrainingExportRevocations,
	readTrainingVault,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Consent = ReturnType<typeof grantTrainingConsent>;

const NOW = new Date('2026-07-05T12:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function record(
	dir: string,
	consent: Consent,
	content: string,
	sessionId: string,
) {
	return buildTrainingVaultRecord({
		directory: dir,
		kind: 'user_message',
		role: 'user',
		content,
		sessionId,
		pluginVersion: 'test-0.0.0',
		source: 'chat',
		consent,
		now: NOW,
	});
}

function seedAndExport(dir: string): { exportId: string; destination: string } {
	const consent = grantTrainingConsent(dir, {
		quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
		expiresAt: '2030-01-01T00:00:00.000Z',
	});
	for (const [content, sessionId] of [
		['withdraw me one', 'sess-w1'],
		['withdraw me two', 'sess-w2'],
	] as const) {
		expect(
			appendTrainingVaultRecord(dir, record(dir, consent, content, sessionId))
				.appended,
		).toBe(true);
	}
	const preview = previewTrainingExport(dir);
	const token = issueTrainingConfirmToken(dir, {
		kind: 'export',
		digest: preview.exportId,
	});
	const res = executeTrainingExport(dir, undefined, { confirmToken: token });
	if (!res.written || !res.exportId || !res.destination) {
		throw new Error(`seedAndExport: export failed: ${JSON.stringify(res)}`);
	}
	return { exportId: res.exportId, destination: res.destination };
}

describe('AC7 withdrawal - revoke stops capture immediately', () => {
	test('revoke rewrites consent as withdrawn and the observer captures nothing after', async () => {
		const dir = canonicalMkdtemp('training-ac7-revoke-');
		try {
			grantTrainingConsent(dir);
			const observer = createTrainingCaptureObserver(dir);
			await observer.observeMessages({
				messages: [
					{
						info: { role: 'user', id: 'msg-w1', sessionID: 'sess-r' },
						parts: [{ type: 'text', text: 'captured before revoke' }],
					},
				],
			});
			expect(readTrainingVault(dir).records).toHaveLength(1);
			const before = fs.readFileSync(trainingVaultRecordsPath(dir), 'utf-8');

			revokeTrainingConsent(dir);
			const raw = JSON.parse(
				fs.readFileSync(trainingConsentPath(dir), 'utf-8'),
			);
			expect(raw.state).toBe('withdrawn');
			expect(typeof raw.withdrawn_at).toBe('string');
			expect(readActiveTrainingConsent(dir)).toBeNull();
			expect(getTrainingVaultStatus(dir).consentState).toBe('withdrawn');

			await observer.observeMessages({
				messages: [
					{
						info: { role: 'user', id: 'msg-w2', sessionID: 'sess-r' },
						parts: [
							{ type: 'text', text: 'captured after revoke must not happen' },
						],
					},
				],
			});
			expect(readTrainingVault(dir).records).toHaveLength(1);
			// The pre-revoke record is byte-identical — no rewrite, no eviction.
			expect(fs.readFileSync(trainingVaultRecordsPath(dir), 'utf-8')).toBe(
				before,
			);
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC7 withdrawal - purge, tombstone, and export revocation', () => {
	test('purge empties the vault, writes a verifiable tombstone, revokes the export', () => {
		const dir = canonicalMkdtemp('training-ac7-purge-');
		try {
			const { exportId, destination } = seedAndExport(dir);
			const vaultRecords = readTrainingVault(dir).records;
			expect(vaultRecords).toHaveLength(2);

			revokeTrainingConsent(dir, { now: NOW });
			const purge = purgeTrainingVaultContent(dir, { now: NOW });
			expect(purge.purgedRecords).toBe(2);
			expect(purge.revokedExports).toEqual([exportId]);

			// Tombstone shape + recomputed purged-record-ids digest.
			const tombstone = purge.tombstone;
			expect(tombstone.schema_version).toBe(1);
			expect(tombstone.tombstone_id).toMatch(/^[0-9a-f]{64}$/);
			expect(tombstone.purged_records).toBe(2);
			expect(tombstone.withdrawn_at).toBe(NOW.toISOString());
			expect(tombstone.revoked_export_ids).toEqual([exportId]);
			const sortedIds = vaultRecords.map((r) => r.record_id).sort();
			const expectedDigest = createHash('sha256')
				.update(sortedIds.join(''))
				.digest('hex');
			expect(tombstone.purged_record_ids_digest).toBe(expectedDigest);

			// The vault is physically empty (rewritten atomically to empty).
			expect(fs.readFileSync(trainingVaultRecordsPath(dir), 'utf-8')).toBe('');
			expect(readTrainingVault(dir).records).toHaveLength(0);

			// The tombstone is durable in tombstones.jsonl.
			const tombstoneLines = fs
				.readFileSync(trainingTombstonesPath(dir), 'utf-8')
				.split('\n')
				.filter(Boolean);
			expect(tombstoneLines).toHaveLength(1);
			expect(JSON.parse(tombstoneLines[0]).tombstone_id).toBe(
				tombstone.tombstone_id,
			);
			expect(listTrainingTombstones(dir)).toHaveLength(1);

			// The export directory carries a REVOKED.json revocation manifest.
			const revokedPath = path.join(destination, 'REVOKED.json');
			expect(fs.existsSync(revokedPath)).toBe(true);
			const revoked = JSON.parse(fs.readFileSync(revokedPath, 'utf-8'));
			expect(revoked.schema_version).toBe(1);
			expect(revoked.export_id).toBe(exportId);
			expect(revoked.tombstone_id).toBe(tombstone.tombstone_id);
			expect(typeof revoked.revoked_at).toBe('string');

			// The revocation reader surfaces it.
			expect(readTrainingExportRevocations(dir)).toEqual([
				{
					exportId,
					revokedAt: revoked.revoked_at,
					tombstoneId: tombstone.tombstone_id,
				},
			]);

			// Status reflects the purge.
			const status = getTrainingVaultStatus(dir);
			expect(status.recordCount).toBe(0);
			expect(status.consentState).toBe('withdrawn');
			expect(status.tombstoneCount).toBe(1);
		} finally {
			rmDir(dir);
		}
	});

	test('a second purge cycle keeps both tombstones (never deleted)', () => {
		const dir = canonicalMkdtemp('training-ac7-tomb-');
		try {
			const first = seedAndExport(dir);
			revokeTrainingConsent(dir, { now: NOW });
			const purge1 = purgeTrainingVaultContent(dir, { now: NOW });
			expect(purge1.purgedRecords).toBe(2);

			const second = seedAndExport(dir);
			revokeTrainingConsent(dir, { now: NOW });
			const purge2 = purgeTrainingVaultContent(dir, { now: NOW });
			expect(purge2.purgedRecords).toBe(2);

			const tombstones = listTrainingTombstones(dir);
			expect(tombstones).toHaveLength(2);
			const ids = tombstones.map((t) => t.tombstone_id);
			expect(ids).toContain(purge1.tombstone.tombstone_id);
			expect(ids).toContain(purge2.tombstone.tombstone_id);
			expect(second.exportId).not.toBe(first.exportId);
			// Both exports now carry revocation manifests.
			expect(readTrainingExportRevocations(dir)).toHaveLength(2);
		} finally {
			rmDir(dir);
		}
	});
});
