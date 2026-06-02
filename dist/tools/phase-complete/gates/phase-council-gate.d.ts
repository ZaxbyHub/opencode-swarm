/**
 * Gate 5 – Phase Council.
 * Conditional on council_mode QA gate flag.
 */
import type { GateContext, GateResult } from './types';
export declare function runPhaseCouncilGate(ctx: GateContext): Promise<GateResult>;
