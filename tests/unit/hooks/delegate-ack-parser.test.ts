/**
 * Unit tests for delegate ack reconciliation (Change 1 / Task 1.5).
 *
 * collectDelegateAcks must: emit a receipt event per acked+shown directive;
 * synthesize a `violated`/`unacknowledged` event for shown criticals with no
 * ack (and audit them to .swarm/unacknowledged-criticals.jsonl); and DROP acks
 * for IDs that were never shown (anti-spoofing).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectDelegateAcks } from '../../../src/hooks/delegate-ack-collector.js';
import {
	type KnowledgeEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

const ID_APPLIED = '11111111-1111-4111-8111-111111111111';
const ID_IGNORED = '22222222-2222-4222-8222-222222222222';
const ID_CRITICAL = '33333333-3333-4333-8333-333333333333';
const ID_NA = '44444444-4444-4444-8444-444444444444';
const ID_NEVER_SHOWN = '99999999-9999-4999-8999-999999999999';

function config(): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		same_project_weight: 1,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1,
		encounter_increment: 0.1,
		max_encounter_score: 10,
		default_max_phases: 10,
		todo_max_phases: 3,
		sweep_enabled: true,
	};
}

function entry(
	id: string,
	priority: RankedEntry['directive_priority'],
): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson for ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		directive_priority: priority,
		relevanceScore: { category: 0, confidence: 0, keywords: 0 },
		finalScore: 0.5,
	} as RankedEntry;
}

function buildPrompt(): string {
	const block = buildDelegateDirectiveBlock(
		[
			entry(ID_APPLIED, 'high'),
			entry(ID_IGNORED, 'medium'),
			entry(ID_CRITICAL, 'critical'),
			entry(ID_NA, 'high'),
		],
		config(),
	);
	return `${block}\n\nTASK_ID: task-42\nImplement the thing.`;
}

function receipts(
	events: KnowledgeEvent[],
): Array<{ id: string; type: string; reason?: string }> {
	return events
		.filter((e) =>
			['applied', 'ignored', 'violated', 'n_a', 'acknowledged'].includes(
				e.type,
			),
		)
		.map((e) => {
			const r = e as { type: string; knowledge_id: string; reason?: string };
			return { id: r.knowledge_id, type: r.type, reason: r.reason };
		});
}

describe('collectDelegateAcks', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ack-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('records one receipt per acked+shown directive with the correct type', async () => {
		const transcript = [
			'Done with the work.',
			`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
			`KNOWLEDGE_IGNORED:${ID_IGNORED} reason=not relevant here`,
			`KNOWLEDGE_N_A:${ID_NA} reason=different subsystem`,
			`KNOWLEDGE_APPLIED:${ID_CRITICAL}`,
		].join('\n');

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt(),
			transcript,
			agent: 'coder',
			sessionId: 'sess-1',
		});

		const events = await readKnowledgeEvents(dir);
		const recs = receipts(events);
		const byId = new Map(recs.map((r) => [r.id, r.type]));
		expect(byId.get(ID_APPLIED)).toBe('applied');
		expect(byId.get(ID_IGNORED)).toBe('ignored');
		expect(byId.get(ID_NA)).toBe('n_a');
		expect(byId.get(ID_CRITICAL)).toBe('applied');
		// No unacknowledged criticals — the critical was acked.
		expect(result.unacknowledgedCriticals).toEqual([]);
	});

	it('synthesizes a violated/unacknowledged event for shown criticals with no ack', async () => {
		const transcript = [
			`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
			`KNOWLEDGE_IGNORED:${ID_IGNORED} reason=not applicable`,
			// ID_CRITICAL deliberately NOT acknowledged.
		].join('\n');

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt(),
			transcript,
			agent: 'coder',
			sessionId: 'sess-2',
		});

		expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);

		const events = await readKnowledgeEvents(dir);
		const violated = events.filter((e) => e.type === 'violated') as Array<{
			knowledge_id: string;
			reason?: string;
		}>;
		expect(violated.length).toBe(1);
		expect(violated[0].knowledge_id).toBe(ID_CRITICAL);
		expect(violated[0].reason).toBe('unacknowledged');

		// Audit log written.
		const auditPath = path.join(
			dir,
			'.swarm',
			'unacknowledged-criticals.jsonl',
		);
		expect(fs.existsSync(auditPath)).toBe(true);
		const auditLine = JSON.parse(
			fs.readFileSync(auditPath, 'utf-8').trim().split('\n')[0],
		);
		expect(auditLine.knowledge_id).toBe(ID_CRITICAL);
		expect(auditLine.reason).toBe('unacknowledged');
	});

	it('drops acks for IDs that were never shown (anti-spoofing)', async () => {
		const transcript = [
			`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
			`KNOWLEDGE_APPLIED:${ID_NEVER_SHOWN}`, // spoofed — never in the block
			`KNOWLEDGE_N_A:${ID_CRITICAL} reason=out of scope`,
		].join('\n');

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt(),
			transcript,
			agent: 'coder',
			sessionId: 'sess-3',
		});

		const events = await readKnowledgeEvents(dir);
		const recs = receipts(events);
		const ids = recs.map((r) => r.id);
		expect(ids).toContain(ID_APPLIED);
		expect(ids).not.toContain(ID_NEVER_SHOWN);
		// The critical was acked as n_a → not unacknowledged.
		expect(result.unacknowledgedCriticals).toEqual([]);
		const byId = new Map(recs.map((r) => [r.id, r.type]));
		expect(byId.get(ID_CRITICAL)).toBe('n_a');
	});

	it('extracts the task id from the prompt envelope', async () => {
		await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt(),
			transcript: `KNOWLEDGE_APPLIED:${ID_CRITICAL}`,
			agent: 'coder',
			sessionId: 'sess-4',
		});
		const events = await readKnowledgeEvents(dir);
		const applied = events.find((e) => e.type === 'applied') as
			| { task_id?: string }
			| undefined;
		expect(applied?.task_id).toBe('task-42');
	});

	it('is a no-op when the prompt has no delegate directive block', async () => {
		const result = await collectDelegateAcks({
			directory: dir,
			prompt: 'Just a normal delegation with no directives.',
			transcript: `KNOWLEDGE_APPLIED:${ID_APPLIED}`,
			agent: 'coder',
			sessionId: 'sess-5',
		});
		expect(result.emitted).toEqual([]);
		const events = await readKnowledgeEvents(dir);
		expect(events.length).toBe(0);
	});
});
