/**
 * Post-Agent Context Map Update Module
 *
 * After an agent completes a task, this module updates the Context Map with
 * the task's results — files touched, implementation summary,
 * rejection/review findings, and decisions made. This is the "write-back"
 * half of the context map lifecycle.
 *
 * All functions use the `_internals` DI seam pattern so tests can override
 * dependencies without `mock.module` (which leaks across files in Bun's
 * shared test-runner process).
 *
 * State lives exclusively under `.swarm/` (Invariant 4). No `process.cwd()`
 * usage — every function accepts an explicit `directory` parameter.
 *
 * No `bun:` imports — this module is Node-ESM-loadable (Invariant 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
	ContextMap,
	DecisionEntry,
	FileContextEntry,
	TaskContextSummary,
} from '../types/context-map';
import { extractFileSummary } from './file-summary';
import {
	appendDecision,
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from './persistence';

// ---------------------------------------------------------------------------
// Parameter interface
// ---------------------------------------------------------------------------

/**
 * Parameters for updating the Context Map after an agent completes a task.
 * Captures all relevant context from the agent's work session so that
 * future agents can understand what happened without re-reading evidence files.
 */
export interface PostAgentUpdateParams {
	/** Task ID (e.g. "1.1", "2.3") */
	task_id: string;
	/** Agent role that completed (coder, reviewer, etc.) */
	agent_role: string;
	/** Files the agent touched/modified */
	files_touched: string[];
	/** Brief summary of what the agent did */
	implementation_summary: string;
	/** Task goal description */
	task_goal: string;
	/** Final status of the task */
	final_status: 'completed' | 'failed' | 'blocked' | 'cancelled';
	/** Reviewer rejection reasons (if any) */
	rejection_reasons?: string[];
	/** Review findings (if any) */
	review_findings?: string[];
	/** Decisions made during this task */
	decisions?: Array<{ decision: string; rationale: string }>;
	/** Project root directory */
	directory: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counter for generating unique decision IDs within this module.
 * Increments monotonically across the lifetime of the module.
 */
let decisionCounter = 0;

/**
 * Generate a unique decision ID using a simple counter prefix.
 */
function nextDecisionId(): string {
	decisionCounter += 1;
	return `A${decisionCounter}`;
}

/**
 * Derive a TaskContextSummary-compatible final_status from the agent's
 * reported status and reviewer rejection reasons.
 *
 * If rejection_reasons are present, the task is "rejected" regardless of
 * the agent's self-reported status. Otherwise the mapping is:
 * completed -> approved, failed -> rejected, blocked -> blocked,
 * cancelled -> rejected.
 */
function deriveFinalStatus(
	params: PostAgentUpdateParams,
): TaskContextSummary['final_status'] {
	if (params.rejection_reasons && params.rejection_reasons.length > 0) {
		return 'rejected';
	}

	switch (params.final_status) {
		case 'completed':
			return 'approved';
		case 'failed':
			return 'rejected';
		case 'blocked':
			return 'blocked';
		case 'cancelled':
			return 'rejected';
	}
}

/**
 * Read the content of a file at the given absolute path.
 * Returns null if the file doesn't exist or can't be read.
 * Never throws.
 */
function readFileContent(absolutePath: string): string | null {
	try {
		if (!_internals.existsSync(absolutePath)) {
			return null;
		}
		return _internals.readFileSync(absolutePath, 'utf-8');
	} catch {
		return null;
	}
}

/**
 * Refresh a FileContextEntry for a touched file.
 *
 * Reads the file content from disk, calls extractFileSummary to get
 * an updated entry, and merges with the existing entry to preserve
 * accumulated fields (invariants, risks, tests, last_seen_task_ids).
 *
 * If the file can't be read, returns null (entry is skipped).
 */
function refreshFileEntry(
	relativePath: string,
	absolutePath: string,
	existingEntry: FileContextEntry | undefined,
): FileContextEntry | null {
	const content = readFileContent(absolutePath);
	if (content === null) {
		return null;
	}
	return _internals.extractFileSummary(
		relativePath,
		content,
		absolutePath,
		existingEntry,
	);
}

// ---------------------------------------------------------------------------
// DI seam — tests override these functions without touching real modules
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls through this
 * object so tests can replace the underlying implementations without
 * `mock.module` (which leaks across files in Bun's shared test-runner process).
 * Mutating this local object is file-scoped and trivially restorable
 * via `afterEach`.
 */
export const _internals = {
	loadContextMap,
	saveContextMap,
	createEmptyContextMap,
	extractFileSummary,
	existsSync: fs.existsSync,
	readFileSync: fs.readFileSync,
	readdirSync: fs.readdirSync,
	realpathSync: fs.realpathSync,
	appendTaskHistory,
	appendDecision,
};

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

/**
 * Extract reviewer/critic findings from .swarm/evidence/ files for a task.
 *
 * Looks for reviewer and test-engineer evidence files under
 * `.swarm/evidence/{taskId}/`, parses them, and returns consolidated
 * rejection reasons and findings.
 *
 * Tries both `test-engineer.json` and `test_engineer.json` filenames to
 * handle naming inconsistencies across the repo.
 *
 * Evidence files may contain:
 * - `verdict`: string (e.g. "APPROVED", "approved", "pass", "REJECTED") —
 *   non-approval verdicts are collected as rejection reasons. Case-insensitive.
 * - `issues`: array of objects with a `message`, `detail`, or `description`
 *   string field — each is collected as a finding.
 * - `findings`: array of objects with a `message`, `detail`, or `description`
 *   string field — also collected as findings.
 *
 * Never throws — returns empty arrays on any error (missing directory,
 * unreadable files, malformed JSON, etc.).
 *
 * @param taskId - Task ID (e.g. "1.1", "2.3")
 * @param directory - Project root directory
 * @returns Consolidated rejection reasons and review findings from evidence
 */
export function extractEvidenceFindings(
	taskId: string,
	directory: string,
): { rejection_reasons: string[]; review_findings: string[] } {
	const result: { rejection_reasons: string[]; review_findings: string[] } = {
		rejection_reasons: [],
		review_findings: [],
	};

	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence', taskId);
		if (!_internals.existsSync(evidenceDir)) {
			return result;
		}

		const evidenceFiles: readonly string[] =
			_internals.readdirSync(evidenceDir);
		const targetFiles = [
			'evidence.json',
			'reviewer.json',
			'test-engineer.json',
			'test_engineer.json',
		];

		for (const fileName of evidenceFiles) {
			if (!targetFiles.includes(fileName)) {
				continue;
			}

			const filePath = path.join(evidenceDir, fileName);
			const content = readFileContent(filePath);
			if (content === null) {
				continue;
			}

			try {
				const parsed: unknown = JSON.parse(content);
				if (
					typeof parsed !== 'object' ||
					parsed === null ||
					Array.isArray(parsed)
				) {
					continue;
				}

				const obj = parsed as Record<string, unknown>;

				// EvidenceBundle format: entries[] array wraps verdict/issues/findings.
				// Legacy/flat format: verdict/issues/findings sit at the top level.
				if (Array.isArray(obj.entries)) {
					for (const entry of obj.entries) {
						if (
							typeof entry !== 'object' ||
							entry === null ||
							Array.isArray(entry)
						) {
							continue;
						}

						const entryObj = entry as Record<string, unknown>;

						// Only process actionable review/test entries; skip neutral
						// types like 'info' or 'note' that are not gate verdicts.
						const entryType = String(entryObj.type ?? '').toLowerCase();
						const isActionable =
							entryType === 'review' ||
							entryType === 'test' ||
							entryType === 'reviewer' ||
							entryType === 'test_engineer' ||
							entryType === 'test-engineer';

						// Extract verdict from actionable entries only
						if (isActionable && typeof entryObj.verdict === 'string') {
							const normalizedVerdict = String(entryObj.verdict).toLowerCase();
							const isRejection =
								normalizedVerdict === 'rejected' ||
								normalizedVerdict === 'fail' ||
								normalizedVerdict === 'concerns';
							if (isRejection) {
								result.rejection_reasons.push(
									`[${fileName.replace('.json', '')}] ${entryObj.verdict}`,
								);
							}
						}

						// Extract issues/findings from actionable entries only
						if (isActionable) {
							const entryIssues = entryObj.issues || entryObj.findings || [];
							if (Array.isArray(entryIssues)) {
								for (const issue of entryIssues) {
									const issueText =
										typeof issue === 'object' && issue !== null
											? String(
													(issue as Record<string, unknown>).message ||
														(issue as Record<string, unknown>).detail ||
														(issue as Record<string, unknown>).description ||
														'',
												)
											: String(issue);
									if (issueText) {
										result.review_findings.push(issueText);
									}
								}
							}

							// Extract test failures[] for test-type entries
							const entryFailures = entryObj.failures;
							if (Array.isArray(entryFailures)) {
								for (const failure of entryFailures) {
									const failureText =
										typeof failure === 'object' && failure !== null
											? String(
													(failure as Record<string, unknown>).message ||
														(failure as Record<string, unknown>).detail ||
														String(failure),
												)
											: String(failure);
									if (failureText) {
										result.review_findings.push(failureText);
									}
								}
							}
						}
					}
				} else {
					// Legacy/flat format — verdict and issues/findings at top level

					// Only treat explicit rejection verdicts as rejections.
					// Neutral verdicts (info, note, etc.) are not rejections.
					if (typeof obj.verdict === 'string') {
						const normalizedVerdict = String(obj.verdict).toLowerCase();
						const isRejection =
							normalizedVerdict === 'rejected' ||
							normalizedVerdict === 'fail' ||
							normalizedVerdict === 'concerns';
						if (isRejection) {
							result.rejection_reasons.push(
								`[${fileName.replace('.json', '')}] ${obj.verdict}`,
							);
						}
					}

					// Extract issues array — try multiple field names used
					// across the repo: message, detail, description
					if (Array.isArray(obj.issues)) {
						for (const issue of obj.issues) {
							const issueText =
								typeof issue === 'object' && issue !== null
									? String(
											(issue as Record<string, unknown>).message ||
												(issue as Record<string, unknown>).detail ||
												(issue as Record<string, unknown>).description ||
												'',
										)
									: String(issue);
							if (issueText) {
								result.review_findings.push(issueText);
							}
						}
					}

					// Extract findings array — same multi-field fallback
					if (Array.isArray(obj.findings)) {
						for (const finding of obj.findings) {
							if (typeof finding === 'object' && finding !== null) {
								const findingText = String(
									(finding as Record<string, unknown>).message ||
										(finding as Record<string, unknown>).detail ||
										(finding as Record<string, unknown>).description ||
										'',
								);
								if (findingText) {
									result.review_findings.push(findingText);
								}
							}
						}
					}
				}
			} catch {
				// Malformed JSON in evidence file — skip silently
			}
		}
	} catch {
		// Any filesystem or parsing error — return what we have
	}

	return result;
}

// ---------------------------------------------------------------------------
// Main update function
// ---------------------------------------------------------------------------

/**
 * Update the Context Map after an agent completes a task.
 *
 * This is the "write-back" half of the context map lifecycle. It:
 * 1. Loads the existing context map (or creates an empty one)
 * 2. Refreshes file summaries for all touched files, preserving accumulated data
 * 3. Appends a TaskContextSummary entry for the completed task
 * 4. Appends any architectural decisions made during the task
 * 5. Saves the updated map and returns it
 *
 * Never throws — on any error, returns the best-effort context map
 * (either the existing one or a fresh empty one).
 *
 * @param params - Parameters describing the completed task and its results
 * @returns The updated ContextMap
 */
export function updateContextMapAfterAgent(
	params: PostAgentUpdateParams,
): ContextMap {
	try {
		// 1. Load existing map or create empty
		let map = _internals.loadContextMap(params.directory);
		if (map === null) {
			map = _internals.createEmptyContextMap();
		}

		// 2. Refresh file summaries for touched files
		const root = path.resolve(params.directory);
		const updatedFiles: Record<string, FileContextEntry> = {
			...map.files,
		};
		const validFiles: string[] = [];

		for (const filePath of params.files_touched) {
			try {
				const resolved = path.resolve(root, filePath);

				// Realpath containment — prevents symlink escape.
				// Resolve both root and target through realpath so that
				// symlinks pointing outside the project root are detected
				// and skipped.
				const realRoot = _internals.realpathSync(root);
				const realResolved = _internals.realpathSync(resolved);
				const relative = path.relative(realRoot, realResolved);
				if (relative.startsWith('..') || path.isAbsolute(relative)) {
					continue; // skip paths outside project root (including symlink escapes)
				}

				// Normalize Windows backslashes to POSIX forward slashes so
				// context-map keys are consistent across platforms.
				const normalizedRelative = relative.replace(/\\/g, '/');

				const existingEntry = map.files[normalizedRelative];
				const refreshed = refreshFileEntry(
					normalizedRelative,
					resolved,
					existingEntry,
				);
				if (refreshed !== null) {
					updatedFiles[normalizedRelative] = refreshed;
				}
				validFiles.push(normalizedRelative);
			} catch {}
		}

		map = { ...map, files: updatedFiles };

		// 3. Build and append TaskContextSummary
		// Auto-extract evidence findings from .swarm/evidence/
		const evidenceFindings = extractEvidenceFindings(
			params.task_id,
			params.directory,
		);

		// Merge: params take priority, evidence fills in missing findings
		const rejectionReasons = params.rejection_reasons ?? [];
		const reviewFindings = params.review_findings ?? [];
		const mergedRejectionReasons = [
			...rejectionReasons,
			...evidenceFindings.rejection_reasons.filter(
				(r) => !rejectionReasons.includes(r),
			),
		];
		const mergedReviewFindings = [
			...reviewFindings,
			...evidenceFindings.review_findings.filter(
				(f) => !reviewFindings.includes(f),
			),
		];

		// Combine rejection reasons and review findings into reviewer_findings
		const reviewerFindings: string[] = [
			...mergedRejectionReasons.map((r) => `[rejection] ${r}`),
			...mergedReviewFindings,
		];

		const taskSummary: TaskContextSummary = {
			task_id: params.task_id,
			goal: params.task_goal,
			files_touched: validFiles,
			implementation_summary: params.implementation_summary,
			reviewer_findings:
				reviewerFindings.length > 0 ? reviewerFindings : undefined,
			final_status:
				mergedRejectionReasons.length > 0
					? ('rejected' as const)
					: deriveFinalStatus(params),
		};

		map = _internals.appendTaskHistory(map, taskSummary);

		// 4. Append decisions
		if (params.decisions) {
			for (const entry of params.decisions) {
				const decision: DecisionEntry = {
					id: nextDecisionId(),
					decision: entry.decision,
					rationale: entry.rationale,
					timestamp: new Date().toISOString(),
					task_id: params.task_id,
				};
				map = _internals.appendDecision(map, decision);
			}
		}

		// 5. Save and return
		_internals.saveContextMap(map, params.directory);
		return map;
	} catch {
		// Never throw — return best-effort map (load whatever we can)
		try {
			const fallback =
				_internals.loadContextMap(params.directory) ??
				_internals.createEmptyContextMap();
			return fallback;
		} catch {
			return _internals.createEmptyContextMap();
		}
	}
}
