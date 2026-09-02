import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';

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

function readKnowledgeEntries(dir: string): Record<string, unknown>[] {
	return readFileSync(join(dir, '.swarm', 'knowledge.jsonl'), 'utf-8')
		.trim()
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
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
		closeProjectDb(dir);
		rmSync(dir, { recursive: true, force: true }); // #2480
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

	test('executes shortened entry ids and actionable new recommendations from the JSON block', async () => {
		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async () =>
				[
					'```json postmortem_actions',
					JSON.stringify({
						summary: 'LLM synthesis with prefix and new directive.',
						curation_recommendations: [
							{
								action: 'promote',
								entry_id: ENTRY_ID.slice(0, 8),
								lesson:
									'Always verify postmortem curation actions after LLM synthesis.',
								reason: 'The model copied the shortened entry id.',
							},
							{
								action: 'promote',
								lesson:
									'Run focused verification before closing a knowledge-pipeline fix',
								reason: 'Postmortem evidence showed the closeout gap.',
								category: 'process',
								applies_to_agents: ['architect'],
								required_actions: [
									'run focused verification before closing the issue',
								],
								triggers: ['knowledge pipeline fix'],
								directive_priority: 'high',
							},
						],
						queue_triage: [],
					}),
					'```',
				].join('\n'),
		});

		expect(result.success).toBe(true);
		expect(result.actions?.knowledge_applied).toBe(2);
		const entries = readKnowledgeEntries(dir);
		expect(entries).toHaveLength(2);
		expect(entries[0].hive_eligible).toBe(true);
		expect(entries[1].applies_to_agents).toEqual(['architect']);
		expect(entries[1].required_actions).toEqual([
			'run focused verification before closing the issue',
		]);
		const report = readFileSync(result.reportPath!, 'utf-8');
		expect(report).toContain('## Generated Against State');
		expect(report).toContain('Plan context: loaded');
		expect(report).toContain('## Post-Mortem Action Verification');
		expect(report).toContain(
			`promote: ${ENTRY_ID.slice(0, 8)} => ${ENTRY_ID} [prefix_match]`,
		);
		expect(report).toContain('promote: new [new_entry]');
	});

	test('ignores quarantined entries when resolving shortened recommendation ids', async () => {
		const swarmDir = join(dir, '.swarm');
		writeFileSync(
			join(swarmDir, 'knowledge.jsonl'),
			[
				JSON.stringify({
					id: ENTRY_ID,
					tier: 'swarm',
					lesson: 'Active lesson survives.',
					category: 'process',
					status: 'active',
					confidence: 0.7,
					tags: [],
					scope: 'global',
					confirmed_by: [],
					project_name: 'test',
					created_at: '2026-07-03T00:00:00.000Z',
					updated_at: '2026-07-03T00:00:00.000Z',
				}),
				JSON.stringify({
					id: `${ENTRY_ID.slice(0, 8)}-0000-4000-8000-000000000000`,
					tier: 'swarm',
					lesson: 'Quarantined prefix collision.',
					category: 'process',
					status: 'quarantined',
					confidence: 0.1,
					tags: [],
					scope: 'global',
					confirmed_by: [],
					project_name: 'test',
					created_at: '2026-07-03T00:00:00.000Z',
					updated_at: '2026-07-03T00:00:00.000Z',
				}),
			].join('\n') + '\n',
		);

		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async () =>
				[
					'```json postmortem_actions',
					JSON.stringify({
						summary: 'Shortened id should resolve to the active entry only.',
						curation_recommendations: [
							{
								action: 'promote',
								entry_id: ENTRY_ID.slice(0, 8),
								lesson: 'Active lesson survives.',
								reason: 'Prefix should ignore quarantined entries.',
							},
						],
						queue_triage: [],
					}),
					'```',
				].join('\n'),
		});

		expect(result.success).toBe(true);
		expect(result.actions?.knowledge_applied).toBe(1);
		const report = readFileSync(result.reportPath!, 'utf-8');
		expect(report).toContain(
			`promote: ${ENTRY_ID.slice(0, 8)} => ${ENTRY_ID} [prefix_match]`,
		);
	});

	test('data-only report labels planless runs and records freshness state', async () => {
		rmSync(join(dir, '.swarm', 'plan.json'), { force: true });

		const result = await runCuratorPostMortem(dir, { force: true });

		expect(result.success).toBe(true);
		expect(result.planId).toBe('unknown');
		const report = readFileSync(result.reportPath!, 'utf-8');
		expect(report).toContain(
			'Plan context: unavailable (plan_id: unknown; project-level fallback)',
		);
		expect(report).toContain('- Knowledge entries summarized: 1');
	});

	test('malformed postmortem_actions JSON pushes diagnostics and triggers repair when llmDelegate present', async () => {
		let callCount = 0;
		_internals.checkHivePromotions = async () => ({
			new_promotions: 1,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 1,
			timestamp: '2026-07-03T00:00:00.000Z',
		});

		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async (_system: string, prompt: string) => {
				callCount++;
				if (callCount === 1) {
					// First call — return malformed JSON inside the fence
					return [
						'POST_MORTEM_REPORT:',
						'```json postmortem_actions',
						'{bad json here -- missing closing brace',
						'```',
					].join('\n');
				}
				// Second call — repair prompt should contain the repair marker
				if (prompt.includes('Repair the supplied CURATOR_POSTMORTEM')) {
					return [
						'```json postmortem_actions',
						JSON.stringify({
							summary: 'Repaired summary after parse failure.',
							curation_recommendations: [
								{
									action: 'promote',
									entry_id: ENTRY_ID,
									lesson:
										'Always verify postmortem curation actions after LLM synthesis.',
									reason: 'Confirmed by repair pass.',
									category: 'process',
									confidence: 0.9,
								},
							],
							queue_triage: [],
						}),
						'```',
					].join('\n');
				}
				return '```json postmortem_actions\n{}\n```';
			},
		});

		expect(result.success).toBe(true);
		expect(
			result.warnings.some(
				(w) =>
					w.includes('structured action parse diagnostics') &&
					w.includes('malformed_json'),
			),
		).toBe(true);
		expect(result.warnings.some((w) => w.includes('repaired'))).toBe(true);
		// The repaired recommendation should have been executed
		expect(
			(result.actions?.knowledge_applied ?? 0) +
				(result.actions?.hive_promotions ?? 0),
		).toBeGreaterThan(0);
	});

	test('empty curation_recommendations with valid summary extracts the summary without executing actions', async () => {
		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async () =>
				[
					'```json postmortem_actions',
					JSON.stringify({
						summary: 'Summary from structured output with no recommendations.',
						curation_recommendations: [],
						queue_triage: [],
					}),
					'```',
				].join('\n'),
		});

		expect(result.success).toBe(true);
		expect(result.summary).toBe(
			'Summary from structured output with no recommendations.',
		);
		// No recommendations → executePostMortemActions not called or is no-op
		// actions may be undefined or all-zero
		const applied = result.actions?.knowledge_applied ?? 0;
		const hive = result.actions?.hive_promotions ?? 0;
		const proposals =
			(result.actions?.proposals_approved ?? 0) +
			(result.actions?.proposals_rejected ?? 0);
		expect(applied + hive + proposals).toBe(0);
		// No knowledge write occurred (hive_eligible should still be absent/undefined)
		const entry = readKnowledgeEntry(dir);
		expect(entry.hive_eligible).toBeUndefined();
	});

	test('legacy CURATION_RECOMMENDATIONS / QUEUE_TRIAGE fallback when no structured fence present', async () => {
		let capturedTriage: Parameters<typeof _internals.applyProposalTriage>[1] =
			[];
		_internals.checkHivePromotions = async () => ({
			new_promotions: 1,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 1,
			timestamp: '2026-07-03T00:00:00.000Z',
		});
		_internals.applyProposalTriage = async (_dir: string, triage) => {
			capturedTriage = triage;
			return { approved: ['useful-skill'], rejected: [], skipped: [] };
		};

		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async () =>
				[
					'SUMMARY:',
					'Legacy fallback summary text.',
					'',
					'CURATION_RECOMMENDATIONS:',
					`- promote: ${ENTRY_ID} - confirmed across phases`,
					'',
					'QUEUE_TRIAGE:',
					'- useful-skill: APPLY - reusable',
				].join('\n'),
		});

		expect(result.success).toBe(true);
		expect(result.summary).toContain('Legacy fallback summary text');
		// promote recommendation was parsed and executed
		expect(result.actions?.knowledge_applied ?? 0).toBeGreaterThanOrEqual(1);
		// queue triage was passed to applyProposalTriage
		expect(
			capturedTriage.some(
				(t) => t.proposal_id === 'useful-skill' && t.action === 'apply',
			),
		).toBe(true);
	});

	test('unsupported merge action in legacy CURATION_RECOMMENDATIONS emits a diagnostic and is dropped', async () => {
		_internals.checkHivePromotions = async () => ({
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
			timestamp: '2026-07-03T00:00:00.000Z',
		});
		_internals.applyProposalTriage = async () => ({
			approved: [],
			rejected: [],
			skipped: [],
		});

		const result = await runCuratorPostMortem(dir, {
			force: true,
			llmDelegate: async () =>
				[
					'SUMMARY:',
					'Post-mortem with unsupported merge action.',
					'',
					'CURATION_RECOMMENDATIONS:',
					`- merge: ${ENTRY_ID} + 660e8400-e29b-41d4-a716-446655440001 - combine these`,
				].join('\n'),
		});

		expect(result.success).toBe(true);
		expect(
			result.warnings.some(
				(w) =>
					w.includes('structured action parse diagnostics') &&
					w.includes("'merge'") &&
					w.includes('unsupported'),
			),
		).toBe(true);
		// merge action should NOT have been executed (knowledge_applied stays 0)
		expect(result.actions?.knowledge_applied ?? 0).toBe(0);
	});
});
