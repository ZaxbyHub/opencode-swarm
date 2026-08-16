/**
 * Delegate terminal source-attribution regression (issue #2032).
 *
 * Split out of delegate-ack-collector.test.ts when that file hit the FR-006
 * 500-line ratchet: every delegate terminal must carry `source: 'delegate'`
 * in BOTH the authoritative V2 ledger and the diagnostic event dual-writes —
 * previously only silent unacknowledged events carried it, while explicit
 * terminals recorded the agent identity (via the shared validator) or nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectDelegateAcks } from '../../../src/hooks/delegate-ack-collector.js';
import {
	appendKnowledgeEvent,
	type KnowledgeEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import { queryLiveMemberships } from '../../../src/hooks/knowledge-receipt-ledger.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FIXED_TRACE_ID = 'trace-fixed-2032-0001';
const SESSION = 'sess-src-2032';
const ID_APPLIED = '11111111-1111-4111-8111-111111111111';
const ID_IGNORED = '22222222-2222-4222-8222-222222222222';
const ID_NA = '44444444-4444-4444-8444-444444444444';
const ID_CRITICAL = '33333333-3333-4333-8333-333333333333';

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

function buildPrompt(entries: RankedEntry[]): string {
	const block = buildDelegateDirectiveBlock(
		entries,
		knowledgeConfig(),
		FIXED_TRACE_ID,
	);
	return `${block}\n\nTASK_ID: task-src\nDelegated work here.`;
}

async function seedRetrieved(
	directory: string,
	resultIds: string[],
): Promise<void> {
	await appendKnowledgeEvent(directory, {
		type: 'retrieved',
		trace_id: FIXED_TRACE_ID,
		session_id: SESSION,
		task_id: 'task-src',
		agent: 'coder',
		query: 'delegate task',
		retrieval_mode: 'delegate_inject',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: FIXED_NOW_ISO,
	});
}

// Fixed RECENT instant (string literal — no clock read; see PRR-009 note in
// the matrix test file).
const FIXED_NOW_ISO = '2026-01-01T00:00:00.000Z';

describe('delegate terminal source attribution (#2032)', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('delegate-ack-source-');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('explicit delegate terminals carry source delegate in the diagnostic dual-write', async () => {
		await seedRetrieved(dir, [ID_APPLIED, ID_IGNORED, ID_NA, ID_CRITICAL]);
		const transcript = [
			'Done.',
			`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`,
			`KNOWLEDGE_IGNORED:${FIXED_TRACE_ID}:${ID_IGNORED} reason=deliberate`,
			`KNOWLEDGE_N_A:${FIXED_TRACE_ID}:${ID_NA} reason=other subsystem`,
			`KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_CRITICAL}`,
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
			sessionId: SESSION,
		});
		expect(result.emitted).toHaveLength(4);
		const receipts = (await readKnowledgeEvents(dir)).filter(
			(e: KnowledgeEvent) =>
				['applied', 'ignored', 'violated', 'n_a'].includes(e.type),
		);
		expect(receipts.length).toBeGreaterThanOrEqual(4);
		for (const event of receipts) {
			expect((event as { source?: string }).source).toBe('delegate');
		}
	});

	it('explicit delegate terminals carry source delegate in the V2 ledger, not the agent identity', async () => {
		await seedRetrieved(dir, [ID_APPLIED]);
		await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([rankedEntry(ID_APPLIED, 'high')]),
			transcript: `KNOWLEDGE_APPLIED:${FIXED_TRACE_ID}:${ID_APPLIED}`,
			agent: 'coder',
			sessionId: SESSION,
		});
		const state = await queryLiveMemberships(dir, {
			session_id: SESSION,
			include_terminal: true,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		expect(state.memberships.length).toBeGreaterThan(0);
		for (const membership of state.memberships) {
			if (!membership.terminal) continue;
			expect(membership.terminal.source).toBe('delegate');
			expect(membership.terminal.source).not.toBe('coder');
		}
	});

	it('unacknowledged-critical terminals keep source delegate in both stores', async () => {
		await seedRetrieved(dir, [ID_CRITICAL]);
		await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([rankedEntry(ID_CRITICAL, 'critical')]),
			transcript: 'did the work without acking',
			agent: 'coder',
			sessionId: SESSION,
		});
		const violated = (await readKnowledgeEvents(dir)).filter(
			(e: KnowledgeEvent) => e.type === 'violated',
		);
		expect(violated.length).toBeGreaterThanOrEqual(1);
		for (const event of violated) {
			expect((event as { source?: string }).source).toBe('delegate');
		}
		const state = await queryLiveMemberships(dir, {
			session_id: SESSION,
			include_terminal: true,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		const terminal = state.memberships.find(
			(m) => m.entry_id === ID_CRITICAL,
		)?.terminal;
		expect(terminal?.outcome).toBe('violated');
		expect(terminal?.source).toBe('delegate');
	});

	it('legacy prompt (no trace header): n_a ack is preserved as acked but never fabricated into a terminal (PRR-016)', async () => {
		// #2031 contract: a legacy prompt has no provable retrieval membership,
		// so the collector marks the explicit ack as acknowledged (no false
		// unacknowledged-critical escalation) but commits NO V2 terminal and
		// NO diagnostic event — presence is not fabricated authority.
		const legacyBlock = buildDelegateDirectiveBlock(
			[rankedEntry(ID_NA, 'medium'), rankedEntry(ID_CRITICAL, 'critical')],
			knowledgeConfig(),
			undefined,
		);
		expect(legacyBlock).not.toContain('trace_id:');
		const result = await collectDelegateAcks({
			directory: dir,
			prompt: `${legacyBlock}\n\nTASK_ID: task-legacy\nDelegated work here.`,
			transcript: `KNOWLEDGE_N_A:${ID_NA} reason=different subsystem\nKNOWLEDGE_APPLIED:${ID_CRITICAL}`,
			agent: 'coder',
			sessionId: SESSION,
		});
		// Both acked → no escalation, no violated fabrication.
		expect(result.unacknowledgedCriticals).toEqual([]);
		// No terminal/diagnostic emissions for legacy acks.
		expect(
			result.emitted.filter((e) => e.type !== 'unacknowledged'),
		).toHaveLength(0);
		const receipts = (await readKnowledgeEvents(dir)).filter((e) =>
			['applied', 'ignored', 'violated', 'n_a'].includes(e.type),
		);
		expect(receipts).toHaveLength(0);
		const state = await queryLiveMemberships(dir, {
			session_id: SESSION,
			include_terminal: true,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		expect(state.memberships.some((m) => m.terminal !== undefined)).toBe(false);
	});
});
