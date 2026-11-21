/**
 * Opt-in delegation critical-path tracer (r17 §8) — distinguishes MODEL and
 * PROVIDER wait time from SWARM-CAUSED wait time, per delegation.
 *
 * PRIVACY CONTRACT: metadata only — session IDs, event types, UTC
 * timestamps, durations, tool NAMES (never arguments, prompts, model output,
 * text deltas, file paths, or user data). Correlation is by sessionID +
 * callID. Disabled by default; enable with SWARM_DELEGATION_TRACE=1
 * (documented in README diagnostics section).
 *
 * OBSERVED vs UNOBSERVED (the r17 mandate — never present inference gaps as
 * measurements):
 *   observed:   dispatch tool call + its `running` result, child session
 *               creation/first text delta (first token)/tool events/terminal
 *               execution events, parent inbox advisory delivery, parent
 *               step boundaries, compaction begin/end (via the shared
 *               v1/v2 timing seams).
 *   unobserved: provider queue wait before model start, model request begin
 *               (the host emits no event for it — TTFT below is therefore an
 *               ESTIMATE measured from the last observed turn boundary, not
 *               from the true request start), GPU generation overlap. For
 *               those segments use LiteLLM/provider metrics; do NOT infer
 *               overlapping generation from overlapping HTTP requests.
 *
 * WASTED PARENT TURNS (the status-chatter hypothesis — OpenCode issue
 * #64073): after a native subagent dispatch returns `running`, the host may
 * resume the parent model turn. A parent turn inside the dispatch window
 * (running → child result delivered to the parent inbox) that produces NO
 * non-dispatch tool call is counted as a `wasted_parent_turns` candidate;
 * the sum of such turns' durations is reported as an explicitly-labeled
 * ESTIMATE (the duration includes model inference the trace cannot
 * attribute). A turn that performs other delegations or real work is useful
 * parallelism and is NOT counted.
 *
 * All state is bounded (MAX_TRACE_SESSIONS); the tracer must never alter the
 * dispatch, hook, or observer paths (every entry point is try/catch-wrapped,
 * best-effort).
 */

export interface DelegationTraceStamp {
	at: number;
	event: string;
	sessionID: string;
	callID?: string;
	tool?: string;
}

interface SessionTraceState {
	/** Last observed turn-boundary timestamp (step ended / tool success end). */
	lastTurnBoundaryMs?: number;
	/** First text delta seen since the last turn boundary (first token). */
	firstTokenAtMs?: number;
	/** Count of step.ended events observed for this session. */
	turnCount: number;
	/** Tool names observed in the CURRENT turn (cleared at turn boundary). */
	turnTools: Set<string>;
	/** Turn start (last boundary) used for wasted-turn duration estimates. */
	turnStartedAtMs?: number;
}

interface DispatchWindow {
	parentSessionID: string;
	callID: string;
	openedAtMs: number;
	/** Delivered (child result reached the parent inbox). */
	deliveredAtMs?: number;
}

const MAX_TRACE_SESSIONS = 512;
const MAX_DISPATCH_WINDOWS = 128;

const sessionStates = new Map<string, SessionTraceState>();
const dispatchWindows: DispatchWindow[] = [];
const cumulative = {
	parentTurns: 0,
	parentTurnsDuringDispatchWindow: 0,
	wastedParentTurns: 0,
	wastedParentTurnsEstimatedMs: 0,
	childFirstTokenEstimatesMs: [] as number[],
	childTerminalToDeliveryMs: [] as number[],
	dispatchWindowsTotal: 0,
};

function enabled(): boolean {
	return process.env.SWARM_DELEGATION_TRACE === '1';
}

function now(): number {
	return Date.now();
}

function stateFor(sessionID: string): SessionTraceState {
	let state = sessionStates.get(sessionID);
	if (state === undefined) {
		if (sessionStates.size >= MAX_TRACE_SESSIONS) {
			const first = sessionStates.keys().next().value;
			if (first !== undefined) sessionStates.delete(first);
		}
		state = {
			turnCount: 0,
			turnTools: new Set<string>(),
		};
		sessionStates.set(sessionID, state);
	}
	return state;
}

function emit(record: Record<string, unknown>): void {
	try {
		console.error(
			'[SWARM_DELEGATION_TRACE] ' +
				JSON.stringify({ at: new Date(now()).toISOString(), ...record }),
		);
	} catch {
		/* best-effort only */
	}
}

// ---------------------------------------------------------------------------
// Host event observations (wired from the v2 event pump)
// ---------------------------------------------------------------------------

/**
 * Record a host session event for the critical-path trace. Only metadata is
 * accepted; the caller must never pass payload text.
 */
export function noteDelegationHostEvent(
	sessionID: string,
	event:
		| 'session.created'
		| 'session.text.delta'
		| 'session.step.ended'
		| 'session.inbox.enqueued'
		| 'session.execution.succeeded'
		| 'session.execution.interrupted'
		| 'session.execution.failed'
		| 'session.error'
		| 'session.compaction',
): void {
	if (!enabled()) return;
	try {
		const state = stateFor(sessionID);
		switch (event) {
			case 'session.text.delta': {
				// First token of the current turn. TTFT is an ESTIMATE from the
				// last observed turn boundary (the true model-request start is
				// not emitted by the host).
				if (
					state.firstTokenAtMs === undefined &&
					state.turnStartedAtMs !== undefined
				) {
					state.firstTokenAtMs = now();
					emit({
						event: 'child_or_session_first_token_estimate',
						sessionID,
						ttftEstimatedMs: Math.max(0, state.firstTokenAtMs - state.turnStartedAtMs),
						unobserved: 'model_request_start',
					});
				}
				return;
			}
			case 'session.step.ended': {
				const endedAt = now();
				const turnDurationMs =
					state.turnStartedAtMs !== undefined
						? Math.max(0, endedAt - state.turnStartedAtMs)
						: undefined;
				state.turnCount += 1;
				const window = openWindowForParent(sessionID);
				if (window !== undefined) {
					cumulative.parentTurnsDuringDispatchWindow += 1;
					// Wasted-turn candidate: no tool activity at all in this
					// turn, or Task-dispatch-only activity (status chatter /
					// "waiting for child" responses).
					const realWork = [...state.turnTools].some(
						(tool) => tool !== 'task' && tool !== 'Task',
					);
					if (!realWork) {
						cumulative.wastedParentTurns += 1;
						if (turnDurationMs !== undefined) {
							cumulative.wastedParentTurnsEstimatedMs += turnDurationMs;
						}
						emit({
							event: 'wasted_parent_turn_candidate',
							sessionID,
							callID: window.callID,
							turnDurationMs,
							turnTools: [...state.turnTools],
							note: 'estimate — includes unobservable model inference',
						});
					}
				} else {
					cumulative.parentTurns += 1;
				}
				state.turnTools.clear();
				state.turnStartedAtMs = endedAt;
				state.firstTokenAtMs = undefined;
				emit({
					event: 'turn_boundary',
					sessionID,
					turnCount: state.turnCount,
					turnDurationMs,
				});
				return;
			}
			case 'session.inbox.enqueued': {
				// Advisory delivery to this session: close any open dispatch
				// window whose parent is this session.
				for (const window of dispatchWindows) {
					if (
						window.parentSessionID === sessionID &&
						window.deliveredAtMs === undefined
					) {
						window.deliveredAtMs = now();
						cumulative.childTerminalToDeliveryMs.push(
							Math.max(0, window.deliveredAtMs - window.openedAtMs),
						);
						emit({
							event: 'dispatch_window_delivered',
							parentSessionID: sessionID,
							callID: window.callID,
							openToDeliveryMs: Math.max(
								0,
								window.deliveredAtMs - window.openedAtMs,
							),
							note: 'open→delivery includes child execution + observer settlement + inbox delivery',
						});
						// One cumulative summary per delivery (consumed by the
						// A/B benchmark harness; see the r17 report).
						emitDelegationTraceSummary();
					}
				}
				return;
			}
			case 'session.created':
			case 'session.execution.succeeded':
			case 'session.execution.interrupted':
			case 'session.execution.failed':
			case 'session.error':
			case 'session.compaction':
				emit({ event, sessionID });
				return;
		}
	} catch {
		/* the tracer must never alter the observed path */
	}
}

/** Record a tool call/observation on a session (tool NAME only). */
export function noteDelegationToolEvent(
	sessionID: string,
	tool: string,
	phase: 'called' | 'success' | 'failed',
): void {
	if (!enabled()) return;
	try {
		stateFor(sessionID).turnTools.add(tool);
		emit({ event: `tool_${phase}`, sessionID, tool });
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------------------
// Dispatch observations (wired from the Task-tool hook + observer)
// ---------------------------------------------------------------------------

/** The Task tool returned a `running` placeholder for this parent call. */
export function noteDispatchRunning(
	parentSessionID: string,
	callID: string,
): void {
	if (!enabled()) return;
	try {
		if (dispatchWindows.length >= MAX_DISPATCH_WINDOWS) dispatchWindows.shift();
		dispatchWindows.push({
			parentSessionID,
			callID,
			openedAtMs: now(),
		});
		cumulative.dispatchWindowsTotal += 1;
		emit({ event: 'dispatch_running_reported', parentSessionID, callID });
	} catch {
		/* best-effort */
	}
}

function openWindowForParent(
	parentSessionID: string,
): DispatchWindow | undefined {
	for (let i = dispatchWindows.length - 1; i >= 0; i -= 1) {
		const window = dispatchWindows[i];
		if (
			window.parentSessionID === parentSessionID &&
			window.deliveredAtMs === undefined
		) {
			return window;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * One summary record per delegation delivery (the A/B benchmark consumes
 * these; see the r17 report for the prepared commands).
 */
export function emitDelegationTraceSummary(): void {
	if (!enabled()) return;
	try {
		emit({
			event: 'summary',
			parentTurns: cumulative.parentTurns,
			parentTurnsDuringDispatchWindow:
				cumulative.parentTurnsDuringDispatchWindow,
			wasted_parent_turns: cumulative.wastedParentTurns,
			wastedParentTurnsEstimatedMs:
				cumulative.wastedParentTurnsEstimatedMs,
			wastedEstimateNote:
				'SUM IS AN ESTIMATE — turn durations include model inference the trace cannot attribute',
			dispatchWindows: cumulative.dispatchWindowsTotal,
			childTerminalToDeliveryMs: cumulative.childTerminalToDeliveryMs,
			unobservedSegments: [
				'provider_queue_wait',
				'model_request_start',
				'gpu_generation_overlap',
			],
		});
	} catch {
		/* best-effort */
	}
}

/** Test-only: reset the bounded tracer state. */
export function _resetDelegationTraceForTesting(): void {
	sessionStates.clear();
	dispatchWindows.length = 0;
	cumulative.parentTurns = 0;
	cumulative.parentTurnsDuringDispatchWindow = 0;
	cumulative.wastedParentTurns = 0;
	cumulative.wastedParentTurnsEstimatedMs = 0;
	cumulative.childFirstTokenEstimatesMs.length = 0;
	cumulative.childTerminalToDeliveryMs.length = 0;
	cumulative.dispatchWindowsTotal = 0;
}
