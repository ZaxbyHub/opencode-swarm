import {
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
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
	EvidenceSchema,
	type PlaceholderEvidence,
	type QualityBudgetEvidence,
	type SastEvidence,
	type SbomEvidence,
	type SecretscanEvidence,
	type SyntaxEvidence,
} from '../config/evidence-schema';
import {
	archiveEvaluationArtifacts,
	type EvaluationRetentionResult,
} from '../evaluation/retention.js';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { bunWrite } from '../utils/bun-compat';
import {
	assertProjectRoot,
	MAX_PROJECT_ROOT_DEPTH,
	PROJECT_ROOT_INDICATORS,
} from '../utils/project-boundary';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
import {
	type DocumentsRetentionResult,
	pruneEvidenceDocuments,
} from './documents-retention.js';
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
 * Options for {@link loadEvidence}.
 *
 * Additive and backward-compatible: omitting the argument entirely — which every
 * pre-existing caller does — keeps the historical behaviour exactly, including
 * the lazy in-place upgrade of a legacy flat retrospective.
 */
export interface LoadEvidenceOptions {
	/**
	 * Whether a legacy flat retrospective may be upgraded **in place** on read.
	 *
	 * `true` (the default, and the historical behaviour) persists the wrapped
	 * bundle back to `.swarm/evidence/<taskId>/evidence.json` under the evidence
	 * lock, so the repair happens once instead of on every read.
	 *
	 * `false` makes the call a pure read: the caller still receives the wrapped,
	 * validated bundle, but nothing is written, no lock is taken, and no
	 * `evidence-loader` actor appears in lock telemetry. Callers that advertise a
	 * read-only contract — the consensus corpus (`src/consensus/corpus.ts`) is the
	 * first — MUST pass `false`. A mining run that silently rewrote the evidence
	 * it was merely reading would falsify that contract and, because
	 * `LEGACY_TASK_COMPLEXITY_MAP` remaps values on the way through, would also
	 * change the stored data.
	 */
	migrate?: boolean;
}

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

/** Maximum depth to walk up the directory tree before failing closed. */
export const MAX_DEPTH = MAX_PROJECT_ROOT_DEPTH;

/** File/directory names that indicate a real project root. */
export const PROJECT_INDICATORS = PROJECT_ROOT_INDICATORS;

/**
 * Defense-in-depth: verify that `directory` is the project root and not a subdirectory
 * of a project that already has a .swarm/ at its root.
 * Walks up the directory tree (bounded by MAX_DEPTH) looking for a parent .swarm/ directory.
 * When .swarm/ is found, checks for at least one PROJECT_INDICATORS entry to distinguish
 * real projects from stray artifacts (e.g. `C:\.swarm`).
 * @throws Error if a parent directory contains both .swarm/ and a project indicator
 */
export function validateProjectRoot(directory: string): void {
	assertProjectRoot(
		directory,
		{
			realpathSync: _internals.realpathSync,
			statSync: _internals.statSync,
		},
		'evidence',
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
	abortSignal?: AbortSignal,
): Promise<EvidenceBundle> {
	abortSignal?.throwIfAborted();
	// Defense-in-depth: reject writes to subdirectories of projects that already have .swarm/
	_internals.validateProjectRoot(directory);

	// Validate task ID and resolve paths before acquiring the lock.
	const sanitizedTaskId = sanitizeTaskId(taskId);
	const relativePath = path.join('evidence', sanitizedTaskId, 'evidence.json');
	// validateSwarmPath throws synchronously on traversal — keep outside lock.
	validateSwarmPath(directory, relativePath);

	// SC-005: Validate evidence through Zod BEFORE any disk write.
	// This ensures forged verdicts (SC-005.1), manipulated timestamps (SC-005.2),
	// and spoofed task_ids (SC-005.3) are rejected at the persistence layer.
	_internals.validateEvidence(evidence);

	return withEvidenceLock(
		directory,
		relativePath,
		'evidence-manager',
		sanitizedTaskId,
		async () => {
			abortSignal?.throwIfAborted();
			const evidencePath = validateSwarmPath(directory, relativePath);
			const evidenceDir = path.dirname(evidencePath);

			// Load existing bundle or create new one
			let bundle: EvidenceBundle;
			const existingContent = await readSwarmFileAsync(directory, relativePath);
			abortSignal?.throwIfAborted();

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
				abortSignal?.throwIfAborted();
				// Commit synchronously after the abort check. An asynchronous rename
				// leaves an uncancellable window where the caller can return cancelled
				// before the durable target is published.
				renameSync(tempPath, evidencePath);
			} catch (error) {
				// Clean up temp file on failure
				try {
					rmSync(tempPath, { force: true });
				} catch {}
				throw error;
			}
			// Invalidate only after a successful rename: a failed write must leave
			// the cache pointing at the still-valid on-disk content (issue #1729
			// defect class — same-size rewrite within one fs timestamp tick would
			// otherwise let the next read observe stale pre-write content).
			invalidateCachedArtifact(evidencePath);

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
 *
 * By default this may perform a one-time in-place upgrade of a legacy flat
 * retrospective (see {@link LoadEvidenceOptions.migrate}). Pass
 * `{ migrate: false }` for a guaranteed pure read.
 */
export async function loadEvidence(
	directory: string,
	taskId: string,
	options?: LoadEvidenceOptions,
): Promise<LoadEvidenceResult> {
	// Validate task ID
	const sanitizedTaskId = sanitizeTaskId(taskId);

	// Construct relative path
	const relativePath = path.join('evidence', sanitizedTaskId, 'evidence.json');

	// Path length guard: reject paths that exceed common OS limits (e.g. Linux 4096 bytes)
	// before attempting any filesystem access. This prevents unhandled errors on
	// adversarial inputs like extremely long task IDs that would produce paths > 4096 chars.
	if (relativePath.length > 4096) {
		return { status: 'not_found' };
	}

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
			//
			// `migrate: false` skips this entire block — no lock, no temp file, no
			// rename. The caller still gets `validated`; the only thing it gives up
			// is the persistence of the repair. This is the single branch that makes
			// a read-only evidence read possible.
			if (options?.migrate === false) {
				return { status: 'found', bundle: validated };
			}
			try {
				// The read path is intentionally available to callers below a project
				// root, but the legacy migration is a write. Re-assert containment before
				// the evidence lock can create state or the repaired bundle is persisted.
				validateProjectRoot(directory);
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
							invalidateCachedArtifact(evidencePath);
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
	try {
		validateProjectRoot(directory);
	} catch {
		// Preserve the deletion contract: an unsafe or unverifiable root is a
		// failed deletion, and no filesystem mutation is attempted.
		return false;
	}

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
export type EvidenceArchiveReport = {
	inventoryEvidence: string[];
	selectedEvidence: string[];
	selectedEvidenceByAge: string[];
	selectedEvidenceByCount: string[];
	archivedEvidence: string[];
	failedEvidence: string[];
	evaluation: EvaluationRetentionResult;
	/**
	 * Documents-cache retention result (issue #1184). Always present in the
	 * report shape — a zeroed result ({ inventory: 0, selected: 0, ... })
	 * indicates the cache was not pruned (no caps configured, file missing,
	 * or prune disabled).
	 */
	documentsCache: DocumentsRetentionResult;
};

export type EvidenceArchiveReportOptions = {
	report: true;
	dryRun?: boolean;
	now?: Date;
	/**
	 * Optional documents-cache retention caps (issue #1184). When either is a
	 * positive number, `archiveEvidence` also prunes
	 * `.swarm/evidence-cache/documents.jsonl` after the bundle/evaluation
	 * sweep. When both are unset, the cache is left untouched (append-only).
	 */
	cacheMaxBytes?: number;
	cacheMaxRecords?: number;
};

export function archiveEvidence(
	directory: string,
	maxAgeDays: number,
	maxBundles?: number,
): Promise<string[]>;
export function archiveEvidence(
	directory: string,
	maxAgeDays: number,
	maxBundles: number | undefined,
	options: EvidenceArchiveReportOptions,
): Promise<EvidenceArchiveReport>;
export async function archiveEvidence(
	directory: string,
	maxAgeDays: number,
	maxBundles?: number,
	options?: EvidenceArchiveReportOptions,
): Promise<string[] | EvidenceArchiveReport> {
	const taskIds = await _internals.listEvidenceTaskIds(directory);
	const cutoffDate = options?.now ? new Date(options.now) : _internals.now();
	cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
	const cutoffIso = cutoffDate.toISOString();

	const selected = new Set<string>();
	const selectedByAge = new Set<string>();
	const selectedByCount = new Set<string>();
	const archived: string[] = [];
	const failed: string[] = [];
	const remainingBundles: Array<{ taskId: string; updatedAt: string }> = [];

	for (const taskId of taskIds) {
		let result: LoadEvidenceResult;
		try {
			result = await _internals.loadEvidence(directory, taskId);
		} catch {
			warn('archive: skipping corrupt or unreadable evidence for task', taskId);
			continue;
		}
		if (result.status !== 'found') {
			continue;
		}

		// Archive if the bundle hasn't been updated since the cutoff
		if (result.bundle.updated_at < cutoffIso) {
			selected.add(taskId);
			selectedByAge.add(taskId);
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

		// Select oldest bundles until we're within the limit
		const toDelete = remainingBundles.length - maxBundles;
		for (let i = 0; i < toDelete; i++) {
			selected.add(remainingBundles[i].taskId);
			selectedByCount.add(remainingBundles[i].taskId);
		}
	}

	if (!options?.dryRun) {
		for (const taskId of [...selected].sort()) {
			const deleted = await _internals.deleteEvidence(directory, taskId);
			if (deleted) archived.push(taskId);
			else failed.push(taskId);
		}
	}

	const evaluation = await archiveEvaluationArtifacts({
		directory,
		maxAgeDays,
		maxBundles,
		dryRun: options?.dryRun,
		now: options?.now,
	});

	// Documents-cache retention (issue #1184). Only runs when at least one cap
	// is configured. Fail-open: a cache I/O error must never break the bundle
	// archive. The zeroed result preserves the report shape for consumers.
	let documentsCache: DocumentsRetentionResult = {
		inventory: 0,
		selected: 0,
		archived: 0,
		corrupt: 0,
		bytesBefore: 0,
		bytesAfter: 0,
		dryRun: options?.dryRun === true,
		aborted: false,
	};
	if (
		(typeof options?.cacheMaxBytes === 'number' && options.cacheMaxBytes > 0) ||
		(typeof options?.cacheMaxRecords === 'number' &&
			options.cacheMaxRecords > 0)
	) {
		try {
			documentsCache = await _internals.pruneEvidenceDocuments({
				directory,
				maxBytes: options?.cacheMaxBytes,
				maxRecords: options?.cacheMaxRecords,
				dryRun: options?.dryRun,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			warn(`archiveEvidence: documents-cache prune failed (fail-open): ${msg}`);
		}
	}

	if (options?.report) {
		return {
			inventoryEvidence: [...taskIds].sort(),
			selectedEvidence: [...selected].sort(),
			selectedEvidenceByAge: [...selectedByAge].sort(),
			selectedEvidenceByCount: [...selectedByCount].sort(),
			archivedEvidence: archived.sort(),
			failedEvidence: failed.sort(),
			evaluation,
			documentsCache,
		};
	}
	return archived.sort();
}

/**
 * Validates evidence through Zod. Exposed via _internals for DI testing.
 */
function validateEvidence(evidence: Evidence): Evidence {
	return EvidenceSchema.parse(evidence);
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
	validateEvidence: typeof validateEvidence;
	saveEvidence: typeof saveEvidence;
	deleteEvidence: typeof deleteEvidence;
	pruneEvidenceDocuments: typeof pruneEvidenceDocuments;
	realpathSync: typeof realpathSync;
	statSync: typeof statSync;
	now: () => Date;
} = {
	wrapFlatRetrospective,
	loadEvidence,
	listEvidenceTaskIds,
	validateProjectRoot,
	validateEvidence,
	saveEvidence,
	deleteEvidence,
	pruneEvidenceDocuments,
	realpathSync,
	statSync,
	now: () => new Date(),
} as const;
