import type { CriticDriftResult, CuratorConfig, CuratorPhaseResult, DriftReport } from './curator-types.js';
/**
 * Read all prior drift reports from .swarm/drift-report-phase-*.json files.
 * Returns reports sorted ascending by phase number.
 * Skips corrupt/unreadable files with a console.warn.
 */
export declare function readPriorDriftReports(directory: string): Promise<DriftReport[]>;
/**
 * Write a drift report to .swarm/drift-report-phase-{N}.json.
 * Creates .swarm/ if it doesn't exist.
 * Returns the absolute path of the written file.
 */
export declare function writeDriftReport(directory: string, report: DriftReport): Promise<string>;
export declare const _internals: {
    readPriorDriftReports: typeof readPriorDriftReports;
    writeDriftReport: typeof writeDriftReport;
    runDeterministicDriftCheck: typeof runDeterministicDriftCheck;
    buildDriftInjectionText: typeof buildDriftInjectionText;
};
/**
 * Deterministic drift check for the given phase.
 * Builds a structured DriftReport from curator data, plan, spec, and prior reports.
 * Writes the report to .swarm/drift-report-phase-N.json.
 * Emits 'curator.drift.completed' event on success.
 * On any error: emits 'curator.error' event and returns a safe default result.
 * NEVER throws — drift failures must not block phase_complete.
 */
export declare function runDeterministicDriftCheck(directory: string, phase: number, curatorResult: CuratorPhaseResult, config: CuratorConfig, injectAdvisory?: (message: string) => void): Promise<CriticDriftResult>;
/**
 * Build a truncated summary suitable for architect context injection.
 * Format: "<drift_report>Phase N: {alignment} ({drift_score}) — {key finding}. {correction if any}.</drift_report>"
 * Truncate to maxChars (simple slice). Tags may be broken when truncation occurs mid-tag.
 * If ALIGNED with drift_score < 0.1: minimal output "Phase N: ALIGNED, all requirements on track."
 * If MINOR_DRIFT or worse: include first_deviation and top correction.
 */
export declare function buildDriftInjectionText(report: DriftReport, maxChars: number): string;
