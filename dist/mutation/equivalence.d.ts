import type { MutationPatch } from './engine.js';
/** Result of equivalence check for a single mutant */
export interface EquivalenceResult {
    patchId: string;
    isEquivalent: boolean;
    method: 'static' | 'llm_judge' | 'skipped';
    confidence: number;
    reason: string;
}
/** Callback signature for LLM judge — injected by caller */
export type LLMJudgeCallback = (original: string, mutated: string, context: string) => Promise<{
    isEquivalent: boolean;
    confidence: number;
    reason: string;
}>;
/**
 * Stage 1: Static equivalence filter.
 * Strips comments (single-line // and multi-line /* *\/), console.log/debugger statements,
 * trailing whitespace, and blank lines. Returns true if the stripped versions are identical.
 */
export declare function isStaticallyEquivalent(originalCode: string, mutatedCode: string): boolean;
export declare const _internals: {
    isStaticallyEquivalent: typeof isStaticallyEquivalent;
    checkEquivalence: typeof checkEquivalence;
    batchCheckEquivalence: typeof batchCheckEquivalence;
};
/**
 * Check a single mutant for equivalence using two-stage approach.
 * Stage 1: static analysis. Stage 2: LLM judge (if provided and Stage 1 didn't determine equivalence).
 */
export declare function checkEquivalence(patch: MutationPatch, originalCode: string, mutatedCode: string, llmJudge?: LLMJudgeCallback): Promise<EquivalenceResult>;
/**
 * Batch check multiple mutants for equivalence.
 * Returns results for all patches.
 */
export declare function batchCheckEquivalence(patches: Array<{
    patch: MutationPatch;
    originalCode: string;
    mutatedCode: string;
}>, llmJudge?: LLMJudgeCallback): Promise<EquivalenceResult[]>;
