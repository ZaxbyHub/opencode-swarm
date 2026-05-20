import type { Evidence } from '../config/evidence-schema';
import { listEvidenceTaskIds as _listEvidenceTaskIds, loadEvidence as _loadEvidence } from '../evidence/manager';
/**
 * _internals — DI seam for testing async I/O without cross-module mocks.
 */
export declare const _internals: {
    loadEvidence: typeof _loadEvidence;
    listEvidenceTaskIds: typeof _listEvidenceTaskIds;
};
/**
 * Structured evidence entry for a task.
 */
export interface EvidenceEntryData {
    index: number;
    entry: Evidence;
    type: string;
    verdict: string;
    verdictIcon: string;
    agent: string;
    summary: string;
    timestamp: string;
    details: Record<string, string | number | undefined>;
}
/**
 * Structured evidence data for a single task.
 */
export interface TaskEvidenceData {
    hasEvidence: boolean;
    taskId: string;
    createdAt: string;
    updatedAt: string;
    entries: EvidenceEntryData[];
}
/**
 * Structured evidence list data for all tasks.
 */
export interface EvidenceListData {
    hasEvidence: boolean;
    tasks: Array<{
        taskId: string;
        entryCount: number;
        lastUpdated: string;
    }>;
}
/**
 * Get emoji for verdict type (exported for use in entry formatting).
 */
export declare function getVerdictEmoji(verdict: string): string;
/**
 * Get evidence data for a specific task.
 */
export declare function getTaskEvidenceData(directory: string, taskId: string): Promise<TaskEvidenceData>;
/**
 * Get list of all evidence bundles.
 */
export declare function getEvidenceListData(directory: string): Promise<EvidenceListData>;
/**
 * Format evidence list as markdown for command output.
 */
export declare function formatEvidenceListMarkdown(list: EvidenceListData): string;
/**
 * Format task evidence as markdown for command output.
 */
export declare function formatTaskEvidenceMarkdown(evidence: TaskEvidenceData): string;
/**
 * Handle evidence command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export declare function handleEvidenceCommand(directory: string, args: string[]): Promise<string>;
/**
 * Handle evidence summary command - generates completion ratio and blockers report.
 */
export declare function handleEvidenceSummaryCommand(directory: string): Promise<string>;
