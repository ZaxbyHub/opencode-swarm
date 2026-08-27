/**
 * Issue #2041 Required 4 — pattern-detection results for RETAINED data.
 *
 * The in-memory cache has always windowed detection at maxLines (it keeps the
 * newest floor(maxLines/2) once over budget); disk compaction uses the SAME
 * rule. These tests pin that equivalence: detection over a post-compaction
 * disk read equals detection over the equally-trimmed cache, a retained-window
 * episode is still caught, and an episode entirely in the pruned half is not
 * spuriously re-detected.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	appendTrajectoryEntry,
	clearTrajectoryCache,
	readTrajectoryWithCoverage,
} from '../trajectory-store';
import { detectPatterns } from '../pattern-detector';
import type { PrmConfig, TrajectoryEntry } from '../types';

const config: PrmConfig = {
	enabled: true,
	pattern_thresholds: {
		repetition_loop: 2,
		ping_pong: 2,
		expansion_drift: 3,
		stuck_on_test: 3,
		context_thrash: 10,
	},
	max_trajectory_lines: 1000,
	escalation_enabled: true,
	detection_timeout_ms: 100,
};

function entry(step: number, overrides: Partial<TrajectoryEntry> = {}): TrajectoryEntry {
	return {
		step,
		agent: 'coder',
		action: 'edit',
		target: 'src/a.ts',
		intent: 'window',
		timestamp: new Date().toISOString(),
		result: 'success',
		...overrides,
	};
}

describe('pattern detection over the retained window (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-window-'));
		clearTrajectoryCache();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('a repetition_loop episode inside the retained window is still detected after compaction', async () => {
		const sessionId = 'retained-episode';
		const maxLines = 20;

		// Steps 1..10: healthy variety. Steps 11..26: a hard repetition loop
		// (same agent|action|target) that survives the compaction triggered at
		// the 25th append (keeps the newest 10: steps 17..25) plus step 26.
		for (let i = 1; i <= 10; i++) {
			await appendTrajectoryEntry(
				sessionId,
				entry(i, { target: `src/healthy-${i}.ts` }),
				tempDir,
				maxLines,
			);
		}
		for (let i = 11; i <= 26; i++) {
			await appendTrajectoryEntry(
				sessionId,
				entry(i, { target: 'src/stuck.ts' }),
				tempDir,
				maxLines,
			);
		}

		clearTrajectoryCache(); // force the disk read path
		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.entries.length).toBeLessThanOrEqual(maxLines);

		const result = detectPatterns(read.entries, config, 0);
		const loop = result.matches.find((m) => m.pattern === 'repetition_loop');
		expect(loop).toBeDefined();
		expect(loop!.occurrenceCount).toBeGreaterThanOrEqual(2);
	});

	test('an episode entirely in the pruned half is not re-detected from the retained window alone', async () => {
		const sessionId = 'pruned-episode';
		const maxLines = 20;

		// Steps 1..12: one repetition episode on src/old-stuck.ts. Steps 13..30:
		// healthy, distinct targets. The compaction at append 25 keeps the
		// newest 10 — the episode is fully pruned from the retained window.
		for (let i = 1; i <= 12; i++) {
			await appendTrajectoryEntry(
				sessionId,
				entry(i, { target: 'src/old-stuck.ts' }),
				tempDir,
				maxLines,
			);
		}
		for (let i = 13; i <= 30; i++) {
			await appendTrajectoryEntry(
				sessionId,
				entry(i, { target: `src/fresh-${i}.ts` }),
				tempDir,
				maxLines,
			);
		}

		clearTrajectoryCache();
		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.entries.some((e) => e.target === 'src/old-stuck.ts')).toBe(false);

		const result = detectPatterns(read.entries, config, 0);
		expect(result.matches.find((m) => m.pattern === 'repetition_loop')).toBeUndefined();
	});

	test('detection over the compacted disk window equals detection over the equally-trimmed cache', async () => {
		const sessionId = 'equivalence';
		const maxLines = 20;

		// Mixed history ending in a repetition loop.
		for (let i = 1; i <= 10; i++) {
			await appendTrajectoryEntry(
				sessionId,
				entry(i, { target: `src/var-${i}.ts` }),
				tempDir,
				maxLines,
			);
		}
		for (let i = 11; i <= 26; i++) {
			await appendTrajectoryEntry(
				sessionId,
				entry(i, { target: 'src/stuck.ts' }),
				tempDir,
				maxLines,
			);
		}

		// Cache path: the live cache after 26 appends, trimmed by the store's
		// cache rule (newest floor(maxLines/2) once over maxLines).
		const { getInMemoryTrajectory } = await import('../trajectory-store');
		const cached = getInMemoryTrajectory(sessionId, tempDir);
		expect(cached.length).toBeLessThanOrEqual(maxLines);

		// Disk path: cold read of the compacted file. The disk window is the
		// NEWEST slice of the cache window (same retention rule; the disk
		// compacts on the check interval while the cache trims continuously).
		clearTrajectoryCache();
		const diskRead = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(diskRead.entries.length).toBeLessThanOrEqual(cached.length);
		expect(cached.slice(-diskRead.entries.length).map((e) => e.step)).toEqual(
			diskRead.entries.map((e) => e.step),
		);

		// Identical windows produce identical detection results, whatever the
		// source — compaction does not distort detector semantics.
		const fromCache = detectPatterns(
			cached.slice(-diskRead.entries.length),
			config,
			0,
		);
		const fromDisk = detectPatterns(diskRead.entries, config, 0);
		expect(fromDisk.matches).toEqual(fromCache.matches);
		expect(fromCache.matches.length).toBeGreaterThan(0);
	});
});
