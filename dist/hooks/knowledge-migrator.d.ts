/** One-time migration from .swarm/context.md → .swarm/knowledge.jsonl for existing projects. */
import type { KnowledgeCategory, KnowledgeConfig } from './knowledge-types.js';
export interface MigrationResult {
    migrated: boolean;
    entriesMigrated: number;
    entriesDropped: number;
    entriesTotal: number;
    skippedReason?: 'sentinel-exists' | 'no-context-file' | 'empty-context' | 'external-sentinel-exists';
}
export declare function migrateKnowledgeToExternal(_directory: string, _config: KnowledgeConfig): Promise<MigrationResult>;
interface RawMigrationEntry {
    text: string;
    sourceSection: 'lessons-learned' | 'patterns' | 'sme-cache' | 'decisions';
    categoryHint: KnowledgeCategory | null;
}
interface Section {
    heading: string;
    body: string;
}
export declare const _internals: {
    migrateContextToKnowledge: typeof migrateContextToKnowledge;
    migrateKnowledgeToExternal: typeof migrateKnowledgeToExternal;
    parseContextMd: typeof parseContextMd;
    splitIntoSections: typeof splitIntoSections;
    extractBullets: typeof extractBullets;
    inferCategoryFromText: typeof inferCategoryFromText;
    truncateLesson: typeof truncateLesson;
    inferProjectName: typeof inferProjectName;
    writeSentinel: typeof writeSentinel;
};
export declare function migrateContextToKnowledge(directory: string, config: KnowledgeConfig): Promise<MigrationResult>;
/**
 * Parse context.md content into raw migration entries.
 * Extracts bullets from sections matching: lessons-learned, patterns, sme-cache, decisions.
 */
declare function parseContextMd(content: string): RawMigrationEntry[];
/**
 * Split markdown content into sections based on headings (h1-h3).
 */
declare function splitIntoSections(content: string): Section[];
/**
 * Extract bullet points from markdown body text.
 * Matches lines starting with - or * followed by content.
 */
declare function extractBullets(body: string): string[];
/**
 * Infer knowledge category from text using keyword matching.
 */
declare function inferCategoryFromText(text: string): KnowledgeCategory;
/**
 * Truncate lesson text to maximum 280 characters.
 */
declare function truncateLesson(text: string): string;
/**
 * Infer project name from package.json or directory basename.
 */
declare function inferProjectName(directory: string): string;
/**
 * Write sentinel file to track migration status.
 */
declare function writeSentinel(sentinelPath: string, migrated: number, dropped: number): Promise<void>;
export {};
