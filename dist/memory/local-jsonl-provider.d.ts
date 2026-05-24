import { type MemoryConfig } from './config';
import type { MemoryProposalStore, MemoryProvider, MemoryRecallUsageEvent } from './provider';
import type { RecallScoringDiagnostics } from './scoring';
import type { MemoryListFilter, MemoryProposal, MemoryRecord, RecallRequest, RecallResultItem } from './types';
export declare class LocalJsonlMemoryProvider implements MemoryProvider, MemoryProposalStore {
    readonly name = "local-jsonl";
    private readonly rootDirectory;
    private readonly config;
    private initialized;
    private memories;
    private proposals;
    constructor(rootDirectory: string, config?: Partial<MemoryConfig>);
    private pathFor;
    initialize(): Promise<void>;
    upsert(record: MemoryRecord): Promise<MemoryRecord>;
    get(id: string): Promise<MemoryRecord | null>;
    delete(id: string, reason?: string): Promise<void>;
    recall(request: RecallRequest): Promise<RecallResultItem[]>;
    recallWithDiagnostics(request: RecallRequest): Promise<{
        items: RecallResultItem[];
        diagnostics: RecallScoringDiagnostics;
    }>;
    recordRecallUsage(event: MemoryRecallUsageEvent): Promise<void>;
    list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
    createProposal(proposal: MemoryProposal): Promise<MemoryProposal>;
    listProposals(filter?: {
        status?: MemoryProposal['status'];
        limit?: number;
    }): Promise<MemoryProposal[]>;
    compact(): Promise<void>;
    private audit;
}
