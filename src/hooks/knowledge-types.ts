/** Type definitions for the opencode-swarm v6.17 two-tier knowledge system. */

export type KnowledgeCategory =
	| 'process'
	| 'architecture'
	| 'tooling'
	| 'security'
	| 'testing'
	| 'debugging'
	| 'performance'
	| 'integration'
	| 'todo'
	| 'other';

export interface PhaseConfirmationRecord {
	phase_number: number;
	confirmed_at: string; // ISO 8601
	project_name: string;
}

export interface ProjectConfirmationRecord {
	project_name: string;
	confirmed_at: string; // ISO 8601
	phase_number?: number;
}

export interface RetrievalOutcome {
	/** @deprecated v1 LEGACY field — frozen in v2.
	 *  v1 callers incremented this for every "shown" event (i.e. it conflated
	 *  shown with applied). v2 stops auto-incrementing it. Existing v1 entries
	 *  still load their historical value; the v1→v2 normalizer copies it into
	 *  `shown_count` so downstream consumers can keep working. New code MUST
	 *  read `applied_explicit_count` for explicit application or
	 *  `succeeded_after_shown_count` / `failed_after_shown_count` for outcome
	 *  attribution. */
	applied_count: number;
	/** @deprecated v1 LEGACY: succeeded_after_count was bumped after
	 *  applied_count. Frozen in v2; new equivalent is succeeded_after_shown_count. */
	succeeded_after_count: number;
	/** @deprecated v1 LEGACY: failed_after_count was bumped after
	 *  applied_count. Frozen in v2; new equivalent is failed_after_shown_count. */
	failed_after_count: number;
	last_applied_at?: string; // ISO 8601
	/** v2: number of times this entry was injected/shown to architect. */
	shown_count?: number;
	/** v2: explicit acknowledgment ("I see directive X") count. */
	acknowledged_count?: number;
	/** v2: explicit application count (KNOWLEDGE_APPLIED: id). */
	applied_explicit_count?: number;
	/** v2: explicit ignore count (KNOWLEDGE_IGNORED: id reason=...). */
	ignored_count?: number;
	/** v2: explicit/inferred violation count (KNOWLEDGE_VIOLATED: id reason=...). */
	violated_count?: number;
	/** v3: explicit contradiction count (entry contradicted by current evidence). */
	contradicted_count?: number;
	/** v2: phase-success count after a "shown" (replaces succeeded_after_count). */
	succeeded_after_shown_count?: number;
	/** v2: phase-failure count after a "shown" (replaces failed_after_count). */
	failed_after_shown_count?: number;
	/** v3: partial-success count after a "shown" (outcome: 'partial'). Event-only
	 *  field — never written to the entry, folded from the event log rollup. */
	partial_after_shown_count?: number;
	/** v3: recent violation timestamps (newest-first, capped) folded from the
	 *  event-derived rollup. Surfaced for the repeat-mistake escalator. */
	violation_timestamps?: string[];
}

/** v2: priority used by retrieval ranking and enforcement. */
export type DirectivePriority = 'low' | 'medium' | 'high' | 'critical';

/** One automatic escalation applied to a directive (Change 3). */
export interface DirectiveEscalationRecord {
	from: DirectivePriority;
	to: DirectivePriority;
	reason: 'repeat_violation' | string;
	at: string; // ISO 8601
}

/** v2: optional actionable-directive metadata attached to a knowledge entry. */
export interface ActionableDirectiveFields {
	/** Trigger phrases that surface this entry (e.g. "coder delegation modifying source"). */
	triggers?: string[];
	/** Required actions when the trigger matches. */
	required_actions?: string[];
	/** Forbidden actions when the trigger matches. */
	forbidden_actions?: string[];
	/** Agent role names this directive applies to. */
	applies_to_agents?: string[];
	/** Tool names this directive applies to. */
	applies_to_tools?: string[];
	/** Reviewer/test-engineer/runtime checks the directive expects. */
	verification_checks?: string[];
	/**
	 * A single machine-checkable verification predicate (Change 2). DSL:
	 *   grep:<regex>:<path-glob>      pass when ripgrep finds zero matches
	 *   tool:<argv>                   pass when the (allowlisted, shell-free) command exits 0
	 *   file_not_modified:<path>      pass when the path is unchanged in the working tree
	 *   file_modified:<path>          pass when the path is changed in the working tree
	 * Runs fail-closed (parse error → error) with a hard 15s timeout, no shell.
	 */
	verification_predicate?: string;
	/** Source pointers (file:line, plan section, etc.). Sanitized. */
	source_refs?: string[];
	/** UUIDs of source knowledge entries (for derived/clustered entries). */
	source_knowledge_ids?: string[];
	/** Slug of generated skill, if a SKILL.md was compiled from this entry. */
	generated_skill_slug?: string;
	/** Repo-local path to generated SKILL.md. */
	generated_skill_path?: string;
	/** Directive priority for ranking/enforcement. */
	directive_priority?: DirectivePriority;
	/**
	 * Enforcement posture (Change 3). `'enforce'` makes the directive block at the
	 * point of violation; `'warn'` only records. Auto-set to `'enforce'` by the
	 * repeat-mistake escalator.
	 */
	enforcement_mode?: 'warn' | 'enforce';
	/** Audit trail of automatic escalations applied to this directive (Change 3). */
	escalation_history?: DirectiveEscalationRecord[];
	/** ISO 8601 timestamp of last explicit application. */
	last_applied_at?: string;
	/** ISO 8601 timestamp of last explicit acknowledgment. */
	last_acknowledged_at?: string;
}

export interface KnowledgeEntryBase extends ActionableDirectiveFields {
	id: string; // UUID v4
	tier: 'swarm' | 'hive';
	lesson: string; // 15–280 chars
	category: KnowledgeCategory;
	tags: string[];
	scope: string; // 'global' or 'stack:<name>'
	confidence: number; // 0.0–1.0
	status:
		| 'candidate'
		| 'established'
		| 'promoted'
		| 'archived'
		| 'quarantined'
		/** Change 4: failed the actionability layer (no predicate or no scope tag).
		 *  Held out of the active store pending hardening by the skill-improver. */
		| 'quarantined_unactionable';
	confirmed_by: PhaseConfirmationRecord[] | ProjectConfirmationRecord[];
	retrieval_outcomes: RetrievalOutcome;
	schema_version: number; // current: 2 (v1 still readable; normalized on read)
	created_at: string; // ISO 8601
	updated_at: string; // ISO 8601
	hive_eligible?: boolean; // set true when ready for hive promotion
	auto_generated?: boolean; // true if created without human review
	phases_alive?: number; // monotonic phase counter, incremented at phase-wrap (excluding promoted & archived)
	max_phases?: number; // per-entry TTL in phases, falls back to KnowledgeConfig.default_max_phases
}

/** v2 schema marker. v1 entries are still parseable and normalized in-memory by knowledge-store.normalizeEntry. */
export const KNOWLEDGE_SCHEMA_VERSION = 2;

export interface SwarmKnowledgeEntry extends KnowledgeEntryBase {
	tier: 'swarm';
	confirmed_by: PhaseConfirmationRecord[];
	project_name: string;
}

export interface HiveKnowledgeEntry extends KnowledgeEntryBase {
	tier: 'hive';
	confirmed_by: ProjectConfirmationRecord[];
	source_project: string; // project where it originated
	/** Weighted encounter score for hive advancement. Starts at 1.0 for originating project. */
	encounter_score: number;
	/** @deprecated Legacy field for backward compatibility. Use encounter_score for weighting. */
	encounter_count?: number;
}

export interface RejectedLesson {
	id: string;
	lesson: string;
	rejection_reason: string;
	rejected_at: string; // ISO 8601
	rejection_layer: 1 | 2 | 3;
}

export interface KnowledgeConfig {
	/** Enable or disable the entire knowledge system. Default: true */
	enabled: boolean;
	/** Maximum entries to keep in swarm knowledge.jsonl. Default: 100 */
	swarm_max_entries: number;
	/** Maximum entries to keep in hive shared-learnings.jsonl. Default: 200 */
	hive_max_entries: number;
	/** Days before auto-promotion to hive tier. Default: 90 */
	auto_promote_days: number;
	/** Maximum knowledge entries to inject per architect message. Default: 5 */
	max_inject_count: number;
	/** Maximum knowledge directives injected into a delegated subagent's prompt. Default: 8 */
	delegate_max_inject_count?: number;
	/** Maximum total chars for the entire injection block. Default: 2000 */
	inject_char_budget?: number;
	/** Minimum headroom chars required before knowledge injection activates. Default: 300 */
	context_budget_threshold?: number;
	/** Maximum display chars per lesson at injection time. Default: 120 */
	max_lesson_display_chars?: number;
	/** Jaccard bigram similarity threshold for deduplication. Default: 0.6 */
	dedup_threshold: number;
	/** Scope filters to apply when reading knowledge. Default: ['global'] */
	scope_filter: string[];
	/** Enable hive (cross-project) tier reads and writes. Default: true */
	hive_enabled: boolean;
	/** Maximum rejected lesson fingerprints to retain. Default: 20 */
	rejected_max_entries: number;
	/** Enable validation gate before storing lessons. Default: true */
	validation_enabled: boolean;
	/** Confidence threshold for marking an entry evergreen. Default: 0.9 */
	evergreen_confidence: number;
	/** Utility score threshold for marking an entry evergreen. Default: 0.8 */
	evergreen_utility: number;
	/** Utility score at or below which an entry is considered low-utility. Default: 0.3 */
	low_utility_threshold: number;
	/** Minimum retrieval count before utility scoring begins. Default: 3 */
	min_retrievals_for_utility: number;
	/** JSONL schema version. Default: 1 */
	schema_version: number;
	/** Weighted scoring: multiplier for encounters from the source project. Default: 1.0 */
	same_project_weight: number;
	/** Weighted scoring: multiplier for encounters from other projects. Default: 0.5 */
	cross_project_weight: number;
	/** Weighted scoring: minimum encounter score floor. Default: 0.1 */
	min_encounter_score: number;
	/** Weighted scoring: initial score for newly promoted hive entries. Default: 1.0 */
	initial_encounter_score: number;
	/** Weighted scoring: score increment per encounter. Default: 0.1 */
	encounter_increment: number;
	/** Weighted scoring: maximum encounter score cap. Default: 10.0 */
	max_encounter_score: number;
	/** Default N-phase TTL for knowledge entries. Default: 10 */
	default_max_phases: number;
	/** N-phase TTL for 'todo' category entries. Default: 3 */
	todo_max_phases: number;
	/** Enable age-based sweep of knowledge entries. Default: true */
	sweep_enabled: boolean;
	/** Change 5: retrieval-upgrade tuning (MMR / cold-start / synonyms). */
	retrieval?: {
		mmr_lambda?: number;
		cold_start_bonus?: number;
		cold_start_max_age_phases?: number;
		synonym_min_cooccurrence?: number;
		synonym_map_max_pairs?: number;
	};
	/** Dedicated quota for LLM enrichment of plain-prose lessons into v3 directives. */
	enrichment: {
		max_calls_per_day: number;
		quota_window: 'utc' | 'local';
		batch_size?: number;
	};
}

export interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
	modelID?: string;
	providerID?: string;
	[key: string]: unknown;
}

export interface MessagePart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface MessageWithParts {
	info: MessageInfo;
	parts: MessagePart[];
}

// ============================================================================
// v2: Retrieval / decision-point context
// ============================================================================

export type RetrievalMode =
	| 'phase_start'
	| 'delegation'
	| 'tool_before'
	| 'phase_complete'
	| 'manual_recall'
	| 'curator';

/** Decision-point context passed to action-aware retrieval. */
export interface KnowledgeRetrievalContext {
	projectName?: string;
	currentPhase?: string;
	taskId?: string;
	taskTitle?: string;
	taskDescription?: string;
	lastUserMessage?: string;
	currentTool?: string;
	currentAction?: string;
	targetAgent?: string;
	filePaths?: string[];
	recentReviewerFailures?: string[];
	recentTestFailures?: string[];
	recentToolErrors?: string[];
	declaredScope?: string;
	techStack?: string[];
	planConstraints?: string[];
	mode?: RetrievalMode;
}

// ============================================================================
// v2: Knowledge-application audit record
// ============================================================================

export type KnowledgeApplicationResult =
	| 'shown'
	| 'acknowledged'
	| 'applied'
	| 'ignored'
	| 'violated';

/** One line of .swarm/knowledge-application.jsonl. */
export interface KnowledgeApplicationRecord {
	timestamp: string; // ISO 8601
	phase?: string;
	taskId?: string;
	action?: string;
	tool?: string;
	targetAgent?: string;
	knowledgeId: string;
	result: KnowledgeApplicationResult;
	reason?: string;
	generatedSkillPath?: string;
	sessionId?: string;
}
