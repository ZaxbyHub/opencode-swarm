import type { tool } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import type { EvidenceVerdict } from '../config/evidence-schema';
export interface SyntaxCheckInput {
    /** Files to check (from diff gate) */
    changed_files: Array<{
        path: string;
        additions: number;
    }>;
    /** Check mode: 'changed' = only changed files, 'all' = all files in repo */
    mode?: 'changed' | 'all';
    /** Optional: restrict to specific languages */
    languages?: string[];
}
export interface SyntaxCheckFileResult {
    path: string;
    language: string;
    ok: boolean;
    errors: Array<{
        line: number;
        column: number;
        message: string;
    }>;
    skipped_reason?: string;
}
export interface SyntaxCheckResult {
    verdict: EvidenceVerdict;
    files: SyntaxCheckFileResult[];
    summary: string;
}
/**
 * Run syntax check on changed files
 *
 * Respects config.gates.syntax_check.enabled - returns skipped if disabled
 */
export declare function syntaxCheck(input: SyntaxCheckInput, directory: string, config?: PluginConfig): Promise<SyntaxCheckResult>;
export declare const syntax_check: ReturnType<typeof tool>;
