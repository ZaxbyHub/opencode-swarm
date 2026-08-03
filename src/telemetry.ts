import * as fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DelegationCostFields } from './services/cost-accounting.js';

// ============================================================================
// Types
// ============================================================================

export type TelemetryEvent =
	| 'session_started'
	| 'session_ended'
	| 'agent_activated'
	| 'delegation_begin'
	| 'delegation_end'
	| 'task_state_changed'
	| 'gate_passed'
	| 'gate_failed'
	| 'gate_parse_error'
	| 'reviewer_gate_decision'
	| 'phase_changed'
	| 'budget_updated'
	| 'model_fallback'
	| 'hard_limit_hit'
	| 'revision_limit_hit'
	| 'loop_detected'
	| 'scope_violation'
	| 'qa_skip_violation'
	| 'heartbeat'
	| 'turbo_mode_changed'
	| 'auto_oversight_escalation'
	| 'environment_detected'
	// PR 1 parallelization foundation events (dark — emitted but no live parallel paths)
	| 'evidence_lock_acquired'
	| 'evidence_lock_contended'
	| 'evidence_lock_stale_recovered'
	| 'plan_ledger_cas_retry'
	| 'plan_md_write_failed'
	| 'snapshot_failed' // FR-004: emitted when snapshot write exhausts retries
	// PRM events
	| 'prm_pattern_detected'
	| 'prm_course_correction_injected'
	| 'prm_escalation_triggered'
	| 'prm_hard_stop';

/** Stable classification for how a reviewer-gate decision was established. */
export type ReviewerGateEvidenceKind =
	| 'genuine'
	| 'fallback'
	| 'data_quality'
	| 'block';

/**
 * Stable reason codes for reviewer-gate decision telemetry.
 *
 * These values are persisted in telemetry.jsonl and consumed by offline gate
 * analytics, so additions are allowed but existing values must not be renamed.
 */
export type ReviewerGateReasonCode =
	| 'lean_turbo_completed_lane'
	| 'standard_turbo_non_tier3'
	| 'durable_evidence_complete'
	| 'workflow_state_complete'
	| 'stage_b_parallel_complete'
	| 'no_active_sessions'
	| 'zero_valid_sessions'
	| 'restart_recovery_complete'
	| 'scoped_delegation_complete'
	| 'unscoped_delegation_complete'
	| 'corrupt_evidence'
	| 'required_gates_missing'
	| 'inspection_error';

export type TelemetryListener = (
	event: TelemetryEvent,
	data: Record<string, unknown>,
) => void;

// ============================================================================
// Internal State
// ============================================================================

let _writeStream: ReturnType<typeof createWriteStream> | null = null;
let _projectDirectory: string | null = null;
const _listeners: TelemetryListener[] = [];
let _disabled: boolean = false;

// ── Heartbeat tracking (FR-010) ───────────────────────────────────
// Production listener captures latest heartbeat timestamp per sessionId.
// Used by /swarm status to render "Last activity: Xs ago".
let _heartbeatTrackingActive = false;
let _heartbeatListener: TelemetryListener | null = null;
const heartbeatTimestamps = new Map<string, number>();

function capHeartbeatMap(): void {
	// Cap at 500 entries (matches _heartbeatTimers pattern in src/index.ts).
	while (heartbeatTimestamps.size >= 500) {
		const oldestKey = heartbeatTimestamps.keys().next().value;
		if (oldestKey === undefined) break;
		heartbeatTimestamps.delete(oldestKey);
	}
}

export function startHeartbeatTracking(): void {
	if (_heartbeatTrackingActive) return;
	_heartbeatTrackingActive = true;
	// Track the listener reference so stopHeartbeatTracking can remove it.
	// addTelemetryListener is push-only with no return disposer; without
	// tracking here, repeated start/stop cycles would leak listeners on _listeners.
	const listener: TelemetryListener = (event, data) => {
		if (event !== 'heartbeat') return;
		const payload = data as { sessionId?: string } | undefined;
		if (!payload?.sessionId) return;
		heartbeatTimestamps.set(payload.sessionId, Date.now());
		capHeartbeatMap();
	};
	_heartbeatListener = listener;
	addTelemetryListener(listener);
}

export function getLastHeartbeat(sessionId: string): number | undefined {
	return heartbeatTimestamps.get(sessionId);
}

export function stopHeartbeatTracking(): void {
	_heartbeatTrackingActive = false;
	// Remove the previously-registered listener to prevent accumulation on
	// repeated start/stop cycles. _listeners.filter preserves the registration
	// order of unrelated listeners.
	if (_heartbeatListener !== null) {
		const idx = _listeners.indexOf(_heartbeatListener);
		if (idx >= 0) _listeners.splice(idx, 1);
		_heartbeatListener = null;
	}
}

export function resetHeartbeatTrackingForTesting(): void {
	_heartbeatTrackingActive = false;
	heartbeatTimestamps.clear();
	// Drain any heartbeat listener from _listeners so the next test starts
	// from a clean slate. Without this, listener accumulation would skew
	// listener-count assertions in the test suite.
	if (_heartbeatListener !== null) {
		const idx = _listeners.indexOf(_heartbeatListener);
		if (idx >= 0) _listeners.splice(idx, 1);
		_heartbeatListener = null;
	}
}

/**
 * Emit counter for rotation throttling. Rotation is checked every
 * `ROTATION_CHECK_INTERVAL` emits so the hot path never pays a `statSync`
 * on every call — satisfying the "no per-tool-call hot-path cost" contract.
 */
let _emitCount = 0;

/**
 * Number of emits between rotation checks. 50 keeps the overhead at one
 * `statSync` per 50 telemetry writes (~once per few seconds in a busy
 * session, roughly once per minute in a quiet one).
 */
export const ROTATION_CHECK_INTERVAL = 50;

/** @internal - For testing only */
export function resetTelemetryForTesting(): void {
	_disabled = false;
	_projectDirectory = null;
	_listeners.length = 0;
	_emitCount = 0;
	resetHeartbeatTrackingForTesting();
	if (_writeStream !== null) {
		_writeStream.end();
		_writeStream = null;
	}
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Initialize telemetry with the project directory.
 * Creates `.swarm/` if it doesn't exist and opens `telemetry.jsonl` for appending.
 * Idempotent — calling multiple times has no effect after the first successful call.
 * @param projectDirectory - Absolute path to the project root
 */
export function initTelemetry(projectDirectory: string): void {
	if (_writeStream !== null || _disabled) {
		return;
	}

	try {
		_projectDirectory = projectDirectory;
		const swarmDir = path.join(projectDirectory, '.swarm');

		if (!fs.existsSync(swarmDir)) {
			fs.mkdirSync(swarmDir, { recursive: true });
		}

		const telemetryPath = path.join(swarmDir, 'telemetry.jsonl');
		const stream = createWriteStream(telemetryPath, { flags: 'a' });

		// Guard on stream identity: a stale stream that was already replaced (by
		// rotation) or ended (by resetTelemetryForTesting) must NOT clobber the
		// currently-active stream's state when it emits a late 'error' — otherwise
		// one dead stream permanently disables telemetry for the live one.
		stream.on('error', () => {
			if (_writeStream === stream) {
				_disabled = true;
				_writeStream = null;
			}
		});

		_writeStream = stream;
	} catch {
		_disabled = true;
		_writeStream = null;
	}
}

/**
 * Emit a telemetry event.
 * Writes a JSONL line to `.swarm/telemetry.jsonl` and notifies all registered listeners.
 * Fire-and-forget — errors are silently swallowed and never propagate to the caller.
 * @param event - The event type
 * @param data - Arbitrary event payload (sessionId always required by convention)
 */
export function emit(
	event: TelemetryEvent,
	data: Record<string, unknown>,
): void {
	try {
		if (_disabled || _writeStream === null) {
			return;
		}

		const line =
			JSON.stringify({
				timestamp: new Date().toISOString(),
				event,
				...data,
			}) + os.EOL;

		const stream = _writeStream;
		stream.write(line, (err) => {
			// Only disable on write error if this is still the active stream.
			if (err && _writeStream === stream) {
				_disabled = true;
				_writeStream = null;
			}
		});

		for (const listener of _listeners) {
			try {
				listener(event, data);
			} catch {
				// Listener errors must NOT propagate
			}
		}

		// Throttled rotation check — only every ROTATION_CHECK_INTERVAL emits,
		// so the hot path pays a single integer increment per call and the
		// statSync only fires occasionally. rotateTelemetryIfNeeded is safe
		// to call opportunistically: it guards on size and swallows errors.
		_emitCount++;
		if (_emitCount >= ROTATION_CHECK_INTERVAL) {
			_emitCount = 0;
			_internals.rotateTelemetryIfNeeded();
		}
	} catch {
		// emit() must never throw to the caller
	}
}

/**
 * Register a listener for telemetry events.
 * Listeners receive every event that is emitted (if telemetry is not disabled).
 * Listener errors are silently swallowed — they never break execution.
 * @param callback - Function called with (event, data) on each emit
 */
export function addTelemetryListener(callback: TelemetryListener): void {
	_listeners.push(callback);
}

/**
 * Rotate telemetry file if it exceeds maxBytes.
 * Renames `telemetry.jsonl` → `telemetry.jsonl.1` and reopens a fresh stream.
 * Errors are silently swallowed.
 * @param maxBytes - Size threshold in bytes (default: 10MB)
 */
export function rotateTelemetryIfNeeded(
	maxBytes: number = 10 * 1024 * 1024,
): void {
	try {
		if (_projectDirectory === null) {
			return;
		}

		const telemetryPath = path.join(
			_projectDirectory,
			'.swarm',
			'telemetry.jsonl',
		);

		if (!fs.existsSync(telemetryPath)) {
			return;
		}

		const stats = fs.statSync(telemetryPath);
		if (stats.size < maxBytes) {
			return;
		}

		const rotatedPath = path.join(
			_projectDirectory,
			'.swarm',
			'telemetry.jsonl.1',
		);
		fs.renameSync(telemetryPath, rotatedPath);

		if (_writeStream !== null) {
			_writeStream.end();
			const stream = createWriteStream(telemetryPath, { flags: 'a' });
			// Same identity guard as initTelemetry: the just-ended old stream must
			// not disable telemetry for this fresh post-rotation stream.
			stream.on('error', () => {
				if (_writeStream === stream) {
					_disabled = true;
					_writeStream = null;
				}
			});
			_writeStream = stream;
		}
	} catch {
		// Rotation errors must be silent
	}
}

// ============================================================================
// Telemetry Convenience Object
// ============================================================================

export const telemetry = {
	sessionStarted(sessionId: string, agentName: string): void {
		_internals.emit('session_started', { sessionId, agentName });
	},

	sessionEnded(sessionId: string, reason: string): void {
		_internals.emit('session_ended', { sessionId, reason });
	},

	agentActivated(sessionId: string, agentName: string, oldName?: string): void {
		_internals.emit('agent_activated', { sessionId, agentName, oldName });
	},

	delegationBegin(sessionId: string, agentName: string, taskId: string): void {
		_internals.emit('delegation_begin', { sessionId, agentName, taskId });
	},

	delegationEnd(
		sessionId: string,
		agentName: string,
		taskId: string,
		result: string,
		costFields?: Partial<DelegationCostFields>,
	): void {
		_internals.emit('delegation_end', {
			sessionId,
			agentName,
			taskId,
			result,
			tokens_input: costFields?.tokens_input ?? 0,
			tokens_output: costFields?.tokens_output ?? 0,
			tokens_reasoning: costFields?.tokens_reasoning ?? 0,
			tokens_cache: costFields?.tokens_cache ?? 0,
			cost_usd: costFields?.cost_usd ?? null,
			cost_source: costFields?.cost_source ?? 'unavailable',
			model: costFields?.model,
			gate: costFields?.gate,
			retry_index: costFields?.retry_index,
		});
	},

	taskStateChanged(
		sessionId: string,
		taskId: string,
		newState: string,
		oldState?: string,
	): void {
		_internals.emit('task_state_changed', {
			sessionId,
			taskId,
			newState,
			oldState,
		});
	},

	gatePassed(sessionId: string, gate: string, taskId: string): void {
		_internals.emit('gate_passed', { sessionId, gate, taskId });
	},

	gateParseError(taskId: string, error: Error): void {
		_internals.emit('gate_parse_error', {
			taskId,
			errorName: error.name,
			errorMessage: error.message.slice(0, 200),
		});
	},

	gateFailed(
		sessionId: string,
		gate: string,
		taskId: string,
		reason: string,
	): void {
		_internals.emit('gate_failed', { sessionId, gate, taskId, reason });
	},

	reviewerGateDecision(
		sessionId: string,
		taskId: string,
		blocked: boolean,
		reasonCode: ReviewerGateReasonCode,
		evidenceKind: ReviewerGateEvidenceKind,
	): void {
		_internals.emit('reviewer_gate_decision', {
			sessionId,
			gate: 'qa_gate',
			taskId,
			blocked,
			allowed: !blocked,
			reasonCode,
			evidenceKind,
		});
	},

	phaseChanged(sessionId: string, oldPhase: number, newPhase: number): void {
		_internals.emit('phase_changed', { sessionId, oldPhase, newPhase });
	},

	budgetUpdated(sessionId: string, budgetPct: number, agentName: string): void {
		_internals.emit('budget_updated', { sessionId, budgetPct, agentName });
	},

	modelFallback(
		sessionId: string,
		agentName: string,
		fromModel: string,
		toModel: string,
		reason: string,
	): void {
		_internals.emit('model_fallback', {
			sessionId,
			agentName,
			fromModel,
			toModel,
			reason,
		});
	},

	hardLimitHit(
		sessionId: string,
		agentName: string,
		limitType: string,
		value: number,
	): void {
		_internals.emit('hard_limit_hit', {
			sessionId,
			agentName,
			limitType,
			value,
		});
	},

	revisionLimitHit(sessionId: string, agentName: string): void {
		_internals.emit('revision_limit_hit', { sessionId, agentName });
	},

	loopDetected(sessionId: string, agentName: string, loopType: string): void {
		_internals.emit('loop_detected', { sessionId, agentName, loopType });
	},

	scopeViolation(
		sessionId: string,
		agentName: string,
		file: string,
		reason: string,
	): void {
		_internals.emit('scope_violation', { sessionId, agentName, file, reason });
	},

	qaSkipViolation(
		sessionId: string,
		agentName: string,
		skipCount: number,
	): void {
		_internals.emit('qa_skip_violation', { sessionId, agentName, skipCount });
	},

	heartbeat(sessionId: string): void {
		_internals.emit('heartbeat', { sessionId });
	},

	turboModeChanged(
		sessionId: string,
		enabled: boolean,
		agentName: string,
	): void {
		_internals.emit('turbo_mode_changed', { sessionId, enabled, agentName });
	},

	autoOversightEscalation(
		sessionId: string,
		reason: string,
		interactionCount: number,
		deadlockCount: number,
		phase?: number,
	): void {
		_internals.emit('auto_oversight_escalation', {
			sessionId,
			reason,
			interactionCount,
			deadlockCount,
			phase,
		});
	},

	environmentDetected(
		sessionId: string,
		hostOS: string,
		shellFamily: string,
		executionMode: string,
	): void {
		_internals.emit('environment_detected', {
			sessionId,
			hostOS,
			shellFamily,
			executionMode,
		});
	},

	prmPatternDetected(
		sessionId: string,
		pattern: string,
		severity: string,
		category: string,
		stepRange: [number, number],
	): void {
		_internals.emit('prm_pattern_detected', {
			sessionId,
			pattern,
			severity,
			category,
			stepRange,
		});
	},

	prmCourseCorrectionInjected(
		sessionId: string,
		pattern: string,
		level: number,
	): void {
		_internals.emit('prm_course_correction_injected', {
			sessionId,
			pattern,
			level,
		});
	},

	prmEscalationTriggered(
		sessionId: string,
		pattern: string,
		level: number,
		occurrenceCount: number,
	): void {
		_internals.emit('prm_escalation_triggered', {
			sessionId,
			pattern,
			level,
			occurrenceCount,
		});
	},

	prmHardStop(
		sessionId: string,
		pattern: string,
		level: number,
		occurrenceCount: number,
	): void {
		_internals.emit('prm_hard_stop', {
			sessionId,
			pattern,
			level,
			occurrenceCount,
		});
	},
};

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.telemetry` and `_internals.emit` so tests can replace the
 * underlying implementations without using `mock.module` — `mock.module` from
 * `bun:test` leaks across files in Bun's shared test-runner process, which
 * would corrupt unrelated test suites. Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	telemetry: typeof telemetry;
	emit: typeof emit;
	rotateTelemetryIfNeeded: typeof rotateTelemetryIfNeeded;
	heartbeatListenerCount: () => number;
} = {
	telemetry,
	emit,
	rotateTelemetryIfNeeded,
	heartbeatListenerCount: () => (_heartbeatListener !== null ? 1 : 0),
};
