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
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	bumpKnowledgeConfidenceBatch,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';

function makeTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'floor-action-test-')));
	mkdirSync(join(dir, '.git'));
	return dir;
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

async function writeEvents(
	dir: string,
	events: Array<{ type: string; knowledge_id: string; timestamp?: string }>,
): Promise<void> {
	const fp = ensureSwarmDir(dir);
	const content = events.map((e) => makeReceiptEvent(e)).join('\n') + '\n';
	writeFileSync(fp, content, 'utf-8');
	for (const [index, event] of events.entries()) {
		if (
			!['applied', 'ignored', 'violated', 'contradicted', 'n_a'].includes(
				event.type,
			)
		) {
			continue;
		}
		const traceId = `floor-${event.knowledge_id}-${index}`;
		const displayed = await commitDisplayedMembership(dir, {
			trace_id: traceId,
			session_id: 'test-session',
			agent: 'test-agent',
			entries: [{ entry_id: event.knowledge_id, critical: false }],
		});
		if (!displayed.ok) throw new Error(displayed.detail);
		const terminal = await validateAndCommitTerminalBatch(dir, {
			trace_id: traceId,
			session_id: 'test-session',
			agent: 'test-agent',
			items: [
				{
					entry_id: event.knowledge_id,
					outcome: event.type as
						| 'applied'
						| 'ignored'
						| 'violated'
						| 'contradicted'
						| 'n_a',
				},
			],
		});
		if (!terminal.ok) throw new Error(terminal.detail);
	}
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
): Promise<
	| { confidence: number; confidence_floor_demoted?: boolean; status?: string }
	| undefined
> {
	const fp = resolveSwarmKnowledgePath(dir);
	const { readKnowledge } = await import(
		'../../../src/hooks/knowledge-store.js'
	);
	const entries = await readKnowledge<{
		id: string;
		confidence: number;
		confidence_floor_demoted?: boolean;
		status?: string;
	}>(fp);
	return entries.find((e) => e.id === id);
}

describe('G2 confidence-floor action (#1715)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempDir();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('demotes a floor entry with net-negative outcome signal (default demote)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 }); // one small decay will clamp to 0.1
		// 4 violated events → net-negative signal, ≥3 outcomes (min default)
		await writeEvents(dir, [
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
		await writeEvents(dir, [
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
		await writeEvents(dir, [
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
		const { readKnowledge } = await import(
			'../../../src/hooks/knowledge-store.js'
		);
		const entries = await readKnowledge<{
			id: string;
			confidence_floor_demoted?: boolean;
			confidence: number;
		}>(fp);
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
		await writeEvents(dir, [
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: -0.1 }], {
			floorAction: 'none',
		});
		const entry = await readEntry(dir, id);
		expect(entry?.confidence).toBe(0.1);
		expect(entry?.confidence_floor_demoted).toBeUndefined();
	});

	test('idempotent: re-running the same delta re-sets the flag harmlessly', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 });
		await writeEvents(dir, [
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

	test('floorAction:"quarantine" routes to canonical quarantineEntry with original_status preserved', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, confidence: 0.15 });
		// 4 violated events → net-negative signal, ≥3 outcomes (min default)
		await writeEvents(dir, [
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
			{ type: 'violated', knowledge_id: id },
		]);
		// -0.1 delta clamps to floor 0.1, triggering quarantine routing
		await bumpKnowledgeConfidenceBatch(dir, [{ id, delta: -0.1 }], {
			floorAction: 'quarantine',
		});

		// Entry must NOT appear in the main knowledge file (removed by quarantineEntry)
		const mainEntry = await readEntry(dir, id);
		expect(mainEntry).toBeUndefined();

		// Entry must appear in the quarantine sidecar with original_status preserved
		const quarantineFp = join(dir, '.swarm', 'knowledge-quarantined.jsonl');
		const { readKnowledge: readQuarantine } = await import(
			'../../../src/hooks/knowledge-store.js'
		);
		const quarantined = await readQuarantine<{
			id: string;
			status: string;
			original_status?: string;
		}>(quarantineFp);
		const found = quarantined.find((e) => e.id === id);
		expect(found).toBeDefined();
		expect(found?.status).toBe('quarantined');
		expect(found?.original_status).toBe('established');
	});
});
