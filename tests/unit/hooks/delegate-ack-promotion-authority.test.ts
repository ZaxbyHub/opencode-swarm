import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectDelegateAcks } from '../../../src/hooks/delegate-ack-collector.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import { commitDisplayedMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';
import { loadPromotionEvidenceByEntry } from '../../../src/hooks/promotion-evidence-store.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = 'trace-fixed-1849-0001';
let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('delegate-ack-promotion-');
	mkdirSync(join(directory, '.git'));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

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
		receipt_close_grace_days: 7,
		todo_max_phases: 3,
		sweep_enabled: true,
	};
}

function entry(): RankedEntry {
	return {
		id: ENTRY_ID,
		tier: 'swarm',
		lesson: 'apply the directive',
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
		directive_priority: 'high',
		relevanceScore: { category: 0, confidence: 0, keywords: 0 },
		finalScore: 0.5,
	} as RankedEntry;
}

describe('delegate ACK promotion authority', () => {
	test('writes promotion evidence from the authoritative terminal', async () => {
		const displayed = await commitDisplayedMembership(directory, {
			trace_id: TRACE_ID,
			session_id: 'session-1',
			agent: 'coder',
			exposure_kind: 'delegate_directive',
			task_id: 'task-42',
			entries: [{ entry_id: ENTRY_ID, critical: false }],
		});
		expect(displayed.ok).toBe(true);
		const block = buildDelegateDirectiveBlock([entry()], config(), TRACE_ID);

		await collectDelegateAcks({
			directory,
			prompt: `${block}\n\nTASK_ID: task-42`,
			transcript: `KNOWLEDGE_APPLIED:${TRACE_ID}:${ENTRY_ID}`,
			agent: 'coder',
			sessionId: 'session-1',
		});

		const records = (await loadPromotionEvidenceByEntry(directory))[ENTRY_ID];
		expect(records).toHaveLength(1);
		expect(records?.[0]?.receipt_outcome).toBe('applied');
	});
});
