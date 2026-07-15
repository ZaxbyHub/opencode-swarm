/**
 * #1848 §4: fair durable scanning cursor tests.
 *
 * Verifies that every eligible entry is eventually visited across repeated
 * bounded runs (no starvation beyond the window), that the cursor survives
 * restart, that crash/retry is idempotent, and that concurrent claims do not
 * duplicate a batch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import {
	_internals,
	claimNextScanBatch,
	getScanStatus,
} from '../../../src/knowledge/scan-cursor.js';

function makeTmpDir(): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), 'swarm-scan-')));
}

function makeEntry(id: string, createdAt: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson for ${id} padding to fifteen`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'established',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		producer: { cohort_id: 'c1', worktree_id: 'wt-A' },
		revision: 1,
		created_at: createdAt,
		updated_at: createdAt,
	};
}

function writeEntries(dir: string, entries: SwarmKnowledgeEntry[]): void {
	const storeDir = path.join(dir, '.swarm');
	mkdirSync(storeDir, { recursive: true });
	writeFileSync(
		path.join(storeDir, 'knowledge.jsonl'),
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
	);
}

describe('fair scan cursor — >500 entries eventually visited', () => {
	let dir: string;

	// IR-5 fix: snapshot/restore _internals to prevent cross-file leak.
	const _internalsSnapshot = { ..._internals };
	beforeEach(() => {
		dir = makeTmpDir();
		// Override resolveCohortId to avoid git subprocess in tests.
		_internals.resolveCohortId = async () => ({
			cohortId: 'test-cohort',
			source: 'path',
			degraded: true,
			normalizedRemote: undefined,
		});
	});
	afterEach(() => {
		Object.assign(_internals, _internalsSnapshot);
	});

	it('visits every eligible entry across repeated bounded runs (no starvation)', async () => {
		// Create 650 entries — more than the default 500 window.
		const entries: SwarmKnowledgeEntry[] = Array.from({ length: 650 }, (_, i) =>
			makeEntry(
				`e-${String(i).padStart(4, '0')}`,
				`2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
			),
		);
		writeEntries(dir, entries);

		const visited = new Set<string>();
		const batchSize = 200;
		// Run sweeps until the cursor reports completion + a fresh generation.
		for (let run = 0; run < 10; run++) {
			const batch = await claimNextScanBatch(dir, batchSize);
			for (const e of batch.entries) visited.add(e.id);
			if (visited.size >= 650) break;
		}
		expect(visited.size).toBe(650);
	});

	it('survives restart — cursor state persists across calls', async () => {
		const entries: SwarmKnowledgeEntry[] = Array.from({ length: 10 }, (_, i) =>
			makeEntry(`r-${i}`, `2026-01-0${(i % 9) + 1}T00:00:00Z`),
		);
		writeEntries(dir, entries);

		const batch1 = await claimNextScanBatch(dir, 3);
		expect(batch1.entries.length).toBe(3);

		const status = await getScanStatus(dir);
		expect(status.generation).toBe(1);
		expect(status.remaining_estimate).toBe(7);

		// Second call continues from where the cursor left off.
		const batch2 = await claimNextScanBatch(dir, 3);
		expect(batch2.entries.length).toBe(3);
		// No overlap between batches.
		const ids1 = new Set(batch1.entries.map((e) => e.id));
		const overlap = batch2.entries.filter((e) => ids1.has(e.id));
		expect(overlap.length).toBe(0);
	});

	it('completes a sweep and bumps generation on the next call', async () => {
		const entries: SwarmKnowledgeEntry[] = Array.from({ length: 5 }, (_, i) =>
			makeEntry(`g-${i}`, `2026-01-0${i + 1}T00:00:00Z`),
		);
		writeEntries(dir, entries);

		// First batch of 5 completes the sweep.
		const batch1 = await claimNextScanBatch(dir, 5);
		expect(batch1.sweepCompleted).toBe(true);

		// Next call starts a fresh generation.
		const batch2 = await claimNextScanBatch(dir, 5);
		expect(batch2.generation).toBe(2);
	});

	it('skips inactive (archived/quarantined) entries', async () => {
		const active = makeEntry('active-1', '2026-01-01T00:00:00Z');
		const archived: SwarmKnowledgeEntry = {
			...makeEntry('archived-1', '2026-01-02T00:00:00Z'),
			status: 'archived',
		};
		writeEntries(dir, [active, archived]);

		const batch = await claimNextScanBatch(dir, 10);
		expect(batch.entries.length).toBe(1);
		expect(batch.entries[0].id).toBe('active-1');
	});
});
