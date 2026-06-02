/**
 * Gate 6 – Final Council.
 * Conditional on final_council QA gate flag.  Only fires after the LAST
 * phase completes — not after intermediate phases.
 */
import type { GateContext, GateResult } from './types';
export declare function runFinalCouncilGate(ctx: GateContext): Promise<GateResult>;
