/**
 * Issue #2041 — crash and concurrency semantics of the bounded store.
 *
 * Torn tails are re-framed on the next append (a crashed mid-line write can
 * no longer swallow the NEXT entry), a stale lock is broken, a held fresh
 * lock skips the append without corrupting the file, and concurrent appends
 * (the two-writer shape) serialize without interleaving or losing lines.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	appendTrajectoryEntry,
	clearTrajectoryCache,
	readTrajectory,
} from '../trajectory-store';
import type { TrajectoryEntry } from '../types';

function createEntry(step: number): TrajectoryEntry {
	return {
		step,
		agent: 'coder',
		action: 'edit',
		target: `src/f${step}.ts`,
		intent: 'lock-crash test',
		timestamp: new Date().toISOString(),
		result: 'success',
	};
}

function trajectoryFile(tempDir: string, sessionId: string): string {
	return path.join(tempDir, '.swarm', 'trajectories', `${sessionId}.jsonl`);
}

describe('trajectory-store lock/crash semantics (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-lock-'));
		clearTrajectoryCache();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('a torn tail (crash mid-line) is re-framed: the next entry is not swallowed', async () => {
		const sessionId = 'torn-tail';
		const dir = path.dirname(trajectoryFile(tempDir, sessionId));
		fs.mkdirSync(dir, { recursive: true });
		// Simulate a crash mid-write: the last line has no trailing newline.
		fs.writeFileSync(
			trajectoryFile(tempDir, sessionId),
			`${JSON.stringify(createEntry(1))}\n${JSON.stringify(createEntry(2)).slice(0, 40)}`,
		);

		await appendTrajectoryEntry(sessionId, createEntry(3), tempDir, 1000);

		const entries = await readTrajectory(sessionId, tempDir);
		// Entry 2 stays corrupt (unrecoverable), but entry 3 must survive as
		// its own line instead of being concatenated into the torn tail.
		const steps = entries.map((e) => e.step);
		expect(steps).toContain(3);
		expect(steps).toContain(1);
		// The corrupt fragment is shed at compaction; until then it remains a
		// separate (skipped) line — the re-framed NEW entry parses cleanly.
		const raw = fs
			.readFileSync(trajectoryFile(tempDir, sessionId), 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		expect(() => JSON.parse(raw[raw.length - 1])).not.toThrow();
		expect((JSON.parse(raw[raw.length - 1]) as TrajectoryEntry).step).toBe(3);
	});

	test('a stale lock (crashed writer) is broken and the append proceeds', async () => {
		const sessionId = 'stale-lock';
		const dir = path.dirname(trajectoryFile(tempDir, sessionId));
		fs.mkdirSync(dir, { recursive: true });
		const lock = `${trajectoryFile(tempDir, sessionId)}.lock`;
		// A lock older than lockStaleMs (5 min) is a crashed writer's leftover.
		const old = new Date(Date.now() - 10 * 60 * 1000);
		fs.writeFileSync(lock, '99999');
		fs.utimesSync(lock, old, old);

		await appendTrajectoryEntry(sessionId, createEntry(1), tempDir, 1000);

		const entries = await readTrajectory(sessionId, tempDir);
		expect(entries.map((e) => e.step)).toEqual([1]);
	});

	test('a held fresh lock skips the append without corrupting the store', async () => {
		const sessionId = 'held-lock';
		const dir = path.dirname(trajectoryFile(tempDir, sessionId));
		fs.mkdirSync(dir, { recursive: true });
		// Seed one valid entry, then hold the lock.
		await appendTrajectoryEntry(sessionId, createEntry(1), tempDir, 1000);
		const lock = `${trajectoryFile(tempDir, sessionId)}.lock`;
		fs.writeFileSync(lock, String(process.pid));

		// The append exhausts its bounded retries (20 x 5ms) and resolves
		// without throwing — telemetry loss is preferred over corruption.
		await expect(
			appendTrajectoryEntry(sessionId, createEntry(2), tempDir, 1000),
		).resolves.toBeUndefined();

		const entries = await readTrajectory(sessionId, tempDir);
		expect(entries.map((e) => e.step)).toEqual([1]); // entry 2 skipped

		// Releasing the lock unblocks subsequent appends.
		fs.unlinkSync(lock);
		await appendTrajectoryEntry(sessionId, createEntry(3), tempDir, 1000);
		expect((await readTrajectory(sessionId, tempDir)).map((e) => e.step)).toEqual([
			1, 3,
		]);
	});

	test('concurrent appends (two writers, one process) serialize without corruption', async () => {
		const sessionId = 'two-writers';
		// Fire 30 appends concurrently; the per-key chain serializes them.
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, i) =>
				appendTrajectoryEntry(sessionId, createEntry(i + 1), tempDir, 1000),
			),
		);
		expect(results.every((r) => r === undefined)).toBe(true);

		const entries = await readTrajectory(sessionId, tempDir);
		expect(entries).toHaveLength(30);
		// Every line is intact JSON and steps are unique — no interleaving.
		const steps = entries.map((e) => e.step).sort((a, b) => a - b);
		expect(steps).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
		const raw = fs
			.readFileSync(trajectoryFile(tempDir, sessionId), 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		expect(raw).toHaveLength(30);
		for (const line of raw) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		// No lock residue after a clean run.
		expect(fs.existsSync(`${trajectoryFile(tempDir, sessionId)}.lock`)).toBe(false);
	});
});
