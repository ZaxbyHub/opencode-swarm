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
export const _internals: {
	tryAcquireLock: typeof tryAcquireLock;
	writeFile: typeof fs.promises.writeFile;
} = {
	tryAcquireLock,
	writeFile: fs.promises.writeFile,
};

/**
 * Sidecar metadata written alongside each lock sentinel file.
 */
export interface LockMetadata {
	originalPath: string; // Normalized original file path
	laneId: string; // Lane ID (e.g., "lane-1")
	taskId: string; // Task ID (e.g., "4.1")
	agent: string; // Agent name
	sessionID: string; // Session ID
	acquiredAt: string; // ISO timestamp
	expiresAt: number; // Unix timestamp (ms)
}

export interface FileLock {
	filePath: string;
	agent: string;
	taskId: string;
	timestamp: string;
	expiresAt: number;
	laneId?: string; // Optional: present when acquired via acquireLaneLocks
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
	// On Windows, lowercase the normalized path to match planner normalization from Phase 4
	const pathForHash =
		process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	const hash = Buffer.from(pathForHash)
		.toString('base64')
		.replace(/[/+=]/g, '_');
	const lockPath = path.join(directory, LOCKS_DIR, `${hash}.lock`);

	// Windows: probe for existing lock at old case-preserving hash for backward compatibility
	if (process.platform === 'win32') {
		const oldHash = Buffer.from(normalized) // case-preserving
			.toString('base64')
			.replace(/[/+=]/g, '_');
		const oldLockPath = path.join(directory, LOCKS_DIR, `${oldHash}.lock`);
		if (fs.existsSync(oldLockPath)) {
			return oldLockPath;
		}
	}

	return lockPath;
}

/**
 * Get the path for the sidecar metadata file corresponding to a lock sentinel.
 */
function getMetaPath(lockPath: string): string {
	return `${lockPath.replace(/\.lock$/, '')}.meta`;
}

/**
 * Atomically write metadata to a sidecar file using temp + rename.
 */
async function writeMetaFile(
	metaPath: string,
	metadata: LockMetadata,
): Promise<void> {
	const tmpPath = `${metaPath}.tmp`;
	try {
		await _internals.writeFile(tmpPath, JSON.stringify(metadata), 'utf-8');
		await fs.promises.rename(tmpPath, metaPath);
	} catch (err) {
		// Clean up temp file on failure
		try {
			await fs.promises.unlink(tmpPath);
		} catch {
			// ignore
		}
		throw err;
	}
}

/**
 * Safely read and parse a metadata file, returning null on error.
 */
function readMetaFile(metaPath: string): LockMetadata | null {
	try {
		const content = fs.readFileSync(metaPath, 'utf-8');
		return JSON.parse(content) as LockMetadata;
	} catch {
		return null;
	}
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
 * Clean up expired locks and their sidecar metadata files.
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
				// Remove sidecar metadata if it exists
				const metaPath = getMetaPath(lockPath);
				try {
					fs.unlinkSync(metaPath);
				} catch {
					// ignore if missing
				}
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
 * List all active locks, reading metadata from sidecar files when available.
 * Filters out expired locks.
 */
export function listActiveLocks(directory: string): FileLock[] {
	const locksDir = path.join(directory, LOCKS_DIR);
	const locks: FileLock[] = [];

	if (!fs.existsSync(locksDir)) {
		return locks;
	}

	const files = fs.readdirSync(locksDir);
	const now = Date.now();

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
					const metaPath = getMetaPath(lockPath);
					const meta = readMetaFile(metaPath);

					if (meta) {
						// Skip expired locks
						if (meta.expiresAt < now) {
							continue;
						}
						locks.push({
							filePath: meta.originalPath,
							agent: meta.agent,
							taskId: meta.taskId,
							timestamp: meta.acquiredAt,
							expiresAt: meta.expiresAt,
							laneId: meta.laneId,
						});
					} else {
						// No metadata: use mtime-based fallback
						let acquiredAt = Date.now();
						try {
							acquiredAt = fs.statSync(plLockDir).mtimeMs;
						} catch {
							// fallback to now
						}
						const expiresAt = acquiredAt + LOCK_TIMEOUT_MS;
						// Skip expired locks in fallback path too
						if (expiresAt < now) {
							continue;
						}
						locks.push({
							filePath: file,
							agent: 'unknown',
							taskId: 'unknown',
							timestamp: new Date(acquiredAt).toISOString(),
							expiresAt,
						});
					}
				}
			}
		} catch {
			// Ignore inaccessible entries
		}
	}

	return locks;
}

/**
 * Acquire locks for all files in a lane (all-or-nothing).
 *
 * If ANY file is already locked, releases ALL previously acquired locks
 * in this lane and returns `{ acquired: false, conflicts }`.
 *
 * @param directory - Project root directory
 * @param laneId - Unique lane identifier
 * @param files - Array of file paths to lock
 * @param agent - Agent name
 * @param taskId - Task ID
 * @param sessionID - Session ID
 * @returns Success with array of FileLock objects, or failure with conflict list
 */
export async function acquireLaneLocks(
	directory: string,
	laneId: string,
	files: string[],
	agent: string,
	taskId: string,
	sessionID: string,
): Promise<
	| { acquired: true; locks: FileLock[] }
	| { acquired: false; conflicts: string[] }
> {
	const acquiredLocks: FileLock[] = [];
	const conflicts: string[] = [];

	for (const file of files) {
		const result = await tryAcquireLock(directory, file, agent, taskId);

		if (!result.acquired) {
			// Failed to acquire: release all previously acquired locks in this lane
			for (const lock of acquiredLocks) {
				try {
					if (lock._release) {
						await lock._release();
					}
					// Delete the sentinel file and its metadata
					const lockPath = getLockFilePath(directory, lock.filePath);
					const metaPath = getMetaPath(lockPath);
					try {
						fs.unlinkSync(metaPath);
					} catch {
						// ignore if missing
					}
					try {
						fs.unlinkSync(lockPath);
					} catch {
						// ignore if already gone
					}
				} catch {
					// Best-effort cleanup
				}
			}
			conflicts.push(file);
			return { acquired: false, conflicts };
		}

		// Successfully acquired: write sidecar metadata
		const lockPath = getLockFilePath(directory, file);
		const metaPath = getMetaPath(lockPath);
		const meta: LockMetadata = {
			originalPath: file,
			laneId,
			taskId,
			agent,
			sessionID,
			acquiredAt: result.lock.timestamp,
			expiresAt: result.lock.expiresAt,
		};

		try {
			await writeMetaFile(metaPath, meta);
		} catch (err) {
			// Failed to write metadata: release ALL previously acquired locks and clean up
			for (const lock of acquiredLocks) {
				try {
					if (lock._release) {
						await lock._release();
					}
					const lp = getLockFilePath(directory, lock.filePath);
					const mp = getMetaPath(lp);
					try {
						fs.unlinkSync(mp);
					} catch {
						// ignore if missing
					}
					try {
						fs.unlinkSync(lp);
					} catch {
						// ignore if already gone
					}
				} catch {
					// Best-effort cleanup
				}
			}
			// Release and clean up the current lock that failed metadata write
			if (result.lock._release) {
				await result.lock._release();
			}
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// ignore
			}
			throw err;
		}

		// Attach laneId to the lock object
		result.lock.laneId = laneId;
		acquiredLocks.push(result.lock);
	}

	return { acquired: true, locks: acquiredLocks };
}

/**
 * Release all locks for a given lane.
 *
 * Reads all `.meta` files in `.swarm/locks/`, finds entries matching `laneId`,
 * and releases + deletes corresponding lock files.
 *
 * @param directory - Project root directory
 * @param laneId - Lane ID to release
 * @returns Number of locks released
 */
export async function releaseLaneLocks(
	directory: string,
	laneId: string,
): Promise<number> {
	const locksDir = path.join(directory, LOCKS_DIR);

	if (!fs.existsSync(locksDir)) {
		return 0;
	}

	const files = fs.readdirSync(locksDir);
	let releasedCount = 0;

	for (const file of files) {
		if (!file.endsWith('.meta')) continue;

		const metaPath = path.join(locksDir, file);
		const meta = readMetaFile(metaPath);

		if (!meta || meta.laneId !== laneId) continue;

		// Found a lock for this lane
		const lockPath = metaPath.replace(/\.meta$/, '.lock');

		try {
			// Release via proper-lockfile if we have the release function stored
			// For lane locks, we need to reconstruct the release function
			// Since _release isn't persisted in metadata, we use proper-lockfile's unlock
			try {
				await lockfile.unlock(lockPath, { realpath: false });
			} catch {
				// May already be unlocked or missing
			}

			// Delete sentinel file
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// ignore if already gone
			}

			// Delete metadata file
			try {
				fs.unlinkSync(metaPath);
			} catch {
				// ignore
			}

			releasedCount++;
		} catch {
			// Best-effort: continue with other locks
		}
	}

	return releasedCount;
}
