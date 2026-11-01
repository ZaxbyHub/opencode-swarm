// #2969 (SIB3-1): writePersisted resilience — the tmp→canonical rename rides
// the shared bounded-retry helper and a failed persist never leaks the temp
// file. Retry arms inject through atomic-write's `_internals.renameSync` (the
// REAL retry loop stays live); the terminal-cleanup arm stubs the site seam.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _internals as fullAutoInternals } from '../../../src/full-auto/state.js';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const STATE_FILE = 'full-auto-state.json';

function persistedFixture() {
	return { version: 2, updatedAt: '2026-10-31T00:00:00.000Z', sessions: {} };
}

function swarmDir(dir: string): string {
	return join(dir, '.swarm');
}

function tmpArtifacts(dir: string): string[] {
	const sd = swarmDir(dir);
	if (!existsSync(sd)) return [];
	return readdirSync(sd).filter((n) => n.startsWith(`${STATE_FILE}.tmp`));
}

describe('full-auto state write resilience (#2969, SIB3-1)', () => {
	const realRename = atomicWriteInternals.renameSync;
	const realSiteRename = fullAutoInternals.renameWithRetry;

	afterEach(() => {
		atomicWriteInternals.renameSync = realRename;
		fullAutoInternals.renameWithRetry = realSiteRename;
	});

	test('transient EPERM x2 on the rename is retried by the REAL shared loop and the state persists', () => {
		const dir = canonicalMkdtemp('fa-write-2969-');
		let calls = 0;
		atomicWriteInternals.renameSync = ((from: string, to: string) => {
			calls += 1;
			if (calls <= 2) {
				const err = new Error(
					'EPERM (test): transient AV hold',
				) as never as NodeJS.ErrnoException;
				(err as { code?: string }).code = 'EPERM';
				throw err;
			}
			return realRename(from, to);
		}) as typeof realRename;

		fullAutoInternals.writePersisted(dir, persistedFixture());

		expect(calls).toBe(3);
		const onDisk = JSON.parse(
			readFileSync(join(swarmDir(dir), STATE_FILE), 'utf-8'),
		);
		expect(onDisk.version).toBe(2);
		expect(tmpArtifacts(dir)).toEqual([]);
	});

	test('permanent rename failure throws AND unlinks the temp file', () => {
		const dir = canonicalMkdtemp('fa-write-2969-');
		// Feedback PRR-019: the terminal arm drives the REAL shared retry
		// helper to exhaustion through the atomic-write fs seam (the old
		// site-seam stub never executed the helper's throw-after-budget
		// contract). The full default schedule (385 ms of sync sleeps) is
		// fine on this non-emit path.
		atomicWriteInternals.renameSync = (() => {
			const err = new Error(
				'EBUSY (test): permanent',
			) as never as NodeJS.ErrnoException;
			(err as { code?: string }).code = 'EBUSY';
			throw err;
		}) as typeof realRename;
		fullAutoInternals.renameWithRetry = realSiteRename;

		expect(() =>
			fullAutoInternals.writePersisted(dir, persistedFixture()),
		).toThrow('Full-Auto state persistence failed');
		// The load-bearing SIB3-1 cleanup: no temp artifact survives a failed
		// persist (the .bak best-effort may exist when a canonical did, but a
		// fresh dir has no canonical, so nothing else may remain).
		expect(tmpArtifacts(dir)).toEqual([]);
		// Feedback PRR-020: the no-clobber invariant is ASSERTED — the failed
		// persist must not have (non-atomically) placed a canonical file.
		expect(existsSync(join(swarmDir(dir), STATE_FILE))).toBe(false);
		expect(existsSync(join(swarmDir(dir), `${STATE_FILE}.bak`))).toBe(false);
	});

	test('non-retryable errors fail fast: the real loop rethrows immediately without extra attempts', () => {
		const dir = canonicalMkdtemp('fa-write-2969-');
		let calls = 0;
		atomicWriteInternals.renameSync = ((from: string, to: string) => {
			calls += 1;
			const err = new Error('ENOENT (test)') as never as NodeJS.ErrnoException;
			(err as { code?: string }).code = 'ENOENT';
			throw err;
		}) as typeof realRename;

		fullAutoInternals.renameWithRetry = realSiteRename;
		expect(() =>
			fullAutoInternals.writePersisted(dir, persistedFixture()),
		).toThrow('Full-Auto state persistence failed');
		expect(calls).toBe(1);
		expect(tmpArtifacts(dir)).toEqual([]);
	});
});
