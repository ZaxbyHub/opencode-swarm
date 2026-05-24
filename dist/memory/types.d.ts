export type MemoryScopeType = 'global_user' | 'workspace' | 'project' | 'repository' | 'run' | 'agent';
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
export type MemoryKind = 'user_preference' | 'project_fact' | 'architecture_decision' | 'repo_convention' | 'api_finding' | 'code_pattern' | 'test_pattern' | 'failure_pattern' | 'security_note' | 'evidence' | 'todo' | 'scratch';
export interface MemorySource {
    type: 'user' | 'agent' | 'tool' | 'file' | 'repo' | 'commit' | 'test' | 'web' | 'manual';
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
export interface RecallRequest {
    query: string;
    task?: string;
    agentRole?: string;
    scopes: MemoryScopeRef[];
    kinds?: MemoryKind[];
    maxItems: number;
    tokenBudget: number;
    minScore?: number;
    includeExpired?: boolean;
    includePendingProposals?: boolean;
}
export interface RecallResultItem {
    record: MemoryRecord;
    score: number;
    reason: string;
}
export interface RecallBundle {
    id: string;
    query: string;
    generatedAt: string;
    items: RecallResultItem[];
    tokenEstimate: number;
    promptBlock: string;
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
