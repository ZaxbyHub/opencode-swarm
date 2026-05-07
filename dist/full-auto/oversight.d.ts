export interface FullAutoCriticResult {
    verdict: string;
    reasoning: string;
    evidenceChecked: string[];
    antiPatternsDetected: string[];
    escalationNeeded: boolean;
    rawResponse: string;
}
export type FullAutoTriggerSource = 'text_pattern' | 'tool_action' | 'cadence' | 'subagent_return' | 'phase_boundary' | 'task_completion' | 'risk';
export interface FullAutoOversightEvent {
    type: 'full_auto_oversight';
    timestamp: string;
    session_id: string;
    plan_id?: string;
    phase?: number;
    task_id?: string;
    trigger_source: FullAutoTriggerSource;
    trigger_reason: string;
    critic_agent: string;
    critic_model: string;
    architect_model?: string;
    verdict: string;
    reasoning: string;
    evidence_checked: string[];
    anti_patterns_detected: string[];
    escalation_needed: boolean;
    decision: string;
    full_auto_status_before?: string;
    full_auto_status_after?: string;
    oversight_sequence: number;
}
export interface DispatchFullAutoOversightInput {
    directory: string;
    sessionID: string;
    trigger: string;
    triggerSource: FullAutoTriggerSource;
    phase?: number;
    taskID?: string;
    planID?: string;
    architectOutput?: string;
    actionContext?: Record<string, unknown>;
    criticModel: string;
    oversightAgentName: string;
    architectModel?: string;
    /**
     * Optional Full-Auto config slice. Used to honor `fail_closed` semantics
     * when oversight event/evidence persistence fails (TASK 6). When
     * omitted, the dispatcher defaults to `fail_closed = true`.
     */
    fullAutoConfig?: {
        fail_closed?: boolean;
    };
}
export declare function parseFullAutoCriticResponse(rawResponse: string): FullAutoCriticResult;
/**
 * Append a Full-Auto oversight event to `.swarm/events.jsonl`.
 *
 * TASK 6: persistence failures MUST propagate. When fail_closed is the
 * active policy (the default), an oversight verdict that cannot be
 * durably audited is not a real verdict — the dispatcher converts the
 * thrown error into a BLOCKED/pause outcome.
 *
 * The lock acquisition is best-effort (some platforms / test sandboxes
 * cannot acquire the cross-process lock); the actual append is the
 * mandatory step and any failure throws.
 */
export declare function writeFullAutoOversightEvent(directory: string, event: FullAutoOversightEvent): Promise<void>;
/**
 * Persist Full-Auto oversight evidence to `.swarm/evidence/{phase}/full-auto-{seq}.json`.
 *
 * TASK 6: persistence failures MUST propagate. For phase_boundary
 * triggers the evidence write is MANDATORY because phase_complete will
 * later block on the absence of an APPROVED record. The dispatcher
 * converts a thrown error into a BLOCKED/pause outcome under
 * fail_closed = true.
 *
 * Returns `undefined` only when `phase` is undefined (no evidence to
 * write because the trigger isn't phase-scoped). All other failures
 * throw.
 */
export declare function writeFullAutoOversightEvidence(directory: string, phase: number | undefined, event: FullAutoOversightEvent): Promise<string | undefined>;
export interface FullAutoOversightOutcome extends FullAutoCriticResult {
    decision: 'allow' | 'deny' | 'pause' | 'escalate_human' | 'pending';
    event: FullAutoOversightEvent;
    evidencePath?: string;
}
export declare function dispatchFullAutoOversight(input: DispatchFullAutoOversightInput): Promise<FullAutoOversightOutcome>;
/**
 * Test-only DI seam.
 */
export declare const _internals: {
    resetSequence: () => void;
};
