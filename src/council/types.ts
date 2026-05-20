/**
 * Work Complete Council — data contracts.
 *
 * Flat, stable schema — no nested generics. Designed for reliable LLM output.
 * No business logic, no I/O. Only types, interfaces, and defaults.
 */

export type CouncilVerdict = 'APPROVE' | 'CONCERNS' | 'REJECT';

export type CouncilFindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export type CouncilFindingCategory =
	| 'logic'
	| 'edge_case'
	| 'error_handling'
	| 'spec_compliance'
	| 'security'
	| 'maintainability'
	| 'naming'
	| 'domain'
	| 'test_gap'
	| 'test_quality'
	| 'mutation_gap'
	| 'adversarial_gap'
	| 'slop_pattern'
	| 'hallucinated_api'
	| 'lazy_abstraction'
	| 'cargo_cult'
	| 'spec_drift'
	| 'other';

export type CouncilAgent =
	| 'critic'
	| 'reviewer'
	| 'sme'
	| 'test_engineer'
	| 'explorer';

export interface CouncilFinding {
	severity: CouncilFindingSeverity;
	category: CouncilFindingCategory;
	/** e.g. "src/tools/convene-council.ts:42" */
	location: string;
	/** Human-readable explanation */
	detail: string;
	/** Concrete quote or line reference */
	evidence: string;
}

export interface CouncilMemberVerdict {
	agent: CouncilAgent;
	verdict: CouncilVerdict;
	/** Confidence 0.0–1.0 */
	confidence: number;
	findings: CouncilFinding[];
	/** Criteria IDs from pre-declaration (e.g. ["C1","C3"]) */
	criteriaAssessed: string[];
	/** Criteria IDs that failed */
	criteriaUnmet: string[];
	durationMs: number;
}

export interface CouncilSynthesis {
	taskId: string;
	swarmId: string;
	/** ISO 8601 */
	timestamp: string;
	overallVerdict: CouncilVerdict;
	vetoedBy: CouncilAgent[] | null;
	memberVerdicts: CouncilMemberVerdict[];
	unresolvedConflicts: string[];
	/** Severity HIGH + MEDIUM from veto members */
	requiredFixes: CouncilFinding[];
	/** Severity LOW or from non-veto members */
	advisoryFindings: CouncilFinding[];
	/** Single markdown document sent to coder */
	unifiedFeedbackMd: string;
	/** 1-indexed */
	roundNumber: number;
	allCriteriaMet: boolean;
	/** Distinct council members that produced verdicts (deduplicated count). */
	quorumSize: number;
	/** true when called with an empty verdicts array — the APPROVE is vacuous */
	emptyVerdictsWarning?: boolean;
}

/**
 * Phase-level council synthesis result.
 * Distinct from CouncilSynthesis — scoped to a phase number
 * rather than a task ID, and targets .swarm/evidence/{phase}/phase-council.json
 * for evidence-file attestation.
 */
export interface PhaseCouncilSynthesis {
	phaseNumber: number;
	/** Always 'phase' — distinguishes from task-level council */
	scope: 'phase';
	/** ISO 8601 */
	timestamp: string;
	overallVerdict: CouncilVerdict;
	vetoedBy: CouncilAgent[] | null;
	memberVerdicts: CouncilMemberVerdict[];
	unresolvedConflicts: string[];
	/** Severity HIGH + MEDIUM from veto members */
	requiredFixes: CouncilFinding[];
	/** Severity LOW or from non-veto members */
	advisoryFindings: CouncilFinding[];
	/** Phase-level advisory notes for the architect */
	advisoryNotes: string[];
	/** Single markdown document for phase review */
	unifiedFeedbackMd: string;
	/** 1-indexed */
	roundNumber: number;
	allCriteriaMet: boolean;
	/** Distinct council members that produced verdicts */
	quorumSize: number;
	/** Path where evidence was written, e.g. .swarm/evidence/1/phase-council.json */
	evidencePath: string;
	/** Summary of the phase being reviewed */
	phaseSummary?: string;
}

/**
 * Project-level final council synthesis result.
 * Distinct from task-level and phase-level council results: this is the
 * final project close gate and writes to .swarm/evidence/final-council.json.
 */
export interface FinalCouncilSynthesis {
	/** Always 'project' - distinguishes final council from task/phase councils */
	scope: 'project';
	/** ISO 8601 */
	timestamp: string;
	overallVerdict: CouncilVerdict;
	vetoedBy: CouncilAgent[] | null;
	memberVerdicts: CouncilMemberVerdict[];
	unresolvedConflicts: string[];
	/** Severity HIGH + MEDIUM from veto members */
	requiredFixes: CouncilFinding[];
	/** Severity LOW or from non-veto members */
	advisoryFindings: CouncilFinding[];
	/** Project-level advisory notes for the architect */
	advisoryNotes: string[];
	/** Single markdown document for final project review */
	unifiedFeedbackMd: string;
	/** 1-indexed */
	roundNumber: number;
	allCriteriaMet: boolean;
	/** Distinct council members that produced verdicts */
	quorumSize: number;
	/** Path where evidence was written */
	evidencePath: '.swarm/evidence/final-council.json';
	/** Summary of the completed project being reviewed */
	projectSummary: string;
}

export interface CouncilCriteriaItem {
	id: string;
	description: string;
	mandatory: boolean;
}

export interface CouncilCriteria {
	taskId: string;
	criteria: CouncilCriteriaItem[];
	/** ISO 8601 */
	declaredAt: string;
}

/** Config shape — matched in schema.ts via CouncilConfigSchema. */
export interface CouncilConfig {
	enabled: boolean;
	/** Default 3 */
	maxRounds: number;
	/** Default 30_000 */
	parallelTimeoutMs: number;
	/** Default true — any REJECT blocks */
	vetoPriority: boolean;
	/** Default false — when true, submit_council_verdicts rejects unless all 5 member verdicts are provided */
	requireAllMembers: boolean;
	/** Default 3 — minimum distinct council members required for quorum. requireAllMembers: true overrides this to 5. */
	minimumMembers: number;
	/**
	 * Optional webhook URL or handler name for auto-escalation when maxRounds is
	 * reached without APPROVE. Reserved for forward compatibility — NOT yet
	 * implemented. Currently, maxRounds exhaustion surfaces a user-facing message
	 * via `buildUnifiedFeedbackMd` in council-service.ts (see the "Escalate to
	 * user" block), and the architect must relay it to the user. Future wiring
	 * options: critic_oversight agent, HTTP webhook, or configurable handler.
	 */
	escalateOnMaxRounds?: string;
	/** Default true — CONCERNS verdict at phase-level council does NOT block completion (advisory). Set false to make CONCERNS block like REJECT. */
	phaseConcernsAllowComplete: boolean;
}

export const COUNCIL_DEFAULTS: CouncilConfig = {
	// OFF by default — feature flag
	enabled: false,
	maxRounds: 3,
	parallelTimeoutMs: 30_000,
	vetoPriority: true,
	requireAllMembers: false,
	minimumMembers: 3,
	phaseConcernsAllowComplete: true,
};
