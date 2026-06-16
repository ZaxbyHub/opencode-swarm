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
	const dir = fs.mkdtempSync(path.join(base, prefix));

	// Safety assertion: verify it's actually under tmpdir
	const resolvedDir = path.resolve(dir);
	const resolvedBase = path.resolve(base);
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
