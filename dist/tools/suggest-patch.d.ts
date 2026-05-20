import type { ToolDefinition } from '@opencode-ai/plugin/tool';
export interface PatchHunk {
    file: string;
    originalContext: string[];
    newContent: string;
    hunkIndex: number;
}
export interface PatchSuggestion {
    success: true;
    patches: PatchHunk[];
    filesModified: string[];
    errors?: PatchError[];
}
export interface PatchError {
    success: false;
    error: true;
    type: 'context-mismatch' | 'file-not-found' | 'parse-error' | 'unknown';
    message: string;
    details?: {
        expected?: string;
        actual?: string;
        location?: string;
    };
    errors?: PatchError[];
}
export interface ChangeDescription {
    file: string;
    contextBefore?: string[];
    contextAfter?: string[];
    oldContent?: string;
    newContent: string;
}
export interface SuggestPatchArgs {
    targetFiles: string[];
    changes: ChangeDescription[];
}
export declare const suggestPatch: ToolDefinition;
