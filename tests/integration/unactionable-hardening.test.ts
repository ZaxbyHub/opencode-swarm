/**
 * Integration test: unactionable-knowledge hardening loop
 * (Swarm Learning System, Change 4 / Task 4.3).
 *
 * One unactionable queue entry + an improver-style enrichment delegate →
 * the entry is hardened (predicates + scope), moves from the queue to the
 * active store as a candidate, and carries the new fields. Failed hardening
 * marks retire_candidate:true and leaves the entry queued; retire candidates
 * are never re-processed; the batch limit bounds LLM attempts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../src/hooks/knowledge-types.js';
import { resolveUnactionablePath } from '../../src/hooks/knowledge-validator.js';
import {
	type HardenableRecord,
	hardenUnactionableEntries,
} from '../../src/services/unactionable-hardening.js';

const VALID_V3 = JSON.stringify({
	applies_to_agents: ['coder'],
	forbidden_actions: ['commit without running git status'],
});

const NEVER_VALID = JSON.stringify({ applies_to_agents: ['coder'] }); // no predicate

function queueRecord(
	id: string,
	lesson: string,
	retire = false,
): HardenableRecord {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['git'],
		scope: 'global',
		confidence: 0.6,
		status: 'quarantined_unactionable',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		unactionable_reason: 'missing_predicate_and_scope',
		quarantined_at: '2026-01-01T00:00:00.000Z',
		...(retire ? { retire_candidate: true } : {}),
	} as HardenableRecord;
}

describe('hardenUnactionableEntries', () => {
	let dir: string;

	function seedQueue(records: HardenableRecord[]): void {
		fs.writeFileSync(
			resolveUnactionablePath(dir),
			`${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
		);
	}

	function readQueue(): HardenableRecord[] {
		const p = resolveUnactionablePath(dir);
		if (!fs.existsSync(p)) return [];
		return fs
			.readFileSync(p, 'utf-8')
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('hardens a queued entry into the active store with the new fields', async () => {
		seedQueue([
			queueRecord('u-1', 'Run git status before committing to verify state'),
		]);

		const result = await hardenUnactionableEntries({
			directory: dir,
			llmDelegate: async () => VALID_V3,
		});

		expect(result.hardened).toBe(1);
		expect(result.retired).toBe(0);
		expect(result.remaining).toBe(0);

		// Entry left the queue…
		expect(readQueue()).toHaveLength(0);
		// …and exists in the active store with the hardened fields.
		const active = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(active).toHaveLength(1);
		expect(active[0].id).toBe('u-1');
		expect(active[0].status).toBe('candidate');
		expect(active[0].forbidden_actions).toEqual([
			'commit without running git status',
		]);
		expect(active[0].applies_to_agents).toEqual(['coder']);
		// Quarantine bookkeeping fields are stripped.
		expect(
			(active[0] as Record<string, unknown>).unactionable_reason,
		).toBeUndefined();
	});

	it('marks retire_candidate when hardening fails (and keeps the entry queued)', async () => {
		seedQueue([
			queueRecord('u-2', 'Some vague observation that resists hardening'),
		]);

		const result = await hardenUnactionableEntries({
			directory: dir,
			llmDelegate: async () => NEVER_VALID,
		});

		expect(result.hardened).toBe(0);
		expect(result.retired).toBe(1);
		expect(result.remaining).toBe(1);

		const queue = readQueue();
		expect(queue).toHaveLength(1);
		expect(queue[0].retire_candidate).toBe(true);
		// Nothing reached the active store.
		const active = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(active).toHaveLength(0);
	});

	it('never re-processes entries already marked retire_candidate', async () => {
		seedQueue([queueRecord('u-3', 'Already retired entry stays put', true)]);
		let calls = 0;
		const result = await hardenUnactionableEntries({
			directory: dir,
			llmDelegate: async () => {
				calls++;
				return VALID_V3;
			},
		});
		expect(calls).toBe(0);
		expect(result.hardened).toBe(0);
		expect(result.retired).toBe(0);
		expect(result.remaining).toBe(1);
	});

	it('respects the batch limit (bounds LLM attempts per run)', async () => {
		seedQueue([
			queueRecord('u-a', 'First distinct lesson about database indexes'),
			queueRecord('u-b', 'Second distinct lesson about cache invalidation'),
			queueRecord('u-c', 'Third distinct lesson about retry backoff'),
		]);
		let calls = 0;
		const result = await hardenUnactionableEntries({
			directory: dir,
			llmDelegate: async () => {
				calls++;
				return VALID_V3;
			},
			batchLimit: 2,
		});
		// Each successful hardening costs exactly one LLM call here.
		expect(calls).toBe(2);
		expect(result.hardened).toBe(2);
		expect(result.remaining).toBe(1);
	});

	it('is a no-op without a delegate (no auto-retire without an attempt)', async () => {
		seedQueue([
			queueRecord('u-4', 'Lesson waiting for an LLM to be available'),
		]);
		const result = await hardenUnactionableEntries({ directory: dir });
		expect(result.hardened).toBe(0);
		expect(result.retired).toBe(0);
		expect(result.remaining).toBe(1);
		expect(readQueue()[0].retire_candidate).toBeUndefined();
	});

	it('never loses an entry when the active-store append fails (regression: Phase 4 review CRITICAL)', async () => {
		// Previous code dropped the entry from the queue BEFORE appending to the
		// active store; a failed append then lost it permanently. The fixed
		// commit order appends to the active store FIRST. Simulate an append
		// failure by making knowledge.jsonl an unwritable path (a directory).
		seedQueue([
			queueRecord('u-5', 'Entry that must survive an active store failure'),
		]);
		fs.mkdirSync(resolveSwarmKnowledgePath(dir), { recursive: true });

		const result = await hardenUnactionableEntries({
			directory: dir,
			llmDelegate: async () => VALID_V3,
		});

		// Nothing was promoted (the store write failed)…
		expect(result.hardened).toBe(0);
		// …and the entry is STILL in the queue (not lost, not retired).
		const queue = readQueue();
		expect(queue).toHaveLength(1);
		expect(queue[0].id).toBe('u-5');
		expect(queue[0].retire_candidate).toBeUndefined();
	});
});
