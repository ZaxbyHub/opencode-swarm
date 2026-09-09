/**
 * Bounded advisory-CI runtime tests (issue #2497; frozen check C5's pinned
 * test file).
 *
 * Pins the three bounded-execution obligations:
 *  (a) a hung evaluation stage is cut by the deadline and the run reports a
 *      deadline outcome;
 *  (b) abort/cancellation mid-run produces a cancelled outcome AND runs the
 *      registered cleanup callbacks exactly once (the SIGINT/SIGTERM →
 *      exit-2 contract; self-signalling native processes is unreliable on
 *      Windows Git Bash, so the seam is tested in-process here);
 *  (c) the run journal is bounded (capped event count, drops counted).
 *
 * Timing notes: the hung stage is TIMER-BACKED (setTimeout), so the
 * per-test budget can always preempt it; the deadline uses short
 * millisecond budgets and the assertions are outcome-based, not
 * wall-clock-based, to stay deterministic across CI platforms (Windows
 * timer tick ~15.6ms — deadlines here are >= 100ms).
 */

import { describe, expect, test } from 'bun:test';
import {
	type AdvisoryCiReport,
	MAX_CI_JOURNAL_EVENTS,
	runAdvisoryCiRuntime,
} from '../../../src/ci/runtime.js';

function minimalReport(verdict: 'pass' | 'fail'): AdvisoryCiReport {
	return {
		version: 1,
		verdict,
		exit_reason: verdict === 'pass' ? 'all_gates_passed' : 'gate_violations',
		gates: [
			{
				name: 'plan',
				status: verdict === 'pass' ? 'pass' : 'fail',
			},
		],
		tasks: [],
		plan: { present: true, task_count: 0 },
		environment: { mode: 'advisory', tty: false, host: 'none' },
		gate_profile: 'default',
		effective_gates: {
			reviewer: true,
			test_engineer: true,
			council_mode: false,
			sme_enabled: true,
			critic_pre_plan: true,
			hallucination_guard: false,
			sast_enabled: true,
			mutation_test: false,
			phase_council: false,
			drift_check: true,
			final_council: false,
		},
		not_evaluated: [],
		not_evaluable: [],
		counts:
			verdict === 'pass'
				? { pass: 1, fail: 0, no_data: 0, corrupt: 0, error: 0 }
				: { pass: 0, fail: 1, no_data: 0, corrupt: 0, error: 0 },
	};
}

describe('runAdvisoryCiRuntime bounds', () => {
	test('deadline cuts a hung evaluation stage and reports the deadline outcome', async () => {
		const result = await runAdvisoryCiRuntime({
			directory: 'C:\\definitely\\not\\used',
			deadlineMs: 100,
			evaluate: () =>
				// Timer-backed hang: the runtime deadline must win the race.
				new Promise<AdvisoryCiReport>(() => {}),
		});
		expect(result.outcome).toBe('deadline');
		expect(result.report).toBeUndefined();
		expect(result.journal.some((e) => e.type === 'run_deadline')).toBe(true);
		expect(result.cleanupRan).toBe(true);
	}, 5000);

	test('direct runtime deadlines normalize to the supported finite range', async () => {
		const realDateNow = Date.now;
		Date.now = () => 1_000_000;
		try {
			const observe = async (deadlineMs: number) => {
				let remaining = Number.NaN;
				const result = await runAdvisoryCiRuntime({
					directory: 'ci-deadline-normalization',
					deadlineMs,
					evaluate: async (ctx) => {
						remaining = ctx.remainingMs();
						return minimalReport('pass');
					},
				});
				expect(result.outcome).toBe('pass');
				return remaining;
			};

			expect(await observe(0)).toBe(1);
			expect(await observe(-1)).toBe(1);
			expect(await observe(Number.NaN)).toBe(1);
			expect(await observe(Number.POSITIVE_INFINITY)).toBe(300_000);
			expect(await observe(300_000)).toBe(300_000);
			expect(await observe(300_001)).toBe(300_000);
		} finally {
			Date.now = realDateNow;
		}
	});

	test('abort mid-run produces a cancelled outcome and runs cleanup exactly once', async () => {
		const controller = new AbortController();
		let cleanups = 0;
		const result = await runAdvisoryCiRuntime({
			directory: 'C:\\definitely\\not\\used',
			deadlineMs: 5000,
			signal: controller.signal,
			evaluate: async (ctx) => {
				ctx.registerCleanup(() => {
					cleanups++;
				});
				// Cancel while the stage is in flight, then hang on a timer so
				// only the cancellation can resolve the run.
				controller.abort();
				await new Promise(() => {});
			},
		});
		expect(result.outcome).toBe('cancelled');
		expect(result.cleanupRan).toBe(true);
		expect(cleanups).toBe(1);
	}, 5000);

	test('pre-aborted signal resolves immediately as cancelled with cleanup', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runAdvisoryCiRuntime({
			directory: 'C:\\definitely\\not\\used',
			deadlineMs: 5000,
			signal: controller.signal,
			evaluate: () => new Promise<AdvisoryCiReport>(() => {}),
		});
		expect(result.outcome).toBe('cancelled');
		expect(result.cleanupRan).toBe(true);
	}, 5000);

	test('a failing evaluation surfaces as the error outcome, not a crash', async () => {
		const result = await runAdvisoryCiRuntime({
			directory: 'C:\\definitely\\not\\used',
			deadlineMs: 5000,
			evaluate: async () => {
				throw new Error('boom');
			},
		});
		expect(result.outcome).toBe('error');
		expect(result.detail).toContain('boom');
		expect(result.cleanupRan).toBe(true);
	}, 5000);

	test('verdict mapping: pass and violations outcomes carry the report', async () => {
		const pass = await runAdvisoryCiRuntime({
			directory: '.',
			deadlineMs: 5000,
			evaluate: async () => minimalReport('pass'),
		});
		expect(pass.outcome).toBe('pass');
		expect(pass.report?.verdict).toBe('pass');

		const fail = await runAdvisoryCiRuntime({
			directory: '.',
			deadlineMs: 5000,
			evaluate: async () => minimalReport('fail'),
		});
		expect(fail.outcome).toBe('violations');
		expect(fail.report?.verdict).toBe('fail');
	}, 5000);

	test('run journal is bounded: cap enforced, drops counted, newest kept', async () => {
		let emitted = 0;
		const result = await runAdvisoryCiRuntime({
			directory: '.',
			deadlineMs: 5000,
			evaluate: async (ctx) => {
				for (let i = 0; i < MAX_CI_JOURNAL_EVENTS + 150; i++) {
					ctx.journal('tick', String(i));
					emitted++;
				}
				return minimalReport('pass');
			},
		});
		expect(emitted).toBe(MAX_CI_JOURNAL_EVENTS + 150);
		expect(result.journal.length).toBe(MAX_CI_JOURNAL_EVENTS);
		// Total events = run_started + ticks + run_finished; drops = total - cap.
		expect(result.journalTruncated).toBe(emitted + 2 - MAX_CI_JOURNAL_EVENTS);
		// Newest events survive the cap: the final tick and the run_finished
		// event appended after the evaluation returned.
		const last = result.journal[result.journal.length - 1];
		const secondLast = result.journal[result.journal.length - 2];
		expect(last.type).toBe('run_finished');
		expect(secondLast.type).toBe('tick');
		expect(secondLast.detail).toBe(String(emitted - 1));
		// The run_finished event lands after the ticks (it also fits because
		// the cap keeps shifting).
		expect(result.journal.some((e) => e.type === 'run_finished')).toBe(true);
	}, 5000);

	test('cleanup callbacks run even when the evaluation succeeds', async () => {
		let cleanups = 0;
		const result = await runAdvisoryCiRuntime({
			directory: '.',
			deadlineMs: 5000,
			evaluate: async (ctx) => {
				ctx.registerCleanup(() => {
					cleanups++;
				});
				ctx.registerCleanup(() => {
					throw new Error('cleanup failure must not block the others');
				});
				ctx.registerCleanup(() => {
					cleanups++;
				});
				return minimalReport('pass');
			},
		});
		expect(result.outcome).toBe('pass');
		expect(result.cleanupRan).toBe(true);
		// A failing callback is skipped; the remaining ones still run.
		expect(cleanups).toBe(2);
	}, 5000);

	test('late cleanup remains best-effort and handles self-registration safely', async () => {
		let beforeThrowing = 0;
		let beforeNormal = 0;
		let lateThrowing = 0;
		let lateNormal = 0;
		let registerLate!: (fn: () => void) => void;

		const result = await runAdvisoryCiRuntime({
			directory: 'ci-late-cleanup',
			deadlineMs: 5_000,
			evaluate: async (ctx) => {
				registerLate = ctx.registerCleanup;
				ctx.registerCleanup(() => {
					beforeThrowing++;
					throw new Error('pre-settlement cleanup failure');
				});
				ctx.registerCleanup(() => {
					beforeNormal++;
				});
				return minimalReport('pass');
			},
		});

		let selfRuns = 0;
		let selfRegistering!: () => void;
		selfRegistering = () => {
			selfRuns++;
			registerLate(selfRegistering);
		};
		registerLate(() => {
			lateThrowing++;
			throw new Error('late cleanup failure');
		});
		registerLate(selfRegistering);
		registerLate(() => {
			lateNormal++;
		});

		expect(result.outcome).toBe('pass');
		expect(result.cleanupRan).toBe(true);
		expect(beforeThrowing).toBe(1);
		expect(beforeNormal).toBe(1);
		expect(lateThrowing).toBe(1);
		expect(selfRuns).toBe(1);
		expect(lateNormal).toBe(1);
	});
});
