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
import {
	jaccardBigram,
	readKnowledge,
	readRejectedLessons,
	resolveSwarmKnowledgePath,
	wordBigrams,
} from '../hooks/knowledge-store';
import type {
	RejectedLesson,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types';
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

export interface ToolProblem {
	tool: string;
	failureCount: number;
	totalCalls: number;
	failureRate: number;
	avgDurationMs: number;
	/**
	 * Issue #2349 sweep: a bounded, deduplicated sample of WHY this tool failed.
	 * Reporting only that a tool failed N times is the same defect class the
	 * sweep set out to close — the reason has to reach a surface a human or
	 * agent actually reads, which is this one.
	 */
	failureReasons?: string[];
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

/**
 * Knowledge-delta surface for the reflection report (issue #2077).
 *
 * `admitted` / `reinforcedRealtime` / `rejectedCurator` are recovered
 * READ-ONLY from durable markers stamped by the realtime admission path
 * (`src/learning/admission.ts`) and the curator rejected-lessons file —
 * the in-memory `DrainSummary` is discarded at `src/index.ts` (issue
 * #1821), but the outcomes it summarized persist on the entries
 * themselves, so the counts are reconstructable here without any new
 * writes. Realtime *rejections* (screened-out candidates that never
 * reached the store) remain unobservable and are flagged in the report.
 */
export interface KnowledgeDelta {
	/** Entries created this session (count, from countSessionKnowledgeEntries). */
	sessionKnowledgeCreated: number;
	/** FR-015 dedup: retro lessons dropped as already-known. */
	dedupDropped: number;
	/** False when the dedup read failed (fail-open) — distinguishes "0 deduped" from "dedup did not run". */
	dedupAvailable: boolean;
	/** Retro lessons that survived dedup and were curated. */
	retroLessonTotal: number;
	/** Close-time curation counts (finalize retro-lesson batch). */
	curation?: {
		stored: number;
		reinforced: number;
		skipped: number;
		rejected: number;
		quarantined: number;
	};
	/** Entries admitted this session (created_at >= sessionStart AND carry an `insight:` provenance marker). */
	admitted?: number;
	/** Pre-existing entries reinforced this session (some confirmed_by[].confirmed_at >= sessionStart). */
	reinforcedRealtime?: number;
	/** Curator-path rejections this session (rejected_at >= sessionStart, from .swarm/knowledge-rejected.jsonl). */
	rejectedCurator?: number;
}

export interface SkillViolationSignal {
	skillPath: string;
	violations: number;
	total: number;
	/** Always true — the 64 KB tail may truncate the denominator. */
	tailBounded: boolean;
	/** 'session' when filtered by sessionID; 'all_sessions' when no sessionID was available. */
	scope: 'session' | 'all_sessions';
}

export interface ContradictionCandidate {
	newLesson: string;
	newEntryId: string;
	conflictsWithId: string;
	conflictsWithLesson: string;
	similarity: number;
}

export type ReflectionActionKind = 'supersede' | 'file_issue' | 'draft_skill';

export interface ReflectionActionProposal {
	kind: ReflectionActionKind;
	/** Short human-readable label for the menu line. */
	label: string;
	/** Longer body (issue body, lesson text, etc.). */
	detail: string;
	/** Existing tool/command to route to, e.g. '/swarm curate'. */
	routing: string;
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
	knowledgeDelta?: KnowledgeDelta;
	skillViolations: SkillViolationSignal[];
	contradictionCandidates: ContradictionCandidate[];
	/**
	 * Issue #2271 bug 6: rejection/circuit-breaker/manual-approval event counts
	 * by type, read from the session ledger (.swarm/events.jsonl). Gate denials
	 * throw in tool.execute.before and never increment ToolAggregate counters
	 * (denied calls do not fire toolAfter), so without this field a session
	 * full of gate rejections reports "0 tool failures or gate rejections".
	 */
	ledgerRejections?: Record<string, number>;
}

export interface SessionReflectionResult {
	data: SessionReflectionData;
	architectReport: string;
	/**
	 * Always-rendered signals block (issue #2077). Surfaced UNCONDITIONALLY
	 * by close.ts (not gated by the narrative-report `hasSignals` check) so
	 * the "0 captured; N deduped" / NOOP line appears even in a clean
	 * session. Present on BOTH the llm and deterministic paths.
	 */
	signalsReport: string;
	source: 'llm' | 'deterministic';
	actionProposals: ReflectionActionProposal[];
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
					...(agg.failureReasons && agg.failureReasons.length > 0
						? { failureReasons: agg.failureReasons }
						: {}),
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
					if (
						entry.error_taxonomy &&
						typeof entry.error_taxonomy === 'object'
					) {
						for (const [key, val] of Object.entries(entry.error_taxonomy)) {
							if (typeof val === 'number') {
								taxonomy[key] = (taxonomy[key] ?? 0) + val;
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

/**
 * Issue #2271 bug 6: event types in .swarm/events.jsonl that represent a
 * rejection, circuit-breaker trip, or manual gate override. These events are
 * written when a gate DENIES a call — and a denied call throws in
 * tool.execute.before, so it never fires toolAfter and never increments the
 * ToolAggregate failure counters the report used to rely on exclusively.
 * `task_removed`, `sounding_board_consulted`, and the advisory `prm_*`
 * pattern events are deliberately NOT here: they are process/telemetry
 * records, not failures. (`prm_hard_stop*` is telemetry.jsonl-only — it has
 * no events.jsonl writer, so listing it here could never match.)
 *
 * NOTE on field shapes: several of these writers emit NO session field
 * (e.g. coder_retry_circuit_breaker); sessionless events are counted even in
 * scoped mode because they cannot be attributed to a sibling session.
 */
const REJECTION_LEDGER_EVENT_TYPES = new Set([
	'coder_retry_circuit_breaker',
	'plan_critic_gate_manual_approval',
	'architect_loop_detected',
	'agent_conflict_detected',
]);

/** Size bound for the ledger read — session-scoped, but bounded regardless. */
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

/**
 * Count rejection-class events in the session ledger. Reads the LIVE
 * .swarm/events.jsonl first (finalize runs before archive in the close
 * pipeline), falling back to the newest archived copy for a partially-run
 * prior close. Fail-open: any read/parse problem yields empty counts.
 *
 * When `sessionId` is provided, events carrying a DIFFERENT session id are
 * ignored so a per-session close summary cannot overcount sibling sessions'
 * rejections in multi-swarm projects. Events with NO session field are still
 * counted: several rejection writers emit none (coder_retry_circuit_breaker,
 * architect_loop_detected), a sessionless event cannot be attributed to a
 * sibling session, and dropping them would resurrect the bug-6 undercount in
 * the standard close flow.
 */
async function gatherLedgerRejections(
	directory: string,
	sessionId?: string,
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	// PR-review PRR-016: an oversized ledger is read from its TAIL (the most
	// recent — session-relevant — events) instead of being refused outright;
	// refusing silently resurrected bug 6's "no rejections" false claim for
	// long-running sessions. A partial first line (cut mid-record by the tail
	// window) is skipped by the JSON.parse try/catch below.
	const readLedger = async (filePath: string): Promise<string | null> => {
		try {
			const handle = await fs.open(filePath, 'r');
			try {
				const stat = await handle.stat();
				if (!stat.isFile()) return null;
				const length = Math.min(stat.size, MAX_LEDGER_BYTES);
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, stat.size - length);
				return buffer.toString('utf-8');
			} finally {
				await handle.close().catch(() => {});
			}
		} catch {
			return null;
		}
	};
	// PR-review PRR-007: containment guard for the archive fallback — the
	// entry names come from readdir and a planted symlink under .swarm/archive
	// must not steer the read outside the archive tree (mirrors the
	// lstat/realpath discipline of validateSwarmPath without importing hooks
	// code into services).
	const readContained = async (
		root: string,
		...segments: string[]
	): Promise<string | null> => {
		const target = path.join(root, ...segments);
		try {
			const realRoot = await fs.realpath(path.join(root));
			const realTarget = await fs.realpath(target);
			const rel = path.relative(realRoot, realTarget);
			if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
		} catch {
			return null;
		}
		return readLedger(target);
	};

	let content = await readLedger(
		path.join(directory, '.swarm', 'events.jsonl'),
	);
	if (content === null) {
		try {
			const archiveRoot = path.join(directory, '.swarm', 'archive');
			const archiveEntries = await fs.readdir(archiveRoot);
			const archives = archiveEntries
				.filter((entry) => entry.startsWith('swarm-'))
				.sort();
			for (
				let index = archives.length - 1;
				index >= 0 && content === null;
				index--
			) {
				content = await readContained(
					archiveRoot,
					archives[index],
					'events.jsonl',
				);
			}
		} catch {
			/* no archive directory */
		}
	}
	if (content === null) return counts;

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as {
				type?: unknown;
				sessionId?: unknown;
				sessionID?: unknown;
			};
			if (
				typeof parsed.type === 'string' &&
				REJECTION_LEDGER_EVENT_TYPES.has(parsed.type)
			) {
				if (sessionId !== undefined) {
					const eventSession =
						typeof parsed.sessionId === 'string'
							? parsed.sessionId
							: typeof parsed.sessionID === 'string'
								? parsed.sessionID
								: undefined;
					// Sessionless rejection events stay counted (see doc);
					// only events that name a DIFFERENT session are excluded.
					if (eventSession !== undefined && eventSession !== sessionId)
						continue;
				}
				counts[parsed.type] = (counts[parsed.type] ?? 0) + 1;
			}
		} catch {
			/* malformed ledger line — skip */
		}
	}
	return counts;
}

// ─── Issue #2077 signal gatherers (advisory, read-only) ──────────────
//
// Every function below is READ-ONLY: it reads durable artifacts
// (.swarm/skill-usage.jsonl, the swarm knowledge file, the rejected
// lessons file) and never mutates a store. Each fails open to an empty
// result so reflection never blocks finalize. They are exposed via the
// `_internals` seam AND invoked through it from `runSessionReflection`,
// so tests inject fakes without `mock.module`.

/** Lower band for the contradiction-candidate similarity window. */
const CONTRADICTION_LOWER = 0.45;
/** Cap on session-created entries scanned for contradiction pairs. */
const CONTRADICTION_SESSION_CAP = 50;
/** Cap on emitted contradiction pairs. */
const CONTRADICTION_PAIR_CAP = 10;
/** Cap on skill-violation rows. */
const SKILL_VIOLATION_CAP = 5;
/** Default realtime admission dedup threshold, mirrored from config schema. */
const DEFAULT_DEDUP_THRESHOLD = 0.6;

/** Negation-polarity heuristic. A contradiction candidate diverges in polarity. */
const NEGATION_RE =
	/\b(never|not|don't|avoid|must\s+not|no\s+longer|forbid|prohibit)\b/i;

function isNegationDivergent(a: string, b: string): boolean {
	const aNeg = NEGATION_RE.test(a ?? '');
	const bNeg = NEGATION_RE.test(b ?? '');
	// Divergence = exactly one side carries negation polarity.
	return aNeg !== bNeg;
}

/**
 * Top skills by violation this session (issue #2077).
 *
 * Reads the bounded tail of `.swarm/skill-usage.jsonl`, groups by
 * `skillPath`, and counts entries where the normalized compliance
 * verdict is `'violated'`. Returns `[]` when `sessionId` is undefined:
 * without a session filter the tail is cumulative cross-session data
 * and MUST NOT be labeled "this session" (issue #2077 critic item 8).
 * `tailBounded` is always true — the 64 KB tail may truncate the
 * denominator.
 */
export function gatherSkillViolations(
	directory: string,
	sessionId?: string,
): SkillViolationSignal[] {
	if (!sessionId) return [];
	try {
		const entries = _internals.readSkillUsageEntriesTail(directory, {
			sessionID: sessionId,
		});
		const bySkill = new Map<string, { violations: number; total: number }>();
		for (const entry of entries) {
			const skill = entry.skillPath;
			if (!skill) continue;
			const agg = bySkill.get(skill) ?? { violations: 0, total: 0 };
			agg.total++;
			if (normalizeComplianceVerdict(entry.complianceVerdict) === 'violated') {
				agg.violations++;
			}
			bySkill.set(skill, agg);
		}
		return [...bySkill.entries()]
			.map(([skillPath, agg]) => ({
				skillPath,
				violations: agg.violations,
				total: agg.total,
				tailBounded: true,
				scope: 'session' as const,
			}))
			.filter((s) => s.violations > 0)
			.sort((a, b) => b.violations - a.violations)
			.slice(0, SKILL_VIOLATION_CAP);
	} catch {
		return [];
	}
}

/**
 * Contradiction candidates among session-created knowledge (issue #2077).
 *
 * IMPORTANT (issue #2077 critic item 3): the realtime admission and
 * curator write paths dedup at `dedup_threshold` (default 0.6) BEFORE an
 * entry becomes active, so two active entries with Jaccard similarity
 * ≥ that threshold cannot coexist. A detector run at the dedup threshold
 * would therefore return `[]` in every real session. Instead this looks
 * in a sub-threshold band `[CONTRADICTION_LOWER, dedupThreshold)` AND
 * requires negation-polarity divergence — the only shape that can occur
 * in production. Uses the exported `wordBigrams`/`jaccardBigram`
 * primitives directly so the score is available (the
 * `findActiveSwarmNearDuplicate` helper returns only the entry, with no
 * score and no self-exclusion). Detect-only: never writes, never
 * auto-supersedes. Supersession is operationally deletion
 * (`superseded_by IS NULL` read filter) and is surfaced only as a menu
 * item the user opts into.
 */
export async function gatherContradictionCandidates(
	directory: string,
	sessionStart?: string,
	dedupThreshold: number = DEFAULT_DEDUP_THRESHOLD,
): Promise<ContradictionCandidate[]> {
	if (!sessionStart) return [];
	const sessionStartMs = Date.parse(sessionStart);
	if (!Number.isFinite(sessionStartMs)) return [];
	try {
		const all = await _internals.readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(directory),
		);
		const sessionCreated = all
			.filter((e) => {
				if (typeof e.created_at !== 'string') return false;
				const ms = Date.parse(e.created_at);
				return Number.isFinite(ms) && ms >= sessionStartMs;
			})
			.slice(0, CONTRADICTION_SESSION_CAP);
		if (sessionCreated.length === 0) return [];
		const seen = new Set<string>();
		const pairs: ContradictionCandidate[] = [];
		for (const entry of sessionCreated) {
			if (pairs.length >= CONTRADICTION_PAIR_CAP) break;
			const entryBigrams = wordBigrams(entry.lesson);
			for (const other of all) {
				if (other.id === entry.id) continue; // self-exclusion
				const sim = jaccardBigram(entryBigrams, wordBigrams(other.lesson));
				if (
					sim >= CONTRADICTION_LOWER &&
					sim < dedupThreshold &&
					isNegationDivergent(entry.lesson, other.lesson)
				) {
					const key = [entry.id, other.id].sort().join('|');
					if (seen.has(key)) continue; // dedup symmetric (A,B)/(B,A)
					seen.add(key);
					pairs.push({
						newLesson: entry.lesson,
						newEntryId: entry.id,
						conflictsWithId: other.id,
						conflictsWithLesson: other.lesson,
						similarity: Math.round(sim * 100) / 100,
					});
					if (pairs.length >= CONTRADICTION_PAIR_CAP) break;
				}
			}
		}
		return pairs;
	} catch {
		return [];
	}
}

/**
 * Realtime admission counts recovered READ-ONLY from durable markers
 * (issue #2077 critic item 4). The in-memory `DrainSummary` is
 * discarded at `src/index.ts`, but the outcomes persist:
 *   - admitted:   entries created this session with an `insight:` provenance marker
 *     (stamped by `admitCandidate` via `unionSourceKnowledgeIds`).
 *   - reinforced: pre-existing entries with a `confirmed_by` record
 *     stamped this session (the realtime reinforce path).
 *   - rejected:   curator-path rejections this session, from
 *     `.swarm/knowledge-rejected.jsonl`.
 * Returns `undefined` when `sessionStart` is undefined (counts are
 * session-scoped). Realtime *rejections* (screened-out candidates that
 * never reached the store) are NOT recoverable and are flagged in the
 * report as tracked by #1821.
 */
export async function gatherRealtimeAdmissionCounts(
	directory: string,
	sessionStart?: string,
): Promise<
	| {
			admitted: number;
			reinforced: number;
			rejected: number;
	  }
	| undefined
> {
	if (!sessionStart) return undefined;
	const sessionStartMs = Date.parse(sessionStart);
	if (!Number.isFinite(sessionStartMs)) return undefined;
	try {
		const entries = await _internals.readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(directory),
		);
		let admitted = 0;
		let reinforced = 0;
		for (const e of entries) {
			const createdMs =
				typeof e.created_at === 'string'
					? Date.parse(e.created_at)
					: Number.NaN;
			const createdThisSession =
				Number.isFinite(createdMs) && createdMs >= sessionStartMs;
			const hasInsightMarker = (e.source_knowledge_ids ?? []).some((id) =>
				id.startsWith('insight:'),
			);
			if (createdThisSession && hasInsightMarker) admitted++;
			const confirmedThisSession = (e.confirmed_by ?? []).some(
				(rec: { confirmed_at?: string }) => {
					const ts =
						typeof rec?.confirmed_at === 'string' ? rec.confirmed_at : '';
					const ms = Date.parse(ts);
					return Number.isFinite(ms) && ms >= sessionStartMs;
				},
			);
			if (!createdThisSession && confirmedThisSession) reinforced++;
		}
		let rejected = 0;
		try {
			const rejectedLessons = await _internals.readRejectedLessons(directory);
			rejected = rejectedLessons.filter((r: RejectedLesson) => {
				const ms = Date.parse(r.rejected_at ?? '');
				return Number.isFinite(ms) && ms >= sessionStartMs;
			}).length;
		} catch {
			rejected = 0;
		}
		return { admitted, reinforced, rejected };
	} catch {
		return undefined;
	}
}

// ─── Phase 2: Architect review ───────────────────────────────────────

function buildReflectionDataSummary(data: SessionReflectionData): string {
	const lines: string[] = [];
	// Defensive defaults: tests and older callers may construct partial data.
	const skillViolations = data.skillViolations ?? [];
	const contradictionCandidates = data.contradictionCandidates ?? [];

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
			// Issue #2349 sweep: surface WHY, not just how often.
			if (p.failureReasons && p.failureReasons.length > 0) {
				lines.push(`      reasons: ${p.failureReasons.join('; ')}`);
			}
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

	if (data.knowledgeDelta) {
		const kd = data.knowledgeDelta;
		lines.push('KNOWLEDGE DELTA:');
		lines.push(
			`  - ${kd.sessionKnowledgeCreated} knowledge entries created this session.`,
		);
		if (kd.curation) {
			lines.push(
				`  - Curation (finalize batch): ${kd.curation.stored} stored, ${kd.curation.reinforced} reinforced, ${kd.curation.skipped} skipped, ${kd.curation.rejected} rejected, ${kd.curation.quarantined} quarantined.`,
			);
		}
		if (
			kd.admitted !== undefined ||
			kd.reinforcedRealtime !== undefined ||
			kd.rejectedCurator !== undefined
		) {
			lines.push(
				`  - Realtime admission: ${kd.admitted ?? 0} admitted, ${kd.reinforcedRealtime ?? 0} reinforced, ${kd.rejectedCurator ?? 0} curator-rejected (from durable markers).`,
			);
		}
		lines.push(
			`  - FR-015 dedup: ${kd.dedupDropped} retro lesson(s) deduped as already-known${kd.dedupAvailable ? '' : ' (dedup unavailable — knowledge read failed)'}.`,
		);
		lines.push('');
	}

	if (skillViolations.length > 0) {
		lines.push('SKILL COMPLIANCE SIGNALS:');
		for (const s of skillViolations) {
			lines.push(
				`  - ${s.skillPath}: ${s.violations} violation(s) across ${s.total} use(s) [${s.scope}${s.tailBounded ? ', tail-bounded' : ''}]`,
			);
		}
		lines.push('');
	}

	if (contradictionCandidates.length > 0) {
		lines.push('CONTRADICTION CANDIDATES (advisory):');
		for (const c of contradictionCandidates) {
			lines.push(
				`  - "${c.newLesson}" (id ${c.newEntryId}) ≈ "${c.conflictsWithLesson}" (id ${c.conflictsWithId}) [sim ${c.similarity}]`,
			);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Always-rendered signals block (issue #2077). Rendered UNCONDITIONALLY
 * by close.ts (not gated by the narrative-report `hasSignals` check) so
 * the "0 captured; N deduped" / NOOP line appears even in a clean
 * session. Surfaces all six signal classes: knowledge delta, skill
 * violations, contradiction candidates, negatives, drafted issues.
 */
export function buildSignalsBlock(data: SessionReflectionData): string {
	const lines: string[] = [];
	lines.push('## Session Signals');
	lines.push('');

	// Defensive defaults: tests and older callers may construct partial data.
	const skillViolations = data.skillViolations ?? [];
	const contradictionCandidates = data.contradictionCandidates ?? [];

	// Knowledge delta — always emit, even when zero (the "report negatives"
	// requirement; issue #2077 calls this "the single genuinely-absent
	// capability"). Mem0's NOOP-as-first-class-outcome.
	const kd = data.knowledgeDelta;
	if (kd) {
		lines.push('**Knowledge Delta**');
		lines.push(
			`- ${kd.sessionKnowledgeCreated} knowledge entries created this session.`,
		);
		if (kd.curation) {
			lines.push(
				`- Curation (finalize batch): ${kd.curation.stored} stored, ${kd.curation.reinforced} reinforced, ${kd.curation.skipped} skipped, ${kd.curation.rejected} rejected, ${kd.curation.quarantined} quarantined.`,
			);
		}
		if (
			kd.admitted !== undefined ||
			kd.reinforcedRealtime !== undefined ||
			kd.rejectedCurator !== undefined
		) {
			lines.push(
				`- Realtime admission: ${kd.admitted ?? 0} admitted, ${kd.reinforcedRealtime ?? 0} reinforced, ${kd.rejectedCurator ?? 0} curator-rejected (from durable markers).`,
			);
			lines.push(
				'- Realtime rejections (screened-out candidates) are not observable here — tracked in #1821.',
			);
		}
		if (!kd.dedupAvailable) {
			lines.push(
				'- FR-015 dedup unavailable (knowledge read failed); drop count not meaningful.',
			);
		} else if (kd.sessionKnowledgeCreated === 0 && kd.dedupDropped === 0) {
			lines.push('- 0 lessons captured; 0 deduped as already-known.');
		} else {
			lines.push(
				`- FR-015 dedup: ${kd.dedupDropped} retro lesson(s) deduped as already-known.`,
			);
		}
		lines.push('');
	}

	// Skill violations — scope-aware (issue #2077 critic item 8).
	if (skillViolations.length > 0) {
		const scopeLabel =
			skillViolations[0]?.scope === 'session'
				? 'this session'
				: 'recent, all sessions (no session id)';
		lines.push(`**Skill Compliance Signals** [${scopeLabel}]`);
		for (const s of skillViolations) {
			lines.push(
				`- ${s.skillPath}: ${s.violations} violation(s) across ${s.total} use(s)${s.tailBounded ? ' (tail-bounded)' : ''}`,
			);
		}
		lines.push('');
	}

	// Contradiction candidates — detect only, never auto-supersede.
	if (contradictionCandidates.length > 0) {
		lines.push(
			'**Contradiction Candidates** (advisory — review before acting)',
		);
		for (const c of contradictionCandidates) {
			lines.push(
				`- "${c.newLesson}" (id ${c.newEntryId}) ≈ "${c.conflictsWithLesson}" (id ${c.conflictsWithId}) [sim ${c.similarity}] → candidate supersede`,
			);
		}
		lines.push('');
	}

	// Issue candidates — deterministic, gated on minimal-reproduction evidence.
	const reproBacked: { title: string; evidence: string }[] = [];
	for (const gf of data.gateFailures.slice(0, 3)) {
		reproBacked.push({
			title: `Gate ${gf.gate} rejected on task ${gf.taskId} (${gf.count}x)`,
			evidence: `gate-fail evidence (verdict: fail/REJECT), ${gf.count} occurrence(s)`,
		});
	}
	for (const p of data.toolProblems.slice(0, 2)) {
		if (p.failureCount > 0) {
			reproBacked.push({
				title: `Tool ${p.tool} failing (${p.failureCount}/${p.totalCalls}, ${Math.round(p.failureRate * 100)}%)`,
				evidence: `tool failure rate ${Math.round(p.failureRate * 100)}% (${p.failureCount}/${p.totalCalls})`,
			});
		}
	}
	if (reproBacked.length > 0) {
		lines.push('**Issue Candidates** (repro evidence verified)');
		for (const r of reproBacked) {
			lines.push(`- ${r.title} — repro evidence: ${r.evidence}`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

/**
 * Assemble a numbered action menu from reflection proposals (issue #2077
 * Phase B). Advisory only — application happens in a later user turn via
 * the named existing tools. Under full-auto the "reply with numbers"
 * prompt is suppressed (reported-only) so the run is not blocked waiting
 * on human input. Returns '' when there are no proposals.
 */
export function buildActionMenu(
	proposals: ReflectionActionProposal[],
	fullAuto: boolean,
): string {
	if (proposals.length === 0) return '';
	const lines: string[] = [];
	// Under full-auto there is no human to reply, so do NOT emit the
	// "reply with numbers" prompt — report the proposals only, with a note
	// that application happens in a later turn (issue #2077 safety constraint).
	lines.push(
		fullAuto
			? '**Proposed actions** (reported-only — full-auto):'
			: '**Proposed actions** (reply with numbers, or "none"):',
	);
	proposals.forEach((p, i) => {
		lines.push(` [${i + 1}] ${p.label} → ${p.routing}`);
	});
	if (fullAuto) {
		lines.push('_Apply in a later turn via the listed tools._');
	}
	return lines.join('\n');
}

/**
 * Build action proposals from gathered signals (issue #2077 Phase B).
 * The `capture` kind is intentionally absent (issue #2077 critic item 7):
 * aggregate curation counts cannot derive per-lesson outcomes, and
 * re-proposing quarantined lessons would fail the actionability gate
 * identically when applied. A menu item guaranteed to be rejected is
 * worse than no menu item.
 */
export function buildActionProposals(
	data: SessionReflectionData,
): ReflectionActionProposal[] {
	// Defensive defaults: tests and older callers may construct partial data.
	const contradictionCandidates = data.contradictionCandidates ?? [];
	const skillViolations = data.skillViolations ?? [];
	const proposals: ReflectionActionProposal[] = [];
	for (const c of contradictionCandidates) {
		proposals.push({
			kind: 'supersede',
			label: `SUPERSEDE ${c.conflictsWithId} with newer entry (contradiction candidate, sim ${c.similarity})`,
			detail: `"${c.newLesson}" (id ${c.newEntryId}) appears to contradict "${c.conflictsWithLesson}" (id ${c.conflictsWithId}).`,
			routing: '/swarm curate',
		});
	}
	for (const gf of data.gateFailures.slice(0, 3)) {
		proposals.push({
			kind: 'file_issue',
			label: `FILE issue: "Gate ${gf.gate} rejected on task ${gf.taskId}" (repro verified)`,
			detail: `Gate ${gf.gate} rejected ${gf.count}x on task ${gf.taskId}. Repro evidence: gate-fail verdict.`,
			routing: 'gh issue create',
		});
	}
	for (const p of data.toolProblems.slice(0, 2)) {
		if (p.failureCount > 0) {
			proposals.push({
				kind: 'file_issue',
				label: `FILE issue: "Tool ${p.tool} failing ${Math.round(p.failureRate * 100)}%" (repro verified)`,
				detail: `Tool ${p.tool}: ${p.failureCount}/${p.totalCalls} failures (${Math.round(p.failureRate * 100)}%).`,
				routing: 'gh issue create',
			});
		}
	}
	for (const s of skillViolations) {
		proposals.push({
			kind: 'draft_skill',
			label: `DRAFT skill change: ${s.skillPath} (${s.violations} violations)`,
			detail: `Skill ${s.skillPath} had ${s.violations} violation(s) across ${s.total} use(s) this session.`,
			routing: 'skill_improve',
		});
	}
	return proposals;
}

const REFLECTION_SYSTEM_PROMPT = `You are the architect reviewing a completed swarm session. Your job is to analyze what happened and produce a concise, actionable report for the human operator.

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
If no skill changes are warranted, say so explicitly — capturing nothing is a valid outcome. Do not invent recommendations to fill the section.

## Process Improvements
What should the swarm do differently next time? Dispatch patterns, gate configurations, agent routing, phase structure — anything the architect should learn from this session.

Keep the report under 3000 characters. Be direct. No filler. Every sentence should be actionable or provide specific evidence. If the session was clean with no issues, say so in 2-3 sentences and skip the detailed sections.`;

function buildDeterministicReport(data: SessionReflectionData): string {
	const lines: string[] = [];
	lines.push('## Problems Encountered');
	lines.push('');

	// Issue #2271 bug 6: ledger rejections are failures the tool counters
	// structurally cannot see (denied calls never fire toolAfter), so both the
	// zero-failure claim and the clean-session claim must account for them.
	const ledgerEntries = Object.entries(data.ledgerRejections ?? {})
		.filter(([, count]) => count > 0)
		.sort((a, b) => b[1] - a[1]);
	const ledgerTotal = ledgerEntries.reduce((sum, [, count]) => sum + count, 0);
	const ledgerLines = (): void => {
		if (ledgerTotal === 0) return;
		lines.push(
			`${ledgerTotal} rejection/circuit-breaker event(s) in the session ledger (events.jsonl):`,
		);
		for (const [type, count] of ledgerEntries.slice(0, 8)) {
			lines.push(`- ${type}: ${count}`);
		}
	};

	if (data.totalToolFailures === 0 && data.gateFailures.length === 0) {
		if (ledgerTotal > 0) {
			ledgerLines();
		} else {
			lines.push('No tool failures or gate rejections recorded this session.');
		}
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
		// Ledger rejections augment the counted failures — they are a separate
		// failure class, not a subset of tool/evidence counts.
		if (ledgerTotal > 0) {
			lines.push('');
			ledgerLines();
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
	}

	lines.push('## Process Improvements');
	lines.push('');
	if (
		data.totalToolFailures === 0 &&
		data.gateFailures.length === 0 &&
		ledgerTotal === 0 &&
		data.lessonsFromRetros.length === 0
	) {
		lines.push('Session completed without notable issues.');
	} else {
		lines.push(
			'_Deterministic fallback: no LLM client available for deep analysis. Review the data above manually._',
		);
	}
	lines.push('');

	// Issue #2077: the signals block is NOT embedded here. It is returned
	// separately as `signalsReport` and rendered unconditionally by close.ts
	// (independent of the hasSignals gate), so embedding it inline in the
	// deterministic architectReport would duplicate it in the finalize output.
	return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

export interface SessionReflectionInput {
	directory: string;
	toolAggregates: Map<string, ToolAggregate>;
	agentSessions: Map<string, AgentSessionLike>;
	sessionId?: string;
	signal?: AbortSignal;
	delegate?: SkillImproverLLMDelegate;
	/** Issue #2077: knowledge-delta surface (close-time curation counts + dedup state). */
	knowledgeDelta?: KnowledgeDelta;
	/** Issue #2077: session start (ISO), used to scope session-created entries. */
	sessionStart?: string;
	/**
	 * Issue #2077: configured dedup threshold (upper bound of the contradiction
	 * band). Read from `config.dedup_threshold` so a user-tuned threshold (e.g.
	 * 0.8) does not cause advisory false negatives for pairs in [0.6, 0.8) that
	 * can coexist in the active store. Defaults to 0.6 (the schema default).
	 */
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
	// Issue #2271 bug 6: read the session ledger so denied (never-counted)
	// rejections surface in the report instead of a false "0 failures".
	const ledgerRejections = await _internals.gatherLedgerRejections(
		input.directory,
		input.sessionId,
	);

	// Issue #2077: advisory signal gatherers (read-only, fail-open, invoked
	// through the _internals seam so tests inject fakes without mock.module).
	const skillViolations = _internals.gatherSkillViolations(
		input.directory,
		input.sessionId,
	);
	const contradictionCandidates =
		await _internals.gatherContradictionCandidates(
			input.directory,
			input.sessionStart,
			input.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD,
		);
	const realtimeCounts = await _internals.gatherRealtimeAdmissionCounts(
		input.directory,
		input.sessionStart,
	);
	const knowledgeDelta: KnowledgeDelta | undefined = input.knowledgeDelta
		? {
				...input.knowledgeDelta,
				admitted: realtimeCounts?.admitted ?? input.knowledgeDelta.admitted,
				reinforcedRealtime:
					realtimeCounts?.reinforced ?? input.knowledgeDelta.reinforcedRealtime,
				rejectedCurator:
					realtimeCounts?.rejected ?? input.knowledgeDelta.rejectedCurator,
			}
		: undefined;

	const data: SessionReflectionData = {
		timestamp: new Date().toISOString(),
		totalToolCalls: totalCalls,
		totalToolFailures: totalFailures,
		toolProblems: problems,
		agentDispatches,
		gateFailures,
		lessonsFromRetros: lessons,
		errorTaxonomy: taxonomy,
		knowledgeDelta,
		skillViolations,
		contradictionCandidates,
		ledgerRejections,
	};

	// Issue #2077: the signals block + action proposals are computed ONCE and
	// returned on BOTH the llm and deterministic paths. close.ts renders
	// `signalsReport` unconditionally (not gated by the narrative-report
	// hasSignals check) so the "0 captured; N deduped" / NOOP line appears
	// even in a clean session.
	const signalsReport = buildSignalsBlock(data);
	const actionProposals = buildActionProposals(data);

	const delegate =
		input.delegate ??
		createSkillImproverLLMDelegate(input.directory, input.sessionId);

	if (delegate && !input.signal?.aborted) {
		try {
			const dataSummary = buildReflectionDataSummary(data);
			const report = await delegate(
				REFLECTION_SYSTEM_PROMPT,
				dataSummary,
				input.signal,
			);
			if (report && report.trim().length > 0) {
				return {
					data,
					architectReport: report.trim(),
					signalsReport,
					actionProposals,
					source: 'llm',
				};
			}
		} catch {
			// LLM failed — fall through to deterministic
		}
	}

	return {
		data,
		architectReport: buildDeterministicReport(data),
		signalsReport,
		actionProposals,
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

export const _internals = {
	gatherToolProblems,
	gatherAgentDispatches,
	gatherRetroLessonsAndTaxonomy,
	gatherGateFailures,
	gatherLedgerRejections,
	buildReflectionDataSummary,
	buildDeterministicReport,
	// Issue #2077 advisory gatherers + their read-only dependencies.
	// Tests reassign these (restored in afterEach) to inject fakes without
	// mock.module. The gatherers reference `_internals.*` at call time, so
	// reassignment here is observed by runSessionReflection.
	gatherSkillViolations,
	gatherContradictionCandidates,
	gatherRealtimeAdmissionCounts,
	buildSignalsBlock,
	buildActionMenu,
	buildActionProposals,
	readSkillUsageEntriesTail,
	readKnowledge,
	readRejectedLessons,
};
