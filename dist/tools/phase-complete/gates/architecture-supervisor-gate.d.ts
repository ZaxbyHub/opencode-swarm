/**
 * Gate 5b – Architecture Supervision (issue #893).
 * Opt-in, gate mode only.  Reads the raw supervisor sidecar and blocks on a
 * missing/invalid/stale/REJECT verdict.  Unlike Gates 1–5 this gate is NOT
 * turbo-bypassed — enabling mode:'gate' is an explicit opt-in to a hard
 * cross-task coherence check.
 */
import type { GateContext, GateResult } from './types';
export declare function runArchitectureSupervisorGate(ctx: GateContext): Promise<GateResult>;
