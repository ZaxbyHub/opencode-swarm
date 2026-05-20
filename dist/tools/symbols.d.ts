import type { ToolDefinition } from '@opencode-ai/plugin/tool';
interface SymbolInfo {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'variable' | 'method' | 'property';
    exported: boolean;
    signature: string;
    line: number;
    jsdoc?: string;
}
/**
 * Extract symbols from a TypeScript/JavaScript file using regex-based parsing.
 * Handles: export function, export const, export class, export interface,
 * export type, export enum, export default, and class members.
 */
export declare function extractTSSymbols(filePath: string, cwd: string): SymbolInfo[];
/**
 * Extract symbols from a Python file.
 */
export declare function extractPythonSymbols(filePath: string, cwd: string): SymbolInfo[];
export declare const symbols: ToolDefinition;
export {};
