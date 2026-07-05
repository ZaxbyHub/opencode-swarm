import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
	const lexicalBase = path.resolve(os.tmpdir());
	const realBase = fs.realpathSync(os.tmpdir());
	if (lexicalTarget === lexicalBase) {
		throw new Error('safeRmRecursive: refusing to remove os.tmpdir() itself');
	}
	if (!lexicalTarget.startsWith(lexicalBase + path.sep)) {
		throw new Error(
			`safeRmRecursive: refusing to remove ${lexicalTarget}; not under os.tmpdir() ${lexicalBase}`,
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

	fs.rmSync(lexicalTarget, { recursive: true, force: true });
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
