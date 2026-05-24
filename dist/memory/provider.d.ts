import type { MemoryListFilter, MemoryProposal, MemoryRecord, RecallRequest, RecallResultItem } from './types';
export interface MemoryProvider {
    readonly name: string;
    initialize?(): Promise<void>;
    upsert(record: MemoryRecord): Promise<MemoryRecord>;
    get(id: string): Promise<MemoryRecord | null>;
    delete(id: string, reason?: string): Promise<void>;
    recall(request: RecallRequest): Promise<RecallResultItem[]>;
    list(filter: MemoryListFilter): Promise<MemoryRecord[]>;
}
export interface MemoryProposalStore {
    createProposal(proposal: MemoryProposal): Promise<MemoryProposal>;
    listProposals(filter?: {
        status?: MemoryProposal['status'];
        limit?: number;
    }): Promise<MemoryProposal[]>;
}
