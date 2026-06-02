/**
 * Gate 3 – Hallucination Guard.
 * Conditional on hallucination_guard QA gate flag.
 */
import type { GateContext, GateResult } from './types';
export declare function runHallucinationGate(ctx: GateContext): Promise<GateResult>;
