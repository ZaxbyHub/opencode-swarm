/**
 * Action-aware injection retrieval via the unified searchKnowledge service:
 *  - high-confidence trigger-matching directive forces inclusion
 *  - non-matching generic high-confidence lesson does not displace
 *  - active generated_skill reference surfaces
 *  - archived entries are excluded
 *
 * (Formerly tested readContextualKnowledge, which searchKnowledge replaced.)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type {
	KnowledgeConfig,
	KnowledgeRetrievalContext,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';
import { searchKnowledge } from '../../../src/hooks/search-knowledge';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-ctx-retr-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

function entry(
	id: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 't',
		...overrides,
	};
}

async function seed(es: SwarmKnowledgeEntry[]): Promise<void> {
	const dir = path.join(tmp, '.swarm');
	await mkdir(dir, { recursive: true });
	const lines = es.map((e) => JSON.stringify(e)).join('\n') + '\n';
	await writeFile(resolveSwarmKnowledgePath(tmp), lines, 'utf-8');
}

const cfg = KnowledgeConfigSchema.parse({});

// Mirrors the injector: action-aware context, architect role (sees all),
// swarm tier (isolates from the global hive), no event emission.
async function inject(
	ctx: KnowledgeRetrievalContext,
	config: KnowledgeConfig = cfg,
) {
	const { results } = await searchKnowledge({
		directory: tmp,
		config,
		context: ctx,
		mode: 'auto_injection',
		agent: 'architect',
		tier: 'swarm',
		emitEvent: false,
	});
	return results;
}

describe('searchKnowledge (action-aware injection)', () => {
	it('forces inclusion of critical directive on tool/agent match', async () => {
		await seed([
			entry('11111111-1111-4111-9111-111111111111', {
				lesson: 'declare scope before coder delegation',
				directive_priority: 'critical',
				applies_to_tools: ['save_plan'],
				applies_to_agents: ['coder'],
				triggers: ['coder delegation'],
				confidence: 0.95,
			}),
			entry('22222222-2222-4222-9222-222222222222', {
				lesson: 'unrelated generic high-confidence lesson',
				confidence: 0.92,
			}),
			entry('33333333-3333-4333-9333-333333333333', {
				lesson: 'another unrelated high-confidence lesson',
				confidence: 0.92,
			}),
		]);
		const result = await inject(
			{
				projectName: 't',
				currentPhase: 'Phase 1',
				currentTool: 'save_plan',
				targetAgent: 'coder',
				mode: 'delegation',
			},
			{ ...cfg, max_inject_count: 2 },
		);
		expect(result.map((r) => r.id)).toContain(
			'11111111-1111-4111-9111-111111111111',
		);
		// Critical comes first
		expect(result[0].id).toBe('11111111-1111-4111-9111-111111111111');
	});

	it('excludes archived entries', async () => {
		await seed([
			entry('aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa', {
				lesson: 'archived old lesson',
				status: 'archived',
				confidence: 0.99,
			}),
			entry('bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb', {
				lesson: 'live lesson',
				confidence: 0.7,
			}),
		]);
		const result = await inject({
			projectName: 't',
			currentPhase: 'Phase 1',
		});
		expect(result.map((r) => r.id)).not.toContain(
			'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa',
		);
	});

	it('includes candidate entries in default retrieval (deny-list, not allow-list)', async () => {
		await seed([
			entry('cccccccc-1111-4ccc-9ccc-cccccccccccc', {
				lesson: 'candidate lesson should now be retrievable',
				status: 'candidate',
			}),
			entry('dddddddd-1111-4ddd-9ddd-dddddddddddd', {
				lesson: 'established lesson should be retrievable',
				status: 'established',
			}),
		]);
		const result = await inject({
			projectName: 't',
			currentPhase: 'Phase 1',
		});
		// Deny-list semantics: candidate entries pass through (only quarantined excluded)
		expect(result.map((r) => r.id)).toContain(
			'cccccccc-1111-4ccc-9ccc-cccccccccccc',
		);
		expect(result.map((r) => r.id)).toContain(
			'dddddddd-1111-4ddd-9ddd-dddddddddddd',
		);
	});

	it('boosts entries that have an active generated_skill_path', async () => {
		await seed([
			entry('cccccccc-cccc-4ccc-9ccc-cccccccccccc', {
				lesson: 'with skill',
				confidence: 0.85,
				generated_skill_path: '.opencode/skills/generated/coder-scope/SKILL.md',
			}),
			entry('dddddddd-dddd-4ddd-9ddd-dddddddddddd', {
				lesson: 'plain',
				confidence: 0.85,
			}),
		]);
		const result = await inject({
			projectName: 't',
			currentPhase: 'Phase 1',
		});
		expect(result[0].id).toBe('cccccccc-cccc-4ccc-9ccc-cccccccccccc');
	});

	it('non-matching generic high-confidence lesson does not displace matching directive', async () => {
		await seed([
			entry('match0001-0001-4000-9000-000000000001', {
				lesson: 'matching directive',
				confidence: 0.85,
				directive_priority: 'critical',
				triggers: ['phase_complete'],
				applies_to_tools: ['phase_complete'],
			}),
			entry('high0002-0002-4000-9000-000000000002', {
				lesson: 'high-confidence but unrelated',
				confidence: 0.99,
			}),
		]);
		const result = await inject(
			{
				projectName: 't',
				currentPhase: 'Phase 1',
				currentTool: 'phase_complete',
				mode: 'tool_before',
			},
			{ ...cfg, max_inject_count: 1 },
		);
		expect(result[0].id).toBe('match0001-0001-4000-9000-000000000001');
	});
});
