/**
 * swarm.db backup → restore round trip (issue #2480 "backup restore"
 * evidence): the /swarm close archive stage's VACUUM INTO snapshot restores to
 * a quick_check-clean DB with all foundation rows intact.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import { archiveSqliteSnapshot } from '../../../src/commands/archive-sqlite.js';
import { appendInsightCandidatesDb } from '../../../src/db/insight-candidate-store.js';
import { upsertPhaseReportDb } from '../../../src/db/phase-report-store.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('backup-restore-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	closeProjectDb(dir);
	rmSync(dir, { recursive: true, force: true });
});

describe('VACUUM INTO backup → restore', () => {
	test(
		'snapshot restores to a quick_check-clean DB with foundation rows intact',
		{ timeout: 60_000 },
		async () => {
			// Populate every foundation surface.
			await appendInsightCandidatesDb(dir, [
				{
					payload: JSON.stringify({ lesson: 'durable lesson' }),
					createdAt: '2026-01-01T00:00:00.000Z',
				},
			]);
			await upsertPhaseReportDb(dir, 'curator_drift', 3, '{"phase":3}');

			// The /swarm close archive stage path: VACUUM INTO snapshot.
			const result = await archiveSqliteSnapshot({
				sourcePath: path.join(dir, '.swarm', 'swarm.db'),
				destDir: dir,
				destName: 'swarm.db',
			});
			expect(result.attempt).toBe('succeeded');
			expect(result.validation).toBe('passed');
			const snapshotPath = result.destPath;
			expect(typeof snapshotPath).toBe('string');

			// Simulate losing the live DB (and its WAL sidecars): close, delete,
			// restore the snapshot over the original path.
			closeProjectDb(dir);
			rmSync(path.join(dir, '.swarm', 'swarm.db'), { force: true });
			rmSync(path.join(dir, '.swarm', 'swarm.db-wal'), { force: true });
			rmSync(path.join(dir, '.swarm', 'swarm.db-shm'), { force: true });
			copyFileSync(snapshotPath, path.join(dir, '.swarm', 'swarm.db'));

			// Reopen: migrations are current, quick_check is clean, rows survived.
			const reopened = getProjectDb(dir);
			expect(reopened.query('PRAGMA quick_check').get()).toMatchObject({
				quick_check: 'ok',
			});
			const pending = reopened
				.query<{ n: number }, []>(
					'SELECT COUNT(*) as n FROM insight_candidate WHERE consumed_at IS NULL',
				)
				.get()?.n;
			expect(pending).toBe(1);
			const reports = reopened
				.query<{ phase: number }, []>(
					"SELECT phase FROM phase_report WHERE kind = 'curator_drift'",
				)
				.all();
			expect(reports.map((r) => r.phase)).toEqual([3]);
		},
	);
});
