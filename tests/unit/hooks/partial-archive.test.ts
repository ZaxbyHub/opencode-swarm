/**
 * Unit tests for partial archive scenario (issue #1508).
 * Archive 1 of 3 sources, verify stale.marker created (not retire).
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retireOrMarkStale } from '../../../src/services/skill-generator.js';

describe('partial-archive stale.marker', () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-archive-'));
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

	it('archive 1 of 3 sources creates stale.marker (NOT retire)', async () => {
		// Create a skill with 3 source knowledge IDs
		const skillDir = await makeSkillDir('three-source-skill', ['src-a', 'src-b', 'src-c']);

		// Archive only 1 of the 3 sources
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['src-a']));

		// Should mark stale, NOT retire (because not all sources are archived)
		expect(result.action).toBe('stale');
		expect(result.slug).toBe('three-source-skill');

		// Verify stale.marker is created
		const staleMarker = path.join(skillDir, 'stale.marker');
		expect(fs.existsSync(staleMarker)).toBe(true);

		// Verify retired.marker does NOT exist
		const retiredMarker = path.join(skillDir, 'retired.marker');
		expect(fs.existsSync(retiredMarker)).toBe(false);
	});

	it('archive 2 of 3 sources creates stale.marker (NOT retire)', async () => {
		// Create a skill with 3 source knowledge IDs
		const skillDir = await makeSkillDir('partial-skill-2', ['id-1', 'id-2', 'id-3']);

		// Archive 2 of 3 sources
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['id-1', 'id-2']));

		// Should still mark stale, not retire
		expect(result.action).toBe('stale');
		expect(result.slug).toBe('partial-skill-2');

		// Verify stale.marker is created
		expect(fs.existsSync(path.join(skillDir, 'stale.marker'))).toBe(true);
		expect(fs.existsSync(path.join(skillDir, 'retired.marker'))).toBe(false);
	});

	it('archive ALL 3 sources creates retired.marker (NOT stale)', async () => {
		// Create a skill with 3 source knowledge IDs
		const skillDir = await makeSkillDir('all-archived-skill', ['k1', 'k2', 'k3']);

		// Archive ALL 3 sources
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['k1', 'k2', 'k3']));

		// Should retire (all sources archived)
		expect(result.action).toBe('retire');
		expect(result.slug).toBe('all-archived-skill');

		// Verify retired.marker is created
		const retiredMarker = path.join(skillDir, 'retired.marker');
		expect(fs.existsSync(retiredMarker)).toBe(true);

		// Verify stale.marker does NOT exist
		const staleMarker = path.join(skillDir, 'stale.marker');
		expect(fs.existsSync(staleMarker)).toBe(false);
	});

	it('stale.marker reason indicates partial archive', async () => {
		const skillDir = await makeSkillDir('partial-reason-skill', ['x', 'y', 'z']);

		// Archive only 'x'
		await retireOrMarkStale(tmp, skillDir, new Set(['x']));

		const staleMarker = path.join(skillDir, 'stale.marker');
		const content = fs.readFileSync(staleMarker, 'utf-8');

		// Reason should mention archived sources
		expect(content).toContain('archived');
	});

	it('multiple skills with partial archive each get stale.marker', async () => {
		// Create two skills with overlapping but different source sets
		await makeSkillDir('skill-alpha', ['shared-1', 'unique-a']);
		await makeSkillDir('skill-beta', ['shared-1', 'unique-b']);

		// Archive shared-1 (partial for both skills)
		const foundAlpha = await retireOrMarkStale(
			tmp,
			path.join(tmp, '.opencode', 'skills', 'generated', 'skill-alpha'),
			new Set(['shared-1']),
		);
		const foundBeta = await retireOrMarkStale(
			tmp,
			path.join(tmp, '.opencode', 'skills', 'generated', 'skill-beta'),
			new Set(['shared-1']),
		);

		// Both should be marked stale
		expect(foundAlpha.action).toBe('stale');
		expect(foundBeta.action).toBe('stale');

		// Both should have stale.marker
		expect(fs.existsSync(path.join(tmp, '.opencode', 'skills', 'generated', 'skill-alpha', 'stale.marker'))).toBe(true);
		expect(fs.existsSync(path.join(tmp, '.opencode', 'skills', 'generated', 'skill-beta', 'stale.marker'))).toBe(true);
	});

	it('empty source_knowledge_ids array marks stale when any source archived', async () => {
		// Create a skill with empty source knowledge IDs
		const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', 'empty-sources');
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(
			path.join(skillDir, 'SKILL.md'),
			['---', 'name: empty-sources', '---', '# Empty Sources'].join('\n'),
			'utf-8',
		);

		// Archive any source (even though there are none)
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['any-id']));

		// Empty source IDs → allArchived=false → marks stale
		expect(result.action).toBe('stale');
		expect(fs.existsSync(path.join(skillDir, 'stale.marker'))).toBe(true);
	});
});
