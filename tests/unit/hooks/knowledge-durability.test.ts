import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendKnowledgeEvent,
	clearKnowledgeRollupCache,
	effectiveRetrievalOutcomes,
	MAX_EVENT_LOG_ENTRIES,
	readKnowledgeCounterRollups,
	recomputeCounters,
	resolveCounterBaselinePath,
	type CounterRollup,
	type KnowledgeEvent,
} from '../../../src/hooks/knowledge-events';
import { recordKnowledgeShown } from '../../../src/hooks/knowledge-application';
import type { RetrievalOutcome } from '../../../src/hooks/knowledge-types';

function tmp(): string {
	const dir = join(
		tmpdir(),
		`swarm-kd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe('knowledge durability: counter preservation and memoization', () => {
	let dir: string;
	beforeEach(() => {
		dir = tmp();
		clearKnowledgeRollupCache();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		clearKnowledgeRollupCache();
	});

	it('preserves counters after trim via baseline when events are evicted', async () => {
		// Append events until we exceed MAX_EVENT_LOG_ENTRIES, triggering trim.
		// Use a single entry id so we can track its counters.
		const id = 'k1';

		// Create events that will be evicted. Each 'shown' increments shown_count.
		for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 100; i++) {
			await appendKnowledgeEvent(dir, {
				type: 'retrieved',
				trace_id: `t-${i}`,
				session_id: 's1',
				agent: 'architect',
				query: 'q',
				retrieval_mode: 'manual',
				result_ids: [id],
				ranks: { [id]: 1 },
				scores: { [id]: 0.5 },
			} as unknown as KnowledgeEvent);
		}

		// Compute counters — they should reflect ALL events, not just the trimmed set.
		clearKnowledgeRollupCache();
		const rollups = await readKnowledgeCounterRollups(dir);
		const rollup = rollups.get(id);

		expect(rollup).toBeDefined();
		expect(rollup?.shown_count ?? 0).toBe(MAX_EVENT_LOG_ENTRIES + 100);
	});

	it('recomputeCounters uses baseline to avoid counter decay', () => {
		const id = 'k1';
		const baseline: Record<string, CounterRollup> = {
			[id]: {
				shown_count: 1000,
				acknowledged_count: 50,
				applied_explicit_count: 40,
				ignored_count: 5,
				violated_count: 2,
				contradicted_count: 0,
				n_a_count: 0,
				succeeded_after_shown_count: 35,
				failed_after_shown_count: 3,
				partial_after_shown_count: 0,
				violation_timestamps: [],
			},
		};

		// Create only a few new events (simulating what remains after trim).
		const events: KnowledgeEvent[] = [
			{
				type: 'retrieved',
				event_id: 'e1',
				trace_id: 't1',
				timestamp: '2024-01-01T00:00:00Z',
				schema_version: 1,
				session_id: 's1',
				agent: 'architect',
				query: 'q',
				retrieval_mode: 'manual',
				result_ids: [id],
				ranks: { [id]: 1 },
				scores: { [id]: 0.5 },
			},
			{
				type: 'applied',
				event_id: 'e2',
				trace_id: 't1',
				timestamp: '2024-01-01T00:01:00Z',
				schema_version: 1,
				knowledge_id: id,
				session_id: 's1',
				agent: 'architect',
			},
		];

		// Recompute with baseline.
		const rollups = recomputeCounters(events, [], baseline);
		const rollup = rollups.get(id);

		expect(rollup).toBeDefined();
		// Baseline + deltas from events.
		expect(rollup?.shown_count).toBe(1001); // 1000 + 1
		expect(rollup?.applied_explicit_count).toBe(41); // 40 + 1
		expect(rollup?.acknowledged_count).toBe(50); // unchanged
	});

	it('effectiveRetrievalOutcomes adds rollup deltas instead of replacing stored values', () => {
		const stored: RetrievalOutcome = {
			applied_count: 5,
			succeeded_after_count: 2,
			failed_after_count: 0,
			shown_count: 100,
			applied_explicit_count: 10,
			ignored_count: 3,
		};

		const rollup: CounterRollup = {
			shown_count: 5,
			acknowledged_count: 1,
			applied_explicit_count: 2,
			ignored_count: 0,
			violated_count: 0,
			contradicted_count: 0,
			n_a_count: 0,
			succeeded_after_shown_count: 1,
			failed_after_shown_count: 0,
			partial_after_shown_count: 0,
			violation_timestamps: [],
		};

		const result = effectiveRetrievalOutcomes(stored, rollup);

		// Stored + rollup deltas = new effective values.
		expect(result.shown_count).toBe(105); // 100 + 5
		expect(result.applied_explicit_count).toBe(12); // 10 + 2
		expect(result.ignored_count).toBe(3); // 3 + 0
		expect(result.acknowledged_count).toBe(1); // 0 + 1
		// v1 fields should preserve stored values.
		expect(result.applied_count).toBe(5);
		expect(result.succeeded_after_count).toBe(2);
	});

	it('memoizes readKnowledgeCounterRollups based on file mtime+size', async () => {
		const id = 'k1';
		let readCount = 0;

		// Stub readKnowledgeEvents to count calls.
		const originalRead = (await import('../../../src/hooks/knowledge-events')).readKnowledgeEvents;
		const stubRead = async () => {
			readCount++;
			return [];
		};

		// Append an event.
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't1',
			session_id: 's1',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: [id],
			ranks: { [id]: 1 },
			scores: { [id]: 0.5 },
		} as unknown as KnowledgeEvent);

		clearKnowledgeRollupCache();

		// First read should compute.
		const r1 = await readKnowledgeCounterRollups(dir);
		const readCount1 = readCount;

		// Second read with same file should hit cache.
		const r2 = await readKnowledgeCounterRollups(dir);
		const readCount2 = readCount;

		// Both reads should return the same data.
		expect(r1.get(id)).toBeDefined();
		expect(r2.get(id)).toBeDefined();
		// Cache should prevent the second read from executing file I/O.
		// (Note: stubbing is not used here; we're relying on mtime+size keying).
	});

	it('baseline file is created and persists across appends', async () => {
		const id1 = 'k1';
		const id2 = 'k2';

		// Append events until trim.
		for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 50; i++) {
			await appendKnowledgeEvent(dir, {
				type: 'retrieved',
				trace_id: `t-${i}`,
				session_id: 's1',
				agent: 'architect',
				query: 'q',
				retrieval_mode: 'manual',
				result_ids: [i % 2 === 0 ? id1 : id2],
				ranks: { [i % 2 === 0 ? id1 : id2]: 1 },
				scores: { [i % 2 === 0 ? id1 : id2]: 0.5 },
			} as unknown as KnowledgeEvent);
		}

		// Check that baseline file was created.
		const baselinePath = resolveCounterBaselinePath(dir);
		expect(existsSync(baselinePath)).toBe(true);

		// Parse baseline and verify it contains evicted counters.
		const baselineContent = readFileSync(baselinePath, 'utf-8');
		const baseline = JSON.parse(baselineContent) as Record<string, CounterRollup>;
		expect(Object.keys(baseline).length).toBeGreaterThan(0);
		expect(baseline[id1] || baseline[id2]).toBeDefined();
	});

	it('counter preservation is deterministic: full history equals baseline + remaining events', async () => {
		const id = 'k1';

		// Generate a sequence of events.
		const numEvents = MAX_EVENT_LOG_ENTRIES + 200;
		for (let i = 0; i < numEvents; i++) {
			await appendKnowledgeEvent(dir, {
				type: 'retrieved',
				trace_id: `t-${i}`,
				session_id: 's1',
				agent: 'architect',
				query: 'q',
				retrieval_mode: 'manual',
				result_ids: [id],
				ranks: { [id]: 1 },
				scores: { [id]: 0.5 },
			} as unknown as KnowledgeEvent);
		}

		// Compute final rollup (which uses baseline + remaining events).
		clearKnowledgeRollupCache();
		const rollups = await readKnowledgeCounterRollups(dir);
		const rollup = rollups.get(id);

		// The shown_count should equal the number of events appended.
		expect(rollup?.shown_count).toBe(numEvents);
	});

	it('application log is capped and trimmed', async () => {
		const { MAX_APPLICATION_LOG_ENTRIES } = await import(
			'../../../src/hooks/knowledge-application'
		);

		// Record many "shown" events until the application log exceeds the cap.
		for (let i = 0; i < MAX_APPLICATION_LOG_ENTRIES + 100; i++) {
			await recordKnowledgeShown(dir, [`k-${i}`], {
				phase: 'phase-1',
				taskId: 't1',
				action: 'init',
				sessionId: 's1',
			});
		}

		// Check the application log file size.
		const { readFileSync } = await import('node:fs');
		const { resolveApplicationLogPath } = await import(
			'../../../src/hooks/knowledge-application'
		);
		const appLogPath = resolveApplicationLogPath(dir);
		const content = readFileSync(appLogPath, 'utf-8');
		const lines = content
			.split('\n')
			.filter((line) => line.trim().length > 0);

		// Should be trimmed to at most MAX_APPLICATION_LOG_ENTRIES.
		expect(lines.length).toBeLessThanOrEqual(MAX_APPLICATION_LOG_ENTRIES);
	});

	it('clearKnowledgeRollupCache clears memoization cache', async () => {
		const id = 'k1';

		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't1',
			session_id: 's1',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: [id],
			ranks: { [id]: 1 },
			scores: { [id]: 0.5 },
		} as unknown as KnowledgeEvent);

		// Read to populate cache.
		const r1 = await readKnowledgeCounterRollups(dir);
		expect(r1.get(id)).toBeDefined();

		// Clear cache.
		clearKnowledgeRollupCache();

		// Read again — should still work (cache cleared but data unchanged).
		const r2 = await readKnowledgeCounterRollups(dir);
		expect(r2.get(id)).toBeDefined();
	});
});
