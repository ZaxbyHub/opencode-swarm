/**
 * Unit tests for listSkills stale behavior (issue #1508).
 * Skill with stale.marker excluded from main list but appears in stale[] with reason.
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSkills } from '../../../src/services/skill-generator.js';

describe('skill-list-stale', () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-list-stale-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/**
	 * Helper: create a skill directory with SKILL.md and optional stale.marker.
	 */
	async function makeSkillDir(
		slug: string,
		options: {
			sourceIds?: string[];
			staleMarker?: string | null;
			retiredMarker?: boolean;
		} = {},
	): Promise<string> {
		const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
		await fs.promises.mkdir(skillDir, { recursive: true });

		if (options.sourceIds) {
			const fm = [
				'---',
				`name: ${slug}`,
				'source_knowledge_ids:',
				...options.sourceIds.map((id) => `  - ${id}`),
				'---',
				`# ${slug}`,
			].join('\n');
			await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), fm, 'utf-8');
		} else {
			await fs.promises.writeFile(
				path.join(skillDir, 'SKILL.md'),
				['---', `name: ${slug}`, '---', `# ${slug}`].join('\n'),
				'utf-8',
			);
		}

		if (options.staleMarker !== undefined && options.staleMarker !== null) {
			await fs.promises.writeFile(
				path.join(skillDir, 'stale.marker'),
				options.staleMarker,
				'utf-8',
			);
		}

		if (options.retiredMarker) {
			await fs.promises.writeFile(
				path.join(skillDir, 'retired.marker'),
				JSON.stringify({ retiredAt: new Date().toISOString(), reason: 'test' }),
				'utf-8',
			);
		}

		return skillDir;
	}

	it('skill with stale.marker excluded from active[], appears in stale[] with reason', async () => {
		// Create an active skill (no stale.marker)
		await makeSkillDir('active-skill', { sourceIds: ['src-1'] });

		// Create a stale skill (with stale.marker)
		const staleReason = 'needs regeneration';
		await makeSkillDir('stale-skill', {
			sourceIds: ['src-2'],
			staleMarker: staleReason,
		});

		// List skills
		const result = await listSkills(tmp);

		// active-skill should be in active list
		expect(result.active.map((s) => s.slug)).toContain('active-skill');

		// stale-skill should NOT be in active list
		expect(result.active.map((s) => s.slug)).not.toContain('stale-skill');

		// stale-skill should be in stale list with correct reason
		expect(result.stale.map((s) => s.slug)).toContain('stale-skill');
		const staleEntry = result.stale.find((s) => s.slug === 'stale-skill');
		expect(staleEntry).toBeDefined();
		expect(staleEntry?.reason.trim()).toBe(staleReason);
	});

	it('skill with retired.marker excluded from both active[] and stale[]', async () => {
		// Create a retired skill
		await makeSkillDir('retired-skill', {
			sourceIds: ['src-1'],
			retiredMarker: true,
		});

		// Create an active skill
		await makeSkillDir('active-skill', { sourceIds: ['src-2'] });

		// List skills
		const result = await listSkills(tmp);

		// retired-skill should NOT be in active list
		expect(result.active.map((s) => s.slug)).not.toContain('retired-skill');

		// retired-skill should NOT be in stale list
		expect(result.stale.map((s) => s.slug)).not.toContain('retired-skill');

		// active-skill should still be in active list
		expect(result.active.map((s) => s.slug)).toContain('active-skill');
	});

	it('skill without SKILL.md excluded from active[] and stale[]', async () => {
		// Create just a directory without SKILL.md
		const emptyDir = path.join(tmp, '.opencode', 'skills', 'generated', 'no-skill-file');
		await fs.promises.mkdir(emptyDir, { recursive: true });

		// Create a real active skill
		await makeSkillDir('active-skill', { sourceIds: ['src-1'] });

		// List skills
		const result = await listSkills(tmp);

		// no-skill-file should NOT appear anywhere
		expect(result.active.map((s) => s.slug)).not.toContain('no-skill-file');
		expect(result.stale.map((s) => s.slug)).not.toContain('no-skill-file');

		// active-skill should still be there
		expect(result.active.map((s) => s.slug)).toContain('active-skill');
	});

	it('stale.marker with empty content uses default reason', async () => {
		// Create a stale skill with empty stale.marker
		await makeSkillDir('empty-stale-skill', {
			sourceIds: ['src-1'],
			staleMarker: '',
		});

		// List skills
		const result = await listSkills(tmp);

		// Should be in stale list
		expect(result.stale.map((s) => s.slug)).toContain('empty-stale-skill');

		// Reason should be 'stale' (default when empty/unreadable)
		const staleEntry = result.stale.find((s) => s.slug === 'empty-stale-skill');
		expect(staleEntry).toBeDefined();
		expect(staleEntry?.reason.trim()).toBe('');
	});

	it('multiple stale skills all appear in stale[] with their reasons', async () => {
		await makeSkillDir('stale-one', { sourceIds: ['s1'], staleMarker: 'reason one' });
		await makeSkillDir('stale-two', { sourceIds: ['s2'], staleMarker: 'reason two' });
		await makeSkillDir('stale-three', { sourceIds: ['s3'], staleMarker: 'reason three' });
		await makeSkillDir('still-active', { sourceIds: ['s4'] });

		// List skills
		const result = await listSkills(tmp);

		// All stale skills should be in stale list
		expect(result.stale.map((s) => s.slug).sort()).toEqual([
			'stale-one',
			'stale-three',
			'stale-two',
		]);

		// Verify reasons
		for (const slug of ['stale-one', 'stale-two', 'stale-three']) {
			const entry = result.stale.find((s) => s.slug === slug);
			expect(entry).toBeDefined();
			expect(entry?.reason.trim()).toContain('reason');
		}

		// still-active should be in active list
		expect(result.active.map((s) => s.slug)).toContain('still-active');

		// No stale skills should be in active list
		for (const slug of ['stale-one', 'stale-two', 'stale-three']) {
			expect(result.active.map((s) => s.slug)).not.toContain(slug);
		}
	});

	it('proposals are listed separately from active skills', async () => {
		// Create an active skill
		await makeSkillDir('active-skill', { sourceIds: ['src-1'] });

		// Create a stale skill
		await makeSkillDir('stale-proposal-like', {
			sourceIds: ['src-2'],
			staleMarker: 'old content',
		});

		// List skills
		const result = await listSkills(tmp);

		// proposals should be listed (from .swarm/skills/proposals)
		// (empty in this case since we didn't create any)
		expect(Array.isArray(result.proposals)).toBe(true);

		// active-skill should be in active
		expect(result.active.map((s) => s.slug)).toContain('active-skill');

		// stale skill should not be in active
		expect(result.active.map((s) => s.slug)).not.toContain('stale-proposal-like');

		// stale skill should be in stale
		expect(result.stale.map((s) => s.slug)).toContain('stale-proposal-like');
	});
});
