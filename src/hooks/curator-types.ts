/**
 * Curator types — phase context consolidation and drift detection.
 * No runtime logic. Types only.
 */

import type { KnowledgeCategory } from './knowledge-types.js';

/** Curator summary — anchored iterative format. Persisted to .swarm/curator-summary.json */
export interface CuratorSummary {
	schema_version: 1;
	session_id: string;
	last_updated: string; // ISO 8601
	last_phase_covered: number;
	/** Running digest rebuilt from the capped phase_digests projection */
	digest: string;
	/** Phase-level digests for lookup, capped to the most recent phases */
	phase_digests: PhaseDigestEntry[];
	/** Accumulated compliance observations */
	compliance_observations: ComplianceObservation[];
	/** Accumulated knowledge update recommendations from curator runs */
	knowledge_recommendations: KnowledgeRecommendation[];
}

export interface PhaseDigestEntry {
	phase: number;
	timestamp: string;
	summary: string;
	agents_used: string[];
	tasks_completed: number;
	tasks_total: number;
	key_decisions: string[];
	blockers_resolved: string[];
}

export interface ComplianceObservation {
	phase: number;
	timestamp: string;
	type:
		| 'missing_reviewer'
		| 'missing_retro'
		| 'missing_sme'
		| 'skipped_test'
		| 'workflow_deviation';
	description: string;
	severity: 'info' | 'warning';
}

export interface KnowledgeRecommendation {
	action: 'promote' | 'archive' | 'flag_contradiction' | 'rewrite';
	entry_id?: string;
	lesson: string;
	reason: string;
	category?: KnowledgeCategory;
	confidence?: number;
}

/** Drift report — produced by critic after curator phase run */
export interface DriftReport {
	schema_version: 1;
	phase: number;
	timestamp: string; // ISO 8601
	/** Overall alignment verdict */
	alignment: 'ALIGNED' | 'MINOR_DRIFT' | 'MAJOR_DRIFT' | 'OFF_SPEC';
	/** Severity score 0.0-1.0 (0 = perfectly aligned, 1 = completely off-spec) */
	drift_score: number;
	/** First deviation point if drift detected */
	first_deviation: {
		phase: number;
		task: string;
		description: string;
	} | null;
	/** Compounding effects across phases */
	compounding_effects: string[];
	/** Recommended course corrections */
	corrections: string[];
	/** Spec requirements checked */
	requirements_checked: number;
	/** Spec requirements satisfied */
	requirements_satisfied: number;
	/** Scope additions not in original plan */
	scope_additions: string[];
	/** Truncated summary for architect context injection */
	injection_summary: string;
}

/**
 * Design-doc drift report (issue #1080) — produced by the deterministic
 * design-doc drift check at phase wrap. Compares the generated design docs
 * (domain/technical-spec/behavior-spec/reference) against code/spec mtimes via
 * the traceability registry. Advisory only — never blocks phase completion.
 */
export interface DocDriftReport {
	schema_version: 1;
	phase: number;
	timestamp: string; // ISO 8601
	/** Output directory the docs were checked under (project-relative). */
	out_dir: string;
	/** Overall verdict for the phase. */
	verdict: 'DOC_FRESH' | 'DOC_STALE' | 'NO_DOCS';
	/** Sections whose owning doc is older than a mapped code anchor or the spec. */
	stale_sections: Array<{
		section_id: string;
		doc: string;
		reason: string;
	}>;
	/** Expected design docs that are missing from out_dir. */
	missing_docs: string[];
	/** Design docs that were found and checked. */
	checked_docs: string[];
}

export interface CuratorConfig {
	enabled: boolean;
	init_enabled: boolean;
	phase_enabled: boolean;
	postmortem_enabled?: boolean;
	max_summary_tokens: number;
	min_knowledge_confidence: number;
	compliance_report: boolean;
	suppress_warnings: boolean;
	drift_inject_max_chars: number;
	llm_timeout_ms?: number;
	skill_generation_enabled?: boolean;
	skill_generation_mode?: 'draft' | 'active';
	min_skill_confidence?: number;
	min_skill_confirmations?: number;
}

export interface CuratorInitResult {
	briefing: string;
	contradictions: string[];
	knowledge_entries_reviewed: number;
	prior_phases_covered: number;
}

export interface CuratorPhaseResult {
	phase: number;
	digest: PhaseDigestEntry;
	compliance: ComplianceObservation[];
	knowledge_recommendations: KnowledgeRecommendation[];
	summary_updated: boolean;
	/** True when this phase was already digested in a prior call. */
	already_digested?: boolean;
	/** v2: per-knowledge-entry application audit (applied/ignored/violated/n/a). */
	knowledge_application_findings?: KnowledgeApplicationFinding[];
	/** v2: candidate clusters the curator suggests compiling into SKILL.md. */
	skill_candidates?: SkillCandidate[];
}

/** v2: machine-typed audit produced by the curator after each phase. */
export interface KnowledgeApplicationFinding {
	knowledge_id: string;
	expected_behavior: string;
	observed_behavior: string;
	verdict: 'applied' | 'ignored' | 'violated' | 'not_applicable';
	evidence_refs: string[];
}

/** v2: skill cluster proposal emitted by the curator. */
export interface SkillCandidate {
	slug: string;
	title: string;
	source_knowledge_ids: string[];
	trigger: string;
	required_procedure: string[];
	forbidden_shortcuts: string[];
	target_agents: string[];
	reviewer_checks: string[];
	confidence: number;
	reason: string;
}

export interface CriticDriftResult {
	phase: number;
	report: DriftReport;
	report_path: string; // .swarm/drift-report-phase-N.json
	injection_text: string; // truncated summary for architect context
}
