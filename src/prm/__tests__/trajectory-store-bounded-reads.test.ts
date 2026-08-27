/**
 * Issue #2041 — bounded reads with coverage disclosure.
 *
 * readTrajectory/readTrajectoryWithCoverage read a bounded tail window no
 * matter how large the file is (legacy pre-fix files included), disclose
 * coverage, tolerate corrupt/oversize tails, and getCurrentStep merges the
 * checkpoint so a restart (or even a fully-corrupt data file) never scans
 * history and never lowers the step high-water mark.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_test_exports,
	clearTrajectoryCache,
	getCurrentStep,
	readTrajectory,
	readTrajectoryCheckpoint,
	readTrajectoryWithCoverage,
} from '../trajectory-store';
import type { TrajectoryEntry } from '../types';

const { TRAJECTORY_LIMITS } = _test_exports;

function entry(step: number): string {
	return JSON.stringify({
		step,
		agent: 'coder',
		action: 'edit',
		target: `src/f${step}.ts`,
		intent: 'read-window',
		timestamp: new Date().toISOString(),
		result: 'success',
	});
}

function makeSessionFile(
	tempDir: string,
	sessionId: string,
	lines: string[],
): string {
	const dir = path.join(tempDir, '.swarm', 'trajectories');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.jsonl`);
	fs.writeFileSync(file, `${lines.join('\n')}\n`);
	return file;
}

describe('trajectory-store bounded reads (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-reads-'));
		clearTrajectoryCache();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('a file larger than the read window returns the newest entries with truncated coverage', async () => {
		const sessionId = 'huge-legacy';
		// Build a file well over readMaxBytes (1 MiB): ~150 B/line x 8000.
		const lines: string[] = [];
		for (let i = 1; i <= 8000; i++) lines.push(entry(i));
		const file = makeSessionFile(tempDir, sessionId, lines);
		expect(fs.statSync(file).size).toBeGreaterThan(
			TRAJECTORY_LIMITS.readMaxBytes,
		);

		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.coverage).toBe('truncated');
		// The window is the newest slice, in order, ending at the last step.
		const steps = read.entries.map((e) => e.step);
		expect(steps[steps.length - 1]).toBe(8000);
		expect(steps.length).toBeGreaterThan(0);
		expect(steps.length).toBeLessThan(8000);
		// Strictly increasing file order.
		for (let i = 1; i < steps.length; i++) {
			expect(steps[i]).toBeGreaterThan(steps[i - 1]);
		}
	});

	test('getCurrentStep is bounded and correct on a huge file (max step lives in the tail)', async () => {
		const sessionId = 'huge-step';
		const lines: string[] = [];
		for (let i = 1; i <= 8000; i++) lines.push(entry(i));
		makeSessionFile(tempDir, sessionId, lines);

		clearTrajectoryCache();
		expect(await getCurrentStep(sessionId, tempDir)).toBe(8000);
	});

	test('coverage is complete for a within-window file with no checkpoint', async () => {
		const sessionId = 'small';
		makeSessionFile(tempDir, sessionId, [entry(1), entry(2)]);

		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.coverage).toBe('complete');
		expect(read.entries.map((e) => e.step)).toEqual([1, 2]);
		expect(read.droppedByCompaction).toBe(0);
	});

	test('a prior compaction (checkpoint) flips coverage to truncated with the dropped count', async () => {
		const sessionId = 'compacted';
		makeSessionFile(tempDir, sessionId, [entry(50), entry(51)]);
		const meta = path.join(
			tempDir,
			'.swarm',
			'trajectories',
			`${sessionId}.jsonl.meta.json`,
		);
		fs.writeFileSync(
			meta,
			JSON.stringify({
				version: 1,
				highestStep: 51,
				droppedEntries: 49,
				compactedAt: new Date().toISOString(),
			}) + '\n',
		);

		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.coverage).toBe('truncated');
		expect(read.droppedByCompaction).toBe(49);
		// readTrajectory (the entries-only API used by the corpus) is unchanged.
		expect(await readTrajectory(sessionId, tempDir)).toHaveLength(2);
	});

	test('corrupt and malformed lines are skipped and counted, never thrown', async () => {
		const sessionId = 'corrupt-tail';
		makeSessionFile(tempDir, sessionId, [
			entry(1),
			'not valid json',
			entry(2),
			'{"step":3', // torn final line (crash mid-write)
		]);

		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.entries.map((e) => e.step)).toEqual([1, 2]);
		expect(read.skippedMalformed).toBe(2);
		expect(read.coverage).toBe('complete'); // within window, no compaction
	});

	test('oversize lines are shed on read', async () => {
		const sessionId = 'oversize-lines';
		makeSessionFile(tempDir, sessionId, [
			entry(1),
			JSON.stringify({
				step: 2,
				blob: 'o'.repeat(TRAJECTORY_LIMITS.maxLineBytes + 1024),
			}),
			entry(3),
		]);

		const read = await readTrajectoryWithCoverage(sessionId, tempDir);
		expect(read.entries.map((e) => e.step)).toEqual([1, 3]);
		expect(read.skippedMalformed).toBe(1);
	});

	test('the checkpoint alone preserves step continuity when the data file is destroyed', async () => {
		const sessionId = 'data-destroyed';
		const file = makeSessionFile(tempDir, sessionId, [entry(1), entry(2)]);
		const meta = `${file}.meta.json`;
		fs.writeFileSync(
			meta,
			JSON.stringify({
				version: 1,
				highestStep: 2000,
				droppedEntries: 1998,
				compactedAt: new Date().toISOString(),
			}) + '\n',
		);
		// Every data line becomes corrupt (the fully-corrupt compaction case).
		fs.writeFileSync(file, 'garbage\nnot json either\n');

		expect(await getCurrentStep(sessionId, tempDir)).toBe(2000);
		expect(
			(await readTrajectoryCheckpoint(sessionId, tempDir))?.highestStep,
		).toBe(2000);
	});

	test('a checkpoint can never lower the high-water mark (merge takes max)', async () => {
		const sessionId = 'meta-lower';
		const file = makeSessionFile(tempDir, sessionId, [entry(10), entry(20)]);
		fs.writeFileSync(
			`${file}.meta.json`,
			JSON.stringify({
				version: 1,
				highestStep: 5, // stale/low checkpoint
				droppedEntries: 0,
				compactedAt: new Date().toISOString(),
			}) + '\n',
		);

		expect(await getCurrentStep(sessionId, tempDir)).toBe(20);
	});
});
