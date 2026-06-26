/**
 * Unit tests for skill-propagation-gate stale exclusion (issue #1508).
 * Skill with stale.marker not injected by the gate.
 *
 * Uses _internals DI seam for mocking — no mock.module (leaks in Bun).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAvailableSkills } from '../../../src/hooks/skill-propagation-gate.js';

describe('skill-propagation-gate-stale', () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-gate-stale-'));
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
			staleMarker?: string | null;
			retiredMarker?: boolean;
		} = {},
	): Promise<string> {
		const skillDir = path.join(tmp, '.claude', 'skills', slug);
		await fs.promises.mkdir(skillDir, { recursive: true });

		await fs.promises.writeFile(
			path.join(skillDir, 'SKILL.md'),
			['---', `name: ${slug}`, '---', `# ${slug}`].join('\n'),
			'utf-8',
		);

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

	it('skill with stale.marker is NOT in available skills', async () => {
		// Create a stale skill
		await makeSkillDir('stale-skill', { staleMarker: 'needs regeneration' });

		// Discover available skills
		const available = discoverAvailableSkills(tmp);

		// stale-skill should NOT appear
		expect(available).not.toContainEqual(expect.stringContaining('stale-skill'));
	});

	it('skill with retired.marker is NOT in available skills', async () => {
		// Create a retired skill
		await makeSkillDir('retired-skill', { retiredMarker: true });

		// Discover available skills
		const available = discoverAvailableSkills(tmp);

		// retired-skill should NOT appear
		expect(available).not.toContainEqual(expect.stringContaining('retired-skill'));
	});

	it('skill without stale/retired marker IS in available skills', async () => {
		// Create a normal active skill
		const skillDir = await makeSkillDir('active-skill');

		// Discover available skills
		const available = discoverAvailableSkills(tmp);

		// active-skill should appear
		const normalizedAvailable = available.map((s) => s.replace(/\\/g, '/'));
		expect(normalizedAvailable).toContainEqual(
			expect.stringContaining('.claude/skills/active-skill/SKILL.md'),
		);
	});

	it('stale skill mixed with active skills: only stale is excluded', async () => {
		// Create multiple skills: some active, some stale
		await makeSkillDir('active-one');
		await makeSkillDir('active-two');
		await makeSkillDir('stale-skill', { staleMarker: 'old content' });
		await makeSkillDir('active-three');

		// Discover available skills
		const available = discoverAvailableSkills(tmp);
		const normalizedAvailable = available.map((s) => s.replace(/\\/g, '/'));

		// Active skills should be present
		expect(normalizedAvailable).toContainEqual(
			expect.stringContaining('.claude/skills/active-one/SKILL.md'),
		);
		expect(normalizedAvailable).toContainEqual(
			expect.stringContaining('.claude/skills/active-two/SKILL.md'),
		);
		expect(normalizedAvailable).toContainEqual(
			expect.stringContaining('.claude/skills/active-three/SKILL.md'),
		);

		// stale-skill should NOT be present
		expect(normalizedAvailable).not.toContainEqual(
			expect.stringContaining('stale-skill'),
		);
	});

	it('empty stale.marker content still excludes skill', async () => {
		// Create a skill with empty stale.marker
		await makeSkillDir('empty-stale-skill', { staleMarker: '' });

		// Discover available skills
		const available = discoverAvailableSkills(tmp);
		const normalizedAvailable = available.map((s) => s.replace(/\\/g, '/'));

		// empty-stale-skill should NOT appear (stale.marker exists regardless of content)
		expect(normalizedAvailable).not.toContainEqual(
			expect.stringContaining('empty-stale-skill'),
		);
	});

	it('multiple stale skills all excluded', async () => {
		// Create multiple stale skills
		await makeSkillDir('stale-alpha', { staleMarker: 'reason a' });
		await makeSkillDir('stale-beta', { staleMarker: 'reason b' });
		await makeSkillDir('stale-gamma', { staleMarker: 'reason c' });

		// Discover available skills
		const available = discoverAvailableSkills(tmp);
		const normalizedAvailable = available.map((s) => s.replace(/\\/g, '/'));

		// None of the stale skills should appear
		for (const slug of ['stale-alpha', 'stale-beta', 'stale-gamma']) {
			expect(normalizedAvailable).not.toContainEqual(
				expect.stringContaining(slug),
			);
		}
	});
});
