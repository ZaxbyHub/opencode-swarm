/**
 * Retry-behavior tests for `readSwarmFileAsync` (issue #1782).
 *
 * The function historically retried only ENOENT (5 × 10ms). On Windows CI,
 * AV/indexing of a freshly-written `.swarm/plan.json` can raise EBUSY/EPERM/
 * EACCES, which returned null on the first attempt — propagating up through
 * `loadPlanJsonOnly` to `resolveEvidenceTaskId`, which then fell through to
 * the stale session fallback (the delegation-gate-resolve-task-id.test.ts
 * merge-group flake in run 29854486821).
 *
 * The fix extends the retry set to include EBUSY/EPERM/EACCES and switches
 * the AV-class branch to exponential backoff (10/20/40/80/160ms across 6
 * attempts). The ENOENT branch keeps the cheap pre-#1782 budget (5 × 10ms)
 * to avoid a hot-path latency regression on missing-file reads
 * (`system-enhancer.ts` reads `context.md`/`plan.md` per message transform).
 *
 * Uses the existing `_internals` seam (src/hooks/utils.ts:23-35) per AGENTS.md
 * invariant 7 (DI over `mock.module`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { _internals, readSwarmFileAsync } from '../../../src/hooks/utils';
import { resetSwarmState } from '../../../src/state';

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

	test('still retries ENOENT (macOS/APFS rename-visibility race)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readswarm-enoent-'));
		try {
			fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(tmp, '.swarm', 'plan.json'), '{"ok":true}');

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

	test('persistent-ENOENT stays cheap (hot-path regression guard, issue #1782 final-critic)', async () => {
		// The split retry policy MUST keep ENOENT on the pre-#1782 cheap budget
		// (5 attempts × 10ms = ~40ms). The per-message system-enhancer path
		// reads context.md and plan.md via readSwarmFileAsync; a 310ms budget
		// on missing files would be an unacceptable per-message regression on
		// projects without those files.
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
			// 5 attempts (ENOENT_MAX_ATTEMPTS), 4 inter-attempt sleeps of 10ms.
			expect(calls).toBe(5);
			// Cheap budget: 4 × 10ms = 40ms plus small overhead. The upper
			// bound (< 80) allows ~2x slack on the 40ms baseline while still
			// catching a regression that routes ENOENT through the AV-class
			// 310ms path (which would blow past 80ms). (PRR-009: was < 150,
			// too loose — allowed ~3.75x regression.)
			expect(elapsed).toBeLessThan(80);
		} finally {
			rmSyncHardened(tmp);
		}
	});
});
