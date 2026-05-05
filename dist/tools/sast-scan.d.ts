/**
 * SAST Scan Tool - Static Application Security Testing
 * Integrates Tier A rules (offline) and optional Semgrep (Tier B)
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import type { PluginConfig } from '../config';
import type { EvidenceVerdict } from '../config/evidence-schema';
export interface SastScanInput {
    /** List of files to scan */
    changed_files: string[];
    /** Minimum severity that causes failure (default: 'medium') */
    severity_threshold?: 'low' | 'medium' | 'high' | 'critical';
    /**
     * When true, capture/merge a phase-scoped baseline snapshot and return
     * status:'baseline_captured'. Subsequent scans with the same phase will
     * diff against this baseline so only NEW findings drive the fail verdict.
     *
     * Capture mode ignores severity_threshold — all severities are recorded.
     * Requires `phase` to be provided.
     */
    capture_baseline?: boolean;
    /**
     * Current phase number (positive integer, >= 1). Required when
     * capture_baseline is true. When provided without capture_baseline, enables
     * baseline diff mode: only findings absent from the phase baseline fail.
     */
    phase?: number;
}
export interface SastScanResult {
    /** Overall verdict: pass if no findings above threshold, fail otherwise */
    verdict: EvidenceVerdict;
    /** Array of security findings */
    findings: SastScanFinding[];
    /** Summary information */
    summary: {
        /** Engine used for scanning */
        engine: 'tier_a' | 'tier_a+tier_b';
        /** Number of files scanned */
        files_scanned: number;
        /** Total number of findings */
        findings_count: number;
        /** Breakdown of findings by severity */
        findings_by_severity: {
            critical: number;
            high: number;
            medium: number;
            low: number;
        };
    };
    /** 'baseline_captured' when capture_baseline:true succeeded */
    status?: 'baseline_captured' | 'baseline_merged';
    /** Number of findings recorded in the baseline (capture mode only) */
    finding_count?: number;
    /** Findings NOT present in the baseline (diff mode only) */
    new_findings?: SastScanFinding[];
    /** Findings that match the baseline (diff mode only) */
    pre_existing_findings?: SastScanFinding[];
    /** True when a baseline was loaded and diff mode was active */
    baseline_used?: boolean;
    /** True when pre_existing_findings were truncated to fit result limits */
    truncated_pre_existing?: boolean;
}
export interface SastScanFinding {
    rule_id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    message: string;
    location: {
        file: string;
        line: number;
        column?: number;
    };
    remediation?: string;
}
/**
 * SAST Scan tool - Static Application Security Testing
 * Scans changed files for security vulnerabilities using:
 * - Tier A: Built-in pattern-based rules (always runs)
 * - Tier B: Semgrep (optional, if available on PATH)
 */
export declare function sastScan(input: SastScanInput, directory: string, config?: PluginConfig): Promise<SastScanResult>;
/**
 * SAST Scan tool - Static Application Security Testing
 * Scans changed files for security vulnerabilities using:
 * - Tier A: Built-in pattern-based rules (always runs)
 * - Tier B: Semgrep (optional, if available on PATH)
 */
export declare const sast_scan: ToolDefinition;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    sastScan: typeof sastScan;
    sast_scan: typeof sast_scan;
};
