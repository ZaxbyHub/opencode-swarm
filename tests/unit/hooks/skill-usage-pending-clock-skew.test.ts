/**
 * PR #2347 review (FB-009): `breakStaleLock` and `resolveStaleInFlight` used
 * to compute `age` as a plain signed subtraction and compare it directly
 * against the stale threshold (`age <= SKILL_USAGE_LOCK_STALE_MS`). A future
 * mtime / `inFlightAt` (clock skew, or a bad wall clock at write time)
 * produces a negative `age`, which that comparison always treats as "fresh" —
 * the lock or claim then wedges forever instead of resolving once the
 * skew-magnitude exceeds the stale window. The fix compares `Math.abs(age)`
 * instead. Neither existing suite (`skill-usage-pending.test.ts`) constructs
 * a future-dated timestamp; both only exercise the ordinary positive-age
 * path. These tests fill that gap.
 *
 * Uses the `_internals` DI seam (never `mock.module`), restored in
 * `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	_resetSkillUsagePendingState,
	acquireSkillUsageLock,
	createPendingDocument,
	markRecordsInFlight,
	mergePendingRecords,
	resolveSkillUsageLockPath,
	resolveStaleInFlight,
	SKILL_USAGE_LOCK_STALE_MS,
	_internals as sup_internals,
} from '../../../src/hooks/skill-usage-pending.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** A fixed instant, deterministic across runs (repo convention: never Date.now()). */
const FROZEN_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');

describe('clock-skew handling (PR #2347 FB-009)', () => {
	describe('resolveStaleInFlight — future-dated inFlightAt', () => {
		test('a claim stamped in the FUTURE beyond the stale window resolves to uncertain, not wedged forever', () => {
			const doc = createPendingDocument();
			doc.migrated = true;
			mergePendingRecords(
				doc,
				[
					{
						id: 'future-claim',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
				'2026-01-01T00:00:00.000Z',
			);

			const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
			// Claimed far enough in the future (beyond the stale window) that a
			// buggy `age <= threshold` comparison treats the negative age as
			// "fresh" and never resolves it — exactly the wedge FB-009 fixes.
			const futureClaimedAt = new Date(
				nowMs + SKILL_USAGE_LOCK_STALE_MS + 60_000,
			).toISOString();
			markRecordsInFlight(doc, ['future-claim'], futureClaimedAt);
			expect(doc.records[0]!.state).toBe('in_flight');

			const resolvedCount = resolveStaleInFlight(doc, nowMs);

			// Un-fixed (`age <= threshold`, no abs): age is a large negative
			// number, the guard never fires, resolvedCount stays 0 and the
			// record stays `in_flight` forever.
			expect(resolvedCount).toBe(1);
			expect(doc.records[0]!.state).toBe('uncertain');
			expect(doc.records[0]!.inFlightAt).toBeUndefined();
		});

		test('a claim stamped in the future but WITHIN the stale window stays in_flight (Math.abs does not over-resolve)', () => {
			const doc = createPendingDocument();
			doc.migrated = true;
			mergePendingRecords(
				doc,
				[
					{
						id: 'near-future-claim',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
				'2026-01-01T00:00:00.000Z',
			);

			const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
			const nearFutureClaimedAt = new Date(
				nowMs + SKILL_USAGE_LOCK_STALE_MS - 1,
			).toISOString();
			markRecordsInFlight(doc, ['near-future-claim'], nearFutureClaimedAt);

			// Semantics-pinning only (not the FB-009 regression proof — this
			// passes on both old and new code): `Math.abs` must not make a
			// small future skew look stale.
			expect(resolveStaleInFlight(doc, nowMs)).toBe(0);
			expect(doc.records[0]!.state).toBe('in_flight');
		});
	});

	describe('breakStaleLock (via acquireSkillUsageLock) — future-dated lock mtime', () => {
		let dir: string;
		const realStatSync = sup_internals.statSync;
		// Capture the ORIGINAL `_internals.now` closure, not `Date.now()`
		// directly — reassigning `sup_internals.now = () => Date.now()` in a
		// `finally` looks like a restore but is a NEW closure that happens to be
		// behaviourally equivalent today; it is not actually the seam's original
		// value and would defeat any future instrumentation of `_internals.now`.
		const originalInternalsNow = sup_internals.now;

		beforeEach(() => {
			dir = canonicalMkdtemp('skill-usage-clock-skew-');
		});

		afterEach(() => {
			sup_internals.statSync = realStatSync;
			sup_internals.now = originalInternalsNow;
			_resetSkillUsagePendingState();
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test('a lock file with a FUTURE mtime beyond the stale window is broken, not held forever', () => {
			withFrozenClock(
				() => {
					const lockPath = resolveSkillUsageLockPath(dir);
					fs.mkdirSync(path.dirname(lockPath), { recursive: true });
					// Real, genuinely-held lock file so `tryCreateLock` fails and
					// control reaches `breakStaleLock`.
					const fd = fs.openSync(lockPath, 'wx');
					fs.closeSync(fd);

					// Stub `now()` and `statSync` independently so the "future" is
					// unambiguous regardless of filesystem mtime-write granularity.
					sup_internals.now = () => FROZEN_NOW_MS;
					sup_internals.statSync = ((p: fs.PathLike) => {
						const real = realStatSync(p);
						return {
							...real,
							mtimeMs: FROZEN_NOW_MS + SKILL_USAGE_LOCK_STALE_MS + 60_000,
						} as fs.Stats;
					}) as typeof sup_internals.statSync;

					try {
						const handle = acquireSkillUsageLock(dir);
						// Un-fixed (`age <= threshold`, no abs): age is a large
						// negative number, `breakStaleLock` returns false,
						// `acquireSkillUsageLock` returns null — the lock is wedged
						// until real time passes the future mtime.
						expect(handle).not.toBeNull();
						expect(handle?.lockPath).toBe(lockPath);
					} finally {
						try {
							fs.unlinkSync(lockPath);
						} catch {
							// already cleaned up by the successful reacquire path
						}
					}
				},
				{ fixedNow: FROZEN_NOW_MS },
			);
		});

		test('a lock file with a SMALL future mtime (within the stale window) is NOT broken — the safety direction of the abs() fix', () => {
			withFrozenClock(
				() => {
					// Stage-B round 2 (PR #2347): `Math.abs(age) <= threshold`
					// closes the wedge above, but must not become the opposite
					// mistake — treating every future mtime as instantly stale,
					// which would let a second writer break a lock still
					// genuinely held by a live holder under ordinary clock
					// jitter (NTP, VM clock hiccups). A skew well inside the
					// stale window must still read as "fresh, held".
					const lockPath = resolveSkillUsageLockPath(dir);
					fs.mkdirSync(path.dirname(lockPath), { recursive: true });
					const fd = fs.openSync(lockPath, 'wx');
					fs.closeSync(fd);

					sup_internals.now = () => FROZEN_NOW_MS;
					sup_internals.statSync = ((p: fs.PathLike) => {
						const real = realStatSync(p);
						return {
							...real,
							// A few seconds in the future — small clock jitter,
							// nowhere near the 5-minute stale window.
							mtimeMs: FROZEN_NOW_MS + 5_000,
						} as fs.Stats;
					}) as typeof sup_internals.statSync;

					try {
						const handle = acquireSkillUsageLock(dir);
						// The lock is genuinely still held (this test created it
						// and never released it) — `acquireSkillUsageLock` must
						// return null, not break a live holder's lock over a few
						// seconds of skew.
						expect(handle).toBeNull();
					} finally {
						fs.unlinkSync(lockPath);
					}
				},
				{ fixedNow: FROZEN_NOW_MS },
			);
		});
	});
});
