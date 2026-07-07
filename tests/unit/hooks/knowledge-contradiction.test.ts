/**
 * G3 (#1715) tests: contradiction signal unification.
 *
 * Previously `contradicted_count` (incremented only via knowledge_receipt) and
 * curator `flag_contradiction` (tag-only) were disconnected. Now the curator
 * emits `contradicted` events post-transaction AND threshold-based quarantine
 * fires via maybeQuarantineOnContradiction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCuratorKnowledgeUpdates } from '../../../src/hooks/curator.js';
import { maybeQuarantineOnContradiction } from '../../../src/hooks/knowledge-escalator.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'contradiction-test-'));
}

function ensureSwarmDir(dir: string): string {
	const p = join(dir, '.swarm', 'knowledge-events.jsonl');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return p;
}

function makeEvent(o: {
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
	const content = events.map((e) => makeEvent(e)).join('\n') + '\n';
	writeFileSync(fp, content, 'utf-8');
}

function writeEntry(dir: string, opts: { id: string; status?: string }): void {
	const fp = resolveSwarmKnowledgePath(dir);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		fp,
		JSON.stringify({
			id: opts.id,
			tier: 'swarm',
			lesson: 'a test lesson long enough to pass validation checks here',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.7,
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

async function readEntryStatus(
	dir: string,
	id: string,
): Promise<string | undefined> {
	const fp = resolveSwarmKnowledgePath(dir);
	const entries = await readKnowledge<{ id: string; status: string }>(fp);
	return entries.find((e) => e.id === id)?.status;
}

const defaultConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false,
	rejected_max_entries: 20,
	validation_enabled: false,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 2,
	same_project_weight: 1.0,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1.0,
	encounter_increment: 0.1,
	max_encounter_score: 10.0,
	default_max_phases: 10,
	todo_max_phases: 3,
	sweep_enabled: true,
	confidence_floor_action: 'none' as const,
	confidence_floor_min_outcomes: 3,
	confidence_floor_signal_threshold: 0,
	contradiction_threshold_action: 'quarantine' as const,
	contradiction_quarantine_threshold: 3,
	contradiction_quarantine_window_days: 30,
	enrichment: { max_calls_per_day: 30, quota_window: 'utc' as const },
};

describe('G3 contradiction unification (#1715)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempDir();
	});
	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('curator flag_contradiction emits a contradicted event post-transaction', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'conflicts with new evidence',
				},
			],
			defaultConfig,
		);
		const events = await readKnowledgeEvents(dir);
		const contradicted = events.filter((e) => e.type === 'contradicted');
		expect(contradicted.length).toBe(1);
		expect(contradicted[0].knowledge_id).toBe(id);
		expect((contradicted[0] as { agent?: string }).agent).toBe('curator');
	});

	test('curator flag_contradiction still adds the tag (backward compat)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'spaces vs tabs',
				},
			],
			defaultConfig,
		);
		const entries = await readKnowledge<{ id: string; tags?: string[] }>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(entries[0].tags).toContain('contradiction:spaces vs tabs');
	});

	test('maybeQuarantineOnContradiction quarantines when threshold crossed', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		// 3 contradicted events in window → threshold 3
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		const result = await maybeQuarantineOnContradiction(dir, id, 3, 30);
		expect(result.quarantined).toBe(true);
		expect(result.contradictionsInWindow).toBe(3);
		// quarantineEntry MOVES the entry to knowledge-quarantined.jsonl, so it
		// is no longer in the active swarm file (the active read returns undefined).
		expect(await readEntryStatus(dir, id)).toBeUndefined();
		// And the quarantine file exists + contains the entry.
		const quarantinePath = join(dir, '.swarm', 'knowledge-quarantined.jsonl');
		expect(existsSync(quarantinePath)).toBe(true);
		const qContent = readFileSync(quarantinePath, 'utf-8');
		expect(qContent).toContain(id);
	});

	test('maybeQuarantineOnContradiction does NOT quarantine below threshold', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		const result = await maybeQuarantineOnContradiction(dir, id, 3, 30);
		expect(result.quarantined).toBe(false);
		expect(await readEntryStatus(dir, id)).toBe('established');
	});

	test('maybeQuarantineOnContradiction is idempotent on already-quarantined entry', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, status: 'quarantined' });
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		const result = await maybeQuarantineOnContradiction(dir, id, 3, 30);
		expect(result.quarantined).toBe(false);
		expect(result.alreadyInactive).toBe(true);
	});

	test('maybeQuarantineOnContradiction respects the window (old events excluded)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60d ago
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id, timestamp: old },
			{ type: 'contradicted', knowledge_id: id, timestamp: old },
			{ type: 'contradicted', knowledge_id: id, timestamp: old },
		]);
		// 3 events but all >30d old → within 30d window = 0 → no quarantine
		const result = await maybeQuarantineOnContradiction(dir, id, 3, 30);
		expect(result.quarantined).toBe(false);
	});

	test('curator quarantine action fires when threshold crossed after flag_contradiction', async () => {
		// Seed 2 prior contradicted events, then run a curator flag_contradiction
		// (which emits a 3rd) with contradiction_threshold_action='quarantine'.
		// The threshold check should fire and quarantine the entry.
		const id = randomUUID();
		writeEntry(dir, { id });
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'third strike',
				},
			],
			defaultConfig,
		);
		// 2 prior + 1 curator-emitted = 3 → threshold crossed → quarantined.
		// quarantineEntry moves the entry to knowledge-quarantined.jsonl, so it
		// is no longer in the active swarm file.
		expect(await readEntryStatus(dir, id)).toBeUndefined();
		const quarantinePath = join(dir, '.swarm', 'knowledge-quarantined.jsonl');
		expect(existsSync(quarantinePath)).toBe(true);
		expect(readFileSync(quarantinePath, 'utf-8')).toContain(id);
	});

	test('curator tag_only config preserves legacy behavior (no quarantine)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'third strike',
				},
			],
			{ ...defaultConfig, contradiction_threshold_action: 'tag_only' },
		);
		// 3 contradicted events but tag_only → no quarantine, entry stays established
		expect(await readEntryStatus(dir, id)).toBe('established');
	});
});
