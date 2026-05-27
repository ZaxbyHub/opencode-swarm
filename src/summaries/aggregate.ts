/**
 * Phase-level aggregation of per-agent work summaries (issue #893, Chunk B).
 *
 * Deterministic, cheap rollup that runs in the non-blocking phase-monitor hook: it reads
 * the agent summaries for a completed phase, unions their decisions/risks/violations, and
 * surfaces cross-agent contradictions (a constraint one agent observed but another
 * violated). The result is written as a raw sidecar that the architecture-supervisor
 * critic reviews in Chunk C. No LLM call here — keeps the hook fast and side-effect-light.
 */

import {
	type AgentWorkSummary,
	MAX_PHASE_SUMMARY_WORDS,
	type PhaseArchitectureSummary,
	SUMMARY_SCHEMA_VERSION,
	truncateWords,
} from './schema';
import { listAgentSummaries, writePhaseArchitectureSummary } from './store';

function dedupe(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).filter((v) => v.trim().length > 0);
}

/**
 * Detect cross-agent contradictions: a constraint string that one agent reports as
 * observed while another reports it as violated. Returns human-readable conflict lines.
 */
function detectConflicts(summaries: AgentWorkSummary[]): string[] {
	const observedBy = new Map<string, Set<string>>();
	const violatedBy = new Map<string, Set<string>>();

	for (const s of summaries) {
		for (const c of s.constraints_observed) {
			if (!observedBy.has(c)) observedBy.set(c, new Set());
			observedBy.get(c)?.add(s.agent);
		}
		for (const c of s.constraints_violated) {
			if (!violatedBy.has(c)) violatedBy.set(c, new Set());
			violatedBy.get(c)?.add(s.agent);
		}
	}

	const conflicts: string[] = [];
	for (const [constraint, violators] of violatedBy) {
		const observers = observedBy.get(constraint);
		if (observers && observers.size > 0) {
			const obs = Array.from(observers).sort().join(', ');
			const vio = Array.from(violators).sort().join(', ');
			conflicts.push(
				`Constraint "${constraint}" observed by [${obs}] but violated by [${vio}]`,
			);
		}
	}
	return conflicts.sort();
}

export interface AggregatePhaseOptions {
	/** Override the timestamp source (tests). */
	now?: () => string;
	/** Word cap for the rollup summary text. */
	maxPhaseSummaryWords?: number;
}

/**
 * Aggregate all agent summaries for `phase` into a PhaseArchitectureSummary and persist
 * it as a sidecar. Returns the summary, or null when there are no agent summaries for the
 * phase (nothing to roll up — the sidecar is not written in that case).
 */
export async function aggregatePhaseSummary(
	directory: string,
	phase: number,
	options: AggregatePhaseOptions = {},
): Promise<PhaseArchitectureSummary | null> {
	const summaries = await listAgentSummaries(directory, { phase });
	if (summaries.length === 0) return null;

	const agentsSeen = dedupe(summaries.map((s) => s.agent)).sort();
	const tasksSeen = dedupe(
		summaries.map((s) => s.task_id).filter((t): t is string => Boolean(t)),
	).sort();
	const keyDecisions = dedupe(summaries.flatMap((s) => s.key_decisions));
	const unresolvedRisks = dedupe(summaries.flatMap((s) => s.risks));
	const constraintViolations = dedupe(
		summaries.flatMap((s) => s.constraints_violated),
	);
	const evidenceRefs = dedupe(summaries.flatMap((s) => s.evidence_refs));
	const conflicts = detectConflicts(summaries);

	const headline = `Phase ${phase}: ${summaries.length} agent summary(ies) across ${tasksSeen.length} task(s); ${constraintViolations.length} constraint violation(s), ${conflicts.length} cross-agent conflict(s).`;
	const cap = options.maxPhaseSummaryWords ?? MAX_PHASE_SUMMARY_WORDS;
	const summaryText = truncateWords(headline, cap).text;

	const phaseSummary: PhaseArchitectureSummary = {
		schema_version: SUMMARY_SCHEMA_VERSION,
		phase,
		summary: summaryText,
		agents_seen: agentsSeen,
		tasks_seen: tasksSeen,
		key_decisions: keyDecisions,
		conflicts,
		unresolved_risks: unresolvedRisks,
		constraint_violations: constraintViolations,
		evidence_refs: evidenceRefs,
		created_at: options.now?.() ?? new Date().toISOString(),
	};

	writePhaseArchitectureSummary(directory, phaseSummary);
	return phaseSummary;
}
