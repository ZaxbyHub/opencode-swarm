/**
 * Lean Turbo Lane Evidence Module.
 *
 * Writes and reads lane-level and phase-level evidence for Lean Turbo executions.
 * Evidence files are stored under `.swarm/evidence/{phase}/lean-turbo/`:
 *
 * - `{laneId}.json` — per-lane evidence
 * - `lean-turbo-phase.json` — aggregated phase evidence
 *
 * All writes use atomic temp+rename to prevent partial-file artifacts on failure.
 */
import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bunWrite } from '../../utils/bun-compat';

/**
 * Evidence record for a single lane.
 */
export interface LaneEvidence {
	laneId: string;
	taskIds: string[];
	files: string[];
	status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
	startedAt?: string;
	completedAt?: string;
	error?: string;
	agent?: string;
	sessionId?: string;
}

import type { LeanTurboConfig } from '../../config/schema';

/**
 * Aggregated evidence for an entire Lean Turbo phase.
 */
export interface PhaseEvidence {
	phase: number;
	planId: string;
	lanes: LaneEvidence[];
	degradedTasks: { taskId: string; reason: string }[];
	startedAt: string;
	completedAt?: string;
	status: 'running' | 'completed' | 'failed';
	/** Paths to lane evidence files (e.g., `.swarm/evidence/{phase}/lean-turbo/{laneId}.json`) */
	evidencePaths?: string[];
	/** Summary of integrated diff across all lanes */
	integratedDiffSummary?: string;
	/** Integrated reviewer verdict */
	reviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	/** Critic verdict */
	criticVerdict?:
		| 'APPROVED'
		| 'NEEDS_REVISION'
		| 'REJECTED'
		| 'ESCALATE_TO_HUMAN';
	/** Snapshot of lean turbo config used for this phase */
	configSnapshot?: LeanTurboConfig;
	/** ISO timestamp when phase evidence was written (distinct from startedAt/completedAt) */
	timestamp?: string;
}

/**
 * Derives the lean-turbo evidence directory for a given phase.
 */
function leanTurboEvidenceDir(directory: string, phase: number): string {
	return path.join(
		directory,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
}

/**
 * Validates a laneId to prevent path traversal attacks.
 *
 * Rejects laneIds that:
 * - Contain path separators (/ or \\)
 * - Contain .. segments
 * - Are absolute paths (starting with / or drive letters like C:)
 * - Are empty strings
 * - Exceed 128 characters
 *
 * @throws Error with descriptive message if laneId is invalid
 */
function validateLaneId(laneId: string): void {
	if (laneId.length === 0) {
		throw new Error(`Invalid laneId: empty string is not allowed`);
	}
	if (laneId.length > 128) {
		throw new Error(
			`Invalid laneId: exceeds maximum length of 128 characters (got ${laneId.length})`,
		);
	}
	if (laneId.includes('/') || laneId.includes('\\')) {
		throw new Error(
			`Invalid laneId: path separators are not allowed (got "${laneId}")`,
		);
	}
	if (laneId.includes('..')) {
		throw new Error(
			`Invalid laneId: parent-directory references are not allowed (got "${laneId}")`,
		);
	}
	// Check for absolute paths (starting with / or drive letter like C:)
	if (laneId.startsWith('/') || /^[a-zA-Z]:/i.test(laneId)) {
		throw new Error(
			`Invalid laneId: absolute paths are not allowed (got "${laneId}")`,
		);
	}
}

/**
 * Derives the lane evidence file path for a given lane.
 *
 * @throws Error if laneId fails validation
 */
function laneEvidencePath(
	directory: string,
	phase: number,
	laneId: string,
): string {
	validateLaneId(laneId);

	const expectedDir = leanTurboEvidenceDir(directory, phase);
	const resolvedPath = path.resolve(path.join(expectedDir, `${laneId}.json`));
	const resolvedDir = path.resolve(expectedDir);

	// Ensure the resolved path is actually contained within the expected directory
	if (
		!resolvedPath.startsWith(resolvedDir + path.sep) &&
		resolvedPath !== resolvedDir
	) {
		throw new Error(
			`Invalid laneId: path traversal detected (got "${laneId}")`,
		);
	}

	return resolvedPath;
}

/**
 * Performs atomic JSON write using temp file + rename pattern.
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON and write
 */
async function atomicWriteJson<T>(filePath: string, data: T): Promise<void> {
	const content = JSON.stringify(data, null, 2);
	const dir = path.dirname(filePath);

	// Ensure parent directory exists
	await fs.mkdir(dir, { recursive: true });

	// Atomic write: temp file in same directory, then rename
	const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	try {
		await bunWrite(tempPath, content);
		await fs.rename(tempPath, filePath);
	} catch (error) {
		// Clean up temp file on failure
		try {
			rmSync(tempPath, { force: true });
		} catch {}
		throw error;
	}
}

/**
 * Derives the phase evidence file path.
 */
function phaseEvidencePath(directory: string, phase: number): string {
	return path.join(
		leanTurboEvidenceDir(directory, phase),
		'lean-turbo-phase.json',
	);
}

/**
 * Writes a single lane's evidence to disk.
 *
 * Uses atomic write (temp file + rename) so readers never see a partial file.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @param evidence - Lane evidence to persist
 * @throws Error if laneId fails validation
 */
export async function writeLaneEvidence(
	directory: string,
	phase: number,
	evidence: LaneEvidence,
): Promise<void> {
	const targetPath = laneEvidencePath(directory, phase, evidence.laneId);
	await atomicWriteJson(targetPath, evidence);
}

/**
 * Reads a single lane's evidence from disk.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @param laneId - Lane identifier
 * @returns Parsed LaneEvidence, or null if file does not exist or is invalid
 * @throws Error if laneId fails validation
 */
export async function readLaneEvidence(
	directory: string,
	phase: number,
	laneId: string,
): Promise<LaneEvidence | null> {
	const targetPath = laneEvidencePath(directory, phase, laneId);

	let content: string;
	try {
		content = await fs.readFile(targetPath, 'utf-8');
	} catch (error) {
		// ENOENT / ENOTDIR means file doesn't exist — not an error
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return null;
		}
		throw error;
	}

	try {
		return JSON.parse(content) as LaneEvidence;
	} catch {
		// Invalid JSON — treat as missing
		return null;
	}
}

/**
 * Writes phase-level aggregated evidence to disk.
 *
 * Uses atomic write (temp file + rename).
 *
 * @param directory - Project root directory
 * @param evidence - Phase evidence to persist
 */
export async function writePhaseEvidence(
	directory: string,
	evidence: PhaseEvidence,
): Promise<void> {
	const targetPath = phaseEvidencePath(directory, evidence.phase);
	await atomicWriteJson(targetPath, evidence);
}

/**
 * Reads phase-level aggregated evidence from disk.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @returns Parsed PhaseEvidence, or null if file does not exist or is invalid
 */
export async function readPhaseEvidence(
	directory: string,
	phase: number,
): Promise<PhaseEvidence | null> {
	const targetPath = phaseEvidencePath(directory, phase);

	let content: string;
	try {
		content = await fs.readFile(targetPath, 'utf-8');
	} catch (error) {
		// ENOENT / ENOTDIR means file doesn't exist — not an error
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return null;
		}
		throw error;
	}

	try {
		return JSON.parse(content) as PhaseEvidence;
	} catch {
		// Invalid JSON — treat as missing
		return null;
	}
}

/**
 * Lists all lane evidence files for a given phase.
 *
 * Reads every `.json` file in the lean-turbo evidence directory and returns
 * parsed LaneEvidence objects. Files that cannot be read or parsed are skipped.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @returns Array of LaneEvidence, skipping any invalid files
 */
export async function listLaneEvidence(
	directory: string,
	phase: number,
): Promise<LaneEvidence[]> {
	const evidenceDir = leanTurboEvidenceDir(directory, phase);

	let entries: string[];
	try {
		entries = await fs.readdir(evidenceDir);
	} catch (error) {
		// Directory doesn't exist — return empty list
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return [];
		}
		throw error;
	}

	const lanes: LaneEvidence[] = [];

	for (const entry of entries) {
		if (!entry.endsWith('.json')) {
			continue;
		}
		// Skip the phase-level file
		if (entry === 'lean-turbo-phase.json') {
			continue;
		}

		const filePath = path.join(evidenceDir, entry);
		let content: string;
		try {
			content = await fs.readFile(filePath, 'utf-8');
		} catch {
			// Skip files that can't be read
			continue;
		}

		try {
			const parsed = JSON.parse(content) as LaneEvidence;
			lanes.push(parsed);
		} catch {}
	}

	return lanes;
}
