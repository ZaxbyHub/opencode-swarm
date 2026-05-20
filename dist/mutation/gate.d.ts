import type { MutationReport, MutationResult } from './engine.js';
export type MutationGateVerdict = 'pass' | 'warn' | 'fail';
export interface MutationGateResult {
    verdict: MutationGateVerdict;
    killRate: number;
    adjustedKillRate: number;
    totalMutants: number;
    killed: number;
    survived: number;
    threshold: number;
    warnThreshold: number;
    message: string;
    /** Survived mutants that need test improvements */
    survivedMutants: MutationResult[];
    /** Prompt for targeted test improvement (non-empty when verdict is 'warn' or 'fail') */
    testImprovementPrompt: string;
}
export declare const _internals: {
    evaluateMutationGate: typeof evaluateMutationGate;
    buildTestImprovementPrompt: typeof buildTestImprovementPrompt;
    buildMessage: typeof buildMessage;
};
/** Default thresholds */
export declare const PASS_THRESHOLD = 0.8;
export declare const WARN_THRESHOLD = 0.6;
/**
 * Evaluate a mutation report against quality gate thresholds.
 * @param report - The mutation report to evaluate
 * @param passThreshold - Kill rate at or above this passes (default: 0.80)
 * @param warnThreshold - Kill rate at or above this warns (default: 0.60)
 * @returns MutationGateResult with verdict and details
 */
export declare function evaluateMutationGate(report: MutationReport, passThreshold?: number, warnThreshold?: number): MutationGateResult;
declare function buildTestImprovementPrompt(report: MutationReport, passThreshold: number, verdict: MutationGateVerdict): string;
declare function buildMessage(verdict: MutationGateVerdict, adjustedKillRate: number, killed: number, totalMutants: number, equivalent: number, warnThreshold: number): string;
export {};
