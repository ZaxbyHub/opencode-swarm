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
import type {
	BunCompatSpawnOptions,
	BunCompatSubprocess,
} from '../../../src/utils/bun-compat';

/**
 * Issue #1968 acceptance criterion 6, the two reasons its own bounds suite left
 * unproduced: `timeout` and `read-failed`. Both are asserted on BOTH twins,
 * because the sync and async digests are independent implementations of the
 * same discriminated contract and a reason that only one of them can emit is a
 * message the other silently downgrades.
 *
 * `timeout` additionally pins the fix for a real defect: `runGitAsyncDetailed`
 * used to arm the spawn helper's timer AND its own on the same deadline, so a
 * timed-out enumeration was reported as `git-failed` — "Verify the checkout is
 * a healthy Git worktree" — whenever the spawn-side timer won the race.
 */

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

const original = {
	revisionEnumerationTimeoutMs: _internals.revisionEnumerationTimeoutMs,
	readChangedFileSync: _internals.readChangedFileSync,
	yieldControl: _internals.yieldControl,
	bunSpawn: _internals.bunSpawn,
};

/** A closed stream carrying `text`, in the shape `readBoundedGitOutput` reads. */
function fakeStream(text: string): BunCompatSubprocess['stdout'] {
	const encoded = new TextEncoder().encode(text);
	return {
		text: async () => text,
		bytes: async () => encoded,
		getReader: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					if (encoded.byteLength > 0) controller.enqueue(encoded);
					controller.close();
				},
			}).getReader(),
	};
}

/**
 * Stand-in for `bunSpawn` that reproduces the one contract detail the race
 * turned on: **when the caller passes `timeout`, the spawn helper arms its own
 * kill timer at that deadline** (`src/utils/bun-compat.ts` does exactly this
 * whenever `killProcessTree` is set, and delegates to the runtime's native
 * timeout otherwise). `rev-parse` always succeeds so the failure is pinned to a
 * path-enumeration call; the enumeration child never exits on its own.
 */
function spawnWithHelperOwnedTimeout(
	headSha: string,
): typeof _internals.bunSpawn {
	return ((cmd: string[], options?: BunCompatSpawnOptions) => {
		const isRevParse = cmd.includes('rev-parse');
		let settle: (code: number) => void = () => undefined;
		const exited = isRevParse
			? Promise.resolve(0)
			: new Promise<number>((resolve) => {
					settle = resolve;
				});
		if (!isRevParse && options?.timeout && options.timeout > 0) {
			// SIGKILL by the helper's own timer: the child is reaped and `exited`
			// resolves with a kill code, which the completion branch reads as a
			// plain non-zero exit.
			setTimeout(() => settle(137), options.timeout);
		}
		return {
			stdout: fakeStream(isRevParse ? `${headSha}\n` : ''),
			stderr: fakeStream(''),
			exited,
			exitCode: null,
			kill: () => settle(137),
		} satisfies BunCompatSubprocess;
	}) as typeof _internals.bunSpawn;
}

describe('revision digest timeout and read-failed reasons (issue #1968)', () => {
	let directory: string;
	let head: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'revision-digest-reasons-'),
		);
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		const resolved = resolveCurrentGitHead(directory);
		expect(resolved).not.toBeNull();
		head = resolved as string;
	});

	afterEach(() => {
		_internals.revisionEnumerationTimeoutMs =
			original.revisionEnumerationTimeoutMs;
		_internals.readChangedFileSync = original.readChangedFileSync;
		_internals.yieldControl = original.yieldControl;
		_internals.bunSpawn = original.bunSpawn;
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('async: the enumeration deadline has one owner, so a timeout is never reported as "git-failed"', async () => {
		_internals.revisionEnumerationTimeoutMs = 25;
		_internals.bunSpawn = spawnWithHelperOwnedTimeout(head);

		// Arming the deadline in BOTH places is what made the reported reason
		// depend on which of two equal-deadline timers fired first. The spawn
		// helper's timer is armed first (inside the spawn call, before the race
		// is constructed), so when it exists it wins: the child is reaped, the
		// completion branch sees a non-zero exit, and a timeout is reported as
		// "a bounded git enumeration failed ... Verify the checkout is a healthy
		// Git worktree". Passing no `timeout` to the spawn helper leaves the race
		// as the sole owner of the deadline, which is what this asserts.
		const detailed = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head,
		);
		expect(detailed).toMatchObject({ ok: false, reason: 'timeout' });
		expect(detailed).not.toMatchObject({ reason: 'git-failed' });
	});

	test('sync: a path enumeration that exceeds its deadline is reason "timeout"', () => {
		fs.writeFileSync(path.join(directory, 'changed.txt'), 'changed\n');
		// Only the ENUMERATION deadline is lowered; `gitTimeoutMs` still governs
		// the `rev-parse --verify` that runs first, so the base-head resolution
		// still succeeds and the timeout is pinned to a path-enumeration call.
		_internals.revisionEnumerationTimeoutMs = 1;

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head);
		expect(detailed).toMatchObject({ ok: false, reason: 'timeout' });
		expect(detailed.ok === false && detailed.detail).toContain('timed out');
		// Not misreported as a broken worktree.
		expect(detailed).not.toMatchObject({ reason: 'git-failed' });
		expect(resolvePrWorkflowRevisionDigest(directory, head)).toBeNull();
	});

	test('async: a path enumeration that exceeds its deadline is reason "timeout"', async () => {
		fs.writeFileSync(path.join(directory, 'changed.txt'), 'changed\n');
		_internals.revisionEnumerationTimeoutMs = 1;

		// Real git, real child process. Tearing down a killed process tree costs
		// hundreds of milliseconds on Windows, so this gets an explicit budget
		// rather than racing bun's 5s default.
		const detailed = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head,
		);
		expect(detailed).toMatchObject({ ok: false, reason: 'timeout' });
		expect(detailed.ok === false && detailed.detail).toContain('timed out');
		await expect(
			resolvePrWorkflowRevisionDigestAsync(directory, head),
		).resolves.toBeNull();
	}, 60_000);

	test('sync: a changed path whose content cannot be read is reason "read-failed"', () => {
		fs.writeFileSync(path.join(directory, 'unreadable.txt'), 'content\n');
		_internals.readChangedFileSync = () => {
			const error = new Error('permission denied') as NodeJS.ErrnoException;
			error.code = 'EACCES';
			throw error;
		};

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head);
		expect(detailed).toMatchObject({ ok: false, reason: 'read-failed' });
		expect(detailed.ok === false && detailed.detail).toContain(
			'read failed for unreadable.txt',
		);
		expect(resolvePrWorkflowRevisionDigest(directory, head)).toBeNull();
	});

	test('async: a changed path that shrinks mid-read is reason "read-failed"', async () => {
		// The async twin reads in bounded chunks and yields between them, so a
		// file that is truncated after `lstat` sized it reads short. No seam of
		// its own is needed: the existing `yieldControl` seam is the point at
		// which the file can change under the reader, which is exactly the
		// real-world race this arm exists for.
		const unstable = path.join(directory, 'unstable.bin');
		let truncated = false;
		// 2 MB is past the reader's first yield point (64 KB chunks, yielding
		// every 16), so the truncation lands mid-file with reads still to come.
		const arm = (): void => {
			fs.writeFileSync(unstable, Buffer.alloc(2 * 1024 * 1024, 'x'));
			truncated = false;
		};
		_internals.yieldControl = async () => {
			if (!truncated) {
				truncated = true;
				fs.truncateSync(unstable, 0);
			}
			await original.yieldControl();
		};

		arm();
		const detailed = await resolvePrWorkflowRevisionDigestDetailedAsync(
			directory,
			head,
		);
		expect(truncated).toBe(true);
		expect(detailed).toMatchObject({ ok: false, reason: 'read-failed' });
		expect(detailed.ok === false && detailed.detail).toContain('unstable.bin');

		// The legacy twin must collapse the same failure to `null`, never throw.
		arm();
		await expect(
			resolvePrWorkflowRevisionDigestAsync(directory, head),
		).resolves.toBeNull();
	});
});
