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

import * as path from 'node:path';
import { atomicWriteFileAnyRoot } from '../utils/atomic-write';
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
 * Atomic write: write to a unique temp file, then rename over the target.
 * The rename is atomic on POSIX and Windows, so readers never observe a torn
 * file. The temp file is cleaned up in `finally` (no-op once renamed away).
 *
 * Delegates to the canonical writer core (`src/utils/atomic-write.ts`, issue
 * #2035) via the ANY-ROOT variant: this shared writer serves dual
 * destinations — `.swarm/evidence/**` files AND the linked/hive knowledge
 * stores whose directories live outside any `.swarm` root (knowledge-store /
 * knowledge-link / memory-link / family migrations) — so `.swarm` root
 * containment (the canonical entry point's contract) is inapplicable here.
 * Everything else is canonical: registered `canonical-v1` temp grammar,
 * fsync-before-rename, bounded Windows rename retry, exact own-temp cleanup,
 * and swarm-artifact-cache invalidation after a successful rename — the
 * cache's stat-based staleness check can collide on a same-size rewrite that
 * lands within one filesystem timestamp tick (issue #1729), which would
 * otherwise let a read immediately following this write observe the pre-write
 * content instead of what was just committed.
 *
 * Failure-injection tests target `src/utils/atomic-write.ts:_internals`
 * (renameSync/unlinkSync) — the seam moved there with the implementation.
 */
export async function atomicWriteFile(
	targetPath: string,
	content: string,
): Promise<void> {
	await atomicWriteFileAnyRoot(targetPath, content);
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
