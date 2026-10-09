import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { ZodError } from 'zod';
import {
	type BuildEvidence,
	EVIDENCE_MAX_JSON_BYTES,
	type Evidence,
	type EvidenceBundle,
	EvidenceBundleSchema,
	type PlaceholderEvidence,
	type QualityBudgetEvidence,
	type SastEvidence,
	type SbomEvidence,
	type SyntaxEvidence,
} from '../config/evidence-schema';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { bunWrite } from '../utils/bun-compat';

/**
 * Discriminated union returned by loadEvidence.
 * - 'found': file exists and passed Zod schema validation
 * - 'not_found': file does not exist on disk
 * - 'invalid_schema': file exists but failed Zod validation; errors contains field names
 */
export type LoadEvidenceResult =
	| { status: 'found'; bundle: EvidenceBundle }
	| { status: 'not_found' }
	| { status: 'invalid_schema'; errors: string[] };

/**
 * All valid evidence types (12 total)
 */
export const VALID_EVIDENCE_TYPES = [
	'review',
	'test',
	'diff',
	'approval',
	'note',
	'retrospective',
	'syntax',
	'placeholder',
	'sast',
	'sbom',
	'build',
	'quality_budget',
] as const;

/**
 * Check if a string is a valid evidence type.
 * Returns true if the type is recognized, false otherwise.
 */
export function isValidEvidenceType(
	type: string,
): type is (typeof VALID_EVIDENCE_TYPES)[number] {
	return VALID_EVIDENCE_TYPES.includes(
		type as (typeof VALID_EVIDENCE_TYPES)[number],
	);
}

/**
 * Type guards for new evidence types
 */
export function isSyntaxEvidence(
	evidence: Evidence,
): evidence is SyntaxEvidence {
	return evidence.type === 'syntax';
}

export function isPlaceholderEvidence(
	evidence: Evidence,
): evidence is PlaceholderEvidence {
	return evidence.type === 'placeholder';
}

export function isSastEvidence(evidence: Evidence): evidence is SastEvidence {
	return evidence.type === 'sast';
}

export function isSbomEvidence(evidence: Evidence): evidence is SbomEvidence {
	return evidence.type === 'sbom';
}

export function isBuildEvidence(evidence: Evidence): evidence is BuildEvidence {
	return evidence.type === 'build';
}

export function isQualityBudgetEvidence(
	evidence: Evidence,
): evidence is QualityBudgetEvidence {
	return evidence.type === 'quality_budget';
}

/**
 * Task ID validation pattern: strict N.M or N.M.P numeric format
 * Same pattern as gate-evidence.ts and check-gate-status.ts
 * Pattern: ^\d+\.\d+(\.\d+)*$
 * Rejects: .., ../, null bytes, control characters, empty string, non-numeric IDs
 */
const TASK_ID_REGEX = /^\d+\.\d+(\.\d+)*$/;

/**
 * Retrospective evidence ID pattern: retro-<number>
 * Allows existing retrospective evidence directories like retro-1, retro-2
 * Pattern: ^retro-\d+$
 */
const RETRO_TASK_ID_REGEX = /^retro-\d+$/;

/**
 * Internal automated-tool evidence ID pattern.
 * Allows only the specific internal tool IDs: sast_scan, quality_budget,
 * syntax_check, placeholder_scan, sbom_generate, build.
 * Pattern: ^(?:sast_scan|quality_budget|syntax_check|placeholder_scan|sbom_generate|build)$
 */
const INTERNAL_TOOL_ID_REGEX =
	/^(?:sast_scan|quality_budget|syntax_check|placeholder_scan|sbom_generate|build)$/;

/**
 * Validate and sanitize task ID.
 * Accepts three formats:
 * 1. Canonical N.M or N.M.P numeric format (matches TASK_ID_REGEX)
 * 2. Retrospective format: retro-<number> (matches RETRO_TASK_ID_REGEX)
 * 3. Internal automated-tool format: specific tool IDs (sast_scan, quality_budget, syntax_check, placeholder_scan, sbom_generate, build)
 * Rejects: .., ../, null bytes, control characters, empty string, other non-numeric IDs
 * @throws Error with descriptive message on failure
 */
export function sanitizeTaskId(taskId: string): string {
	// Check for empty string
	if (!taskId || taskId.length === 0) {
		throw new Error('Invalid task ID: empty string');
	}

	// Check for null bytes
	if (/\0/.test(taskId)) {
		throw new Error('Invalid task ID: contains null bytes');
	}

	// Check for control characters (char codes < 32)
	for (let i = 0; i < taskId.length; i++) {
		if (taskId.charCodeAt(i) < 32) {
			throw new Error('Invalid task ID: contains control characters');
		}
	}

	// Check for path traversal patterns
	if (
		taskId.includes('..') ||
		taskId.includes('../') ||
		taskId.includes('..\\')
	) {
		throw new Error('Invalid task ID: path traversal detected');
	}

	// Validate against canonical numeric regex
	if (TASK_ID_REGEX.test(taskId)) {
		return taskId;
	}

	// Also accept retrospective IDs like retro-1, retro-2
	if (RETRO_TASK_ID_REGEX.test(taskId)) {
		return taskId;
	}

	// Also accept internal automated-tool IDs like sast_scan, quality_budget, etc.
	if (INTERNAL_TOOL_ID_REGEX.test(taskId)) {
		return taskId;
	}

	// Reject anything else
	throw new Error(
		`Invalid task ID: must match pattern ^\\d+\\.\\d+(\\.\\d+)*$, ^retro-\\d+$, or ^(?:sast_scan|quality_budget|syntax_check|placeholder_scan|sbom_generate|build)$, got "${taskId}"`,
	);
}

/**
 * Save evidence to a task's evidence bundle.
 * Creates new bundle if doesn't exist, appends to existing.
 * Performs atomic write via temp file + rename.
 * @throws Error if task ID is invalid or size limit would be exceeded
 */
export async function saveEvidence(
	directory: string,
	taskId: string,
	evidence: Evidence,
): Promise<EvidenceBundle> {
	// Validate task ID
	const sanitizedTaskId = sanitizeTaskId(taskId);

	// Construct and validate path
	const relativePath = path.join('evidence', sanitizedTaskId, 'evidence.json');
	const evidencePath = validateSwarmPath(directory, relativePath);
	const evidenceDir = path.dirname(evidencePath);

	// Load existing bundle or create new one
	let bundle: EvidenceBundle;
	const existingContent = await readSwarmFileAsync(directory, relativePath);

	if (existingContent !== null) {
		try {
			const parsed = JSON.parse(existingContent);
			bundle = EvidenceBundleSchema.parse(parsed);
		} catch (error) {
			// Invalid existing bundle, create new one
			warn(
				`Existing evidence bundle invalid for task ${sanitizedTaskId}, creating new: ${error instanceof Error ? error.message : String(error)}`,
			);
			const now = new Date().toISOString();
			bundle = {
				schema_version: '1.0.0',
				task_id: sanitizedTaskId,
				entries: [],
				created_at: now,
				updated_at: now,
			};
		}
	} else {
		// Create new bundle
		const now = new Date().toISOString();
		bundle = {
			schema_version: '1.0.0',
			task_id: sanitizedTaskId,
			entries: [],
			created_at: now,
			updated_at: now,
		};
	}

	// Create new bundle with appended evidence
	const updatedBundle: EvidenceBundle = {
		...bundle,
		entries: [...bundle.entries, evidence],
		updated_at: new Date().toISOString(),
	};

	// Check size limit
	const bundleJson = JSON.stringify(updatedBundle);
	if (bundleJson.length > EVIDENCE_MAX_JSON_BYTES) {
		throw new Error(
			`Evidence bundle size (${bundleJson.length} bytes) exceeds maximum (${EVIDENCE_MAX_JSON_BYTES} bytes)`,
		);
	}

	// Create directory (recursive)
	mkdirSync(evidenceDir, { recursive: true });

	// Write atomically: temp file + rename
	const tempPath = path.join(
		evidenceDir,
		`evidence.json.tmp.${Date.now()}.${process.pid}`,
	);
	try {
		await bunWrite(tempPath, bundleJson);
		renameSync(tempPath, evidencePath);
	} catch (error) {
		// Clean up temp file on failure
		try {
			rmSync(tempPath, { force: true });
		} catch {}
		throw error;
	}

	return updatedBundle;
}

/**
 * Check if a parsed object is a flat retrospective (legacy format without EvidenceBundle wrapper).
 * Flat retrospective: plain object with type === 'retrospective' but no schema_version field.
 */
function isFlatRetrospective(
	parsed: unknown,
): parsed is { type: 'retrospective'; task_id?: string; timestamp?: string } {
	return (
		parsed !== null &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed) &&
		(parsed as Record<string, unknown>).type === 'retrospective' &&
		!(parsed as Record<string, unknown>).schema_version
	);
}

/**
 * Legacy to current task_complexity value mapping.
 */
const LEGACY_TASK_COMPLEXITY_MAP: Record<string, string> = {
	low: 'simple',
	medium: 'moderate',
	high: 'complex',
};

/**
 * Remap legacy task_complexity values in an evidence entry.
 * Returns a new entry with remapped values (does not mutate).
 */
function remapLegacyTaskComplexity(
	entry: Record<string, unknown>,
): Record<string, unknown> {
	const taskComplexity = entry.task_complexity;
	if (
		typeof taskComplexity === 'string' &&
		taskComplexity in LEGACY_TASK_COMPLEXITY_MAP
	) {
		return {
			...entry,
			task_complexity: LEGACY_TASK_COMPLEXITY_MAP[taskComplexity],
		};
	}
	return entry;
}

/**
 * Transform a flat retrospective object into a valid EvidenceBundle.
 */
function wrapFlatRetrospective(
	flatEntry: Record<string, unknown>,
	taskId: string,
): EvidenceBundle {
	const now = new Date().toISOString();
	// Remap legacy task_complexity values
	const remappedEntry = remapLegacyTaskComplexity(flatEntry);
	return {
		schema_version: '1.0.0',
		task_id: (remappedEntry.task_id as string) ?? taskId,
		created_at: (remappedEntry.timestamp as string) ?? now,
		updated_at: (remappedEntry.timestamp as string) ?? now,
		entries: [remappedEntry as Evidence],
	};
}

/**
 * Load evidence bundle for a task.
 * Returns a LoadEvidenceResult discriminated union.
 */
export async function loadEvidence(
	directory: string,
	taskId: string,
): Promise<LoadEvidenceResult> {
	// Validate task ID
	const sanitizedTaskId = sanitizeTaskId(taskId);

	// Construct relative path
	const relativePath = path.join('evidence', sanitizedTaskId, 'evidence.json');
	const evidencePath = validateSwarmPath(directory, relativePath);

	// Read file
	const content = await readSwarmFileAsync(directory, relativePath);
	if (content === null) {
		return { status: 'not_found' };
	}

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { status: 'invalid_schema', errors: ['Invalid JSON'] };
	}

	// Check for flat retrospective format and transform if needed
	if (isFlatRetrospective(parsed)) {
		const wrappedBundle = wrapFlatRetrospective(parsed, sanitizedTaskId);
		// Validate the wrapped bundle
		try {
			const validated = EvidenceBundleSchema.parse(wrappedBundle);
			// Persist repaired bundle back to the same file path
			const evidenceDir = path.dirname(evidencePath);
			const bundleJson = JSON.stringify(validated);
			const tempPath = path.join(
				evidenceDir,
				`evidence.json.tmp.${Date.now()}.${process.pid}`,
			);
			try {
				await bunWrite(tempPath, bundleJson);
				renameSync(tempPath, evidencePath);
			} catch (writeError) {
				// Clean up temp file on failure
				try {
					rmSync(tempPath, { force: true });
				} catch {}
				warn(
					`Failed to persist repaired flat retrospective for task ${sanitizedTaskId}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
				);
				// Still return the validated bundle even if write failed
			}
			return { status: 'found', bundle: validated };
		} catch (error) {
			// This shouldn't happen since we constructed it, but handle gracefully
			warn(
				`Wrapped flat retrospective failed validation for task ${sanitizedTaskId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			const errors =
				error instanceof ZodError
					? error.issues.map((e) => `${e.path.join('.')}: ${e.message}`)
					: [String(error)];
			return { status: 'invalid_schema', errors };
		}
	}

	// Parse and validate
	try {
		const validated = EvidenceBundleSchema.parse(parsed);
		return { status: 'found', bundle: validated };
	} catch (error) {
		warn(
			`Evidence bundle validation failed for task ${sanitizedTaskId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		const errors =
			error instanceof ZodError
				? error.issues.map((e) => `${e.path.join('.')}: ${e.message}`)
				: [String(error)];
		return { status: 'invalid_schema', errors };
	}
}

/**
 * List all task IDs that have evidence bundles.
 * Returns sorted array of valid task IDs.
 * Returns empty array if evidence directory doesn't exist.
 */
export async function listEvidenceTaskIds(
	directory: string,
): Promise<string[]> {
	// Validate evidence base directory path
	const evidenceBasePath = validateSwarmPath(directory, 'evidence');

	// Check if directory exists
	try {
		statSync(evidenceBasePath);
	} catch {
		return [];
	}

	// Read directory entries
	let entries: string[];
	try {
		entries = readdirSync(evidenceBasePath);
	} catch {
		return [];
	}

	// Filter to only valid task ID directories
	const taskIds: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(evidenceBasePath, entry);
		try {
			// Check if it's a directory
			const stats = statSync(entryPath);
			if (!stats.isDirectory()) {
				continue;
			}

			// Validate as task ID
			sanitizeTaskId(entry);
			taskIds.push(entry);
		} catch (error) {
			// Only log unexpected errors (not invalid task ID names)
			if (
				error instanceof Error &&
				!error.message.startsWith('Invalid task ID')
			) {
				warn(`Error reading evidence entry '${entry}': ${error.message}`);
			}
		}
	}

	// Return sorted
	return taskIds.sort();
}

/**
 * Delete evidence bundle for a task.
 * Returns true if deleted, false if didn't exist or deletion failed.
 */
export async function deleteEvidence(
	directory: string,
	taskId: string,
): Promise<boolean> {
	// Validate task ID
	const sanitizedTaskId = sanitizeTaskId(taskId);

	// Construct and validate path
	const relativePath = path.join('evidence', sanitizedTaskId);
	const evidenceDir = validateSwarmPath(directory, relativePath);

	// Check if directory exists first
	try {
		statSync(evidenceDir);
	} catch {
		return false;
	}

	// Delete directory recursively
	try {
		rmSync(evidenceDir, { recursive: true, force: true });
		return true;
	} catch (error) {
		warn(
			`Failed to delete evidence for task ${sanitizedTaskId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Archive old evidence bundles based on retention policy.
 * Removes evidence older than maxAgeDays.
 * If maxBundles is provided, enforces a maximum bundle count by deleting oldest first.
 * Returns array of archived (deleted) task IDs.
 */
export async function archiveEvidence(
	directory: string,
	maxAgeDays: number,
	maxBundles?: number,
): Promise<string[]> {
	const taskIds = await listEvidenceTaskIds(directory);
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
	const cutoffIso = cutoffDate.toISOString();

	const archived: string[] = [];
	const remainingBundles: Array<{ taskId: string; updatedAt: string }> = [];

	for (const taskId of taskIds) {
		const result = await loadEvidence(directory, taskId);
		if (result.status !== 'found') {
			continue;
		}

		// Archive if the bundle hasn't been updated since the cutoff
		if (result.bundle.updated_at < cutoffIso) {
			const deleted = await deleteEvidence(directory, taskId);
			if (deleted) {
				archived.push(taskId);
			}
		} else {
			// Track remaining bundles for maxBundles enforcement
			remainingBundles.push({
				taskId,
				updatedAt: result.bundle.updated_at,
			});
		}
	}

	// Enforce maxBundles limit if specified
	if (maxBundles !== undefined && remainingBundles.length > maxBundles) {
		// Sort by updated_at ascending (oldest first)
		remainingBundles.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

		// Delete oldest bundles until we're within the limit
		const toDelete = remainingBundles.length - maxBundles;
		for (let i = 0; i < toDelete; i++) {
			const deleted = await deleteEvidence(
				directory,
				remainingBundles[i].taskId,
			);
			if (deleted) {
				archived.push(remainingBundles[i].taskId);
			}
		}
	}

	return archived;
}
