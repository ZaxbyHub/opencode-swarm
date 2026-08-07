import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	resolveCurrentGitHead,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
	resolvePrWorkflowRevisionDigestDetailed,
	resolvePrWorkflowRevisionDigestDetailedAsync,
} from '../../../src/background/workspace-snapshot';

// issue #1968 P6 — the digest caps stop being a dead end: this file proves
// the discriminated `RevisionDigestResult` reasons are actually produced and
// distinguishable, and that the pre-existing sync/async twins stay
// byte-for-byte backward compatible (`null` on any failure, never a throw).

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git ${args.join(' ')} failed`,
		);
	}
}

const original = {
	revisionMaxFiles: _internals.revisionMaxFiles,
	revisionMaxTotalBytes: _internals.revisionMaxTotalBytes,
	gitSnapshotMaxBuffer: _internals.gitSnapshotMaxBuffer,
	revisionEnumerationTimeoutMs: _internals.revisionEnumerationTimeoutMs,
	spawnSync: _internals.spawnSync,
};

describe('revision digest bounds (issue #1968 P6)', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'revision-digest-bounds-'),
		);
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
		_internals.revisionMaxFiles = original.revisionMaxFiles;
		_internals.revisionMaxTotalBytes = original.revisionMaxTotalBytes;
		_internals.gitSnapshotMaxBuffer = original.gitSnapshotMaxBuffer;
		_internals.revisionEnumerationTimeoutMs =
			original.revisionEnumerationTimeoutMs;
		_internals.spawnSync = original.spawnSync;
	});

	test('happy path: detailed ok+digest equals the legacy sync/async strings', async () => {
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		fs.writeFileSync(path.join(directory, 'base.txt'), 'edited\n');

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head!);
		const legacy = resolvePrWorkflowRevisionDigest(directory, head!);
		expect(detailed).toEqual({ ok: true, digest: expect.any(String) });
		expect(detailed.ok && detailed.digest).toBe(legacy!);

		const detailedAsync = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head!,
		);
		const legacyAsync = await resolvePrWorkflowRevisionDigestAsync(
			directory,
			head!,
		);
		expect(detailedAsync).toEqual({ ok: true, digest: expect.any(String) });
		expect(detailedAsync.ok && detailedAsync.digest).toBe(legacyAsync!);

		// Sync and async twins agree on the same repo state.
		expect(detailedAsync.ok && detailed.ok && detailedAsync.digest).toBe(
			detailed.ok ? detailed.digest : undefined,
		);
	});

	test('file-cap: too many changed paths is reason "file-cap", distinguishable from other bounds', async () => {
		_internals.revisionMaxFiles = 1;
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		fs.writeFileSync(path.join(directory, 'untracked-a.txt'), 'a\n');
		fs.writeFileSync(path.join(directory, 'untracked-b.txt'), 'b\n');

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head!);
		expect(detailed).toMatchObject({ ok: false, reason: 'file-cap' });
		expect(resolvePrWorkflowRevisionDigest(directory, head!)).toBeNull();

		const detailedAsync = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head!,
		);
		expect(detailedAsync).toMatchObject({ ok: false, reason: 'file-cap' });
		await expect(
			resolvePrWorkflowRevisionDigestAsync(directory, head!),
		).resolves.toBeNull();
	});

	test('byte-cap: content exceeding the total-bytes bound is reason "byte-cap"', async () => {
		_internals.revisionMaxTotalBytes = 10;
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		fs.writeFileSync(
			path.join(directory, 'base.txt'),
			Buffer.alloc(1_000, 'x'),
		);

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head!);
		expect(detailed).toMatchObject({ ok: false, reason: 'byte-cap' });
		expect(resolvePrWorkflowRevisionDigest(directory, head!)).toBeNull();

		const detailedAsync = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head!,
		);
		expect(detailedAsync).toMatchObject({ ok: false, reason: 'byte-cap' });
		await expect(
			resolvePrWorkflowRevisionDigestAsync(directory, head!),
		).resolves.toBeNull();
	});

	test('buffer-truncated: an oversized enumeration call is reason "buffer-truncated", not "file-cap"', async () => {
		// A real `rev-parse --verify` hash line is ~41 bytes (40 hex chars + \n).
		// 100 bytes comfortably fits that single call but not the untracked-file
		// `status --porcelain -z` enumeration created below (untracked files
		// never appear in `diff --name-only` output), so the overflow is pinned
		// to a real path-enumeration call, not baseHead.
		_internals.gitSnapshotMaxBuffer = 100;
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		for (let index = 0; index < 10; index++) {
			fs.writeFileSync(
				path.join(directory, `long-enough-file-name-${index}.txt`),
				`content ${index}\n`,
			);
		}

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head!);
		expect(detailed).toMatchObject({ ok: false, reason: 'buffer-truncated' });
		// Reason must be distinguishable from a mere cap — the whole point of
		// this change (05-fix-plan.md P6.2).
		expect(detailed).not.toMatchObject({ reason: 'file-cap' });
		expect(resolvePrWorkflowRevisionDigest(directory, head!)).toBeNull();

		const detailedAsync = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head!,
		);
		expect(detailedAsync).toMatchObject({
			ok: false,
			reason: 'buffer-truncated',
		});
		await expect(
			resolvePrWorkflowRevisionDigestAsync(directory, head!),
		).resolves.toBeNull();
	});

	test('git-failed: a base revision that cannot be verified is reason "git-failed"', async () => {
		const nonExistentSha = '0'.repeat(40);

		const detailed = resolvePrWorkflowRevisionDigestDetailed(
			directory,
			nonExistentSha,
		);
		expect(detailed).toMatchObject({ ok: false, reason: 'git-failed' });
		expect(
			resolvePrWorkflowRevisionDigest(directory, nonExistentSha),
		).toBeNull();

		const detailedAsync = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			nonExistentSha,
		);
		expect(detailedAsync).toMatchObject({ ok: false, reason: 'git-failed' });
		await expect(
			resolvePrWorkflowRevisionDigestAsync(directory, nonExistentSha),
		).resolves.toBeNull();
	});

	test('containment: a path resolving outside the project root is reason "containment"', () => {
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();

		_internals.spawnSync = ((_command, args) => {
			const joined = args.join(' ');
			if (joined.includes('rev-parse')) {
				return {
					status: 0,
					signal: null,
					pid: 1,
					output: [],
					stdout: `${head}\n`,
					stderr: '',
				};
			}
			if (joined.includes('diff')) {
				return {
					status: 0,
					signal: null,
					pid: 1,
					output: [],
					// Escapes the project root; real Git never emits this, but the
					// digest must fail closed rather than hash outside the repo.
					stdout: '../outside.txt\0',
					stderr: '',
				};
			}
			return {
				status: 0,
				signal: null,
				pid: 1,
				output: [],
				stdout: '',
				stderr: '',
			};
		}) as typeof _internals.spawnSync;

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head!);
		expect(detailed).toMatchObject({ ok: false, reason: 'containment' });
		expect(resolvePrWorkflowRevisionDigest(directory, head!)).toBeNull();
	});
});
