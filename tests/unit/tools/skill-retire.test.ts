/**
 * Tests for skill_retire tool and retireSkill service.
 *
 * Covers:
 * - retireSkill: marker creation, invalid slug, skill-not-found, JSON content,
 *   SKILL.md preservation, custom reason, listSkills exclusion
 * - skill_retire tool: delegation, missing slug error, optional reason passthrough
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { listSkills, retireSkill } from '../../../src/services/skill-generator';
import {
	skill_retire,
	_internals as toolInternals,
} from '../../../src/tools/skill-retire';

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mock.restore();
	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'swarm-skill-retire-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});
afterEach(async () => {
	process.chdir(originalCwd);
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

// ---------------------------------------------------------------------------
// Helper: create a valid active skill directory with SKILL.md
// ---------------------------------------------------------------------------
async function createActiveSkill(
	slug: string,
	body = '# Test Skill\n',
): Promise<string> {
	const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
	await mkdir(skillDir, { recursive: true });
	await writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');
	return skillDir;
}

// ============================================================================
// retireSkill tests
// ============================================================================

describe('retireSkill', () => {
	it('happy path: creates marker file, returns retired: true', async () => {
		await createActiveSkill('my-skill');
		const result = await retireSkill(tmp, 'my-skill');
		expect(result.retired).toBe(true);
		expect(result.markerPath).toContain('retired.marker');
		expect(existsSync(result.markerPath)).toBe(true);
	});

	it('skill not found: returns retired: false, reason: "active skill not found"', async () => {
		const result = await retireSkill(tmp, 'nonexistent-skill');
		expect(result.retired).toBe(false);
		expect(result.reason).toBe('active skill not found');
	});

	it('invalid slug: returns retired: false, reason: "invalid slug"', async () => {
		// Empty string is definitely invalid after sanitization
		const result = await retireSkill(tmp, '');
		expect(result.retired).toBe(false);
		expect(result.reason).toBe('invalid slug');
	});

	it('marker contains correct JSON with retiredAt and reason fields', async () => {
		await createActiveSkill('json-check');
		await retireSkill(tmp, 'json-check', 'no longer relevant');
		const content = readFileSync(
			path.join(
				tmp,
				'.opencode',
				'skills',
				'generated',
				'json-check',
				'retired.marker',
			),
			'utf-8',
		);
		const marker = JSON.parse(content);
		expect(marker.retiredAt).toBeString();
		expect(marker.reason).toBe('no longer relevant');
		// Verify ISO timestamp is valid
		expect(new Date(marker.retiredAt).toISOString()).toBe(marker.retiredAt);
	});

	it('SKILL.md is NOT deleted after retirement', async () => {
		const skillDir = await createActiveSkill('preserve-test');
		const skillPath = path.join(skillDir, 'SKILL.md');
		await retireSkill(tmp, 'preserve-test');
		expect(existsSync(skillPath)).toBe(true);
		const content = readFileSync(skillPath, 'utf-8');
		expect(content).toContain('# Test Skill');
	});

	it('custom reason is persisted in marker', async () => {
		await createActiveSkill('custom-reason');
		await retireSkill(tmp, 'custom-reason', 'superseded by new skill');
		const markerPath = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'custom-reason',
			'retired.marker',
		);
		const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
		expect(marker.reason).toBe('superseded by new skill');
	});

	it('default reason "manual_retire" when no reason provided', async () => {
		await createActiveSkill('default-reason');
		await retireSkill(tmp, 'default-reason');
		const markerPath = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'default-reason',
			'retired.marker',
		);
		const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
		expect(marker.reason).toBe('manual_retire');
	});

	it('listSkills excludes retired skills', async () => {
		await createActiveSkill('active-skill');
		await createActiveSkill('will-be-retired');
		const listBefore = await listSkills(tmp);
		expect(listBefore.active.map((s) => s.slug)).toContain('active-skill');
		expect(listBefore.active.map((s) => s.slug)).toContain('will-be-retired');

		await retireSkill(tmp, 'will-be-retired');
		const listAfter = await listSkills(tmp);
		expect(listAfter.active.map((s) => s.slug)).toContain('active-skill');
		expect(listAfter.active.map((s) => s.slug)).not.toContain(
			'will-be-retired',
		);
	});
});

// ============================================================================
// skill_retire tool tests
// ============================================================================

describe('skill_retire tool', () => {
	it('happy path: delegates to retireSkill and returns JSON result', async () => {
		await createActiveSkill('tool-test');
		// createSwarmTool uses ctx?.directory ?? process.cwd()
		// process.chdir(tmp) in beforeEach ensures process.cwd() returns tmp
		const result = await skill_retire.execute({ slug: 'tool-test' });
		const parsed = JSON.parse(result);
		expect(parsed.retired).toBe(true);
	});

	it('missing slug returns error JSON with reason "slug required"', async () => {
		const result = await skill_retire.execute({});
		const parsed = JSON.parse(result);
		expect(parsed.retired).toBe(false);
		expect(parsed.reason).toBe('slug required');
	});

	it('null slug returns error JSON with reason "slug required"', async () => {
		const result = await skill_retire.execute({ slug: null });
		const parsed = JSON.parse(result);
		expect(parsed.retired).toBe(false);
		expect(parsed.reason).toBe('slug required');
	});

	it('optional reason is passed through to retireSkill', async () => {
		await createActiveSkill('reason-pass');
		const result = await skill_retire.execute({
			slug: 'reason-pass',
			reason: 'custom退休reason',
		});
		const parsed = JSON.parse(result);
		expect(parsed.retired).toBe(true);
		// Verify marker contains the custom reason
		const markerPath = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'reason-pass',
			'retired.marker',
		);
		const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
		expect(marker.reason).toBe('custom退休reason');
	});
});

// ============================================================================
// _internals DI seam verification
// ============================================================================

describe('_internals seam for skill_retire', () => {
	it('exposes skill_retire via _internals', () => {
		expect(toolInternals.skill_retire).toBeDefined();
		expect(typeof toolInternals.skill_retire.execute).toBe('function');
	});
});
