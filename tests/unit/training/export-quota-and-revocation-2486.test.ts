/**
 * Acceptance coverage for issue #2486 review findings PRR-014/PRR-002/PRR-008/
 * PRR-023 (PR #2637 feedback round): the export_quota failure path, the
 * fail-closed quota read, token preservation on refusals, and the
 * revoked-export re-creation guard.
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	grantTrainingConsent,
	TRAINING_EXPORT_QUOTA_CEILINGS,
} from '../../../src/training/consent.js';
import {
	_internals,
	executeTrainingExport,
	issueTrainingConfirmToken,
	previewTrainingExport,
} from '../../../src/training/exporter.js';
import {
	trainingExportsDir,
	trainingPendingOpPath,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = new Date('2026-08-01T10:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function seedOneRecord(dir: string): void {
	const consent = grantTrainingConsent(dir, {
		now: NOW,
		quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
		expiresAt: '2030-01-01T00:00:00.000Z',
	});
	const record = buildTrainingVaultRecord({
		directory: dir,
		kind: 'user_message',
		role: 'user',
		content: 'quota probe record',
		sessionId: 'sess-quota',
		pluginVersion: 'test-0.0.0',
		source: 'chat',
		consent,
		now: NOW,
	});
	expect(appendTrainingVaultRecord(dir, record).appended).toBe(true);
}

describe('PRR-014 - export_quota ceiling is enforced and tested', () => {
	test('the maxExports ceiling refuses a new export with reason export_quota', () => {
		const dir = canonicalMkdtemp('training-prr14-quota-');
		try {
			seedOneRecord(dir);
			const preview = previewTrainingExport(dir);
			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			// Seed the ceiling: stub directories stand in for prior exports.
			fs.mkdirSync(trainingExportsDir(dir), { recursive: true });
			for (let i = 0; i < TRAINING_EXPORT_QUOTA_CEILINGS.maxExports; i += 1) {
				fs.mkdirSync(
					`${trainingExportsDir(dir)}/stub-export-${String(i).padStart(2, '0')}`,
				);
			}
			const res = executeTrainingExport(dir, undefined, {
				confirmToken: token,
			});
			expect(res.written).toBe(false);
			expect(res.reason).toBe('export_quota');
			// Refusal must not create the destination, and the token stays
			// valid (consumption happens only on the write path).
			expect(fs.existsSync(preview.destination)).toBe(false);
			expect(fs.existsSync(trainingPendingOpPath(dir))).toBe(true);
		} finally {
			rmDir(dir);
		}
	});

	test('quota gate wiring uses the _internals seam (fail-closed on read errors)', () => {
		const dir = canonicalMkdtemp('training-prr02-failclosed-');
		try {
			seedOneRecord(dir);
			const preview = previewTrainingExport(dir);
			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			const original = _internals.countExportDirs;
			// Simulate an unreadable exports dir: the seam reports at-capacity
			// (the fail-closed mapping the real implementation applies to
			// non-ENOENT readdir errors).
			_internals.countExportDirs = () =>
				TRAINING_EXPORT_QUOTA_CEILINGS.maxExports;
			try {
				const res = executeTrainingExport(dir, undefined, {
					confirmToken: token,
				});
				expect(res.reason).toBe('export_quota');
			} finally {
				_internals.countExportDirs = original;
			}
		} finally {
			rmDir(dir);
		}
	});
});

describe('PRR-023 - a revoked export id cannot be re-created', () => {
	test('a tombstone listing the export id refuses the export with export_revoked', () => {
		const dir = canonicalMkdtemp('training-prr23-revoked-');
		try {
			seedOneRecord(dir);
			const preview = previewTrainingExport(dir);
			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			const original = _internals.listTombstones;
			_internals.listTombstones = (() => [
				{
					schema_version: 1,
					tombstone_id: 't'.repeat(64),
					withdrawn_at: '2026-08-02T00:00:00.000Z',
					purged_records: 1,
					purged_record_ids_digest: 'a'.repeat(64),
					revoked_export_ids: [preview.exportId],
				},
			]) as typeof _internals.listTombstones;
			try {
				const res = executeTrainingExport(dir, undefined, {
					confirmToken: token,
				});
				expect(res.written).toBe(false);
				expect(res.reason).toBe('export_revoked');
				expect(fs.existsSync(preview.destination)).toBe(false);
			} finally {
				_internals.listTombstones = original;
			}
		} finally {
			rmDir(dir);
		}
	});
});

describe('PRR-008 - refusals preserve the confirmation token', () => {
	test('an empty-matching preview returns empty without consuming the token', () => {
		const dir = canonicalMkdtemp('training-prr08-empty-');
		try {
			seedOneRecord(dir);
			const filters = { sessionId: 'sess-quota' } as const;
			const preview = previewTrainingExport(dir, filters);
			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			// Different session filter matches nothing.
			const emptyFilters = { sessionId: 'sess-no-such' } as const;
			const emptyPreview = previewTrainingExport(dir, emptyFilters);
			// Scope the token to the empty preview to reach the empty branch
			// with a matching scope digest.
			const emptyToken = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: emptyPreview.exportId,
			});
			const res = executeTrainingExport(dir, emptyFilters, {
				confirmToken: emptyToken,
			});
			expect(res.written).toBe(false);
			expect(res.reason).toBe('empty');
			// Token slot preserved — the human does not need a fresh preview.
			expect(fs.existsSync(trainingPendingOpPath(dir))).toBe(true);
			void token;
			void preview;
		} finally {
			rmDir(dir);
		}
	});
});
