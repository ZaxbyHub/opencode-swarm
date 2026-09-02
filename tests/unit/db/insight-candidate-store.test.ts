/**
 * insight-candidate swarm.db store (issue #2480): stream versioning, FIFO cap
 * (off-by-one regression), dual-contract consume txn, DELETE-based retention,
 * and the idempotent legacy .jsonl import including its crash windows.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_resetInsightImportGuards,
	appendInsightCandidatesDb,
	consumeInsightCandidatesDb,
	countPendingInsightCandidatesDb,
	INSIGHT_CANDIDATE_STREAM_ID,
	INSIGHT_PENDING_CAP,
	listPendingInsightCandidatesDb,
} from '../../../src/db/insight-candidate-store.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';

let dir: string;

function row(lesson: string, at = '2026-01-01T00:00:00.000Z') {
	return { payload: JSON.stringify({ lesson, created_at: at }), createdAt: at };
}

function pendingVersions(): number[] {
	return getProjectDb(dir)
		.query<{ version: number }, [string]>(
			'SELECT version FROM insight_candidate WHERE stream_id = ? AND consumed_at IS NULL ORDER BY version',
		)
		.all(INSIGHT_CANDIDATE_STREAM_ID)
		.map((r) => r.version);
}

beforeEach(() => {
	dir = canonicalMkdtemp('insight-store-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_resetInsightImportGuards();
});

afterEach(() => {
	closeProjectDb(dir);
	rmSync(dir, { recursive: true, force: true });
});

describe('append / consume round trip', () => {
	test('versions are monotonic and UNIQUE per stream', async () => {
		await appendInsightCandidatesDb(dir, [row('one'), row('two')]);
		await appendInsightCandidatesDb(dir, [row('three')]);
		expect(pendingVersions()).toEqual([1, 2, 3]);
		// The PK (stream_id, version) rejects a duplicate version.
		expect(() =>
			getProjectDb(dir).run(
				'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
				[INSIGHT_CANDIDATE_STREAM_ID, 1, '{}', '2026-01-01'],
			),
		).toThrow();
	});

	test('consume takes the OLDEST batch and marks exactly it consumed', async () => {
		await appendInsightCandidatesDb(dir, [row('a'), row('b'), row('c')]);
		const consumed = consumeInsightCandidatesDb(dir, 2);
		expect(consumed.length).toBe(2);
		expect(JSON.parse(consumed[0]).lesson).toBe('a');
		expect(JSON.parse(consumed[1]).lesson).toBe('b');
		expect(countPendingInsightCandidatesDb(dir)).toBe(1);
		const remaining = listPendingInsightCandidatesDb(dir, 10);
		expect(JSON.parse(remaining[0]).lesson).toBe('c');
	});

	test('FIFO cap keeps exactly the newest N pending (off-by-one regression)', async () => {
		const rows = [];
		for (let i = 0; i < INSIGHT_PENDING_CAP + 3; i++) {
			rows.push(row(`lesson-${i}`));
		}
		await appendInsightCandidatesDb(dir, rows);
		const versions = pendingVersions();
		expect(versions.length).toBe(INSIGHT_PENDING_CAP);
		// The OLDEST three (0,1,2) were dropped; lesson-3 is the oldest kept.
		const oldest = listPendingInsightCandidatesDb(dir, 1);
		expect(JSON.parse(oldest[0]).lesson).toBe('lesson-3');
	});
});

describe('legacy .jsonl import', () => {
	function legacyFile(): string {
		return path.join(dir, '.swarm', 'insight-candidates.jsonl');
	}

	test('file present + empty table → one-txn import → .imported rename', async () => {
		writeFileSync(
			legacyFile(),
			[
				JSON.stringify({ lesson: 'l1' }),
				JSON.stringify({ lesson: 'l2' }),
				'{corrupt',
			].join('\n') + '\n',
		);
		await appendInsightCandidatesDb(dir, [row('fresh')]);
		expect(countPendingInsightCandidatesDb(dir)).toBe(3); // 2 imported + 1 fresh
		expect(existsSync(`${legacyFile()}.imported`)).toBe(true);
		expect(existsSync(legacyFile())).toBe(false);
	});

	test('table non-empty + file present → no re-import; file left untouched', async () => {
		await appendInsightCandidatesDb(dir, [row('already-here')]);
		writeFileSync(legacyFile(), JSON.stringify({ lesson: 'stale' }) + '\n');
		await appendInsightCandidatesDb(dir, [row('another')]);
		expect(countPendingInsightCandidatesDb(dir)).toBe(2);
		// The stale file is inert and preserved (crash-after-commit window /
		// older-plugin-version reappearance), never silently destroyed.
		expect(existsSync(legacyFile())).toBe(true);
	});

	test('file absent → no-op', async () => {
		await appendInsightCandidatesDb(dir, [row('only')]);
		expect(countPendingInsightCandidatesDb(dir)).toBe(1);
		expect(existsSync(`${legacyFile()}.imported`)).toBe(false);
	});

	test('import crash window: post-commit state (table populated, file present) never double-imports', async () => {
		// Simulate "committed but rename never happened": rows in the table AND
		// the original file still on disk.
		await appendInsightCandidatesDb(dir, [row('committed-row')]);
		writeFileSync(
			legacyFile(),
			JSON.stringify({ lesson: 'committed-row' }) + '\n',
		);
		const before = countPendingInsightCandidatesDb(dir);
		_resetInsightImportGuards(); // force the import path to re-evaluate
		consumeInsightCandidatesDb(dir, 10);
		await appendInsightCandidatesDb(dir, [row('post')]);
		expect(countPendingInsightCandidatesDb(dir)).toBe(1); // only 'post'
		expect(before).toBe(1);
	});
});

describe('import retry on transient failure (final-critic finding)', () => {
	test('a throwing import does not cache the root; the next call retries', async () => {
		const legacyPath = path.join(dir, '.swarm', 'insight-candidates.jsonl');
		writeFileSync(legacyPath, `${JSON.stringify({ lesson: 'waiting' })}\n`);
		// First attempt: force the import transaction itself to fail by
		// shadowing the target table with a VIEW (inserts throw).
		const db = getProjectDb(dir);
		db.run('DROP TABLE insight_candidate');
		db.run('CREATE VIEW insight_candidate AS SELECT 1 AS x');
		expect(() => countPendingInsightCandidatesDb(dir)).toThrow();
		// Repair (restore the real v15 table shape); the SAME process must
		// retry the import — the guard was not cached by the failure.
		db.run('DROP VIEW insight_candidate');
		db.run(`CREATE TABLE insight_candidate (
			stream_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL,
			consumed_at TEXT,
			PRIMARY KEY(stream_id, version)
		)`);
		expect(countPendingInsightCandidatesDb(dir)).toBe(1);
		expect(existsSync(`${legacyPath}.imported`)).toBe(true);
	});
});

describe('consumed-row retention', () => {
	test('consumed rows older than the retention window are DELETE-pruned', async () => {
		await appendInsightCandidatesDb(dir, [row('old-consumed'), row('recent')]);
		{
			consumeInsightCandidatesDb(dir, 1); // consumes 'old-consumed'
			// Backdate the consumed_at timestamp beyond the 7-day window.
			getProjectDb(dir).run(
				"UPDATE insight_candidate SET consumed_at = datetime('now', '-30 days') WHERE consumed_at IS NOT NULL",
			);
			consumeInsightCandidatesDb(dir, 1); // consumes 'recent' + triggers the sweep
			// The BACKDATED consumed row was pruned; 'recent' was consumed just
			// now (inside the window) and legitimately remains.
			const outsideWindow = getProjectDb(dir)
				.query<{ n: number }, []>(
					"SELECT COUNT(*) as n FROM insight_candidate WHERE consumed_at IS NOT NULL AND consumed_at < datetime('now', '-7 days')",
				)
				.get()?.n;
			expect(outsideWindow).toBe(0); // pruned
			expect(countPendingInsightCandidatesDb(dir)).toBe(0);
		}
	});
});
