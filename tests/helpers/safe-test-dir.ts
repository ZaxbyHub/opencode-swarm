import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeProjectDb } from '../../src/db/project-db.js';

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
	// Resolve through realpathSync so the returned dir matches the canonical
	// path that production code (which canonicalizes via path.resolve/realpath)
	// will compare against. On macOS, os.tmpdir() returns /var/folders/... (a
	// symlink to /private/var/folders/...); without realpath, fixtures built
	// under the symlinked path trip .swarm containment guards and repo-graph
	// boundary checks that canonicalize ("resolves outside the working
	// directory"). Also fixes the Windows 8.3 short-name mismatch
	// (C:\Users\RUNNER~1 vs C:\Users\runneradmin). AGENTS.md invariant 7
	// requires this wrap when the result is chdir'd; doing it unconditionally
	// is safe and makes the shared helper the single correct precedent.
	const dir = fs.realpathSync(rawDir);

	// Safety assertion: verify it's actually under tmpdir (compare against the
	// resolved base too, so the symlinked /var vs real /private/var case is
	// caught).
	const resolvedDir = path.resolve(dir);
	const resolvedBase = path.resolve(fs.realpathSync(base));
	if (
		!resolvedDir.startsWith(resolvedBase + path.sep) &&
		resolvedDir !== resolvedBase
	) {
		throw new Error(
			`createSafeTestDir: created dir ${resolvedDir} is not under os.tmpdir() ${resolvedBase}`,
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
	// Compute the base BOTH lexically and via realpath so the containment
	// guards below work regardless of which form the caller passed in.
	// createSafeTestDir now returns a realpath-resolved dir (issue #1729 macOS
	// /var -> /private/var symlink fix), so lexicalTarget may be the resolved
	// /private/var/... form while os.tmpdir() returns the /var/... symlink.
	// Comparing resolved-target against resolved-base keeps the lexical guard
	// consistent with how createSafeTestDir canonicalizes its return value.
	const realBase = fs.realpathSync(os.tmpdir());
	const lexicalBase = path.resolve(os.tmpdir());
	const resolvedBase = path.resolve(realBase);
	if (lexicalTarget === lexicalBase || lexicalTarget === resolvedBase) {
		throw new Error('safeRmRecursive: refusing to remove os.tmpdir() itself');
	}
	if (
		!lexicalTarget.startsWith(lexicalBase + path.sep) &&
		!lexicalTarget.startsWith(resolvedBase + path.sep)
	) {
		throw new Error(
			`safeRmRecursive: refusing to remove ${lexicalTarget}; not under os.tmpdir() ${lexicalBase} (resolved ${resolvedBase})`,
		);
	}

	if (fs.existsSync(lexicalTarget)) {
		const realTarget = fs.realpathSync(lexicalTarget);
		if (
			realTarget === realBase ||
			!realTarget.startsWith(realBase + path.sep)
		) {
			throw new Error(
				`safeRmRecursive: refusing to remove ${lexicalTarget}; real path ${realTarget} escapes os.tmpdir() ${realBase}`,
			);
		}
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
