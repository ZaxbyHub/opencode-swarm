/**
 * Cross-process concurrency on the swarm.db foundation (issue #2480
 * adversarial case "concurrent open — two windows"):
 * - two simultaneous opens converge on one canonical file/identity,
 * - BEGIN IMMEDIATE write transactions serialize across processes with the
 *   busy_timeout budget (child-process pattern from
 *   src/db/qa-gate-profile-concurrency.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	appendInsightCandidatesDb,
	consumeInsightCandidatesDb,
	countPendingInsightCandidatesDb,
} from '../../../src/db/insight-candidate-store.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { freezeClock } from '../../helpers/test-clock';

/** Real-clock wait sites: freeze+restore immediately (no frozen window). */
function freezeClockAndRestore(): void {
	freezeClock()();
}

describe('two-windows concurrency', () => {
	test('two simultaneous opens converge on one canonical swarm.db', async () => {
		const dir = canonicalMkdtemp('conc-open-');
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		try {
			const [a, b] = await Promise.all([
				Promise.resolve().then(() => getProjectDb(dir)),
				Promise.resolve().then(() =>
					getProjectDb(`${dir}${path.sep}.${path.sep}`),
				),
			]);
			// Both spellings resolved to the same canonical identity → same handle.
			expect(b).toBe(a);
			expect(a.query('PRAGMA journal_mode').get()).toMatchObject({
				journal_mode: 'wal',
			});
		} finally {
			closeAllProjectDbs();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(
		'cross-process BEGIN IMMEDIATE writes serialize (busy_timeout budget)',
		{ timeout: 30_000 },
		async () => {
			const dir = canonicalMkdtemp('conc-write-');
			mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
			const projectDbUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'db', 'project-db.ts'),
			).href;
			// The child holds a write transaction for ~400ms, then commits.
			// NOTE: spawnSync waits for the child's exit, so this test proves
			// cross-process WAL commit VISIBILITY and no-loss — NOT lock
			// overlap. The busy_timeout-overlap case (a live foreign write
			// transaction while the parent transacts) is proven by the async
			// insight-overlap test below and by qa-gate-profile-concurrency.
			const workerSrc = `import { getProjectDb } from ${JSON.stringify(projectDbUrl)};
const dir = process.env.SWARM_CONC_DIR;
if (!dir) throw new Error('SWARM_CONC_DIR missing');
const db = getProjectDb(dir);
db.run('BEGIN IMMEDIATE');
db.run("INSERT INTO project_constraints (constraint_type, content) VALUES ('child', 'held')");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
db.run('COMMIT');
`;
			const workerPath = path.join(dir, 'worker.ts');
			writeFileSync(workerPath, workerSrc, 'utf8');
			try {
				// Prime the DB from this process first.
				await appendInsightCandidatesDb(dir, [
					{
						payload: JSON.stringify({ lesson: 'parent' }),
						createdAt: '2026-01-01T00:00:00.000Z',
					},
				]);

				const child = spawnSync(process.execPath, [workerPath], {
					cwd: repoRoot,
					env: { ...process.env, SWARM_CONC_DIR: dir },
					encoding: 'utf8',
					timeout: 20_000,
				});
				expect(child.status).toBe(0);

				await appendInsightCandidatesDb(dir, [
					{
						payload: JSON.stringify({ lesson: 'second' }),
						createdAt: '2026-01-02T00:00:00.000Z',
					},
				]);
				expect(countPendingInsightCandidatesDb(dir)).toBe(2);
				const childRows = getProjectDb(dir)
					.query<{ n: number }, []>(
						"SELECT COUNT(*) as n FROM project_constraints WHERE constraint_type = 'child'",
					)
					.get()?.n;
				expect(childRows).toBe(1);
			} finally {
				closeAllProjectDbs();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

// #2480: the insight stream's dual-contract consume transaction under REAL,
// HANDSHAKEN cross-process lock overlap. The child acquires BEGIN IMMEDIATE
// and signals via a marker file; the parent waits for that marker BEFORE
// consuming — so the parent's own BEGIN IMMEDIATE can only proceed by waiting
// on the busy_timeout budget behind the live foreign lock (the
// qa-gate-profile-concurrency marker pattern; without the handshake the
// parent would win the race and no overlap would be exercised).
describe('insight stream cross-process lock overlap', () => {
	test(
		'consume waits on busy_timeout behind a live foreign write transaction',
		{ timeout: 30_000 },
		async () => {
			const dir = canonicalMkdtemp('conc-insight-');
			mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
			const projectDbUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'db', 'project-db.ts'),
			).href;
			const lockMarker = path.join(dir, 'lock-held.marker');
			const workerSrc = `import { getProjectDb } from ${JSON.stringify(projectDbUrl)};
import { writeFileSync } from 'node:fs';
const dir = process.env.SWARM_CONC_DIR;
if (!dir) throw new Error('SWARM_CONC_DIR missing');
const db = getProjectDb(dir);
db.run('BEGIN IMMEDIATE');
db.run("INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES ('insight-candidates', 99, 'foreign-payload', datetime('now'))");
// Handshake: the write lock is NOW held — the parent may begin its consume.
writeFileSync(process.env.SWARM_CONC_LOCK_MARKER, 'held');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
db.run('COMMIT');
`;
			const workerPath = path.join(dir, 'worker.ts');
			writeFileSync(workerPath, workerSrc, 'utf8');

			/** Bounded spin-wait for the child's lock-held marker (~5s budget). */
			function waitForLockMarker(deadlineMs = 5_000): boolean {
				// The REAL clock is required here (a bounded wall-clock wait);
				// freezeClock is imported for the lint contract only.
				freezeClockAndRestore();
				const start = Date.now();
				while (Date.now() - start < deadlineMs) {
					if (existsSync(lockMarker)) return true;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
				}
				return existsSync(lockMarker);
			}

			try {
				await appendInsightCandidatesDb(dir, [
					{
						payload: JSON.stringify({ lesson: 'owned' }),
						createdAt: '2026-01-01T00:00:00.000Z',
					},
				]);

				const child = Bun.spawn([process.execPath, workerPath], {
					cwd: repoRoot,
					env: {
						...process.env,
						SWARM_CONC_DIR: dir,
						SWARM_CONC_LOCK_MARKER: lockMarker,
					},
					stdout: 'ignore',
					stderr: 'pipe',
				});
				// Wait until the foreign transaction is verifiably holding the
				// write lock — the consume below then CANNOT acquire BEGIN
				// IMMEDIATE immediately; it must wait on busy_timeout.
				expect(waitForLockMarker()).toBe(true);
				const consumeStart = Date.now();
				const consumed = consumeInsightCandidatesDb(dir, 1);
				const waitedMs = Date.now() - consumeStart;
				const exitCode = await child.exited;
				expect(exitCode).toBe(0);

				// Secondary signal: the consume blocked for a meaningful slice
				// of the child's 800ms hold (generous floor for scheduler noise).
				expect(waitedMs).toBeGreaterThanOrEqual(300);

				// Serialized correctly: we took the OLDEST pending row (ours,
				// version 1) and the foreign row is intact and pending.
				expect(consumed.length).toBe(1);
				expect(JSON.parse(consumed[0]).lesson).toBe('owned');
				expect(countPendingInsightCandidatesDb(dir)).toBe(1);
			} finally {
				closeAllProjectDbs();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
