import type { ToolDefinition } from '@opencode-ai/plugin/tool';
export interface SymbolInfo {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'variable' | 'method' | 'property';
    exported: boolean;
    signature: string;
    line: number;
    jsdoc?: string;
}
export type FileErrorType = 'file-not-found' | 'parse-error' | 'empty-file' | 'unsupported-language' | 'path-traversal' | 'path-outside-workspace' | 'invalid-path';
export interface FileSymbolResult {
    file: string;
    success: boolean;
    symbols?: SymbolInfo[];
    error?: string;
    errorType?: FileErrorType;
}
export interface BatchSymbolsResult {
    results: FileSymbolResult[];
    totalFiles: number;
    successCount: number;
    failureCount: number;
}
export declare const batch_symbols: ToolDefinition;
