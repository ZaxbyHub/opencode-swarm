/**
 * Deterministic-clock test helper for opencode-swarm.
 *
 * Why this exists: several production functions are continuous functions of
 * `Date.now()` (e.g. `computeRecencyScore` in `src/hooks/skill-scoring.ts`).
 * Under coverage instrumentation or sub-millisecond timing, the real clock can
 * advance between the call under test and a later equality assertion, flipping
 * a comparison bit and producing a flake (issue #1782, root-cause class 1).
 *
 * Bun's `bun:test` does NOT export `FakeTime` (verified absent on 1.3.13/1.3.14),
 * so this helper builds on the repo's only proven pattern — `spyOn(Date, ...)`.
 *
 * Usage (manual restore):
 *   const restore = freezeClock();
 *   try { /* assertions *\/ } finally { restore(); }
 *
 * Usage (auto restore, preferred inside a test body):
 *   withFrozenClock(() => {
 *     expect(computeThing()).toBe(computeThing()); // deterministic
 *   });
 *
 * Restore contract: `withFrozenClock` relies on try/finally ONLY (no
 * `afterEach` safety net) to avoid registration-ordering ambiguity with a
 * file's own `afterEach(mock.restore())` hooks (issue #1782 plan critic M2).
 * `freezeClock()` returns a `restore()` the caller MUST call in finally.
 */
import { type Mock, spyOn } from 'bun:test';

export interface FreezeClockOptions {
	/**
	 * The fixed millisecond instant `Date.now()` will report. Defaults to a
	 * stable constant (0) so the frozen instant is fully deterministic across
	 * runs — NOT `Date.now()` captured at freeze time, which would itself be
	 * non-deterministic across runs.
	 */
	fixedNow?: number;
	/**
	 * If set, each call to the mocked `Date.now()` advances the reported
	 * instant by this many ms (controlled time-passage for decay/interval
	 * tests). If unset, the clock is frozen exactly at `fixedNow`.
	 */
	tickMs?: number;
	/**
	 * If set, also spies `Date.prototype.toISOString` to return this string.
	 * Use when the code under test stamps records with `new Date().toISOString()`
	 * and an assertion compares the stamp byte-for-byte
	 * (e.g. `manager-plan-md-sync.test.ts`).
	 */
	isoNow?: string;
}

/** A function that removes all spies installed by `freezeClock`. */
export type Restore = () => void;

interface InstalledSpies {
	now: Mock<typeof Date.now> | null;
	iso: Mock<typeof Date.prototype.toISOString> | null;
}

/**
 * Module-level flag tracking whether a freeze is currently active. bun's
 * `spyOn` + `mockRestore` does NOT stack: restoring an inner spy also removes
 * the outer spy, so a nested `freezeClock` would silently break the outer
 * freeze (the inner `restore()` resets `Date.now` to the real clock, not the
 * outer frozen value). Rather than implement spy-stacking, we fail-fast on
 * nested freezes with a clear error (PR review F-004). No current test nests
 * freezes; if a future test needs nested time-scopes, restructure it into
 * sequential freeze/restore cycles instead.
 */
let activeFreeze = false;

/**
 * Freeze the clock deterministically. Returns a `restore()` that MUST be
 * called (typically in a `finally` block, or via `withFrozenClock`).
 *
 * Spies installed:
 *   - `Date.now`        → returns fixedNow (advancing by tickMs per call if set)
 *   - `Date.prototype.toISOString` → returns isoNow (only if `isoNow` is set)
 *
 * Note on completeness: this covers the two time-read surfaces that production
 * code actually uses for now-reads (`Date.now()`) and stamp formatting
 * (`new Date().toISOString()`). It does NOT freeze `process.hrtime.bigint()`
 * or `performance.now()` — see `docs/testing/test-stability.md` "Known
 * limitations". No current test asserts on those.
 */
export function freezeClock(options: FreezeClockOptions = {}): Restore {
	if (activeFreeze) {
		throw new Error(
			'freezeClock: a freeze is already active. Nested freezes are not ' +
				'supported (bun spyOn/mockRestore does not stack — the inner ' +
				'restore would reset the outer freeze to the real clock). ' +
				'Restructure into sequential freeze/restore cycles instead.',
		);
	}

	const { fixedNow = 0, tickMs, isoNow } = options;

	let current = fixedNow;

	const installed: InstalledSpies = { now: null, iso: null };

	// Install spies first; only claim the active-freeze flag after success, so a
	// throw during installation cannot leak the flag as `true` and permanently
	// block all future freezeClock calls (final critic F-004 residual gap).
	try {
		const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
			const returned = current;
			if (tickMs !== undefined) {
				current += tickMs;
			}
			return returned;
		});
		installed.now = nowSpy;

		if (isoNow !== undefined) {
			const isoSpy = spyOn(Date.prototype, 'toISOString').mockImplementation(
				() => isoNow,
			);
			installed.iso = isoSpy;
		}
	} catch (err) {
		// Defensive: spy-install should not throw under normal use (the guard
		// above prevents the already-spied case), but if it does, leave the
		// activeFreeze flag clear and restore anything partially installed.
		installed.now?.mockRestore();
		installed.iso?.mockRestore();
		throw err;
	}
	activeFreeze = true;

	return () => {
		installed.now?.mockRestore();
		installed.iso?.mockRestore();
		activeFreeze = false;
	};
}

/**
 * Run `fn` with the clock frozen, always restoring afterward (try/finally).
 * Preferred for use inside a test body. Re-throws anything `fn` throws after
 * restoring the clock, so failures surface normally.
 */
export function withFrozenClock<T>(
	fn: () => T,
	options?: FreezeClockOptions,
): T {
	const restore = freezeClock(options);
	try {
		return fn();
	} finally {
		restore();
	}
}

/**
 * Run an async `fn` with the clock frozen, always restoring afterward.
 * Async counterpart to `withFrozenClock`.
 */
export async function withFrozenClockAsync<T>(
	fn: () => Promise<T>,
	options?: FreezeClockOptions,
): Promise<T> {
	const restore = freezeClock(options);
	try {
		return await fn();
	} finally {
		restore();
	}
}
