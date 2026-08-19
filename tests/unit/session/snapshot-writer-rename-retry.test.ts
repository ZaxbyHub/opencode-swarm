/**
 * Regression tests for the snapshot writer's atomic-swap rename retry.
 *
 * Previous code performed the swap with a bare `renameSync` inside a catch
 * that only logs, so a transient Windows sharing violation (EEXIST/EBUSY/
 * EPERM — an external reader or AV scanner briefly holding
 * .swarm/session/state.json open) silently dropped the snapshot update and
 * left the on-disk state stale. The writer now retries the rename with the
 * same codes/budget/delay as `bunWrite` (src/utils/bun-compat.ts:36 — except
 * this loop skips the sleep after the final attempt) and best-effort cleans
 * up the orphaned temp file when the rename fails permanently.
 *
 * The rename is intercepted through the module's `_internals.rename` DI seam
 * (Tier 1) — no `mock.module`, no cross-file pollution.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals,
	SNAPSHOT_RENAME_MAX_ATTEMPTS,
	type SnapshotData,
	writeSnapshot,
} from '../../../src/session/snapshot-writer';
import {
	_internals as artifactCacheInternals,
	readCachedTextFile,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let testDir: string;
const originalRename = _internals.rename;
const originalCacheStat = artifactCacheInternals.stat;

const emptyState = () => ({
	toolAggregates: new Map(),
	activeAgent: new Map(),
	delegationChains: new Map(),
	activeToolCalls: new Map(),
	pendingEvents: 0,
	agentSessions: new Map(),
});

const transientError = (code: string): NodeJS.ErrnoException => {
	const err: NodeJS.ErrnoException = new Error(
		`${code}: simulated transient rename failure`,
	);
	err.code = code;
	return err;
};

beforeEach(() => {
	// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap and
	// the Windows 8.3 short-name mismatch (FR-011, issue #1737).
	testDir = canonicalMkdtemp('snapshot-rename-retry-');
	resetSwarmArtifactCache();
});

afterEach(() => {
	_internals.rename = originalRename;
	artifactCacheInternals.stat = originalCacheStat;
	resetSwarmArtifactCache();
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

describe('writeSnapshot — regression: transient rename failure must not drop the snapshot (bun-compat parity)', () => {
	const sessionDir = () => path.join(testDir, '.swarm', 'session');
	const statePath = () => path.join(sessionDir(), 'state.json');

	it.each([
		'EEXIST',
		'EBUSY',
		'EPERM',
	])('retries %s and eventually completes the atomic swap', async (code) => {
		let calls = 0;
		_internals.rename = mock(async (oldPath: string, newPath: string) => {
			calls++;
			// Fail every attempt but the last so the test exercises the full
			// retry budget rather than a single lucky retry.
			if (calls < SNAPSHOT_RENAME_MAX_ATTEMPTS) {
				throw transientError(code);
			}
			return originalRename(oldPath, newPath);
		});

		await writeSnapshot(testDir, emptyState());

		expect(calls).toBe(SNAPSHOT_RENAME_MAX_ATTEMPTS);
		expect(existsSync(statePath())).toBe(true);
		const parsed = JSON.parse(
			await Bun.file(statePath()).text(),
		) as SnapshotData;
		expect(parsed.version).toBe(3);
		// The successful swap consumed the temp file — nothing left behind.
		expect(
			readdirSync(sessionDir()).filter((f) => f.includes('.tmp.')),
		).toEqual([]);
	});

	it('gives up after the retry budget on a persistent transient code and removes the temp file', async () => {
		let calls = 0;
		_internals.rename = mock(async () => {
			calls++;
			throw transientError('EBUSY');
		});

		// Still swallows the error (never crash the plugin)...
		await expect(writeSnapshot(testDir, emptyState())).resolves.toBeUndefined();

		// ...but only after exhausting the full retry budget.
		expect(calls).toBe(SNAPSHOT_RENAME_MAX_ATTEMPTS);
		expect(existsSync(statePath())).toBe(false);
		// Permanent failure must not litter .swarm/session with temp files.
		expect(
			readdirSync(sessionDir()).filter((f) => f.includes('.tmp.')),
		).toEqual([]);
	});

	it('treats ENOENT on a retry as the spurious-failure success it is, so the cache is still invalidated', async () => {
		// Windows can report a sharing violation for a rename that actually
		// committed; the retry then finds the temp already gone. Reporting that
		// as a failure would skip invalidateCachedArtifact for a file that
		// really did change — the exact stale cached read issue #1729 guards
		// against.
		//
		// The assertion has to be the cache entry, not the file: on this path
		// the snapshot lands on disk either way, so asserting file contents
		// would pass with or without the fix. Same frozen-stat technique as
		// tests/unit/utils/swarm-write-cache-invalidation-wiring.test.ts —
		// under a frozen stamp the cache can only miss if the entry was
		// dropped, so a directRead the file never contains proves invalidation.
		mkdirSync(sessionDir(), { recursive: true });
		writeFileSync(statePath(), 'OLD SNAPSHOT', 'utf-8');
		const primed = await readCachedTextFile(statePath(), async () =>
			readFileSync(statePath(), 'utf-8'),
		);
		expect(primed).toBe('OLD SNAPSHOT');
		const frozenStat = await fsp.stat(statePath());
		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		let calls = 0;
		_internals.rename = mock(async (oldPath: string, newPath: string) => {
			calls++;
			if (calls === 1) {
				// The move lands despite the reported sharing violation.
				await originalRename(oldPath, newPath);
				throw transientError('EPERM');
			}
			// The real filesystem now fails this way: the source is gone.
			throw transientError('ENOENT');
		});

		await writeSnapshot(testDir, emptyState());

		expect(calls).toBe(2);
		const second = await readCachedTextFile(statePath(), async () => 'FRESH');
		expect(second).toBe('FRESH');
	});

	it('does not retry a non-transient rename error', async () => {
		let calls = 0;
		_internals.rename = mock(async () => {
			calls++;
			throw transientError('EACCES');
		});

		await expect(writeSnapshot(testDir, emptyState())).resolves.toBeUndefined();

		expect(calls).toBe(1);
		expect(existsSync(statePath())).toBe(false);
		expect(
			readdirSync(sessionDir()).filter((f) => f.includes('.tmp.')),
		).toEqual([]);
	});
});
