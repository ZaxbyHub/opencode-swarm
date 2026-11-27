/**
 * r15 audit follow-up (P5): the persisted write-order `seq` is NOT monotonic
 * across restarts, and the cap eviction's seq-primary sort can therefore
 * evict NEWER records while retaining OLDER ones.
 *
 * `allocateSeq` computes `max(lastInMemory + 1, Date.now())`. A burst of
 * records in one millisecond tick pushes seq ABOVE the wall clock (seq W,
 * W+1, ... W+127). After a restart (empty in-memory map — or the map's own
 * 512-entry FIFO eviction), the next record's seq is `max(1, Date.now())` —
 * e.g. W+50 — STRICTLY BELOW the surviving burst records' seqs (W+51..W+127).
 * The seq-primary eviction sort then treats the newer record as older than
 * 77 pre-restart records and evicts it first.
 *
 * The repair (r15): eviction orders by mtime FIRST (the real recency signal),
 * with seq demoted to a coarse-mtime TIE-BREAKER (its originally-intended
 * role — a deterministic, roughly-write-ordered tie-break within one mtime
 * tick). The just-written record stays protected by protectPath.
 *
 * r16 follow-up: allocateSeq additionally continues the counter from the
 * dir's persisted records at a restarted writer's first allocation, so the
 * post-restart seqs stay above every surviving record's seq even when old
 * and new records share one coarse mtime tick (the identical-mtime case is
 * covered by stage-b-dispatch-binding-store-restart-seq-r16.test.ts). The
 * precondition assertion below pins that continuation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR,
	recordStageBDispatchBindings,
	_internals as storeInternals,
} from '../../../src/background/stage-b-dispatch-binding-store';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// The in-memory seq map's FIFO bound: this many DISTINCT session dirs evict
// the target dir's entry — the deterministic in-process equivalent of a
// restart (a fresh process starts with an empty map).
const MAP_FIFO_BOUND = 512;

let dir = '';
const SESSION = 'sess-r15-restart';

beforeEach(() => {
	dir = canonicalMkdtemp('stage-b-restart-r15-');
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

function readSeq(sessionID: string, callID: string): number {
	return (
		JSON.parse(fs.readFileSync(recordPathFor(sessionID, callID), 'utf-8')) as {
			seq: number;
		}
	).seq;
}

function pinMtime(filePath: string, mtimeMs: number): void {
	const at = new Date(mtimeMs);
	fs.utimesSync(filePath, at, at);
}

describe('stage-b-dispatch-binding-store — eviction order across restarts (r15 P5)', () => {
	it('never evicts newer records while retaining older ones after a restart', async () => {
		const W = Date.now();
		const cap = MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR; // 128

		// Phase A (pre-restart): a burst of `cap` records in ONE frozen
		// millisecond tick — seqs W..W+127, all pinned to one deterministic
		// mtime (W - 100s, well within the 24h TTL).
		withFrozenClock(
			() => {
				for (let i = 0; i < cap; i++) {
					expect(record(SESSION, `old-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);
		for (let i = 0; i < cap; i++) {
			pinMtime(recordPathFor(SESSION, `old-${i}`), W - 100_000);
		}
		expect(readSeq(SESSION, 'old-0')).toBe(W);
		expect(readSeq(SESSION, `old-${cap - 1}`)).toBe(W + cap - 1);

		// Restart: flush the target dir's entry out of the in-memory seq map
		// (FIFO bound) via distinct throwaway session dirs. Their records are
		// pinned OLDER than the target dir's so the cross-dir LRU sweep never
		// reaps the target dir itself.
		withFrozenClock(
			() => {
				for (let d = 0; d < MAP_FIFO_BOUND; d++) {
					const dummy = `sess-r15-dummy-${d}`;
					expect(record(dummy, 'call-1', () => W)).toBe(true);
					pinMtime(recordPathFor(dummy, 'call-1'), W - 200_000);
				}
			},
			{ fixedNow: W },
		);

		// Phase B (post-restart): 60 more records in the target dir at a
		// frozen clock only 50 ms "later". r16: allocateSeq continues the
		// counter from the dir's persisted records (bounded one-time
		// reconstruction at the first allocation per dir per process), so
		// the post-restart seqs stay ABOVE the burst's tail (W+128..)
		// instead of restarting at the wall-clock floor (W+50). Their
		// mtimes are the real (later) write times.
		let new1Seq = 0;
		withFrozenClock(
			() => {
				for (let j = 1; j <= 60; j++) {
					expect(record(SESSION, `new-${j}`, () => W + 50)).toBe(true);
					if (j === 1) {
						// Capture BEFORE later writes' prunes can evict it.
						new1Seq = readSeq(SESSION, 'new-1');
					}
				}
			},
			{ fixedNow: W + 50 },
		);

		// r16 continuation precondition proven: the first post-restart
		// record continued the burst's sequence instead of dropping to the
		// wall-clock floor (W+50, which sat below the surviving burst's
		// tail — the pre-r16 defect mechanism this test originally pinned).
		expect(new1Seq).toBe(W + 128);
		expect(new1Seq).toBeGreaterThan(readSeq(SESSION, `old-${cap - 1}`));

		// The dir is back at the cap: 128 + 60 written, 60 evicted.
		const sessionDir = path.dirname(recordPathFor(SESSION, 'old-0'));
		const remaining = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith('.json'));
		expect(remaining.length).toBe(cap);

		// THE BUG (seq-primary sort): the five oldest POST-restart records
		// (seqs W+50..W+54) sorted below pre-restart records (seqs W+55+)
		// and were evicted while 73 older records survived. Correct eviction
		// (recency) removes only pre-restart records.
		expect(fs.existsSync(recordPathFor(SESSION, 'new-1'))).toBe(true);
		expect(fs.existsSync(recordPathFor(SESSION, 'new-5'))).toBe(true);
		expect(fs.existsSync(recordPathFor(SESSION, 'new-60'))).toBe(true);

		// The oldest pre-restart records were evicted (both orders agree).
		expect(fs.existsSync(recordPathFor(SESSION, 'old-0'))).toBe(false);
		expect(fs.existsSync(recordPathFor(SESSION, 'old-59'))).toBe(false);
		// ...and the newest pre-restart record survives (both orders agree).
		expect(fs.existsSync(recordPathFor(SESSION, `old-${cap - 1}`))).toBe(true);
	});

	it('within one mtime tick, seq still breaks ties deterministically (oldest callID evicted at the cap)', () => {
		const W = Date.now();
		const cap = MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR;
		withFrozenClock(
			() => {
				for (let i = 0; i <= cap; i++) {
					expect(record(SESSION, `call-cap-${i}`, () => W)).toBe(true);
				}
			},
			{ fixedNow: W },
		);
		// All records share (roughly) one mtime tick; the seq tie-break must
		// evict the FIRST-written record, never the just-written one.
		expect(fs.existsSync(recordPathFor(SESSION, 'call-cap-0'))).toBe(false);
		expect(fs.existsSync(recordPathFor(SESSION, `call-cap-${cap}`))).toBe(true);
	});
});
