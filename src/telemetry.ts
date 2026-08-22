import * as fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createObservation,
	toLegacyTelemetryLine,
} from './observability/index.js';
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
	| 'context_pruned'
	| 'model_fallback'
	/**
	 * Issue #2271 bug 4 — a configured agent model id was POSITIVELY confirmed
	 * unresolvable against the live provider catalog (distinct from a runtime
	 * model_fallback: this fires at preflight, before any dispatch attempt).
	 */
	| 'model_unresolved'
	| 'hard_limit_hit'
	| 'revision_limit_hit'
	| 'loop_detected'
	| 'no_op_strong_warning'
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
	// Gate-denial containment (issue #2063 B1): emitted when the same
	// (session, tool, denial-code) streak reaches the hard rung.
	| 'gate_denial_loop'
	/**
	 * Issue #2063 B5 — an ARMED execution episode reached the advisory rung:
	 * `execution_stall_warn_calls` tool calls with no delegation completion, no
	 * file write, no `update_task_status`, and no workspace change. Emitted once
	 * per non-progress streak.
	 */
	| 'execution_stall_warning'
	/**
	 * Issue #2063 B5 — the same episode reached `execution_stall_stop_calls` and
	 * a non-productive tool (read/glob/grep/bash/shell) was hard-denied. Emitted
	 * once per non-progress streak; the denial itself repeats until a progress
	 * event clears the rung.
	 */
	| 'execution_stall_denied'
	/**
	 * Issue #2063 B4 — a read/glob/grep/bash call resolved to a path inside the
	 * INSTALLED opencode-swarm package and was denied. `target` is relative to the
	 * package root so no user home path is written to the ledger.
	 */
	| 'swarm_internals_read_denied'
	// PRM events
	| 'prm_pattern_detected'
	| 'prm_course_correction_injected'
	| 'prm_escalation_triggered'
	| 'prm_hard_stop'
	/**
	 * Issue #2063 C2 — DELIVERY of a PRM hard stop, as distinct from the
	 * `prm_hard_stop` TRIGGER emitted by `src/prm/escalation.ts`. A trigger with
	 * no matching delivery means the containment never reached the agent.
	 */
	| 'prm_hard_stop_delivered'
	// Emitted by src/hooks/conflict-resolution.ts. Until issue #2029 this member
	// was MISSING and that producer reached `emit` through
	// `'agent_conflict_detected' as Parameters<typeof emit>[0]` — a cast that
	// defeated the type system, so a live production event kind existed in
	// `.swarm/telemetry.jsonl` that no type, catalog, or consumer knew about.
	// That is the exact defect class this issue targets; the cast is now gone.
	| 'agent_conflict_detected'
	// Close/archive observability (issue #2030): structured event carrying per-artifact
	// requiredness/attempt/validation/source_disposition plus aggregate
	// archive_valid/archive_empty health facts (counts only, no row content).
	| 'close_archive_result'
	| 'knowledge_receipt_transition' // Diagnostic projection only; the V2 journal is authoritative.
	// Human-only hive-store maintenance audit (issue #2033): one metadata-only event per
	// preview/commit/rollback phase with bounded abort codes, counts, hash prefixes, and
	// token prefixes. No lesson text and no filesystem paths ever enter the payload.
	| 'knowledge_maintenance'
	// Atomic-write residue health (issue #2035): bounded counts emitted when a
	// quarantine run moves verified stale temp files (close clean stage or
	// `/swarm config doctor --quarantine-residue`). Counts and registered
	// grammar ids only — no file names, no paths, no content.
	| 'residue_health';

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

		// Build the canonical observability event (issue #2029), then project it
		// down to the legacy JSONL line. `createObservation` performs no I/O, never
		// throws, and never clones or traverses `data` — see
		// `docs/observability-event-contract.md`.
		//
		// The written line is BYTE-IDENTICAL to the previous inline construction:
		// `toLegacyTelemetryLine` takes `timestamp` from `canonical.observedAt`
		// (stamped with the same `new Date().toISOString()`) and spreads the
		// caller's original `data` object last. Proven by
		// `tests/unit/telemetry/emit-line-parity.test.ts` against a corpus captured
		// from the unmodified tree at e50386b9.
		//
		// `JSON.stringify` still throws here for circular/BigInt payloads, before
		// the listener fan-out below — preserving the ordering asserted by
		// `src/telemetry.test.ts:137-162`.
		const canonical = _internals.createObservation(event, data);
		const line =
			JSON.stringify(_internals.toLegacyTelemetryLine(canonical)) + os.EOL;

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

/**
 * Flush any buffered telemetry records to disk and reopen the append stream.
 *
 * Why this exists (issue #2030 item 8): `/swarm close` archives
 * `telemetry.jsonl` via `fs.copyFile`, but the writer holds an open buffered
 * `WriteStream` whose in-memory buffer is not reflected in the on-disk file
 * until the OS accepts the bytes. Archiving without flushing silently loses the
 * tail records of the session.
 *
 * Ordering (race fix, swarm-pr-review F-003): the replacement stream is created
 * and assigned to `_writeStream` BEFORE `end()` is called on the old handle, so
 * a concurrent `emit()` that races across the await lands on the live stream.
 * The old handle's write callback would otherwise fire
 * `ERR_STREAM_WRITE_AFTER_END`, latch `_disabled = true`, and kill telemetry for
 * every subsequent session until restart (server-scoped plugin process). This
 * mirrors the already-safe `rotateTelemetryIfNeeded` ordering.
 *
 * `WriteStream.end(cb)` invokes `cb` on the `'finish'` event — AFTER the buffer
 * has been drained to the OS — so awaiting that callback is the documented way
 * to guarantee the on-disk file contains every emitted record up to this point.
 *
 * Fail-open: any error during reopen disables telemetry rather than throwing —
 * a flush failure must never block the close pipeline.
 */
export async function flushAndDrainTelemetry(): Promise<void> {
	const stream = _writeStream;
	if (stream === null || _projectDirectory === null) {
		return;
	}
	// Create the replacement stream and install it BEFORE ending the old one,
	// so a racing emit() lands on the live stream and the old handle fails the
	// identity guard in the emit() error handler.
	let next: ReturnType<typeof createWriteStream>;
	try {
		const telemetryPath = path.join(
			_projectDirectory,
			'.swarm',
			'telemetry.jsonl',
		);
		next = createWriteStream(telemetryPath, { flags: 'a' });
		next.on('error', () => {
			if (_writeStream === next) {
				_disabled = true;
				_writeStream = null;
			}
		});
		_writeStream = next;
	} catch {
		// Reopen failed — leave telemetry disabled rather than throwing.
		_disabled = true;
		_writeStream = null;
		return;
	}
	// Now drain the old handle. Racing emits go to `next` (already installed).
	await new Promise<void>((resolve) => {
		stream.end(() => resolve());
	});
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

	contextPruned(data: {
		sessionId: string;
		agentName: string;
		trigger: 'agent_switch' | 'critical_threshold';
		usageSource: 'provider' | 'estimated';
		beforeTokens: number;
		afterTokens: number;
		modelLimit: number;
		maskedMessages: number;
		maskedToolParts: number;
		maskedTokensFreed: number;
		prunedMessages: number;
		prunedTextParts: number;
		prunedToolParts: number;
		prunedTokensFreed: number;
	}): void {
		_internals.emit('context_pruned', data);
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

	/**
	 * Issue #2271 bug 4 — preflight confirmed a configured model id does not
	 * resolve against the provider catalog. Emitted once per detected model.
	 */
	modelUnresolved(agentName: string, model: string, detail: string): void {
		_internals.emit('model_unresolved', {
			sessionId: 'preflight',
			agentName,
			model,
			detail,
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

	/**
	 * Issue #2063 B2 — stage 2 of the no-op ladder fired: the session has made
	 * `count` consecutive tool calls with no file write and no subagent dispatch,
	 * at or beyond 2× `no_op_warning_threshold`.
	 */
	noOpStrongWarning(
		sessionId: string,
		agentName: string,
		count: number,
		threshold: number,
	): void {
		_internals.emit('no_op_strong_warning', {
			sessionId,
			agentName,
			count,
			threshold,
		});
	},

	/**
	 * Issue #2063 B1 — a fail-closed `tool.execute.before` denial streak reached
	 * the hard rung: `count` consecutive denials with the same classification
	 * (`code`) for the same tool in the same session. Emitted from
	 * `src/hooks/gate-denial-tracker.ts` at every denial at or past the rung, so
	 * the ledger shows how long the model kept retrying after being told to stop.
	 */
	gateDenialLoop(
		sessionId: string,
		tool: string,
		code: string,
		count: number,
	): void {
		_internals.emit('gate_denial_loop', { sessionId, tool, code, count });
	},

	/**
	 * Issue #2063 B5 — advisory rung of the execution-stall ladder. Emitted from
	 * `src/hooks/guardrails/execution-stall.ts` once per non-progress streak, so
	 * a warning with no matching `execution_stall_denied` means the agent
	 * recovered on its own.
	 */
	executionStallWarning(
		sessionId: string,
		count: number,
		threshold: number,
	): void {
		_internals.emit('execution_stall_warning', {
			sessionId,
			count,
			threshold,
		});
	},

	/**
	 * Issue #2063 B5 — hard rung of the execution-stall ladder. `tool` is the
	 * normalized name of the denied non-productive tool.
	 */
	executionStallDenied(
		sessionId: string,
		tool: string,
		count: number,
		threshold: number,
	): void {
		_internals.emit('execution_stall_denied', {
			sessionId,
			tool,
			count,
			threshold,
		});
	},

	/**
	 * Issue #2063 B4 — a call targeting the installed plugin package was denied.
	 * `target` is package-root-relative (never an absolute user path).
	 */
	swarmInternalsReadDenied(
		sessionId: string,
		tool: string,
		target: string,
	): void {
		_internals.emit('swarm_internals_read_denied', {
			sessionId,
			tool,
			target,
		});
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

	/**
	 * Close/archive structured result (issue #2030). This single event is the
	 * shared source of truth for both the user-facing close summary prose and
	 * the telemetry stream, so the two cannot disagree. Carries per-artifact
	 * structured fields plus aggregate `archive_valid`/`archive_empty` health
	 * facts. Row counts are counts ONLY — no row content is ever emitted (issue
	 * item 4/9), enabling PR 16 to alarm and PR 20 to report without leaking
	 * data.
	 */
	closeArchiveResult(data: {
		archive_valid: boolean;
		archive_empty: boolean;
		file_count: number;
		bundle: string;
		artifacts: Array<{
			artifact: string;
			requiredness: string;
			attempt: string;
			validation: string;
			source_disposition: string;
			method: string;
			reason_code: string;
			row_counts?: {
				schema_migrations_max_version: number | null;
				project_constraints: number;
				qa_gate_profile: number;
			};
		}>;
	}): void {
		_internals.emit('close_archive_result', data);
	},

	/**
	 * Atomic-write residue health (issue #2035). Emitted after a residue
	 * quarantine run (close clean stage / doctor flag). Bounded payload:
	 * counts, one bounded age figure, total bytes, and per-grammar counts
	 * keyed by the frozen registry ids — never file names, paths, or content,
	 * enabling later reporting (PR 16/19) without leaking workspace layout.
	 */
	residueHealth(data: {
		trigger: string;
		scanned: number;
		matched: number;
		eligible: number;
		ambiguous: number;
		quarantined: number;
		preserved: number;
		total_bytes: number;
		oldest_age_ms: number;
		grammar_counts: Record<string, number>;
	}): void {
		_internals.emit('residue_health', data);
	},

	/**
	 * Issue #2063 C2 — the PRM hard-stop DENIAL was actually delivered to the
	 * agent (thrown by the guardrails `toolBefore` consumer). `prm_hard_stop`
	 * above records the TRIGGER and is emitted solely by
	 * `src/prm/escalation.ts`; a trigger without a matching delivery means the
	 * containment armed but never reached the model.
	 */
	prmHardStopDelivered(
		sessionId: string,
		pattern: string,
		level: number,
		occurrenceCount: number,
	): void {
		_internals.emit('prm_hard_stop_delivered', {
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
	flushAndDrainTelemetry: typeof flushAndDrainTelemetry;
	heartbeatListenerCount: () => number;
	createObservation: typeof createObservation;
	toLegacyTelemetryLine: typeof toLegacyTelemetryLine;
} = {
	telemetry,
	emit,
	rotateTelemetryIfNeeded,
	flushAndDrainTelemetry,
	heartbeatListenerCount: () => (_heartbeatListener !== null ? 1 : 0),
	createObservation,
	toLegacyTelemetryLine,
};
