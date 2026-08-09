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

/**
 * Per-test budget for the async enumeration-timeout arm. It is the ONLY thing
 * that catches that arm's deadline being re-pointed at `gitTimeoutMs`, because
 * the async twin owns its deadline inside a `Promise.race` no stub can observe.
 * Named rather than inlined so the test body can assert the window it depends
 * on; see the sizing note at its use site.
 */
const ASYNC_DEADLINE_BUDGET_MS = 4000;

const original = {
	revisionEnumerationTimeoutMs: _internals.revisionEnumerationTimeoutMs,
	readChangedFileSync: _internals.readChangedFileSync,
	yieldControl: _internals.yieldControl,
	bunSpawn: _internals.bunSpawn,
	spawnSync: _internals.spawnSync,
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

/**
 * Stand-in for `_internals.spawnSync` that reproduces the `ETIMEDOUT` contract
 * `runGitDetailed` maps to `reason: 'timeout'`
 * (`src/background/workspace-snapshot.ts:229-234`, Node sets `error.code` to
 * `'ETIMEDOUT'` when the `timeout` option is exceeded), without racing a real
 * `spawnSync` deadline against a git process that usually enumerates a tiny
 * temp repo in well under 1ms on fast CI runners. That wall-clock race failed
 * all three attempts on PR #2080 and exhausted its retry budget, evicting it
 * from the merge queue.
 *
 * Discriminates on the git ARGS (`diff` / `status`), not on
 * `options.timeout === _internals.revisionEnumerationTimeoutMs` — the latter
 * breaks if `gitTimeoutMs` is ever set equal to the enumeration deadline. It
 * is PERSISTENT, not single-shot: the sync test invokes the digest twice
 * (`resolvePrWorkflowRevisionDigestDetailed`, then
 * `resolvePrWorkflowRevisionDigest`), and a `mockImplementationOnce`-style
 * stub would make the second call pass by falling through to the real
 * `spawnSync` instead of exercising the stubbed timeout. Every non-enumeration
 * call (`rev-parse --verify`) delegates to the real `spawnSync` captured
 * before the stub was installed, so head resolution still genuinely succeeds
 * and the fabricated failure stays pinned to path enumeration.
 *
 * Each enumeration call's `timeout` option is recorded into
 * `observedEnumerationTimeouts` so the caller can still pin which deadline the
 * enumeration was handed. Without that, replacing the real spawn removes the
 * only thing that bound these calls to `revisionEnumerationTimeoutMs` rather
 * than to `gitTimeoutMs`.
 *
 * Untested branches: the `ENOBUFS` -> `buffer-truncated` arm
 * (`src/background/workspace-snapshot.ts:248`) and the real Node `spawnSync`
 * `ETIMEDOUT` error-object contract itself, which this stub fabricates rather
 * than observes. Rationale: `buffer-truncated` is driven through a real
 * `spawnSync` against a real `ENOBUFS` error object in
 * `tests/unit/background/workspace-snapshot-digest-bounds.test.ts`, which keeps
 * the `result.error.code` extraction path verified against real runtime
 * behavior; the `ETIMEDOUT` code itself has no portable way to be provoked on a
 * bounded deadline without the wall-clock race this stub exists to remove.
 */
function spawnSyncWithEnumerationTimeout(
	realSpawnSync: typeof _internals.spawnSync,
	observedEnumerationTimeouts: Array<number | undefined>,
): typeof _internals.spawnSync {
	return ((command: string, args?: readonly string[], options?: unknown) => {
		const argv = args ?? [];
		const isEnumeration = argv.includes('diff') || argv.includes('status');
		if (!isEnumeration) {
			return (realSpawnSync as (...callArgs: unknown[]) => unknown)(
				command,
				args,
				options,
			);
		}
		observedEnumerationTimeouts.push(
			(options as { timeout?: number } | undefined)?.timeout,
		);
		const error = new Error('spawnSync ETIMEDOUT') as NodeJS.ErrnoException;
		error.code = 'ETIMEDOUT';
		return {
			pid: 0,
			output: [null, '', ''],
			stdout: '',
			stderr: '',
			status: null,
			signal: null,
			error,
		};
	}) as typeof _internals.spawnSync;
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
		_internals.spawnSync = original.spawnSync;
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
		// Asserting this by actually racing a 1ms `spawnSync` deadline against a
		// real git enumeration of this tiny temp repo was flaky: fast CI runners
		// finish enumeration in under 1ms, the digest succeeds, and the assertion
		// below never observes a timeout. PR #2080 hit exactly this race on all
		// three merge-queue attempts and was evicted after exhausting its retry
		// budget. Instead, the enumeration spawn is stubbed to return Node's
		// ETIMEDOUT `spawnSync` result directly — the same shape `runGitDetailed`
		// (src/background/workspace-snapshot.ts:229-234) documents mapping to
		// `reason: 'timeout'` — while `rev-parse --verify` still runs for real
		// via the captured original `spawnSync`, so head resolution still
		// genuinely succeeds and the failure stays pinned to enumeration.
		//
		// The value below is a SENTINEL, not a deadline: nothing waits on it now,
		// so it exists only to be observed. Replacing the real spawn would
		// otherwise drop the one thing that pinned enumeration to the enumeration
		// deadline — with the timeout unobserved, swapping both enumeration calls
		// to `gitTimeoutMs` still passes. A value no other seam holds makes that
		// swap fail on the assertion below.
		_internals.revisionEnumerationTimeoutMs = 4242;
		const observedEnumerationTimeouts: Array<number | undefined> = [];
		_internals.spawnSync = spawnSyncWithEnumerationTimeout(
			original.spawnSync,
			observedEnumerationTimeouts,
		);

		const detailed = resolvePrWorkflowRevisionDigestDetailed(directory, head);
		expect(detailed).toMatchObject({ ok: false, reason: 'timeout' });
		expect(detailed.ok === false && detailed.detail).toContain('timed out');
		// Not misreported as a broken worktree.
		expect(detailed).not.toMatchObject({ reason: 'git-failed' });
		// The enumeration call that ran was bounded by the enumeration deadline,
		// not by the `gitTimeoutMs` that governs `rev-parse --verify`. Only
		// `diff` runs: it fails first and the digest returns before reaching
		// `status`, so this observes one call, not both.
		expect(observedEnumerationTimeouts).not.toHaveLength(0);
		for (const observed of observedEnumerationTimeouts) {
			expect(observed).toBe(_internals.revisionEnumerationTimeoutMs);
		}
		// The stub is persistent (not single-shot), so this second, independent
		// call through the thin delegate exercises the same stubbed timeout
		// rather than falling through to the real, fast-finishing `spawnSync`.
		expect(resolvePrWorkflowRevisionDigest(directory, head)).toBeNull();
	});

	test(
		'async: a path enumeration that exceeds its deadline is reason "timeout"',
		async () => {
			// Same flakiness as the sync case above, on the async twin: a real
			// enumeration of this tiny temp repo can finish inside a 1ms deadline on
			// fast CI runners, so racing a real child process against the wall clock
			// is nondeterministic. `spawnWithHelperOwnedTimeout` (used verbatim from
			// the first test in this suite) is reused here for the reason documented
			// there: `runGitAsyncDetailed` deliberately omits `timeout` from its
			// spawn options, so the stubbed enumeration child never exits on its
			// own — the `Promise.race` deadline below is the sole resolver, making
			// `reason: 'timeout'` a deterministic lower bound rather than a race. If
			// `timeout` is ever re-added to those spawn options, the stub arms its
			// own kill timer, `exited` resolves 137, and the reason flips to
			// `git-failed` — so this still fails on the real #1968 defect.
			//
			// Distinct from the first test in this suite (which uses the same stub
			// and deadline): that test only pins the reason discriminator. This test
			// additionally pins that `detail` contains `'timed out'`, and that the
			// thin `resolvePrWorkflowRevisionDigestAsync` delegate collapses the
			// same failure to `null` — neither of which the first test asserts.
			//
			// The async twin owns its deadline inside a `Promise.race` the stub
			// cannot observe, so — unlike the sync twin, which pins the binding
			// directly by asserting the timeout its stub was handed — the only thing
			// that can catch these calls being re-pointed at `gitTimeoutMs` is the
			// per-test budget below. It must be set EXPLICITLY: CI does not run at
			// bun's 5s default. `scripts/ci/run-test-with-timeout.ts` DEFAULTS the
			// sharded unit job to `--timeout 120000` (injected only when the caller
			// passed no `--timeout` of its own), and the coverage gate's
			// per-file retry loop in `scripts/ci/run-coverage-gate.sh` (its two
			// `bun test --isolate --coverage --timeout 60000 "$test_file"`
			// invocations) uses `--timeout 60000` — either of which would swallow
			// the mutation silently. A per-test argument overrides the CLI value,
			// so this budget holds everywhere.
			//
			// Sizing: the body makes two sequential digest calls, so a re-point to
			// `gitTimeoutMs` costs 2 x `GIT_SNAPSHOT_TIMEOUT_MS` while the correct
			// wiring costs 2 x `revisionEnumerationTimeoutMs`. The budget must sit
			// between those, and the assertion below enforces the upper half of that
			// window rather than leaving it to this comment: a timing guard whose
			// window is only documented goes inert silently the moment someone
			// lowers the constant it depends on.
			_internals.revisionEnumerationTimeoutMs = 25;
			_internals.bunSpawn = spawnWithHelperOwnedTimeout(head);

			// If `GIT_SNAPSHOT_TIMEOUT_MS` ever drops far enough that a mis-pointed
			// deadline would finish INSIDE the budget, the budget stops discriminating
			// and must come down with it. Fail loudly here rather than silently
			// passing a test that no longer guards anything.
			expect(2 * _internals.gitTimeoutMs).toBeGreaterThan(
				ASYNC_DEADLINE_BUDGET_MS,
			);

			const detailed = await resolvePrWorkflowRevisionDigestDetailedAsync(
				directory,
				head,
			);
			expect(detailed).toMatchObject({ ok: false, reason: 'timeout' });
			expect(detailed.ok === false && detailed.detail).toContain('timed out');
			await expect(
				resolvePrWorkflowRevisionDigestAsync(directory, head),
			).resolves.toBeNull();
		},
		ASYNC_DEADLINE_BUDGET_MS,
	);

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
