/**
 * Bounded drain semantics — admission outcomes and LLM cancellation
 * (issue #1821, Workstream B, Task 2).
 *
 * The bounding rule under test: `withTimeout` is a `Promise.race` that does NOT
 * cancel, so the knowledge-store transaction is never raced. Only the
 * cancellable LLM call is bounded, via `AbortSignal.timeout`.
 *
 * Budget enforcement (retries, wall clock, requeue bound, concurrency) lives in
 * `admission-drain-budgets.test.ts`.
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
	getQueueStats,
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
	dir = canonicalMkdtemp('admission-drain-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	resetSessionQueue();
});

afterEach(() => {
	resetSessionQueue();
	fs.rmSync(dir, { recursive: true, force: true });
});

const storedEntries = () => readStored(dir);

describe('drainSessionQueue — happy path', () => {
	it('admits the drained batch into the knowledge store', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		enqueueCandidate(
			's1',
			candidate('Run the linter before declaring styling complete'),
			{
				maxQueueSize: 50,
			},
		);

		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig(),
			baseDeps(),
		);
		expect(summary.attempted).toBe(2);
		expect(summary.admitted).toBe(2);
		expect(await storedEntries()).toHaveLength(2);
		expect(getQueueDepth('s1')).toBe(0);
	});

	it('is a no-op for an empty queue and never touches the store', async () => {
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig(),
			baseDeps(),
		);
		expect(summary.attempted).toBe(0);
		expect(fs.existsSync(resolveSwarmKnowledgePath(dir))).toBe(false);
	});

	it('does nothing when the feature is disabled', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({ enabled: false }),
			baseDeps(),
		);
		expect(summary.attempted).toBe(0);
		// The candidate stays queued rather than being silently discarded.
		expect(getQueueDepth('s1')).toBe(1);
	});

	it('rejects an unactionable candidate without writing it', async () => {
		enqueueCandidate(
			's1',
			{
				...candidate('A plain prose lesson with no predicate or scope at all'),
				applies_to_agents: undefined,
				required_actions: undefined,
			},
			{ maxQueueSize: 50 },
		);
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig(),
			baseDeps(),
		);
		expect(summary.rejected).toBe(1);
		expect(await storedEntries()).toHaveLength(0);
	});
});

describe('drainSessionQueue — AbortSignal cancellation of the LLM call', () => {
	it('forwards a real abort signal and retries the cancelled candidate', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);

		const seenSignals: (AbortSignal | undefined)[] = [];
		let calls = 0;
		const llmDelegate = async (
			_system: string,
			_prompt: string,
			signal?: AbortSignal,
		): Promise<string> => {
			calls++;
			seenSignals.push(signal);
			if (calls === 1) {
				// Simulate a genuine cancellation: wait on the caller's signal.
				await new Promise((_resolve, reject) => {
					signal?.addEventListener('abort', () =>
						reject(signal.reason ?? new Error('aborted')),
					);
				});
			}
			return 'ADMIT';
		};

		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({
				per_candidate_llm_timeout_ms: 20,
				max_retries_per_candidate: 1,
			}),
			{ ...baseDeps(), llmDelegate },
		);

		// The first attempt was cancelled by AbortSignal.timeout, the retry
		// succeeded — proving the abort is real and the failure is retryable.
		expect(calls).toBe(2);
		expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
		expect(summary.retries).toBe(1);
		expect(summary.admitted).toBe(1);
		expect(getQueueStats('s1').retriesUsed).toBe(1);
	});

	it('admits without an LLM call when the per-candidate timeout is 0', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		let called = false;
		const llmDelegate = async (): Promise<string> => {
			called = true;
			return 'ADMIT';
		};
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({ per_candidate_llm_timeout_ms: 0 }),
			{ ...baseDeps(), llmDelegate },
		);
		expect(called).toBe(false);
		expect(summary.admitted).toBe(1);
	});

	it('skips the LLM entirely when max_llm_calls_per_session is 0', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		let called = false;
		const llmDelegate = async (): Promise<string> => {
			called = true;
			return 'REJECT';
		};
		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig({ max_llm_calls_per_session: 0 }),
			{ ...baseDeps(), llmDelegate },
		);
		expect(called).toBe(false);
		expect(summary.admitted).toBe(1);
	});

	it('honours a REJECT verdict from the screening call', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		const summary = await drainSessionQueue(dir, 's1', admissionConfig(), {
			...baseDeps(),
			llmDelegate: async () => 'REJECT — task specific',
		});
		expect(summary.rejected).toBe(1);
		expect(await storedEntries()).toHaveLength(0);
	});
});

describe('drainSessionQueue — provenance and fail-open screening', () => {
	it('propagates AC10 evidence POINTERS onto the STORED entry (V3)', async () => {
		// `insightCandidateToEntry` does NOT copy `source_refs`; admission is the
		// only path that writes evidence pointers onto a persisted entry. Both
		// "pointers only" assertions elsewhere inspect the in-memory candidate, so
		// without this the whole propagation could be deleted unnoticed.
		const withRefs = {
			...candidate(
				'Change approach after a repetition loop instead of retrying',
			),
			source_refs: [
				'prm:s1:repetition_loop:1-5',
				'prm:s1:repetition_loop:9-14',
			],
		};
		enqueueCandidate('s1', withRefs, { maxQueueSize: 50 });

		const summary = await drainSessionQueue(
			dir,
			's1',
			admissionConfig(),
			baseDeps(),
		);
		expect(summary.admitted).toBe(1);

		const [entry] = await storedEntries();
		expect(entry.source_refs).toEqual([
			'prm:s1:repetition_loop:1-5',
			'prm:s1:repetition_loop:9-14',
		]);
		// Pointers only — never transcript or reasoning text.
		for (const ref of entry.source_refs ?? []) {
			expect(ref).toMatch(/^prm:[^:]+:[a-z_]+:\d+-\d+$/);
		}
	});

	it('FAILS OPEN and still admits when the LLM budget is exhausted (V4)', async () => {
		// Screening is a filter, not a gate. If budget exhaustion were treated as a
		// rejection, an LLM outage or a busy session would silently stop all
		// learning — the inverse of the documented contract.
		for (let i = 0; i < 3; i++) {
			enqueueCandidate(
				's1',
				candidate(`Distinct lesson ${i} about verifying build output first`),
				{ maxQueueSize: 50 },
			);
		}
		let screened = 0;
		const summary = await drainSessionQueue(
			dir,
			's1',
			// One call of budget for three candidates.
			admissionConfig({
				max_llm_calls_per_session: 1,
				min_drain: 3,
				max_drain: 3,
				max_concurrent_admissions: 1,
			}),
			{
				...baseDeps(),
				llmDelegate: async () => {
					screened++;
					return 'ADMIT';
				},
			},
		);
		// Only one candidate could be screened, but ALL THREE are admitted.
		expect(screened).toBe(1);
		expect(summary.admitted).toBe(3);
		expect(summary.rejected).toBe(0);
		expect(await storedEntries()).toHaveLength(3);
	});
});
