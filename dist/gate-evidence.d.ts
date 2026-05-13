/**
 * Gate Evidence Store
 *
 * Durable, task-scoped evidence for QA gate completion.
 * Evidence is recorded on disk (.swarm/evidence/{taskId}.json) by the
 * delegation-gate toolAfter hook and read by checkReviewerGate at
 * update_task_status(completed) time.
 *
 * Evidence files survive session restarts (unlike in-memory state).
 * Agents never write these files directly — only the hook does.
 * Gates are append-only: required_gates can only grow, never shrink.
 */
export interface GateEvidence {
    sessionId: string;
    timestamp: string;
    agent: string;
}
export interface TaskEvidence {
    taskId: string;
    required_gates: string[];
    gates: Record<string, GateEvidence>;
    turbo?: boolean;
}
export declare const DEFAULT_REQUIRED_GATES: string[];
/**
 * Canonical task-id validation helper.
 * Delegates to the shared strict validator (#452 item 2).
 * Re-exported for backward compatibility with existing callers.
 */
export declare function isValidTaskId(taskId: string): boolean;
/**
 * Maps the first-dispatched agent type to the initial required_gates array.
 * Unknown agent types fall back to the safe default ["reviewer", "test_engineer"].
 */
export declare function deriveRequiredGates(agentType: string): string[];
/**
 * Returns the union of existingGates and deriveRequiredGates(newAgentType).
 * Sorted, deduplicated. Gates can only grow, never shrink.
 */
export declare function expandRequiredGates(existingGates: string[], newAgentType: string): string[];
/**
 * Creates or updates .swarm/evidence/{taskId}.json with a gate pass entry.
 * If file doesn't exist: creates with required_gates from deriveRequiredGates(gate).
 * If file exists: merges gate entry, expands required_gates via expandRequiredGates.
 * Atomic write: temp file + rename.
 */
export declare function recordGateEvidence(directory: string, taskId: string, gate: string, sessionId: string, turbo?: boolean): Promise<void>;
/**
 * Sets or expands required_gates WITHOUT recording a gate pass.
 * Used when non-gate agents are dispatched (coder, explorer, sme, etc.).
 * Creates evidence file if it doesn't exist yet.
 */
export declare function recordAgentDispatch(directory: string, taskId: string, agentType: string, turbo?: boolean): Promise<void>;
/**
 * Returns the TaskEvidence for a task, or null if file missing or parse error.
 * Never throws.
 */
export declare function readTaskEvidence(directory: string, taskId: string): Promise<TaskEvidence | null>;
/**
 * Returns the TaskEvidence for a task, or null if the file does not exist (ENOENT).
 * Throws on malformed JSON, permission errors, or other non-ENOENT issues.
 * Used by checkReviewerGate for evidence-first gate checking with proper error handling.
 */
export declare function readTaskEvidenceRaw(directory: string, taskId: string): TaskEvidence | null;
/**
 * Returns true only when every required_gate has a matching gates entry.
 * Returns false if no evidence file exists.
 */
export declare function hasPassedAllGates(directory: string, taskId: string): Promise<boolean>;
