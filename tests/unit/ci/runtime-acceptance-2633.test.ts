/**
 * Focused pre-fix acceptance checks for issue #2633: runtime cleanup
 * lifecycle, deadline edge handling, and concurrent-run isolation.
 */

import { describe, expect, test } from 'bun:test';
import type { AdvisoryCiReport } from '../../../src/ci/evaluate.js';
import { runAdvisoryCiRuntime } from '../../../src/ci/runtime.js';

function report(verdict: 'pass' | 'fail'): AdvisoryCiReport {
	return {
		version: 1,
		verdict,
		exit_reason: verdict === 'pass' ? 'all_gates_passed' : 'gate_violations',
		gates: [{ name: 'fixture', status: verdict === 'pass' ? 'pass' : 'fail' }],
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

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('issue #2633 runtime acceptance checks', () => {
	test('AC1: late cleanup registration is drained exactly once', async () => {
		const lateCleanup = deferred<void>();
		let beforeSettlement = 0;
		let afterSettlement = 0;

		const result = await runAdvisoryCiRuntime({
			directory: 'ci-ac1-fixture',
			deadlineMs: 5_000,
			evaluate: async (ctx) => {
				ctx.registerCleanup(() => {
					beforeSettlement++;
				});
				// The late callback is registered after the evaluation promise has
				// settled, matching a shadow-copy creator that resumes after the
				// runtime's race winner has entered finally.
				return Promise.resolve(report('pass')).finally(() => {
					setTimeout(() => {
						ctx.registerCleanup(() => {
							afterSettlement++;
						});
						lateCleanup.resolve();
					}, 0);
				});
			},
		});

		expect(result.outcome).toBe('pass');
		expect(beforeSettlement).toBe(1);
		expect(result.cleanupRan).toBe(true);
		await lateCleanup.promise;
		expect(afterSettlement).toBe(1);
	});

	test('AC11: deadline checks retain timer-tick margin and normalize edge inputs', async () => {
		// 100ms leaves ample room above the ~15.6ms Windows timer tick while
		// remaining short enough that a broken deadline cannot stall this test.
		const result = await runAdvisoryCiRuntime({
			directory: 'ci-ac11-fixture',
			deadlineMs: 100,
			evaluate: () => new Promise<AdvisoryCiReport>(() => {}),
		});
		expect(result.outcome).toBe('deadline');

		const remaining = async (deadlineMs: number) => {
			let observed = Number.NaN;
			await runAdvisoryCiRuntime({
				directory: 'ci-ac11-edge',
				deadlineMs,
				evaluate: async (ctx) => {
					observed = ctx.remainingMs();
					return report('pass');
				},
			});
			return observed;
		};

		const [zero, negative, infinite] = await Promise.all([
			remaining(0),
			remaining(-1),
			remaining(Number.POSITIVE_INFINITY),
		]);
		expect(zero).toBeGreaterThanOrEqual(0);
		expect(zero).toBeLessThanOrEqual(1);
		expect(negative).toBeGreaterThanOrEqual(0);
		expect(negative).toBeLessThanOrEqual(1);
		expect(Number.isFinite(infinite)).toBe(true);
	});

	test('AC13: concurrent runtimes keep outcomes, journals, and cleanup isolated', async () => {
		const firstStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		let firstCleanups = 0;
		let secondCleanups = 0;

		const firstPromise = runAdvisoryCiRuntime({
			directory: 'ci-ac13-first',
			deadlineMs: 5_000,
			evaluate: async (ctx) => {
				ctx.registerCleanup(() => {
					firstCleanups++;
				});
				ctx.journal('first_only');
				firstStarted.resolve();
				await releaseFirst.promise;
				return report('pass');
			},
		});
		await firstStarted.promise;

		const second = await runAdvisoryCiRuntime({
			directory: 'ci-ac13-second',
			deadlineMs: 5_000,
			evaluate: async (ctx) => {
				ctx.registerCleanup(() => {
					secondCleanups++;
				});
				ctx.journal('second_only');
				return report('fail');
			},
		});
		releaseFirst.resolve();
		const first = await firstPromise;

		expect(first.outcome).toBe('pass');
		expect(second.outcome).toBe('violations');
		expect(firstCleanups).toBe(1);
		expect(secondCleanups).toBe(1);
		expect(first.journal.some((event) => event.type === 'first_only')).toBe(
			true,
		);
		expect(first.journal.some((event) => event.type === 'second_only')).toBe(
			false,
		);
		expect(second.journal.some((event) => event.type === 'second_only')).toBe(
			true,
		);
		expect(second.journal.some((event) => event.type === 'first_only')).toBe(
			false,
		);
	});
});
