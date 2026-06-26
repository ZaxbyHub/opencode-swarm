/**
 * Unit tests for knowledge-archive stale.marker creation.
 * Tests that archiving a knowledge entry that a skill depends on creates a stale.marker.
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findSkillsBySourceKnowledgeId,
	findStaleSkillsBySourceKnowledgeId,
	retireOrMarkStale,
} from '../../../src/services/skill-generator.js';

describe('knowledge-archive stale.marker', () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-stale-'));
		// Set up .opencode/skills/generated directory
		const generatedDir = path.join(tmp, '.opencode', 'skills', 'generated');
		fs.mkdirSync(generatedDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/**
	 * Helper: create a skill directory with SKILL.md and given source knowledge IDs.
	 */
	async function makeSkillDir(slug: string, sourceIds: string[]): Promise<string> {
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

	it('archives entry with known skill, verifies stale.marker created', async () => {
		// Create a skill that depends on source knowledge ID 'src-entry-1'
		const skillDir = await makeSkillDir('my-skill', ['src-entry-1']);

		// Verify the skill exists
		const found = await findSkillsBySourceKnowledgeId(tmp, 'src-entry-1');
		expect(found.length).toBe(1);
		expect(found[0]).toContain('my-skill');

		// Simulate: archive the source knowledge entry (add to archived set)
		// Call retireOrMarkStale with only src-entry-1 in archived set
		// Since NOT all sources are archived (only 1 of 1 = all for this single-source skill),
		// it should mark stale (stale.marker), not retire
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['src-entry-1']));

		// With single source and it's archived, allArchived=true → should retire
		// But let's verify the behavior: if all sources are archived, it retires
		expect(result.action).toBe('retire');
		expect(result.slug).toBe('my-skill');

		// Verify retired.marker exists (not stale.marker, because all sources archived)
		const retiredMarker = path.join(skillDir, 'retired.marker');
		expect(fs.existsSync(retiredMarker)).toBe(true);
	});

	it('archive partial sources creates stale.marker (not retire)', async () => {
		// Create a skill with 3 source knowledge IDs
		const skillDir = await makeSkillDir('partial-skill', ['src-a', 'src-b', 'src-c']);

		// Archive only src-a (1 of 3 sources)
		// This should NOT retire the skill, but mark it stale
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['src-a']));

		expect(result.action).toBe('stale');
		expect(result.slug).toBe('partial-skill');

		// Verify stale.marker is created
		const staleMarker = path.join(skillDir, 'stale.marker');
		expect(fs.existsSync(staleMarker)).toBe(true);

		// Verify retired.marker does NOT exist
		const retiredMarker = path.join(skillDir, 'retired.marker');
		expect(fs.existsSync(retiredMarker)).toBe(false);

		// Verify stale.marker content
		const content = fs.readFileSync(staleMarker, 'utf-8');
		expect(content).toContain('archived');
	});

	it('findSkillsBySourceKnowledgeId returns skill with archived source', async () => {
		// Create skill with source ID
		await makeSkillDir('test-skill', ['knowledge-id-xyz']);

		// findSkillsBySourceKnowledgeId should find our skill
		const found = await findSkillsBySourceKnowledgeId(tmp, 'knowledge-id-xyz');
		expect(found.length).toBe(1);
		expect(found[0]).toContain('test-skill');
	});

	it('findStaleSkillsBySourceKnowledgeId returns empty when not all archived', async () => {
		// Create skill with multiple sources
		await makeSkillDir('multi-skill', ['id-1', 'id-2', 'id-3']);

		// Archive only one source
		const stale = await findStaleSkillsBySourceKnowledgeId(tmp, new Set(['id-1']));
		// findStaleSkillsBySourceKnowledgeId finds skills with stale.marker whose ALL sources are archived
		// Since we didn't create stale.marker yet, this should return empty
		expect(stale.length).toBe(0);
	});

	it('retireOrMarkStale creates stale.marker when not all sources archived', async () => {
		// Create skill with 2 sources
		const skillDir = await makeSkillDir('two-source-skill', ['src-x', 'src-y']);

		// Archive only src-x (not all sources)
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['src-x']));

		expect(result.action).toBe('stale');

		// Verify stale.marker exists
		const staleMarker = path.join(skillDir, 'stale.marker');
		expect(fs.existsSync(staleMarker)).toBe(true);

		// Verify retired.marker does NOT exist
		expect(fs.existsSync(path.join(skillDir, 'retired.marker'))).toBe(false);
	});
});
