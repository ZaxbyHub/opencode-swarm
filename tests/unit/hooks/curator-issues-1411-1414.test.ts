import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	parseKnowledgeRecommendationsWithDiagnostics,
	runCuratorPhase,
} from '../../../src/hooks/curator';
import type { CuratorSummary } from '../../../src/hooks/curator-types';

let tempDir: string;

const knownId = '00000000-0000-4000-8000-000000000001';
const unknownId = '00000000-0000-4000-8000-000000000099';
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

function swarmPath(...parts: string[]): string {
	return path.join(tempDir, '.swarm', ...parts);
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readSummary(): CuratorSummary {
	return JSON.parse(
		fs.readFileSync(swarmPath('curator-summary.json'), 'utf-8'),
	) as CuratorSummary;
}

function readRepoFile(...parts: string[]): string {
	return fs.readFileSync(path.join(repoRoot, ...parts), 'utf-8');
}

function markdownTableCell(
	markdown: string,
	field: string,
	cellIndex: number,
): string | undefined {
	for (const line of markdown.split(/\r?\n/)) {
		const cells = line
			.split('|')
			.slice(1, -1)
			.map((cell) => cell.trim().replaceAll('`', ''));
		if (cells[0] === field) return cells[cellIndex];
	}
	return undefined;
}

function writeKnowledge(): void {
	fs.mkdirSync(swarmPath(), { recursive: true });
	fs.writeFileSync(
		swarmPath('knowledge.jsonl'),
		`${JSON.stringify({
			id: knownId,
			tier: 'swarm',
			lesson: 'Existing lesson',
			category: 'testing',
			tags: ['testing'],
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
			created_at: '2026-06-01T00:00:00.000Z',
			updated_at: '2026-06-01T00:00:00.000Z',
			project_name: 'test',
		})}\n`,
		'utf-8',
	);
}

describe('curator issue regressions', () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-issues-'));
		fs.mkdirSync(swarmPath(), { recursive: true });
		writeKnowledge();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('reports malformed recommendation lines without dropping valid lines', () => {
		const parsed = parseKnowledgeRecommendationsWithDiagnostics(
			[
				'OBSERVATIONS:',
				`- entry ${knownId} (could be tighter): Keep this valid recommendation`,
				'- malformed observation',
				'',
				'KNOWLEDGE_UPDATES:',
				'- unknown-action new: bad action',
			].join('\n'),
		);

		expect(parsed.recommendations).toHaveLength(1);
		expect(parsed.diagnostics).toHaveLength(2);
		expect(parsed.diagnostics.map((d) => d.section)).toEqual([
			'OBSERVATIONS',
			'KNOWLEDGE_UPDATES',
		]);
	});

	test('accumulates recommendations and filters unknown entry ids', async () => {
		writeJson(swarmPath('curator-summary.json'), {
			schema_version: 1,
			session_id: 'prior',
			last_updated: '2026-06-01T00:00:00.000Z',
			last_phase_covered: 1,
			digest: '### Phase 1\nprior',
			phase_digests: [
				{
					phase: 1,
					timestamp: '2026-06-01T00:00:00.000Z',
					summary: 'prior',
					agents_used: [],
					tasks_completed: 0,
					tasks_total: 0,
					key_decisions: [],
					blockers_resolved: [],
				},
			],
			compliance_observations: [],
			knowledge_recommendations: [
				{
					action: 'rewrite',
					lesson: 'prior recommendation',
					reason: 'prior recommendation',
				},
			],
		});

		await runCuratorPhase(
			tempDir,
			2,
			['reviewer', 'test_engineer'],
			{
				enabled: true,
				init_enabled: true,
				phase_enabled: true,
				max_summary_tokens: 2000,
				min_knowledge_confidence: 0.5,
				compliance_report: true,
				suppress_warnings: false,
				drift_inject_max_chars: 1000,
			},
			{},
			async () =>
				[
					'OBSERVATIONS:',
					`- entry ${knownId} (could be tighter): Known recommendation`,
					`- entry ${unknownId} (could be tighter): Unknown recommendation`,
				].join('\n'),
		);

		const summary = readSummary();
		expect(summary.knowledge_recommendations).toHaveLength(2);
		expect(summary.knowledge_recommendations.map((r) => r.lesson)).toEqual([
			'prior recommendation',
			'Known recommendation',
		]);
	});

	test('caps phase digests to the most recent 50 and rebuilds digest from the cap', async () => {
		writeJson(swarmPath('curator-summary.json'), {
			schema_version: 1,
			session_id: 'prior',
			last_updated: '2026-06-01T00:00:00.000Z',
			last_phase_covered: 50,
			digest: Array.from(
				{ length: 50 },
				(_, i) => `### Phase ${i + 1}\nold`,
			).join('\n\n'),
			phase_digests: Array.from({ length: 50 }, (_, i) => ({
				phase: i + 1,
				timestamp: '2026-06-01T00:00:00.000Z',
				summary: `phase-${i + 1}`,
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			})),
			compliance_observations: [],
			knowledge_recommendations: [],
		});

		await runCuratorPhase(
			tempDir,
			51,
			['reviewer', 'test_engineer'],
			{
				enabled: true,
				init_enabled: true,
				phase_enabled: true,
				max_summary_tokens: 2000,
				min_knowledge_confidence: 0.5,
				compliance_report: true,
				suppress_warnings: false,
				drift_inject_max_chars: 1000,
			},
			{},
		);

		const summary = readSummary();
		expect(summary.phase_digests).toHaveLength(50);
		expect(summary.phase_digests[0].phase).toBe(2);
		expect(summary.phase_digests.at(-1)?.phase).toBe(51);
		expect(summary.digest.split('\n')).not.toContain('### Phase 1');
		expect(summary.digest).toContain('### Phase 51');
	});

	test('caps accumulated compliance observations and knowledge recommendations', async () => {
		writeJson(swarmPath('curator-summary.json'), {
			schema_version: 1,
			session_id: 'prior',
			last_updated: '2026-06-01T00:00:00.000Z',
			last_phase_covered: 1,
			digest: '### Phase 1\nprior',
			phase_digests: [
				{
					phase: 1,
					timestamp: '2026-06-01T00:00:00.000Z',
					summary: 'prior',
					agents_used: [],
					tasks_completed: 0,
					tasks_total: 0,
					key_decisions: [],
					blockers_resolved: [],
				},
			],
			compliance_observations: Array.from({ length: 201 }, (_, i) => ({
				phase: i,
				timestamp: '2026-06-01T00:00:00.000Z',
				type: 'workflow_deviation',
				description: `observation-${i}`,
				severity: 'info',
			})),
			knowledge_recommendations: Array.from({ length: 201 }, (_, i) => ({
				action: 'rewrite',
				lesson: `recommendation-${i}`,
				reason: `recommendation-${i}`,
			})),
		});

		await runCuratorPhase(
			tempDir,
			2,
			['reviewer', 'test_engineer'],
			{
				enabled: true,
				init_enabled: true,
				phase_enabled: true,
				max_summary_tokens: 2000,
				min_knowledge_confidence: 0.5,
				compliance_report: true,
				suppress_warnings: false,
				drift_inject_max_chars: 1000,
			},
			{},
		);

		const summary = readSummary();
		expect(summary.compliance_observations).toHaveLength(200);
		expect(summary.compliance_observations[0].description).toBe(
			'observation-1',
		);
		expect(summary.knowledge_recommendations).toHaveLength(200);
		expect(summary.knowledge_recommendations[0].lesson).toBe(
			'recommendation-1',
		);
	});

	test('documents enabled defaults and malformed structured-output diagnostics', () => {
		const planning = readRepoFile('docs', 'planning.md');
		const configuration = readRepoFile('docs', 'configuration.md');
		const knowledge = readRepoFile('docs', 'knowledge.md');

		expect(markdownTableCell(planning, 'enabled', 1)).toBe('true');
		expect(markdownTableCell(planning, 'postmortem_enabled', 1)).toBe('true');
		expect(markdownTableCell(planning, 'llm_timeout_ms', 1)).toBe('300000');
		expect(markdownTableCell(planning, 'skill_generation_enabled', 1)).toBe(
			'true',
		);
		expect(markdownTableCell(planning, 'skill_generation_mode', 1)).toBe(
			'draft',
		);
		expect(markdownTableCell(planning, 'min_skill_confidence', 1)).toBe('0.7');
		expect(markdownTableCell(planning, 'min_skill_confirmations', 1)).toBe('2');
		expect(markdownTableCell(configuration, 'enabled', 2)).toBe('true');
		expect(knowledge).toContain(
			'reported through debug-gated curator diagnostics',
		);
		expect(knowledge).not.toContain('Malformed JSON is silently dropped');
	});
});
