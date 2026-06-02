/**
 * Shared types for phase-complete gate modules.
 */
/**
 * Result returned by every gate function.
 * - blocked === true  → phase_complete must return an error result immediately.
 * - blocked === false → gate passed; warnings may be accumulated in the gate's
 *                       local warnings list (the orchestrator appends them to the
 *                       shared warnings array after the call).
 */
export interface GateResult {
    blocked: boolean;
    reason?: string;
    message?: string;
    agentsDispatched: string[];
    agentsMissing: string[];
    warnings: string[];
    /** Optional extra fields that some gates add to the return value */
    [key: string]: unknown;
}
/**
 * Context passed to every gate function.  These are the values that are already
 * available at the call site in executePhaseComplete and do not need to be
 * re-computed inside each gate.
 */
export interface GateContext {
    /** Phase number being completed */
    phase: number;
    /** Resolved project root (the `.swarm/` parent directory) */
    dir: string;
    /** Caller session ID (may be undefined in edge cases) */
    sessionID: string | undefined;
    /** Already-loaded plugin config */
    pluginConfig: import('../../../config/schema').PluginConfig;
    /** Agents already dispatched (cross-session aggregated) */
    agentsDispatched: string[];
    /** Non-blocking warning helper */
    safeWarn: (message: string, error: unknown) => void;
}
