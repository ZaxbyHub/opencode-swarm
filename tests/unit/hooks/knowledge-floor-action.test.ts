/**
 * Tests for the G2 (#1715) confidence-floor action in bumpKnowledgeConfidenceBatch.
 *
 * Previously confidence feedback dead-ended at the floor with no consequence.
 * Now a floor-clamped entry with a net-negative outcome signal is demoted
 * (`confidence_floor_demoted` flag, strips retrieval `statusBoost`) or
 * quarantined per config.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	bumpKnowledgeConfidenceBatch,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'floor-action-test-'));
}

function eventsPath(dir: string): string {
	return join(dir, '.swarm', 'knowledge-events.jsonl');
}

function ensureSwarmDir(dir: string): string {
	const p = eventsPath(dir);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return p;
}

function makeReceiptEvent(o: {
	type: string;
	knowledge_id: string;
	timestamp?: string;
}): string {
	return JSON.stringify({
		type: o.type,
		event_id: randomUUID(),
		trace_id: randomUUID(),
		knowledge_id: o.knowledge_id,
		timestamp: o.timestamp ?? new Date().toISOString(),
		session_id: 'test-session',
		agent: 'test-agent',
	});
}

function writeEvents(
	dir: string,
	events: Array<{ type: string; knowledge_id: string; timestamp?: string }>,
): void {
	const fp = ensureSwarmDir(dir);
	const content = events.map((e) => makeReceiptEvent(e)).join('\n') + '\n';
	writeFileSync(fp, content, 'utf-8');
}

function writeEntry(
	dir: string,
	opts: { id: string; confidence: number; status?: string },
): void {
	const fp = resolveSwarmKnowledgePath(dir);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		fp,
		JSON.stringify({
			id: opts.id,
			tier: 'swarm',
			lesson: 'a test lesson long enough to pass validation',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: opts.confidence,
			status: opts.status ?? 'established',
			confirmed_by: [],
			retrieval_outcomes: {},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}) + '\n',
		'utf-8',
	);
}

async function readEntry(
	dir: string,
	id: string,
): Promise<{ confidence: number; confidence_floor_demoted?: boolean; status?: string } | undefined> {
	const fp = resolveSwarmKnowledgePath(dir);
	const { readKnowledge } = await import('../../../src/hooks/knowledge-store.js');
	const entries = await readKnowledge<{ id: string; confidence: number; confidence_floor_demoted?: boolean; status?: string }>(fp);
	return entries.find((e) => e.id === id);
}

describe('G2 confidence-floor action (#1715)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempDir();
	});
	afterEach(() => {
		try {
			import('node:fs').then(({ rmSync }) => rmSync(dir, { recursive: true, force: true }));
		} catch {
			/* ignore */
		}
	});

	test('demotes a floor entry with net-negative outcome signal (default demote)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 }); // one small decay will clamp to 0.1
		// 4 violated events → net-negative signal, ≥3 outcomes (min default)
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		// -0.1 delta clamps to floor 0.1
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: -0.1 }]);
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBe(0.1);
		expect(entry?.confidence_floor_demoted).toBe(true);
	});

	test('does NOT demote when evidence is below floorMinOutcomes', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 });
		// only 2 violated → below default min 3
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: -0.1 }]);
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBe(0.1);
		expect(entry?.confidence_floor_demoted).toBeUndefined();
	});

	test('does NOT demote when outcome signal is net-positive', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 });
		// 5 applied vs 1 violated → net-positive
		writeEvents(dir, [
			{ type: 'applied', knowledge_id: id },
			{ type: 'applied', knowledge_id: id },
			{ type: 'applied', knowledge_id: id },
			{ type: 'applied', knowledge_id: id },
			{ type: 'applied', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: -0.1 }]);
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBe(0.1);
		expect(entry?.confidence_floor_demoted).toBeUndefined();
	});

	test('clears stale confidence_floor_demoted flag on recovery above floor', async () => {
		const id = randomUUID();
		// Start demoted at the floor.
		writeEntry(dir, { id, confidence: 0.1 });
		// First bump with no outcome evidence → flag would not be SET (no signal),
		// so seed the flag manually first by writing it directly.
		const fp = resolveSwarmKnowledgePath(dir);
		const { readKnowledge } = await import('../../../src/hooks/knowledge-store.js');
		const entries = await readKnowledge<{ id: string; confidence_floor_demoted?: boolean; confidence: number }>(fp);
		entries[0].confidence_floor_demoted = true;
		writeFileSync(fp, JSON.stringify(entries[0]) + '\n', 'utf-8');

		// +0.4 boost → rises well above floor; no events → recovered branch fires
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: 0.4 }]);
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBeGreaterThan(0.1);
		expect(entry?.confidence_floor_demoted).toBe(false);
	});

	test('floorAction:"none" preserves legacy dead-end behavior (no flag)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 });
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		await bumpKnowledgeConfidenceBatch(
			dir,
			[{ id, delta: -0.1 }],
			{ floorAction: 'none' },
		);
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBe(0.1);
		expect(entry?.confidence_floor_demoted).toBeUndefined();
	});

	test('idempotent: re-running the same delta re-sets the flag harmlessly', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 });
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: -0.1 }]);
		// Second run with a no-op delta (0) — entry stays at floor, flag stays true
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: 0 }]);
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBe(0.1);
		expect(entry?.confidence_floor_demoted).toBe(true);
	});
});
