/**
 * Declare scope tool for setting the file scope for coder delegations.
 * Implements FR-010: Declare coder scope before delegation.
 * This tool must be called before delegating to coder to enable scope containment checking.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the declare_scope tool
 */
export interface DeclareScopeArgs {
    taskId: string;
    files: string[];
    whitelist?: string[];
    working_directory?: string;
}
/**
 * Result from executing declare_scope
 */
export interface DeclareScopeResult {
    success: boolean;
    message: string;
    taskId?: string;
    fileCount?: number;
    errors?: string[];
    warnings?: string[];
}
/**
 * Validate that taskId matches the required format (N.M or N.M.P).
 * @param taskId - The task ID to validate
 * @returns Error message if invalid, undefined if valid
 */
export declare function validateTaskIdFormat(taskId: string): string | undefined;
/**
 * Validate file entries for security concerns.
 * @param files - Array of file paths to validate
 * @returns Array of error messages, empty if all valid
 */
export declare function validateFiles(files: string[]): string[];
/**
 * Execute the declare_scope tool.
 * Validates the taskId and files, then sets the declared scope on all active architect sessions.
 * @param args - The declare scope arguments
 * @param fallbackDir - Fallback directory for plan lookup
 * @returns DeclareScopeResult with success status and details
 */
export declare function executeDeclareScope(args: DeclareScopeArgs, fallbackDir?: string): Promise<DeclareScopeResult>;
/**
 * Tool definition for declare_scope
 */
export declare const declare_scope: ToolDefinition;
