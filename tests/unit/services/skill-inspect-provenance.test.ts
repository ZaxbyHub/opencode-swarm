/**
 * Unit tests for skill_inspect provenance reporting (issue #1508).
 * Verifies source_knowledge_status returns correct status per source ID.
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectSkill } from '../../../src/services/skill-generator.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';

describe('skill-inspect-provenance', () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-inspect-prov-'));
		// Set up .opencode/skills/generated directory
		const generatedDir = path.join(tmp, '.opencode', 'skills', 'generated');
		fs.mkdirSync(generatedDir, { recursive: true });
		// Set up .swarm directory for knowledge
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/**
	 * Helper: create a skill with given source knowledge IDs in frontmatter.
	 */
	async function makeSkillDir(
		slug: string,
		sourceIds: string[],
	): Promise<string> {
		const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
		await fs.promises.mkdir(skillDir, { recursive: true });
		const fm = [
			'---',
			`name: ${slug}`,
			'source_knowledge_ids:',
			...sourceIds.map((id) => `  - ${id}`),
			'---',
			`# ${slug}`,
		].join('\n');
		await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), fm, 'utf-8');
		return skillDir;
	}

	/**
	 * Helper: append a knowledge entry to the swarm knowledge file.
	 */
	async function appendKnowledgeEntry(
		id: string,
		status: 'active' | 'archived' | 'quarantined',
	): Promise<void> {
		const knowledgePath = path.join(tmp, '.swarm', 'knowledge.jsonl');
		const entry: SwarmKnowledgeEntry = {
			id,
			tier: 'swarm',
			lesson: `Lesson for ${id}`,
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.8,
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
		};
		const line = JSON.stringify(entry) + '\n';
		await fs.promises.appendFile(knowledgePath, line, 'utf-8');
	}

	it('source_knowledge_status returns active for active entries', async () => {
		// Create skill with one source ID
		await makeSkillDir('single-source', ['active-entry-id']);

		// Add the entry as active in knowledge store
		await appendKnowledgeEntry('active-entry-id', 'active');

		// Inspect the skill
		const result = await inspectSkill(tmp, 'single-source', 'active');

		expect(result.found).toBe(true);
		expect(result.source_knowledge_status).toBeDefined();
		expect(result.source_knowledge_status).toHaveLength(1);
		expect(result.source_knowledge_status![0]).toEqual({
			id: 'active-entry-id',
			status: 'active',
		});
	});

	it('source_knowledge_status returns archived for archived entries', async () => {
		// Create skill with one source ID
		await makeSkillDir('archived-source', ['archived-entry-id']);

		// Add the entry as archived in knowledge store
		await appendKnowledgeEntry('archived-entry-id', 'archived');

		// Inspect the skill
		const result = await inspectSkill(tmp, 'archived-source', 'active');

		expect(result.found).toBe(true);
		expect(result.source_knowledge_status).toBeDefined();
		expect(result.source_knowledge_status![0]).toEqual({
			id: 'archived-entry-id',
			status: 'archived',
		});
	});

	it('source_knowledge_status returns deleted for missing entries', async () => {
		// Create skill with a source ID that doesn't exist in knowledge store
		await makeSkillDir('missing-source', ['non-existent-id']);

		// Inspect the skill
		const result = await inspectSkill(tmp, 'missing-source', 'active');

		expect(result.found).toBe(true);
		expect(result.source_knowledge_status).toBeDefined();
		expect(result.source_knowledge_status![0]).toEqual({
			id: 'non-existent-id',
			status: 'deleted',
		});
	});

	it('source_knowledge_status returns correct status for mixed entries', async () => {
		// Create skill with 3 source IDs
		await makeSkillDir('mixed-sources', ['id-active', 'id-archived', 'id-deleted']);

		// Add active and archived entries to knowledge store
		await appendKnowledgeEntry('id-active', 'active');
		await appendKnowledgeEntry('id-archived', 'archived');
		// id-deleted is NOT added (will be 'deleted')

		// Inspect the skill
		const result = await inspectSkill(tmp, 'mixed-sources', 'active');

		expect(result.found).toBe(true);
		expect(result.source_knowledge_status).toBeDefined();
		expect(result.source_knowledge_status).toHaveLength(3);

		// Verify each status
		const statusMap = new Map(
			result.source_knowledge_status!.map((s) => [s.id, s.status]),
		);
		expect(statusMap.get('id-active')).toBe('active');
		expect(statusMap.get('id-archived')).toBe('archived');
		expect(statusMap.get('id-deleted')).toBe('deleted');
	});

	it('source_knowledge_status returns quarantined as archived', async () => {
		// Create skill with one source ID
		await makeSkillDir('quarantined-source', ['quarantined-entry-id']);

		// Add the entry as quarantined in knowledge store
		await appendKnowledgeEntry('quarantined-entry-id', 'quarantined');

		// Inspect the skill
		const result = await inspectSkill(tmp, 'quarantined-source', 'active');

		expect(result.found).toBe(true);
		expect(result.source_knowledge_status).toBeDefined();
		// Quarantined entries should be reported as 'archived'
		expect(result.source_knowledge_status![0]).toEqual({
			id: 'quarantined-entry-id',
			status: 'archived',
		});
	});

	it('skill without source_knowledge_ids has undefined source_knowledge_status', async () => {
		// Create skill without source knowledge IDs
		const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', 'no-sources');
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(
			path.join(skillDir, 'SKILL.md'),
			['---', 'name: no-sources', '---', '# No Sources'].join('\n'),
			'utf-8',
		);

		// Inspect the skill
		const result = await inspectSkill(tmp, 'no-sources', 'active');

		expect(result.found).toBe(true);
		// When there are no source knowledge IDs, source_knowledge_status is not set (undefined)
		expect(result.source_knowledge_status).toBeUndefined();
	});

	it('stale_reason is present when stale.marker exists', async () => {
		// Create skill with stale.marker
		const skillDir = await makeSkillDir('stale-inspect', ['src-id']);
		const staleReason = 'needs regeneration';
		await fs.promises.writeFile(
			path.join(skillDir, 'stale.marker'),
			staleReason,
			'utf-8',
		);

		// Add a knowledge entry so inspect doesn't error
		await appendKnowledgeEntry('src-id', 'active');

		// Inspect the skill
		const result = await inspectSkill(tmp, 'stale-inspect', 'active');

		expect(result.found).toBe(true);
		expect(result.stale_reason).toBeDefined();
		expect(result.stale_reason?.trim()).toBe(staleReason);
	});

	it('stale_reason is absent when no stale.marker exists', async () => {
		// Create skill without stale.marker
		await makeSkillDir('fresh-skill', ['src-id']);
		await appendKnowledgeEntry('src-id', 'active');

		// Inspect the skill
		const result = await inspectSkill(tmp, 'fresh-skill', 'active');

		expect(result.found).toBe(true);
		expect(result.stale_reason).toBeUndefined();
	});
});
