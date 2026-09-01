export type MemoryScopeType =
	| 'global_user'
	| 'workspace'
	| 'project'
	| 'repository'
	| 'run'
	| 'agent'
	// Linked Knowledge 5/5 (#1850): cohort-scoped memory shared across linked
	// sibling worktrees through the #1846 cohort identity. A cohort scope is
	// visible to every worktree that resolves the same canonical cohort id, so
	// it is the scope used for shared repository memory. Per-session/per-run
	// state continues to use the `run`/`agent` scopes (which stay worktree-local).
	| 'cohort';

export interface MemoryScopeRef {
	type: MemoryScopeType;
	userId?: string;
	workspaceId?: string;
	projectId?: string;
	repoId?: string;
	repoRoot?: string;
	runId?: string;
	agentId?: string;
	/** Canonical cohort id from `resolveCohortId` (#1850). Set when
	 * `type === 'cohort'`. Required for cohort-scoped records so the scope key
	 * and recall filters distinguish different cohorts. */
	cohortId?: string;
}

export type MemoryKind =
	| 'user_preference'
	| 'project_fact'
	| 'architecture_decision'
	| 'repo_convention'
	| 'api_finding'
	| 'code_pattern'
	| 'test_pattern'
	| 'failure_pattern'
	| 'security_note'
	| 'evidence'
	| 'todo'
	| 'scratch';

export interface MemorySource {
	type:
		| 'user'
		| 'agent'
		| 'tool'
		| 'file'
		| 'repo'
		| 'commit'
		| 'test'
		| 'web'
		| 'manual';
	ref?: string;
	url?: string;
	filePath?: string;
	commitSha?: string;
	createdBy?: string;
}

/** Repository-relative structural location associated with a memory result. */
export interface MemoryAnchor {
	file: string;
	symbol?: string;
}

/** A task-observed result for a recalled memory or graph answer. */
export interface MemoryOutcome {
	outcome: 'useful' | 'dead_end' | 'corrected';
	at: string;
	taskId?: string;
	correction?: string;
}

export interface MemoryRelation {
	memoryId: string;
	type: 'merged_with';
}

export interface MemoryRecord {
	id: string;
	scope: MemoryScopeRef;
	kind: MemoryKind;
	text: string;
	tags: string[];
	confidence: number;
	stability: 'ephemeral' | 'session' | 'durable';
	source: MemorySource;
	createdAt: string;
	updatedAt: string;
	lastAccessedAt?: string;
	expiresAt?: string;
	/** Provider-derived from applied curator proposals; never user-writable. */
	relations?: MemoryRelation[];
	supersedes?: string[];
	supersededBy?: string;
	contentHash: string;
	metadata: Record<string, unknown>;
	/** Optional code-structure anchors; additive for pre-#1989 stores. */
	anchors?: MemoryAnchor[];
	/** Append-only materialized outcome view; provider events remain canonical. */
	outcomes?: MemoryOutcome[];
	// Linked Knowledge 5/5 (#1850): cohort-sharing provenance. All optional so
	// pre-#1850 records continue to load without migration. Populated by the
	// gateway on cohort-linked writes; validated by `validateMemoryRecordRules`
	// for cohort-scoped records. Provenance preserves privacy/redaction policy
	// across cohort members (acceptance #13).
	/** Canonical cohort id the record belongs to. Matches `scope.cohortId`
	 * when `scope.type === 'cohort'`. */
	cohortId?: string;
	/** Session id of the producer (when policy permits retention). */
	producerSessionId?: string;
	/** Agent role of the producer. */
	producerAgentRole?: string;
	/** Redaction policy version at write time (from REDACTION_POLICY_VERSION). */
	redactionPolicyVersion?: number;
	/** Memory schema version at write time. */
	schemaVersion?: number;
	/** Provider name at write time (`'sqlite'` | `'local-jsonl'`). */
	providerVersion?: string;
	/** Source git revision of the producer, when available. */
	sourceRevision?: string;
	// #1466 Phase 6 provenance — denormalized to memory_items columns by the
	// SQLite provider. All optional so pre-#1466 records (and the JSONL
	// provider) stay valid; contentHash/id derive from {scope,kind,text} only.
	/** Unit-of-work (plan task) identity that produced the record. Never
	 * defaulted to sessionID — see MemoryContext.unitId. */
	sourceTaskId?: string;
	/** Embedding model version at write time (Phase 4 swaps join on this). */
	embeddingModelVersion?: string;
	/** When this memory became authoritative (supersede chains). */
	validFrom?: string;
	/** Why this record superseded its predecessor. */
	supersedesReason?: string;
}

export interface MemoryProposal {
	id: string;
	operation: 'add' | 'update' | 'delete' | 'ignore' | 'merge' | 'supersede';
	proposedRecord?: MemoryRecord;
	targetMemoryId?: string;
	relatedMemoryIds?: string[];
	proposedBy: {
		agentRole?: string;
		agentId?: string;
		runId?: string;
	};
	rationale: string;
	evidenceRefs: string[];
	status: 'pending' | 'approved' | 'rejected' | 'superseded' | 'applied';
	reviewer?: 'user' | 'controller' | 'curator_agent' | 'auto_policy';
	reviewedAt?: string;
	rejectionReason?: string;
	createdAt: string;
	metadata: Record<string, unknown>;
}

export interface NewMemoryRecord {
	scope?: MemoryScopeRef;
	kind: MemoryKind;
	text: string;
	tags?: string[];
	confidence?: number;
	stability?: MemoryRecord['stability'];
	source?: MemorySource;
	expiresAt?: string;
	metadata?: Record<string, unknown>;
	anchors?: MemoryAnchor[];
	outcomes?: MemoryOutcome[];
}

export type MemoryPatch = Partial<
	Pick<
		NewMemoryRecord,
		| 'scope'
		| 'kind'
		| 'text'
		| 'tags'
		| 'confidence'
		| 'stability'
		| 'source'
		| 'expiresAt'
		| 'metadata'
		| 'anchors'
		| 'outcomes'
	>
>;

export type CuratorMemoryDecision =
	| { action: 'add'; proposalId: string; memory: NewMemoryRecord }
	| {
			action: 'update';
			proposalId: string;
			targetMemoryId: string;
			patch: MemoryPatch;
			reason: string;
	  }
	| {
			action: 'supersede';
			proposalId: string;
			oldMemoryId: string;
			replacement: NewMemoryRecord;
			reason: string;
	  }
	| {
			action: 'merge';
			proposalId: string;
			relatedMemoryIds: string[];
			reason: string;
	  }
	| { action: 'reject'; proposalId: string; reason: string }
	| { action: 'noop'; proposalId: string; reason: string };

export type ResolvedCuratorMemoryDecision =
	| { action: 'add'; proposalId: string; memory: MemoryRecord }
	| {
			action: 'update';
			proposalId: string;
			targetMemoryId: string;
			patch: MemoryPatch;
			reason: string;
	  }
	| {
			action: 'supersede';
			proposalId: string;
			oldMemoryId: string;
			replacement: MemoryRecord;
			reason: string;
	  }
	| {
			action: 'merge';
			proposalId: string;
			relatedMemoryIds: string[];
			reason: string;
	  }
	| { action: 'reject'; proposalId: string; reason: string }
	| { action: 'noop'; proposalId: string; reason: string };

export interface AppliedMemoryChange {
	action: CuratorMemoryDecision['action'];
	proposalId: string;
	proposalStatus: MemoryProposal['status'];
	appliedAt: string;
	eventId?: string;
	memoryId?: string;
	targetMemoryId?: string;
	oldMemoryId?: string;
	replacementMemoryId?: string;
	relatedMemoryIds?: string[];
	reason?: string;
}

export type RecallMode = 'manual' | 'injection' | 'curator' | 'evaluation';
export type RecallInjectionSkipReason =
	| 'disabled'
	| 'no_signal'
	| 'below_threshold'
	| 'no_results';

export interface RecallRequest {
	query: string;
	task?: string;
	agentRole?: string;
	mode?: RecallMode;
	scopes: MemoryScopeRef[];
	kinds?: MemoryKind[];
	maxItems: number;
	tokenBudget: number;
	minScore?: number;
	requireQuerySignal?: boolean;
	includeExpired?: boolean;
	includePendingProposals?: boolean;
	/**
	 * Opt in to include memories suppressed for low learned utility (q-value
	 * below `qLearning.suppressionThreshold`). Default recall omits them;
	 * suppression never deletes or tombstones the underlying record.
	 */
	includeLowQ?: boolean;
}

export interface RecallResultItem {
	record: MemoryRecord;
	score: number;
	reason: string;
	relation?: { type: MemoryRelation['type']; sourceMemoryId: string };
	signals: {
		textOverlap: number;
		tagOverlap: number;
		fileOverlap?: number;
		symbolOverlap?: number;
		kindMatch: boolean;
		scopeMatch: boolean;
	};
	/**
	 * C.1 (FR-014/SC-016): true when this item was an otherwise-suppressed
	 * low-q memory (qValue < `qLearning.suppressionThreshold`) resurfaced by
	 * the bounded active-exploration layer in
	 * `scoreMemoryRecordsWithDiagnostics`, rather than a normal recall hit.
	 * Absent/undefined for every normal (non-explored) item.
	 */
	explored?: boolean;
}

export interface RecallBundle {
	id: string;
	query: string;
	generatedAt: string;
	items: RecallResultItem[];
	tokenEstimate: number;
	promptBlock: string;
	diagnostics?: {
		injectionSkipReason?: RecallInjectionSkipReason;
		candidateCount?: number;
		preScoredFilteredCount?: number;
		noSignalCount?: number;
		belowThresholdCount?: number;
	};
}

export interface MemoryContext {
	directory: string;
	sessionID?: string;
	agentRole?: string;
	agentId?: string;
	runId?: string;
	/**
	 * Task/phase unit-of-work identity (e.g. plan task id "1.1"). ADDITIVE join
	 * key recorded alongside `runId` on recall-usage rows so reward attribution
	 * (B.2) and the finalize sweep (B.6) can join memories to the unit of work
	 * they were recalled for — independent of session id. NULL/undefined when a
	 * trustworthy id cannot be resolved at recording time; the system then
	 * degrades to today's session-scoped (`runId`) behavior. Never defaulted to
	 * sessionID — that would repopulate the exact session-scoped value this
	 * escapes.
	 */
	unitId?: string;
}

export interface MemoryListFilter {
	scopes?: MemoryScopeRef[];
	kinds?: MemoryKind[];
	includeExpired?: boolean;
	includeInactive?: boolean;
	limit?: number;
}
