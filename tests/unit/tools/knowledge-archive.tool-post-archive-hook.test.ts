/**
 * Post-archive hook tests for knowledge_archive tool.
 * Part 3 of 3 for knowledge-archive.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	getArchivedKnowledgeIds,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';
import { makeCtx } from './_knowledge-archive-helpers';

describe('post-archive hook', () => {
	let dir: string;
	let origHome: string;

	beforeEach(() => {
		dir = join(
			tmpdir(),
			`ka-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		origHome = process.env.HOME;
		process.env.HOME = dir;
	});

	afterEach(() => {
		process.env.HOME = origHome;
		rmSync(dir, { force: true, recursive: true });
	});

	async function appendKnowledgeEntry(
		id: string,
		status: string,
	): Promise<void> {
		const swarmPath = resolveSwarmKnowledgePath(dir);
		const { appendKnowledge } = await import(
			'../../../src/hooks/knowledge-store'
		);
		await appendKnowledge(swarmPath, {
			id,
			tier: 'swarm',
			lesson: `Lesson ${id}`,
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status,
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
		} satisfies SwarmKnowledgeEntry);
	}

	it('archives entry successfully (verifies post-archive hook is wired)', async () => {
		await appendKnowledgeEntry('src-entry-1', 'candidate');

		const raw = await knowledge_archive.execute(
			{ id: 'src-entry-1', reason: 'test-reason' },
			makeCtx(dir),
		);
		const result = JSON.parse(raw);

		expect(result.success).toBe(true);
		expect(result.id).toBe('src-entry-1');
		expect(result.status).toBe('archived');
	});

	it('retires stale skill when all its sources are archived (file-based verification)', async () => {
		await appendKnowledgeEntry('src-entry-1', 'candidate');

		const skillDir = join(
			dir,
			'.opencode',
			'skills',
			'generated',
			'stale-skill-x',
		);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, 'SKILL.md'),
			[
				'---',
				'name: stale-skill-x',
				'source_knowledge_ids:',
				'  - src-entry-1',
				'---',
				'# Stale Skill X',
			].join('\n'),
		);
		writeFileSync(join(skillDir, 'stale.marker'), 'needs regen\n');

		const raw = await knowledge_archive.execute(
			{ id: 'src-entry-1', reason: 'test-reason' },
			makeCtx(dir),
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(true);

		// Wait for microtask to fire
		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		expect(existsSync(join(skillDir, 'retired.marker'))).toBe(true);
	});

	it('getArchivedKnowledgeIds returns archived and quarantined entry IDs', async () => {
		const swarmPath = resolveSwarmKnowledgePath(dir);
		const { appendKnowledge, readKnowledge } = await import(
			'../../../src/hooks/knowledge-store'
		);

		await appendKnowledge(swarmPath, {
			id: 'archived-entry',
			tier: 'swarm',
			lesson: 'L',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'archived',
			confirmed_by: [],
			project_name: 'test',
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: '',
			updated_at: '',
		} satisfies SwarmKnowledgeEntry);
		await appendKnowledge(swarmPath, {
			id: 'quarantined-entry',
			tier: 'swarm',
			lesson: 'L',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'quarantined',
			confirmed_by: [],
			project_name: 'test',
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: '',
			updated_at: '',
		} satisfies SwarmKnowledgeEntry);
		await appendKnowledge(swarmPath, {
			id: 'active-entry',
			tier: 'swarm',
			lesson: 'L',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			project_name: 'test',
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: '',
			updated_at: '',
		} satisfies SwarmKnowledgeEntry);

		const ids = await getArchivedKnowledgeIds(dir);
		expect(ids).toContain('archived-entry');
		expect(ids).toContain('quarantined-entry');
		expect(ids).not.toContain('active-entry');
	});
});
