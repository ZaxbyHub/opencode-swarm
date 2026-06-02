/**
 * Gate 4 – Mutation Gate.
 * Conditional on mutation_test QA gate flag.
 */
import type { GateContext, GateResult } from './types';
export declare function runMutationGate(ctx: GateContext): Promise<GateResult>;
