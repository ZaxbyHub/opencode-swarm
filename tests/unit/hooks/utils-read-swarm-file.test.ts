/**
 * Retry-behavior tests for `readSwarmFileAsync` (issue #1782, amended by
 * issue #2472 W3 / PERF-1).
 *
 * The function historically retried only ENOENT (5 × 10ms). On Windows CI,
 * AV/indexing of a freshly-written `.swarm/plan.json` can raise EBUSY/EPERM/
 * EACCES, which returned null on the first attempt — propagating up through
 * `loadPlanJsonOnly` to `resolveEvidenceTaskId`, which then fell through to
 * the stale session fallback (the delegation-gate-resolve-task-id.test.ts
 * merge-group flake in run 29854486821).
 *
 * The #1782 fix extended the retry set to include EBUSY/EPERM/EACCES with
 * exponential backoff (10/20/40/80/160ms across 6 attempts). Issue #2472 W3
 * then split ENOENT by EVIDENCE (three-way policy): an ENOENT retries the
 * cheap 5 × 10ms budget ONLY when this process recently wrote the file
 * (`wasRecentlyWrittenByThisProcess` — the transient-ENOENT fixture below
 * writes through the canonical atomic writer to record that intent) or the
 * artifact cache previously observed it to exist; an ENOENT on a file that
 * plausibly never existed returns null on the FIRST attempt with zero sleeps
 * (plan-less projects were paying 4 × 10ms per missing-file read, ~1.9s/turn).
 *
 * Uses the existing `_internals` seam (src/hooks/utils.ts) per AGENTS.md
 * invariant 7 (DI over `mock.module`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { _internals, readSwarmFileAsync } from '../../../src/hooks/utils';
import { resetSwarmState } from '../../../src/state';
import { atomicWriteSwarmFileSync } from '../../../src/utils/atomic-write';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realReadCachedTextFile = _internals.readCachedTextFile;

afterEach(() => {
	_internals.readCachedTextFile = realReadCachedTextFile;
	resetSwarmState();
});

function errno(code: string, message: string): NodeJS.ErrnoException {
	const err = new Error(message) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

function rmSyncHardened(target: string): void {
	// Windows AV can briefly hold a handle on a freshly-read file; use the
	// same retry hardening pattern as the production code under test.
	fs.rmSync(target, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
}

describe('readSwarmFileAsync retry behavior (issue #1782)', () => {
	test('retries EBUSY and returns content once the transient error clears', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readswarm-ebusy-'));
		try {
			fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(tmp, '.swarm', 'plan.json'), '{"ok":true}');

			let calls = 0;
			// Throw EBUSY on attempts 1 and 2, succeed on attempt 3.
			_internals.readCachedTextFile = ((
				_resolvedPath: string,
				reader: () => Promise<string>,
			) => {
				calls++;
				if (calls < 3) {
					throw errno('EBUSY', 'resource busy or locked');
				}
				return reader();
			}) as typeof _internals.readCachedTextFile;

			const result = await readSwarmFileAsync(tmp, 'plan.json');
			expect(result).toBe('{"ok":true}');
			expect(calls).toBe(3);
		} finally {
			rmSyncHardened(tmp);
		}
	});

	test('retries EPERM and EACCES the same way as EBUSY', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readswarm-eperm-'));
		try {
			fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(tmp, '.swarm', 'plan.json'), '{"ok":true}');

			const codes = ['EPERM', 'EACCES', 'EBUSY'];
			let i = 0;
			_internals.readCachedTextFile = ((
				_resolvedPath: string,
				reader: () => Promise<string>,
			) => {
				const code = codes[i++];
				if (code) throw errno(code, `transient ${code}`);
				return reader();
			}) as typeof _internals.readCachedTextFile;

			const result = await readSwarmFileAsync(tmp, 'plan.json');
			expect(result).toBe('{"ok":true}');
		} finally {
			rmSyncHardened(tmp);
		}
	});

	test('does NOT retry non-transient codes (ENOTDIR fails fast)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readswarm-enotdir-'));
		try {
			let calls = 0;
			_internals.readCachedTextFile = ((): Promise<string> | never => {
				calls++;
				throw errno('ENOTDIR', 'not a directory');
			}) as typeof _internals.readCachedTextFile;

			const result = await readSwarmFileAsync(tmp, 'plan.json');
			expect(result).toBeNull();
			// Single attempt — no retries.
			expect(calls).toBe(1);
		} finally {
			rmSyncHardened(tmp);
		}
	});

	test('returns null after exhausting retries on persistent EBUSY', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readswarm-persistent-'));
		try {
			fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(tmp, '.swarm', 'plan.json'), '{"ok":true}');

			let calls = 0;
			_internals.readCachedTextFile = ((): Promise<string> | never => {
				calls++;
				throw errno('EBUSY', 'persistent lock');
			}) as typeof _internals.readCachedTextFile;

			const start = performance.now();
			const result = await readSwarmFileAsync(tmp, 'plan.json');
			const elapsed = performance.now() - start;

			expect(result).toBeNull();
			// 6 attempts (maxAttempts for the AV-class branch), 5 inter-attempt sleeps.
			expect(calls).toBe(6);
			// Worst-case added latency is 10+20+40+80+160 = 310ms. The upper
			// bound (< 600) catches a regression that roughly doubles the
			// backoff schedule (e.g. 20/40/80/160/320 = 620ms would fail)
			// while still allowing platform scheduling jitter headroom on the
			// documented 310ms worst case. (PRR-008: was < 1000, too loose.)
			expect(elapsed).toBeGreaterThanOrEqual(200);
			expect(elapsed).toBeLessThan(600);
		} finally {
			rmSyncHardened(tmp);
		}
	});

	test('still retries evidenced ENOENT (macOS/APFS rename-visibility race)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readswarm-enoent-'));
		try {
			fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			// Retry precondition (issue #2472 W3): the ENOENT ladder only
			// retries a file this process recently wrote (or previously
			// observed). Create the fixture through the canonical atomic writer
			// so the write-intent marker is recorded exactly as production
			// would record it — no test-only seam needed.
			atomicWriteSwarmFileSync(
				path.join(tmp, '.swarm', 'plan.json'),
				'{"ok":true}',
			);

			let calls = 0;
			_internals.readCachedTextFile = ((
				_resolvedPath: string,
				reader: () => Promise<string>,
			) => {
				calls++;
				if (calls < 2) throw errno('ENOENT', 'no such file or directory');
				return reader();
			}) as typeof _internals.readCachedTextFile;

			const result = await readSwarmFileAsync(tmp, 'plan.json');
			expect(result).toBe('{"ok":true}');
			expect(calls).toBe(2);
		} finally {
			rmSyncHardened(tmp);
		}
	});

	test('never-existing ENOENT returns null on the first attempt with zero sleeps (issue #2472 PERF-1)', async () => {
		// The three-way policy (issue #2472 W3) replaces the old "always retry
		// ENOENT 5 × 10ms" behavior: an ENOENT with no recent write by this
		// process and no prior observation of existence is a file that plausibly
		// NEVER existed — retrying cannot succeed. The per-message
		// system-enhancer path reads context.md and plan.md via
		// readSwarmFileAsync; on plan-less projects the old ladder cost 4 × 10ms
		// per read (~1.9s/turn). The pre-#2472 version of this test pinned the
		// removed behavior (5 attempts / 4 sleeps) and was re-pinned to the new
		// contract.
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), 'readswarm-persistent-enoent-'),
		);
		try {
			let calls = 0;
			_internals.readCachedTextFile = ((): Promise<string> | never => {
				calls++;
				throw errno('ENOENT', 'no such file or directory');
			}) as typeof _internals.readCachedTextFile;

			const start = performance.now();
			const result = await readSwarmFileAsync(tmp, 'plan.json');
			const elapsed = performance.now() - start;

			expect(result).toBeNull();
			// 1 attempt — the never-existed fast path returns before any sleep.
			expect(calls).toBe(1);
			// Zero inter-attempt sleeps: the only elapsed time is the call
			// itself. The bound (< 40) is half of even ONE old retry sleep
			// budget (4 × 10ms), catching a regression back to any retrying
			// ladder while tolerating timer/scheduling overhead.
			expect(elapsed).toBeLessThan(40);
		} finally {
			rmSyncHardened(tmp);
		}
	});

	test('custom readers can bypass the replacement-decoding artifact cache', async () => {
		const tmp = canonicalMkdtemp('readswarm-reader-');
		try {
			fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			const planPath = path.join(tmp, '.swarm', 'plan.json');
			fs.writeFileSync(planPath, '{"strict":true}');

			let cacheCalls = 0;
			_internals.readCachedTextFile = (() => {
				cacheCalls++;
				return Promise.resolve('{"lossy":true}');
			}) as typeof _internals.readCachedTextFile;

			let readerCalls = 0;
			const result = await readSwarmFileAsync(
				tmp,
				'plan.json',
				undefined,
				async (resolvedPath) => {
					readerCalls++;
					return fs.promises.readFile(resolvedPath, 'utf8');
				},
				false,
			);

			expect(result).toBe('{"strict":true}');
			expect(readerCalls).toBe(1);
			expect(cacheCalls).toBe(0);
		} finally {
			rmSyncHardened(tmp);
		}
	});
});
