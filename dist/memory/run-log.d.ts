export type MemoryRunLogEventName = 'recall_requested' | 'recall_returned' | 'prompt_injection_skipped' | 'prompt_injected' | 'proposal_created' | 'proposal_rejected_by_validation';
export interface MemoryRunLogEvent {
    event: MemoryRunLogEventName;
    runId: string;
    agentRole?: string;
    agentId?: string;
    bundleId?: string;
    memoryIds?: string[];
    scores?: number[];
    tokenEstimate?: number;
    proposalId?: string;
    rejectionReason?: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
}
export declare function appendMemoryRunLog(directory: string, runId: string | undefined, event: MemoryRunLogEvent): Promise<void>;
export declare function sanitizeRunId(runId: string | undefined): string;
