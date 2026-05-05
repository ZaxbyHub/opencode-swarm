import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

const LOCKS_DIR = '.swarm/locks';
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Test-only dependency-injection seam. Tests replace the function on this
 * object so they can inject mock behaviour without touching the real
 * `proper-lockfile` module — `mock.module` from `bun:test` leaks across
 * files in Bun's shared test-runner process, which would corrupt
 * unrelated suites. Mutating this local object is file-scoped and
 * trivially restorable via `afterEach`.
 *
 * NOTE: Production code does NOT call through this seam internally.
 * `_internals` exists solely to allow test code to intercept lock
 * acquisition without patching the real implementation.
 */
export const _internals: { tryAcquireLock: typeof tryAcquireLock } = {
	tryAcquireLock,
};

export interface FileLock {
	filePath: string;
	agent: string;
	taskId: string;
	timestamp: string;
	expiresAt: number;
	_release?: () => Promise<void>;
}

/**
 * Get lock file path for a file
 */
function getLockFilePath(directory: string, filePath: string): string {
	// Normalize path before validation to handle relative segments
	const normalized = path.resolve(directory, filePath);

	// Validate path to prevent traversal attacks.
	// Must use path.sep suffix so that /project doesn't match /project_evil.
	// Windows: case-insensitive comparison (matches pattern in src/hooks/utils.ts).
	const baseDir = path.resolve(directory) + path.sep;
	const pathOk =
		process.platform === 'win32'
			? normalized.toLowerCase().startsWith(baseDir.toLowerCase())
			: normalized.startsWith(baseDir);
	if (!pathOk) {
		throw new Error('Invalid file path: path traversal not allowed');
	}

	// Hash the normalized file path to create a safe lock filename
	const hash = Buffer.from(normalized)
		.toString('base64')
		.replace(/[/+=]/g, '_');
	return path.join(directory, LOCKS_DIR, `${hash}.lock`);
}

/**
 * Try to acquire a lock on a file using proper-lockfile
 */
export async function tryAcquireLock(
	directory: string,
	filePath: string,
	agent: string,
	taskId: string,
): Promise<
	{ acquired: true; lock: FileLock } | { acquired: false; existing?: FileLock }
> {
	// getLockFilePath throws synchronously for traversal — keep that behaviour
	const lockPath = getLockFilePath(directory, filePath);
	const locksDir = path.dirname(lockPath);

	// Ensure locks directory exists (mkdir -p equivalent)
	if (!fs.existsSync(locksDir)) {
		fs.mkdirSync(locksDir, { recursive: true });
	}

	// proper-lockfile requires the target file to exist
	if (!fs.existsSync(lockPath)) {
		fs.writeFileSync(lockPath, '', 'utf-8');
	}

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(lockPath, {
			stale: LOCK_TIMEOUT_MS,
			retries: { retries: 0 },
			realpath: false,
		});
	} catch (err: unknown) {
		// ELOCKED means another process holds the lock
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ELOCKED' || code === 'EEXIST') {
			return { acquired: false };
		}
		throw err;
	}

	const lock: FileLock = {
		filePath,
		agent,
		taskId,
		timestamp: new Date().toISOString(),
		expiresAt: Date.now() + LOCK_TIMEOUT_MS,
		_release: release,
	};

	return { acquired: true, lock };
}

/**
 * Release a lock on a file.
 *
 * The preferred release path is `lockResult.lock._release()` at the call site.
 * This function is kept for API compatibility but is a no-op: callers that
 * stored a proper-lockfile release function on `lock._release` should call
 * that directly.  Callers that do not have the release function (e.g. tests
 * that write lock sentinel files by hand) can ignore the return value.
 */
export async function releaseLock(
	_directory: string,
	_filePath: string,
	_taskId: string,
): Promise<boolean> {
	// No-op: actual release is via lock._release() at the call site.
	// Kept for API compatibility.
	return true;
}

/**
 * Check if a file is locked
 */
export function isLocked(directory: string, filePath: string): FileLock | null {
	const lockPath = getLockFilePath(directory, filePath);

	// proper-lockfile creates a <file>.lock directory; check for it
	const plLockDir = `${lockPath}.lock`;
	if (fs.existsSync(plLockDir)) {
		// Use the lock directory's mtime as a proxy for acquisition time
		let acquiredAt = Date.now();
		try {
			acquiredAt = fs.statSync(plLockDir).mtimeMs;
		} catch {
			// fallback to now
		}
		return {
			filePath,
			agent: 'unknown',
			taskId: 'unknown',
			timestamp: new Date(acquiredAt).toISOString(),
			expiresAt: acquiredAt + LOCK_TIMEOUT_MS,
		};
	}

	return null;
}

/**
 * Clean up expired locks
 */
export function cleanupExpiredLocks(directory: string): number {
	const locksDir = path.join(directory, LOCKS_DIR);

	if (!fs.existsSync(locksDir)) {
		return 0;
	}

	let cleaned = 0;
	const files = fs.readdirSync(locksDir);

	for (const file of files) {
		// proper-lockfile lock directories end in .lock (are directories)
		// sentinel files end in .lock (are plain files created by tryAcquireLock)
		// We only touch the sentinel files — proper-lockfile manages its own dirs
		if (!file.endsWith('.lock')) continue;

		const lockPath = path.join(locksDir, file);

		// Skip proper-lockfile lock directories
		try {
			const stat = fs.statSync(lockPath);
			if (stat.isDirectory()) continue;
		} catch {
			continue;
		}

		// Sentinel file: check its mtime as a proxy for staleness
		try {
			const stat = fs.statSync(lockPath);
			const ageMs = Date.now() - stat.mtimeMs;
			if (ageMs > LOCK_TIMEOUT_MS) {
				fs.unlinkSync(lockPath);
				cleaned++;
			}
		} catch {
			// Already removed
		}
	}

	return cleaned;
}

/**
 * List all active locks
 */
export function listActiveLocks(directory: string): FileLock[] {
	const locksDir = path.join(directory, LOCKS_DIR);
	const locks: FileLock[] = [];

	if (!fs.existsSync(locksDir)) {
		return locks;
	}

	const files = fs.readdirSync(locksDir);

	for (const file of files) {
		if (!file.endsWith('.lock')) continue;

		const lockPath = path.join(locksDir, file);

		try {
			const stat = fs.statSync(lockPath);

			// Sentinel files (plain files) represent known lock targets
			if (stat.isFile()) {
				// Check whether a proper-lockfile lock directory is active for it
				const plLockDir = `${lockPath}.lock`;
				if (fs.existsSync(plLockDir)) {
					let acquiredAt = Date.now();
					try {
						acquiredAt = fs.statSync(plLockDir).mtimeMs;
					} catch {
						// fallback to now
					}
					locks.push({
						filePath: file,
						agent: 'unknown',
						taskId: 'unknown',
						timestamp: new Date(acquiredAt).toISOString(),
						expiresAt: acquiredAt + LOCK_TIMEOUT_MS,
					});
				}
			}
		} catch {
			// Ignore inaccessible entries
		}
	}

	return locks;
}
