import { type MemoryConfig } from './config';
import { type JsonlMigrationReport } from './jsonl-migration';
import type { MemoryProposalStore, MemoryProvider, MemoryRecallUsageEvent } from './provider';
import type { RecallScoringDiagnostics } from './scoring';
import type { MemoryListFilter, MemoryProposal, MemoryRecord, RecallRequest, RecallResultItem } from './types';
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
    list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
    createProposal(proposal: MemoryProposal): Promise<MemoryProposal>;
    listProposals(filter?: {
        status?: MemoryProposal['status'];
        limit?: number;
    }): Promise<MemoryProposal[]>;
    close(): void;
    importJsonl(): Promise<SQLiteJsonlImportResult>;
    exportJsonl(): Promise<{
        directory: string;
        memoriesPath: string;
        proposalsPath: string;
        memories: number;
        proposals: number;
    }>;
    hasMigration(name: string): boolean;
    markMigration(version: number, name: string): void;
    private runMigrations;
    private loadMemories;
    private loadProposals;
    private writeMemory;
    private writeProposal;
    private migrateLegacyJsonlIfNeeded;
    private importLegacyJsonlRows;
    private event;
    private insertEvent;
    private requireDb;
}
