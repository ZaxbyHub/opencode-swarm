import { type ASTDiffResult } from '../diff/ast-diff.js';
import { type SemanticDiffSummary } from '../diff/summary-generator.js';
import { createSwarmTool } from './create-tool';
export interface DiffResult {
    files: Array<{
        path: string;
        additions: number;
        deletions: number;
    }>;
    contractChanges: string[];
    hasContractChanges: boolean;
    summary: string;
    astDiffs?: ASTDiffResult[];
    semanticSummary?: SemanticDiffSummary;
    markdownSummary?: string;
    /**
     * @deprecated This field is no longer computed and will be removed in a future version.
     * It is retained for backward compatibility with existing consumers.
     */
    astSkippedCount?: number;
}
export interface DiffErrorResult {
    error: string;
    files: [];
    contractChanges: [];
    hasContractChanges: false;
}
export declare const diff: ReturnType<typeof createSwarmTool>;
