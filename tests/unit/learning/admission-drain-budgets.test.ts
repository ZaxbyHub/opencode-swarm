/**
 * Bounded drain semantics — budget enforcement
 * (issue #1821, Workstream B, Task 2).
 *
 * `max_drain_wall_time_ms` stops the drain from STARTING new work; it never
 * interrupts work in flight, because the knowledge-store transaction must never
 * be abandoned while holding the `.swarm/` directory lock.
 *
 * Admission outcomes and LLM cancellation live in `admission-drain.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import { drainSessionQueue } from '../../../src/learning/admission.js';
import {
	enqueueCandidate,
	getQueueDepth,
	MAX_CANDIDATE_DRAIN_ATTEMPTS,
	resetSessionQueue,
} from '../../../src/learning/candidate-queue.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	admissionConfig,
	baseDeps,
	candidate,
	storedEntries as readStored,
} from './_admission-fixtures.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('admission-budget-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	resetSessionQueue();
});

afterEach(() => {
	resetSessionQueue();
	fs.rmSync(dir, { recursive: true, force: true });
});

const storedEntries = () => readStored(dir);

describe('drainSessionQueue — retry exhaustion', () => {
	it('abandons a candidate after max_retries_per_candidate and never spins', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		let calls = 0;
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({ max_retries_per_candidate: 2 }),
			{
				...baseDeps(),
				llmDelegate: async () => {
					calls++;
					throw new Error('provider exploded');
				},
			},
		);
		// 1 initial attempt + 2 retries = 3 calls, then handed back to the queue.
		expect(calls).toBe(3);
		expect(summary.retries).toBe(2);
		expect(summary.admitted).toBe(0);
		expect(await storedEntries()).toHaveLength(0);
		// REQUEUED, not dropped. The dominant real failure here is a transient
		// `ELOCKED` on the shared `.swarm/` directory lock; discarding the
		// candidate would lose the lesson outright, and for a PRM-sourced
		// candidate the cooldown would then suppress the same pattern for 15 min.
		expect(summary.deferred).toBe(1);
		expect(summary.failed).toBe(0);
		expect(getQueueDepth('s1')).toBe(1);
	});

	it('eventually ABANDONS a permanently failing candidate rather than looping', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{ maxQueueSize: 50 },
		);
		const cfg = admissionConfig({ max_retries_per_candidate: 0 });
		const alwaysThrows = {
			...baseDeps(),
			llmDelegate: async () => {
				throw new Error('provider permanently down');
			},
		};

		let deferred = 0;
		let failed = 0;
		for (let i = 0; i < MAX_CANDIDATE_DRAIN_ATTEMPTS + 2; i++) {
			if (getQueueDepth('s1') === 0) break;
			const summary = await drainSessionQueue(dir, 's1', cfg, alwaysThrows);
			deferred += summary.deferred;
			failed += summary.failed;
		}
		// Requeued until the per-candidate drain-attempt ceiling, then dropped —
		// so a permanently broken provider cannot spin the queue forever.
		expect(deferred).toBe(MAX_CANDIDATE_DRAIN_ATTEMPTS - 1);
		expect(failed).toBe(1);
		expect(getQueueDepth('s1')).toBe(0);
	});

	it('makes exactly one attempt when retries are disabled', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		let calls = 0;
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({ max_retries_per_candidate: 0 }),
			{
				...baseDeps(),
				llmDelegate: async () => {
					calls++;
					throw new Error('provider exploded');
				},
			},
		);
		expect(calls).toBe(1);
		expect(summary.retries).toBe(0);
		// One attempt, then handed back for the next drain (see above).
		expect(summary.deferred).toBe(1);
		expect(getQueueDepth('s1')).toBe(1);
	});
});

describe('drainSessionQueue — wall-time budget', () => {
	it('stops starting new candidates once the budget elapses, and requeues them', async () => {
		for (let i = 0; i < 4; i++) {
			enqueueCandidate(
				's1',
				candidate(`Distinct lesson number ${i} about verifying builds`),
				{
					maxQueueSize: 50,
				},
			);
		}

		// A controllable clock: the budget expires after the FIRST candidate.
		let clock = 0;
		const now = () => clock;
		let admissions = 0;

		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({
				max_drain_wall_time_ms: 100,
				max_concurrent_admissions: 1,
				min_drain: 4,
				max_drain: 4,
			}),
			{
				...baseDeps(),
				now,
				llmDelegate: async () => {
					admissions++;
					// The first candidate's work pushes the clock past the deadline.
					clock += 500;
					return 'ADMIT';
				},
			},
		);

		// Exactly one candidate ran; the rest were deferred BETWEEN candidates.
		expect(admissions).toBe(1);
		expect(summary.admitted).toBe(1);
		expect(summary.deferred).toBe(3);
		// Deferred candidates go back on the queue for the next drain — they are
		// never dropped, and the in-flight one was never interrupted.
		expect(getQueueDepth('s1')).toBe(3);
		expect(await storedEntries()).toHaveLength(1);
	});

	it('lets an in-flight candidate finish and COMMIT past the budget', async () => {
		// The knowledge-store transaction is never raced or cancelled, so a
		// candidate that started before the deadline must still reach the store.
		// Asserted on the PERSISTED entry, not on a local flag: a local boolean
		// would be unfalsifiable here because nothing in the drain can interrupt
		// in-flight work in the first place.
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{ maxQueueSize: 50 },
		);
		// Clock: 0 for the velocity sample and for `startedAt`, so the deadline is
		// 50 ms and the FIRST candidate is allowed to start; it then overruns.
		let ticks = 0;
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({
				max_drain_wall_time_ms: 50,
				per_candidate_llm_timeout_ms: 0,
			}),
			{
				...baseDeps(),
				now: () => (++ticks <= 3 ? 0 : 10_000),
			},
		);
		expect(summary.admitted).toBe(1);
		expect(summary.deferred).toBe(0);
		expect(await storedEntries()).toHaveLength(1);
	});

	it('treats max_drain_wall_time_ms = 0 as no wall-clock bound', async () => {
		for (let i = 0; i < 3; i++) {
			enqueueCandidate(
				's1',
				candidate(`Another distinct lesson ${i} about verifying builds`),
				{
					maxQueueSize: 50,
				},
			);
		}
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({
				max_drain_wall_time_ms: 0,
				min_drain: 3,
				max_drain: 3,
			}),
			{ ...baseDeps(), now: () => 10_000_000 },
		);
		expect(summary.deferred).toBe(0);
		expect(summary.admitted).toBe(3);
	});
});

describe('drainSessionQueue — requeue cannot loop forever', () => {
	it('abandons a candidate after MAX_CANDIDATE_DRAIN_ATTEMPTS deferrals', async () => {
		// A session whose wall-clock budget always expires would otherwise bounce
		// the same candidate between drains indefinitely: the per-candidate RETRY
		// cap is never reached because no attempt ever starts.
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{ maxQueueSize: 50 },
		);
		const cfg = admissionConfig({ max_drain_wall_time_ms: 1 });

		let deferrals = 0;
		let abandoned = 0;
		for (let i = 0; i < MAX_CANDIDATE_DRAIN_ATTEMPTS + 2; i++) {
			if (getQueueDepth('s1') === 0) break;
			// The clock reads 0 for the velocity sample and for `startedAt`, then
			// jumps past the deadline — so every candidate finds the budget already
			// spent and is deferred without starting work.
			let ticks = 0;
			const summary = await drainSessionQueue(dir, 's1', cfg, {
				...baseDeps(),
				now: () => (++ticks <= 2 ? 0 : 1_000_000),
			});
			deferrals += summary.deferred;
			abandoned += summary.failed;
		}

		expect(deferrals).toBe(MAX_CANDIDATE_DRAIN_ATTEMPTS - 1);
		expect(abandoned).toBe(1);
		// The queue drains to empty rather than looping forever.
		expect(getQueueDepth('s1')).toBe(0);
		expect(await storedEntries()).toHaveLength(0);
	});
});

describe('drainSessionQueue — concurrency bound', () => {
	it('never runs more admissions at once than max_concurrent_admissions', async () => {
		for (let i = 0; i < 6; i++) {
			enqueueCandidate(
				's1',
				candidate(`Unique lesson ${i} about verifying build output`),
				{
					maxQueueSize: 50,
				},
			);
		}
		let inFlight = 0;
		let peak = 0;
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({
				max_concurrent_admissions: 2,
				min_drain: 6,
				max_drain: 6,
			}),
			{
				...baseDeps(),
				llmDelegate: async () => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await Bun.sleep(5);
					inFlight--;
					return 'ADMIT';
				},
			},
		);
		expect(summary.attempted).toBe(6);
		expect(peak).toBeLessThanOrEqual(2);
		expect(peak).toBeGreaterThan(1);
	});
});

describe('drainSessionQueue — wall-clock budget bounds the LLM deadline (C1)', () => {
	it('caps a hung screening call at the REMAINING budget, not the per-candidate timeout', async () => {
		// Regression: the wall-clock budget is only checked BETWEEN candidates, so
		// before this fix N candidates each burned a full
		// `per_candidate_llm_timeout_ms` (schema default 60 s, doubled by the
		// default single retry) while `tool.execute.after` awaited the drain —
		// ~120 s of blocking against a nominal 10 s budget. The screening deadline
		// is now min(per-candidate timeout, remaining budget).
		for (let i = 0; i < 3; i++) {
			enqueueCandidate(
				's1',
				candidate(`Distinct lesson ${i} about verifying build output first`),
				{ maxQueueSize: 50 },
			);
		}

		const deadlines: number[] = [];
		const started = Date.now();
		await drainSessionQueue(
			dir,
			's1',
			admissionConfig({
				max_drain_wall_time_ms: 120,
				// Far larger than the budget — the budget must win.
				per_candidate_llm_timeout_ms: 60_000,
				max_retries_per_candidate: 0,
				max_concurrent_admissions: 1,
				min_drain: 3,
				max_drain: 3,
			}),
			{
				...baseDeps(),
				llmDelegate: async (_s: string, _p: string, signal?: AbortSignal) => {
					deadlines.push(Date.now() - started);
					// Never resolves on its own — only the forwarded signal can end it.
					await new Promise((_r, reject) => {
						signal?.addEventListener('abort', () =>
							reject(signal.reason ?? new Error('aborted')),
						);
					});
					return 'ADMIT';
				},
			},
		);
		const elapsed = Date.now() - started;

		// Without the fix this would be 3 x 60 000 ms. Generous upper bound so the
		// assertion is about the ORDER OF MAGNITUDE, not scheduler jitter.
		expect(elapsed).toBeLessThan(5_000);
		expect(deadlines.length).toBeGreaterThan(0);
	});
});
