/**
 * Bounded session-keyed candidate queue (issue #1821, Workstream B, Task 1).
 *
 * Covers the invariant-8 obligations: every cap is exercised INDEPENDENTLY, key
 * eviction past MAX_TRACKED_SESSIONS is proven, and sessions cannot see each
 * other's candidates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { InsightCandidate } from '../../../src/hooks/micro-reflector.js';
import {
	MAX_SOURCE_KNOWLEDGE_IDS,
	unionInsightMarker,
} from '../../../src/hooks/micro-reflector.js';
import {
	_internals,
	computeArrivalVelocity,
	enqueueCandidate,
	getQueueDepth,
	getQueueStats,
	getTrackedSessionCount,
	MAX_TRACKED_SESSIONS,
	recordRetry,
	requeueCandidate,
	reserveLlmBudget,
	resetSessionQueue,
	takeDrainBatch,
} from '../../../src/learning/candidate-queue.js';

function candidate(lesson: string): InsightCandidate {
	return {
		lesson,
		category: 'testing',
		tags: [],
		applies_to_agents: ['coder'],
		required_actions: ['run the failing test before finishing'],
		source: {
			kind: 'micro_reflection',
			task_id: 't-1',
			agent: 'coder',
			outcome: 'failure_test',
			trajectory_steps: 3,
		},
		created_at: '2026-01-01T00:00:00.000Z',
	};
}

const realNow = _internals.now;

beforeEach(() => {
	resetSessionQueue();
	_internals.now = realNow;
});

afterEach(() => {
	resetSessionQueue();
	_internals.now = realNow;
});

describe('enqueueCandidate — max_queue_size cap (drop-oldest)', () => {
	it('drops the OLDEST candidate and counts the drop when flooded', () => {
		for (let i = 0; i < 10; i++) {
			enqueueCandidate('s1', candidate(`lesson number ${i} about testing`), {
				maxQueueSize: 3,
			});
		}
		const stats = getQueueStats('s1');
		expect(stats.depth).toBe(3);
		expect(stats.dropped).toBe(7);

		// The survivors must be the NEWEST three, proving drop-oldest (not
		// drop-newest): a newer observation better reflects current agent state.
		const batch = takeDrainBatch('s1', 3);
		expect(batch.map((b) => b.candidate.lesson)).toEqual([
			'lesson number 7 about testing',
			'lesson number 8 about testing',
			'lesson number 9 about testing',
		]);
	});

	it('reports evictedOldest only on the enqueue that actually evicted', () => {
		const first = enqueueCandidate('s1', candidate('first lesson here now'), {
			maxQueueSize: 1,
		});
		expect(first.evictedOldest).toBe(false);
		const second = enqueueCandidate('s1', candidate('second lesson here now'), {
			maxQueueSize: 1,
		});
		expect(second.evictedOldest).toBe(true);
		expect(second.dropped).toBe(1);
	});

	it('rejects an empty session id rather than creating an unkeyed queue', () => {
		const result = enqueueCandidate('', candidate('a lesson about things'), {
			maxQueueSize: 5,
		});
		expect(result.enqueued).toBe(false);
		expect(getTrackedSessionCount()).toBe(0);
	});
});

describe('session isolation', () => {
	it('keeps candidates, drops, and budgets per session', () => {
		enqueueCandidate('alpha', candidate('alpha lesson about testing'), {
			maxQueueSize: 5,
		});
		enqueueCandidate('beta', candidate('beta lesson about testing'), {
			maxQueueSize: 5,
		});
		enqueueCandidate('beta', candidate('beta second lesson testing'), {
			maxQueueSize: 5,
		});

		expect(getQueueDepth('alpha')).toBe(1);
		expect(getQueueDepth('beta')).toBe(2);

		const drained = takeDrainBatch('alpha', 5);
		expect(drained).toHaveLength(1);
		expect(drained[0].candidate.lesson).toBe('alpha lesson about testing');
		// Draining alpha must not touch beta.
		expect(getQueueDepth('beta')).toBe(2);
	});

	it('resetSessionQueue(id) clears only that session', () => {
		enqueueCandidate('alpha', candidate('alpha lesson about testing'), {
			maxQueueSize: 5,
		});
		enqueueCandidate('beta', candidate('beta lesson about testing'), {
			maxQueueSize: 5,
		});
		resetSessionQueue('alpha');
		expect(getQueueDepth('alpha')).toBe(0);
		expect(getQueueDepth('beta')).toBe(1);
	});
});

describe('MAX_TRACKED_SESSIONS — FIFO key eviction (invariant 8)', () => {
	it('evicts the oldest session key once the map exceeds the cap', () => {
		for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
			enqueueCandidate(`s-${i}`, candidate(`lesson ${i} about testing here`), {
				maxQueueSize: 2,
			});
		}
		expect(getTrackedSessionCount()).toBe(MAX_TRACKED_SESSIONS);
		expect(getQueueDepth('s-0')).toBe(1);

		// One past the cap: the FIRST-inserted key is evicted, the new one survives.
		enqueueCandidate('overflow', candidate('overflow lesson about testing'), {
			maxQueueSize: 2,
		});
		expect(getTrackedSessionCount()).toBe(MAX_TRACKED_SESSIONS);
		expect(getQueueDepth('s-0')).toBe(0);
		expect(getQueueDepth('overflow')).toBe(1);
		expect(getQueueDepth(`s-${MAX_TRACKED_SESSIONS - 1}`)).toBe(1);
	});
});

describe('reserveLlmBudget — call and token caps enforced INDEPENDENTLY', () => {
	beforeEach(() => {
		enqueueCandidate('s1', candidate('a lesson about testing here'), {
			maxQueueSize: 5,
		});
	});

	it('stops at the CALL ceiling even with token headroom to spare', () => {
		const limits = { maxLlmCallsPerSession: 2, maxTokensPerSession: 1_000_000 };
		expect(reserveLlmBudget('s1', 1, limits)).toBe(true);
		expect(reserveLlmBudget('s1', 1, limits)).toBe(true);
		expect(reserveLlmBudget('s1', 1, limits)).toBe(false);
		expect(getQueueStats('s1').llmCallsUsed).toBe(2);
	});

	it('stops at the TOKEN ceiling even with call headroom to spare', () => {
		const limits = { maxLlmCallsPerSession: 1000, maxTokensPerSession: 250 };
		expect(reserveLlmBudget('s1', 100, limits)).toBe(true);
		expect(reserveLlmBudget('s1', 100, limits)).toBe(true);
		// Third would reach 300 > 250 — refused, and NOT partially charged.
		expect(reserveLlmBudget('s1', 100, limits)).toBe(false);
		expect(getQueueStats('s1').tokensUsed).toBe(200);
		expect(getQueueStats('s1').llmCallsUsed).toBe(2);
	});

	it('treats a zero call ceiling as "LLM admission disabled"', () => {
		expect(
			reserveLlmBudget('s1', 10, {
				maxLlmCallsPerSession: 0,
				maxTokensPerSession: 1000,
			}),
		).toBe(false);
	});

	it('treats a zero token ceiling as "LLM admission disabled"', () => {
		expect(
			reserveLlmBudget('s1', 10, {
				maxLlmCallsPerSession: 10,
				maxTokensPerSession: 0,
			}),
		).toBe(false);
	});

	it('refuses budget for an unknown session', () => {
		expect(
			reserveLlmBudget('never-seen', 10, {
				maxLlmCallsPerSession: 10,
				maxTokensPerSession: 1000,
			}),
		).toBe(false);
	});
});

describe('takeDrainBatch / requeueCandidate', () => {
	it('takes the oldest N and increments each item attempt counter', () => {
		for (let i = 0; i < 5; i++) {
			enqueueCandidate('s1', candidate(`lesson ${i} about testing here`), {
				maxQueueSize: 10,
			});
		}
		const batch = takeDrainBatch('s1', 2);
		expect(batch.map((b) => b.candidate.lesson)).toEqual([
			'lesson 0 about testing here',
			'lesson 1 about testing here',
		]);
		expect(batch.every((b) => b.attempts === 1)).toBe(true);
		expect(getQueueDepth('s1')).toBe(3);
	});

	it('never takes more than the queue holds', () => {
		enqueueCandidate('s1', candidate('only lesson about testing'), {
			maxQueueSize: 10,
		});
		expect(takeDrainBatch('s1', 50)).toHaveLength(1);
		expect(takeDrainBatch('s1', 50)).toHaveLength(0);
	});

	it('requeues to the FRONT so a deferred candidate is retried first', () => {
		enqueueCandidate('s1', candidate('first lesson about testing'), {
			maxQueueSize: 10,
		});
		const [taken] = takeDrainBatch('s1', 1);
		enqueueCandidate('s1', candidate('newer lesson about testing'), {
			maxQueueSize: 10,
		});
		requeueCandidate('s1', taken, { maxQueueSize: 10 });

		const batch = takeDrainBatch('s1', 2);
		expect(batch[0].candidate.lesson).toBe('first lesson about testing');
		expect(batch[1].candidate.lesson).toBe('newer lesson about testing');
	});

	it('requeue respects max_queue_size by dropping the NEWEST tail', () => {
		enqueueCandidate('s1', candidate('deferred lesson about testing'), {
			maxQueueSize: 2,
		});
		const [taken] = takeDrainBatch('s1', 1);
		enqueueCandidate('s1', candidate('newer one about testing here'), {
			maxQueueSize: 2,
		});
		enqueueCandidate('s1', candidate('newer two about testing here'), {
			maxQueueSize: 2,
		});
		requeueCandidate('s1', taken, { maxQueueSize: 2 });

		const batch = takeDrainBatch('s1', 5);
		// The requeued item already consumed budget, so it survives; the newest
		// tail entry is the one discarded.
		expect(batch.map((b) => b.candidate.lesson)).toEqual([
			'deferred lesson about testing',
			'newer one about testing here',
		]);
		expect(getQueueStats('s1').dropped).toBe(1);
	});

	it('requeue on an unknown session is a no-op rather than a resurrection', () => {
		enqueueCandidate('s1', candidate('a lesson about testing here'), {
			maxQueueSize: 5,
		});
		const [taken] = takeDrainBatch('s1', 1);
		resetSessionQueue('s1');
		requeueCandidate('s1', taken, { maxQueueSize: 5 });
		expect(getQueueDepth('s1')).toBe(0);
	});
});

describe('recordRetry', () => {
	it('accumulates the session retry counter', () => {
		enqueueCandidate('s1', candidate('a lesson about testing here'), {
			maxQueueSize: 5,
		});
		expect(recordRetry('s1')).toBe(1);
		expect(recordRetry('s1')).toBe(2);
		expect(getQueueStats('s1').retriesUsed).toBe(2);
	});

	it('returns 0 for an unknown session', () => {
		expect(recordRetry('nope')).toBe(0);
	});
});

describe('getQueueStats', () => {
	it('returns a zeroed record for an unknown session', () => {
		expect(getQueueStats('unknown')).toEqual({
			depth: 0,
			dropped: 0,
			llmCallsUsed: 0,
			tokensUsed: 0,
			retriesUsed: 0,
			lastDrainAt: 0,
			enqueuedSinceLastDrain: 0,
		});
	});

	it('resets the velocity numerator but NOT the drop counter on drain', () => {
		for (let i = 0; i < 4; i++) {
			enqueueCandidate('s1', candidate(`lesson ${i} about testing here`), {
				maxQueueSize: 2,
			});
		}
		expect(getQueueStats('s1').enqueuedSinceLastDrain).toBe(4);
		expect(getQueueStats('s1').dropped).toBe(2);
		takeDrainBatch('s1', 1);
		expect(getQueueStats('s1').enqueuedSinceLastDrain).toBe(0);
		// Drops are cumulative for the session — a drain must not hide them.
		expect(getQueueStats('s1').dropped).toBe(2);
	});
});

describe('computeArrivalVelocity', () => {
	it('converts arrivals-per-interval into arrivals-per-second', () => {
		const stats = {
			depth: 4,
			dropped: 0,
			llmCallsUsed: 0,
			tokensUsed: 0,
			retriesUsed: 0,
			lastDrainAt: 1_000,
			enqueuedSinceLastDrain: 4,
		};
		// 4 arrivals across 2000 ms = 2/s.
		expect(computeArrivalVelocity(stats, 3_000)).toBe(2);
	});

	it('returns 0 rather than Infinity when no time has elapsed', () => {
		const stats = {
			depth: 1,
			dropped: 0,
			llmCallsUsed: 0,
			tokensUsed: 0,
			retriesUsed: 0,
			lastDrainAt: 5_000,
			enqueuedSinceLastDrain: 3,
		};
		expect(computeArrivalVelocity(stats, 5_000)).toBe(0);
		expect(computeArrivalVelocity(stats, 4_000)).toBe(0);
	});
});

describe('unionInsightMarker — bounded source_knowledge_ids', () => {
	it('appends a new marker below the cap', () => {
		expect(unionInsightMarker(['task:t-1'], 'insight:ic_a')).toEqual([
			'task:t-1',
			'insight:ic_a',
		]);
	});

	it('is idempotent for a marker already present', () => {
		const existing = ['task:t-1', 'insight:ic_a'];
		expect(unionInsightMarker(existing, 'insight:ic_a')).toEqual(existing);
	});

	it('handles an absent array', () => {
		expect(unionInsightMarker(undefined, 'insight:ic_a')).toEqual([
			'insight:ic_a',
		]);
	});

	it('evicts the OLDEST insight markers once over the cap', () => {
		// `source_knowledge_ids` is exempt from the store's write-path array cap,
		// so an entry reinforced by many distinct candidates would otherwise grow
		// this array forever (invariant 8).
		const full = Array.from(
			{ length: MAX_SOURCE_KNOWLEDGE_IDS },
			(_, i) => `insight:ic_${i}`,
		);
		const result = unionInsightMarker(full, 'insight:ic_new');
		expect(result).toHaveLength(MAX_SOURCE_KNOWLEDGE_IDS);
		expect(result).not.toContain('insight:ic_0');
		expect(result).toContain('insight:ic_1');
		expect(result).toContain('insight:ic_new');
	});

	it('NEVER evicts non-insight ids, even when that leaves the array over cap', () => {
		// `skill-invalidator.ts` walks these to retire skills whose source entry was
		// archived; dropping one would leave a stale generated skill live.
		const taskIds = Array.from(
			{ length: MAX_SOURCE_KNOWLEDGE_IDS },
			(_, i) => `task:t-${i}`,
		);
		const result = unionInsightMarker(taskIds, 'insight:ic_new');
		expect(result).toHaveLength(MAX_SOURCE_KNOWLEDGE_IDS + 1);
		for (const id of taskIds) expect(result).toContain(id);
		expect(result).toContain('insight:ic_new');
	});

	it('evicts only as many insight markers as the overflow requires', () => {
		const mixed = [
			...Array.from({ length: 10 }, (_, i) => `task:t-${i}`),
			...Array.from(
				{ length: MAX_SOURCE_KNOWLEDGE_IDS - 10 },
				(_, i) => `insight:ic_${i}`,
			),
		];
		const result = unionInsightMarker(mixed, 'insight:ic_new');
		expect(result).toHaveLength(MAX_SOURCE_KNOWLEDGE_IDS);
		expect(result).not.toContain('insight:ic_0');
		expect(result).toContain('insight:ic_1');
		expect(result.filter((id) => id.startsWith('task:'))).toHaveLength(10);
	});
});
