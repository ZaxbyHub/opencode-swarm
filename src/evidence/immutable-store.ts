/**
 * Shared write pipeline for content-addressed, write-once artifacts under
 * `.swarm/` (issue #1821).
 *
 * Several subsystems persist artifacts that must never be silently rewritten:
 * the evaluation store (`.swarm/evolution/{task-sets,runs,decisions,...}`) and
 * the consensus report store (`.swarm/evolution/consensus/`). They all need the
 * identical sequence — create the parent directory, take the evidence lock,
 * re-read whatever is already on disk, treat a byte-identical (or
 * caller-defined equivalent) payload as idempotent, reject a divergent payload,
 * and otherwise commit through the atomic temp-file+rename write.
 *
 * That sequence lives here exactly once. Duplicating it per store is how the
 * two copies drift: one gains a conflict check the other lacks, or one takes
 * the lock under the wrong actor and corrupts lock attribution.
 *
 * Deliberate design points:
 * - `agent` is a **parameter**, not a constant. The lock actor identifies the
 *   subsystem doing the write; hard-coding one store's actor would mislabel
 *   every other store's lock acquisitions in telemetry and diagnostics.
 * - `serialize` is a **parameter**. The canonical-JSON encoder that the
 *   evaluation store uses lives in `src/evaluation/`, and importing it here
 *   would tie this module to a sibling subsystem it has no business knowing
 *   about. Callers supply their own canonical form.
 * - `conflictError` is a **factory parameter** rather than a hard-coded error
 *   class, so each store throws its own conflict type (and keeps `instanceof`
 *   identity with its own tests) without this module importing any of them.
 */

import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { withEvidenceLock } from './lock.js';
import { atomicWriteFile } from './task-file.js';

/**
 * Read a UTF-8 file, returning `undefined` when it does not exist.
 *
 * A missing immutable artifact is the normal first-write case, not an error, so
 * this collapses `ENOENT` into `undefined` while letting every other filesystem
 * error (EACCES, EISDIR, EIO, ...) propagate. Exported because the same
 * "absent means not-yet-written" semantics apply to the stores' own reads.
 */
export async function readOptionalFile(
	filePath: string,
): Promise<string | undefined> {
	try {
		return await readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * Why a write to an already-populated path could not proceed.
 *
 * - `corrupt`   — a file exists but does not parse/validate as the artifact
 *                 type, so it cannot be compared against the desired payload.
 * - `divergent` — a valid artifact exists and differs from the desired payload.
 */
export type ImmutableArtifactConflict =
	| { kind: 'corrupt'; filePath: string; cause: unknown }
	| { kind: 'divergent'; filePath: string };

export type WriteImmutableArtifactOptions<T> = {
	/** Project root; the evidence lock is scoped to it. */
	directory: string;
	/** Lock key — the artifact path relative to `<directory>/.swarm/`. */
	relativeLockPath: string;
	/** Absolute path of the artifact file to write. */
	filePath: string;
	/** Lock actor, e.g. the owning store's name. */
	agent: string;
	/** Lock task identifier, for diagnostics. */
	taskId: string;
	/** The artifact to persist. */
	value: T;
	/** Canonical encoder; its output is what lands on disk verbatim. */
	serialize: (value: unknown) => string;
	/** Schema parse/validate for the artifact already on disk. */
	parse: (value: unknown) => T;
	/**
	 * Optional equivalence escape hatch for artifacts whose canonical form may
	 * legitimately differ (e.g. a decision that carries a decision timestamp).
	 */
	isEquivalent?: (existing: T, desired: T) => boolean;
	/** Builds the store-specific error thrown on a conflict. */
	conflictError: (conflict: ImmutableArtifactConflict) => Error;
};

/**
 * Write `value` to `filePath` exactly once.
 *
 * Idempotent: re-writing an equivalent payload returns the artifact already on
 * disk without touching the file. Writing a different payload to the same path
 * throws the caller-supplied conflict error. The whole read-compare-write runs
 * under the evidence lock so concurrent writers cannot interleave.
 */
export async function writeImmutableArtifact<T>(
	options: WriteImmutableArtifactOptions<T>,
): Promise<T> {
	await mkdir(path.dirname(options.filePath), { recursive: true });
	return withEvidenceLock(
		options.directory,
		options.relativeLockPath,
		options.agent,
		options.taskId,
		async () => {
			const desired = options.serialize(options.value);
			const existing = await readOptionalFile(options.filePath);
			if (existing !== undefined) {
				let parsed: T;
				try {
					parsed = options.parse(JSON.parse(existing));
				} catch (error) {
					throw options.conflictError({
						kind: 'corrupt',
						filePath: options.filePath,
						cause: error,
					});
				}
				if (
					options.serialize(parsed) === desired ||
					options.isEquivalent?.(parsed, options.value)
				) {
					return parsed;
				}
				throw options.conflictError({
					kind: 'divergent',
					filePath: options.filePath,
				});
			}
			await atomicWriteFile(options.filePath, desired);
			return options.value;
		},
	);
}
