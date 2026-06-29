/**
 * Behavioral tests for delegate-ack-collector (FR-012).
 *
 * Tests the three observable outcomes of the delegate-ack-collector hook:
 * 1. Collects ACK messages from delegated subagents
 * 2. Times out unresponsive subagents after configured deadline  ← empty-transcript path
 * 3. Emits aggregate ACK summary for the parent agent
 *
 * Uses real implementations (no mock.module) to stay in the same isolation tier as
 * the companion file delegate-ack-parser.test.ts. Each test gets its own temp
 * directory; cleanup runs in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	collectDelegateAcks,
	collectDelegateAcksAfter,
	type DelegateAckInput,
	type DelegateAckOutput,
} from '../../../src/hooks/delegate-ack-collector.js';
import {
	type KnowledgeEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ID_APPLIED = '11111111-1111-4111-8111-111111111111';
const ID_IGNORED = '22222222-2222-4222-8222-222222222222';
const ID_CRITICAL = '33333333-3333-4333-8333-333333333333';
const ID_NA = '44444444-4444-4444-8444-444444444444';
const ID_SPOOFED = '99999999-9999-4999-8999-999999999999';

function knowledgeConfig(): KnowledgeConfig {
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

function rankedEntry(
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

function buildPrompt(entries: RankedEntry[]): string {
	const block = buildDelegateDirectiveBlock(entries, knowledgeConfig());
	return `${block}\n\nTASK_ID: task-42\nDelegated work here.`;
}

function extractReceipts(
	events: KnowledgeEvent[],
): Array<{ id: string; type: string; reason?: string }> {
	return events
		.filter((e) =>
			['applied', 'ignored', 'violated', 'n_a', 'acknowledged'].includes(
				e.type,
			),
		)
		.map((e) => {
			const ev = e as { type: string; knowledge_id: string; reason?: string };
			return { id: ev.knowledge_id, type: ev.type, reason: ev.reason };
		});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delegate-ack-collector', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ack-collector-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// Outcome 1: Collects ACK messages from delegated subagents
	// -------------------------------------------------------------------------

	describe('Outcome 1 — collects ACK messages from delegated subagents', () => {
		it('records one receipt per acked+shown directive with the correct type', async () => {
			const transcript = [
				'Done.',
				`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
				`KNOWLEDGE_IGNORED:${ID_IGNORED} reason=not relevant here`,
				`KNOWLEDGE_N_A:${ID_NA} reason=different subsystem`,
				`KNOWLEDGE_APPLIED:${ID_CRITICAL}`,
			].join('\n');

			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([
					rankedEntry(ID_APPLIED, 'high'),
					rankedEntry(ID_IGNORED, 'medium'),
					rankedEntry(ID_CRITICAL, 'critical'),
					rankedEntry(ID_NA, 'high'),
				]),
				transcript,
				agent: 'coder',
				sessionId: 'sess-1',
			});

			const events = await readKnowledgeEvents(dir);
			const recs = extractReceipts(events);
			const byId = new Map(recs.map((r) => [r.id, r.type]));
			expect(byId.get(ID_APPLIED)).toBe('applied');
			expect(byId.get(ID_IGNORED)).toBe('ignored');
			expect(byId.get(ID_NA)).toBe('n_a');
			expect(byId.get(ID_CRITICAL)).toBe('applied');
			expect(result.unacknowledgedCriticals).toEqual([]);
			expect(result.emitted).toHaveLength(4);
		});

		it('drops acks for IDs that were never shown (anti-spoofing)', async () => {
			const transcript = [
				`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
				`KNOWLEDGE_APPLIED:${ID_SPOOFED}`, // never in the directive block
			].join('\n');

			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([
					rankedEntry(ID_APPLIED, 'high'),
					rankedEntry(ID_CRITICAL, 'critical'),
				]),
				transcript,
				agent: 'coder',
				sessionId: 'sess-2',
			});

			const events = await readKnowledgeEvents(dir);
			const recs = extractReceipts(events);
			const ids = recs.map((r) => r.id);
			expect(ids).toContain(ID_APPLIED);
			expect(ids).not.toContain(ID_SPOOFED);
			// ID_APPLIED is acknowledged; ID_CRITICAL was shown but never acked → auto-added as violated.
			// ID_SPOOFED is dropped (never shown — anti-spoofing).
			const emittedById = new Map(result.emitted.map((e) => [e.id, e.type]));
			expect(emittedById.get(ID_APPLIED)).toBe('applied');
			expect(emittedById.get(ID_CRITICAL)).toBe('violated');
			expect(emittedById.has(ID_SPOOFED)).toBe(false);
		});

		it('records violated type when transcript contains KNOWLEDGE_VIOLATED marker', async () => {
			const transcript = [
				`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
				`KNOWLEDGE_VIOLATED:${ID_CRITICAL} reason=intentional violation`,
			].join('\n');

			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([
					rankedEntry(ID_APPLIED, 'high'),
					rankedEntry(ID_CRITICAL, 'critical'),
				]),
				transcript,
				agent: 'coder',
				sessionId: 'sess-3',
			});

			const byId = new Map(result.emitted.map((e) => [e.id, e.type]));
			expect(byId.get(ID_CRITICAL)).toBe('violated');
		});

		it('extracts the task id from the prompt envelope when taskId is not provided', async () => {
			const transcript = `KNOWLEDGE_APPLIED:${ID_APPLIED}`;

			await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([rankedEntry(ID_APPLIED, 'high')]),
				transcript,
				agent: 'coder',
				sessionId: 'sess-4',
				// taskId intentionally omitted — extractTaskId should parse it from prompt
			});

			const events = await readKnowledgeEvents(dir);
			const applied = events.find(
				(e) => e.type === 'applied',
			) as (typeof events)[0] & { task_id?: string };
			expect(applied?.task_id).toBe('task-42');
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 2: Times out unresponsive subagents (empty-transcript path)
	// -------------------------------------------------------------------------

	describe('Outcome 2 — times out unresponsive subagents', () => {
		it('returns violated emitted event for unacknowledged critical when transcript is empty (timeout)', async () => {
			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([rankedEntry(ID_CRITICAL, 'critical')]),
				transcript: '',
				agent: 'coder',
				sessionId: 'sess-timeout-1',
			});

			// The critical was shown but never acked → auto-added as violated.
			expect(result.emitted).toContainEqual({
				id: ID_CRITICAL,
				type: 'violated',
			});
			expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);
		});

		it('returns violated emitted event for unacknowledged critical when transcript is whitespace-only', async () => {
			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([rankedEntry(ID_CRITICAL, 'critical')]),
				transcript: '   \n\t  ',
				agent: 'coder',
				sessionId: 'sess-timeout-2',
			});

			// The critical was shown but never acked → auto-added as violated.
			expect(result.emitted).toContainEqual({
				id: ID_CRITICAL,
				type: 'violated',
			});
			expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);
		});

		it('collectDelegateAcksAfter returns early when tool is not Task', async () => {
			const input: DelegateAckInput = {
				tool: 'Shell',
				args: { prompt: 'anything' },
			};
			const output: DelegateAckOutput = { output: 'something' };

			await collectDelegateAcksAfter(dir, input, output);

			// No events written
			const events = await readKnowledgeEvents(dir);
			expect(events.length).toBe(0);
		});

		it('collectDelegateAcksAfter returns early when prompt is missing', async () => {
			const input: DelegateAckInput = {
				tool: 'Task',
				args: {},
			};
			const output: DelegateAckOutput = { output: 'some transcript' };

			await collectDelegateAcksAfter(dir, input, output);

			const events = await readKnowledgeEvents(dir);
			expect(events.length).toBe(0);
		});

		it('collectDelegateAcksAfter returns early when transcript is missing', async () => {
			const input: DelegateAckInput = {
				tool: 'Task',
				args: { prompt: 'some prompt' },
			};
			const output: DelegateAckOutput = {};

			await collectDelegateAcksAfter(dir, input, output);

			const events = await readKnowledgeEvents(dir);
			expect(events.length).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 3: Emits aggregate ACK summary for the parent agent
	// -------------------------------------------------------------------------

	describe('Outcome 3 — emits aggregate ACK summary for the parent agent', () => {
		it('returns correct emitted array and unacknowledgedCriticals for mixed acks', async () => {
			// Only two of four directives were acknowledged; critical was not.
			const transcript = [
				`KNOWLEDGE_APPLIED:${ID_APPLIED}`,
				`KNOWLEDGE_IGNORED:${ID_IGNORED} reason=handled differently`,
			].join('\n');

			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([
					rankedEntry(ID_APPLIED, 'high'),
					rankedEntry(ID_IGNORED, 'medium'),
					rankedEntry(ID_CRITICAL, 'critical'),
					rankedEntry(ID_NA, 'low'),
				]),
				transcript,
				agent: 'reviewer',
				sessionId: 'sess-summary-1',
				taskId: 'task-summary-1',
			});

			// Two explicit acks emitted
			expect(result.emitted).toHaveLength(3); // applied + ignored + violated(critical)
			expect(result.emitted).toContainEqual({
				id: ID_APPLIED,
				type: 'applied',
			});
			expect(result.emitted).toContainEqual({
				id: ID_IGNORED,
				type: 'ignored',
			});

			// Unacknowledged critical
			expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);
			expect(result.emitted).toContainEqual({
				id: ID_CRITICAL,
				type: 'violated',
			});
		});

		it('records events with correct sessionId, taskId, and agent in the event store', async () => {
			const transcript = `KNOWLEDGE_APPLIED:${ID_APPLIED}`;

			await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([rankedEntry(ID_APPLIED, 'high')]),
				transcript,
				agent: 'test-agent',
				sessionId: 'sess-summary-2',
				taskId: 'task-summary-2',
			});

			const events = await readKnowledgeEvents(dir);
			const applied = events.find(
				(e) => e.type === 'applied',
			) as (typeof events)[0] & {
				session_id: string;
				task_id: string;
				agent: string;
			};
			expect(applied.session_id).toBe('sess-summary-2');
			expect(applied.task_id).toBe('task-summary-2');
			expect(applied.agent).toBe('test-agent');
		});

		it('writes unacknowledged-criticals.jsonl audit log when criticals are not acked', async () => {
			const transcript = `KNOWLEDGE_APPLIED:${ID_APPLIED}`; // critical deliberately not acked

			await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([
					rankedEntry(ID_APPLIED, 'high'),
					rankedEntry(ID_CRITICAL, 'critical'),
				]),
				transcript,
				agent: 'coder',
				sessionId: 'sess-summary-3',
			});

			const auditPath = path.join(
				dir,
				'.swarm',
				'unacknowledged-criticals.jsonl',
			);
			expect(fs.existsSync(auditPath)).toBe(true);
			const auditLine = JSON.parse(
				fs.readFileSync(auditPath, 'utf-8').trim().split('\n')[0]!,
			);
			expect(auditLine.knowledge_id).toBe(ID_CRITICAL);
			expect(auditLine.reason).toBe('unacknowledged');
		});

		it('is a no-op when prompt has no delegate directive block', async () => {
			const prompt = 'Just a normal delegation with no knowledge directives.';
			const transcript = `KNOWLEDGE_APPLIED:${ID_APPLIED}`;

			const result = await collectDelegateAcks({
				directory: dir,
				prompt,
				transcript,
				agent: 'coder',
				sessionId: 'sess-summary-4',
			});

			expect(result.emitted).toEqual([]);
			expect(result.unacknowledgedCriticals).toEqual([]);
			const events = await readKnowledgeEvents(dir);
			expect(events.length).toBe(0);
		});
	});
});
