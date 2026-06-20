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
			console.warn(
				`[replay] Invalid path detected - path traversal attempt blocked for session ${sessionID}`,
			);
			return null;
		}

		// Ensure directory exists
		await fs.mkdir(replayDir, { recursive: true });

		return filepath;
	} catch (err) {
		// Non-blocking: log error and return null
		console.warn(
			`[replay] Failed to start recording for session ${sessionID}: ${err}`,
		);
		return null;
	}
}

/**
 * Appends a ReplayEntry to the replay artifact file.
 * Non-blocking: errors are caught and logged, never thrown.
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
			console.warn(
				`[replay] Invalid artifact path - not within .swarm/replays/: ${artifactPath}`,
			);
			return;
		}

		const fullEntry: ReplayEntry = {
			timestamp: new Date().toISOString(),
			sessionID,
			...entry,
		};
		const line = `${JSON.stringify(fullEntry)}\n`;
		await fs.appendFile(artifactPath, line, 'utf-8');
	} catch (err) {
		// Non-blocking: log error and continue
		console.warn(`[replay] Failed to record entry: ${err}`);
	}
}

export const _test_exports = {
	isPathSafe,
	isWithinReplaysDir,
	sanitizeFilename,
} as const;
