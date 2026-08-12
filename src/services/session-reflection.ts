/**
 * Session reflection service — two-phase end-of-session architect review.
 *
 * Phase 1 (deterministic): Aggregate session signals — tool failures, gate
 * rejections, error taxonomy, agent dispatches, retro lessons. No LLM, no
 * quota, fast. Produces a structured snapshot the architect can reason over.
 *
 * Phase 2 (LLM): Feed the snapshot to the skill_improver agent (which acts
 * as the architect's reflection delegate) to produce an actionable report:
 * what skills to create/change, what problems were encountered, what tools
 * didn't work, and what the swarm should learn for next time. The report is
 * surfaced directly in the finalize output — not buried in an artifact.
 *
 * When no LLM client is available, phase 2 falls back to a deterministic
 * summary so finalize never blocks on missing infrastructure.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { findActiveSwarmNearDuplicate } from '../hooks/knowledge-reinforcement';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types';
import {
	createSkillImproverLLMDelegate,
	type SkillImproverLLMDelegate,
} from '../hooks/skill-improver-llm-factory';
import {
	normalizeComplianceVerdict,
	readSkillUsageEntriesTail,
} from '../hooks/skill-usage-log';
import { validateSwarmPath } from '../hooks/utils';
import type { ToolAggregate } from '../state';

// ─── Types ───────────────────────────────────────────────────────────

/** A near-duplicate candidate pair: a session entry and an existing store entry. */
export interface NearDuplicateCandidate {
	sessionEntryText: string;
	existingEntryText: string;
	existingEntryId: string;
}

export interface ToolProblem {
	tool: string;
	failureCount: number;
	totalCalls: number;
	failureRate: number;
	avgDurationMs: number;
}

export interface AgentDispatchSummary {
	agent: string;
	delegationCount: number;
	lastDelegationReason?: string;
}

export interface GateFailureSummary {
	gate: string;
	taskId: string;
	count: number;
}

/** Top skills ranked by violation count for the session or all-time. */
export interface SkillViolationSignal {
	skillPath: string;
	violationCount: number;
}

/** A single numbered action-menu item assembled from reflection proposals. FR-007. */
export interface ActionMenuItem {
	number: number;
	description: string;
	targetTool: string;
	data: unknown;
}

/** A drafted (not filed) GitHub issue candidate produced by the reflection report. FR-006. */
export interface DraftedIssueCandidate {
	title: string;
	body: string;
	errorCategory: string;
	evidence: string;
}

export interface SessionReflectionData {
	timestamp: string;
	totalToolCalls: number;
	totalToolFailures: number;
	toolProblems: ToolProblem[];
	agentDispatches: AgentDispatchSummary[];
	gateFailures: GateFailureSummary[];
	lessonsFromRetros: string[];
	errorTaxonomy: Record<string, number>;
	/** Knowledge entries actually stored via curation this session */
	lessonsStored: number;
	/** Total knowledge entries created this session (may exceed lessonsStored) */
	knowledgeCreated: number;
	/** Retro lessons deduped as already-known (currently silently discarded) */
	dedupDropCount: number;
	/** Drain admitted count (admission drain this session) */
	drainAdmitted: number;
	/** Drain reinforced count (admission drain this session) */
	drainReinforced: number;
	/** Drain rejected count (admission drain this session) */
	drainRejected: number;
	/** Top skills by violation count (session-scoped or all-time). FR-002. */
	skillViolationSignals: SkillViolationSignal[];
	/** Near-duplicate candidate pairs from this session vs. the active knowledge store. FR-003. */
	nearDuplicateCandidates: NearDuplicateCandidate[];
	/** Drafted (not filed) GitHub issue candidates for problems with reproduction evidence. FR-006. */
	draftedIssueCandidates: DraftedIssueCandidate[];
	/** Numbered action menu assembled from Phase A proposals. FR-007. */
	assembledMenu?: ActionMenuItem[];
}

export interface SessionReflectionResult {
	data: SessionReflectionData;
	architectReport: string;
	source: 'llm' | 'deterministic';
}

// ─── Phase 1: Deterministic gathering ────────────────────────────────

function gatherToolProblems(toolAggregates: Map<string, ToolAggregate>): {
	problems: ToolProblem[];
	totalCalls: number;
	totalFailures: number;
} {
	let totalCalls = 0;
	let totalFailures = 0;
	const problems: ToolProblem[] = [];

	for (const [, agg] of toolAggregates) {
		totalCalls += agg.count;
		totalFailures += agg.failureCount;

		if (agg.failureCount > 0 && agg.count > 0) {
			const failureRate = agg.failureCount / agg.count;
			if (failureRate > 0.2 || agg.failureCount > 2) {
				problems.push({
					tool: agg.tool,
					failureCount: agg.failureCount,
					totalCalls: agg.count,
					failureRate: Math.round(failureRate * 100) / 100,
					avgDurationMs: Math.round(agg.totalDuration / agg.count),
				});
			}
		}
	}

	problems.sort((a, b) => b.failureCount - a.failureCount);
	return { problems, totalCalls, totalFailures };
}

interface AgentSessionLike {
	agentName: string;
	lastDelegationReason?: string;
}

function gatherAgentDispatches(
	agentSessions: Map<string, AgentSessionLike>,
): AgentDispatchSummary[] {
	const agentCounts = new Map<string, { count: number; lastReason?: string }>();

	for (const [, session] of agentSessions) {
		const name = session.agentName;
		const existing = agentCounts.get(name) ?? { count: 0 };
		existing.count++;
		if (session.lastDelegationReason) {
			existing.lastReason = session.lastDelegationReason;
		}
		agentCounts.set(name, existing);
	}

	return [...agentCounts.entries()]
		.map(([agent, data]) => ({
			agent,
			delegationCount: data.count,
			lastDelegationReason: data.lastReason,
		}))
		.sort((a, b) => b.delegationCount - a.delegationCount);
}

async function gatherRetroLessonsAndTaxonomy(
	directory: string,
): Promise<{ lessons: string[]; taxonomy: Record<string, number> }> {
	const lessons: string[] = [];
	const taxonomy: Record<string, number> = {};

	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		const entries = await fs.readdir(evidenceDir);
		const retroDirs = entries
			.filter((e) => e.startsWith('retro-'))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

		for (const retroDir of retroDirs) {
			const evidencePath = path.join(evidenceDir, retroDir, 'evidence.json');
			try {
				const content = await fs.readFile(evidencePath, 'utf-8');
				const parsed = JSON.parse(content);
				const bundleEntries = parsed.entries ?? [parsed];

				for (const entry of bundleEntries) {
					if (Array.isArray(entry.lessons_learned)) {
						for (const lesson of entry.lessons_learned) {
							if (typeof lesson === 'string' && lesson.trim().length > 0) {
								lessons.push(lesson.trim());
							}
						}
					}
					if (entry.error_taxonomy != null) {
						if (Array.isArray(entry.error_taxonomy)) {
							// Canonical schema: ["logic_error", "timeout", ...]
							for (const cat of entry.error_taxonomy) {
								if (typeof cat === 'string' && cat.length > 0) {
									taxonomy[cat] = (taxonomy[cat] ?? 0) + 1;
								}
							}
						} else if (typeof entry.error_taxonomy === 'object') {
							// Legacy/object format: { category: count }
							for (const [key, val] of Object.entries(
								entry.error_taxonomy as Record<string, unknown>,
							)) {
								if (typeof val === 'number') {
									taxonomy[key] = (taxonomy[key] ?? 0) + val;
								}
							}
						}
					}
				}
			} catch {
				// Per-file failure is non-blocking
			}
		}
	} catch {
		// evidence dir may not exist
	}

	return { lessons: [...new Set(lessons)], taxonomy };
}

async function gatherGateFailures(
	directory: string,
): Promise<GateFailureSummary[]> {
	const failures = new Map<string, GateFailureSummary>();

	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		const entries = await fs.readdir(evidenceDir);

		for (const entry of entries) {
			if (entry.startsWith('retro-')) continue;
			const evidencePath = path.join(evidenceDir, entry, 'evidence.json');
			try {
				const content = await fs.readFile(evidencePath, 'utf-8');
				const parsed = JSON.parse(content);
				const bundleEntries = parsed.entries ?? [parsed];

				for (const e of bundleEntries) {
					if (e.verdict === 'fail' || e.verdict === 'REJECT') {
						const gate = e.agent ?? e.type ?? 'unknown';
						const taskId = entry;
						const key = `${gate}:${taskId}`;
						const existing = failures.get(key) ?? {
							gate,
							taskId,
							count: 0,
						};
						existing.count++;
						failures.set(key, existing);
					}
				}
			} catch {
				// Per-file failure is non-blocking
			}
		}
	} catch {
		// evidence dir may not exist
	}

	return [...failures.values()].sort((a, b) => b.count - a.count);
}

/** Maximum number of skill-violation signals to surface. */
const MAX_SKILL_VIOLATION_SIGNALS = 10;

/**
 * Gather top skills ranked by violation count from the skill-usage log.
 *
 * Reads the tail of the skill-usage JSONL via `readSkillUsageEntriesTail`.
 * When `sessionId` is provided, only entries matching that session are
 * considered.  When absent, the function degrades to an all-time tally
 * (no session filter — every entry in the tail window counts).
 *
 * Entries whose normalized `complianceVerdict` equals `'violated'` are
 * counted as violations.  Results are ranked descending by violation
 * count and capped at `MAX_SKILL_VIOLATION_SIGNALS`.
 */
async function gatherSkillViolationSignals(
	directory: string,
	sessionId?: string,
): Promise<SkillViolationSignal[]> {
	const entries = readSkillUsageEntriesTail(directory, {
		sessionID: sessionId,
	});

	const tally = new Map<string, number>();
	for (const entry of entries) {
		if (normalizeComplianceVerdict(entry.complianceVerdict) !== 'violated') {
			continue;
		}
		const prev = tally.get(entry.skillPath) ?? 0;
		tally.set(entry.skillPath, prev + 1);
	}

	return [...tally.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_SKILL_VIOLATION_SIGNALS)
		.map(([skillPath, violationCount]) => ({ skillPath, violationCount }));
}

// ─── Phase 1.5: Near-duplicate candidate detection ───────────────────

/** Maximum session entries to compare against the knowledge store. */
const MAX_SESSION_ENTRIES_FOR_DEDUP = 50;

/** Default threshold when dedupThreshold is not provided. */
const DEFAULT_DEDUP_THRESHOLD = 0.6;

/**
 * Gather near-duplicate candidate pairs by comparing this session's knowledge
 * entries against the active knowledge store.
 *
 * Returns an empty array when no candidates are found, the session has no
 * entries, or any error occurs (fail-open).  Each candidate carries both
 * entry texts as menu material for the architect to review.  Zero writes —
 * supersession is never automatic.
 */
async function gatherNearDuplicateCandidates(
	directory: string,
	sessionStart: string | undefined,
	threshold: number,
): Promise<NearDuplicateCandidate[]> {
	const candidates: NearDuplicateCandidate[] = [];

	try {
		const knowledgePath = resolveSwarmKnowledgePath(directory);
		const allEntries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		if (allEntries.length === 0) return candidates;

		// Identify this session's entries by filtering on created_at >= sessionStart.
		// When sessionStart is unavailable, take the tail (last N entries).
		let sessionEntries: SwarmKnowledgeEntry[];
		if (sessionStart) {
			const sessionStartMs = tryParseDate(sessionStart);
			if (sessionStartMs !== undefined) {
				sessionEntries = allEntries.filter((e) => {
					const createdMs = tryParseDate(e.created_at);
					return createdMs !== undefined && createdMs >= sessionStartMs;
				});
			} else {
				sessionEntries = allEntries.slice(-MAX_SESSION_ENTRIES_FOR_DEDUP);
			}
		} else {
			sessionEntries = allEntries.slice(-MAX_SESSION_ENTRIES_FOR_DEDUP);
		}

		// Cap the comparison set
		sessionEntries = sessionEntries.slice(0, MAX_SESSION_ENTRIES_FOR_DEDUP);
		if (sessionEntries.length === 0) return candidates;

		for (const sessionEntry of sessionEntries) {
			try {
				const match = _internals.findActiveSwarmNearDuplicate(
					sessionEntry.lesson,
					allEntries,
					threshold,
				);
				if (match && match.id !== sessionEntry.id) {
					candidates.push({
						sessionEntryText: sessionEntry.lesson,
						existingEntryText: match.lesson,
						existingEntryId: match.id,
					});
				}
			} catch {
				// Per-entry fail-open: one bad comparison must not abort the scan
			}
		}
	} catch {
		// Fail-open: entire gather degrades to empty candidates
	}

	return candidates;
}

// ─── Phase 1.6: Drafted issue candidate generation ───────────────────

/**
 * Scan .swarm/evidence/ for any failing-test entries and return their paths.
 * Used to populate "Related evidence" lines in issue drafts AND as an
 * independent qualification signal (taxonomy OR evidence qualifies).
 */
async function scanEvidencePaths(directory: string): Promise<string[]> {
	const paths: string[] = [];
	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		const dirEntries = await fs.readdir(evidenceDir);

		for (const dirEntry of dirEntries) {
			if (dirEntry.startsWith('retro-')) continue;
			const evidencePath = path.join(evidenceDir, dirEntry, 'evidence.json');
			try {
				const content = await fs.readFile(evidencePath, 'utf-8');
				const parsed = JSON.parse(content);
				const bundleEntries: Record<string, unknown>[] = Array.isArray(
					parsed.entries,
				)
					? parsed.entries
					: [parsed];

				for (const entry of bundleEntries) {
					const entryType = typeof entry.type === 'string' ? entry.type : '';
					const entryVerdict =
						typeof entry.verdict === 'string' ? entry.verdict : '';
					const entryTestFile =
						typeof entry.test_file === 'string' ? entry.test_file.trim() : '';
					if (
						!entryType.includes('test') ||
						(entryVerdict !== 'fail' && entryVerdict !== 'rejected') ||
						entryTestFile.length === 0
					) {
						continue;
					}
					paths.push(`.swarm/evidence/${dirEntry}/evidence.json`);
				}
			} catch {
				// Per-file failure is non-blocking
			}
		}
	} catch {
		// evidence dir may not exist
	}
	return [...new Set(paths)];
}

/**
 * Gather drafted (not filed) GitHub issue candidates for problems that have
 * reproduction evidence via error-taxonomy entries OR failing-test evidence.
 *
 * A problem signal from toolProblems or gateFailures produces an issue draft
 * when the session has ANY error-taxonomy entries (key presence, regardless of count) OR any
 * failing-test evidence paths in .swarm/evidence/. Either signal
 * independently qualifies — both are not required.
 *
 * The finalize report SHALL NOT file these issues (no gh subprocess).
 * FR-006.
 */
async function gatherDraftedIssueCandidates(
	data: SessionReflectionData,
	directory: string,
): Promise<DraftedIssueCandidate[]> {
	const candidates: DraftedIssueCandidate[] = [];

	const hasTaxonomyEntries = Object.keys(data.errorTaxonomy).length > 0;

	// Scan evidence paths — used both for qualification and for body content
	let evidencePaths: string[] = [];
	try {
		evidencePaths = await _internals.scanEvidencePaths(directory);
	} catch {
		// Non-blocking: informational section omitted on failure
	}

	const hasEvidence = evidencePaths.length > 0;
	if (!hasTaxonomyEntries && !hasEvidence) {
		return candidates;
	}

	const taxonomyCategories = Object.entries(data.errorTaxonomy)
		.filter(([, count]) => count > 0)
		.map(([cat, count]) => `${cat} (${count})`)
		.join(', ');
	const taxonomyNote = `Session recorded ${Object.keys(data.errorTaxonomy).length} error taxonomy entr${Object.keys(data.errorTaxonomy).length === 1 ? 'y' : 'ies'}: ${taxonomyCategories}`;

	// Process tool problems
	for (const problem of data.toolProblems) {
		candidates.push(
			buildDraft(
				problem.tool,
				taxonomyNote,
				evidencePaths,
				[
					`Tool \`${problem.tool}\` experienced ${problem.failureCount} failure(s) out of ${problem.totalCalls} calls (${Math.round(problem.failureRate * 100)}% failure rate), averaging ${problem.avgDurationMs}ms per call.`,
				],
				problem.tool,
			),
		);
	}

	// Process gate failures
	for (const failure of data.gateFailures) {
		candidates.push(
			buildDraft(
				failure.gate,
				taxonomyNote,
				evidencePaths,
				[
					`Gate \`${failure.gate}\` failed ${failure.count} time(s) on task ${failure.taskId}.`,
				],
				failure.gate,
			),
		);
	}

	return candidates;
}

/**
 * Build a single DraftedIssueCandidate from problem details.
 */
function buildDraft(
	category: string,
	taxonomyNote: string,
	evidencePaths: string[],
	problemLines: string[],
	errorCategory: string,
): DraftedIssueCandidate {
	const evidenceNote =
		evidencePaths.length > 0
			? `Related evidence: ${evidencePaths.join(', ')}`
			: undefined;

	const bodyParts: string[] = [
		'## Problem',
		'',
		...problemLines,
		'',
		'## Evidence',
		'',
		`- ${taxonomyNote}`,
	];

	if (evidenceNote) {
		bodyParts.push('', '- ' + evidenceNote);
	}

	return {
		title: `[${category}] Repeated failures during session reflection`,
		body: bodyParts.join('\n'),
		errorCategory,
		evidence: taxonomyNote,
	};
}

/** Parse an ISO 8601 date string; returns undefined if not parseable. */
function tryParseDate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

// ─── Action menu assembly (FR-007) ──────────────────────────────────

/** Maximum number of action menu items to surface. */
const MAX_ACTION_MENU_ITEMS = 12;

/**
 * Collect proposals from reflection signal data into a numbered action menu.
 *
 * Each item routes to an existing tool — the menu is always report-only.
 * Duplicate descriptions are deduplicated. Results are capped at
 * `MAX_ACTION_MENU_ITEMS`.
 */
function assembleActionMenu(data: SessionReflectionData): ActionMenuItem[] {
	const proposals: ActionMenuItem[] = [];
	let nextNumber = 1;

	// (a) Skill-violation signals → skill_improve
	for (const sv of data.skillViolationSignals ?? []) {
		if (sv.violationCount > 0) {
			proposals.push({
				number: nextNumber++,
				description: `Review skill violations for ${sv.skillPath}`,
				targetTool: 'skill_improve',
				data: { skillPath: sv.skillPath, violationCount: sv.violationCount },
			});
		}
	}

	// (b) Near-duplicate candidates → knowledge_add (for supersede discussion)
	for (const nd of data.nearDuplicateCandidates ?? []) {
		const sessionText =
			nd.sessionEntryText.length > 60
				? `${nd.sessionEntryText.slice(0, 57)}...`
				: nd.sessionEntryText;
		const existingText =
			nd.existingEntryText.length > 60
				? `${nd.existingEntryText.slice(0, 57)}...`
				: nd.existingEntryText;
		proposals.push({
			number: nextNumber++,
			description: `Review near-duplicate: ${sessionText} vs ${existingText}`,
			targetTool: 'knowledge_add',
			data: {
				existingEntryId: nd.existingEntryId,
				sessionEntryText: nd.sessionEntryText,
				existingEntryText: nd.existingEntryText,
				required_actions: [
					`compare knowledge entry ${nd.existingEntryId} against new session lesson for semantic overlap`,
				],
				applies_to_agents: ['coder'],
				verification_checks: [
					`knowledge.jsonl contains an entry referencing ${nd.existingEntryId}`,
				],
			},
		});
	}

	// (c) Drafted issues → gh issue create
	for (const issue of data.draftedIssueCandidates ?? []) {
		proposals.push({
			number: nextNumber++,
			description: `File issue: ${issue.title}`,
			targetTool: 'gh issue create',
			data: {
				title: issue.title,
				body: issue.body,
				errorCategory: issue.errorCategory,
			},
		});
	}

	// (d) Knowledge delta → skill_generate
	if ((data.lessonsStored ?? 0) > 0) {
		proposals.push({
			number: nextNumber++,
			description: `Compile ${data.lessonsStored} new lesson(s) into skills`,
			targetTool: 'skill_generate',
			data: { lessonsStored: data.lessonsStored },
		});
	}

	// Deduplicate by description
	const seen = new Set<string>();
	const deduped: ActionMenuItem[] = [];
	for (const item of proposals) {
		if (seen.has(item.description)) continue;
		seen.add(item.description);
		deduped.push(item);
	}

	// Re-number after dedup
	const result = deduped.slice(0, MAX_ACTION_MENU_ITEMS);
	for (let i = 0; i < result.length; i++) {
		result[i].number = i + 1;
	}

	return result;
}

// ─── Phase 2: Architect review ───────────────────────────────────────

function buildReflectionDataSummary(data: SessionReflectionData): string {
	const lines: string[] = [];

	lines.push('SESSION DATA SNAPSHOT');
	lines.push(`Total tool calls: ${data.totalToolCalls}`);
	lines.push(`Total tool failures: ${data.totalToolFailures}`);
	if (data.totalToolCalls > 0) {
		lines.push(
			`Overall failure rate: ${Math.round((data.totalToolFailures / data.totalToolCalls) * 100)}%`,
		);
	}
	lines.push('');

	if (data.toolProblems.length > 0) {
		lines.push('TOOL PROBLEMS (tools with >20% failure rate or >2 failures):');
		for (const p of data.toolProblems) {
			lines.push(
				`  - ${p.tool}: ${p.failureCount}/${p.totalCalls} failures (${Math.round(p.failureRate * 100)}%), avg ${p.avgDurationMs}ms`,
			);
		}
		lines.push('');
	}

	if (data.agentDispatches.length > 0) {
		lines.push('AGENT DISPATCHES:');
		for (const a of data.agentDispatches) {
			const reason = a.lastDelegationReason
				? ` (last reason: ${a.lastDelegationReason})`
				: '';
			lines.push(`  - ${a.agent}: ${a.delegationCount} delegation(s)${reason}`);
		}
		lines.push('');
	}

	if (data.gateFailures.length > 0) {
		lines.push('GATE FAILURES:');
		for (const gf of data.gateFailures) {
			lines.push(`  - ${gf.gate} on task ${gf.taskId}: ${gf.count} failure(s)`);
		}
		lines.push('');
	}

	const taxonomyEntries = Object.entries(data.errorTaxonomy).sort(
		(a, b) => b[1] - a[1],
	);
	if (taxonomyEntries.length > 0) {
		lines.push('ERROR TAXONOMY (from phase retrospectives):');
		for (const [category, count] of taxonomyEntries) {
			lines.push(`  - ${category}: ${count}`);
		}
		lines.push('');
	}

	if (data.lessonsFromRetros.length > 0) {
		lines.push('LESSONS FROM RETROSPECTIVES:');
		for (const lesson of data.lessonsFromRetros) {
			lines.push(`  - ${lesson}`);
		}
		lines.push('');
	}

	// Knowledge delta (FR-001)
	lines.push('KNOWLEDGE DELTA:');
	lines.push(`  - Lessons stored (curated): ${data.lessonsStored ?? 0}`);
	lines.push(`  - Knowledge entries created: ${data.knowledgeCreated ?? 0}`);
	lines.push(`  - Dedup drops (already-known): ${data.dedupDropCount ?? 0}`);
	lines.push(`  - Drain admitted: ${data.drainAdmitted ?? 0}`);
	lines.push(`  - Drain reinforced: ${data.drainReinforced ?? 0}`);
	lines.push(`  - Drain rejected: ${data.drainRejected ?? 0}`);
	lines.push('');

	// Skill violation signals (FR-002)
	const skillSignals = data.skillViolationSignals ?? [];
	if (skillSignals.length > 0) {
		lines.push('SKILL VIOLATION SIGNALS:');
		for (const sv of skillSignals) {
			lines.push(`  - ${sv.skillPath}: ${sv.violationCount} violation(s)`);
		}
	} else {
		lines.push('SKILL VIOLATION SIGNALS: 0 detected');
	}
	lines.push('');

	// Near-duplicate candidates (FR-003)
	const nearDups = data.nearDuplicateCandidates ?? [];
	if (nearDups.length > 0) {
		lines.push('NEAR-DUPLICATE CANDIDATES:');
		for (const nd of nearDups.slice(0, 5)) {
			lines.push(
				`  - Existing [${nd.existingEntryId}]: "${nd.existingEntryText.slice(0, 80)}"`,
			);
			lines.push(`    Session entry: "${nd.sessionEntryText.slice(0, 80)}"`);
		}
	} else {
		lines.push('NEAR-DUPLICATE CANDIDATES: 0 found');
	}
	lines.push('');

	// Drafted issue candidates (FR-006)
	const issueCandidates = data.draftedIssueCandidates ?? [];
	if (issueCandidates.length > 0) {
		lines.push('DRAFTED ISSUE CANDIDATES:');
		for (const issue of issueCandidates.slice(0, 5)) {
			lines.push(`  - [${issue.errorCategory}] ${issue.title}`);
		}
	} else {
		lines.push('DRAFTED ISSUE CANDIDATES: 0 drafted');
	}
	lines.push('');

	// Assembled action menu (FR-007)
	const summaryMenu = data.assembledMenu ?? [];
	lines.push(`ACTION MENU: ${summaryMenu.length} items proposed`);
	lines.push('');

	return lines.join('\n');
}

export const REFLECTION_SYSTEM_PROMPT = `You are the architect reviewing a completed swarm session. Your job is to analyze what happened and produce a concise, actionable report for the human operator.

You have been given the full session telemetry: tool call statistics, agent dispatches, gate failures, error taxonomy, and lessons from phase retrospectives.

Your report MUST include these sections (omit a section only if there is genuinely nothing to say):

## Problems Encountered
What went wrong during this session? Tool failures, repeated gate rejections, error patterns. Be specific — name the tools, the error categories, the tasks affected. If nothing went wrong, say so clearly.

## Tools That Didn't Work
Which tools had high failure rates or were slow? What was the likely cause? What should the operator or the swarm do differently next time?

## Skill Recommendations
Based on everything that happened in this session, should any existing skills be updated or new skills be created? Be specific: name the skill, describe the change, and explain why. Consider:
- Patterns that repeated across multiple tasks or phases
- Workarounds the agents had to use
- Knowledge gaps the agents exposed
- Conventions the session revealed that aren't captured in any skill

If no skills need updating or creating, say so clearly — capturing nothing is a valid outcome.

## Process Improvements
What should the swarm do differently next time? Dispatch patterns, gate configurations, agent routing, phase structure — anything the architect should learn from this session.

Keep the report under 3000 characters. Be direct. No filler. Every sentence should be actionable or provide specific evidence. If the session was clean with no issues, say so in 2-3 sentences and skip the detailed sections.`;

function buildDeterministicReport(data: SessionReflectionData): string {
	const lines: string[] = [];
	lines.push('## Problems Encountered');
	lines.push('');

	if (data.totalToolFailures === 0 && data.gateFailures.length === 0) {
		lines.push('No tool failures or gate rejections recorded this session.');
		lines.push('');
	} else {
		if (data.totalToolFailures > 0) {
			const rate =
				data.totalToolCalls > 0
					? Math.round((data.totalToolFailures / data.totalToolCalls) * 100)
					: 0;
			lines.push(
				`${data.totalToolFailures} tool failure(s) across ${data.totalToolCalls} calls (${rate}% failure rate).`,
			);
		}
		if (data.gateFailures.length > 0) {
			lines.push(`${data.gateFailures.length} gate failure(s) recorded:`);
			for (const gf of data.gateFailures.slice(0, 5)) {
				lines.push(`- ${gf.gate} on task ${gf.taskId} (${gf.count}x)`);
			}
		}
		const taxonomyEntries = Object.entries(data.errorTaxonomy).sort(
			(a, b) => b[1] - a[1],
		);
		if (taxonomyEntries.length > 0) {
			lines.push('');
			lines.push('Error patterns:');
			for (const [cat, count] of taxonomyEntries) {
				lines.push(`- ${cat}: ${count} occurrence(s)`);
			}
		}
		lines.push('');
	}

	if (data.toolProblems.length > 0) {
		lines.push("## Tools That Didn't Work");
		lines.push('');
		for (const p of data.toolProblems) {
			lines.push(
				`- **${p.tool}**: ${p.failureCount}/${p.totalCalls} failures (${Math.round(p.failureRate * 100)}%), avg ${p.avgDurationMs}ms per call`,
			);
		}
		lines.push('');
	}

	if (data.lessonsFromRetros.length > 0) {
		lines.push('## Skill Recommendations');
		lines.push('');
		lines.push(
			'The following lessons were captured during the session. Review them for skill creation/update opportunities:',
		);
		for (const lesson of data.lessonsFromRetros) {
			lines.push(`- ${lesson}`);
		}
		lines.push('');
	} else {
		lines.push('## Skill Recommendations');
		lines.push('');
		lines.push(
			'No skills need updating or creating — capturing nothing is a valid outcome.',
		);
		lines.push('');
	}

	// Knowledge delta section (FR-001, FR-004)
	lines.push('## Knowledge Delta');
	lines.push('');
	lines.push(`- Lessons curated: ${data.lessonsStored ?? 0}`);
	lines.push(`- Knowledge entries created: ${data.knowledgeCreated ?? 0}`);
	lines.push(`- Dedup drops (already-known): ${data.dedupDropCount ?? 0}`);
	lines.push(`- Drain admitted: ${data.drainAdmitted ?? 0}`);
	lines.push(`- Drain reinforced: ${data.drainReinforced ?? 0}`);
	lines.push(`- Drain rejected: ${data.drainRejected ?? 0}`);
	lines.push('');

	// Skill violation signals (FR-002)
	lines.push('## Skill Violations');
	lines.push('');
	const detSkillSignals = data.skillViolationSignals ?? [];
	if (detSkillSignals.length > 0) {
		for (const sv of detSkillSignals.slice(0, 10)) {
			lines.push(`- **${sv.skillPath}**: ${sv.violationCount} violation(s)`);
		}
	} else {
		lines.push('No skill violations detected this session.');
	}
	lines.push('');

	// Near-duplicate candidates (FR-003)
	lines.push('## Near-Duplicate Candidates');
	lines.push('');
	const detNearDups = data.nearDuplicateCandidates ?? [];
	if (detNearDups.length > 0) {
		for (const nd of detNearDups.slice(0, 5)) {
			lines.push(
				`- Existing [${nd.existingEntryId}]: "${nd.existingEntryText.slice(0, 80)}"`,
			);
			lines.push(`  Session: "${nd.sessionEntryText.slice(0, 80)}"`);
		}
	} else {
		lines.push('No near-duplicate candidates detected this session.');
	}
	lines.push('');

	// Drafted issue candidates (FR-006)
	lines.push('## Drafted Issue Candidates');
	lines.push('');
	const detIssueCandidates = data.draftedIssueCandidates ?? [];
	if (detIssueCandidates.length > 0) {
		for (const issue of detIssueCandidates.slice(0, 5)) {
			lines.push(`- **[${issue.errorCategory}]** ${issue.title}`);
		}
	} else {
		lines.push('No drafted issue candidates this session.');
	}
	lines.push('');

	// NOTE: Proposed Actions menu (FR-007) is NOT rendered here anymore.
	// It is appended externally in runSessionReflection to ensure it
	// appears in BOTH LLM and deterministic report paths.

	lines.push('## Process Improvements');
	lines.push('');
	if (
		data.totalToolFailures === 0 &&
		data.gateFailures.length === 0 &&
		data.lessonsFromRetros.length === 0
	) {
		lines.push('Session completed without notable issues.');
	} else {
		lines.push(
			'_Deterministic fallback: no LLM client available for deep analysis. Review the data above manually._',
		);
	}
	lines.push('');

	return lines.join('\n');
}

// ─── Action menu persistence (FR-010) ────────────────────────────

/**
 * Atomic write helper: write `content` to `targetPath` via a temp file
 * and rename.  If the rename fails, the temp file is cleaned up.
 *
 * On POSIX, `fs.rename` is atomic within the same filesystem.
 * On Windows, `fs.rename` may fail if the target already exists and is
 * open; the outer try/catch in `persistActionMenu` handles this as a
 * non-blocking fail-open.
 */
async function atomicWriteJson(
	targetPath: string,
	content: string,
): Promise<void> {
	const tmpPath = `${targetPath}.tmp`;
	await _internals.writeFile(tmpPath, content, 'utf-8');
	try {
		await _internals.rename(tmpPath, targetPath);
	} catch {
		// Rename failed — clean up the temp file so we don't leave garbage.
		try {
			await _internals.unlink(tmpPath);
		} catch {
			// Best-effort cleanup; ignore failure.
		}
		throw new Error('atomic rename failed');
	}
}

/**
 * Persist the assembled action menu to `.swarm/memory/` so it survives
 * finalize clean+align.  Uses atomic temp-and-rename to prevent truncating
 * an existing artifact if the write fails partway.  Fail-open: any I/O
 * error is caught and logged via console.debug — the menu remains
 * available in the in-session report.
 *
 * @param directory - Project root directory
 * @param menu - Assembled action menu items (may be empty)
 * @param sessionId - Session identifier; uses 'unknown' when absent
 */
async function persistActionMenu(
	directory: string,
	menu: ActionMenuItem[],
	sessionId?: string,
): Promise<void> {
	if (!menu || menu.length === 0) return;
	try {
		const safeId = sessionId ?? 'unknown';
		const filename = `memory/action-menu-${safeId}.json`;
		const filePath = validateSwarmPath(directory, filename);
		const content = JSON.stringify(
			{ sessionId: safeId, timestamp: new Date().toISOString(), items: menu },
			null,
			2,
		);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await atomicWriteJson(filePath, content);
	} catch {
		// Fail-open: menu persistence is advisory, not blocking
	}
}

/** Maximum age (ms) for a persisted action menu before it is considered expired. */
const ACTION_MENU_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Shape of the persisted action-menu JSON file. */
interface PersistedActionMenu {
	sessionId: string;
	timestamp: string;
	items: ActionMenuItem[];
}

/**
 * Read a persisted action menu from `.swarm/memory/action-menu-*.json`.
 *
 * When `sessionID` is provided, reads the exact file for that session.
 * When omitted, scans the memory directory for the most recent menu file.
 * Returns null when no menu is found or the menu is expired (>24h old).
 *
 * FR-013: Application writes persist to durable stores — reads the durable artifact.
 *
 * @param directory - Project root directory
 * @param sessionID - Optional session identifier for exact lookup
 * @returns The parsed menu items, or null if not found / expired
 */
async function readActionMenu(
	directory: string,
	sessionID?: string,
): Promise<ActionMenuItem[] | null> {
	try {
		let filePath: string;

		if (sessionID) {
			filePath = validateSwarmPath(
				directory,
				`memory/action-menu-${sessionID}.json`,
			);
		} else {
			// Scan for the most recent menu file when no sessionID is provided
			const memoryDir = validateSwarmPath(directory, 'memory');
			const entries = await fs.readdir(memoryDir).catch(() => [] as string[]);
			const menuFiles = entries
				.filter((e) => e.startsWith('action-menu-') && e.endsWith('.json'))
				.sort();

			if (menuFiles.length === 0) return null;
			filePath = path.join(memoryDir, menuFiles[menuFiles.length - 1]);
		}

		const content = await fs.readFile(filePath, 'utf-8');
		const parsed: PersistedActionMenu = JSON.parse(content);

		if (!parsed.items || parsed.items.length === 0) return null;

		// Check staleness — reject menus older than 24 hours
		const menuAge = Date.now() - new Date(parsed.timestamp).getTime();
		if (menuAge > ACTION_MENU_MAX_AGE_MS) return null;

		return parsed.items;
	} catch {
		return null;
	}
}

// ─── Action menu formatting (FR-007) ──────────────────────────────

/**
 * Render the assembled action menu as a numbered markdown section.
 * Returns empty string when there are no menu items.
 */
function formatActionMenuText(menu: ActionMenuItem[]): string {
	if (!menu || menu.length === 0) return '';
	const lines: string[] = [];
	lines.push('## Proposed Actions');
	lines.push('');
	for (const item of menu) {
		lines.push(
			`${item.number}. ${item.description} → (tool: ${item.targetTool})`,
		);
	}
	lines.push('');
	return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

export interface SessionReflectionInput {
	directory: string;
	toolAggregates: Map<string, ToolAggregate>;
	agentSessions: Map<string, AgentSessionLike>;
	sessionId?: string;
	/** ISO 8601 timestamp of session start; used to scope knowledge entries for dedup. */
	sessionStart?: string;
	signal?: AbortSignal;
	delegate?: SkillImproverLLMDelegate;
	/** Knowledge entries actually stored via curation this session */
	lessonsStored?: number;
	/** Total knowledge entries created this session */
	knowledgeCreated?: number;
	/** Retro lessons deduped as already-known */
	dedupDropCount?: number;
	/** Drain admitted count (admission drain this session) */
	drainAdmitted?: number;
	/** Drain reinforced count (admission drain this session) */
	drainReinforced?: number;
	/** Drain rejected count (admission drain this session) */
	drainRejected?: number;
	/** Jaccard bigram threshold for near-duplicate detection (0-1). FR-003. */
	dedupThreshold?: number;
}

export async function runSessionReflection(
	input: SessionReflectionInput,
): Promise<SessionReflectionResult> {
	const { problems, totalCalls, totalFailures } = gatherToolProblems(
		input.toolAggregates,
	);
	const agentDispatches = gatherAgentDispatches(input.agentSessions);
	const { lessons, taxonomy } = await gatherRetroLessonsAndTaxonomy(
		input.directory,
	);
	const gateFailures = await gatherGateFailures(input.directory);

	// FR-002: skill-violation signals — individually fail-open because the
	// shared CLOSE_REFLECTION_TIMEOUT_MS discards the entire report on expiry.
	let skillViolationSignals: SkillViolationSignal[] = [];
	try {
		skillViolationSignals = await _internals.gatherSkillViolationSignals(
			input.directory,
			input.sessionId,
		);
	} catch {
		// Non-blocking: degrade to empty signals rather than crashing the report
	}

	// FR-003: near-duplicate candidate detection — individually fail-open.
	let nearDuplicateCandidates: NearDuplicateCandidate[] = [];
	try {
		nearDuplicateCandidates = await _internals.gatherNearDuplicateCandidates(
			input.directory,
			input.sessionStart,
			input.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD,
		);
	} catch {
		// Non-blocking: degrade to empty candidates rather than crashing the report
	}

	const data: SessionReflectionData = {
		timestamp: new Date().toISOString(),
		totalToolCalls: totalCalls,
		totalToolFailures: totalFailures,
		toolProblems: problems,
		agentDispatches,
		gateFailures,
		lessonsFromRetros: lessons,
		errorTaxonomy: taxonomy,
		lessonsStored: input.lessonsStored ?? 0,
		knowledgeCreated: input.knowledgeCreated ?? 0,
		dedupDropCount: input.dedupDropCount ?? 0,
		drainAdmitted: input.drainAdmitted ?? 0,
		drainReinforced: input.drainReinforced ?? 0,
		drainRejected: input.drainRejected ?? 0,
		skillViolationSignals,
		nearDuplicateCandidates,
		draftedIssueCandidates: [],
	};

	// FR-006: drafted issue candidates — individually fail-open.
	try {
		data.draftedIssueCandidates = await _internals.gatherDraftedIssueCandidates(
			data,
			input.directory,
		);
	} catch {
		// Non-blocking: degrade to empty candidates rather than crashing the report
	}

	// FR-007: assemble action menu from all signal data — fail-open.
	try {
		data.assembledMenu = _internals.assembleActionMenu(data);
	} catch {
		// Non-blocking: degrade to no menu rather than crashing the report
	}

	const delegate =
		input.delegate ??
		createSkillImproverLLMDelegate(input.directory, input.sessionId);

	// FR-007: append action menu to ensure it appears in BOTH LLM and deterministic paths.
	const menuText = _internals.formatActionMenuText(data.assembledMenu ?? []);

	if (delegate && !input.signal?.aborted) {
		try {
			const dataSummary = buildReflectionDataSummary(data);
			const report = await delegate(
				REFLECTION_SYSTEM_PROMPT,
				dataSummary,
				input.signal,
			);
			if (report && report.trim().length > 0) {
				const finalReport = menuText
					? `${report.trim()}\n\n${menuText}`
					: report.trim();
				return { data, architectReport: finalReport, source: 'llm' };
			}
		} catch {
			// LLM failed — fall through to deterministic
		}
	}

	const deterministicReport = buildDeterministicReport(data);
	const finalDeterministicReport = menuText
		? `${deterministicReport}\n\n${menuText}`
		: deterministicReport;

	return {
		data,
		architectReport: finalDeterministicReport,
		source: 'deterministic',
	};
}

export async function writeSessionReflection(
	directory: string,
	result: SessionReflectionResult,
): Promise<string> {
	const reflectionPath = validateSwarmPath(directory, 'session-reflection.md');
	const lines: string[] = [];
	lines.push('# Session Reflection');
	lines.push('');
	lines.push(`Generated: ${result.data.timestamp}`);
	lines.push(`Source: ${result.source}`);
	lines.push('');
	lines.push(result.architectReport);
	const content = lines.join('\n');
	await fs.writeFile(reflectionPath, content, 'utf-8');
	return reflectionPath;
}

export { readActionMenu };

export const _internals = {
	gatherToolProblems,
	gatherAgentDispatches,
	gatherRetroLessonsAndTaxonomy,
	gatherGateFailures,
	gatherSkillViolationSignals,
	gatherNearDuplicateCandidates,
	gatherDraftedIssueCandidates,
	scanEvidencePaths,
	findActiveSwarmNearDuplicate,
	buildReflectionDataSummary,
	buildDeterministicReport,
	assembleActionMenu,
	formatActionMenuText,
	persistActionMenu,
	readActionMenu,
	ACTION_MENU_MAX_AGE_MS,
	// DI seams for atomic write — tests can inject failures here.
	writeFile: fs.writeFile.bind(fs),
	rename: fs.rename.bind(fs),
	unlink: fs.unlink.bind(fs),
};
