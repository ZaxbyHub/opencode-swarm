import {
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
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
	type SecretscanEvidence,
	type SyntaxEvidence,
} from '../config/evidence-schema';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { bunWrite } from '../utils/bun-compat';
import { withEvidenceLock } from './lock.js';

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
 * All valid evidence types (13 total)
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
	'secretscan',
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
 * Type guard for secretscan evidence
 */
export function isSecretscanEvidence(
	evidence: Evidence,
): evidence is SecretscanEvidence {
	return evidence.type === 'secretscan';
}

// Task ID validation is consolidated in src/validation/task-id.ts (#452 item 2).
// Re-export sanitizeTaskId for backward compatibility with existing callers.
import { sanitizeTaskId as _sanitizeTaskId } from '../validation/task-id';

export const sanitizeTaskId = _sanitizeTaskId;

/** Maximum depth to walk up the directory tree before stopping (fail-open). */
export const MAX_DEPTH = 20;

/** File/directory names that indicate a real project root. */
export const PROJECT_INDICATORS = [
	'package.json',
	'.git',
	'.opencode',
	'Cargo.toml',
	'go.mod',
	'pyproject.toml',
	'Gemfile',
	'composer.json',
	'pom.xml',
	'build.gradle',
	'CMakeLists.txt',
] as const;

/**
 * Defense-in-depth: verify that `directory` is the project root and not a subdirectory
 * of a project that already has a .swarm/ at its root.
 * Walks up the directory tree (bounded by MAX_DEPTH) looking for a parent .swarm/ directory.
 * When .swarm/ is found, checks for at least one PROJECT_INDICATORS entry to distinguish
 * real projects from stray artifacts (e.g. `C:\.swarm`).
 * @throws Error if a parent directory contains both .swarm/ and a project indicator
 */
export function validateProjectRoot(directory: string): void {
	let resolved: string;
	try {
		resolved = realpathSync(directory);
	} catch {
		warn(
			`[evidence] Cannot canonicalize directory "${directory}" — failing closed`,
		);
		throw new Error(
			`Cannot verify project root for "${directory}" — directory may not exist or is inaccessible`,
		);
	}
	let current = resolved;
	let depth = 0;
	while (true) {
		if (depth >= MAX_DEPTH) break; // depth limit — fail open
		depth++;
		const parent = path.dirname(current);
		if (parent === current) break; // reached filesystem root
		const parentSwarm = path.join(parent, '.swarm');
		try {
			if (statSync(parentSwarm).isDirectory()) {
				// Check for at least one project indicator to confirm this is a real project
				let hasProjectIndicator = false;
				for (const indicator of PROJECT_INDICATORS) {
					try {
						const indicatorStat = statSync(path.join(parent, indicator));
						if (indicatorStat.isFile() || indicatorStat.isDirectory()) {
							hasProjectIndicator = true;
							break;
						}
					} catch (error) {
						if (
							error instanceof Error &&
							'code' in error &&
							(error as NodeJS.ErrnoException).code === 'ENOENT'
						) {
							// indicator doesn't exist — continue checking next one
						} else {
							// Non-ENOENT error (EPERM, EBUSY, etc.) — can't verify, assume indicator present (fail-closed)
							hasProjectIndicator = true;
							break;
						}
					}
				}
				if (hasProjectIndicator) {
					warn(
						`[evidence] Rejecting write to subdirectory "${resolved}" — parent "${parent}" already contains .swarm/`,
					);
					throw new Error(
						`Cannot write evidence in "${resolved}" — parent directory "${parent}" already contains a .swarm/ folder. Evidence must be written to the project root.`,
					);
				}
				// No project indicators found — treat as stray artifact, continue walking
			}
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith('Cannot write evidence')
			) {
				throw error;
			}
			// statSync failing means .swarm doesn't exist — continue walking
		}
		current = parent;
	}
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
	// Defense-in-depth: reject writes to subdirectories of projects that already have .swarm/
	_internals.validateProjectRoot(directory);

	// Validate task ID and resolve paths before acquiring the lock.
	const sanitizedTaskId = sanitizeTaskId(taskId);
	const relativePath = path.join('evidence', sanitizedTaskId, 'evidence.json');
	// validateSwarmPath throws synchronously on traversal — keep outside lock.
	validateSwarmPath(directory, relativePath);

	return withEvidenceLock(
		directory,
		relativePath,
		'evidence-manager',
		sanitizedTaskId,
		async () => {
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

			// Trim oldest entries if bundle exceeds max entry count to prevent unbounded
			// growth from continuously-appended bundles (e.g. retro-session) (#444 item 10)
			const MAX_BUNDLE_ENTRIES = 100;
			let entries = [...bundle.entries, evidence];
			if (entries.length > MAX_BUNDLE_ENTRIES) {
				entries = entries.slice(entries.length - MAX_BUNDLE_ENTRIES);
			}

			// Create new bundle with appended evidence
			const updatedBundle: EvidenceBundle = {
				...bundle,
				entries,
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

			// Write atomically: temp file + rename (unchanged semantics)
			const tempPath = path.join(
				evidenceDir,
				`evidence.json.tmp.${Date.now()}.${process.pid}`,
			);
			try {
				await bunWrite(tempPath, bundleJson);
				await fs.rename(tempPath, evidencePath);
			} catch (error) {
				// Clean up temp file on failure
				try {
					rmSync(tempPath, { force: true });
				} catch {}
				throw error;
			}

			return updatedBundle;
		},
	);
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
		const wrappedBundle = _internals.wrapFlatRetrospective(
			parsed,
			sanitizedTaskId,
		);
		// Validate the wrapped bundle
		try {
			const validated = EvidenceBundleSchema.parse(wrappedBundle);
			// Persist repaired bundle under the evidence lock so the write-back
			// cannot race with a concurrent saveEvidence call.
			// Non-fatal: read-only return value is valid even if write-back fails.
			try {
				await withEvidenceLock(
					directory,
					relativePath,
					'evidence-loader',
					sanitizedTaskId,
					async () => {
						const evidenceDir = path.dirname(evidencePath);
						const bundleJson = JSON.stringify(validated);
						const tempPath = path.join(
							evidenceDir,
							`evidence.json.tmp.${Date.now()}.${process.pid}`,
						);
						try {
							await bunWrite(tempPath, bundleJson);
							await fs.rename(tempPath, evidencePath);
						} catch (writeError) {
							try {
								rmSync(tempPath, { force: true });
							} catch {}
							warn(
								`Failed to persist repaired flat retrospective for task ${sanitizedTaskId}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
							);
						}
					},
				);
			} catch (lockErr) {
				// EvidenceLockTimeoutError or unexpected lock error — non-fatal.
				// The flat-retrospective format upgrade will be retried on the next
				// loadEvidence call; the validated bundle is returned to this caller.
				warn(
					`Evidence lock failed during flat-retrospective write-back for task ${sanitizedTaskId}: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`,
				);
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
					: [error instanceof Error ? error.message : String(error)];
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
				: [error instanceof Error ? error.message : String(error)];
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
 * Check if a requirement coverage file exists for a given phase.
 * Looks for .swarm/evidence/req-coverage-phase-{N}.json
 */
export async function checkRequirementCoverage(
	phase: number,
	directory: string,
): Promise<{ exists: boolean; path: string }> {
	const relativePath = path.join(
		'evidence',
		`req-coverage-phase-${phase}.json`,
	);
	const absolutePath = path.resolve(directory, '.swarm', relativePath);

	try {
		await fs.access(absolutePath);
		return { exists: true, path: absolutePath };
	} catch {
		return { exists: false, path: absolutePath };
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
	const taskIds = await _internals.listEvidenceTaskIds(directory);
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
	const cutoffIso = cutoffDate.toISOString();

	const archived: string[] = [];
	const remainingBundles: Array<{ taskId: string; updatedAt: string }> = [];

	for (const taskId of taskIds) {
		const result = await _internals.loadEvidence(directory, taskId);
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

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	wrapFlatRetrospective: typeof wrapFlatRetrospective;
	loadEvidence: typeof loadEvidence;
	listEvidenceTaskIds: typeof listEvidenceTaskIds;
	validateProjectRoot: typeof validateProjectRoot;
} = {
	wrapFlatRetrospective,
	loadEvidence,
	listEvidenceTaskIds,
	validateProjectRoot,
} as const;
