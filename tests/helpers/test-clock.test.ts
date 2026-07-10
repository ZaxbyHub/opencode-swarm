/**
 * Self-tests for the test-clock helper.
 * Proves the helper itself is deterministic and restores correctly.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
	freezeClock,
	withFrozenClock,
	withFrozenClockAsync,
} from './test-clock.js';

// Ensure no spy leaks between tests regardless of helper behavior.
afterEach(() => {
	mock.restore();
});

describe('freezeClock', () => {
	test('Date.now() returns the fixed instant when fixedNow is set', () => {
		const restore = freezeClock({ fixedNow: 1_700_000_000_000 });
		try {
			expect(Date.now()).toBe(1_700_000_000_000);
			expect(Date.now()).toBe(1_700_000_000_000);
			expect(Date.now()).toBe(1_700_000_000_000);
		} finally {
			restore();
		}
	});

	test('defaults to a deterministic constant (0) when no fixedNow given', () => {
		const restore = freezeClock();
		try {
			expect(Date.now()).toBe(0);
		} finally {
			restore();
		}
	});

	test('tickMs advances the reported instant on each call', () => {
		const restore = freezeClock({ fixedNow: 100, tickMs: 50 });
		try {
			expect(Date.now()).toBe(100);
			expect(Date.now()).toBe(150);
			expect(Date.now()).toBe(200);
		} finally {
			restore();
		}
	});

	test('restore() returns Date.now() to the real clock', () => {
		const before = Date.now();
		const restore = freezeClock({ fixedNow: 42 });
		expect(Date.now()).toBe(42);
		restore();
		// Real clock should now be >= the pre-freeze instant (it advanced).
		const after = Date.now();
		expect(after).toBeGreaterThanOrEqual(before);
		expect(after).not.toBe(42);
	});

	test('isoNow spies Date.prototype.toISOString', () => {
		const restore = freezeClock({ isoNow: '2026-01-01T00:00:00.000Z' });
		try {
			expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
		} finally {
			restore();
		}
	});

	test('isoNow is not spied when omitted', () => {
		const restore = freezeClock({ fixedNow: 0 });
		try {
			// Real toISOString — should produce a valid ISO string, not a frozen one.
			const s = new Date(0).toISOString();
			expect(s).toBe('1970-01-01T00:00:00.000Z');
		} finally {
			restore();
		}
	});

	test('restore() is idempotent (safe to call more than once)', () => {
		const restore = freezeClock({ fixedNow: 99 });
		restore();
		expect(() => restore()).not.toThrow();
	});
});

describe('withFrozenClock', () => {
	test('runs fn with a frozen clock', () => {
		const result = withFrozenClock(
			() => {
				return [Date.now(), Date.now(), Date.now()];
			},
			{ fixedNow: 5_000 },
		);
		expect(result).toEqual([5_000, 5_000, 5_000]);
	});

	test('restores the clock even when fn throws', () => {
		expect(() =>
			withFrozenClock(
				() => {
					throw new Error('boom');
				},
				{ fixedNow: 1 },
			),
		).toThrow('boom');
		// Clock must be restored — Date.now() is real again.
		expect(Date.now()).not.toBe(1);
	});

	test('returns the fn return value', () => {
		const out = withFrozenClock(() => 'value', { fixedNow: 0 });
		expect(out).toBe('value');
	});

	test('a nested direct Date.now() call does not drift', () => {
		// Simulates the exact skill-scoring determinism case: calling the
		// function-under-test multiple times must yield identical results
		// because the clock is frozen.
		function computeScoreFromClock(): number {
			return Date.now();
		}
		const scores = withFrozenClock(
			() => [
				computeScoreFromClock(),
				computeScoreFromClock(),
				computeScoreFromClock(),
			],
			{ fixedNow: 1_234_567 },
		);
		expect(scores[0]).toBe(scores[1]);
		expect(scores[1]).toBe(scores[2]);
	});
});

describe('withFrozenClockAsync', () => {
	test('runs async fn with a frozen clock and awaits the result', async () => {
		const out = await withFrozenClockAsync(
			async () => {
				await Promise.resolve();
				return Date.now();
			},
			{ fixedNow: 8_888 },
		);
		expect(out).toBe(8_888);
	});

	test('restores the clock even when async fn rejects', async () => {
		await expect(
			withFrozenClockAsync(
				async () => {
					throw new Error('async boom');
				},
				{ fixedNow: 1 },
			),
		).rejects.toThrow('async boom');
		// Clock restored.
		expect(Date.now()).not.toBe(1);
	});
});

describe('freezeClock — interaction with the real clock after restore', () => {
	test('successive freeze/restore cycles are independent', () => {
		withFrozenClock(() => undefined, { fixedNow: 10 });
		const a = withFrozenClock(() => Date.now(), { fixedNow: 20 });
		withFrozenClock(() => undefined, { fixedNow: 30 });
		expect(a).toBe(20);
		// After all restores, real clock is back.
		expect(Date.now()).not.toBe(10);
		expect(Date.now()).not.toBe(20);
		expect(Date.now()).not.toBe(30);
	});

	test('does not interfere with an independently-spied function', () => {
		// Confirm freezeClock's restore does not clobber an unrelated spy.
		const obj = { method: () => 'real' };
		const unrelatedSpy = spyOn(obj, 'method').mockReturnValue('spied');
		const restore = freezeClock({ fixedNow: 7 });
		try {
			expect(obj.method()).toBe('spied');
			expect(Date.now()).toBe(7);
		} finally {
			restore();
		}
		// Unrelated spy survives freezeClock's restore.
		expect(obj.method()).toBe('spied');
		unrelatedSpy.mockRestore();
		expect(obj.method()).toBe('real');
	});
});

describe('freezeClock — nested freeze guard (F-004)', () => {
	test('throws on nested freeze rather than silently breaking the outer freeze', () => {
		const outer = freezeClock({ fixedNow: 1000 });
		try {
			expect(() => freezeClock({ fixedNow: 2000 })).toThrow(
				/a freeze is already active/,
			);
			// Outer freeze is still intact (the rejected inner did not install a spy).
			expect(Date.now()).toBe(1000);
		} finally {
			outer();
		}
	});

	test('after restore, a new freeze can be started (flag resets)', () => {
		const first = freezeClock({ fixedNow: 5 });
		first();
		// Should not throw — the active flag was cleared by restore.
		const second = freezeClock({ fixedNow: 9 });
		try {
			expect(Date.now()).toBe(9);
		} finally {
			second();
		}
	});

	test('withFrozenClock nested inside an active freeze also throws', () => {
		const outer = freezeClock({ fixedNow: 1 });
		try {
			expect(() => withFrozenClock(() => undefined, { fixedNow: 2 })).toThrow(
				/a freeze is already active/,
			);
		} finally {
			outer();
		}
	});
});

describe('freezeClock — combined options (F-011 table tests)', () => {
	test.each([
		{ fixedNow: 1_700_000_000_000, isoNow: '2026-01-01T00:00:00.000Z' },
		{ fixedNow: 0, isoNow: '1970-01-01T00:00:00.000Z' },
		{ fixedNow: 42, isoNow: '2024-12-31T23:59:59.000Z' },
	])('fixedNow + isoNow together: %j', ({ fixedNow, isoNow }) => {
		const restore = freezeClock({ fixedNow, isoNow });
		try {
			expect(Date.now()).toBe(fixedNow);
			expect(new Date().toISOString()).toBe(isoNow);
		} finally {
			restore();
		}
	});

	test('tickMs + isoNow together: clock advances while toISOString stays fixed', () => {
		const restore = freezeClock({
			fixedNow: 100,
			tickMs: 25,
			isoNow: '2026-07-10T12:00:00.000Z',
		});
		try {
			expect(Date.now()).toBe(100);
			expect(Date.now()).toBe(125);
			expect(new Date().toISOString()).toBe('2026-07-10T12:00:00.000Z');
			expect(new Date().toISOString()).toBe('2026-07-10T12:00:00.000Z');
		} finally {
			restore();
		}
	});

	test('all three options: fixedNow + tickMs + isoNow', () => {
		const restore = freezeClock({
			fixedNow: 1000,
			tickMs: 10,
			isoNow: '2025-06-15T08:30:00.000Z',
		});
		try {
			expect(Date.now()).toBe(1000);
			expect(Date.now()).toBe(1010);
			expect(Date.now()).toBe(1020);
			expect(new Date().toISOString()).toBe('2025-06-15T08:30:00.000Z');
		} finally {
			restore();
		}
	});
});
