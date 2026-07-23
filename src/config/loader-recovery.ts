/**
 * Config loader recovery persistence module.
 *
 * Persists recovery metadata emitted by the config loader so that:
 *   - `/swarm config doctor` can surface stale recovery artifacts
 *     (left by a prior process that crashed before cleanup).
 *   - Post-init flush (via `flushPendingLoaderRecovery`) can record
 *     recovery warnings without blocking plugin init.
 *   - Stale artifacts from older loads are cleaned up atomically
 *     when a newer load completes successfully (SC-002.3).
 *
 * Conflict resolution: every completed load writes a recovery artifact
 * tagged with the tuple `{loadStartedAt, pid, inProcessCounter}`. When
 * an artifact already exists, the new load wins iff its tuple is
 * numerically greater than the existing one (component-wise comparison).
 * This prevents a slower or earlier process from overwriting a newer
 * recovery result.
 *
 * Artifact format (JSON):
 * ```json
 * {
 *   "loadStartedAt": number,
 *   "pid": number,
 *   "inProcessCounter": number,
 *   "sources": string[],
 *   "fingerprint": string,
 *   "warnings": RecoveryWarning[]
 * }
 * ```
 *
 * Lives under `src/config/` alongside `loader.ts` so the loader can
 * import it without cross-module dependency violations.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';
import { bunWrite } from '../utils/bun-compat.js';
import type { RecoveryWarning } from './sanitize-malformed-values.js';

// ─── Public types ───────────────────────────────────────────────────────────

/** Shape of the on-disk recovery artifact. */
export interface LoaderRecoveryArtifact {
	/** Date.now() when the config load started. */
	loadStartedAt: number;
	/** process.pid of the loading process. */
	pid: number;
	/** Monotonic per-process counter for same-process disambiguation. */
	inProcessCounter: number;
	/** Sorted source paths that contributed to the config merge. */
	sources: string[];
	/** SHA-256 fingerprint of the merged raw config. */
	fingerprint: string;
	/** Recovery warnings from the load (empty for clean loads). */
	warnings: RecoveryWarning[];
}

/**
 * Input shape accepted by the public API.
 * Matches `LoadPluginConfigWithRecoveryResult.pendingPersistence`
 * from `loader.ts`.
 */
export type PendingLoaderRecoveryData = Omit<
	LoaderRecoveryArtifact,
	'warnings'
> & {
	warnings: RecoveryWarning[];
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Relative path (under `.swarm/`) where the recovery artifact is stored. */
const RECOVERY_ARTIFACT_REL = 'advisories/loader-recovery.json';

/** Advisory prefix for all warnings from this module. */
const ADVISORY_PREFIX = '[opencode-swarm]';

// ─── DI seam ────────────────────────────────────────────────────────────────

/**
 * Test-only dependency-injection seam — replaces `fsPromises.readFile`
 * and `bunWrite` so tests can exercise failure paths without
 * `mock.module` leakage (AGENTS.md §7).
 */
export const _internals = {
	readFile: fsPromises.readFile,
	write: bunWrite,
};

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Compare two conflict-resolution tuples component-wise:
 * `{loadStartedAt, pid, inProcessCounter}`.
 *
 * Returns `true` when `a` is strictly greater than `b`, meaning `a`
 * should win the artifact slot.
 */
function tupleGreaterThan(
	a: { loadStartedAt: number; pid: number; inProcessCounter: number },
	b: { loadStartedAt: number; pid: number; inProcessCounter: number },
): boolean {
	// Primary: timestamp (earlier loads have lower timestamps)
	if (a.loadStartedAt !== b.loadStartedAt) {
		return a.loadStartedAt > b.loadStartedAt;
	}
	// Secondary: pid (higher pid wins on same timestamp)
	if (a.pid !== b.pid) {
		return a.pid > b.pid;
	}
	// Tertiary: in-process counter (higher counter wins)
	return a.inProcessCounter > b.inProcessCounter;
}

/**
 * Read and parse the existing artifact. Returns `null` when the file
 * does not exist, is unreadable, or contains invalid JSON.
 */
async function readExistingArtifact(
	artifactPath: string,
): Promise<LoaderRecoveryArtifact | null> {
	try {
		const raw = await _internals.readFile(artifactPath, 'utf-8');
		const parsed = JSON.parse(raw) as LoaderRecoveryArtifact;
		// Validate minimum required fields are present and numeric
		if (
			typeof parsed.loadStartedAt !== 'number' ||
			typeof parsed.pid !== 'number' ||
			typeof parsed.inProcessCounter !== 'number'
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Persist loader recovery data to `<directory>/.swarm/advisories/loader-recovery.json`.
 *
 * Every completed load atomically writes the artifact under deterministic
 * conflict resolution: the new load wins iff its `{loadStartedAt, pid,
 * inProcessCounter}` tuple is numerically greater than the existing artifact's.
 * Clean loads (no recovery warnings) write `warnings: []`, which serves as
 * the SC-002.3 stale-artifact cleanup signal.
 *
 * Failures (filesystem errors, permission issues) are logged via
 * `advisoryWarn` and never thrown — this is best-effort persistence.
 *
 * @param directory - Project root directory (the `.swarm/` parent).
 * @param data - Recovery data from the loader's `pendingPersistence`.
 */
export async function persistLoaderRecovery(
	directory: string,
	data: PendingLoaderRecoveryData,
): Promise<void> {
	const artifactPath = path.join(directory, '.swarm', RECOVERY_ARTIFACT_REL);

	try {
		const existing = await readExistingArtifact(artifactPath);

		if (existing !== null) {
			const incomingTuple = {
				loadStartedAt: data.loadStartedAt,
				pid: data.pid,
				inProcessCounter: data.inProcessCounter,
			};
			const existingTuple = {
				loadStartedAt: existing.loadStartedAt,
				pid: existing.pid,
				inProcessCounter: existing.inProcessCounter,
			};

			if (!tupleGreaterThan(incomingTuple, existingTuple)) {
				// Existing artifact is newer or equal — skip write to avoid
				// overwriting a more recent load's recovery data.
				return;
			}
		}

		const artifact: LoaderRecoveryArtifact = {
			loadStartedAt: data.loadStartedAt,
			pid: data.pid,
			inProcessCounter: data.inProcessCounter,
			sources: data.sources,
			fingerprint: data.fingerprint,
			warnings: data.warnings,
		};

		const content = JSON.stringify(artifact, null, 2);
		await _internals.write(artifactPath, content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		advisoryWarn(
			`${ADVISORY_PREFIX} Failed to persist loader recovery artifact: ${message}`,
		);
	}
}

/**
 * Synchronous wrapper that defers `persistLoaderRecovery` via `queueMicrotask`.
 *
 * This is designed for the post-init flush path (task 1.5) where the caller
 * must not await the write — the write is fire-and-forget, with errors
 * routed to `advisoryWarn` inside `persistLoaderRecovery`.
 *
 * @param directory - Project root directory (the `.swarm/` parent).
 * @param pendingData - Recovery data from the loader's `pendingPersistence`.
 */
export function flushPendingLoaderRecovery(
	directory: string,
	pendingData: PendingLoaderRecoveryData,
): void {
	queueMicrotask(() =>
		persistLoaderRecovery(directory, pendingData).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			advisoryWarn(
				`${ADVISORY_PREFIX} Deferred loader recovery flush failed: ${message}`,
			);
		}),
	);
}
