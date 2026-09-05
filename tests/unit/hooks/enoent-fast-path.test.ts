/**
 * First-miss ENOENT fast-path guardrails (issue #2472 W3 / PERF-1).
 *
 * Contract under test — the three-way ENOENT policy in `readSwarmFileAsync`
 * (src/hooks/utils.ts) and `readFileOrEmpty`
 * (src/services/context-budget-service.ts):
 *
 *  1. NEVER-EXISTED fast path: a first ENOENT on a file with no recent write
 *     by this process and no prior observation of existence returns null/''
 *     immediately — ZERO short retry sleeps. (Before #2472 every miss paid
 *     4 × 10ms; plan-less projects lost ~1.9s/turn.)
 *  2. EVIDENCED rename-race: an ENOENT on a file this process recently wrote
 *     (write INTENT recorded by the canonical atomic writers before the temp
 *     write begins) or previously observed to exist still walks the retry
 *     ladder — the #1782 macOS/APFS rename-visibility protection is retained.
 *  3. AV window (EBUSY/EPERM/EACCES) — unchanged; covered by
 *     utils-read-swarm-file.test.ts.
 *
 * Short sleeps are measured by instrumenting globalThis.setTimeout exactly
 * like the frozen acceptance check (repro/check-c4.ts, issue #2472).
 *
 * DI seams per AGENTS.md invariant 7: `_internals` on src/hooks/utils and on
 * src/utils/swarm-artifact-cache; no mock.module.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
	_internals as hookInternals,
	readSwarmFileAsync,
	validateSwarmPath,
} from '../../../src/hooks/utils';
import { getContextBudgetReport } from '../../../src/services/context-budget-service';
import {
	atomicWriteSwarmFileSync,
	RECENT_WRITE_WINDOW_MS,
	wasRecentlyWrittenByThisProcess,
} from '../../../src/utils/atomic-write';
import {
	_internals as cacheInternals,
	readCachedTextFileSync,
	wasObservedToExist,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// ── setTimeout instrumentation (check-c4.ts precedent) ───────────────────────
const realSetTimeout = globalThis.setTimeout;
let shortSleepCount = 0;
type SetTimeoutLike = typeof globalThis.setTimeout;

function installSleepCounter(): void {
	shortSleepCount = 0;
	(globalThis as unknown as { setTimeout: SetTimeoutLike }).setTimeout = ((
		fn: (...args: unknown[]) => void,
		ms?: number,
		...rest: unknown[]
	) => {
		if (typeof ms === 'number' && ms <= 50) shortSleepCount++;
		return (realSetTimeout as unknown as SetTimeoutLike)(
			fn,
			ms,
			...((rest as unknown[]) ?? []),
		);
	}) as SetTimeoutLike;
}

function restoreSetTimeout(): void {
	(globalThis as unknown as { setTimeout: SetTimeoutLike }).setTimeout =
		realSetTimeout;
}

// ── fixtures / seams ─────────────────────────────────────────────────────────
const realReadCachedTextFile = hookInternals.readCachedTextFile;
const realStatSync = cacheInternals.statSync;

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

afterEach(() => {
	hookInternals.readCachedTextFile = realReadCachedTextFile;
	cacheInternals.statSync = realStatSync;
	restoreSetTimeout();
});

describe('first-miss ENOENT fast path (issue #2472 W3 / PERF-1)', () => {
	test('never-existing plan.md: first-miss ENOENT returns null with ZERO short sleeps', async () => {
		// No .swarm directory at all — the plan-less-project hot path
		// (system-enhancer reads plan.md per message transform).
		const dir = canonicalMkdtemp('enoent-fast-never-');
		installSleepCounter();
		try {
			const start = Date.now();
			const result = await readSwarmFileAsync(dir, 'plan.md');
			const elapsed = Date.now() - start;
			expect(result).toBeNull();
			expect(shortSleepCount).toBe(0);
			// Zero sleeps ⇒ only the call itself; bound is generous CI headroom.
			expect(elapsed).toBeLessThan(40);
		} finally {
			restoreSetTimeout();
			rmSyncHardened(dir);
		}
	});

	test('atomic-write-then-immediate-read: an evidenced ENOENT still retries (rename-race protection retained)', async () => {
		const dir = canonicalMkdtemp('enoent-fast-race-');
		fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
		const target = join(dir, '.swarm', 'plan.json');
		// REAL atomic writer — records write intent + completion exactly as
		// production does (no test-only seam).
		atomicWriteSwarmFileSync(target, '{"race":true}');
		expect(
			wasRecentlyWrittenByThisProcess(target, RECENT_WRITE_WINDOW_MS),
		).toBe(true);
		// The write-marker arm is what drives this test: nothing has observed
		// the file yet (no successful read/stat of the target so far).
		expect(wasObservedToExist(target)).toBe(false);

		let calls = 0;
		hookInternals.readCachedTextFile = ((
			resolvedPath: string,
			reader: () => Promise<string>,
		) => {
			calls++;
			// Attempt 1 simulates the mid-rename visibility miss (ENOENT even
			// though the write completed); attempt 2 reads for real.
			if (calls < 2) throw errno('ENOENT', 'no such file or directory');
			return realReadCachedTextFile(resolvedPath, reader);
		}) as typeof hookInternals.readCachedTextFile;

		installSleepCounter();
		try {
			const result = await readSwarmFileAsync(dir, 'plan.json');
			expect(result).toBe('{"race":true}');
			// Retried exactly once, paying one 10ms flat-backoff sleep — the
			// #1782 rename-race ladder is still walked when evidenced.
			expect(calls).toBe(2);
			expect(shortSleepCount).toBe(1);
		} finally {
			restoreSetTimeout();
			hookInternals.readCachedTextFile = realReadCachedTextFile;
			rmSyncHardened(dir);
		}
	});

	test('wasObservedToExist flips after a successful read of an existing file', async () => {
		const dir = canonicalMkdtemp('enoent-fast-observed-');
		fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
		// Plain write on purpose: NO atomic-writer marker, so only the
		// observed-existence arm can mark this path.
		fs.writeFileSync(join(dir, '.swarm', 'context.md'), '# observed');
		const resolved = validateSwarmPath(dir, 'context.md');
		expect(wasObservedToExist(resolved)).toBe(false);

		const result = await readSwarmFileAsync(dir, 'context.md');
		expect(result).toBe('# observed');
		expect(wasObservedToExist(resolved)).toBe(true);
		rmSyncHardened(dir);
	});

	test('previously-observed file: persistent ENOENT still walks the full 5-attempt ladder', async () => {
		const dir = canonicalMkdtemp('enoent-fast-observed-retry-');
		fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(join(dir, '.swarm', 'context.md'), 'gone soon');
		// Observe existence through a real successful read (no write marker).
		const first = await readSwarmFileAsync(dir, 'context.md');
		expect(first).toBe('gone soon');
		expect(wasObservedToExist(validateSwarmPath(dir, 'context.md'))).toBe(true);
		// The file now disappears and every read ENOENTs (mid-delete race).
		fs.rmSync(join(dir, '.swarm', 'context.md'));

		let calls = 0;
		hookInternals.readCachedTextFile = ((): Promise<string> | never => {
			calls++;
			throw errno('ENOENT', 'no such file or directory');
		}) as typeof hookInternals.readCachedTextFile;

		try {
			const result = await readSwarmFileAsync(dir, 'context.md');
			expect(result).toBeNull();
			// Full ENOENT ladder (ENOENT_MAX_ATTEMPTS = 5, 4 sleeps) — the
			// observed-existence arm keeps the #1782 budget for files that
			// existed moments ago.
			expect(calls).toBe(5);
		} finally {
			hookInternals.readCachedTextFile = realReadCachedTextFile;
			rmSyncHardened(dir);
		}
	});

	test('knownToExist evicts FIFO at capacity (512 entries)', () => {
		const dir = canonicalMkdtemp('enoent-fast-evict-');
		const fakeFileStat = () =>
			({
				isFile: () => true,
				isDirectory: () => false,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isSymbolicLink: () => false,
				isFIFO: () => false,
				isSocket: () => false,
				mtimeMs: 1,
				ctimeMs: 1,
				size: 1,
			}) as unknown as ReturnType<typeof fs.statSync>;
		cacheInternals.statSync = (() =>
			fakeFileStat()) as typeof cacheInternals.statSync;
		try {
			const pathOf = (i: number) =>
				join(dir, `f-${String(i).padStart(4, '0')}.txt`);
			// 513 distinct successful stats through the sync reader: capacity
			// is 512, so the 513th insert evicts the FIRST-recorded path.
			for (let i = 0; i <= 512; i++) {
				const value = readCachedTextFileSync(pathOf(i), () => 'x');
				expect(value).toBe('x');
			}
			expect(wasObservedToExist(pathOf(0))).toBe(false); // evicted
			expect(wasObservedToExist(pathOf(1))).toBe(true);
			expect(wasObservedToExist(pathOf(512))).toBe(true);
		} finally {
			cacheInternals.statSync = realStatSync;
			rmSyncHardened(dir);
		}
	});

	test('wasRecentlyWrittenByThisProcess window expires (direct unit call, short withinMs)', async () => {
		const dir = canonicalMkdtemp('enoent-fast-window-');
		fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
		const target = join(dir, '.swarm', 'window.json');
		atomicWriteSwarmFileSync(target, '{}');

		// Fresh write: inside both the default and a generous window.
		expect(
			wasRecentlyWrittenByThisProcess(target, RECENT_WRITE_WINDOW_MS),
		).toBe(true);
		// Let ~25ms of wall-clock time pass via the REAL setTimeout.
		await new Promise((resolve) => realSetTimeout(resolve, 25));
		// A 10ms window has expired; the default 500ms window still covers it.
		expect(wasRecentlyWrittenByThisProcess(target, 10)).toBe(false);
		expect(wasRecentlyWrittenByThisProcess(target)).toBe(true);
		rmSyncHardened(dir);
	});

	test('context-budget ladder: report on a fresh project incurs ZERO short sleeps (readFileOrEmpty fast path)', async () => {
		// Ladder 2 of the frozen check (repro/check-c4.ts): the public caller
		// reads plan.md / knowledge / run-memory.jsonl / handoff.md /
		// context.md on a project where none of them ever existed.
		const dir = canonicalMkdtemp('enoent-fast-budget-');
		installSleepCounter();
		try {
			const report = await getContextBudgetReport(
				dir,
				'enoent fast path system prompt',
				{
					enabled: true,
					budgetTokens: 100_000,
					warningPct: 70,
					criticalPct: 90,
					warningMode: 'once',
					warningIntervalTurns: 20,
				},
			);
			expect(report.status).toBeDefined();
			expect(shortSleepCount).toBe(0);
		} finally {
			restoreSetTimeout();
			rmSyncHardened(dir);
		}
	});
});
