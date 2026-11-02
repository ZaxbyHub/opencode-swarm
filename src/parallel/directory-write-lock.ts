import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile, { type LockOptions } from 'proper-lockfile';

/** Anchor file inside `dir`; never lock `dir` itself (creates sibling `<dir>.lock`). */
export const DIRECTORY_WRITE_LOCK_ANCHOR = '.write-lock-anchor';

export type DirectoryWriteLockOptions = {
	stale?: number;
	retries?:
		| number
		| {
				retries?: number;
				minTimeout?: number;
				maxTimeout?: number;
				factor?: number;
		  };
	realpath?: boolean;
};

const DEFAULT_OPTS: DirectoryWriteLockOptions = {
	retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
	stale: 5000,
	realpath: false,
};

/**
 * Serialize writers under `dir` using a file anchor inside the directory.
 * `proper-lockfile.lock(dir)` on a `.swarm/` path creates `<project>/.swarm.lock`
 * beside the folder, which breaks gitignore invariants and crashes file watchers
 * that stat the transient sibling (observed on /srv/infra).
 */
export async function acquireDirectoryWriteLock(
	dir: string,
	options?: DirectoryWriteLockOptions,
): Promise<() => Promise<void>> {
	await mkdir(dir, { recursive: true });
	const anchor = path.join(dir, DIRECTORY_WRITE_LOCK_ANCHOR);
	if (!existsSync(anchor)) {
		writeFileSync(anchor, '', 'utf8');
	}
	return lockfile.lock(anchor, {
		...DEFAULT_OPTS,
		...options,
	} as LockOptions);
}
