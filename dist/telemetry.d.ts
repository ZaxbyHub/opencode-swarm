export type TelemetryEvent = 'session_started' | 'session_ended' | 'agent_activated' | 'delegation_begin' | 'delegation_end' | 'task_state_changed' | 'gate_passed' | 'gate_failed' | 'phase_changed' | 'budget_updated' | 'model_fallback' | 'hard_limit_hit' | 'revision_limit_hit' | 'loop_detected' | 'scope_violation' | 'qa_skip_violation' | 'heartbeat' | 'turbo_mode_changed' | 'auto_oversight_escalation' | 'environment_detected' | 'evidence_lock_acquired' | 'evidence_lock_contended' | 'evidence_lock_stale_recovered' | 'plan_ledger_cas_retry' | 'plan_md_write_failed' | 'prm_pattern_detected' | 'prm_course_correction_injected' | 'prm_escalation_triggered' | 'prm_hard_stop';
export type TelemetryListener = (event: TelemetryEvent, data: Record<string, unknown>) => void;
/** @internal - For testing only */
export declare function resetTelemetryForTesting(): void;
/**
 * Initialize telemetry with the project directory.
 * Creates `.swarm/` if it doesn't exist and opens `telemetry.jsonl` for appending.
 * Idempotent — calling multiple times has no effect after the first successful call.
 * @param projectDirectory - Absolute path to the project root
 */
export declare function initTelemetry(projectDirectory: string): void;
/**
 * Emit a telemetry event.
 * Writes a JSONL line to `.swarm/telemetry.jsonl` and notifies all registered listeners.
 * Fire-and-forget — errors are silently swallowed and never propagate to the caller.
 * @param event - The event type
 * @param data - Arbitrary event payload (sessionId always required by convention)
 */
export declare function emit(event: TelemetryEvent, data: Record<string, unknown>): void;
/**
 * Register a listener for telemetry events.
 * Listeners receive every event that is emitted (if telemetry is not disabled).
 * Listener errors are silently swallowed — they never break execution.
 * @param callback - Function called with (event, data) on each emit
 */
export declare function addTelemetryListener(callback: TelemetryListener): void;
/**
 * Rotate telemetry file if it exceeds maxBytes.
 * Renames `telemetry.jsonl` → `telemetry.jsonl.1` and reopens a fresh stream.
 * Errors are silently swallowed.
 * @param maxBytes - Size threshold in bytes (default: 10MB)
 */
export declare function rotateTelemetryIfNeeded(maxBytes?: number): void;
export declare const telemetry: {
    sessionStarted(sessionId: string, agentName: string): void;
    sessionEnded(sessionId: string, reason: string): void;
    agentActivated(sessionId: string, agentName: string, oldName?: string): void;
    delegationBegin(sessionId: string, agentName: string, taskId: string): void;
    delegationEnd(sessionId: string, agentName: string, taskId: string, result: string): void;
    taskStateChanged(sessionId: string, taskId: string, newState: string, oldState?: string): void;
    gatePassed(sessionId: string, gate: string, taskId: string): void;
    gateFailed(sessionId: string, gate: string, taskId: string, reason: string): void;
    phaseChanged(sessionId: string, oldPhase: number, newPhase: number): void;
    budgetUpdated(sessionId: string, budgetPct: number, agentName: string): void;
    modelFallback(sessionId: string, agentName: string, fromModel: string, toModel: string, reason: string): void;
    hardLimitHit(sessionId: string, agentName: string, limitType: string, value: number): void;
    revisionLimitHit(sessionId: string, agentName: string): void;
    loopDetected(sessionId: string, agentName: string, loopType: string): void;
    scopeViolation(sessionId: string, agentName: string, file: string, reason: string): void;
    qaSkipViolation(sessionId: string, agentName: string, skipCount: number): void;
    heartbeat(sessionId: string): void;
    turboModeChanged(sessionId: string, enabled: boolean, agentName: string): void;
    autoOversightEscalation(sessionId: string, reason: string, interactionCount: number, deadlockCount: number, phase?: number): void;
    environmentDetected(sessionId: string, hostOS: string, shellFamily: string, executionMode: string): void;
    prmPatternDetected(sessionId: string, pattern: string, severity: string, category: string, stepRange: [number, number]): void;
    prmCourseCorrectionInjected(sessionId: string, pattern: string, level: number): void;
    prmEscalationTriggered(sessionId: string, pattern: string, level: number, occurrenceCount: number): void;
    prmHardStop(sessionId: string, pattern: string, level: number, occurrenceCount: number): void;
};
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.telemetry` and `_internals.emit` so tests can replace the
 * underlying implementations without using `mock.module` — `mock.module` from
 * `bun:test` leaks across files in Bun's shared test-runner process, which
 * would corrupt unrelated test suites. Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    telemetry: typeof telemetry;
    emit: typeof emit;
};
