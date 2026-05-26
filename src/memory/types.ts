export type MemoryScopeType =
	| 'global_user'
	| 'workspace'
	| 'project'
	| 'repository'
	| 'run'
	| 'agent';

export interface MemoryScopeRef {
	type: MemoryScopeType;
	userId?: string;
	workspaceId?: string;
	projectId?: string;
	repoId?: string;
	repoRoot?: string;
	runId?: string;
	agentId?: string;
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
	supersedes?: string[];
	supersededBy?: string;
	contentHash: string;
	metadata: Record<string, unknown>;
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
}

export interface RecallResultItem {
	record: MemoryRecord;
	score: number;
	reason: string;
	signals: {
		textOverlap: number;
		tagOverlap: number;
		fileOverlap?: number;
		symbolOverlap?: number;
		kindMatch: boolean;
		scopeMatch: boolean;
	};
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
}

export interface MemoryListFilter {
	scopes?: MemoryScopeRef[];
	kinds?: MemoryKind[];
	includeExpired?: boolean;
	limit?: number;
}
