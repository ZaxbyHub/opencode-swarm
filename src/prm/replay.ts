/**
 * PRM Replay System
 *
 * Provides deterministic replay functionality for PRM (Process Remediation Manager).
 * Records all LLM requests/responses and tool I/O during a run for replay.
 *
 * Replay artifacts are stored in `.swarm/replays/{sessionId}-{timestamp}.jsonl`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';
import * as logger from '../utils/logger.js';

/**
 * Validates that a path is within a base directory using canonical path resolution.
 * Rejects paths with traversal attempts (..) or absolute paths pointing outside.
 *
 * @param targetPath - The path to validate
 * @param basePath - The base directory
 * @returns true if path is safe, false otherwise
 */
function isPathSafe(targetPath: string, basePath: string): boolean {
	const resolvedTarget = path.resolve(targetPath);
	const resolvedBase = path.resolve(basePath);
	const rel = path.relative(resolvedBase, resolvedTarget);

	// Safe if: relative path doesn't start with '..' and isn't absolute
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validates that a path is within the swarm replays directory.
 * Checks that '.swarm' and 'replays' appear as consecutive path segments.
 *
 * @param targetPath - The path to validate
 * @returns true if path is within .swarm/replays/, false otherwise
 */
function isWithinReplaysDir(targetPath: string): boolean {
	const resolved = path.resolve(targetPath);
	const parts = resolved.split(path.sep);
	// Check that '.swarm' and 'replays' appear as consecutive segments
	for (let i = 0; i < parts.length - 1; i++) {
		if (parts[i] === '.swarm' && parts[i + 1] === 'replays') {
			return true;
		}
	}
	return false;
}

/**
 * Entry types for replay recording
 */
export type ReplayEntryType =
	| 'llm_request'
	| 'llm_response'
	| 'tool_call'
	| 'tool_result'
	| 'pattern_detected'
	| 'course_correction'
	| 'escalation'
	| 'hard_stop';

/**
 * A single entry in the replay log
 */
export interface ReplayEntry {
	/** ISO 8601 timestamp when entry was recorded */
	timestamp: string;
	/** Session identifier */
	sessionID: string;
	/** Type of replay entry */
	type: ReplayEntryType;
	/** Entry data payload */
	data: Record<string, unknown>;
}

/**
 * Sanitizes a string for safe use in filenames.
 * Allows only alphanumeric characters, underscores, and hyphens.
 * All other characters are replaced with underscores.
 *
 * @param input - String to sanitize
 * @returns Sanitized string safe for filenames
 */
function sanitizeFilename(input: string): string {
	return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Initializes replay recording for a session.
 * Creates the replay directory if it doesn't exist.
 * Non-blocking: errors are caught and logged, returns null on failure.
 *
 * @param sessionID - Session identifier
 * @param directory - Project directory
 * @returns Path to the replay artifact file, or null on error
 */
export async function startReplayRecording(
	sessionID: string,
	directory: string,
): Promise<string | null> {
	try {
		const replayDir = path.join(directory, '.swarm', 'replays');
		const safeSessionID = sanitizeFilename(sessionID);
		const filename = `${safeSessionID}-${Date.now()}.jsonl`;
		const filepath = path.join(replayDir, filename);

		// Validate path is within .swarm/replays/
		if (!isPathSafe(filepath, replayDir)) {
			// Defense-in-depth signal: under normal flow this is unreachable
			// (sanitizeFilename neutralizes traversal first), but if the guard
			// fires it signals an internal-invariant violation. Surface via
			// /swarm diagnose + debug log; never raw stderr (the attempt is
			// blocked, not corrupting — Invariant 10).
			advisoryWarn(
				`[replay] Invalid path detected - path traversal attempt blocked for session ${sessionID}`,
			);
			return null;
		}

		// Ensure directory exists
		await fs.mkdir(replayDir, { recursive: true });

		return filepath;
	} catch (err) {
		// Non-blocking: log error and return null
		logger.log(
			`[replay] Failed to start recording for session ${sessionID}: ${err}`,
		);
		return null;
	}
}

/**
 * Hard budgets for replay artifacts (issue #2041 Required 1 — the PRM budget
 * set covers replays as well as trajectories). Replays are write-only
 * best-effort diagnostics: at the cap, further entries for that artifact are
 * skipped with a one-time warning rather than rotated (rotation would create
 * unbounded sibling files, which is exactly what this cap exists to prevent).
 * The 7-day age sweep + per-directory count cap in trajectory-store's
 * `cleanupOldTrajectoryFiles` bound the directory as a whole.
 */
export const REPLAY_LIMITS = {
	/** Per-artifact byte ceiling. */
	maxBytes: 1024 * 1024,
	/** Stat cadence per artifact (bytes are tracked in memory between stats). */
	checkIntervalEntries: 16,
	/** Bound on tracked artifacts (Invariant 8). */
	maxTrackedArtifacts: 256,
} as const;

/**
 * Byte estimate per artifact path, maintained in memory and reconciled with a
 * real `stat` every `checkIntervalEntries` appends (and on first append after
 * a restart, where the estimate is unknown).
 */
const replayByteEstimates = new Map<string, number>();
const replayEntriesSinceStat = new Map<string, number>();
const replayCapWarned = new Map<string, true>();

function boundReplayMap(map: Map<string, unknown>, key: string): void {
	if (map.has(key)) return;
	while (map.size >= REPLAY_LIMITS.maxTrackedArtifacts) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/**
 * Appends a ReplayEntry to the replay artifact file, enforcing the per-artifact
 * byte cap. Non-blocking: errors are caught and logged, never thrown.
 *
 * @param artifactPath - Path to the replay artifact file
 * @param sessionID - Session identifier
 * @param entry - Entry to record (without timestamp/sessionID)
 */
export async function recordReplayEntry(
	artifactPath: string,
	sessionID: string,
	entry: Omit<ReplayEntry, 'timestamp' | 'sessionID'>,
): Promise<void> {
	try {
		// Validate artifactPath is within .swarm/replays/ using path segment validation
		if (!isWithinReplaysDir(artifactPath)) {
			logger.log(
				`[replay] Invalid artifact path - not within .swarm/replays/: ${artifactPath}`,
			);
			return;
		}

		// Byte-cap enforcement (issue #2041). The estimate starts unknown
		// (restart) and is reconciled with the real size on the stat cadence;
		// between stats the estimate only grows, so the cap errs toward
		// catching oversize slightly late, never toward dropping early.
		const sinceStat = (replayEntriesSinceStat.get(artifactPath) ?? 0) + 1;
		if (
			!replayByteEstimates.has(artifactPath) ||
			sinceStat >= REPLAY_LIMITS.checkIntervalEntries
		) {
			// ENOENT is expected before the first append (startReplayRecording
			// only prepares the path); treat it as an empty artifact.
			let sizeBytes = 0;
			try {
				sizeBytes = (await fs.stat(artifactPath)).size;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			}
			boundReplayMap(replayByteEstimates, artifactPath);
			boundReplayMap(replayEntriesSinceStat, artifactPath);
			replayByteEstimates.set(artifactPath, sizeBytes);
			replayEntriesSinceStat.set(artifactPath, 0);
		} else {
			boundReplayMap(replayEntriesSinceStat, artifactPath);
			replayEntriesSinceStat.set(artifactPath, sinceStat);
		}
		const estimatedBytes = replayByteEstimates.get(artifactPath) ?? 0;
		if (estimatedBytes >= REPLAY_LIMITS.maxBytes) {
			if (!replayCapWarned.has(artifactPath)) {
				boundReplayMap(replayCapWarned, artifactPath);
				replayCapWarned.set(artifactPath, true);
				logger.warn(
					`[replay] Artifact reached the ${REPLAY_LIMITS.maxBytes} B cap; ` +
						`further entries for this artifact are skipped (best-effort diagnostics, issue #2041)`,
				);
			}
			return;
		}

		const fullEntry: ReplayEntry = {
			timestamp: new Date().toISOString(),
			sessionID,
			...entry,
		};
		const line = `${JSON.stringify(fullEntry)}\n`;
		await fs.appendFile(artifactPath, line, 'utf-8');
		boundReplayMap(replayByteEstimates, artifactPath);
		replayByteEstimates.set(
			artifactPath,
			estimatedBytes + Buffer.byteLength(line, 'utf-8'),
		);
	} catch (err) {
		// Non-blocking: log and continue
		logger.log(`[replay] Failed to record entry: ${err}`);
	}
}

export const _test_exports = {
	isPathSafe,
	isWithinReplaysDir,
	sanitizeFilename,
	REPLAY_LIMITS,
	/** Test isolation: drop per-artifact byte-cap bookkeeping. */
	resetReplayByteTracking: (): void => {
		replayByteEstimates.clear();
		replayEntriesSinceStat.clear();
		replayCapWarned.clear();
	},
} as const;
