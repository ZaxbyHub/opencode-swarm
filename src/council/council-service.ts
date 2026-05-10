/**
 * Work Complete Council — pure synthesis service.
 *
 * Given the verdicts of council members (critic, reviewer, sme, test_engineer),
 * compute the overall verdict, classify findings, detect conflicts, and build a
 * single unified feedback document for the coder.
 *
 * No I/O — fully unit-testable with mock inputs. All file reads/writes happen in
 * sibling modules (criteria-store, council-evidence-writer).
 */

import type {
	CouncilAgent,
	CouncilConfig,
	CouncilCriteria,
	CouncilFinding,
	CouncilMemberVerdict,
	CouncilSynthesis,
	CouncilVerdict,
	PhaseCouncilSynthesis,
} from './types';
import { COUNCIL_DEFAULTS } from './types';

export function synthesizeCouncilVerdicts(
	taskId: string,
	swarmId: string,
	verdicts: CouncilMemberVerdict[],
	criteria: CouncilCriteria | null,
	roundNumber: number,
	config: Partial<CouncilConfig> = {},
): CouncilSynthesis {
	const cfg: CouncilConfig = { ...COUNCIL_DEFAULTS, ...config };
	const timestamp = new Date().toISOString();

	// Distinct member count — the canonical quorum size for this synthesis.
	// Computed here (rather than passed in) so the field is always self-consistent
	// with `memberVerdicts`, even for direct test callers that bypass the tool.
	const quorumSize = new Set(verdicts.map((v) => v.agent)).size;

	// ── Veto detection ────────────────────────────────────────────────────
	const rejectingMembers: CouncilAgent[] = verdicts
		.filter((v) => v.verdict === 'REJECT')
		.map((v) => v.agent);

	let overallVerdict: CouncilVerdict;
	if (cfg.vetoPriority && rejectingMembers.length > 0) {
		overallVerdict = 'REJECT';
	} else if (
		verdicts.some((v) => v.verdict === 'CONCERNS') ||
		(!cfg.vetoPriority && rejectingMembers.length > 0)
	) {
		// Without veto, a REJECT still warrants at least CONCERNS — never swallowed silently.
		overallVerdict = 'CONCERNS';
	} else {
		overallVerdict = 'APPROVE';
	}

	// ── Conflict detection ────────────────────────────────────────────────
	const unresolvedConflicts = detectConflicts(verdicts);

	// ── Finding classification ────────────────────────────────────────────
	const rejectingSet = new Set<CouncilAgent>(rejectingMembers);
	const vetoFindings = verdicts
		.filter((v) => rejectingSet.has(v.agent))
		.flatMap((v) => v.findings);

	const requiredFixes = vetoFindings.filter(
		(f) => f.severity === 'HIGH' || f.severity === 'MEDIUM',
	);

	const advisoryFindings: CouncilFinding[] = [
		...vetoFindings.filter((f) => f.severity === 'LOW'),
		...verdicts
			.filter((v) => !rejectingSet.has(v.agent))
			.flatMap((v) => v.findings),
	];

	// ── Criteria assessment ───────────────────────────────────────────────
	// A mandatory criterion counts as "met" only when it was actually assessed
	// by at least one member AND no member reported it unmet. An unassessed
	// mandatory criterion is treated as not met — otherwise a council that
	// simply forgot to evaluate the criterion would silently auto-approve.
	const allAssessedIds = new Set(verdicts.flatMap((v) => v.criteriaAssessed));
	const allUnmetIds = new Set(verdicts.flatMap((v) => v.criteriaUnmet));
	const mandatoryIds = new Set(
		(criteria?.criteria ?? []).filter((c) => c.mandatory).map((c) => c.id),
	);
	const allCriteriaMet = [...mandatoryIds].every(
		(id) => allAssessedIds.has(id) && !allUnmetIds.has(id),
	);

	// ── Unified feedback markdown ─────────────────────────────────────────
	const unifiedFeedbackMd = buildUnifiedFeedback(
		taskId,
		overallVerdict,
		rejectingMembers,
		requiredFixes,
		advisoryFindings,
		unresolvedConflicts,
		roundNumber,
		cfg.maxRounds,
	);

	return {
		taskId,
		swarmId,
		timestamp,
		overallVerdict,
		vetoedBy: rejectingMembers.length > 0 ? rejectingMembers : null,
		memberVerdicts: verdicts,
		unresolvedConflicts,
		requiredFixes,
		advisoryFindings,
		unifiedFeedbackMd,
		roundNumber,
		allCriteriaMet,
		quorumSize,
		...(verdicts.length === 0 && { emptyVerdictsWarning: true }),
	};
}

// ── Conflict detection ────────────────────────────────────────────────────────
// A conflict exists when two members make findings at the same location with
// directly contradictory directives (one says "add X", another says "remove X").
function detectConflicts(verdicts: CouncilMemberVerdict[]): string[] {
	const conflicts: string[] = [];
	const locationMap = new Map<
		string,
		Array<{ agent: string; detail: string }>
	>();

	for (const verdict of verdicts) {
		for (const finding of verdict.findings) {
			const key = finding.location.toLowerCase();
			// Skip empty locations — cannot meaningfully detect conflicts there.
			if (!key) continue;
			const entries = locationMap.get(key);
			if (entries) {
				entries.push({ agent: verdict.agent, detail: finding.detail });
			} else {
				locationMap.set(key, [
					{ agent: verdict.agent, detail: finding.detail },
				]);
			}
		}
	}

	for (const [location, entries] of locationMap) {
		if (entries.length < 2) continue;
		const addDirectives = entries.filter((e) =>
			/\badd\b|\binclude\b|\binsert\b/i.test(e.detail),
		);
		const removeDirectives = entries.filter((e) =>
			/\bremove\b|\bdelete\b|\beliminate\b/i.test(e.detail),
		);
		if (addDirectives.length > 0 && removeDirectives.length > 0) {
			conflicts.push(
				`Conflict at ${location}: ${addDirectives
					.map((e) => `${e.agent} says "${e.detail}"`)
					.join(', ')} vs ${removeDirectives
					.map((e) => `${e.agent} says "${e.detail}"`)
					.join(', ')}`,
			);
		}
	}

	return conflicts;
}

// ── Unified feedback builder ──────────────────────────────────────────────────
function buildUnifiedFeedback(
	taskId: string,
	verdict: CouncilVerdict,
	vetoedBy: CouncilAgent[],
	requiredFixes: CouncilFinding[],
	advisoryFindings: CouncilFinding[],
	conflicts: string[],
	roundNumber: number,
	maxRounds: number,
): string {
	const lines: string[] = [
		`## Work Complete Council — Round ${roundNumber}/${maxRounds}`,
		`**Task:** ${taskId}  **Overall verdict:** ${verdict}`,
		'',
	];

	if (vetoedBy.length > 0) {
		lines.push(`> ⛔ **BLOCKED** by: ${vetoedBy.join(', ')}`);
		lines.push('');
	}

	if (requiredFixes.length > 0) {
		lines.push('### Required Fixes (must resolve before re-submission)');
		for (const f of requiredFixes) {
			lines.push(
				`- **[${f.severity}]** \`${f.location}\` — ${f.detail}`,
				`  _Evidence:_ ${f.evidence}`,
			);
		}
		lines.push('');
	}

	if (conflicts.length > 0) {
		lines.push('### Conflicts to Resolve');
		lines.push(
			'_The following reviewers gave contradictory instructions. Architect must resolve before sending to coder._',
		);
		for (const c of conflicts) {
			lines.push(`- ${c}`);
		}
		lines.push('');
	}

	if (advisoryFindings.length > 0) {
		lines.push('### Advisory Findings (non-blocking)');
		for (const f of advisoryFindings) {
			lines.push(`- **[${f.severity}]** \`${f.location}\` — ${f.detail}`);
		}
		lines.push('');
	}

	if (verdict === 'APPROVE') {
		lines.push(
			'> ✅ **All council members approved.** Work may advance to `complete`.',
		);
	} else if (roundNumber >= maxRounds) {
		lines.push(
			`> ⚠️ **Max rounds (${maxRounds}) reached.** Escalate to user — do not auto-advance.`,
		);
	}

	return lines.join('\n');
}

/**
 * Synthesize phase-level council verdicts into a PhaseCouncilSynthesis.
 * Reuses the same veto detection, conflict detection, and finding
 * classification logic as per-task council, but scoped to a phase number.
 *
 * Pure computation — no I/O. File writes are the caller's responsibility
 * (see writePhaseCouncilEvidence in submit-phase-council-verdicts.ts).
 */
export function synthesizePhaseCouncilAdvisory(
	phaseNumber: number,
	phaseSummary: string,
	verdicts: CouncilMemberVerdict[],
	roundNumber: number,
	config: Partial<CouncilConfig> = {},
	_workingDir?: string,
): PhaseCouncilSynthesis {
	const cfg: CouncilConfig = { ...COUNCIL_DEFAULTS, ...config };
	const timestamp = new Date().toISOString();
	const scope = 'phase' as const;

	// ── Quorum ─────────────────────────────────────────────────────────
	const quorumSize = new Set(verdicts.map((v) => v.agent)).size;

	// ── Veto detection ──────────────────────────────────────────────────
	const rejectingMembers: CouncilAgent[] = verdicts
		.filter((v) => v.verdict === 'REJECT')
		.map((v) => v.agent);

	let overallVerdict: CouncilVerdict;
	if (cfg.vetoPriority && rejectingMembers.length > 0) {
		overallVerdict = 'REJECT';
	} else if (
		verdicts.some((v) => v.verdict === 'CONCERNS') ||
		(!cfg.vetoPriority && rejectingMembers.length > 0)
	) {
		overallVerdict = 'CONCERNS';
	} else {
		overallVerdict = 'APPROVE';
	}

	// ── Conflict detection ──────────────────────────────────────────────
	const unresolvedConflicts = detectConflicts(verdicts);

	// ── Finding classification ──────────────────────────────────────────
	const rejectingSet = new Set<CouncilAgent>(rejectingMembers);
	const vetoFindings = verdicts
		.filter((v) => rejectingSet.has(v.agent))
		.flatMap((v) => v.findings);
	const requiredFixes = vetoFindings.filter(
		(f) => f.severity === 'HIGH' || f.severity === 'MEDIUM',
	);
	const advisoryFindings: CouncilFinding[] = [
		...vetoFindings.filter((f) => f.severity === 'LOW'),
		...verdicts
			.filter((v) => !rejectingSet.has(v.agent))
			.flatMap((v) => v.findings),
	];

	// ── Advisory notes ──────────────────────────────────────────────────
	const advisoryNotes: string[] = [];
	if (advisoryFindings.length > 0) {
		advisoryNotes.push(
			`Phase ${phaseNumber} council found ${advisoryFindings.length} advisory finding(s). Review before proceeding to next phase.`,
		);
	}
	if (verdicts.length < 3) {
		advisoryNotes.push(
			`Phase council quorum is ${verdicts.length} members — consider convening additional members for broader review coverage.`,
		);
	}

	// ── Criteria assessment ─────────────────────────────────────────────
	// Phase-level council has no pre-declared criteria, so if any member
	// reports unmet criteria, treat it as criteria not fully met.
	const allUnmetIds = new Set(verdicts.flatMap((v) => v.criteriaUnmet));
	const allCriteriaMet = allUnmetIds.size === 0 && verdicts.length > 0;

	// ── Unified feedback ────────────────────────────────────────────────
	const unifiedFeedbackMd = buildPhaseCouncilFeedback(
		phaseNumber,
		phaseSummary,
		overallVerdict,
		rejectingMembers,
		requiredFixes,
		advisoryFindings,
		unresolvedConflicts,
		roundNumber,
		cfg.maxRounds,
	);

	// ── Evidence path ───────────────────────────────────────────────────
	const evidencePath = `.swarm/evidence/${phaseNumber}/phase-council.json`;

	return {
		phaseNumber,
		scope,
		timestamp,
		overallVerdict,
		vetoedBy: rejectingMembers.length > 0 ? rejectingMembers : null,
		memberVerdicts: verdicts,
		unresolvedConflicts,
		requiredFixes,
		advisoryFindings,
		advisoryNotes,
		unifiedFeedbackMd,
		roundNumber,
		allCriteriaMet,
		quorumSize,
		evidencePath,
		phaseSummary,
	};
}

/**
 * Build unified feedback markdown for phase-level council review.
 */
function buildPhaseCouncilFeedback(
	phaseNumber: number,
	phaseSummary: string,
	verdict: CouncilVerdict,
	vetoedBy: CouncilAgent[],
	requiredFixes: CouncilFinding[],
	advisoryFindings: CouncilFinding[],
	conflicts: string[],
	roundNumber: number,
	maxRounds: number,
): string {
	const lines: string[] = [
		`## Phase Council Review — Round ${roundNumber}/${maxRounds}`,
		`**Phase:** ${phaseNumber}  **Overall verdict:** ${verdict}`,
		'',
	];

	if (phaseSummary) {
		lines.push(`**Phase Summary:** ${phaseSummary}`);
		lines.push('');
	}

	if (vetoedBy.length > 0) {
		lines.push(`> ⛔ **BLOCKED** by: ${vetoedBy.join(', ')}`);
		lines.push('');
	}

	if (requiredFixes.length > 0) {
		lines.push('### Required Fixes (must resolve before re-submission)');
		for (const f of requiredFixes) {
			lines.push(
				`- **[${f.severity}]** \`${f.location}\` — ${f.detail}`,
				`  _Evidence:_ ${f.evidence}`,
			);
		}
		lines.push('');
	}

	if (conflicts.length > 0) {
		lines.push('### Conflicts to Resolve');
		lines.push(
			'_The following reviewers gave contradictory instructions. Architect must resolve before sending to coder._',
		);
		for (const c of conflicts) {
			lines.push(`- ${c}`);
		}
		lines.push('');
	}

	if (advisoryFindings.length > 0) {
		lines.push('### Advisory Findings (non-blocking)');
		for (const f of advisoryFindings) {
			lines.push(`- **[${f.severity}]** \`${f.location}\` — ${f.detail}`);
		}
		lines.push('');
	}

	if (verdict === 'APPROVE') {
		lines.push(
			'> ✅ **Phase council approved.** Phase may proceed to completion.',
		);
	} else if (roundNumber >= maxRounds) {
		lines.push(
			`> ⚠️ **Max rounds (${maxRounds}) reached.** Escalate to user — do not auto-advance.`,
		);
	}

	return lines.join('\n');
}
