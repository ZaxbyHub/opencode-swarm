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
	appendKnowledgeEvent,
	type KnowledgeEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import { queryLiveMemberships } from '../../../src/hooks/knowledge-receipt-ledger.js';
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
		receipt_close_grace_days: 7,
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

// (#1849) Fixed trace_id shared between the directive block and the seeded
// `retrieved` event, so the shared receipt validator finds the trace and the
// shown IDs as result_ids.
const FIXED_TRACE_ID = 'trace-fixed-1849-0001';

function buildPrompt(entries: RankedEntry[]): string {
	const block = buildDelegateDirectiveBlock(
		entries,
		knowledgeConfig(),
		FIXED_TRACE_ID,
	);
	return `${block}\n\nTASK_ID: task-42\nDelegated work here.`;
}

/** Seed a retrieved event so the validator's trace-existence + membership checks pass. */
async function seedRetrieved(
	directory: string,
	resultIds: string[],
	opts: { traceId?: string; sessionId?: string; taskId?: string } = {},
): Promise<void> {
	await appendKnowledgeEvent(directory, {
		type: 'retrieved',
		trace_id: opts.traceId ?? FIXED_TRACE_ID,
		session_id: opts.sessionId ?? 'sess',
		task_id: opts.taskId ?? 'task-42',
		agent: 'coder',
		query: 'delegate task',
		retrieval_mode: 'delegate_inject',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: new Date().toISOString(),
	});
}

function extractReceipts(
	events: KnowledgeEvent[],
): Array<{ id: string; type: string; reason?: string; source?: string }> {
	return events
		.filter((e) =>
			['applied', 'ignored', 'violated', 'n_a', 'acknowledged'].includes(
				e.type,
			),
		)
		.map((e) => {
			const ev = e as {
				type: string;
				knowledge_id: string;
				reason?: string;
				source?: string;
			};
			return {
				id: ev.knowledge_id,
				type: ev.type,
				reason: ev.reason,
				source: ev.source,
			};
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
				`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`,
				`KNOWLEDGE_IGNORED:${FIXED_TRACE_ID}:${ID_IGNORED} reason=not relevant here`,
				`KNOWLEDGE_N_A:${FIXED_TRACE_ID}:${ID_NA} reason=different subsystem`,
				`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_CRITICAL}`,
			].join('\n');

			// (#1849) Seed the retrieved event the directive block's trace_id
			// references, with the shown IDs as result_ids + matching session id,
			// so the shared receipt validator accepts the acks.
			await seedRetrieved(dir, [ID_APPLIED, ID_IGNORED, ID_CRITICAL, ID_NA], {
				sessionId: 'sess-1',
			});

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

			// (#2032) Every delegate terminal dual-write carries the delegate
			// provenance class — previously these diagnostic events omitted
			// source entirely while unacknowledged events carried it.
			for (const rec of recs) {
				expect(rec.source).toBe('delegate');
			}

			// (#2032) The V2 ledger terminal carries source 'delegate', not the
			// agent identity ('coder') the shared validator previously stamped.
			const live = await queryLiveMemberships(dir, {
				session_id: 'sess-1',
				include_terminal: true,
			});
			expect(live.ok).toBe(true);
			if (live.ok) {
				for (const membership of live.memberships) {
					if (!membership.terminal) continue;
					expect(membership.terminal.source).toBe('delegate');
				}
			}
		});

		it('drops acks for IDs that were never shown (anti-spoofing)', async () => {
			const transcript = [
				`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`,
				`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_SPOOFED}`, // never in the directive block
			].join('\n');

			// (#1849) Seed the retrieved trace so the validator accepts the
			// shown-ID ack. ID_SPOOFED is intentionally NOT in result_ids so it
			// is rejected by the membership check (anti-spoofing).
			await seedRetrieved(dir, [ID_APPLIED, ID_CRITICAL], {
				sessionId: 'sess-2',
			});

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
			// (#PRR-006) Seed the retrieved trace so the validator ACCEPTS the
			// KNOWLEDGE_VIOLATED ack as a validated terminal (was passing for the
			// wrong reason: no seed → trace_not_found → violated came from the
			// unacknowledged-critical fallback, not the marker).
			await seedRetrieved(dir, [ID_APPLIED, ID_CRITICAL], {
				sessionId: 'sess-3',
			});
			const transcript = [
				`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`,
				`KNOWLEDGE_VIOLATED:${FIXED_TRACE_ID}:${ID_CRITICAL} reason=intentional violation`,
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

		it('(#PRR-008) does NOT falsely escalate an acked critical when validation fails (wrong session)', async () => {
			// Seed a trace under a DIFFERENT session so validateReceipt returns
			// wrong_session (ok:false). The delegate explicitly acked ID_CRITICAL
			// with KNOWLEDGE_APPLIED — the ok:false branch must preserve it in
			// ackedIds so the unacknowledged-critical loop does NOT escalate it.
			await seedRetrieved(dir, [ID_CRITICAL], { sessionId: 'other-session' });
			const transcript = `KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_CRITICAL}`;
			const result = await collectDelegateAcks({
				directory: dir,
				prompt: buildPrompt([rankedEntry(ID_CRITICAL, 'critical')]),
				transcript,
				agent: 'coder',
				sessionId: 'sess-prr008', // different from the seeded trace's session
			});
			// The critical was explicitly acked → must NOT appear as unacknowledged.
			expect(result.unacknowledgedCriticals).not.toContain(ID_CRITICAL);
		});

		it('extracts the task id from the prompt envelope when taskId is not provided', async () => {
			const transcript = `KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`;

			// (#1849) Seed the retrieved trace so the validator accepts the ack.
			await seedRetrieved(dir, [ID_APPLIED], { sessionId: 'sess-4' });

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
			await seedRetrieved(dir, [ID_CRITICAL], {
				sessionId: 'sess-timeout-1',
			});
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
			await seedRetrieved(dir, [ID_CRITICAL], {
				sessionId: 'sess-timeout-2',
			});
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
				`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`,
				`KNOWLEDGE_IGNORED:${FIXED_TRACE_ID}:${ID_IGNORED} reason=handled differently`,
			].join('\n');

			// (#1849) Seed the retrieved trace with all four shown IDs so the
			// validator accepts the two acks (and the unacknowledged critical
			// still falls through to the auto-violated path).
			await seedRetrieved(dir, [ID_APPLIED, ID_IGNORED, ID_CRITICAL, ID_NA], {
				sessionId: 'sess-summary-1',
				taskId: 'task-summary-1',
			});

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

			// applied + ignored + violated(critical) + unacknowledged(ID_NA, 'low')
			expect(result.emitted).toHaveLength(4);
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
			const transcript = `KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`;

			// (#1849) Seed the retrieved trace so the validator accepts the ack.
			await seedRetrieved(dir, [ID_APPLIED], {
				sessionId: 'sess-summary-2',
				taskId: 'task-summary-2',
			});

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
			const transcript = `KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`; // critical deliberately not acked
			await seedRetrieved(dir, [ID_APPLIED, ID_CRITICAL], {
				sessionId: 'sess-summary-3',
			});

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
