import type { MemoryProposalStore, MemoryProvider } from './provider';
import type { MemoryProposal, MemoryRecord } from './types';
export interface MemoryRecallUsageByMemory {
    memoryId: string;
    count: number;
    lastRecalledAt: string;
    agentRoles: Record<string, number>;
    averageScore: number;
}
export interface MemoryRecallUsageByRole {
    agentRole: string;
    count: number;
    memoryIds: Record<string, number>;
}
export interface MemorySupersededChain {
    rootId: string;
    chain: string[];
    reason?: string;
}
export interface MemoryMaintenanceReport {
    generatedAt: string;
    totalMemories: number;
    activeMemories: number;
    deletedMemories: MemoryRecord[];
    expiredScratchMemories: MemoryRecord[];
    supersededMemories: MemoryRecord[];
    supersededChains: MemorySupersededChain[];
    lowUtilityMemories: MemoryRecord[];
    neverRecalledMemories: MemoryRecord[];
    mostRecalledMemories: MemoryRecallUsageByMemory[];
    recallByAgentRole: MemoryRecallUsageByRole[];
    rejectedProposalReasons: MemoryProposal[];
    pendingProposals: MemoryProposal[];
    recallEventCount: number;
}
export interface MemoryMaintenanceReportOptions {
    now?: Date;
    limit?: number;
    lowUtilityMaxConfidence?: number;
    lowUtilityMinAgeDays?: number;
}
type ObservableProvider = MemoryProvider & Partial<MemoryProposalStore> & {
    listRecallUsage?: MemoryProvider['listRecallUsage'];
};
export declare function buildMemoryMaintenanceReport(provider: ObservableProvider, options?: MemoryMaintenanceReportOptions): Promise<MemoryMaintenanceReport>;
export declare function shouldCompactMemory(memory: MemoryRecord, now?: Date): 'deleted' | 'superseded' | 'expired_scratch' | null;
export {};
