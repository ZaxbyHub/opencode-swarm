import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	commitDisplayedMembership,
	queryLiveMemberships,
	repairKnowledgeReceiptLedger,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { knowledge_recall } from '../../../src/tools/knowledge-recall';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('knowledge_recall authoritative membership ordering', () => {
	let directory: string;
	const fixedNowIso = '2026-01-01T00:00:00.000Z';
	const fixedNowMs = Date.parse(fixedNowIso);
	let restoreClock: (() => void) | undefined;

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: fixedNowMs,
			isoNow: fixedNowIso,
		});
		directory = canonicalMkdtemp('knowledge-recall-receipt-');
		const configDir = join(directory, '.opencode');
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, 'opencode-swarm.json'),
			JSON.stringify({ knowledge: { hive_enabled: false } }),
		);
		const swarm = join(directory, '.swarm');
		mkdirSync(swarm, { recursive: true });
		writeFileSync(
			join(swarm, 'knowledge.jsonl'),
			`${JSON.stringify({
				id: 'manual-result',
				tier: 'swarm',
				lesson: 'always validate manual retrieval results',
				category: 'process',
				tags: ['validate', 'manual', 'retrieval'],
				scope: 'global',
				confidence: 0.9,
				status: 'established',
				confirmed_by: [],
				project_name: 'test',
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			})}\n`,
		);
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = undefined;
		rmSync(directory, { recursive: true, force: true });
	});

	test('returns results only after authoritative membership is durably recorded', async () => {
		const raw = await knowledge_recall.execute(
			{ query: 'validate manual retrieval', tier: 'swarm' },
			{ directory, sessionID: 'manual-session', agent: 'architect' },
		);
		const result = JSON.parse(raw);

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.id).toBe('manual-result');
		expect(result.total).toBe(1);
		expect(typeof result.trace_id).toBe('string');

		const memberships = await queryLiveMemberships(directory, {
			session_id: 'manual-session',
			include_terminal: false,
		});
		expect(memberships.ok).toBe(true);
		if (!memberships.ok) throw new Error(memberships.detail);
		expect(memberships.memberships).toEqual([
			expect.objectContaining({
				trace_id: result.trace_id,
				entry_id: 'manual-result',
				session_id: 'manual-session',
				exposure_kind: 'manual_recall',
			}),
		]);
	});

	test('returns no results when receipt membership cannot be persisted', async () => {
		mkdirSync(join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'));

		const raw = await knowledge_recall.execute(
			{ query: 'validate manual retrieval', tier: 'swarm' },
			{ directory, sessionID: 'manual-session', agent: 'architect' },
		);
		const result = JSON.parse(raw);

		expect(result.results).toEqual([]);
		expect(result.total).toBe(0);
		expect(result.unverifiable).toBe(true);
		expect(result.code).toBe('store_unavailable');
	});

	test('clears a repaired scope only through an architect complete re-evaluation bound to its repair id', async () => {
		const seeded = await commitDisplayedMembership(directory, {
			trace_id: 'pre-repair-trace',
			session_id: 'manual-session',
			phase: 'phase-a',
			task_id: 'task-a',
			entries: [{ entry_id: 'pre-repair-entry', critical: true }],
		});
		if (!seeded.ok) throw new Error(seeded.detail);
		appendFileSync(
			join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'{corrupt-tail',
		);
		const repaired = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'manual-session',
			task_id: 'task-a',
			reason: 'bind public recall re-evaluation',
		});
		if (!repaired.ok || !repaired.repair_id) {
			throw new Error(repaired.ok ? 'missing repair id' : repaired.detail);
		}

		const denied = JSON.parse(
			await knowledge_recall.execute(
				{
					query: 'validate manual retrieval',
					tier: 'swarm',
					repair_re_evaluation: {
						repair_id: repaired.repair_id,
						phase: 'phase-a',
						task_id: 'task-a',
						scope_complete: true,
					},
				},
				{ directory, sessionID: 'manual-session', agent: 'reviewer' },
			),
		);
		expect(denied.code).toBe('RECEIPT_REEVALUATION_ARCHITECT_ONLY');

		const accepted = JSON.parse(
			await knowledge_recall.execute(
				{
					query: 'validate manual retrieval',
					tier: 'swarm',
					repair_re_evaluation: {
						repair_id: repaired.repair_id,
						phase: 'phase-a',
						task_id: 'task-a',
						scope_complete: true,
					},
				},
				{ directory, sessionID: 'manual-session', agent: 'architect' },
			),
		);
		expect(accepted.results).toHaveLength(1);

		const live = await queryLiveMemberships(directory, {
			phase: 'phase-a',
			session_id: 'manual-session',
		});
		expect(live.ok).toBe(true);
	});
});
