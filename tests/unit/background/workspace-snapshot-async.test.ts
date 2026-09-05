/**
 * Async workspace-snapshot twin + digest-skip predicate (issue #2472 W7 / AC-8).
 *
 * Contracts pinned here:
 *   - `captureWorkspaceSnapshotAsync` produces the same snapshot shape (and the
 *     same degraded-failure shape) as the sync twin on a real small git repo.
 *   - `shouldSkipSnapshot` answers true only for the digest of the LAST
 *     persisted snapshot (the `.swarm`-contained marker), false for a changed
 *     digest, a missing marker, or a malformed candidate digest.
 *   - The digest marker lives ONLY under `<root>/.swarm/` (containment).
 *
 * The async twin is exercised against a real temp git repository — the point of
 * W7 is replacing a real sync spawn with a real bounded async spawn on the hook
 * path, so no spawn seams are mocked here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	captureWorkspaceSnapshot,
	captureWorkspaceSnapshotAsync,
	digest,
	shouldSkipSnapshot,
} from '../../../src/background/workspace-snapshot';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git ${args.join(' ')} failed`,
		);
	}
}

/** Content digest formula shared with the module's persist path. */
function contentDigestOf(snapshot: {
	gitHead: string | null;
	dirtyHash: string | null;
}): string {
	expect(snapshot.gitHead).not.toBeNull();
	expect(snapshot.dirtyHash).not.toBeNull();
	return digest(`${snapshot.gitHead}\n${snapshot.dirtyHash}`);
}

describe('issue #2472 W7 — captureWorkspaceSnapshotAsync', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('ws-snapshot-async-');
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('returns the same snapshot as the sync twin on a clean repo', async () => {
		const syncSnapshot = captureWorkspaceSnapshot(directory);
		const asyncSnapshot = await captureWorkspaceSnapshotAsync(directory);
		expect(asyncSnapshot).toEqual(syncSnapshot);
		expect(asyncSnapshot.gitHead).not.toBeNull();
		expect(asyncSnapshot.dirtyHash).not.toBeNull();
		expect(asyncSnapshot.changedFiles).toEqual([]);
	});

	test('returns the same snapshot as the sync twin on a dirty repo', async () => {
		fs.writeFileSync(path.join(directory, 'src-new.ts'), 'export {}\n');
		const syncSnapshot = captureWorkspaceSnapshot(directory);
		const asyncSnapshot = await captureWorkspaceSnapshotAsync(directory);
		expect(asyncSnapshot).toEqual(syncSnapshot);
		expect(asyncSnapshot.changedFiles).toEqual(['src-new.ts']);
	});

	test('honours the options object and the string-scope overload like the sync twin', async () => {
		const syncWithOptions = captureWorkspaceSnapshot(directory, {
			prHeadSha: 'abc123',
			scope: 'task-1.1',
		});
		const asyncWithOptions = await captureWorkspaceSnapshotAsync(directory, {
			prHeadSha: 'abc123',
			scope: 'task-1.1',
		});
		expect(asyncWithOptions).toEqual(syncWithOptions);
		expect(asyncWithOptions.prHeadSha).toBe('abc123');
		expect(asyncWithOptions.scope).toBe('task-1.1');

		const asyncWithScopeString = await captureWorkspaceSnapshotAsync(
			directory,
			'task-2.1',
		);
		expect(asyncWithScopeString.scope).toBe('task-2.1');
		expect(asyncWithScopeString.prHeadSha).toBeNull();
	});

	test('degrades identically to the sync twin outside a git repository', async () => {
		const plain = canonicalMkdtemp('ws-snapshot-async-nogit-');
		try {
			const syncSnapshot = captureWorkspaceSnapshot(plain);
			const asyncSnapshot = await captureWorkspaceSnapshotAsync(plain);
			expect(asyncSnapshot).toEqual(syncSnapshot);
			expect(asyncSnapshot.gitHead).toBeNull();
			expect(asyncSnapshot.dirtyHash).toBeNull();
			expect(asyncSnapshot.changedFiles).toBeNull();
		} finally {
			fs.rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe('issue #2472 W7 — shouldSkipSnapshot digest marker', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('ws-snapshot-digest-');
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('false before any async capture (no marker), true for the persisted digest after', async () => {
		const current = captureWorkspaceSnapshot(directory);
		const currentDigest = contentDigestOf(current);
		expect(shouldSkipSnapshot(directory, currentDigest)).toBe(false);

		await captureWorkspaceSnapshotAsync(directory);
		expect(shouldSkipSnapshot(directory, currentDigest)).toBe(true);
	});

	test('false for a changed digest, and flips when the workspace content changes', async () => {
		await captureWorkspaceSnapshotAsync(directory);
		const cleanDigest = contentDigestOf(captureWorkspaceSnapshot(directory));
		expect(shouldSkipSnapshot(directory, cleanDigest)).toBe(true);
		expect(shouldSkipSnapshot(directory, 'a'.repeat(64))).toBe(false);

		// New uncommitted content → new dirtyHash → new persisted digest.
		fs.writeFileSync(path.join(directory, 'changed.txt'), 'changed\n');
		await captureWorkspaceSnapshotAsync(directory);
		expect(shouldSkipSnapshot(directory, cleanDigest)).toBe(false);
		const dirtyDigest = contentDigestOf(captureWorkspaceSnapshot(directory));
		expect(shouldSkipSnapshot(directory, dirtyDigest)).toBe(true);
	});

	test('fails open (false) for malformed candidate digests and unreadable markers', async () => {
		await captureWorkspaceSnapshotAsync(directory);
		expect(shouldSkipSnapshot(directory, '')).toBe(false);
		expect(shouldSkipSnapshot(directory, 'not-a-digest')).toBe(false);
		expect(shouldSkipSnapshot(directory, 'A'.repeat(64))).toBe(false); // uppercase hex rejected

		// A directory with no `.swarm` at all must fail open, never throw.
		const bare = canonicalMkdtemp('ws-snapshot-digest-bare-');
		try {
			expect(shouldSkipSnapshot(bare, 'b'.repeat(64))).toBe(false);
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});

	test('the digest marker lives ONLY under .swarm and holds the content digest', async () => {
		await captureWorkspaceSnapshotAsync(directory);

		const markerPath = path.join(
			directory,
			'.swarm',
			'workspace-snapshot.digest',
		);
		expect(fs.existsSync(markerPath)).toBe(true);
		// No marker leaked to the repository root or anywhere outside .swarm.
		expect(
			fs.existsSync(path.join(directory, 'workspace-snapshot.digest')),
		).toBe(false);

		const stored = fs.readFileSync(markerPath, 'utf-8').trim();
		expect(stored).toBe(contentDigestOf(captureWorkspaceSnapshot(directory)));
	});

	test('a moved HEAD changes the content digest (gitHead participates in identity)', async () => {
		await captureWorkspaceSnapshotAsync(directory);
		const before = contentDigestOf(captureWorkspaceSnapshot(directory));

		fs.writeFileSync(path.join(directory, 'second.txt'), 'second\n');
		git(directory, ['add', 'second.txt']);
		git(directory, ['commit', '-m', 'test: move HEAD']);

		await captureWorkspaceSnapshotAsync(directory);
		const after = contentDigestOf(captureWorkspaceSnapshot(directory));
		expect(after).not.toBe(before);
		expect(shouldSkipSnapshot(directory, before)).toBe(false);
		expect(shouldSkipSnapshot(directory, after)).toBe(true);
	});
});
