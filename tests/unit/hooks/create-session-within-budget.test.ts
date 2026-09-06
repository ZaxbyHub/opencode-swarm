import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { _internals } from '../../../src/hooks/delegation-gate/worktree-isolation';

const originals = {
	worktreeSessionCreateTimeoutMs: _internals.worktreeSessionCreateTimeoutMs,
	worktreeSessionCreateSettleGraceMs:
		_internals.worktreeSessionCreateSettleGraceMs,
};

/**
 * Issue #2599: the settle-state machine in createSessionWithinBudget. Drives
 * the production function directly through its `_internals` seam with
 * controlled promises — no racy shared flag is involved.
 */
describe('createSessionWithinBudget settle-state machine (#2599)', () => {
	beforeEach(() => {
		_internals.worktreeSessionCreateTimeoutMs = 20;
		_internals.worktreeSessionCreateSettleGraceMs = 2_000;
	});

	afterEach(() => {
		Object.assign(_internals, originals);
	});

	test('no timeoutMs argument ⇒ deadline comes from the seam', async () => {
		let settled = false;
		const promise = new Promise<string>((resolve) => {
			setTimeout(() => {
				settled = true;
				resolve('ok');
			}, 200);
		});
		await expect(
			_internals.createSessionWithinBudget(promise, 'SEAM_TEST'),
		).rejects.toThrow(
			/SEAM_TEST deadline expired after 20ms \(worktree\.session_create_timeout_ms\)/,
		);
		expect(settled).toBe(true); // grace (2s) waited out the 200ms settle
	});

	test('settle-after-catch: late fulfillment reaches teardown exactly once', async () => {
		let resolveCreate: (value: string) => void = () => {};
		const promise = new Promise<string>((resolve) => {
			resolveCreate = resolve;
		});
		const onLateResolve = mock(async () => {});
		const pending = _internals.createSessionWithinBudget(
			promise,
			'LATE',
			onLateResolve,
			20,
		);
		// Fulfill well after the 20ms deadline but inside the 2s settle grace;
		// the function's catch awaits the settle BEFORE rethrowing, so the
		// awaited rejection below resolves only after the late fulfillment.
		setTimeout(() => resolveCreate('child-1'), 60);
		await expect(pending).rejects.toThrow('LATE deadline expired');
		expect(onLateResolve).toHaveBeenCalledTimes(1);
		expect(onLateResolve.mock.calls[0]?.[0]).toBe('child-1');
	});

	test('in-window settle (same-timer batch, deadline registered first) still rejects and tears down', async () => {
		let resolveCreate: (value: string) => void = () => {};
		const promise = new Promise<string>((resolve) => {
			resolveCreate = resolve;
		});
		const onLateResolve = mock(async () => {});
		// Register the create's settle timer AFTER the call so withTimeout's
		// deadline timer is first in the same 30ms batch — the exact window
		// where the pre-#2599 boolean misread the settle state.
		const pending = _internals.createSessionWithinBudget(
			promise,
			'WINDOW',
			onLateResolve,
			30,
		);
		setTimeout(() => resolveCreate('child-window'), 30);
		await expect(pending).rejects.toThrow('WINDOW deadline expired');
		await new Promise((r) => setTimeout(r, 50));
		expect(onLateResolve).toHaveBeenCalledTimes(1);
		expect(onLateResolve.mock.calls[0]?.[0]).toBe('child-window');
	});

	test('late REJECTION runs no teardown (pre-#2599 contract preserved)', async () => {
		let rejectCreate: (reason: unknown) => void = () => {};
		const promise = new Promise<string>((_, reject) => {
			rejectCreate = reject;
		});
		const onLateResolve = mock(async () => {});
		const pending = _internals.createSessionWithinBudget(
			promise,
			'REJECT',
			onLateResolve,
			20,
		);
		await expect(pending).rejects.toThrow('REJECT deadline expired');
		rejectCreate(new Error('server-side create failed'));
		await new Promise((r) => setTimeout(r, 25));
		expect(onLateResolve).not.toHaveBeenCalled();
	});

	test('never-settling create: grace expiry rethrows the deadline error without teardown', async () => {
		_internals.worktreeSessionCreateSettleGraceMs = 10;
		const onLateResolve = mock(async () => {});
		await expect(
			_internals.createSessionWithinBudget(
				new Promise<string>(() => {}),
				'NEVER',
				onLateResolve,
				5,
			),
		).rejects.toThrow('NEVER deadline expired');
		expect(onLateResolve).not.toHaveBeenCalled();
	});

	test('fulfillment AFTER settle-grace expiry still runs the detached teardown', async () => {
		// Review round 1 gap: nothing proved the continuation survives grace
		// expiry. Deadline 5ms + grace 10ms means the caller sees the error at
		// ~15ms; fulfill at ~35ms — strictly past the grace — and the DETACHED
		// continuation must still tear down.
		_internals.worktreeSessionCreateSettleGraceMs = 10;
		let resolveCreate: (value: string) => void = () => {};
		const promise = new Promise<string>((resolve) => {
			resolveCreate = resolve;
		});
		let signalTeardown: (() => void) | undefined;
		const teardownSignal = new Promise<void>((resolve) => {
			signalTeardown = resolve;
		});
		const onLateResolve = mock(async () => {
			signalTeardown?.();
		});
		await expect(
			_internals.createSessionWithinBudget(
				promise,
				'POST_GRACE',
				onLateResolve,
				5,
			),
		).rejects.toThrow('POST_GRACE deadline expired');
		await new Promise((r) => setTimeout(r, 20)); // past the 10ms grace
		resolveCreate('child-post-grace');
		// setTimeout-backed race: a regression to grace-bound cancellation
		// fails loudly here instead of hanging the runner (a never-settling
		// await is not preempted by bun's per-test budget).
		await Promise.race([
			teardownSignal,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error('post-grace teardown never ran')),
					1_500,
				),
			),
		]);
		expect(onLateResolve).toHaveBeenCalledTimes(1);
		expect(onLateResolve.mock.calls[0]?.[0]).toBe('child-post-grace');
	});

	test('a rejecting late teardown never surfaces as an unhandled rejection', async () => {
		// Review round 1: the detached continuation can outlive the grace
		// await. Under the CURRENT race-based withTimeout, Promise.race
		// attaches a handler that absorbs the late rejection; this test pins
		// that contract so a withTimeout reimplementation that drops the
		// handler cannot silently reintroduce an unhandled rejection after
		// the caller already received the deadline error.
		_internals.worktreeSessionCreateSettleGraceMs = 10;
		let resolveCreate: (value: string) => void = () => {};
		const promise = new Promise<string>((resolve) => {
			resolveCreate = resolve;
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);
		const onLateResolve = mock(async () => {
			throw new Error('teardown exploded');
		});
		try {
			await expect(
				_internals.createSessionWithinBudget(
					promise,
					'THROWING_TEARDOWN',
					onLateResolve,
					5,
				),
			).rejects.toThrow('THROWING_TEARDOWN deadline expired');
			await new Promise((r) => setTimeout(r, 20)); // past the grace
			resolveCreate('child-throw');
			await new Promise((r) => setTimeout(r, 50)); // let a rejection surface
			expect(unhandled).toEqual([]);
			expect(onLateResolve).toHaveBeenCalledTimes(1);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
