/**
 * Issue #2041 — cleanup budgets: age sweep (mtime clamped against clock
 * skew), per-directory session-file count cap (the adversarial-mtime
 * backstop), checkpoint-sibling removal, stale tmp reaping, bounded work per
 * run, and structural isolation from task evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFrozenClock } from '../../../tests/helpers/test-clock.js';
import {
	_test_exports,
	cleanupOldTrajectoryFiles,
	scheduleTrajectoryCleanup,
} from '../trajectory-store';

// FR-011 (issue #1737): canonicalize the macOS /var symlink gap.
const canonicalTmp = fs.realpathSync(os.tmpdir());

const { TRAJECTORY_LIMITS } = _test_exports;

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed epoch instants (2020-01-01 / 2100-01-01): the sweeper computes
// its own cutoff from the real clock, so tests only need mtimes that are
// deterministically far older/newer than any 7-day horizon — no raw clock
// reads in test code (tests/unit test-clock gate, now covering src).
const OLD_EPOCH_S = 1_577_836_800;
const FUTURE_EPOCH_S = 4_102_444_800;

function touchOld(file: string, _ageMs: number): void {
	fs.utimesSync(file, OLD_EPOCH_S, OLD_EPOCH_S);
}

function mkTrajectory(tempDir: string, name: string): string {
	const dir = path.join(tempDir, '.swarm', 'trajectories');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, '{"step":1}\n');
	return file;
}

describe('trajectory-store cleanup budgets (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(canonicalTmp, 'trajectory-cleanup-'));
		// The debounce timestamp is module-global; a sibling test file's real
		// scheduling call inside the 10-minute window would otherwise no-op
		// this file's first call under a directory-level co-run.
		_test_exports.resetCleanupDebounce();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('age sweep removes the trajectory AND its checkpoint sibling, keeps fresh files', async () => {
		const oldFile = mkTrajectory(tempDir, 'old-session');
		fs.writeFileSync(`${oldFile}.meta.json`, '{"version":1}\n');
		touchOld(oldFile, 30 * DAY_MS);
		touchOld(`${oldFile}.meta.json`, 30 * DAY_MS);
		const freshFile = mkTrajectory(tempDir, 'fresh-session');

		await cleanupOldTrajectoryFiles(tempDir, 7);

		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(`${oldFile}.meta.json`)).toBe(false);
		expect(fs.existsSync(freshFile)).toBe(true);
	});

	test('the per-directory count cap deletes oldest-first (adversarial mtime backstop)', async () => {
		const cap = TRAJECTORY_LIMITS.maxFilesPerDir;
		const total = cap + 10;
		// Frozen clock: "now" is a fixed instant, so mtimes offset from it are
		// simultaneously FRESH (within the 7-day horizon) and strictly ordered
		// — no raw clock reads in test code (test-clock gate now scans src).
		const fixedNowMs = 1_700_000_000_000;
		await withFrozenClock(
			async () => {
				for (let i = 0; i < total; i++) {
					const file = mkTrajectory(tempDir, `s-${String(i).padStart(4, '0')}`);
					// Higher index = older; all within the age horizon.
					const atMs = fixedNowMs - i * 1000;
					fs.utimesSync(file, atMs / 1000, atMs / 1000);
				}

				await cleanupOldTrajectoryFiles(tempDir, 7);

				const remaining = fs
					.readdirSync(path.join(tempDir, '.swarm', 'trajectories'))
					.filter((n) => n.endsWith('.jsonl'));
				expect(remaining.length).toBeLessThanOrEqual(cap);
				// The NEWEST sessions survive; the most-aged are reaped first.
				expect(remaining).toContain('s-0000.jsonl');
				expect(remaining).toContain('s-0199.jsonl');
				expect(remaining).not.toContain('s-0209.jsonl');
			},
			{ fixedNow: fixedNowMs },
		);
	});

	test('a future-dated mtime is clamped to now — no flash-delete, no immortal file via age alone', async () => {
		const futureFile = mkTrajectory(tempDir, 'future-session');
		// utimes accepts epoch SECONDS directly — no Date construction needed.
		const future = FUTURE_EPOCH_S;
		fs.utimesSync(futureFile, future, future);

		await cleanupOldTrajectoryFiles(tempDir, 7);

		// Clamped to "now": the file counts as fresh — neither reaped nor
		// immortal (it is reaped by the count cap, not by age, until real
		// time passes its horizon).
		expect(fs.existsSync(futureFile)).toBe(true);
	});

	test('work per run is bounded: a large overshoot converges across runs', async () => {
		const cap = TRAJECTORY_LIMITS.maxFilesPerDir;
		const overshoot = cap + TRAJECTORY_LIMITS.maxDeletionsPerRun + 50;
		for (let i = 0; i < overshoot; i++) {
			mkTrajectory(tempDir, `bulk-${String(i).padStart(5, '0')}`);
		}

		await cleanupOldTrajectoryFiles(tempDir, 7);
		let remaining = fs
			.readdirSync(path.join(tempDir, '.swarm', 'trajectories'))
			.filter((n) => n.endsWith('.jsonl')).length;
		// First run deleted at most maxDeletionsPerRun files.
		expect(remaining).toBe(overshoot - TRAJECTORY_LIMITS.maxDeletionsPerRun);

		await cleanupOldTrajectoryFiles(tempDir, 7);
		remaining = fs
			.readdirSync(path.join(tempDir, '.swarm', 'trajectories'))
			.filter((n) => n.endsWith('.jsonl')).length;
		expect(remaining).toBeLessThanOrEqual(cap); // converged
	});

	test('stale atomic-write tmp leftovers age out', async () => {
		const dir = path.join(tempDir, '.swarm', 'trajectories');
		fs.mkdirSync(dir, { recursive: true });
		const tmp = path.join(dir, 'session.jsonl.12345.tmp');
		fs.writeFileSync(tmp, 'partial write');
		touchOld(tmp, 30 * DAY_MS);

		await cleanupOldTrajectoryFiles(tempDir, 7);

		expect(fs.existsSync(tmp)).toBe(false);
	});

	test('live lock files are never unlinked by the sweeper', async () => {
		const dir = path.join(tempDir, '.swarm', 'trajectories');
		fs.mkdirSync(dir, { recursive: true });
		const lock = path.join(dir, 'session.jsonl.lock');
		fs.writeFileSync(lock, String(process.pid));
		touchOld(lock, 365 * DAY_MS); // even an "old-looking" lock

		await cleanupOldTrajectoryFiles(tempDir, 7);

		expect(fs.existsSync(lock)).toBe(true);
	});

	test('replays/ shares the sweep; task evidence is structurally untouched', async () => {
		const replaysDir = path.join(tempDir, '.swarm', 'replays');
		fs.mkdirSync(replaysDir, { recursive: true });
		const oldReplay = path.join(replaysDir, 'ses-123-1000.jsonl');
		fs.writeFileSync(oldReplay, '{}\n');
		touchOld(oldReplay, 30 * DAY_MS);

		// Evidence tree lives under .swarm/evidence — a different directory
		// the sweeper never enumerates.
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', 'task-1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		const evidence = path.join(evidenceDir, 'trajectory.jsonl');
		fs.writeFileSync(evidence, '{"step":1}\n');
		touchOld(evidence, 365 * DAY_MS);

		await cleanupOldTrajectoryFiles(tempDir, 7);

		expect(fs.existsSync(oldReplay)).toBe(false);
		expect(fs.existsSync(evidence)).toBe(true);
	});

	test('scheduleTrajectoryCleanup debounces repeat scheduling', async () => {
		const file = mkTrajectory(tempDir, 'sched-session');
		touchOld(file, 30 * DAY_MS);

		scheduleTrajectoryCleanup(tempDir);
		// Second call inside the debounce window is a no-op; give the first
		// (fire-and-forget) pass a moment to land.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(fs.existsSync(file)).toBe(false);

		// Re-create + re-schedule inside the window: still debounced.
		const file2 = mkTrajectory(tempDir, 'sched-session-2');
		touchOld(file2, 30 * DAY_MS);
		scheduleTrajectoryCleanup(tempDir);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(fs.existsSync(file2)).toBe(true); // not swept — debounced
	});
});
