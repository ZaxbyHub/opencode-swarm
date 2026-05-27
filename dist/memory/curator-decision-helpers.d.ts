import type { AppliedMemoryChange, MemoryPatch, MemoryProposal, MemoryRecord, ResolvedCuratorMemoryDecision } from './types';
export declare const CURATOR_PROMOTED_MEMORY_MAX_TEXT_LENGTH = 500;
export declare function validateDecisionMatchesProposal(decision: ResolvedCuratorMemoryDecision, proposal: MemoryProposal): void;
export declare function validateCuratorPromotableMemory(record: MemoryRecord): void;
export declare function applyPatchToMemory(existing: MemoryRecord, patch: MemoryPatch, updatedAt: string): MemoryRecord;
export declare function markProposalReviewed(proposal: MemoryProposal, decision: ResolvedCuratorMemoryDecision, status: MemoryProposal['status'], reviewedAt: string, ids: {
    memoryId?: string;
    targetMemoryId?: string;
    oldMemoryId?: string;
    replacementMemoryId?: string;
}): MemoryProposal;
export declare function curatorDecisionReason(decision: ResolvedCuratorMemoryDecision): string | undefined;
export declare function buildCuratorDecisionEvent(change: AppliedMemoryChange, proposal: MemoryProposal): AppliedMemoryChange & {
    proposalOperation: MemoryProposal['operation'];
};
export declare function normalizeTags(tags: string[]): string[];
