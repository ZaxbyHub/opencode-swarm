/**
 * Acceptance checks for issue #2486 — AC4 (quotas, disk pressure, no silent
 * eviction).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * At a byte or record cap capture must stop with a typed non-silent reason;
 * unexpired records and tombstones are never evicted; disk-pressure failures
 * (breached floor stub, ENOSPC-like append failure stub) fail closed with the
 * 'disk_floor' stop reason. Seams are stubbed via the vault _internals seam
 * only (no mock.module); every stub is restored.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	grantTrainingConsent,
	revokeTrainingConsent,
} from '../../../src/training/consent.js';
import {
	checkTrainingDiskFloor,
	TRAINING_DISK_FLOOR_BYTES,
} from '../../../src/training/disk.js';
import {
	trainingTombstonesPath,
	trainingVaultRecordsPath,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	listTrainingTombstones,
	purgeTrainingVaultContent,
	readTrainingVault,
	_internals as vaultInternals,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Consent = ReturnType<typeof grantTrainingConsent>;

const NOW = new Date('2026-06-10T09:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function record(dir: string, consent: Consent, content: string) {
	return buildTrainingVaultRecord({
		directory: dir,
		kind: 'user_message',
		role: 'user',
		content,
		sessionId: `sess-${content.replace(/\W+/g, '-')}`,
		pluginVersion: 'test-0.0.0',
		source: 'chat',
		consent,
		now: NOW,
	});
}

function vaultLines(dir: string): string[] {
	return fs
		.readFileSync(trainingVaultRecordsPath(dir), 'utf-8')
		.split('\n')
		.filter(Boolean);
}

// Restore the full _internals seam after every test (defense in depth on top of
// the per-test finally restores).
const seamSnapshot = {
	statfsCheck: vaultInternals.statfsCheck,
	appendFile: vaultInternals.appendFile,
	readFile: vaultInternals.readFile,
	now: vaultInternals.now,
};
afterEach(() => {
	vaultInternals.statfsCheck = seamSnapshot.statfsCheck;
	vaultInternals.appendFile = seamSnapshot.appendFile;
	vaultInternals.readFile = seamSnapshot.readFile;
	vaultInternals.now = seamSnapshot.now;
});

describe('AC4 quotas - record-count cap stops capture without eviction', () => {
	test('third append is refused with quota_records; the first two records stay on disk', () => {
		const dir = canonicalMkdtemp('training-ac4-records-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				quotas: { maxBytes: 10_485_760, maxRecords: 2, retentionDays: 30 },
			});
			const r1 = record(dir, consent, 'first record');
			const r2 = record(dir, consent, 'second record');
			const r3 = record(dir, consent, 'third record');

			expect(appendTrainingVaultRecord(dir, r1).appended).toBe(true);
			expect(appendTrainingVaultRecord(dir, r2).appended).toBe(true);

			const third = appendTrainingVaultRecord(dir, r3);
			expect(third.appended).toBe(false);
			expect(third.stopReason).toBe('quota_records');

			// No eviction: the two capped-in records still exist on disk.
			const lines = vaultLines(dir);
			expect(lines).toHaveLength(2);
			const ids = lines.map((l) => JSON.parse(l).record_id);
			expect([...ids].sort()).toEqual([r1.record_id, r2.record_id].sort());
			expect(readTrainingVault(dir).records).toHaveLength(2);
		} finally {
			rmDir(dir);
		}
	});

	test('byte cap stops capture with quota_bytes and keeps existing records', () => {
		const dir = canonicalMkdtemp('training-ac4-bytes-');
		try {
			// maxBytes: 1 — the first line makes vault bytes >= 1, so the second
			// append must refuse (vault-bytes check is evaluated before writing).
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				quotas: { maxBytes: 1, maxRecords: 100, retentionDays: 30 },
			});
			expect(
				appendTrainingVaultRecord(dir, record(dir, consent, 'only line'))
					.appended,
			).toBe(true);
			const second = appendTrainingVaultRecord(
				dir,
				record(dir, consent, 'must be refused'),
			);
			expect(second.appended).toBe(false);
			expect(second.stopReason).toBe('quota_bytes');
			expect(vaultLines(dir)).toHaveLength(1);
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC4 disk pressure - floor and write failures fail closed (typed stopReason)', () => {
	test('breached disk floor (stubbed statfsCheck) refuses the append', () => {
		const dir = canonicalMkdtemp('training-ac4-floor-');
		const original = vaultInternals.statfsCheck;
		vaultInternals.statfsCheck = (): {
			ok: boolean;
			floorBytes: number;
			reason: 'disk_floor';
		} => ({
			ok: false,
			floorBytes: TRAINING_DISK_FLOOR_BYTES,
			reason: 'disk_floor',
		});
		try {
			const consent = grantTrainingConsent(dir, { now: NOW });
			const res = appendTrainingVaultRecord(
				dir,
				record(dir, consent, 'blocked by floor'),
			);
			expect(res.appended).toBe(false);
			expect(res.stopReason).toBe('disk_floor');
			expect(fs.existsSync(trainingVaultRecordsPath(dir))).toBe(false);
		} finally {
			vaultInternals.statfsCheck = original;
			rmDir(dir);
		}
	});

	test('ENOSPC-like append failure (stubbed appendFile) fails closed as disk_floor', () => {
		const dir = canonicalMkdtemp('training-ac4-enospc-');
		const original = vaultInternals.appendFile;
		vaultInternals.appendFile = async () => {
			const err: NodeJS.ErrnoException = new Error(
				'write failed: no space left on device',
			);
			err.code = 'ENOSPC';
			throw err;
		};
		try {
			const consent = grantTrainingConsent(dir, { now: NOW });
			const res = appendTrainingVaultRecord(
				dir,
				record(dir, consent, 'disk full write'),
			);
			expect(res.appended).toBe(false);
			expect(res.stopReason).toBe('disk_floor');
		} finally {
			vaultInternals.appendFile = original;
			rmDir(dir);
		}
	});

	test('the real checkTrainingDiskFloor reports the 2 GiB floor', () => {
		const dir = canonicalMkdtemp('training-ac4-disk-');
		try {
			expect(TRAINING_DISK_FLOOR_BYTES).toBe(2_147_483_648);
			const res = checkTrainingDiskFloor(dir);
			expect(res.floorBytes).toBe(2_147_483_648);
			expect(typeof res.ok).toBe('boolean');
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC4 no silent eviction - tombstones survive quota stops and purges', () => {
	test('tombstone written by the first purge survives a second purge cycle and quota refusals', () => {
		const dir = canonicalMkdtemp('training-ac4-tomb-');
		try {
			// Cycle 1: grant, one record, revoke, purge -> tombstone 1.
			const consent1 = grantTrainingConsent(dir, {
				now: NOW,
				quotas: { maxBytes: 10_485_760, maxRecords: 1, retentionDays: 30 },
			});
			expect(
				appendTrainingVaultRecord(dir, record(dir, consent1, 'cycle one'))
					.appended,
			).toBe(true);
			revokeTrainingConsent(dir, { now: NOW });
			const purge1 = purgeTrainingVaultContent(dir, { now: NOW });
			expect(purge1.purgedRecords).toBe(1);
			const tombstone1 = purge1.tombstone;

			// Cycle 2: re-grant, hit the record cap, then purge again -> tombstone 2.
			const consent2 = grantTrainingConsent(dir, {
				now: NOW,
				quotas: { maxBytes: 10_485_760, maxRecords: 1, retentionDays: 30 },
			});
			expect(
				appendTrainingVaultRecord(dir, record(dir, consent2, 'cycle two a'))
					.appended,
			).toBe(true);
			const refused = appendTrainingVaultRecord(
				dir,
				record(dir, consent2, 'cycle two b'),
			);
			expect(refused.appended).toBe(false);
			expect(refused.stopReason).toBe('quota_records');

			revokeTrainingConsent(dir, { now: NOW });
			const purge2 = purgeTrainingVaultContent(dir, { now: NOW });
			expect(purge2.purgedRecords).toBe(1);

			// Tombstones are never evicted: both are durable, first one unchanged.
			const tombstones = listTrainingTombstones(dir);
			expect(tombstones).toHaveLength(2);
			const ids = tombstones.map((t) => t.tombstone_id);
			expect(ids).toContain(tombstone1.tombstone_id);
			expect(ids).toContain(purge2.tombstone.tombstone_id);
			const rawTombstones = fs.readFileSync(
				trainingTombstonesPath(dir),
				'utf-8',
			);
			expect(rawTombstones.includes(tombstone1.tombstone_id)).toBe(true);
			expect(rawTombstones.includes(purge2.tombstone.tombstone_id)).toBe(true);
		} finally {
			rmDir(dir);
		}
	});
});
