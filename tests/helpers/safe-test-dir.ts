import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS } from '../../src/commands/close/unlink-schedule.js';
import { closeProjectDb } from '../../src/db/project-db.js';
import { collectGarbageBestEffort } from '../../src/utils/bun-compat.js';

/** Native-first realpath keeps test fixtures aligned with production identity. */
export const _internals: {
	realpathSyncNative: (path: fs.PathLike) => string;
	realpathSync: typeof fs.realpathSync;
	rmSync: typeof fs.rmSync;
	collectGarbageBestEffort: () => void;
	wait: (ms: number) => void;
} = {
	realpathSyncNative: fs.realpathSync.native,
	realpathSync: fs.realpathSync,
	rmSync: fs.rmSync,
	collectGarbageBestEffort,
	wait: (ms: number) => {
		Atomics.wait(RETRY_WAIT, 0, 0, ms);
	},
};

/**
 * Import-time snapshot of the `_internals` member values (#3260-D). Tests that
 * swap seam members must restore them (AGENTS.md invariant 7); the snapshot is
 * what makes a LEAK detectable: `assertInternalsRestored` (below) fails when
 * any member still differs. A leaked `wait` swap silently converts every
 * consumer's retry budget to ~0 s — loud throw, silent cause — so the guard
 * runs run-wide from the aggregated preload afterAll
 * (tests/preload/prod-store-tripwire.ts).
 */
const IMPORT_TIME_INTERNALS: Readonly<Record<string, unknown>> = {
	..._internals,
};

/**
 * Throws when any `_internals` member differs from its import-time value (a
 * test swapped a seam member and did not restore it). Returns normally when
 * the seam is clean. Run-wide wiring lives in the aggregated preload afterAll;
 * individual suites may also call it directly.
 */
export function assertInternalsRestored(): void {
	for (const key of Object.keys(IMPORT_TIME_INTERNALS)) {
		if (
			(_internals as Record<string, unknown>)[key] !==
			IMPORT_TIME_INTERNALS[key]
		) {
			throw new Error(
				`safe-test-dir internals-restoration guard: _internals.${key} differs from its import-time value — a test swapped this seam member without restoring it, leaking its semantics to every later consumer in this process`,
			);
		}
	}
}

const RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function canonicalRealpath(targetPath: fs.PathLike): string {
	try {
		return _internals.realpathSyncNative(targetPath);
	} catch {
		return _internals.realpathSync(targetPath);
	}
}

/** Symlink-resolved path, or the path itself when it does not exist. */
function realpathOrSelf(targetPath: string): string {
	try {
		return canonicalRealpath(targetPath);
	} catch {
		return targetPath;
	}
}

/**
 * Test fixtures often spy on `process.platform` to exercise a target platform.
 * Use the host `node:path` separator rather than that mutable runtime property
 * so the test cleanup boundary still describes the real filesystem.
 */
function normalizeHostFilesystemPath(targetPath: string): string {
	const resolved = path.resolve(targetPath);
	return path.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function isWithinHostFilesystemPath(
	targetPath: string,
	rootPath: string,
): boolean {
	const target = normalizeHostFilesystemPath(targetPath);
	const root = normalizeHostFilesystemPath(rootPath);
	return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Creates a unique subdirectory under os.tmpdir() and returns
 * the path plus a cleanup function. Safe for use in bun:test.
 *
 * Usage:
 *   const { dir, cleanup } = createSafeTestDir('my-test-');
 *   afterEach(cleanup);
 */
export function createSafeTestDir(prefix = 'swarm-safe-test-'): {
	dir: string;
	cleanup: () => void;
} {
	const base = os.tmpdir();
	const rawDir = fs.mkdtempSync(path.join(base, prefix));
	// Resolve through native realpath first so the returned dir matches the canonical
	// path that production code (which canonicalizes via path.resolve/realpath)
	// will compare against. On macOS, os.tmpdir() returns /var/folders/... (a
	// symlink to /private/var/folders/...); without realpath, fixtures built
	// under the symlinked path trip .swarm containment guards and repo-graph
	// boundary checks that canonicalize ("resolves outside the working
	// directory"). Also fixes the Windows 8.3 short-name mismatch
	// (C:\Users\RUNNER~1 vs C:\Users\runneradmin). AGENTS.md invariant 7
	// requires this wrap when the result is chdir'd; doing it unconditionally
	// is safe and makes the shared helper the single correct precedent.
	const dir = canonicalRealpath(rawDir);
	const canonicalBase = canonicalRealpath(base);

	// Safety assertion: verify it's actually under tmpdir (compare against the
	// resolved base too, so the symlinked /var vs real /private/var case is
	// caught).
	if (!isWithinHostFilesystemPath(dir, canonicalBase)) {
		throw new Error(
			`createSafeTestDir: created dir ${dir} is not under os.tmpdir()`,
		);
	}

	const cleanup = (): void => {
		safeRmRecursive(dir);
	};

	return { dir, cleanup };
}

/**
 * Recursively remove a test path only after proving it is under os.tmpdir().
 */
export function safeRmRecursive(targetPath: string): void {
	if (typeof targetPath !== 'string' || targetPath.trim() === '') {
		throw new Error('safeRmRecursive: targetPath must be a non-empty string');
	}

	const lexicalTarget = path.resolve(targetPath);
	// Never remove the working directory or any of its ancestors. A checkout
	// can itself live under os.tmpdir() (a clone in /tmp, a worktree in a temp
	// dir), and then the tmpdir checks below accept '.' — which deleted the
	// whole checkout.
	// Compare both the literal and the symlink-resolved forms (macOS: /var is
	// /private/var, so one side may be resolved and the other not).
	const cwd = path.resolve(process.cwd());
	if (
		isWithinHostFilesystemPath(cwd, lexicalTarget) ||
		isWithinHostFilesystemPath(
			realpathOrSelf(cwd),
			realpathOrSelf(lexicalTarget),
		)
	) {
		throw new Error(
			`safeRmRecursive: refusing to remove ${lexicalTarget}; it is the current working directory or contains it`,
		);
	}
	const tmpBase = os.tmpdir();
	const canonicalTmpBase = canonicalRealpath(tmpBase);
	const lexicalTmpBase = path.resolve(tmpBase);
	if (
		normalizeHostFilesystemPath(lexicalTarget) ===
			normalizeHostFilesystemPath(lexicalTmpBase) ||
		normalizeHostFilesystemPath(lexicalTarget) ===
			normalizeHostFilesystemPath(canonicalTmpBase)
	) {
		throw new Error('safeRmRecursive: refusing to remove os.tmpdir() itself');
	}
	if (
		!isWithinHostFilesystemPath(lexicalTarget, lexicalTmpBase) &&
		!isWithinHostFilesystemPath(lexicalTarget, canonicalTmpBase)
	) {
		throw new Error(
			`safeRmRecursive: refusing to remove ${lexicalTarget}; not under os.tmpdir()`,
		);
	}
	if (
		fs.existsSync(lexicalTarget) &&
		!isWithinHostFilesystemPath(
			canonicalRealpath(lexicalTarget),
			canonicalTmpBase,
		)
	) {
		throw new Error(
			`safeRmRecursive: refusing to remove ${lexicalTarget}; not under os.tmpdir()`,
		);
	}

	// #2480: production code may have opened .swarm/swarm.db under this dir
	// (cached canonical handle); a held WAL lock makes rmSync fail EBUSY on
	// Windows no matter how long we retry. Release it first, best-effort
	// (closeProjectDb never throws and is a no-op without a cached handle).
	closeProjectDb(lexicalTarget);

	// Bun does not consistently honor fs.rmSync's maxRetries on Windows. Retry
	// transient handle-release failures on the PRODUCTION delay schedule
	// (ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS — the same ~15.2 s budget PR #3254
	// sized to the instrumented windows-latest handle-release tail; sum
	// 15,175 ms over 20 delays). Issue #3248 class 2 introduced the retry;
	// issue #3260-A tied it to the production schedule after the independent
	// ~9.9 s literal (99 × 100 ms) was found NOT to cover the same tail the
	// production unlink schedule covers. Shape: one attempt per schedule
	// delay (20 attempts + waits), then ONE final attempt after the schedule
	// is exhausted (21 rmSync attempts total), with NO wait after the final
	// failure. collectGarbageBestEffort runs on EVERY failed attempt: a hedge
	// for GC-reclaimable handles (Bun sqlite statement caches), not a cure
	// for AV-held handles — only elapsed time helps those.
	for (const delay of ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS) {
		try {
			_internals.rmSync(lexicalTarget, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')
				throw error;
			_internals.collectGarbageBestEffort();
			_internals.wait(delay);
		}
	}
	// Schedule exhausted: one last attempt, then surface the final error
	// (no wait after the final failure).
	_internals.rmSync(lexicalTarget, { recursive: true, force: true });
}

/**
 * Recursively remove MULTIPLE test paths the way `safeRmRecursive` does, but
 * attempt EVERY target and throw only AFTER the loop (#3260-C): a `for (const
 * d of dirs) safeRmRecursive(d);` loop rethrows on the first exhausted dir and
 * strands the remaining temp dirs (their cleanup never runs, and sibling
 * bookkeeping like `testRoots.clear()` is skipped too). The aggregate error
 * names every failed target; per-target causes are preserved as AggregateError
 * causes.
 */
export function safeRmAllRecursive(targets: readonly string[]): void {
	const failures: Array<{ target: string; error: unknown }> = [];
	for (const target of targets) {
		try {
			safeRmRecursive(target);
		} catch (error) {
			failures.push({ target, error });
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(
			failures.map((failure) => failure.error),
			`safeRmAllRecursive: ${failures.length}/${targets.length} teardown target(s) failed: ${failures
				.map((failure) => failure.target)
				.join(', ')}`,
		);
	}
}

/**
 * Runs an async function with a safe temp directory, always cleaning up.
 *
 * Usage:
 *   await withSafeTestDir(async (dir) => {
 *     fs.writeFileSync(path.join(dir, 'test.txt'), 'hello');
 *     // ... test logic
 *   });
 */
export async function withSafeTestDir<T>(
	fn: (dir: string) => Promise<T>,
	prefix = 'swarm-safe-test-',
): Promise<T> {
	const { dir, cleanup } = createSafeTestDir(prefix);
	try {
		return await fn(dir);
	} finally {
		cleanup();
	}
}
