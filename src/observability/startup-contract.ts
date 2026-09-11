/**
 * The startup and first-use latency contract (issue #2670).
 *
 * Stage model — every interval the issue names, measured and emitted
 * SEPARATELY as single-line `STARTUP-CONTRACT <json>` rows on stdout:
 *
 *   import         performance.now() at the end of src/index.ts module
 *                  evaluation (ms since performance.timeOrigin, i.e.
 *                  process start). The fresh-process harness child's own
 *                  external import timer additionally includes its
 *                  node:perf_hooks import and preload; the two values are
 *                  intentionally not expected to be identical.
 *   server         server() entry -> resolution (the plugin wrapper in
 *                  src/index.ts).
 *   first_turn     time from server resolution until the FIRST
 *                  experimental.chat.messages.transform invocation
 *                  settles (success or rejection), once per process.
 *   first_tool     time from server resolution until the FIRST tool
 *                  execute settles (success or rejection), once per
 *                  process, labeled with the tool name.
 *   readiness      queue_settled: the wrapper-owned post-resolution queue
 *                  has fully drained (every scheduled task settled),
 *                  measured from drain scheduling. Optional work NEVER
 *                  gates manifest delivery (AGENTS.md invariant 1).
 *   optional_task  per-task outcome rows: task name, `completed|failed`,
 *                  duration from drain start; failed rows carry a bounded
 *                  error string (<=200 chars, no stack, single line).
 *
 * Emission is gated behind OPENCODE_SWARM_DEBUG=1 exactly like
 * src/utils/logger.ts — ZERO contract rows appear with the env var unset
 * (no chat-visible noise, invariant 10; asserted by the frozen acceptance
 * checks' debug-off probe and the unit suite).
 *
 * All collectors are in-memory only: no filesystem writes, no awaits added
 * to any init path, no new module-load side effects beyond one
 * performance.now() capture (invariant 1). Per-boot state resets on every
 * server() entry so repeated boots in one process (tests) stay coherent;
 * the import mark is captured once per process.
 *
 * The advisory counter is a STARTUP-window counter: the window opens at
 * server entry and closes at queue settle (or at server resolution when no
 * queue is scheduled) and never re-opens — late-session advisories never
 * contribute to `queue_settled.advisories`.
 */

type PostResolutionTaskLike = () => void | Promise<void>;

interface StartupContractState {
	importMarkMs: number | null;
	serverStartMark: number | null;
	serverResolvedMark: number | null;
	serverMs: number | null;
	queueScheduledAt: number | null;
	queuePending: number;
	queueTasks: number;
	queueCompleted: number;
	queueFailed: number;
	queueSettled: boolean;
	queueSettledMs: number | null;
	advisoryCount: number;
	advisoryWindowOpen: boolean;
	firstTurnDone: boolean;
	firstToolDone: boolean;
	firstToolName: string | null;
	firstTurnMs: number | null;
	firstToolMs: number | null;
}

const state: StartupContractState = {
	importMarkMs: null,
	serverStartMark: null,
	serverResolvedMark: null,
	serverMs: null,
	queueScheduledAt: null,
	queuePending: 0,
	queueTasks: 0,
	queueCompleted: 0,
	queueFailed: 0,
	queueSettled: false,
	queueSettledMs: null,
	advisoryCount: 0,
	advisoryWindowOpen: false,
	firstTurnDone: false,
	firstToolDone: false,
	firstToolName: null,
	firstTurnMs: null,
	firstToolMs: null,
};

const CONTRACT_PREFIX = 'STARTUP-CONTRACT ';
const BOUNDED_ERROR_MAX_CHARS = 200;

function roundMs(value: number): number {
	return Math.round(value * 10) / 10;
}

function emitContractRow(payload: Record<string, unknown>): void {
	try {
		if (!_internals.isDebugEnabled()) return;
		_internals.emitLine(`${CONTRACT_PREFIX}${JSON.stringify(payload)}`);
	} catch {
		// Telemetry must never throw into an observed path.
	}
}

function boundErrorText(err: unknown): string {
	let text = 'unknown error';
	try {
		text = err instanceof Error ? err.message : String(err);
	} catch {
		// keep default
	}
	text = text.replace(/\s+/g, ' ').trim().slice(0, BOUNDED_ERROR_MAX_CHARS);
	return text;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === 'function'
	);
}

/** Capture the import-stage mark. Called once at src/index.ts module scope. */
export function markStartupImportComplete(): void {
	if (state.importMarkMs !== null) return;
	state.importMarkMs = _internals.performance.now();
}

/**
 * Begin the server-interval and open the startup advisory window. Resets
 * per-boot state (the import mark persists). Called at server() entry.
 */
export function beginStartupServerInterval(): void {
	state.serverStartMark = _internals.performance.now();
	state.serverResolvedMark = null;
	state.serverMs = null;
	state.queueScheduledAt = null;
	state.queuePending = 0;
	state.queueTasks = 0;
	state.queueCompleted = 0;
	state.queueFailed = 0;
	state.queueSettled = false;
	state.queueSettledMs = null;
	state.advisoryCount = 0;
	state.advisoryWindowOpen = true;
	state.firstTurnDone = false;
	state.firstToolDone = false;
	state.firstToolName = null;
	state.firstTurnMs = null;
	state.firstToolMs = null;
}

/** Resolve the server interval and emit the init row. Called just before the wrapper returns its hooks. */
export function endStartupServerInterval(): void {
	if (state.serverStartMark === null) return;
	const now = _internals.performance.now();
	state.serverResolvedMark = now;
	state.serverMs = roundMs(now - state.serverStartMark);
	if (state.queueScheduledAt === null) {
		// No optional work was scheduled: the advisory window closes here.
		state.advisoryWindowOpen = false;
	}
	emitContractRow({
		v: 1,
		stage: 'init',
		importMs: state.importMarkMs === null ? null : roundMs(state.importMarkMs),
		serverMs: state.serverMs,
	});
}

/**
 * Record that optional tasks were scheduled onto the post-resolution queue:
 * captures the settle-interval origin. Task and pending counts are owned by
 * the wrapper (one increment per wrapped task, one decrement per settle), so
 * late-appended tasks are accounted correctly.
 */
export function noteQueueScheduled(): void {
	state.queueScheduledAt = _internals.performance.now();
}

function maybeEmitQueueSettled(): void {
	if (state.queueSettled || state.queueScheduledAt === null) return;
	if (state.queueTasks === 0 || state.queuePending > 0) return;
	state.queueSettled = true;
	const now = _internals.performance.now();
	state.queueSettledMs =
		state.queueScheduledAt === null
			? null
			: roundMs(now - state.queueScheduledAt);
	// The startup window ends when the queue settles; late advisories no
	// longer contribute to queue_settled.advisories.
	state.advisoryWindowOpen = false;
	emitContractRow({
		v: 1,
		stage: 'queue_settled',
		tasks: state.queueTasks,
		completed: state.queueCompleted,
		failed: state.queueFailed,
		ms: state.queueSettledMs,
		advisories: state.advisoryCount,
	});
}

function recordTaskOutcome(
	name: string,
	outcome: 'completed' | 'failed',
	ms: number,
	err?: unknown,
): void {
	state.queuePending -= 1;
	if (outcome === 'completed') {
		state.queueCompleted += 1;
	} else {
		state.queueFailed += 1;
	}
	const row: Record<string, unknown> = {
		v: 1,
		stage: 'optional_task',
		task: name,
		outcome,
		ms: roundMs(ms),
	};
	if (outcome === 'failed') {
		row.error = boundErrorText(err);
	}
	emitContractRow(row);
	maybeEmitQueueSettled();
}

/**
 * Wrap one post-resolution task so its settle outcome is recorded. Settle
 * tracking is try/finally-structured: a synchronous throw and an async
 * rejection both record and re-raise, preserving the drain loop's existing
 * non-fatal catch semantics (src/index.ts). Tasks appended to the array
 * after a settle still get outcome rows (bounded late-task behavior).
 */
export function wrapPostResolutionTask(
	task: PostResolutionTaskLike,
): PostResolutionTaskLike {
	const name = task.name || 'anonymous';
	// Late-appended tasks (pushed to the array while the drain loop still
	// iterates it) are wrapped too and join the pending count, so they are
	// awaited by the settle condition; a task appended after the queue has
	// settled still gets its outcome row (bounded late-task behavior).
	state.queueTasks += 1;
	state.queuePending += 1;
	const wrapped = async (): Promise<void> => {
		const startedAt = _internals.performance.now();
		try {
			await task();
			recordTaskOutcome(
				name,
				'completed',
				_internals.performance.now() - startedAt,
			);
		} catch (err) {
			recordTaskOutcome(
				name,
				'failed',
				_internals.performance.now() - startedAt,
				err,
			);
			throw err;
		}
	};
	try {
		Object.defineProperty(wrapped, 'name', {
			value: name,
			configurable: true,
		});
	} catch {
		// Name preservation is cosmetic; never fail the wrap.
	}
	return wrapped;
}

function noteFirstUseSettled(
	stage: 'first_turn' | 'first_tool',
	label: string | undefined,
): void {
	try {
		if (stage === 'first_turn') {
			if (state.firstTurnDone) return;
			state.firstTurnDone = true;
			state.firstTurnMs =
				state.serverResolvedMark === null
					? null
					: roundMs(_internals.performance.now() - state.serverResolvedMark);
			emitContractRow({
				v: 1,
				stage: 'first_turn',
				ms: state.firstTurnMs,
			});
		} else {
			if (state.firstToolDone) return;
			state.firstToolDone = true;
			state.firstToolName = label ?? null;
			state.firstToolMs =
				state.serverResolvedMark === null
					? null
					: roundMs(_internals.performance.now() - state.serverResolvedMark);
			emitContractRow({
				v: 1,
				stage: 'first_tool',
				tool: state.firstToolName,
				ms: state.firstToolMs,
			});
		}
	} catch {
		// Telemetry must never throw into an observed path.
	}
}

/**
 * Observe the FIRST invocation of a host-facing handler (chat transform or
 * tool execute) without changing it: returns the handler's own result /
 * promise untouched and attaches a detached observation that records the
 * first-use interval when the invocation SETTLES (success or rejection —
 * an errored first call is still a first use). No extra awaits on the
 * observed path, no writes to any argument, no rebinding.
 */
export function withStartupFirstUseTracking<Args extends unknown[], Result>(
	stage: 'first_turn' | 'first_tool',
	label: string | undefined,
	handler: (...args: Args) => Result,
): (...args: Args) => Result {
	const tracked = (...args: Args): Result => {
		const result = handler(...args);
		const settle = (): void => noteFirstUseSettled(stage, label);
		if (isPromiseLike(result)) {
			void Promise.resolve(result).then(settle, settle);
		} else {
			settle();
		}
		return result;
	};
	try {
		Object.defineProperty(tracked, 'name', {
			value: handler.name || `tracked${stage}`,
			configurable: true,
		});
	} catch {
		// Name preservation is cosmetic; never fail the wrap.
	}
	return tracked;
}

/**
 * Tool-execute specialization of the first-use observation with a FIXED
 * two-parameter signature: the plugin's ToolDefinition.execute contract is
 * `(args, ctx) => ...`, and the registration-convention tests assert
 * `execute.length >= 2` on tool definitions. The wrapper still returns the
 * wrapped execute's own result untouched and records the interval when the
 * invocation settles (success or rejection).
 */
export function withStartupFirstToolTracking<Args, Result>(
	name: string,
	execute: (args: Args, ctx: unknown) => Result,
): (args: Args, ctx: unknown) => Result {
	const tracked = (args: Args, ctx: unknown): Result => {
		const result = execute(args, ctx);
		const settle = (): void => noteFirstUseSettled('first_tool', name);
		if (isPromiseLike(result)) {
			void Promise.resolve(result).then(settle, settle);
		} else {
			settle();
		}
		return result;
	};
	try {
		Object.defineProperty(tracked, 'name', {
			value: execute.name || 'trackedFirstToolExecute',
			configurable: true,
		});
	} catch {
		// Name preservation is cosmetic; never fail the wrap.
	}
	return tracked;
}

/**
 * Count a startup-window advisory (readiness warning). Called from
 * warning-buffer's addDeferredWarning; the window opens at server entry
 * and closes at queue settle (never re-opens), so late-session advisories
 * never contribute.
 */
export function noteStartupAdvisory(): void {
	if (!state.advisoryWindowOpen) return;
	state.advisoryCount += 1;
}

/**
 * The collected contract state, as a structured report.
 *
 * @internal Unit-test seam and future surfaces; not a public API.
 */
export function buildStartupContractReport(): StartupContractState {
	return { ...state };
}

/**
 * DI seam for testability (repo convention; see src/utils/logger.ts).
 * Internal calls route through `_internals` so tests can inject a
 * deterministic performance clock and capture emissions without
 * mock.module.
 */
export const _internals: {
	performance: { now: () => number };
	isDebugEnabled: () => boolean;
	emitLine: (line: string) => void;
} = {
	performance: performance,
	isDebugEnabled: () => process.env.OPENCODE_SWARM_DEBUG === '1',
	emitLine: (line: string) => {
		// biome-ignore lint/suspicious/noConsole: debug-gated contract emission, mirrors src/utils/logger.ts
		console.log(line);
	},
} as const;
