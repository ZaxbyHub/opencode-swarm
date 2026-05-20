import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Extract filename from code content or context
 */
export declare function extractFilename(code: string, language: string, index: number): string;
/**
 * Extract code blocks from content and save to files
 */
export declare const extract_code_blocks: ToolDefinition;
