/**
 * Host-decoupled bounded advisory-CI runtime (issue #2497).
 *
 * This module is the execution harness for `swarm ci`: it owns the five
 * bounded-execution obligations the issue names — bounded startup, bounded
 * evaluation ("health wait" for the run's own progress), cancellation,
 * bounded event streaming, and cleanup — while the evaluation itself lives
 * in `src/ci/evaluate.ts` and only ever composes the existing authoritative
 * readers.
 *
 * Host-decoupling contract (frozen check C1 / ratchet
 * tests/unit/ci/host-decoupling-ratchet.test.ts): this module and its
 * siblings under `src/ci/` must never read the OpenCode host
 * client handle or the plugin's live in-process session state.
 * Advisory evaluation spawns no subprocess and opens no host connection;
 * if a later phase needs one, `runExternalTool`
 * (src/utils/external-tool-runner.ts) is the designated bounded supervisor —
 * do not add supervisor code here without a production caller.
 *
 * SQLite note (AGENTS.md invariant 2 / #1873): this runtime must not open
 * `.swarm/swarm.db` itself. DB-mediated reads (gate profiles, plan-critic
 * snapshots) route through the existing readers in `src/db/qa-gate-profile.ts`
 * and `src/hooks/delegation-gate.ts`, executed against a discarded shadow
 * copy of `.swarm/` managed by `src/ci/evaluate.ts` so the evaluated repo is
 * never mutated (frozen check C7).
 */

import type { AdvisoryCiReport } from './evaluate.js';

/** Bounded run-journal cap. One event per stage/task/check — not per log
 * line — so 200 covers large plans while still bounding memory. Mirrors the
 * named-cap pattern of MAX_PENDING_ADVISORIES (src/utils/advisory-queue.ts). */
export const MAX_CI_JOURNAL_EVENTS = 200;

/** Terminal outcome vocabulary for an advisory CI run. */
export type CiRunOutcome =
	| 'pass'
	| 'violations'
	| 'cancelled'
	| 'deadline'
	| 'error';

export interface CiRunEvent {
	seq: number;
	type: string;
	detail?: string;
}

/** Context handed to the evaluation callback. */
export interface CiEvaluateContext {
	/** Append a bounded journal event. */
	journal: (type: string, detail?: string) => void;
	/** Register a cleanup callback; all callbacks run exactly once in the
	 * runtime's finally block (even on cancel/deadline/error). */
	registerCleanup: (fn: () => void) => void;
	/** Trips when the caller aborts (SIGINT/SIGTERM at the CLI layer). */
	signal: AbortSignal;
	/** Milliseconds remaining until the overall deadline (monotonic-ish;
	 * recomputed per stage). */
	remainingMs: () => number;
}

export interface CiRuntimeOptions {
	directory: string;
	/** Overall deadline for the whole run. Default 300s; clamps to >=1ms. */
	deadlineMs?: number;
	/** Caller-owned abort source (CLI wires SIGINT/SIGTERM). */
	signal?: AbortSignal;
	/** The evaluation to run under the harness. */
	evaluate: (ctx: CiEvaluateContext) => Promise<AdvisoryCiReport>;
}

export interface CiRunResult {
	outcome: CiRunOutcome;
	/** Present for 'pass' and 'violations'; absent for cancel/deadline/error. */
	report?: AdvisoryCiReport;
	journal: CiRunEvent[];
	/** Events dropped because the journal cap was exceeded. */
	journalTruncated: number;
	/** True when every registered cleanup callback has run. */
	cleanupRan: boolean;
	/** Error detail for 'error'/'deadline'/'cancelled' outcomes. */
	detail?: string;
}

/** Deadline/cancel sentinel carried out of the stage race. */
class RunAborted extends Error {
	constructor(
		public reason: 'deadline' | 'cancelled',
		message: string,
	) {
		super(message);
		this.name = 'RunAborted';
	}
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

/** Race a stage against cancellation without leaving floating rejections:
 * the wrapped promise settles into a result object, so a losing stage that
 * later rejects can never surface as an unhandled rejection (the bare-race
 * hazard documented against withTimeout). */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return promise.then(
		(value: T): Settled<T> => ({ ok: true, value }),
		(error: unknown): Settled<T> => ({
			ok: false,
			error: error instanceof Error ? error : new Error(String(error)),
		}),
	);
}

/**
 * Run one advisory evaluation under bounded-execution semantics.
 *
 * Bounds: every stage is raced against both the caller's abort signal and
 * the overall deadline; the journal is capped; cleanup callbacks run exactly
 * once in `finally`. The evaluation callback receives the context above and
 * must not outlive the runtime (cleanup disposes its resources).
 */
export async function runAdvisoryCiRuntime(
	options: CiRuntimeOptions,
): Promise<CiRunResult> {
	const deadlineMs = Math.max(1, options.deadlineMs ?? 300_000);
	const startedAt = Date.now();
	const events: CiRunEvent[] = [];
	let journalTruncated = 0;
	let seq = 0;
	const cleanups: Array<() => void> = [];
	let cleanupsRan = false;

	const journal = (type: string, detail?: string) => {
		seq++;
		if (events.length >= MAX_CI_JOURNAL_EVENTS) {
			// Keep the newest events (advisory-queue precedent); count the drops.
			events.shift();
			journalTruncated++;
		}
		events.push({ seq, type, ...(detail !== undefined ? { detail } : {}) });
	};

	const registerCleanup = (fn: () => void) => {
		cleanups.push(fn);
	};

	const runCleanups = () => {
		if (cleanupsRan) return;
		cleanupsRan = true;
		for (const fn of cleanups) {
			try {
				fn();
			} catch {
				// Cleanup is best-effort; a failing callback must not block the
				// remaining ones or the outcome.
			}
		}
	};

	const remainingMs = () => Math.max(0, deadlineMs - (Date.now() - startedAt));

	const abort = options.signal ?? new AbortController().signal;
	let abortReason: 'cancelled' | null = null;
	const onAbort = () => {
		abortReason = 'cancelled';
	};
	if (abort.aborted) abortReason = 'cancelled';
	else abort.addEventListener('abort', onAbort, { once: true });

	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let deadlinePromise: Promise<never> | undefined;
	let cancelPromise: Promise<never> | undefined;

	try {
		journal('run_started', options.directory);

		// One stage: the whole evaluation. A finer-grained stage split adds
		// racing overhead without changing the outcome vocabulary; per-stage
		// bounds are the remaining-deadline budget by construction.
		deadlinePromise = new Promise<never>((_, reject) => {
			// The deadline timer is deliberately NOT unref'd: it must remain
			// able to wake an otherwise-idle loop, because when a hung
			// evaluation is the only pending work this timer is the sole thing
			// that can still produce the deadline outcome (an unref'd timer
			// would let the process exit with no verdict at all). It is always
			// cleared below once the race is decided.
			deadlineTimer = setTimeout(() => {
				reject(new RunAborted('deadline', 'advisory CI run deadline exceeded'));
			}, deadlineMs);
		});
		cancelPromise = new Promise<never>((_, reject) => {
			if (abortReason === 'cancelled') {
				reject(new RunAborted('cancelled', 'advisory CI run cancelled'));
				return;
			}
			const listener = () => {
				reject(new RunAborted('cancelled', 'advisory CI run cancelled'));
			};
			abort.addEventListener('abort', listener, { once: true });
			registerCleanup(() => abort.removeEventListener('abort', listener));
		});

		const wrapped = settle(
			Promise.race([
				options.evaluate({
					journal,
					registerCleanup,
					signal: abort,
					remainingMs,
				}),
				deadlinePromise as Promise<never>,
				cancelPromise as Promise<never>,
			]),
		);
		// Losing racers must never surface as unhandled rejections after the
		// winner settles (the bare-race hazard documented against withTimeout):
		// the deadline timer is cleared below once the race is decided, and the
		// no-op catches below swallow any rejection that still slips through
		// (e.g. a late abort after a successful evaluation).
		const raced = await wrapped;
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		deadlinePromise.catch(() => {});
		cancelPromise.catch(() => {});

		if (!raced.ok) {
			const err = raced.error as Error;
			if (err instanceof RunAborted) {
				if (err.reason === 'cancelled') {
					journal('run_cancelled');
					return {
						outcome: 'cancelled',
						journal: [...events],
						journalTruncated,
						cleanupRan: true,
						detail: err.message,
					};
				}
				journal('run_deadline');
				return {
					outcome: 'deadline',
					journal: [...events],
					journalTruncated,
					cleanupRan: true,
					detail: err.message,
				};
			}
			journal('run_error', err.message);
			return {
				outcome: 'error',
				journal: [...events],
				journalTruncated,
				cleanupRan: true,
				detail: err.message,
			};
		}

		const report = raced.value;
		const outcome: CiRunOutcome =
			report.verdict === 'pass' ? 'pass' : 'violations';
		journal('run_finished', outcome);
		return {
			outcome,
			report,
			journal: [...events],
			journalTruncated,
			cleanupRan: true,
		};
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		deadlinePromise?.catch(() => {});
		cancelPromise?.catch(() => {});
		if (abortReason === null) abort.removeEventListener('abort', onAbort);
		runCleanups();
	}
}
