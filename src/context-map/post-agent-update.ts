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
import type {
	ContextMap,
	DecisionEntry,
	FileContextEntry,
	TaskContextSummary,
} from '../types/context-map';
import { extractContextDecisions } from '../utils/context-decisions';
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
	final_status: 'completed' | 'in_progress' | 'failed' | 'blocked' | 'cancelled';
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

// ---------------------------------------------------------------------------
// Task-release verification and authoritative promotion (r14 audit P1-5)
// ---------------------------------------------------------------------------

/**
 * Whether the WHOLE TASK is authoritatively released: the plan's task status
 * is `completed` AND every required QA gate has a recorded (satisfied) result.
 * A single successful child or gate ingestion proves nothing about the task
 * release — that is exactly the conflation this repair removes.
 *
 * Fail-closed: any read error or missing proof yields `'in_progress'`.
 */
export async function resolveContextMapTaskReleaseStatus(
	directory: string,
	taskId: string,
): Promise<'completed' | 'in_progress'> {
	try {
		const { readTaskEvidence } = await import('../gate-evidence.js');
		const evidence = await readTaskEvidence(directory, taskId);
		const required = evidence?.required_gates ?? [];
		const gates = evidence?.gates ?? {};
		if (!required.every((gate) => gates[gate] !== undefined)) {
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
 */
export function promoteContextMapTaskRelease(
	directory: string,
	taskId: string,
): void {
	try {
		const map =
			_internals.loadContextMap(directory) ??
			_internals.createEmptyContextMap();
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
