/**
 * Completion verification tool - deterministic pre-check verifying that plan task
 * identifiers exist in their target source files before phase completion.
 * Blocks if obviously incomplete.
 */
import type { ToolDefinition } from '@opencode-ai/plugin';
/**
 * Arguments for the completion_verify tool
 */
export interface CompletionVerifyArgs {
    /** The phase number to check */
    phase: number;
    /** Session ID (optional, auto-provided by plugin context) */
    sessionID?: string;
    /** Explicit project root directory override */
    working_directory?: string;
}
/**
 * Execute the completion verification check
 */
export declare function executeCompletionVerify(args: CompletionVerifyArgs, directory: string): Promise<string>;
/**
 * Tool definition for completion_verify
 */
export declare const completion_verify: ToolDefinition;
