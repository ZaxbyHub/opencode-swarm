/**
 * Gate 1 – Completion Verify (deterministic, in-process).
 * Blocks when executeCompletionVerify returns status === 'blocked'.
 */
import type { GateContext, GateResult } from './types';
export declare function runCompletionVerifyGate(ctx: GateContext): Promise<GateResult>;
