/**
 * Issue #2041 — the production append path enforces the DISK bound.
 *
 * These tests prove the bound on the FILE, not the in-memory cache: sustained
 * appends through `appendTrajectoryEntry` (the exact function
 * `src/hooks/trajectory-logger.ts` calls per tool call) keep the session
 * trajectory within its line budget and byte ceiling, retain the newest
 * window (with the global max step), and ratchet the atomic checkpoint.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_test_exports,
	appendTrajectoryEntry,
	clearTrajectoryCache,
	getCurrentStep,
	readTrajectory,
	readTrajectoryCheckpoint,
	readTrajectoryWithCoverage,
} from '../trajectory-store';
import type { TrajectoryEntry } from '../types';

// FR-011 (issue #1737): canonicalize the macOS /var symlink gap.
const canonicalTmp = fs.realpathSync(os.tmpdir());

const { sessionMaxBytesFor, TRAJECTORY_LIMITS } = _test_exports;

function createEntry(
	step: number,
	overrides: Partial<TrajectoryEntry> = {},
): TrajectoryEntry {
	return {
		step,
		agent: 'coder',
		action: 'edit',
		target: `src/file-${step}.ts`,
		intent: 'bounded-store test',
		timestamp: '2026-01-01T00:00:00.000Z',
		result: 'success',
		tool: 'write',
		args_summary: `summary-${step}`,
		...overrides,
	};
}

function readDiskLines(tempDir: string, sessionId: string): TrajectoryEntry[] {
	const file = path.join(
		tempDir,
		'.swarm',
		'trajectories',
		`${sessionId}.jsonl`,
	);
	const content = fs.readFileSync(file, 'utf-8');
	return content
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as TrajectoryEntry);
}

describe('trajectory-store disk bounds (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(canonicalTmp, 'trajectory-bounds-'));
		clearTrajectoryCache();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('sustained production appends keep the file within the line budget', async () => {
		const sessionId = 'line-budget';
		const maxLines = 20;

		// 26 appends cross one check interval (25); the check compacts to
		// floor(20/2) = 10 and the 26th lands after it.
		for (let i = 1; i <= 26; i++) {
			await appendTrajectoryEntry(sessionId, createEntry(i), tempDir, maxLines);
		}

		const entries = readDiskLines(tempDir, sessionId);
		expect(entries.length).toBeLessThanOrEqual(maxLines);
		// Newest retained in order, oldest shed.
		expect(entries.map((e) => e.step)).toEqual(
			Array.from(
				{ length: entries.length },
				(_, k) => 26 - entries.length + 1 + k,
			),
		);
		expect(entries[entries.length - 1].step).toBe(26);
	});

	test('the byte ceiling is enforced at APPEND time, not only on the check interval', async () => {
		const sessionId = 'byte-ceiling';
		// maxLines=10 derives the minimum ceiling (64 KiB floor). Fat entries
		// (~2 KiB each) cross it long before 25 appends: entry ~33.
		const maxLines = 10;
		const ceiling = sessionMaxBytesFor(maxLines);
		const fat = { args_summary: 'x'.repeat(2048) };

		for (let i = 1; i <= 20; i++) {
			await appendTrajectoryEntry(
				sessionId,
				createEntry(i, fat),
				tempDir,
				maxLines,
			);
		}

		const file = path.join(
			tempDir,
			'.swarm',
			'trajectories',
			`${sessionId}.jsonl`,
		);
		// 20 fat entries ≈ 41 KiB < 64 KiB — under the floor; force a bigger
		// run so the append-time trigger fires mid-run.
		for (let i = 21; i <= 60; i++) {
			await appendTrajectoryEntry(
				sessionId,
				createEntry(i, fat),
				tempDir,
				maxLines,
			);
		}
		const sizeAfter60 = fs.statSync(file).size;
		// The ceiling binds at append time: the file can overshoot by at most
		// one append line past the ceiling between checks.
		expect(sizeAfter60).toBeLessThanOrEqual(
			ceiling + TRAJECTORY_LIMITS.maxLineBytes,
		);

		// A budget-busting file converges under the ceiling and keeps the
		// newest entries. (Between compactions the file may legitimately hold
		// more than maxLines FAT lines — the sovereign bound here is BYTES.)
		const entries = readDiskLines(tempDir, sessionId);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[entries.length - 1].step).toBe(60);
	});

	test('a fat-line file sheds oldest-kept until retained bytes fit the ceiling (min 1 line)', async () => {
		const sessionId = 'sovereign-bytes';
		const maxLines = 1000; // ceiling = 500 KiB
		const ceiling = sessionMaxBytesFor(maxLines);
		// 120 entries x ~6 KiB ≈ 720 KiB: over the byte ceiling while under
		// the line budget — the sovereign ceiling must shed oldest-kept.
		const fat = { args_summary: 'y'.repeat(6 * 1024) };
		for (let i = 1; i <= 120; i++) {
			await appendTrajectoryEntry(
				sessionId,
				createEntry(i, fat),
				tempDir,
				maxLines,
			);
		}
		const file = path.join(
			tempDir,
			'.swarm',
			'trajectories',
			`${sessionId}.jsonl`,
		);
		const size = fs.statSync(file).size;
		expect(size).toBeLessThanOrEqual(ceiling + TRAJECTORY_LIMITS.maxLineBytes);

		const entries = readDiskLines(tempDir, sessionId);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.length).toBeLessThan(120); // shedding happened
		expect(entries[entries.length - 1].step).toBe(120); // newest survives
	});

	test('oversize single records are skipped whole and never reach the file', async () => {
		const sessionId = 'oversize-record';
		const huge = {
			args_summary: 'z'.repeat(TRAJECTORY_LIMITS.maxLineBytes + 1024),
		};

		await appendTrajectoryEntry(sessionId, createEntry(1, huge), tempDir, 1000);
		await appendTrajectoryEntry(sessionId, createEntry(2), tempDir, 1000);

		const entries = readDiskLines(tempDir, sessionId);
		expect(entries.map((e) => e.step)).toEqual([2]);
	});

	test('compaction ratchets the checkpoint and retains the max step', async () => {
		const sessionId = 'checkpoint-ratchet';
		const maxLines = 20;

		for (let i = 1; i <= 26; i++) {
			await appendTrajectoryEntry(sessionId, createEntry(i), tempDir, maxLines);
		}

		const checkpoint = await readTrajectoryCheckpoint(sessionId, tempDir);
		expect(checkpoint).not.toBeNull();
		expect(checkpoint!.version).toBe(1);
		// Compaction ran at the 25th append (check interval): it saw max step
		// 25, kept the newest floor(20/2)=10 window (steps 16..25), and the
		// 26th append landed after it. The checkpoint records what compaction
		// OBSERVED (25); the appended-after step is covered by the tail read.
		expect(checkpoint!.highestStep).toBeGreaterThanOrEqual(25);
		expect(checkpoint!.droppedEntries).toBeGreaterThan(0);

		// Simulated restart: cache cleared, no in-process state. Step
		// continuity comes from max(tail read, checkpoint) — the 26th step
		// lives in the tail.
		clearTrajectoryCache();
		expect(await getCurrentStep(sessionId, tempDir)).toBeGreaterThanOrEqual(26);
	});

	test('cache and disk agree: the same maxLines knob bounds both', async () => {
		const sessionId = 'aligned-knobs';
		const maxLines = 20;

		for (let i = 1; i <= 30; i++) {
			await appendTrajectoryEntry(sessionId, createEntry(i), tempDir, maxLines);
		}

		const disk = readDiskLines(tempDir, sessionId);
		const { getInMemoryTrajectory } = await import('../trajectory-store');
		const cache = getInMemoryTrajectory(sessionId, tempDir);

		// Both obey the SAME retention rule: newest floor(maxLines/2) when
		// over maxLines (the cache trims continuously; the disk compacts on
		// the check interval, so the disk may briefly retain up to maxLines).
		expect(cache.length).toBeLessThanOrEqual(maxLines);
		expect(disk.length).toBeLessThanOrEqual(maxLines);
		// The newest entry is identical in both.
		expect(cache[cache.length - 1].step).toBe(disk[disk.length - 1].step);
	});

	test('a cold read populates the cache trimmed to the CONFIGURED budget, not the default', async () => {
		const sessionId = 'cold-read-budget';
		// A legacy pre-fix file with far more entries than the configured
		// budget: without threading maxLines through the read, the cache
		// would silently hold up to the default 1000 (review round 1).
		const trajectoriesDir = path.join(tempDir, '.swarm', 'trajectories');
		fs.mkdirSync(trajectoriesDir, { recursive: true });
		const lines: string[] = [];
		for (let i = 1; i <= 300; i++) lines.push(JSON.stringify(createEntry(i)));
		fs.writeFileSync(
			path.join(trajectoriesDir, `${sessionId}.jsonl`),
			`${lines.join('\n')}\n`,
		);

		const read = await readTrajectoryWithCoverage(sessionId, tempDir, 50);
		expect(read.entries.length).toBe(300); // the read returns the window
		const { getInMemoryTrajectory } = await import('../trajectory-store');
		expect(getInMemoryTrajectory(sessionId, tempDir).length).toBe(25); // floor(50/2)
	});

	test('a legacy unbounded file converges under the budget through the bounded append path', async () => {
		const sessionId = 'legacy-huge';
		const trajectoriesDir = path.join(tempDir, '.swarm', 'trajectories');
		fs.mkdirSync(trajectoriesDir, { recursive: true });
		const file = path.join(trajectoriesDir, `${sessionId}.jsonl`);
		// Pre-#2041-style unbounded legacy file: 600 entries.
		const legacy: string[] = [];
		for (let i = 1; i <= 600; i++) {
			legacy.push(JSON.stringify(createEntry(i)));
		}
		fs.writeFileSync(file, `${legacy.join('\n')}\n`);

		const maxLines = 40;
		// 26 new appends trigger the check interval; the tail-bounded
		// compaction reads at most compactMaxBytes regardless of file size.
		for (let i = 601; i <= 626; i++) {
			await appendTrajectoryEntry(sessionId, createEntry(i), tempDir, maxLines);
		}

		const entries = readDiskLines(tempDir, sessionId);
		expect(entries.length).toBeLessThanOrEqual(maxLines);
		expect(entries[entries.length - 1].step).toBe(626);
		// Step continuity across the legacy migration.
		clearTrajectoryCache();
		expect(await getCurrentStep(sessionId, tempDir)).toBeGreaterThanOrEqual(
			626,
		);
		// readTrajectory returns the retained window in order.
		const read = await readTrajectory(sessionId, tempDir);
		expect(read.length).toBe(entries.length);
	});

	test('per-session resets do not defeat the line-count compaction cadence (maintainer review #2395, finding 4)', async () => {
		const sessionId = 'counter-wipe';
		const maxLines = 20;

		// Interleave UNRELATED-session cache clears with appends: the old
		// wholesale appendCheckCounters wipe reset this session's compaction
		// cadence too, so the file overshoot ~2.2x the line budget.
		for (let i = 1; i <= 30; i++) {
			await appendTrajectoryEntry(sessionId, createEntry(i), tempDir, maxLines);
			await clearTrajectoryCache('unrelated-other-session');
		}

		const entries = readDiskLines(tempDir, sessionId);
		expect(entries.length).toBeLessThanOrEqual(maxLines);
		expect(entries[entries.length - 1].step).toBe(30);
	});
});
