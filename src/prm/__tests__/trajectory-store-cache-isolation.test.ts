/**
 * Issue #2041 Required 6 — cache identity and eviction for multi-project
 * hosts. The in-memory trajectory cache is keyed by canonical root + session
 * id, so the same session id under two roots is isolated; junction/symlink
 * aliases of one root share one identity; FIFO eviction holds; and a
 * directory-less clear releases every root's entry for a session.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_test_exports,
	appendTrajectoryEntry,
	clearTrajectoryCache,
	getInMemoryTrajectory,
	readTrajectory,
} from '../trajectory-store';
import type { TrajectoryEntry } from '../types';

function createEntry(step: number): TrajectoryEntry {
	return {
		step,
		agent: 'coder',
		action: 'edit',
		target: 'src/a.ts',
		intent: 'isolation',
		timestamp: new Date().toISOString(),
		result: 'success',
	};
}

describe('trajectory-store cache isolation (issue #2041)', () => {
	let rootA: string;
	let rootB: string;

	beforeEach(() => {
		rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-iso-a-'));
		rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-iso-b-'));
		clearTrajectoryCache();
	});

	afterEach(() => {
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
	});

	test('the same session id under two roots keeps independent cache and disk state', async () => {
		const sessionId = 'ses-shared-id';

		await appendTrajectoryEntry(sessionId, createEntry(1), rootA, 1000);
		await appendTrajectoryEntry(sessionId, createEntry(1), rootB, 1000);
		await appendTrajectoryEntry(sessionId, createEntry(2), rootA, 1000);

		// Cache: root A saw two entries, root B one — no cross-contamination.
		expect(getInMemoryTrajectory(sessionId, rootA)).toHaveLength(2);
		expect(getInMemoryTrajectory(sessionId, rootB)).toHaveLength(1);

		// Disk: separate files under each root.
		expect(await readTrajectory(sessionId, rootA)).toHaveLength(2);
		expect(await readTrajectory(sessionId, rootB)).toHaveLength(1);
	});

	test('a junction/symlink alias of a root shares one cache identity', async () => {
		const sessionId = 'ses-alias';
		const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-iso-real-'));
		const alias = path.join(os.tmpdir(), `traj-alias-${Date.now()}`);
		// Junctions need no privileges on Windows; symlinks elsewhere.
		fs.symlinkSync(
			realRoot,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		try {
			await appendTrajectoryEntry(sessionId, createEntry(1), realRoot, 1000);
			await appendTrajectoryEntry(sessionId, createEntry(2), alias, 1000);

			// Both paths canonicalize to the same root: one file, two entries,
			// and either path's cache read sees the full window.
			expect(await readTrajectory(sessionId, realRoot)).toHaveLength(2);
			expect(getInMemoryTrajectory(sessionId, alias)).toHaveLength(2);
		} finally {
			// Best-effort alias cleanup: removing a Windows junction can EFAULT
			// under Bun's rm; the OS temp sweep handles any residue.
			try {
				fs.rmSync(alias, { recursive: true, force: true });
			} catch {
				/* temp-dir artifact */
			}
			fs.rmSync(realRoot, { recursive: true, force: true });
		}
	});

	test('clearTrajectoryCache(sessionId) releases every root for that session', async () => {
		const sessionId = 'ses-clear';

		await appendTrajectoryEntry(sessionId, createEntry(1), rootA, 1000);
		await appendTrajectoryEntry(sessionId, createEntry(1), rootB, 1000);
		expect(getInMemoryTrajectory(sessionId, rootA)).toHaveLength(1);
		expect(getInMemoryTrajectory(sessionId, rootB)).toHaveLength(1);

		clearTrajectoryCache(sessionId);

		expect(getInMemoryTrajectory(sessionId, rootA)).toEqual([]);
		expect(getInMemoryTrajectory(sessionId, rootB)).toEqual([]);
		// Disk files remain — the clear is a cache eviction, not a deletion.
		expect(await readTrajectory(sessionId, rootA)).toHaveLength(1);
	});

	test('FIFO eviction still holds under composite keys', async () => {
		const max = _test_exports.MAX_TRACKED_TRAJECTORY_SESSIONS;
		for (let i = 0; i <= max; i++) {
			await appendTrajectoryEntry(`evict-${i}`, createEntry(1), rootA, 1000);
		}
		expect(_test_exports.getCacheSize()).toBeLessThanOrEqual(max);
		expect(getInMemoryTrajectory('evict-0', rootA)).toEqual([]);
		expect(getInMemoryTrajectory(`evict-${max}`, rootA)).toHaveLength(1);
	});
});
