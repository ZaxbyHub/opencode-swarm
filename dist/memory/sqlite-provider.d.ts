import { type MemoryConfig } from './config';
import { type JsonlMigrationReport } from './jsonl-migration';
import type { MemoryCompactOptions, MemoryCompactResult, MemoryProposalStore, MemoryProvider, MemoryRecallUsageEvent, MemoryRecallUsageFilter } from './provider';
import type { RecallScoringDiagnostics } from './scoring';
import type { AppliedMemoryChange, MemoryListFilter, MemoryProposal, MemoryRecord, RecallRequest, RecallResultItem, ResolvedCuratorMemoryDecision } from './types';
export interface SQLiteJsonlImportResult {
    importedMemories: number;
    importedProposals: number;
    invalidRows: JsonlMigrationReport['invalidRows'];
    totalRows: number;
}
export declare class SQLiteMemoryProvider implements MemoryProvider, MemoryProposalStore {
    readonly name = "sqlite";
    private readonly rootDirectory;
    private readonly config;
    private initialized;
    private db;
    private ftsAvailable;
    private memories;
    private proposals;
    private lastAutomaticJsonlMigration;
    constructor(rootDirectory: string, config?: Partial<MemoryConfig>);
    private databasePath;
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
    listRecallUsage(filter?: MemoryRecallUsageFilter): Promise<MemoryRecallUsageEvent[]>;
    list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
    createProposal(proposal: MemoryProposal): Promise<MemoryProposal>;
    listProposals(filter?: {
        status?: MemoryProposal['status'];
        limit?: number;
    }): Promise<MemoryProposal[]>;
    applyCuratorDecision(decision: ResolvedCuratorMemoryDecision): Promise<AppliedMemoryChange>;
    close(): void;
    importJsonl(): Promise<SQLiteJsonlImportResult>;
    exportJsonl(): Promise<{
        directory: string;
        memoriesPath: string;
        proposalsPath: string;
        memories: number;
        proposals: number;
    }>;
    compactMaintenance(options?: MemoryCompactOptions): Promise<MemoryCompactResult>;
    hasMigration(name: string): boolean;
    markMigration(version: number, name: string): void;
    private selectRecallCandidates;
    private runMigrations;
    private initializeFtsIndex;
    private recreateFtsIndex;
    private rebuildFtsIndex;
    private countValidMemoryRows;
    private iterateMemoryRows;
    private parseMemoryRow;
    private loadMemories;
    private loadProposals;
    private writeMemory;
    private writeMemoryFts;
    private deleteMemoryFts;
    private writeProposal;
    private applyDecisionToStorage;
    private readPendingProposal;
    private readActiveMemory;
    private validateDecisionMemory;
    private migrateLegacyJsonlIfNeeded;
    private importLegacyJsonlRows;
    private event;
    private insertEvent;
    private requireDb;
}
declare function buildFtsQuery(request: RecallRequest): string | null;
declare function extractFtsTerms(text: string): Set<string>;
export declare const _test_exports: {
    buildFtsQuery: typeof buildFtsQuery;
    extractFtsTerms: typeof extractFtsTerms;
    FTS_SCHEMA_MIGRATION_NAME: string;
    FTS_SCHEMA_MIGRATION_VERSION: number;
};
export {};
