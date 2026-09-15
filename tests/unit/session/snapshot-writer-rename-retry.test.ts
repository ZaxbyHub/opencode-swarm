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
	writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ensureSnapshotCoordinationReady } from '../../../src/session/snapshot-coordination-init';
import {
	_internals,
	SNAPSHOT_PROJECTION_FILE,
	SNAPSHOT_RENAME_MAX_ATTEMPTS,
	type SnapshotData,
	writeSnapshot,
	writeSnapshotProjection,
} from '../../../src/session/snapshot-writer';
import {
	_internals as artifactCacheInternals,
	readCachedTextFile,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
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
		safeRmRecursive(testDir);
	}
});

describe('writeSnapshot — regression: transient rename failure must not drop the snapshot (bun-compat parity)', () => {
	const sessionDir = () => path.join(testDir, '.swarm', 'session');
	const statePath = () =>
		path.join(testDir, '.swarm', SNAPSHOT_PROJECTION_FILE);

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

	it('treats ENOENT after a retry commits as success, so the cache is still invalidated', async () => {
		// Windows can report a transient failure before the swap, then report
		// ENOENT for the retry that actually commits. Reporting that second
		// result as a failure would skip invalidateCachedArtifact for a file
		// that really did change — the exact stale cached read issue #1729 guards
		// against. A commit followed by EPERM on the first attempt is covered
		// separately below.
		//
		// The assertion has to be the cache entry, not the file: on this path
		// the snapshot lands on disk either way, so asserting file contents
		// would pass with or without the fix. Same frozen-stat technique as
		// tests/unit/utils/swarm-write-cache-invalidation-wiring.test.ts —
		// under a frozen stamp the cache can only miss if the entry was
		// dropped, so a directRead the file never contains proves invalidation.
		mkdirSync(sessionDir(), { recursive: true });
		// Warm the per-directory coordination entry before intercepting the
		// projection rename; initialization has its own projection write and is
		// outside this retry unit's call-count contract.
		await ensureSnapshotCoordinationReady(testDir);
		const oldSnapshot: SnapshotData = {
			version: 3,
			writtenAt: 1_700_000_000_000,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};
		const oldSnapshotText = JSON.stringify(oldSnapshot);
		writeFileSync(statePath(), oldSnapshotText, 'utf-8');
		const primed = await readCachedTextFile(statePath(), async () =>
			readFileSync(statePath(), 'utf-8'),
		);
		expect(primed).toBe(oldSnapshotText);
		const frozenStat = await fsp.stat(statePath());
		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		let calls = 0;
		_internals.rename = mock(async (oldPath: string, newPath: string) => {
			calls++;
			if (calls === 1) {
				throw transientError('EPERM');
			}
			// The move lands despite the reported missing source on retry.
			await originalRename(oldPath, newPath);
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

	it('re-checks authority inside a delayed async rename adapter before the atomic swap', async () => {
		mkdirSync(sessionDir(), { recursive: true });
		const oldSnapshot: SnapshotData = {
			version: 3,
			writtenAt: 1_700_000_000_000,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};
		const oldSnapshotText = JSON.stringify(oldSnapshot);
		writeFileSync(statePath(), oldSnapshotText, 'utf8');
		const primed = await readCachedTextFile(statePath(), async () =>
			readFileSync(statePath(), 'utf8'),
		);
		expect(primed).toBe(oldSnapshotText);
		const frozenStat = await fsp.stat(statePath());
		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		let allowCommit = true;
		let renameCalls = 0;
		let releaseRename!: () => void;
		const renameEntered = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		let renameStarted!: () => void;
		const renameStartedPromise = new Promise<void>((resolve) => {
			renameStarted = resolve;
		});
		_internals.rename = mock(
			async (
				oldPath: string,
				newPath: string,
				shouldCommit?: () => boolean,
			) => {
				renameCalls++;
				renameStarted();
				await renameEntered;
				if (shouldCommit && !shouldCommit()) return;
				return originalRename(oldPath, newPath);
			},
		);

		const nextSnapshot: SnapshotData = {
			...oldSnapshot,
			writtenAt: 1_700_000_001_000,
		};
		const writing = writeSnapshotProjection(
			testDir,
			nextSnapshot,
			() => allowCommit,
		);
		await renameStartedPromise;
		allowCommit = false;
		releaseRename();
		await writing;

		expect(renameCalls).toBe(1);
		expect(readFileSync(statePath(), 'utf8')).toBe(oldSnapshotText);
		let directReads = 0;
		const observed = await readCachedTextFile(statePath(), async () => {
			directReads++;
			return readFileSync(statePath(), 'utf8');
		});
		expect(observed).toBe(oldSnapshotText);
		// A declined write leaves the warmed cache intact; invalidating it would
		// turn this into an unnecessary direct read even though the file is old.
		expect(directReads).toBe(0);
		expect(
			readdirSync(sessionDir()).filter((f) => f.includes('.tmp.')),
		).toEqual([]);
	});

	it('invalidates cache when Windows reports a transient error after the rename commits, even if authority changes before retry', async () => {
		mkdirSync(sessionDir(), { recursive: true });
		const oldSnapshot: SnapshotData = {
			version: 3,
			writtenAt: 1_700_000_000_000,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};
		const oldSnapshotText = JSON.stringify(oldSnapshot);
		writeFileSync(statePath(), oldSnapshotText, 'utf8');
		const primed = await readCachedTextFile(statePath(), async () =>
			readFileSync(statePath(), 'utf8'),
		);
		expect(primed).toBe(oldSnapshotText);
		const frozenStat = await fsp.stat(statePath());
		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		let allowCommit = true;
		let renameCalls = 0;
		let reportFailure!: () => void;
		const failureReleased = new Promise<void>((resolve) => {
			reportFailure = resolve;
		});
		let signalCommitted!: () => void;
		const committed = new Promise<void>((resolve) => {
			signalCommitted = resolve;
		});
		_internals.rename = mock(async (oldPath: string, newPath: string) => {
			renameCalls++;
			await originalRename(oldPath, newPath);
			signalCommitted();
			await failureReleased;
			throw transientError('EPERM');
		});

		const nextSnapshot: SnapshotData = {
			...oldSnapshot,
			writtenAt: 1_700_000_001_000,
		};
		const writing = writeSnapshotProjection(
			testDir,
			nextSnapshot,
			() => allowCommit,
		);
		await committed;
		// Model a newer writer superseding this operation after Windows has
		// moved the file but before the adapter reports its transient error.
		allowCommit = false;
		reportFailure();
		await writing;

		expect(renameCalls).toBe(1);
		let directReads = 0;
		const observed = await readCachedTextFile(statePath(), async () => {
			directReads++;
			return readFileSync(statePath(), 'utf8');
		});
		expect(directReads).toBe(1);
		expect((JSON.parse(observed ?? 'null') as SnapshotData).writtenAt).toBe(
			nextSnapshot.writtenAt,
		);
		expect(
			readdirSync(sessionDir()).filter((f) => f.includes('.tmp.')),
		).toEqual([]);
	});
});
