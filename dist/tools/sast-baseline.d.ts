/**
 * SAST Baseline — phase-scoped snapshot of pre-existing security findings.
 *
 * Enables baseline diffing so only NEW findings (introduced since baseline capture)
 * drive the fail verdict in subsequent sast_scan calls.
 *
 * Storage: .swarm/evidence/{phase}/sast-baseline.json
 *   Mirrors the phase-scoped convention used by write-drift-evidence.ts and
 *   write-hallucination-evidence.ts (path.join('evidence', String(phase), filename)
 *   passed to validateSwarmPath).
 *
 * Fingerprint format (stable):
 *   `${relFile}|${rule_id}|${sha256(3lineWindow).slice(0,16)}|#${occurrenceIndex}`
 *
 * Fingerprint format (unstable — file unreadable or path escapes workspace):
 *   `${relFile}|${rule_id}|L${line}|UNSTABLE|#${occurrenceIndex}`
 *   Unstable fingerprints are ALWAYS treated as NEW findings (fail-closed).
 *
 * Merge semantics:
 *   On every capture for a set of files, ALL prior fingerprints for those files
 *   are removed (full prune, engine-agnostic) before inserting current findings.
 *   This prevents stale cross-engine fingerprints from causing false-pass verdicts.
 */
import type { SastScanFinding } from './sast-scan';
export declare const BASELINE_SCHEMA_VERSION: "1.0.0";
/** Maximum findings to store in baseline (heuristic — open for tuning). */
export declare const MAX_BASELINE_FINDINGS = 2000;
export interface SastBaselineFile {
    schema_version: '1.0.0';
    phase: number;
    created_at: string;
    updated_at: string;
    engine: 'tier_a' | 'tier_a+tier_b';
    /** Canonical relative paths of files indexed into this baseline. */
    files_indexed: string[];
    /** Fingerprint strings for all indexed findings. */
    fingerprints: string[];
    /** Full findings snapshot (for auditing / debugging). */
    findings_snapshot: SastScanFinding[];
    /** True if the snapshot was truncated at MAX_BASELINE_FINDINGS. */
    truncated: boolean;
}
export type LoadBaselineResult = {
    status: 'found';
    fingerprints: Set<string>;
    bundle: SastBaselineFile;
} | {
    status: 'not_found';
} | {
    status: 'invalid_schema';
    errors: string[];
};
export interface FingerprintResult {
    fingerprint: string;
    /** False when the file was unreadable or the path escapes the workspace. */
    stable: boolean;
}
export interface IndexedFinding {
    finding: SastScanFinding;
    index: number;
    stable: boolean;
    fingerprint: string;
}
export type CaptureResult = {
    status: 'written';
    path: string;
    fingerprint_count: number;
} | {
    status: 'merged';
    path: string;
    fingerprint_count: number;
} | {
    status: 'error';
    message: string;
};
/**
 * Return the canonical relative path for a finding file.
 * Mirrors the normalization in pre-check-batch.ts classifySastFindings.
 */
export declare function normalizeFindingPath(directory: string, file: string): string;
/**
 * Compute a stable or unstable fingerprint for a single finding.
 *
 * Stable uses a 3-line content window (N-1, N, N+1) so the fingerprint
 * survives line-number shifts caused by insertions above the finding.
 *
 * Unstable is produced when the file cannot be read or the path escapes
 * the workspace — such findings are always classified NEW (fail-closed).
 */
export declare function fingerprintFinding(finding: SastScanFinding, directory: string, occurrenceIndex: number): FingerprintResult;
/**
 * Assign occurrence indices to a batch of findings.
 *
 * Two findings that produce the same (relFile, rule_id, contentHash) tuple
 * — e.g., copy-pasted vulnerable lines — receive different indices so they
 * get distinct fingerprints and can be individually classified.
 */
export declare function assignOccurrenceIndices(findings: SastScanFinding[], directory: string): IndexedFinding[];
/**
 * Capture or merge SAST findings into the phase-scoped baseline.
 *
 * Merge semantics:
 *   For every file in `scannedFiles`, ALL prior fingerprints for that file are
 *   removed from the baseline before inserting the current scan's fingerprints.
 *   This full-prune (engine-agnostic) prevents stale cross-engine entries from
 *   causing false-pass verdicts on later full-engine diff scans.
 *
 * Severity threshold:
 *   Callers MUST pass ALL findings regardless of severity threshold so the
 *   baseline captures the full pre-existing surface. Threshold filtering is
 *   the diff caller's responsibility.
 *
 * Idempotency:
 *   Calling twice with identical inputs produces an identical baseline file.
 *   Calling with a new file set adds/replaces only those files' fingerprints.
 */
export declare function captureOrMergeBaseline(directory: string, phase: number, findings: SastScanFinding[], engine: 'tier_a' | 'tier_a+tier_b', scannedFiles: string[], opts?: {
    force?: boolean;
}): Promise<CaptureResult>;
/**
 * Load the SAST baseline for a given phase.
 *
 * Returns 'not_found' when no baseline file exists (first run for phase).
 * Returns 'invalid_schema' when the file is present but unparseable.
 */
export declare function loadBaseline(directory: string, phase: number): LoadBaselineResult;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    fingerprintFinding: typeof fingerprintFinding;
    assignOccurrenceIndices: typeof assignOccurrenceIndices;
    captureOrMergeBaseline: typeof captureOrMergeBaseline;
    loadBaseline: typeof loadBaseline;
};
