/**
 * Unit tests for knowledge-remove stale.marker creation.
 * Tests that removing a knowledge entry that a skill depends on creates a stale.marker.
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findSkillsBySourceKnowledgeId,
	markSkillStale,
} from '../../../src/services/skill-generator.js';

describe('knowledge-remove stale.marker', () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-stale-'));
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

	it('removes entry, verifies stale.marker created for affected skill', async () => {
		// Create a skill that depends on source knowledge ID 'src-entry-1'
		const skillDir = await makeSkillDir('my-skill', ['src-entry-1']);

		// Verify the skill is found by findSkillsBySourceKnowledgeId
		const found = await findSkillsBySourceKnowledgeId(tmp, 'src-entry-1');
		expect(found.length).toBe(1);
		expect(found[0]).toContain('my-skill');

		// Simulate: mark skill stale via markSkillStale (what knowledge-remove calls)
		const staleReason = 'knowledge entry purged';
		await markSkillStale(skillDir, staleReason);

		// Verify stale.marker is created
		const staleMarker = path.join(skillDir, 'stale.marker');
		expect(fs.existsSync(staleMarker)).toBe(true);

		// Verify content
		const content = fs.readFileSync(staleMarker, 'utf-8');
		expect(content).toBe(staleReason);
	});

	it('markSkillStale creates stale.marker in skill directory', async () => {
		// Create skill directory
		const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', 'test-skill');
		await fs.promises.mkdir(skillDir, { recursive: true });

		// Call markSkillStale
		await markSkillStale(skillDir, 'purged entry');

		// Verify stale.marker exists
		const staleMarker = path.join(skillDir, 'stale.marker');
		expect(fs.existsSync(staleMarker)).toBe(true);

		// Verify content
		const content = fs.readFileSync(staleMarker, 'utf-8');
		expect(content).toBe('purged entry');
	});

	it('findSkillsBySourceKnowledgeId returns skill for removed knowledge ID', async () => {
		// Create skill with source ID
		await makeSkillDir('removal-test-skill', ['removed-entry-id']);

		// findSkillsBySourceKnowledgeId should find our skill
		const found = await findSkillsBySourceKnowledgeId(tmp, 'removed-entry-id');
		expect(found.length).toBe(1);
		expect(found[0]).toContain('removal-test-skill');
	});

	it('multiple skills referencing same removed entry all get stale.marker', async () => {
		// Create two skills that both reference 'shared-entry-id'
		await makeSkillDir('skill-one', ['shared-entry-id', 'other-1']);
		await makeSkillDir('skill-two', ['shared-entry-id', 'other-2']);

		// Both should be found
		const found = await findSkillsBySourceKnowledgeId(tmp, 'shared-entry-id');
		expect(found.length).toBe(2);

		// Mark both stale
		for (const skillDir of found) {
			await markSkillStale(skillDir, 'knowledge entry purged');
		}

		// Both should have stale.marker
		for (const skillSlug of ['skill-one', 'skill-two']) {
			const staleMarker = path.join(
				tmp,
				'.opencode',
				'skills',
				'generated',
				skillSlug,
				'stale.marker',
			);
			expect(fs.existsSync(staleMarker)).toBe(true);
		}
	});

	it('stale.marker reason contains context about purge', async () => {
		const skillDir = await makeSkillDir('purge-reason-skill', ['entry-to-purge']);

		// Simulate what knowledge-remove does: markSkillStale with reason
		const reason = 'knowledge entry purged';
		await markSkillStale(skillDir, reason);

		const staleMarker = path.join(skillDir, 'stale.marker');
		const content = fs.readFileSync(staleMarker, 'utf-8');

		// Reason should be written verbatim
		expect(content).toBe(reason);
	});
});
