/**
 * Work Complete Council — data contracts.
 *
 * Flat, stable schema — no nested generics. Designed for reliable LLM output.
 * No business logic, no I/O. Only types, interfaces, and defaults.
 */

export type CouncilVerdict = 'APPROVE' | 'CONCERNS' | 'REJECT';

export type CouncilFindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

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

/**
 * The canonical five-member council role set (issue #2102 contract H).
 * Writers, gates, and quorum checks must import this constant instead of
 * re-declaring the list, so the role policy can never drift between the
 * write path and the gate path.
 */
export const COUNCIL_MEMBER_ROLES: readonly CouncilAgent[] = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
];

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
	/**
	 * Optional session id of the dispatched agent that produced this verdict.
	 * When supplied, the memory reward pathway rewards this member's own
	 * recall bundle in addition to the submitting session's, so sub-agent
	 * recalls are not silently skipped. Unvalidated caller input — the
	 * reward pathway must confirm this resolves to a real tracked session
	 * before trusting it.
	 */
	sessionId?: string;
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
	/** Count of HIGH/CRITICAL findings from CONCERNS members promoted to requiredFixes */
	blockingConcernsCount: number;
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
	/** Count of HIGH/CRITICAL findings from CONCERNS members promoted to requiredFixes */
	blockingConcernsCount: number;
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
	/** Count of HIGH/CRITICAL findings from CONCERNS members promoted to requiredFixes */
	blockingConcernsCount: number;
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

/** Normalized final-council completion policy (issue #2102 contract C). */
export interface FinalCompletionPolicyConfig {
	/** 'all_required' (default, strict legacy) or explicit 'quorum' weakening. */
	mode: 'all_required' | 'quorum';
	/** Required when mode is 'quorum'; bounded 3..5 distinct canonical members. */
	minimumMembers?: number;
}

/** Config shape — matched in schema.ts via CouncilConfigSchema. */
export interface CouncilConfig {
	enabled: boolean;
	/** Default 3 */
	maxRounds: number;
	/**
	 * @deprecated Inert — declared for parse compatibility only. No runtime
	 * consumer exists: council tools consume already-returned verdict
	 * submissions and there is no member-dispatch cancellation seam. Config
	 * doctor warns when this is explicitly set; the field will be removed in
	 * a future release. Dispatch timeouts are governed by the agent host.
	 */
	parallelTimeoutMs: number;
	/** Default true — any REJECT blocks */
	vetoPriority: boolean;
	/** Default false — when true, submit_council_verdicts rejects unless all 5 member verdicts are provided */
	requireAllMembers: boolean;
	/** Default 3 — minimum distinct council members required for quorum. requireAllMembers: true overrides this to 5. */
	minimumMembers: number;
	/**
	 * Optional webhook URL or handler name declared for escalation when
	 * maxRounds is reached without APPROVE. REMAINS INERT: no handler,
	 * webhook, or outbound execution exists or is invoked. Config doctor
	 * visibly warns when it is explicitly set (issue #1650), and max-rounds
	 * exhaustion emits a durable structured event plus a user escalation
	 * message. Wiring real escalation requires a separate security review.
	 */
	escalateOnMaxRounds?: string;
	/** Default true — CONCERNS verdict with only MEDIUM/LOW findings does NOT block completion (advisory). Set false to make all CONCERNS block like REJECT. Note: HIGH/CRITICAL findings from CONCERNS members are always promoted to requiredFixes and block at the tool level regardless of this setting. */
	phaseConcernsAllowComplete: boolean;
	/**
	 * Final-council completion policy. Missing/default `all_required`
	 * preserves the exact legacy requirement (all five canonical roles,
	 * five distinct members, zero absentees). `quorum` is an explicit,
	 * bounded weakening: it requires `minimumMembers` between 3 and 5, and
	 * only distinct members of the canonical five-role set count. The
	 * normalized policy is part of the council policy digest, so any change
	 * invalidates previously accepted final-council evidence.
	 */
	finalCompletionPolicy: FinalCompletionPolicyConfig;
	/**
	 * Default 24 — maximum age (hours) of phase-council, architecture-
	 * supervisor, and final-council evidence. Bounded 1..720. Part of the
	 * council policy digest, so changing it invalidates prior evidence.
	 */
	freshnessMaxAgeHours: number;
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
	finalCompletionPolicy: { mode: 'all_required' },
	freshnessMaxAgeHours: 24,
};
