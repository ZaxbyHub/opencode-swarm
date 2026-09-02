/**
 * Behavioral tests for delegate-ack-collector timeout/early-return paths.
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
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

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

const FIXED_TRACE_ID = 'trace-fixed-1849-0001';

function buildPrompt(entries: RankedEntry[]): string {
	const block = buildDelegateDirectiveBlock(
		entries,
		knowledgeConfig(),
		FIXED_TRACE_ID,
	);
	return `${block}\n\nTASK_ID: task-42\nDelegated work here.`;
}

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

describe('delegate-ack-collector timeout and early-return paths', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ack-collector-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

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
