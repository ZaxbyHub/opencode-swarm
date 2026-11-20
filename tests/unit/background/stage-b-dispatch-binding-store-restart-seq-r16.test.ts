/**
 * r16 audit (P1/P2): cap eviction must preserve write order even when OLD
 * and NEW records share the SAME coarse mtime across a process restart.
 *
 * The r15 repair made mtime the primary sort key with the persisted `seq` as
 * a tie-breaker — but the tie-break is only correct when seq is monotonic
 * across the restart boundary. `allocateSeq` floors a restarted process's
 * first seq at `Date.now()`, and a pre-restart same-tick burst can outrun the
 * wall clock (seqs W..W+127 while Date.now() is still ~W). Post-restart
 * records then carry LOWER seqs than surviving pre-restart records. When the
 * filesystem's timestamp resolution is coarse enough that old and new
 * records share one mtime, the tie-break sorts NEWER records as OLDER and
 * the cap eviction deletes them while retaining pre-restart records.
 *
 * The r15 regression test pinned the old records' mtimes 100 s in the past,
 * so the mtime-primary sort always separated the generations — it never
 * exercised the identical-mtime case this file targets.
 *
 * The r16 repair continues the seq counter from the records already
 * persisted in the session dir at a writer's first allocation (bounded: at
 * most the per-session cap of tiny reads, once per dir per process), so a
 * restarted writer's seqs stay ABOVE every surviving record's seq.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR,
	recordStageBDispatchBindings,
	STAGE_B_BINDING_TTL_MS,
	_internals as storeInternals,
} from '../../../src/background/stage-b-dispatch-binding-store';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const MAP_FIFO_BOUND = 512;

let dir = '';
const SESSION = 'sess-r16-restart';

beforeEach(() => {
	dir = canonicalMkdtemp('stage-b-restart-r16-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function recordPathFor(sessionID: string, callID: string): string {
	return storeInternals.recordPath(dir, sessionID, callID);
}

function record(
	sessionID: string,
	callID: string,
	nowMs: () => number,
): boolean {
	return recordStageBDispatchBindings(
		dir,
		{
			sessionID,
			callID,
			bindings: [{ taskId: '1.1', generation: 1 }],
		},
		{ nowMs },
	);
}

function readSeq(filePath: string): number {
	return (JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { seq: number })
		.seq;
}

function pinMtime(filePath: string, mtimeMs: number): void {
	const at = new Date(mtimeMs);
	fs.utimesSync(filePath, at, at);
}

/**
 * Deterministic in-process restart: flush the target dir's entry out of the
 * in-memory seq map (FIFO bound) via distinct throwaway session dirs. Their
 * records are pinned OLDER than the target dir's so the cross-dir LRU sweep
 * never reaps the target dir itself (same seam as the r15 test).
 */
function simulateRestart(targetNewestMtime: number, clock: number): void {
	withFrozenClock(
		() => {
			for (let d = 0; d < MAP_FIFO_BOUND; d++) {
				const dummy = `sess-r16-dummy-${d}`;
				expect(record(dummy, 'call-1', () => clock)).toBe(true);
				pinMtime(recordPathFor(dummy, 'call-1'), clock - 200_000);
			}
		},
		{ fixedNow: clock },
	);
	// The target dir's records are newer than every dummy's — the sweep
	// removes dummies, never the target (asserted by the target surviving).
	expect(fs.existsSync(recordPathFor(SESSION, 'old-0'))).toBe(true);
	void targetNewestMtime;
}

describe('stage-b-dispatch-binding-store — eviction order under IDENTICAL mtimes across a restart (r16)', () => {
	it('never evicts post-restart records while retaining pre-restart records at one shared mtime', () => {
		const W = Date.now();
		const cap = MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR; // 128
		const T = W; // the shared coarse mtime tick

		// Pre-heat the in-memory counter ABOVE the wall clock (a same-tick
		// burst of throwaway writes), then delete the throwaways: the
		// counter stays at W+69 while the dir is empty.
		withFrozenClock(
			() => {
				for (let i = 0; i < 70; i++) {
					expect(record(SESSION, `heat-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);
		for (let i = 0; i < 70; i++) {
			fs.rmSync(recordPathFor(SESSION, `heat-${i}`), { force: true });
		}

		// Pre-restart burst: 80 records at one frozen tick — their seqs
		// (W+70..W+149) all sit ABOVE the wall clock. No cap eviction happens
		// (the dir never exceeds the cap).
		withFrozenClock(
			() => {
				for (let i = 0; i < 80; i++) {
					expect(record(SESSION, `old-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);
		expect(readSeq(recordPathFor(SESSION, 'old-0'))).toBe(W + 70);
		expect(readSeq(recordPathFor(SESSION, 'old-79'))).toBe(W + 149);
		for (let i = 0; i < 80; i++) {
			pinMtime(recordPathFor(SESSION, `old-${i}`), T);
		}

		// Restart (in-memory seq map entry for this dir is gone).
		simulateRestart(T, W);

		// Post-restart burst: 10 records at a frozen clock only 50 ms past W.
		// Pre-repair, the wall-clock floor gives them seqs W+50..W+59 —
		// BELOW every surviving pre-restart seq. The dir stays under the
		// cap, so no in-write pruning can interfere with the pinned state.
		withFrozenClock(
			() => {
				for (let j = 1; j <= 10; j++) {
					expect(record(SESSION, `new-${j}`, () => W + 50)).toBe(true);
				}
			},
			{ fixedNow: W + 50 },
		);
		for (let j = 1; j <= 10; j++) {
			pinMtime(recordPathFor(SESSION, `new-${j}`), T);
		}

		// Push the dir over the cap with hand-written later-burst records
		// (seqs far above everything, same shared mtime). These represent a
		// subsequent same-tick burst on the coarse filesystem; they are the
		// NEWEST writes and must be the safest from eviction.
		const sessionDir = path.dirname(recordPathFor(SESSION, 'old-0'));
		const extras = 45;
		for (let e = 0; e < extras; e++) {
			const filePath = path.join(sessionDir, `extra-${e}.json`);
			fs.writeFileSync(
				filePath,
				JSON.stringify({
					schemaVersion: 1,
					sessionID: SESSION,
					callID: `extra-${e}`,
					recordedAt: W,
					seq: W + 300 + e,
					bindings: [{ taskId: '9.9', generation: 1 }],
				}),
			);
			pinMtime(filePath, T);
		}

		// THE decisive prune: 135 fresh candidates (> 128 cap) that ALL
		// share the same mtime — the sort falls through to seq, exactly the
		// coarse-filesystem condition. It must evict 7 records, and they
		// must be the 7 OLDEST by write order (pre-restart), never the
		// post-restart records.
		storeInternals.pruneSessionDir(dir, SESSION, W + 60_000);

		for (let j = 1; j <= 10; j++) {
			expect(
				fs.existsSync(recordPathFor(SESSION, `new-${j}`)),
				`post-restart record new-${j} must survive the cap eviction`,
			).toBe(true);
		}
		// The later-burst extras are the newest writes — all survive.
		for (let e = 0; e < extras; e++) {
			expect(fs.existsSync(path.join(sessionDir, `extra-${e}.json`))).toBe(
				true,
			);
		}
		// The eviction consumed 7 pre-restart records (the oldest by the
		// continued seq order) and the dir is back at the cap.
		let evictedOld = 0;
		for (let i = 0; i < 80; i++) {
			if (!fs.existsSync(recordPathFor(SESSION, `old-${i}`))) evictedOld++;
		}
		expect(evictedOld).toBe(135 - cap);
		const remaining = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith('.json'));
		expect(remaining.length).toBe(cap);
	});

	it('a restarted writer continues the seq ABOVE every surviving record (bounded reconstruction)', () => {
		const W = Date.now();

		// Pre-heat + 3 real records: seqs W+100..W+102, all above the wall clock.
		withFrozenClock(
			() => {
				for (let i = 0; i < 100; i++) {
					expect(record(SESSION, `heat-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);
		for (let i = 0; i < 100; i++) {
			fs.rmSync(recordPathFor(SESSION, `heat-${i}`), { force: true });
		}
		withFrozenClock(
			() => {
				for (let i = 0; i < 3; i++) {
					expect(record(SESSION, `old-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);
		const maxOldSeq = readSeq(recordPathFor(SESSION, 'old-2'));
		expect(maxOldSeq).toBe(W + 102);

		simulateRestart(W, W);

		// Post-restart write at a frozen clock BELOW the surviving seqs: the
		// wall-clock floor alone would give W+50 — the reconstruction must
		// continue above W+102 instead.
		withFrozenClock(
			() => {
				expect(record(SESSION, 'new-1', () => W + 50)).toBe(true);
			},
			{ fixedNow: W + 50 },
		);
		const newSeq = readSeq(recordPathFor(SESSION, 'new-1'));
		expect(newSeq).toBeGreaterThan(maxOldSeq);
	});

	it('a symlinked .json never leaks or damages the external target during pruning', () => {
		const W = Date.now();
		// A few genuine fresh records.
		withFrozenClock(
			() => {
				for (let i = 0; i < 3; i++) {
					expect(record(SESSION, `real-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);

		// An external file OUTSIDE the store with distinctive content and a
		// stale mtime (beyond the 24 h TTL)...
		const external = path.join(dir, 'external-target.txt');
		const externalContent = 'EXTERNAL_SECRET_CONTENT_§$%& must survive';
		fs.writeFileSync(external, externalContent, 'utf-8');
		const staleAt = new Date(W - STAGE_B_BINDING_TTL_MS - 3_600_000);
		fs.utimesSync(external, staleAt, staleAt);

		// ...planted as a .json symlink inside the session dir.
		const sessionDir = path.dirname(recordPathFor(SESSION, 'real-0'));
		const plantedLink = path.join(sessionDir, 'planted.json');
		fs.symlinkSync(external, plantedLink);

		// A SECOND symlink whose external target is FRESH: statSync follows
		// it for the TTL check (documented behavior), so it counts as a
		// fresh candidate and is not TTL-pruned.
		const externalFresh = path.join(dir, 'external-fresh.txt');
		fs.writeFileSync(externalFresh, 'FRESH_EXTERNAL', 'utf-8');
		const freshLink = path.join(sessionDir, 'planted-fresh.json');
		fs.symlinkSync(externalFresh, freshLink);

		storeInternals.pruneSessionDir(dir, SESSION, W);

		// The stale link was TTL-pruned — but only the LINK is unlinked.
		expect(fs.existsSync(plantedLink)).toBe(false);
		// The external files are untouched: same bytes, still present.
		expect(fs.readFileSync(external, 'utf-8')).toBe(externalContent);
		expect(fs.readFileSync(externalFresh, 'utf-8')).toBe('FRESH_EXTERNAL');
		// The fresh link survived as a candidate (stat follows it).
		expect(fs.existsSync(freshLink)).toBe(true);
		// The genuine records survive.
		for (let i = 0; i < 3; i++) {
			expect(fs.existsSync(recordPathFor(SESSION, `real-${i}`))).toBe(true);
		}
	});
});
