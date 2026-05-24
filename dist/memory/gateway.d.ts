import { type MemoryConfig } from './config';
import type { MemoryProposalStore, MemoryProvider } from './provider';
import type { MemoryContext, MemoryKind, MemoryProposal, MemoryRecord, MemoryScopeRef, MemorySource, RecallBundle, RecallMode } from './types';
export interface MemoryGatewayOptions {
    config?: Partial<MemoryConfig>;
    provider?: MemoryProvider & Partial<MemoryProposalStore>;
    now?: () => Date;
}
export interface ProposeMemoryInput {
    operation: MemoryProposal['operation'];
    kind?: MemoryKind;
    text?: string;
    targetMemoryId?: string;
    relatedMemoryIds?: string[];
    rationale: string;
    evidenceRefs?: string[];
}
export interface RecallMemoryInput {
    query: string;
    task?: string;
    mode?: RecallMode;
    scopes?: MemoryScopeRef[];
    kinds?: MemoryKind[];
    maxItems?: number;
    tokenBudget?: number;
    minScore?: number;
    requireQuerySignal?: boolean;
    includeExpired?: boolean;
}
export declare class MemoryGateway {
    private readonly context;
    private readonly config;
    private readonly provider;
    private readonly now;
    constructor(context: MemoryContext, options?: MemoryGatewayOptions);
    isEnabled(): boolean;
    deriveAllowedScopes(): MemoryScopeRef[];
    recall(input: RecallMemoryInput): Promise<RecallBundle>;
    propose(input: ProposeMemoryInput): Promise<MemoryProposal>;
    upsertCurated(record: MemoryRecord): Promise<MemoryRecord>;
    createRecord(input: {
        kind: MemoryKind;
        text: string;
        evidenceRefs?: string[];
        source?: MemorySource;
        scope?: MemoryScopeRef;
        confidence?: number;
        stability?: MemoryRecord['stability'];
        tags?: string[];
        metadata?: Record<string, unknown>;
    }): MemoryRecord;
    private assertEnabled;
}
export declare function createMemoryGateway(context: MemoryContext, options?: MemoryGatewayOptions): MemoryGateway;
