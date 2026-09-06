import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeProjectDb } from '../../src/db/project-db.js';
import { collectGarbageBestEffort } from '../../src/utils/bun-compat.js';

/** Native-first realpath keeps test fixtures aligned with production identity. */
export const _internals: {
	realpathSyncNative: (path: fs.PathLike) => string;
	realpathSync: typeof fs.realpathSync;
} = {
	realpathSyncNative: fs.realpathSync.native,
	realpathSync: fs.realpathSync,
};

function canonicalRealpath(targetPath: fs.PathLike): string {
	try {
		return _internals.realpathSyncNative(targetPath);
	} catch {
		return _internals.realpathSync(targetPath);
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
	// transient handle-release failures explicitly, bounded to two seconds.
	const retryWait = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; ; attempt += 1) {
		try {
			fs.rmSync(lexicalTarget, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				attempt >= 20 ||
				(code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')
			)
				throw error;
			if (attempt === 0) collectGarbageBestEffort();
			Atomics.wait(retryWait, 0, 0, 100);
		}
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
