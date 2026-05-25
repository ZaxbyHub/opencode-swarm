import { type MemoryConfig } from './config';
import type { MemoryProposal, MemoryRecord } from './types';
export declare const LEGACY_JSONL_MIGRATION_VERSION = 2;
export declare const LEGACY_JSONL_MIGRATION_NAME = "legacy_jsonl_import_complete";
export interface JsonlInvalidRow {
    file: 'memories.jsonl' | 'proposals.jsonl';
    line: number;
    error: string;
}
export interface JsonlImportPayload {
    memories: MemoryRecord[];
    proposals: MemoryProposal[];
    invalidRows: JsonlInvalidRow[];
    totalRows: number;
}
export interface JsonlBackupResult {
    source: string;
    backup: string;
    created: boolean;
}
export interface JsonlMigrationReport {
    migration: typeof LEGACY_JSONL_MIGRATION_NAME;
    completedAt: string;
    skipped: boolean;
    reason?: string;
    importedMemories: number;
    importedProposals: number;
    invalidRows: JsonlInvalidRow[];
    backups: JsonlBackupResult[];
}
export declare function resolveMemoryStorageDir(rootDirectory: string, config?: Partial<MemoryConfig>): string;
export declare function resolveSqliteDatabasePath(rootDirectory: string, config?: Partial<MemoryConfig>): string;
export declare function readLegacyJsonl(rootDirectory: string, config?: Partial<MemoryConfig>): Promise<JsonlImportPayload>;
export declare function backupLegacyJsonl(rootDirectory: string, config?: Partial<MemoryConfig>): Promise<JsonlBackupResult[]>;
export declare function writeJsonlExport(rootDirectory: string, config: Partial<MemoryConfig>, memories: MemoryRecord[], proposals: MemoryProposal[]): Promise<{
    directory: string;
    memoriesPath: string;
    proposalsPath: string;
}>;
export declare function writeMigrationReport(rootDirectory: string, report: JsonlMigrationReport, config?: Partial<MemoryConfig>): Promise<string>;
export declare function readMigrationReport(rootDirectory: string, config?: Partial<MemoryConfig>): Promise<JsonlMigrationReport | null>;
export declare function getLegacyJsonlFileStatus(rootDirectory: string, config?: Partial<MemoryConfig>): Promise<Array<{
    file: 'memories.jsonl' | 'proposals.jsonl';
    path: string;
    exists: boolean;
    sizeBytes: number;
}>>;
