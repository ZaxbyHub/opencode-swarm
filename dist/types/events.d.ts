/**
 * v6.19.0 JSONL Event Types
 * Event interfaces for the prompt-quality and adversarial robustness update
 */
export interface SoundingBoardConsultedEvent {
    type: 'sounding_board_consulted';
    timestamp: string;
    architectQuery: string;
    criticVerdict: 'UNNECESSARY' | 'REPHRASE' | 'APPROVED' | 'RESOLVE';
    phase: number;
    taskId?: string;
}
export interface ArchitectLoopDetectedEvent {
    type: 'architect_loop_detected';
    timestamp: string;
    impasseDescription: string;
    occurrenceCount: number;
    phase: number;
    taskId?: string;
}
export interface PrecedentManipulationDetectedEvent {
    type: 'precedent_manipulation_detected';
    timestamp: string;
    pattern: 'PRECEDENT_MANIPULATION';
    severity: 'HIGHEST';
    detectedIn: string;
    phase: number;
    taskId?: string;
}
export interface CoderSelfAuditEvent {
    type: 'coder_self_audit';
    timestamp: string;
    taskId: string;
    filesModified: string[];
    checklistResults: {
        filesMatchSpec: boolean;
        noExtraFunctionality: boolean;
        noSkippedAcceptanceCriteria: boolean;
        didNotRunTests: boolean;
        syntaxCheckPassed: boolean;
    };
    meta: {
        summary: string;
    };
}
export interface CoderRetryCircuitBreakerEvent {
    type: 'coder_retry_circuit_breaker';
    timestamp: string;
    taskId: string;
    rejectionCount: number;
    rejectionHistory: string[];
    phase: number;
    action: 'sounding_board_consultation' | 'simplification' | 'user_escalation';
}
export interface AgentConflictDetectedEvent {
    type: 'agent_conflict_detected';
    timestamp: string;
    sessionId: string;
    phase: number;
    taskId?: string;
    sourceAgent: 'architect' | 'coder' | 'reviewer' | 'critic' | 'test_engineer';
    targetAgent: 'architect' | 'coder' | 'reviewer' | 'critic' | 'test_engineer';
    conflictType: 'feedback_rejection' | 'authority_collision' | 'retry_spiral' | 'scope_disagreement' | 'quality_gate_dispute';
    resolutionPath: 'self_resolve' | 'soundingboard' | 'simplification' | 'sme_consult' | 'user_escalation';
    summary: string;
}
export interface AuthorityHandoffResolvedEvent {
    type: 'authority_handoff_resolved';
    timestamp: string;
    sessionId: string;
    previousAgent: string;
    newAgent: string;
    reason: 'task_complete' | 'stale_delegation' | 'conflict_escalation' | 'manual_reset';
}
export interface SpecStaleDetectedEvent {
    type: 'spec_stale_detected';
    timestamp: string;
    phase: number;
    specHash_plan: string;
    specHash_current: string | null;
    reason: string;
    planTitle: string;
}
export interface SpecDriftAcknowledgedEvent {
    type: 'spec_drift_acknowledged';
    timestamp: string;
    phase: number;
    planTitle: string;
    acknowledgedBy: string;
    previousHash: string;
    newHash: string | null;
}
/**
 * Emitted whenever savePlan removes one or more tasks from the prior plan
 * (issue #853). Audit-only — replayFromLedger does not mutate plan state on
 * this event. The `reason` describes why the task was removed; `source`
 * identifies the caller (e.g. 'save_plan_tool', 'phase_complete_rebuild_from_ledger').
 */
export interface TaskRemovedEvent {
    type: 'task_removed';
    timestamp: string;
    task_id: string;
    phase_id: number;
    from_status: string;
    source: string;
    reason: string;
}
export interface PrmPatternDetectedEvent {
    type: 'prm_pattern_detected';
    timestamp: string;
    sessionId: string;
    pattern: string;
    severity: string;
    category: string;
    stepRange: [number, number];
}
export interface PrmCourseCorrectionInjectedEvent {
    type: 'prm_course_correction_injected';
    timestamp: string;
    sessionId: string;
    pattern: string;
    level: number;
}
export interface PrmEscalationTriggeredEvent {
    type: 'prm_escalation_triggered';
    timestamp: string;
    sessionId: string;
    pattern: string;
    level: number;
    occurrenceCount: number;
}
export interface PrmHardStopEvent {
    type: 'prm_hard_stop';
    timestamp: string;
    sessionId: string;
    pattern: string;
    level: number;
    occurrenceCount: number;
}
export type V619Event = SoundingBoardConsultedEvent | ArchitectLoopDetectedEvent | PrecedentManipulationDetectedEvent | CoderSelfAuditEvent | CoderRetryCircuitBreakerEvent | AgentConflictDetectedEvent | AuthorityHandoffResolvedEvent | SpecStaleDetectedEvent | SpecDriftAcknowledgedEvent | PrmPatternDetectedEvent | PrmCourseCorrectionInjectedEvent | PrmEscalationTriggeredEvent | PrmHardStopEvent;
