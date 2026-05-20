import type { ToolDefinition } from '@opencode-ai/plugin/tool';
export interface SearchMatch {
    file: string;
    lineNumber: number;
    lineText: string;
    context?: string[];
}
export interface SearchResult {
    matches: SearchMatch[];
    truncated: boolean;
    total: number;
    query: string;
    mode: 'literal' | 'regex';
    maxResults: number;
}
export interface SearchError {
    error: true;
    type: 'rg-not-found' | 'regex-timeout' | 'path-escape' | 'invalid-query' | 'unknown';
    message: string;
}
export interface SearchArgs {
    query: string;
    mode?: 'literal' | 'regex';
    include?: string;
    exclude?: string;
    max_results?: number;
    max_lines?: number;
}
export declare const search: ToolDefinition;
