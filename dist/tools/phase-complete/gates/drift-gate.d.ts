/**
 * Gate 2 – Drift Verifier.
 * Conditional on drift_check QA gate.  Blocks when drift evidence is missing
 * (when spec.md exists) or when the verdict is rejected.
 */
import type { GateContext, GateResult } from './types';
export declare function runDriftGate(ctx: GateContext): Promise<GateResult>;
