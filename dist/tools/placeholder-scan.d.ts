import type { tool } from '@opencode-ai/plugin';
import type { EvidenceVerdict } from '../config/evidence-schema';
export interface PlaceholderScanInput {
    changed_files: string[];
    allow_globs?: string[];
    deny_patterns?: string[];
}
export interface PlaceholderFinding {
    path: string;
    line: number;
    kind: 'comment' | 'string' | 'function_body' | 'other';
    excerpt: string;
    rule_id: string;
}
export interface PlaceholderScanResult {
    verdict: EvidenceVerdict;
    findings: PlaceholderFinding[];
    summary: {
        files_scanned: number;
        findings_count: number;
        files_with_findings: number;
    };
}
/**
 * Scan files for placeholder content (TODO/FIXME comments, stub implementations, etc.)
 */
export declare function placeholderScan(input: PlaceholderScanInput, directory: string): Promise<PlaceholderScanResult>;
export declare const placeholder_scan: ReturnType<typeof tool>;
