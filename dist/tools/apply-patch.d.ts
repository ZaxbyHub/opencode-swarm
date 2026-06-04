/**
 * apply-patch — Native Swarm tool for applying unified diffs in-process.
 * Parses standard unified diff format, validates paths against workspace
 * boundaries, matches hunk context exactly, and writes atomically.
 *
 * FR-001 through FR-014, SR-002 through SR-005.
 * Pure TypeScript, no shell/git/external binaries, standard node:fs sync I/O.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/** Per-file error detail in the structured output. */
export interface ApplyPatchFileError {
    hunkIndex: number;
    type: 'context-mismatch' | 'file-not-found' | 'file-unchanged' | 'create-not-allowed' | 'delete-not-allowed' | 'binary-rejected' | 'rename-rejected';
    message: string;
    expected?: string;
    actual?: string;
    line?: number;
}
/** Per-file result in the structured output. */
export interface ApplyPatchFileResult {
    file: string;
    status: 'applied' | 'no-changes' | 'created' | 'error';
    hunks: number;
    hunksApplied: number;
    hunksFailed: number;
    errors?: ApplyPatchFileError[];
}
/** Structured JSON result returned by the tool. */
export interface ApplyPatchResult {
    success: boolean;
    dryRun?: boolean;
    files: ApplyPatchFileResult[];
    summary: {
        totalFiles: number;
        applied: number;
        failed: number;
        totalHunks: number;
    };
}
/** Arguments accepted by the apply_patch tool. */
export interface ApplyPatchArgs {
    patch: string;
    files: string[];
    dryRun?: boolean;
    allowCreates?: boolean;
    allowDeletes?: boolean;
}
export declare const applyPatch: ToolDefinition;
