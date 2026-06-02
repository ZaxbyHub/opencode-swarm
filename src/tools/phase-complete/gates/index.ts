/**
 * Gate modules for phase_complete — each gate is a pure function that
 * receives a GateContext and returns a GateResult.
 */

export { runArchitectureSupervisorGate } from './architecture-supervisor-gate.js';
export { runCompletionVerifyGate } from './completion-verify-gate.js';
export { runDriftGate } from './drift-gate.js';
export { runFinalCouncilGate } from './final-council-gate.js';
export { runHallucinationGate } from './hallucination-gate.js';
export { runMutationGate } from './mutation-gate.js';
export { runPhaseCouncilGate } from './phase-council-gate.js';

export type { GateContext, GateResult } from './types.js';
