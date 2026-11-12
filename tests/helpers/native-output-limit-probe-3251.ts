/**
 * Shared nativeOutputLimitProbe (#3251 extraction; issue-tracer trace
 * 2973-3218-3251-3261-3262-3630). Extracted from
 * tests/unit/utils/bun-compat-exit-first-2530.test.ts:167-218 so the 2530
 * suite and the #3251 race spec drive ONE implementation — the regression
 * oracle cannot pass while the production-used probe stays wrong.
 *
 * Contract (plan-critic round 1-2 approved):
 * - Receipt carries `terminationObserved`, `terminationObservedLate`,
 *   `attempts` (1..3), plus the 2530-compatible fields.
 * - Bounded re-observation: a clean exit-0 with no signal RE-SPAWNS, at most
 *   3 attempts total, 20 ms setTimeout backoff, attempt-counted (no raw clock
 *   reads — the check:test-clock gate).
 * - Kill-origin discriminator: a 1000 ms observation deadline armed at spawn,
 *   strictly shorter than the 10 000 ms spawn backstop; termination observed
 *   only after the deadline reports terminationObservedLate (a FAILING
 *   receipt — the timeout path can never satisfy the window, so a pass proves
 *   the OVERFLOW controller killed). Production claim scope: the overflow
 *   kill REQUEST is wired (src/utils/bun-compat.ts createOutputOverflowController
 *   → requestKill); success acknowledgment is not observable and not claimed.
 * - Invariant-3 posture: per-attempt outputs are drained (stream text()
 *   promises awaited) and a best-effort kill runs in finally.
 * - Injectable spawnAttempt seam: deterministic per-attempt sequences are
 *   testable without real children (see the #3251 spec suite).
 */
import * as bunCompat from '../../src/utils/bun-compat.js';

export const PROBE_LARGE_OUTPUT_BYTES = 128 * 1024;
export const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const PROBE_SPAWN_BACKSTOP_MS = 10_000;
export const PROBE_OBSERVATION_DEADLINE_MS = 1_000;
export const PROBE_MAX_ATTEMPTS = 3;
export const PROBE_BACKOFF_MS = 20;

export interface ProbeStreamResult {
	ok: boolean;
	name?: string;
	instanceOf?: boolean;
	limit?: number;
	captured?: number;
	total?: number;
	length?: number;
}

export interface ProbeReceipt {
	outputLimitErrorExported: boolean;
	terminationObserved: boolean;
	terminationObservedLate: boolean;
	attempts: number;
	exitCode: number | null;
	signalCode: string | null;
	stdout: ProbeStreamResult;
	stderr: ProbeStreamResult;
}

/** One observation of a spawned child's termination evidence. */
export interface ProbeAttempt {
	exitCode: number | null;
	signalCode: string | null;
	/** Termination evidence arrived only after the observation deadline. */
	laterThanDeadline: boolean;
	stdout?: ProbeStreamResult;
	stderr?: ProbeStreamResult;
	outputLimitErrorExported?: boolean;
}

export interface ProbeOptions {
	/** Injected attempt source for deterministic sequences (no real child). */
	spawnAttempt?: () => Promise<ProbeAttempt>;
	/** Overrides the child's --eval script (default: dual-stream hold-open). */
	childEval?: string;
}

const DEFAULT_CHILD_EVAL = `const p = 'O'.repeat(${
	PROBE_LARGE_OUTPUT_BYTES * 2
}); process.stdout.write(p); process.stderr.write(p); setInterval(() => {}, 1000);`;

type SpawnWithOutputLimit = Parameters<typeof bunCompat.bunSpawn>[1] & {
	maxBuffer?: number;
};

const nativeSpawn = bunCompat.bunSpawn as unknown as (
	command: string[],
	options?: SpawnWithOutputLimit,
) => bunCompat.BunCompatSubprocess;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeErrorFactory(outputLimitError: typeof Error | undefined) {
	return (error: unknown): ProbeStreamResult => ({
		ok: false,
		name: error instanceof Error ? error.name : typeof error,
		instanceOf:
			typeof outputLimitError === 'function' &&
			error instanceof outputLimitError,
		limit: (error as { limit?: number }).limit,
		captured: (error as { captured?: number }).captured,
		total: (error as { total?: number }).total,
	});
}

/** A real overflow-child attempt with the hold-open + deadline semantics. */
async function realAttempt(childEval: string): Promise<ProbeAttempt> {
	const outputLimitError = (
		bunCompat as typeof bunCompat & {
			BunCompatOutputLimitError?: typeof Error;
		}
	).BunCompatOutputLimitError;
	const describeError = describeErrorFactory(outputLimitError);
	const proc = nativeSpawn([process.execPath, '--eval', childEval], {
		cwd: process.cwd(),
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: PROBE_SPAWN_BACKSTOP_MS,
		maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
	});
	const stdout = proc.stdout
		.text()
		.then((value) => ({ ok: true, length: value.length }), describeError);
	const stderr = proc.stderr
		.text()
		.then((value) => ({ ok: true, length: value.length }), describeError);
	const exited = new Promise<number | null>((resolve) => {
		void proc.exited.then(
			(code) => resolve(code),
			() => resolve(null),
		);
	});
	const deadline = sleep(PROBE_OBSERVATION_DEADLINE_MS).then(
		() => 'late' as const,
	);
	try {
		const first = await Promise.race([exited, deadline]);
		const laterThanDeadline = first === 'late';
		const exitCode = await exited;
		return {
			exitCode,
			signalCode: proc.signalCode ?? null,
			laterThanDeadline,
			stdout: await stdout,
			stderr: await stderr,
			outputLimitErrorExported: typeof outputLimitError === 'function',
		};
	} finally {
		// Best-effort cleanup (invariant 3): a surviving child must not outlive
		// the attempt. Ignored errors mean it already exited.
		try {
			proc.kill();
		} catch {
			/* already gone */
		}
	}
}

export async function nativeOutputLimitProbe(
	options: ProbeOptions = {},
): Promise<ProbeReceipt> {
	const injected = options.spawnAttempt;
	const childEval = options.childEval ?? DEFAULT_CHILD_EVAL;
	let last: ProbeAttempt | undefined;
	let outputLimitErrorExported = false;
	let attemptsMade = 0;
	for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 1) await sleep(PROBE_BACKOFF_MS);
		const observed = injected ? await injected() : await realAttempt(childEval);
		attemptsMade = attempt;
		if (observed.outputLimitErrorExported !== undefined) {
			outputLimitErrorExported = observed.outputLimitErrorExported;
		}
		last = observed;
		if (observed.exitCode !== 0 && observed.exitCode !== null) break;
		if (observed.signalCode !== null) break;
		// Clean exit-0 with no signal: no termination evidence — re-observe.
	}
	const attempt = last ?? {
		exitCode: null,
		signalCode: null,
		laterThanDeadline: false,
	};
	return {
		outputLimitErrorExported,
		terminationObserved:
			(attempt.exitCode !== 0 && attempt.exitCode !== null) ||
			attempt.signalCode !== null,
		terminationObservedLate: attempt.laterThanDeadline,
		attempts: attemptsMade,
		exitCode: attempt.exitCode,
		signalCode: attempt.signalCode,
		stdout: attempt.stdout ?? { ok: true },
		stderr: attempt.stderr ?? { ok: true },
	};
}
