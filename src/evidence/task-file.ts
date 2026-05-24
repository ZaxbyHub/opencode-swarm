/**
 * Shared write primitives for the flat task-scoped evidence file
 * `.swarm/evidence/{taskId}.json`.
 *
 * This file is the single source of truth for *where* the flat task evidence
 * file lives and *how* it is written safely. Multiple writers target the same
 * `{taskId}.json` (the delegation-gate hook via `gate-evidence.ts`, and the
 * Work-Complete council via `council-evidence-writer.ts`). They MUST coordinate
 * through the same lock key and use the same atomic temp-file+rename write, or
 * one writer's read-modify-write can clobber the other's (lost update) or
 * observe a torn file.
 *
 * The lock is keyed by the *relative* evidence path, so every writer has to
 * pass the identical relative path to `withEvidenceLock`. Centralizing that
 * derivation here (`taskEvidenceRelPath`) guarantees the keys match.
 *
 * This module deliberately holds no schema/validation logic — each caller keeps
 * its own taskId validation and read/merge semantics.
 */

import { renameSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { bunWrite } from '../utils/bun-compat';
import { withEvidenceLock } from './lock.js';

/**
 * Relative path (under `.swarm/`) of the flat task evidence file.
 * This is also the lock key — it MUST be identical across all writers to the
 * same task file so their locks coordinate.
 */
export function taskEvidenceRelPath(taskId: string): string {
	return path.join('evidence', `${taskId}.json`);
}

/** Absolute path of the flat task evidence file under `<directory>/.swarm/`. */
export function taskEvidencePath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', taskEvidenceRelPath(taskId));
}

/**
 * Dependency-injection seam for testing. Tests can temporarily replace these
 * to exercise failure paths (e.g. EPERM on renameSync) without mock.module leakage.
 * Restore each entry in afterEach via the saved original reference.
 */
export const _internals = {
	renameSync,
	unlinkSync,
};

/**
 * Atomic write: write to a unique temp file, then rename over the target.
 * The rename is atomic on POSIX and Windows, so readers never observe a torn
 * file. The temp file is cleaned up in `finally` (no-op once renamed away).
 */
export async function atomicWriteFile(
	targetPath: string,
	content: string,
): Promise<void> {
	const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		await bunWrite(tempPath, content);
		_internals.renameSync(tempPath, targetPath);
	} finally {
		try {
			_internals.unlinkSync(tempPath);
		} catch {
			/* already renamed or never created */
		}
	}
}

/**
 * Acquire the exclusive lock for a task's flat evidence file, run `fn`, release.
 * Thin wrapper over `withEvidenceLock` that fixes the lock-key convention so all
 * writers to `{taskId}.json` serialize against each other.
 */
export function withTaskEvidenceLock<T>(
	directory: string,
	taskId: string,
	agent: string,
	fn: () => Promise<T>,
): Promise<T> {
	return withEvidenceLock(
		directory,
		taskEvidenceRelPath(taskId),
		agent,
		taskId,
		fn,
	);
}
