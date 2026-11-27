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
import { sanitizeContextText } from '../hooks/context-sanitizer';
import { derivePlanIdentityHash } from '../plan/utils';
import type {
	ContextMap,
	DecisionEntry,
	FileContextEntry,
	TaskContextSummary,
} from '../types/context-map';
import { extractContextDecisions } from '../utils/context-decisions';
import * as logger from '../utils/logger.js';
import { extractFileSummary } from './file-summary';
import {
	appendDecision,
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	readContextMapState,
	saveContextMap,
} from './persistence';

// ---------------------------------------------------------------------------
// Parameter interface
// ---------------------------------------------------------------------------

/**
 * A decision extracted from `.swarm/context.md`'s `## Decisions` section,
 * ready to be persisted as a `DecisionEntry` by `updateContextMapAfterAgent`.
 */
export interface PostAgentDecision {
	/** The decision text (bullet text before the first `: ` separator) */
	decision: string;
	/** Rationale text (after the first `: ` separator; empty when absent) */
	rationale: string;
	/** Phase number when the bullet carried or inherited one, else absent */
	phase?: number;
}

/**
 * Options for {@link extractContextDecisionsFromContextMd}.
 */
export interface ExtractContextDecisionsOptions {
	/**
	 * Session agent role used to gate the sync. `.swarm/context.md` is
	 * architect-maintained (subagents are forbidden from writing it), so when
	 * a role is supplied and is not an architect role — bare `'architect'`
	 * (`ORCHESTRATOR_NAME`) or a multi-swarm prefixed form ending in
	 * `'_architect'` — the sync returns no decisions without reading the file.
	 * Omit to extract regardless of role.
	 */
	agent_role?: string;
}

/**
 * Maximum number of context.md decisions one sync records. The architect
 * appends newest decisions at the bottom of the file, so the window keeps the
 * MOST RECENT entries; older entries beyond the window are never
 * retroactively recorded.
 */
export const MAX_CONTEXT_MD_DECISIONS = 50;

/**
 * Character bound for the context.md content handed to the shared extractor
 * (PR #3023 feedback FB-005). The shared extractor's own cap slices a PREFIX
 * (oldest-first), which would invert the most-recent window for pathological
 * file sizes and silently drop a `## Decisions` heading lying beyond the
 * slice; this module slices from the TAIL instead so the most recent content
 * is what gets scanned.
 */
export const MAX_CONTEXT_MD_CONTENT_CHARS = 1_000_000;

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
	/**
	 * The release status of the WHOLE TASK, not the individual child:
	 *
	 * - `'completed'` — ONLY when the authoritative task release is proven
	 *   (plan task status completed AND every required QA gate satisfied).
	 *   Maps to the final `'approved'` context-map status.
	 * - `'in_progress'` — r14 audit repair (P1-5): a single successful child
	 *   or gate ingestion is NOT a full task release. Maps to the non-final
	 *   `'pending'` context-map status; the authoritative promotion happens
	 *   later (update_task_status / promoteContextMapTaskRelease).
	 * - `'failed' | 'blocked' | 'cancelled'` — terminal negative outcomes.
	 */
	final_status:
		| 'completed'
		| 'in_progress'
		| 'failed'
		| 'blocked'
		| 'cancelled';
	/** Reviewer rejection reasons (if any) */
	rejection_reasons?: string[];
	/** Review findings (if any) */
	review_findings?: string[];
	/** Decisions made during this task */
	decisions?: Array<{ decision: string; rationale: string; phase?: number }>;
	/** Project root directory */
	directory: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Allocate the next durable decision ID for a context map.
 *
 * Derived from the decisions already present in the map being updated:
 * the max numeric suffix among existing `A<n>` IDs + 1, computed with BigInt
 * so suffixes past 2^53 stay exact. Mirrors `allocateSummaryId` in
 * src/summaries/manager.ts (issue #2576 / #2720): after a process restart
 * the map is reloaded from disk, so allocation continues after the persisted
 * IDs instead of restarting at A1 and duplicating identity in
 * `.swarm/context-map.json`.
 *
 * IDs that do not match `^A\d+$` (foreign prefixes, non-strings) are ignored
 * rather than crashing allocation.
 */
export function allocateDecisionId(
	decisions: readonly DecisionEntry[],
): string {
	let max = 0n;
	for (const entry of decisions) {
		if (typeof entry?.id !== 'string') continue;
		const match = /^A(\d+)$/.exec(entry.id);
		if (!match) continue;
		const value = BigInt(match[1]);
		if (value > max) max = value;
	}
	return `A${(max + 1n).toString()}`;
}

/**
 * Whether a session agent role is an architect role — the bare orchestrator
 * name (`'architect'`) or a multi-swarm prefixed form ending in
 * `'_architect'` (mirrors `extractCapsuleRole`'s suffix idiom).
 */
function isArchitectRole(role: string): boolean {
	return role === 'architect' || role.endsWith('_architect');
}

/**
 * Extract decisions from `.swarm/context.md`'s `## Decisions` section.
 *
 * The context file is the repo's decisions-recording convention (architect
 * prompt `src/agents/architect.ts`; shared `## Decisions` grammar parsed by
 * `extractContextDecisions`, the #2493 consolidation). Each bullet
 * `- <decision>: <rationale>` becomes a {@link PostAgentDecision}: the text
 * before the FIRST `: ` is the decision, the remainder the rationale (a
 * rationale may itself contain colons; a bullet without a separator yields an
 * empty rationale). Bullets whose decision text is empty after the
 * extractor's marker stripping are dropped.
 *
 * Bounded: keeps the most recent {@link MAX_CONTEXT_MD_DECISIONS} entries —
 * entries beyond that window are never retroactively recorded.
 *
 * When `options.agent_role` is supplied and is not an architect role, returns
 * `[]` without touching the filesystem (the file is architect-maintained;
 * subagent-only sessions do not adopt its decisions).
 *
 * Never throws — a missing or unreadable file yields `[]`.
 */
export function extractContextDecisionsFromContextMd(
	directory: string,
	options?: ExtractContextDecisionsOptions,
): PostAgentDecision[] {
	if (
		options?.agent_role !== undefined &&
		!isArchitectRole(options.agent_role)
	) {
		return [];
	}

	try {
		const contextMdPath = path.join(directory, '.swarm', 'context.md');
		if (!_internals.existsSync(contextMdPath)) {
			return [];
		}
		const content = _internals.readFileSync(contextMdPath, 'utf-8');
		// Tail-slice before the shared extractor so the bounded scan keeps the
		// MOST RECENT content (the extractor's internal cap slices a prefix).
		const bounded =
			content.length > MAX_CONTEXT_MD_CONTENT_CHARS
				? content.slice(content.length - MAX_CONTEXT_MD_CONTENT_CHARS)
				: content;
		const extracted = extractContextDecisions(bounded);

		const decisions: PostAgentDecision[] = [];
		for (const entry of extracted) {
			const separatorIndex = entry.text.indexOf(': ');
			const decision =
				separatorIndex === -1
					? entry.text
					: entry.text.slice(0, separatorIndex);
			const rationale =
				separatorIndex === -1 ? '' : entry.text.slice(separatorIndex + 2);
			// Empty-text bullets carry no identity; pure-marker residue (e.g. a
			// bare checkmark the shared extractor deliberately preserves) is
			// equally junk once the bracketed markers are gone.
			if (decision.trim() === '' || /^[\s✅]*$/.test(decision)) {
				continue;
			}
			decisions.push({
				// #3023 review PRR-001: the same source file is sanitized by
				// every other injection consumer (curator, system-enhancer,
				// extractors); persisted and capsule-rendered decision text
				// must pass the shared sanitizer too.
				decision: sanitizeContextText(decision),
				rationale: sanitizeContextText(rationale),
				...(entry.phase === null ? {} : { phase: entry.phase }),
			});
		}

		if (decisions.length > MAX_CONTEXT_MD_DECISIONS) {
			return decisions.slice(decisions.length - MAX_CONTEXT_MD_DECISIONS);
		}
		return decisions;
	} catch {
		return [];
	}
}

/**
 * Upper bound for the PERSISTED decisions log in `.swarm/context-map.json`
 * (PR #3023 feedback FB-002). The log is append-only within this window:
 * after each update the most recent entries are kept and older ones are
 * trimmed at save time, so reworded decision variants cannot grow the file
 * without bound. The capsule read surface is additionally capped by
 * `MAX_CAPSULE_DECISIONS` in the capsule builder.
 */
export const MAX_PERSISTED_DECISIONS = 200;

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
		// r14 audit repair (P1-5): a child/gate-level success while the task
		// is not yet authoritatively released — the NON-FINAL status.
		case 'in_progress':
			return 'pending';
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
	readContextMapState,
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
		// 1. Load existing map or create empty — but ONLY rebuild for a
		// GENUINELY missing map (r17 audit repair, P1). An existing-but-corrupt
		// or unreadable map must be preserved byte-for-byte: the previous
		// `loadContextMap(...) ?? createEmptyContextMap()` collapsed "missing"
		// and "corrupt" into the same null, so a child completion on a damaged
		// file manufactured a fresh, nearly-empty map and — via
		// `saveContextMap` — REPLACED the damaged file, destroying the
		// operator's recovery path (the same hole the r16 repairs closed for
		// `promoteContextMapTaskRelease` and the reconciliation; this is the
		// remaining normal child-update path). The whole update is SKIPPED:
		// no in-memory rebuild, no save, no fake task history. The skipped
		// write is never acked as persisted — the completion observer's
		// read-back verifier (`verifyContextMapWrite`) fails on an unreadable
		// map, so the closeout obligation stays resumable until the map is
		// repaired. Return contract unchanged (never throws; a detached empty
		// map is returned without persisting it, mirroring the outer-catch
		// fallback).
		const readState = _internals.readContextMapState(params.directory);
		if (readState.kind === 'unreadable') {
			logger.warn(
				`[context-map] ${params.directory}/.swarm/context-map.json exists but is corrupt or unreadable — preserving the original file; child completion update for task ${params.task_id} skipped (repair the map; the closeout stays resumable)`,
			);
			return _internals.createEmptyContextMap();
		}
		let map =
			readState.kind === 'ok'
				? readState.map
				: _internals.createEmptyContextMap();

		// 2. Refresh file summaries for touched files
		const root = path.resolve(params.directory);
		const updatedFiles: Record<string, FileContextEntry> = {
			...map.files,
		};
		const validFiles: string[] = [];

		// Resolve root once outside the loop — root is constant for all iterations.
		const realRoot = _internals.realpathSync(root);

		for (const filePath of params.files_touched) {
			try {
				const resolved = path.resolve(root, filePath);

				// Realpath containment — prevents symlink escape.
				// Resolve the target through realpath so that symlinks
				// pointing outside the project root are detected and skipped.
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

		// r14 audit repair (P1-5): a NON-FINAL child-level update must never
		// overwrite a terminal task verdict in the context map — a later
		// positive reviewer completion (status 'pending') cannot erase an
		// already-recorded negative test-engineer verdict ('rejected'), an
		// authoritative release ('approved'), or a blocked task.
		const existingSummary = map.task_history[params.task_id];
		const wouldOverwriteTerminal =
			existingSummary !== undefined &&
			existingSummary.final_status !== 'pending' &&
			taskSummary.final_status === 'pending';
		if (!wouldOverwriteTerminal) {
			map = _internals.appendTaskHistory(map, taskSummary);
		}

		// 4. Append decisions (idempotent: exact-text duplicates are skipped so
		// re-syncing `.swarm/context.md` on every task completion does not
		// grow the log; first-write-wins — an edited rationale never updates
		// the stored entry, and a re-worded decision text is a new entry).
		if (params.decisions && params.decisions.length > 0) {
			// Entries whose decision text is empty carry no identity and are
			// never recorded.
			const batch = params.decisions.filter(
				(entry) => (entry.decision ?? '').trim() !== '',
			);
			// Derive the first id from the current map, then advance the suffix
			// locally per append: O(map.decisions + decisions) total instead of
			// rescanning the whole array per decision. Each emitted id keeps allocateDecisionId's
			// `A<n>` output grammar (the append below reassigns `map`, so a
			// mid-call re-derivation would see prior appends — equivalent output,
			// just quadratic).
			// Null/malformed stored entries (legacy corruption — the class
			// allocateDecisionId already tolerates) contribute no identity.
			const existingTexts = new Set(
				map.decisions.map((entry) => String(entry?.decision ?? '').trim()),
			);
			let nextSuffix = BigInt(allocateDecisionId(map.decisions).slice(1));
			for (const entry of batch) {
				const text = String(entry.decision).trim();
				if (existingTexts.has(text)) {
					continue;
				}
				existingTexts.add(text);
				const decision: DecisionEntry = {
					id: `A${nextSuffix.toString()}`,
					decision: entry.decision,
					rationale: entry.rationale,
					timestamp: new Date().toISOString(),
					task_id: params.task_id,
					...(entry.phase === undefined ? {} : { phase: entry.phase }),
				};
				map = _internals.appendDecision(map, decision);
				nextSuffix += 1n;
			}
		}

		// Bound the persisted log (FB-002): keep the most recent entries when
		// the append-only log exceeds the window.
		if (map.decisions.length > MAX_PERSISTED_DECISIONS) {
			map = {
				...map,
				decisions: map.decisions.slice(
					map.decisions.length - MAX_PERSISTED_DECISIONS,
				),
			};
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

/**
 * r16 audit repair (P2): the COORDINATED post-agent update. Wraps the whole
 * load→update→save cycle of {@link updateContextMapAfterAgent} in the
 * cross-process context-map write lock, so two concurrent completions (the
 * background observer in one process, the sync Task handoff hook in another)
 * cannot both extend a map they loaded before either saved — the loser's
 * task summary, decisions, and file summaries would silently vanish.
 * Best-effort by the same contract as the sync variant.
 */
export async function updateContextMapAfterAgentLocked(
	params: PostAgentUpdateParams,
	lockTimeoutMs: number = CONTEXT_MAP_LOCK_BUDGET_MS.background,
): Promise<ContextMap> {
	const result = await withContextMapLock(
		params.directory,
		params.agent_role || 'unknown',
		params.task_id,
		() => updateContextMapAfterAgent(params),
		lockTimeoutMs,
	);
	return result.ok
		? result.value
		: (_internals.loadContextMap(params.directory) ??
				_internals.createEmptyContextMap());
}

// ---------------------------------------------------------------------------
// Task-release verification and authoritative promotion (r14 audit P1-5)
// ---------------------------------------------------------------------------

/**
 * r17 (§6): lazily-bound raw plan readers used by the per-task release proof
 * when NO snapshot is supplied. Seamed so the I/O-budget regression can
 * count (or replace) the physical plan.json reads without mocking `node:fs`
 * (mock.module on node:fs wedges Bun 1.4.4's module machinery — measured,
 * see reconcile-io-budget.test.ts). Production binds the real gate-evidence
 * functions on first use; each invocation is one physical plan.json read.
 */
export const _planProofReaders: {
	resolveCurrentPlanIdentitySync:
		| null
		| ((
				directory: string,
		  ) => { planId: string; planIdentityHash: string } | null);
	readCurrentTaskDeclaredFiles:
		| null
		| ((directory: string, taskId: string) => string[] | null);
} = {
	resolveCurrentPlanIdentitySync: null,
	readCurrentTaskDeclaredFiles: null,
};

/** Lazily bind the raw plan readers from gate-evidence (once per process). */
async function bindPlanProofReaders(): Promise<void> {
	if (
		_planProofReaders.resolveCurrentPlanIdentitySync !== null &&
		_planProofReaders.readCurrentTaskDeclaredFiles !== null
	) {
		return;
	}
	const gate = await import('../gate-evidence.js');
	_planProofReaders.resolveCurrentPlanIdentitySync ??=
		gate.resolveCurrentPlanIdentitySync;
	_planProofReaders.readCurrentTaskDeclaredFiles ??=
		gate.readCurrentTaskDeclaredFiles;
}

/**
 * r17 (§6): a once-loaded, READ-ONLY plan snapshot the reconciliation pass
 * derives from the plan it already loaded — so the per-task evidence proof
 * does not re-read and re-parse the ENTIRE plan.json twice per candidate
 * (`resolveCurrentPlanIdentitySync` + `readCurrentTaskDeclaredFiles` both
 * raw-read plan.json; measured pre-repair: ~4000 physical plan opens for a
 * 1000-task first pass).
 *
 * SECURITY CONTRACT: the snapshot is only used for repeatable, read-only
 * proof computation. It never replaces an authority check at a mandatory
 * write point — the promotion fence
 * (`promoteContextMapTaskReleaseLocked`) re-reads the CURRENT plan under
 * the context-map lock and re-verifies BOTH the task status AND the plan
 * identity hash before writing, so a plan that changed identity mid-pass
 * fails closed and the next maintenance pass re-drives the promotions.
 *
 * Residual (documented): `planIdentityHash` derives from `swarm` + `title`
 * only — a same-identity plan.json edit limited to a completed task's
 * `files_touched` between the pass's plan load and the promotion is not
 * detected by the identity fence. The status fence plus the fail-closed
 * evidence gates bound that window; no exactly-once guarantee is claimed.
 */
export interface TaskReleaseProofSnapshot {
	/** Identity hash of the plan the snapshot was derived from (never undefined). */
	planIdentityHash: string | null;
	/**
	 * The task's declared files, with `readCurrentTaskDeclaredFiles`
	 * semantics: null when the task is absent, duplicated, or its
	 * files_touched is not a string[].
	 */
	declaredFiles: string[] | null;
}

/** Derive the declared-files map from an already-loaded plan (once per pass). */
function deriveDeclaredFilesByTask(
	plan: import('../config/plan-schema').Plan,
): Map<string, string[] | null> {
	const byTask = new Map<string, string[] | null>();
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			if (byTask.has(task.id)) {
				// Duplicate task id: not proof (readCurrentTaskDeclaredFiles
				// returns null for a second match).
				byTask.set(task.id, null);
				continue;
			}
			const files = (task as { files_touched?: unknown }).files_touched;
			byTask.set(
				task.id,
				Array.isArray(files) && files.every((file) => typeof file === 'string')
					? [...(files as string[])]
					: null,
			);
		}
	}
	return byTask;
}

/**
 * r16 audit repair (P2): the evidence-lock key coordinating every
 * context-map read-modify-write cycle. `saveContextMap`'s atomic write makes
 * each individual persist torn-write-safe, but two processes that both
 * LOADED the map before either saved still lose one writer's update (last
 * rename wins). The mutation entry points below wrap their whole
 * load→mutate→save cycle in the EXISTING cross-process evidence lock
 * (`withEvidenceLock`, the same coordinating layer the pr-subscription and
 * evidence stores use) so participating writers serialize. The lock is
 * coordinating, not a sandbox: unlocked legacy writers can still clobber —
 * they could before r16 too.
 */
const CONTEXT_MAP_LOCK_KEY = 'context-map.json';

/**
 * r17 audit repair (P1): bounded lock-ACQUISITION budgets for the
 * context-map paths, replacing the inherited 60 000 ms evidence-lock
 * default. `withEvidenceLock`'s timeout bounds only the ACQUISITION wait —
 * on timeout the callback never started, so there is no uncontrolled
 * continuation and no partial write (this is precisely why the budget is
 * passed through `withEvidenceLock`'s `timeoutMs` instead of a
 * `Promise.race` around the write, which would leave the operation running
 * after the racer returned).
 *
 * The context-map write is OPTIONAL enrichment: a skipped write is
 * fail-closed and recovered — the completion observer's `context_map`
 * closeout step stays un-acked (retryable) and the maintenance-point
 * reconciliation re-drives the promotion. A tool completion (and the whole
 * hook chain behind it) must never wait minutes on it.
 */
export const CONTEXT_MAP_LOCK_BUDGET_MS = {
	/**
	 * The critical synchronous `tool.execute.after` path: an optional
	 * context-map write must not delay a delegation's completion signal.
	 */
	hook: 1_500,
	/**
	 * Background closeout steps and the authoritative promotion from
	 * update_task_status: bounded (journaled retries recover a skip; the
	 * task release itself never rolls back).
	 */
	background: 5_000,
	/**
	 * Maintenance reconciliation (status service, post-init maintenance,
	 * observer maintenance pass): still bounded — an unattended pass must
	 * not sit on the lock for a minute.
	 */
	maintenance: 10_000,
} as const;

/**
 * Run `fn` under the cross-process context-map write lock. Never throws:
 * a lock failure (timeout, project-root rejection) is logged and reported
 * via the return value so best-effort callers can skip — the reconciliation
 * at the next maintenance point recovers a skipped promotion.
 *
 * `timeoutMs` bounds only the lock ACQUISITION (r17): on timeout `fn` never
 * ran, so the mutation is skipped whole — no partial write is possible.
 */
export async function withContextMapLock<T>(
	directory: string,
	agent: string,
	taskId: string,
	fn: () => T | Promise<T>,
	timeoutMs: number = 60_000,
): Promise<{ ok: true; value: T } | { ok: false }> {
	try {
		const { withEvidenceLock } = await import('../evidence/lock.js');
		const value = await withEvidenceLock(
			directory,
			CONTEXT_MAP_LOCK_KEY,
			agent,
			taskId,
			async () => fn(),
			timeoutMs,
		);
		return { ok: true, value };
	} catch (error) {
		logger.warn(
			`[context-map] write lock for task ${taskId} failed (skipped; retried at the next maintenance point): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { ok: false };
	}
}

/**
 * Whether the WHOLE TASK is authoritatively released: the plan's task status
 * is `completed` AND every required QA gate has a recorded (satisfied) result.
 * A single successful child or gate ingestion proves nothing about the task
 * release — that is exactly the conflation this repair removes.
 *
 * Fail-closed: any read error or missing proof yields `'in_progress'`.
 *
 * r16 audit repair (P1): the release proof now applies the same durable
 * authority rules as the real task completion (`update_task_status` /
 * `checkReviewerGate`) instead of a raw `required_gates.every(...)` scan:
 *
 * - `readTaskEvidenceState` (not `readTaskEvidence`): a missing OR
 *   unparseable/corrupt evidence file both fail closed. The previous code
 *   coerced `null` into an EMPTY required-gate list, and `[].every(...)`
 *   passed vacuously — a plan that merely claimed `completed` released the
 *   context map with no QA evidence at all.
 * - `deriveApplicableGateSet`: the single authoritative gate derivation.
 *   Empty `required_gates` are only legitimate with the exact generation-0
 *   no-mutation settlement proof (or a matched external-evidence attest);
 *   otherwise Stage A (`pre_check`) remains applicable and is reported
 *   missing. Do NOT require `required_gates.length > 0` literally — the
 *   settlement/attest cases are the repository's legitimate empty-gate
 *   authorizations.
 * - the workflow metadata must be authoritative and terminal
 *   (`tests_run`/`complete`) or a legitimate read-only no-mutation
 *   settlement. A `forcedCompletion` marker is durable proof that the task
 *   did NOT pass the gates and never releases the map.
 * - evidence stamped (planIdentityHash) for a different plan is prior
 *   campaign evidence and fails closed; an absent stamp is "unknown" and
 *   keeps the pre-existing non-blocking behavior (same semantics as
 *   `evidenceStampedForDifferentPlan`).
 *
 * r16 audit repair (P2, 7.2): the durable-evidence half is split into
 * {@link resolveTaskReleaseEvidenceProof} so the reconciliation pass — which
 * already holds the loaded plan and iterates only completed tasks — can
 * verify N tasks with ONE plan load instead of N+1 (each extra
 * `loadPlanJsonOnly` is a stat plus a structuredClone of the ENTIRE plan;
 * measured at 100/500/1000 pending completed tasks: 100/500/1000 redundant
 * plan loads and ~2.9 s for the 1000-task first pass). The combined
 * `resolveContextMapTaskReleaseStatus` keeps its exact contract for the
 * observer and sync-handoff callers.
 */
export async function resolveTaskReleaseEvidenceProof(
	directory: string,
	taskId: string,
	snapshot?: TaskReleaseProofSnapshot,
): Promise<boolean> {
	try {
		await bindPlanProofReaders();
		const {
			readTaskEvidenceState,
			getTaskWorkflowSnapshot,
			deriveApplicableGateSet,
			evidenceStampedForDifferentPlan,
		} = await import('../gate-evidence.js');
		// Fail closed on missing AND unparseable evidence — a vacuous
		// empty-gate pass is never a release proof.
		const state = await readTaskEvidenceState(directory, taskId);
		if (state.kind !== 'ok') {
			return false;
		}
		const evidence = state.evidence;
		// Prior-campaign evidence (positive plan-identity mismatch only).
		// r17 (§6): with a pass snapshot the identity comes from the snapshot
		// (zero per-task plan reads); the write-point promotion fence
		// re-verifies the CURRENT plan identity before any write.
		const currentIdentityHash =
			snapshot?.planIdentityHash ??
			_planProofReaders.resolveCurrentPlanIdentitySync!(directory)
				?.planIdentityHash ??
			null;
		if (evidenceStampedForDifferentPlan(evidence, currentIdentityHash)) {
			return false;
		}
		const workflow = getTaskWorkflowSnapshot(evidence);
		// Legacy evidence without an authoritative workflow generation cannot
		// prove the release (same refusal as checkReviewerGate).
		if (!workflow.authoritative) {
			return false;
		}
		// A QA-exempt (forced) completion is durable proof the gates were NOT
		// passed — it must not release the context map.
		if (workflow.forcedCompletion === true) {
			return false;
		}
		// The authoritative applicable-gate derivation: empty required gates
		// are honored only with the exact no-mutation settlement proof (or a
		// matched external attest); everything else still owes Stage A.
		// r17 (§6): declared files come from the pass snapshot when supplied.
		const currentDeclaredFiles =
			snapshot?.declaredFiles ??
			_planProofReaders.readCurrentTaskDeclaredFiles!(directory, taskId);
		const derivedGates = deriveApplicableGateSet(evidence, {
			currentDeclaredFiles,
		});
		if (derivedGates.missingGates.length > 0) {
			return false;
		}
		// The workflow itself must have reached a terminal QA state (or be a
		// legitimate read-only settlement) — recorded gates alone do not prove
		// the lifecycle finished.
		const workflowComplete =
			workflow.state === 'tests_run' || workflow.state === 'complete';
		return workflowComplete || derivedGates.readOnlyNoMutation;
	} catch {
		return false;
	}
}

export async function resolveContextMapTaskReleaseStatus(
	directory: string,
	taskId: string,
): Promise<'completed' | 'in_progress'> {
	try {
		if (!(await resolveTaskReleaseEvidenceProof(directory, taskId))) {
			return 'in_progress';
		}
		const { loadPlanJsonOnly } = await import('../plan/manager.js');
		const plan = await loadPlanJsonOnly(directory);
		const task = plan?.phases
			.flatMap((phase) => phase.tasks)
			.find((t) => t.id === taskId);
		return task?.status === 'completed' ? 'completed' : 'in_progress';
	} catch {
		return 'in_progress';
	}
}

/**
 * r17 audit repair (P1): read the task's CURRENT status and the plan's
 * CURRENT identity hash from the plan.json projection with a single RAW
 * read — deliberately NOT through the plan artifact cache (each cached load
 * costs a stat plus a structuredClone of the entire plan, which would
 * re-create the per-task plan-load budget the r16 repair removed) and not
 * through a schema-validated parse (the fence only needs two fields).
 * Fail-closed: any read/parse error, missing task, or non-string status
 * yields null and the caller skips the promotion.
 */
function readCurrentTaskStatusAndIdentityFromPlan(
	directory: string,
	taskId: string,
): { status: string; planIdentityHash: string } | null {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const raw = _internals.readFileSync(planPath, 'utf-8');
		const parsed = JSON.parse(raw) as {
			swarm?: unknown;
			title?: unknown;
			phases?: Array<{
				tasks?: Array<{ id?: unknown; status?: unknown }>;
			}>;
		};
		if (typeof parsed.swarm !== 'string' || typeof parsed.title !== 'string') {
			return null;
		}
		for (const phase of parsed.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				if (task?.id === taskId) {
					if (typeof task.status !== 'string') return null;
					return {
						status: task.status,
						planIdentityHash: derivePlanIdentityHash({
							swarm: parsed.swarm,
							title: parsed.title,
						}),
					};
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * r14 audit repair (P1-5): the AUTHORITATIVE task-release promotion. The
 * background completion observer (and the sync Task handoff) deliberately
 * write only the non-final `'pending'` summary until the task is released;
 * this function runs at the authoritative release point
 * (update_task_status with status `completed`) and promotes the summary to
 * `'approved'`.
 *
 * Never overwrites a terminal `'rejected'` entry (a positive verdict cannot
 * erase an already-recorded negative one); idempotent; creates a minimal
 * summary when no child ever recorded one.
 *
 * CONTRACT: the CALLER owns the release authority. This sync primitive
 * promotes what it is told; the stale-plan fence (r17) lives in the
 * production entry point {@link promoteContextMapTaskReleaseLocked}, which
 * re-verifies the current authoritative task status under the context-map
 * lock immediately before calling this function.
 */
export function promoteContextMapTaskRelease(
	directory: string,
	taskId: string,
): void {
	try {
		// r16 audit repair (P1): a rebuild is only legitimate for a GENUINELY
		// missing map. An existing-but-corrupt map must be preserved
		// byte-for-byte — overwriting it with a fresh map would destroy the
		// operator's recovery path for the damaged decisions/task history.
		// The promotion is best-effort by contract; a skipped promotion is
		// recovered by reconciliation once the map is repaired.
		const readState = _internals.readContextMapState(directory);
		if (readState.kind === 'unreadable') {
			logger.warn(
				`[context-map] ${directory}/.swarm/context-map.json exists but is corrupt or unreadable — preserving the original file; task-release promotion for task ${taskId} skipped (repair the map, then the next maintenance pass re-drives the promotion)`,
			);
			return;
		}
		const map =
			readState.kind === 'ok'
				? readState.map
				: _internals.createEmptyContextMap();
		const existing = map.task_history[taskId];
		if (existing?.final_status === 'approved') return; // idempotent
		if (existing?.final_status === 'rejected') {
			// A terminal negative verdict is never overwritten by the release
			// promotion — the negative result stays durably diagnosable.
			return;
		}
		const summary: TaskContextSummary = existing
			? { ...existing, final_status: 'approved' }
			: {
					task_id: taskId,
					goal: '',
					files_touched: [],
					implementation_summary: '',
					final_status: 'approved',
				};
		const next = _internals.appendTaskHistory(map, summary);
		_internals.saveContextMap(next, directory);
	} catch {
		// The promotion must never block the authoritative status update.
	}
}

/**
 * r16 audit repair (P2): the COORDINATED task-release promotion. Wraps the
 * whole load→promote→save cycle of {@link promoteContextMapTaskRelease} in
 * the cross-process context-map write lock so a concurrent writer (the
 * observer's child summary, the sync handoff, another process's
 * reconciliation) cannot interleave its own read-modify-write and lose this
 * promotion — or vice versa. Best-effort by the same contract as the sync
 * variant: a lock failure skips the promotion (logged), and the next
 * maintenance-point reconciliation recovers it.
 */
export async function promoteContextMapTaskReleaseLocked(
	directory: string,
	taskId: string,
	lockTimeoutMs: number = CONTEXT_MAP_LOCK_BUDGET_MS.background,
	expectedPlanIdentityHash?: string,
): Promise<void> {
	await withContextMapLock(
		directory,
		'update_task_status',
		taskId,
		() => {
			// r17 audit repair (P1): STALE-PLAN FENCE. The reconciliation selects
			// its candidates from a plan loaded BEFORE the per-task (async)
			// evidence proof, and the authoritative task status can change in
			// between — a rework flips completed → in_progress under a new
			// workflow generation. The existing plan-identity fence does not
			// catch this: `planIdentityHash` derives from `swarm` + `title` only,
			// so a task-status change never changes it, and unstamped legacy
			// evidence skips the mismatch check entirely. Re-read the task's
			// CURRENT status here — under the context-map lock, immediately
			// before the write — and skip the promotion unless it is still
			// `completed`. No fresh `approved` marking is created for a task that
			// is no longer released; the pending entry survives for the next
			// maintenance pass.
			//
			// r17 (§6): when the caller derived its proofs from a pass snapshot
			// (the reconciliation), it passes the snapshot's
			// `expectedPlanIdentityHash`; the fence re-derives the CURRENT
			// identity from the same raw read and skips on mismatch — a
			// snapshot never replaces the authority check at the write point.
			//
			// The fence is a single RAW plan.json read (not the artifact cache) —
			// a cached load costs a stat plus a structuredClone of the ENTIRE
			// plan per promoted task, which would re-create the per-task
			// plan-load budget the r16 repair removed.
			//
			// RESIDUAL RACE (documented, deliberately not claimed closed): the
			// plan ledger's writes are not serialized against this context-map
			// lock — no common authority boundary exists between the two stores.
			// The fence closes the wide window (the evidence proof plus the lock
			// wait) but a plan write racing inside the read→promote→save window
			// itself can still interleave. A skipped promotion is fail-closed and
			// recovered: the next maintenance-point reconciliation re-drives it
			// once the task is released again.
			const current = readCurrentTaskStatusAndIdentityFromPlan(
				directory,
				taskId,
			);
			if (current?.status !== 'completed') {
				logger.warn(
					`[context-map] task-release promotion for task ${taskId} skipped — the authoritative plan status is '${current?.status ?? 'task-missing'}' (not completed) at promotion time; the next maintenance pass re-drives it once the task is released`,
				);
				return;
			}
			if (
				expectedPlanIdentityHash !== undefined &&
				current.planIdentityHash !== expectedPlanIdentityHash
			) {
				logger.warn(
					`[context-map] task-release promotion for task ${taskId} skipped — the plan identity changed since the reconciliation pass loaded it (stale proofs); the next maintenance pass re-derives everything`,
				);
				return;
			}
			promoteContextMapTaskRelease(directory, taskId);
		},
		lockTimeoutMs,
	);
}

/**
 * r15 audit repair (P3): idempotent reconciliation of context-map task
 * releases after a lost promotion.
 *
 * `promoteContextMapTaskRelease` (and its caller in update_task_status) is
 * best-effort by contract — the authoritative task release in the plan must
 * never be rolled back by a context-map write failure. But before this
 * repair, a failed promotion left the context map 'pending' FOREVER: the
 * child closeout steps were already completed, so no closeout replay re-drove
 * the promotion.
 *
 * This reconciliation reconstructs the promotion from the AUTHORITATIVE
 * durable state alone — the plan's task status plus the recorded QA-gate
 * evidence (the exact proof `resolveContextMapTaskReleaseStatus` applies,
 * fail-closed: no promotion without full QA proof). It runs at existing
 * maintenance points (observer maintenance pass, /swarm status, post-init
 * background maintenance), so any later runtime recovers a lost promotion.
 *
 * r16 (P2, 7.2) cost bound: the plan is loaded ONCE per pass and the
 * per-task work is the evidence proof only (`resolveTaskReleaseEvidenceProof`)
 * — one bounded evidence-file read per pending completed task. Terminal
 * entries are skipped before any I/O, so a steady-state pass is O(1) in
 * plan reads (measured: 1 read, 2-4 ms at 1000 tasks).
 *
 * Guarantees:
 * - the plan stays authoritative — this never touches plan state;
 * - idempotent: `appendTaskHistory` upserts by task id, so repeated
 *   reconciliations never duplicate task-history entries;
 * - a terminal 'rejected' entry is never overwritten (same guard as the
 *   promotion itself). NOTE (r15): the context-map data model carries no
 *   workflow-generation identity on task entries, so a later reworked and
 *   re-released task cannot be distinguished from the generation that was
 *   rejected — per the audit, the negative-protection guard is NOT weakened
 *   without a reproduced rework test; a rejected entry stays rejected;
 * - gated on the context_map config — no context map is invented for
 *   projects with the context map disabled;
 * - failures are diagnosable (logged) and never throw.
 */
export async function reconcileContextMapTaskReleases(
	directory: string,
): Promise<void> {
	try {
		const { loadPluginConfig } = await import('../config/loader.js');
		if (loadPluginConfig(directory).context_map?.enabled !== true) {
			return;
		}
		const { loadPlanJsonOnly } = await import('../plan/manager.js');
		const plan = await loadPlanJsonOnly(directory);
		if (!plan) return;
		const completedTasks = plan.phases
			.flatMap((phase) => phase.tasks)
			.filter((task) => task.status === 'completed');
		if (completedTasks.length === 0) return;
		// r16 audit repair (P1): reconcile may rebuild ONLY a genuinely
		// missing map. An existing-but-corrupt map is preserved untouched —
		// no promotion is derived from a damaged file, and the original bytes
		// stay available for recovery. The condition is logged so the damage
		// is diagnosable; reconciliation retries at the next maintenance
		// point once the map is repaired.
		const readState = _internals.readContextMapState(directory);
		if (readState.kind === 'unreadable') {
			logger.warn(
				`[context-map] ${directory}/.swarm/context-map.json exists but is corrupt or unreadable — reconciliation skipped, original file preserved for recovery`,
			);
			return;
		}
		const map =
			readState.kind === 'ok'
				? readState.map
				: _internals.createEmptyContextMap();
		// r17 (§6): the once-per-pass READ-ONLY proof snapshot. The per-task
		// proof previously raw-read plan.json TWICE per candidate
		// (`resolveCurrentPlanIdentitySync` + `readCurrentTaskDeclaredFiles`);
		// measured pre-repair: ~4000 physical plan.json opens for a
		// 1000-task first pass. The snapshot supplies both values from the
		// plan loaded ONCE above. Security: the snapshot is used only for
		// this read-only proof computation — the promotion fence below
		// re-verifies the CURRENT task status AND plan identity at the
		// mandatory write point, so a plan that changed mid-pass fails
		// closed.
		const passPlanIdentityHash = derivePlanIdentityHash({
			swarm: plan.swarm,
			title: plan.title,
		});
		const declaredFilesByTask = deriveDeclaredFilesByTask(plan);
		for (const task of completedTasks) {
			const existing = map.task_history[task.id];
			if (existing !== undefined && existing.final_status !== 'pending') {
				// 'approved' is already done; 'rejected'/'blocked' are terminal
				// verdicts the reconciliation must preserve.
				continue;
			}
			// Fail-closed release proof: the plan status is already known
			// (this loop iterates only completed tasks of the plan loaded
			// ONCE above), so only the durable QA evidence is re-verified per
			// task. r16 (P2, 7.2): the previous per-task
			// resolveContextMapTaskReleaseStatus call re-loaded the plan N
			// times per pass — every load is a stat plus a structuredClone of
			// the ENTIRE plan (measured: 1000 redundant loads, ~2.9 s for a
			// 1000-task first pass). Anything unreadable or unproven stays
			// untouched.
			const evidenceProven = await resolveTaskReleaseEvidenceProof(
				directory,
				task.id,
				{
					planIdentityHash: passPlanIdentityHash,
					declaredFiles: declaredFilesByTask.get(task.id) ?? null,
				},
			);
			if (evidenceProven) {
				// r16 (P2): the coordinated promotion — the whole
				// load→promote→save cycle runs under the cross-process
				// context-map lock so a concurrent writer cannot lose it.
				// r17 (P1): the acquisition wait is bounded to the maintenance
				// budget — an unattended maintenance pass must not sit on a
				// contended lock; a skipped promotion is re-driven by the
				// next maintenance point.
				// r17 (§6): the pass identity is passed to the promotion fence —
				// a plan whose identity changed since the pass load fails
				// closed at the write point (stale proofs are never written).
				await promoteContextMapTaskReleaseLocked(
					directory,
					task.id,
					CONTEXT_MAP_LOCK_BUDGET_MS.maintenance,
					passPlanIdentityHash,
				);
			}
		}
	} catch (error) {
		logger.warn(
			`[context-map] task-release reconciliation failed (non-fatal; retried at the next maintenance point): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
