import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	_internals,
	runCuratorPostMortem,
} from '../../../src/hooks/curator-postmortem.js';

const ENTRY_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'postmortem-actions-'));
}

function writePlan(dir: string): void {
	const swarmDir = join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 1684',
			swarm: 'test',
			phases: [{ id: 1, name: 'Fix', status: 'complete', tasks: [] }],
		}),
	);
}

function writeKnowledge(dir: string): void {
	const swarmDir = join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		join(swarmDir, 'knowledge.jsonl'),
		`${JSON.stringify({
			id: ENTRY_ID,
			tier: 'swarm',
			lesson: 'Always verify postmortem curation actions after LLM synthesis.',
			category: 'process',
			status: 'active',
			confidence: 0.7,
			tags: [],
			scope: 'global',
			confirmed_by: [],
			project_name: 'test',
			created_at: '2026-07-03T00:00:00.000Z',
			updated_at: '2026-07-03T00:00:00.000Z',
		})}\n`,
	);
}

function readKnowledgeEntry(dir: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(join(dir, '.swarm', 'knowledge.jsonl'), 'utf-8').trim(),
	);
}

describe('curator post-mortem executable actions', () => {
	let dir: string;
	const originalCheckHivePromotions = _internals.checkHivePromotions;
	const originalApplyProposalTriage = _internals.applyProposalTriage;

	beforeEach(() => {
		dir = makeTempDir();
		writePlan(dir);
		writeKnowledge(dir);
	});

	afterEach(() => {
		_internals.checkHivePromotions = originalCheckHivePromotions;
		_internals.applyProposalTriage = originalApplyProposalTriage;
		rmSync(dir, { recursive: true, force: true });
	});

	test('executes parsed LLM actions and returns the LLM summary', async () => {
		let proposalIds: string[] = [];
		_internals.checkHivePromotions = async () => ({
			new_promotions: 1,
			encounters_incremented: 2,
			advancements: 0,
			total_hive_entries: 1,
			timestamp: '2026-07-03T00:00:00.000Z',
		});
		_internals.applyProposalTriage = async (_directory, triage) => {
			proposalIds = triage.map((item) => item.proposal_id);
			return { approved: ['useful-skill'], rejected: [], skipped: [] };
		};

		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async () =>
				[
					'POST_MORTEM_REPORT:',
					'SUMMARY:',
					'LLM synthesis: curator found one actionable promotion.',
					'',
					'```json postmortem_actions',
					JSON.stringify({
						summary: 'LLM synthesis: curator found one actionable promotion.',
						curation_recommendations: [
							{
								action: 'promote',
								entry_id: ENTRY_ID,
								lesson:
									'Always verify postmortem curation actions after LLM synthesis.',
								reason: 'Confirmed by final postmortem evidence.',
								category: 'process',
								confidence: 0.9,
							},
						],
						queue_triage: [
							{
								proposal_id: 'proposals/useful-skill.md',
								action: 'apply',
								reason: 'General reusable workflow.',
							},
						],
					}),
					'```',
				].join('\n'),
		});

		expect(result.success).toBe(true);
		expect(result.summary).toBe(
			'LLM synthesis: curator found one actionable promotion.',
		);
		expect(result.actions?.knowledge_applied).toBe(1);
		expect(result.actions?.hive_promotions).toBe(1);
		expect(result.actions?.proposals_approved).toBe(1);
		expect(proposalIds).toEqual(['proposals/useful-skill.md']);
		expect(readKnowledgeEntry(dir).hive_eligible).toBe(true);
	});
});
