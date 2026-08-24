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
	/**
	 * Canonical cohort id (issue #1847) — the identity used for cross-project
	 * distinctness, from `resolveCohortId` (#1846). Sibling worktrees and remote
	 * aliases of one repository share one `cohort_id`, so they count as a single
	 * project. Absent on legacy records written before #1847; such records are
	 * counted by `project_name` as a degraded fallback and are NEVER synthetically
	 * credited with a cohort id.
	 */
	cohort_id?: string;
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
	/** G10 (issue #1717): slug of a draft proposal compiled from this entry. */
	draft_generated_skill_slug?: string;
	/** G10 (issue #1717): repo-local path to the draft proposal. */
	draft_generated_skill_path?: string;
	/** G12 (issue #1717): retired skill slugs previously generated from this entry. */
	retired_skill_history?: string[];
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

/**
 * Canonical cohort-scoped producer provenance (issue #1848 §1).
 *
 * Every mutable knowledge entry carries enough immutable provenance for a
 * cohort-safe ownership decision: who produced it, in which cohort, from which
 * worktree/session, and tied to which creation transaction. Absent/null on
 * legacy entries written before #1848 — such entries are treated as
 * unknown-owner and protected from destructive curation by default (the
 * curation-policy layer converts destructive intent into a non-destructive
 * proposal rather than guessing an owner from the current worktree).
 *
 * `worktree_id` is the primary ownership key: a worktree may directly mutate an
 * entry only when it is the proven producer (or cohort quorum / operator
 * override applies). It is stored at write time from `resolveWorktreeId`
 * (src/knowledge/worktree-identity.ts) — a per-worktree stable id, NOT
 * link-resolved, so two sibling worktrees of the same cohort have distinct
 * ownership keys.
 */
export interface ProducerProvenance {
	/** Canonical cohort id (from `resolveCohortId`, #1846). Scopes quorum + audit. */
	cohort_id: string;
	/** Stable per-worktree id (owner key). NOT link-resolved — per-worktree. */
	worktree_id: string;
	/** Producing session id, when known (audit). */
	session_id?: string;
	/** Producing agent/role, when known (audit). */
	role?: string;
	/** Creation transaction/event id, when known (audit lineage). */
	creation_event_id?: string;
}

/**
 * The evidence scope a curation decision was based on (issue #1848 §2).
 *
 * Absence of LOCAL session events is NOT negative evidence — a worktree that
 * never saw an application event for an entry cannot conclude the entry was
 * never applied (a sibling producer may have applied it). Evidence queries must
 * be scoped intentionally:
 *   - `local-session`: only this worktree's session events (owner-local decisions)
 *   - `producer`:       the producing worktree's own validated evidence
 *   - `cohort-wide`:    the full cohort event log (shared/quorum decisions)
 */
export type CurationEvidenceScope =
	| 'local-session'
	| 'producer'
	| 'cohort-wide';

/**
 * Every destructive lifecycle action the curation-policy layer authorizes
 * (issue #1848 §2). All of these share one policy so archive/purge/remove/
 * quarantine/retraction/merge/retire cannot diverge in ownership semantics.
 */
export type CurationAction =
	| 'archive'
	| 'purge'
	| 'remove'
	| 'quarantine'
	| 'retract'
	| 'rewrite'
	| 'merge'
	| 'retire'
	| 'demote'
	| 'restore'
	| 'unarchive'
	| 'escalate';

/**
 * A non-destructive proposal recorded when a destructive curation action is
 * unauthorized (issue #1848 §2). Other cohort members may later confirm it.
 * Destructive intent is preserved WITHOUT mutating the shared record.
 */
export interface CurationProposal {
	entryId: string;
	action: CurationAction;
	reason?: string;
	evidenceScope: CurationEvidenceScope;
	proposedAt: string; // ISO 8601
	status: 'pending';
}

/**
 * Immutable before/after history for a destructive rewrite or merge (issue
 * #1848 §3). Ensures the only copy of prior lesson text is never overwritten,
 * and supports deterministic reconstruction or rollback. Appended to the
 * cohort-scoped `knowledge-rewrites.jsonl` audit log.
 */
export interface RewriteHistoryRecord {
	entry_id: string;
	before_lesson: string;
	after_lesson: string;
	before_revision: number;
	after_revision: number;
	/** 'auto' | producing worktree_id | 'manual-override'. */
	actor: string;
	reason?: string;
	/** Event/trace ids that justified the change. */
	evidence_refs?: string[];
	timestamp: string; // ISO 8601
	action: 'rewrite' | 'merge';
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
	schema_version: number; // current: 3 (v1/v2 still readable; normalized on read)
	created_at: string; // ISO 8601
	updated_at: string; // ISO 8601
	hive_eligible?: boolean; // set true when ready for hive promotion
	auto_generated?: boolean; // true if created without human review
	phases_alive?: number; // monotonic phase counter, incremented at phase-wrap (excluding promoted & archived)
	max_phases?: number; // per-entry TTL in phases, falls back to KnowledgeConfig.default_max_phases
	/** G2 (#1715): set when the confidence-floor action fired (demote).
	 * Suppresses `statusBoost` in retrieval so a floor-clamped entry sinks to
	 * the bottom of ranking without introducing a new retrieval-leaking status.
	 * Cleared if confidence recovers above the floor. */
	confidence_floor_demoted?: boolean;
	/** G6 (#1716): recorded at archive time so `unarchiveEntry` can restore the
	 * entry to its prior status. Set by all three archive producers (tool,
	 * curator recommendation, TTL sweep). Absent on entries archived before
	 * this field existed; `unarchiveEntry` falls back to `'candidate'`. */
	archived_from?: KnowledgeEntryBase['status'];
	/** G6 (#1716): ISO 8601 timestamp of archival. */
	archived_at?: string;
	/** G7 (#1716): consecutive-net-negative-phase counter, incremented by
	 * `runAutoDemotion` when a promoted entry's outcome signal is at/below
	 * `promoted_demotion_signal_threshold`. Reset on a non-negative phase and on
	 * demotion. Used with `last_demotion_phase` to demote at
	 * `promoted_demotion_min_negative_phases` consecutive net-negative phases. */
	recent_negative_phase_count?: number;
	/** G7 (#1716): the `phase_number` of the most recent `runAutoDemotion`
	 * counter update. Prevents double-counting when `curateAndStoreSwarm` runs
	 * multiple times in the same logical phase (e.g. phase-complete + close). */
	last_demotion_phase?: number;
	/** #1848 §1: producer provenance. Absent/null on legacy entries →
	 * unknown-owner → protected from destructive curation by default. Filled at
	 * creation time by all new-entry paths via `resolveWorktreeId` +
	 * `resolveCohortId`. Never synthesized for legacy records. */
	producer?: ProducerProvenance | null;
	/** #1848 §3: monotonic revision counter for compare-and-swap. Starts at 1
	 * at creation, bumped on each accepted mutation. Absent/0 = legacy (CAS
	 * with `expectedRevision === undefined` allows the first mutation). */
	revision?: number;
	/** #1848 §3: 12-hex SHA-256 prefix of `lesson`, for CAS content verification.
	 * Computed at WRITE time only (never per-read) to avoid hashing thousands of
	 * entries on every readKnowledge of a large cohort store. Absent on legacy. */
	content_hash?: string;
	/** #1848 §4: idempotency stamp for the fair scan cursor. Records the
	 * generation in which this entry was last curated by a non-idempotent action
	 * (rewrite/demote/confidence-delta). Prevents compounding under concurrent
	 * cohort postmortems that claim the same batch. */
	last_curated_generation?: number;
	/**
	 * Exact-once checkpoint for receipt-driven confidence feedback. Stored in the
	 * same atomic knowledge-entry rewrite as the confidence delta so a crash
	 * before the external projection cursor is written cannot apply the same V2
	 * terminal twice.
	 */
	receipt_feedback_cursors?: Record<
		string,
		{ timestamp: string; event_id: string }
	>;
}

/**
 * Current knowledge schema marker. v1 entries are still parseable and
 * normalized in-memory by knowledge-store.normalizeEntry. v3 (#1848) adds
 * optional `producer`, `revision`, `content_hash`, and `last_curated_generation`
 * fields — all default-absent so v1/v2/v3 records coexist on disk without an
 * on-disk migration. New writes stamp v3.
 */
export const KNOWLEDGE_SCHEMA_VERSION = 3;

/**
 * The single canonical set of inactive (non-retrieval) knowledge statuses.
 * Every retrieval/filter consumer MUST go through {@link isActiveStatus} rather
 * than re-deriving its own literal list — the G4 drift (issue #1716) was caused
 * by exactly that pattern.
 *
 * Note: `archived`, `quarantined`, and `quarantined_unactionable` are all
 * considered inactive. The remaining statuses (`candidate`, `established`,
 * `promoted`) plus the "unknown" cases (`undefined`/`null`/any future string)
 * are considered active — the unknown-status case is intentional and preserves
 * the #828 regression-guard behavior (entries with missing status after
 * migration are not silently dropped from retrieval).
 */
export const INACTIVE_STATUSES: ReadonlySet<string> = new Set([
	'archived',
	'quarantined',
	'quarantined_unactionable',
]);

/**
 * Outcome-signal threshold at or below which a knowledge entry is considered to
 * have a clearly negative track record (negatives clearly outweigh positives,
 * with enough corroborating evidence to act on). Tuned against
 * `computeOutcomeSignal`'s Laplace smoothing so a lone ignore/contradiction
 * does not trip it.
 *
 * G7 (#1716): the canonical home for this value. Previously a module-local
 * const in `knowledge-curator.ts`; lifted here so the config default
 * (`promoted_demotion_signal_threshold`) can reference the same value without
 * a schema→curator import cycle. Both the promotion block and the demotion
 * threshold share this single source of truth.
 */
export const OUTCOME_BLOCK_THRESHOLD = -0.3;

/**
 * Returns `true` for retrieval-active statuses. Returns `true` for
 * `undefined`/`null`/unknown strings (preserves the #828 deny-list intent:
 * entries with unexpected status values are not silently dropped). Returns
 * `false` only for the three known inactive statuses.
 *
 * PRR-009 / design note: issue #1716's G4 section literally requested an
 * allow-list ("future statuses default to excluded"). We deliberately use a
 * deny-list here to preserve the #828 regression-guard intent (entries with
 * missing/unknown status after migration are not silently dropped from
 * retrieval). The known-inactive leak the issue cares about (the 3 statuses
 * above) is closed; the hypothetical-future-status robustness is the tradeoff.
 * Switching to an allow-list would re-introduce #828.
 */
export function isActiveStatus(status: string | undefined | null): boolean {
	return !INACTIVE_STATUSES.has(status ?? '');
}

export interface SwarmKnowledgeEntry extends KnowledgeEntryBase {
	tier: 'swarm';
	confirmed_by: PhaseConfirmationRecord[];
	project_name: string;
}

/**
 * A single validated terminal application of a knowledge entry, usable as
 * promotion evidence (issue #1847). Only receipts tied to a real retrieval
 * trace AND a terminal outcome (`applied` / `violated` / `contradicted`) that
 * is a member of that trace's result set qualify. Shown / retrieved / injected
 * / acknowledged-only states do NOT qualify — they are display/attention
 * signals, not application evidence.
 *
 * Production of real host traces is owned by #1849; this PR (#1847) owns the
 * schema and the conservative promotion-side consumer. Legacy records carry no
 * `PromotionEvidenceRecord`s and receive NO synthetic credit.
 */
export interface PromotionEvidenceRecord {
	/** Canonical repository/cohort identity (from `resolveCohortId`, #1846). */
	cohort_id: string;
	/** Source cohort / link id when known (from the v2 LinkPointer). */
	source_link_id?: string;
	/** The hive/swarm entry id this evidence contributes to. */
	entry_id: string;
	/** Retrieval trace id that surfaced the entry (ties to a RetrievedEvent). */
	retrieval_trace_id: string;
	/** Terminal receipt outcome. */
	receipt_outcome: 'applied' | 'violated' | 'contradicted';
	/**
	 * Provenance class of the terminal this evidence was derived from
	 * (#2032 review F-003). `'delegate'` evidence is a self-report and stays
	 * non-independent: the promotion gate only counts evidence whose source is
	 * present and not `'delegate'` toward `promotion_min_terminal_applications`.
	 * Absent on records written before #2032 — such records fail closed (they
	 * do not count as independent).
	 */
	receipt_source?: string;
	/** Id of the ReceiptEvent this evidence was derived from. */
	receipt_event_id: string;
	phase?: string;
	timestamp: string; // ISO 8601
}

/** How a hive entry was promoted (issue #1847 §3 lineage). */
export type PromotionActor = 'auto' | 'manual' | 'manual-override';

/**
 * Lineage + validated-evidence block attached to a promoted hive entry (issue
 * #1847 §3). A promoted hive record must retain enough provenance to audit
 * redaction/ownership and to trace back to its source without storing
 * unnecessary sensitive content.
 *
 * All fields optional except `actor` so legacy on-disk records (which predate
 * this block) load unchanged. Legacy records are NOT retroactively given a
 * synthetic lineage block (no broad rewrite); consumers treat an absent
 * `lineage` as "origin unknown, pre-#1847".
 */
export interface PromotionLineage {
	/** UUID of the source swarm entry this hive record was promoted from. */
	source_entry_id?: string;
	/** Canonical cohort id of the source repository (#1846). */
	source_cohort_id?: string;
	/** Source entry content hash/revision (for drift detection). */
	source_revision?: string;
	/** Prior phase/confidence snapshot captured at promotion time. */
	prior_confidence?: number;
	prior_phases_alive?: number;
	/** Ids of {@link PromotionEvidenceRecord}s that contributed to this promotion. */
	contributing_evidence_ids?: string[];
	/** For merged near-duplicates: losing entry ids preserved for audit. */
	merged_from?: string[];
	/** The promotion transaction/event id (ties to the hive audit-event log). */
	promotion_event_id?: string;
	/** Who/what initiated the promotion. */
	actor: PromotionActor;
	reason?: string;
	/** When an override was used: the policy gates that failed. */
	override_failed_gates?: string[];
}

export interface HiveKnowledgeEntry extends KnowledgeEntryBase {
	tier: 'hive';
	confirmed_by: ProjectConfirmationRecord[];
	source_project: string; // project where it originated
	/** Weighted encounter score for hive advancement. Starts at 1.0 for originating project. */
	encounter_score: number;
	/** @deprecated Legacy field for backward compatibility. Use encounter_score for weighting. */
	encounter_count?: number;
	/** #1847: promotion lineage + validated-evidence references. Optional so
	 * legacy on-disk records load unchanged; normalized in-memory on read. */
	lineage?: PromotionLineage;
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
	/** Days to retain closed authoritative receipt state before archival. Default: 7 */
	receipt_close_grace_days: number;
	/** N-phase TTL for 'todo' category entries. Default: 3 */
	todo_max_phases: number;
	/** Enable age-based sweep of knowledge entries. Default: true */
	sweep_enabled: boolean;
	/** G2 (#1715): action when an entry sits at the confidence floor with a
	 * net-negative outcome signal. Default: 'demote'. */
	confidence_floor_action: 'none' | 'demote' | 'quarantine';
	/** G2: minimum total outcome-evidence count required before acting. Default: 3. */
	confidence_floor_min_outcomes: number;
	/** G2: outcome-signal threshold below which a floor entry is acted on. Default: 0. */
	confidence_floor_signal_threshold: number;
	/** G3 (#1715): action when contradicted count crosses the threshold. Default: 'quarantine'. */
	contradiction_threshold_action: 'tag_only' | 'quarantine';
	/** G3: contradicted-event count in window to trigger the action. Default: 3. */
	contradiction_quarantine_threshold: number;
	/** G3: window in days for counting contradicted events. Default: 30. */
	contradiction_quarantine_window_days: number;
	/** G7 (#1716): consecutive net-negative phase evaluations required to demote
	 * a `promoted` entry to `established`. Default: 3. */
	promoted_demotion_min_negative_phases: number;
	/** G7 (#1716): outcome-signal threshold at or below which a promoted entry's
	 * demotion counter increments for the current phase. Default: -0.3 (matches
	 * `OUTCOME_BLOCK_THRESHOLD`). */
	promoted_demotion_signal_threshold: number;
	/** #1847: minimum number of validated terminal-application receipts
	 * (PromotionEvidenceRecord) required for the `validated_terminal_applications`
	 * promotion gate. Default 0 — conservative: until #1849 produces real
	 * receipts, absence of evidence neither credits nor blocks. Raising this
	 * activates application-evidence gating. Legacy records get NO synthetic
	 * credit; they simply do not add to the count. */
	promotion_min_terminal_applications: number;
	/** #1847: minimum number of DISTINCT canonical cohort ids that must appear
	 * among the validated terminal-application receipts for the
	 * `validated_terminal_applications` gate. Default 0 (conservative; see
	 * `promotion_min_terminal_applications`). */
	promotion_min_distinct_cohorts: number;
	/** #1821: require a promotion candidate to carry an actionable directive
	 * before it may be promoted. Default true (see `KnowledgeConfigSchema`).
	 * Declared OPTIONAL here on purpose: this hand-written interface is what the
	 * hooks layer imports, and hundreds of full config literals in tests would
	 * otherwise need updating. The Zod inference keeps it required. */
	promotion_require_actionable?: boolean;
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
	| 'contradicted'
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
