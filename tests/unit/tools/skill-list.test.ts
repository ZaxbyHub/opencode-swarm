/**
 * Tests for skill_list tool.
 *
 * Covers:
 * - Happy path: returns listSkills result as JSON
 * - Error handling: when listSkills throws
 * - _internals seam verification
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mockListSkills = mock(async () => ({
	drafts: [
		{ slug: 'test-skill', path: '.swarm/skills/proposals/test-skill.md' },
	],
	active: [
		{
			slug: 'active-skill',
			path: '.opencode/skills/generated/active-skill/SKILL.md',
		},
	],
	stale: [],
}));

// Module-level mock — must be before the tool import
mock.module('../../../src/services/skill-generator.js', () => ({
	listSkills: mockListSkills,
	generateSkills: async () => ({}),
	activateProposal: async () => ({}),
	inspectSkill: async () => ({}),
	regenerateSkill: async () => ({}),
}));

import { _internals } from '../../../src/tools/skill-list';

const { skill_list } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockListSkills.mockClear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'skill-list-test-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	process.chdir(originalCwd);
	try {
		await fs.rm(tmp, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('skill_list tool', () => {
	it('returns JSON result from listSkills', async () => {
		const result = JSON.parse(await skill_list.execute({}, tmp));
		expect(result.drafts).toHaveLength(1);
		expect(result.drafts[0].slug).toBe('test-skill');
		expect(result.active).toHaveLength(1);
		expect(result.active[0].slug).toBe('active-skill');
	});

	it('returns empty lists when no skills exist', async () => {
		mockListSkills.mockResolvedValueOnce({ drafts: [], active: [], stale: [] });
		const result = JSON.parse(await skill_list.execute({}, tmp));
		expect(result.drafts).toEqual([]);
		expect(result.active).toEqual([]);
	});

	it('passes directory to listSkills', async () => {
		await skill_list.execute({}, tmp);
		expect(mockListSkills).toHaveBeenCalledWith(tmp);
	});

	it('returns error JSON when listSkills throws', async () => {
		mockListSkills.mockRejectedValueOnce(new Error('read error'));
		const result = JSON.parse(await skill_list.execute({}, tmp));
		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('execution_error');
	});

	it('returns error JSON when listSkills throws non-Error', async () => {
		mockListSkills.mockRejectedValueOnce('string error');
		const result = JSON.parse(await skill_list.execute({}, tmp));
		expect(result.success).toBe(false);
	});

	describe('_internals seam', () => {
		it('exposes skill_list via _internals', () => {
			expect(_internals.skill_list).toBeDefined();
			expect(typeof _internals.skill_list.execute).toBe('function');
		});
	});

	describe('ADVERSARIAL: malformed inputs and boundary violations', () => {
		it('handles undefined directory gracefully', async () => {
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(await skill_list.execute({}, undefined as any));
			expect(result.success).toBe(false);
		});

		it('handles null directory gracefully', async () => {
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(await skill_list.execute({}, null as any));
			expect(result.success).toBe(false);
		});

		it('handles empty string directory', async () => {
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(await skill_list.execute({}, ''));
			expect(result.success).toBe(false);
		});

		it('handles directory with null byte path traversal', async () => {
			const maliciousDir = '/path/to\x00/../etc';
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(
				await skill_list.execute({}, maliciousDir as any),
			);
			expect(result.success).toBe(false);
		});

		it('handles very long directory path', async () => {
			const longPath = '/tmp/' + 'a'.repeat(10000);
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(await skill_list.execute({}, longPath as any));
			expect(result.success).toBe(false);
		});

		it('handles numeric directory argument', async () => {
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(await skill_list.execute({}, 12345 as any));
			expect(result.success).toBe(false);
		});

		it('handles object as directory argument', async () => {
			mockListSkills.mockRejectedValueOnce(new Error('ENOENT'));
			const result = JSON.parse(
				await skill_list.execute({}, { path: '/tmp' } as any),
			);
			expect(result.success).toBe(false);
		});

		it('handles non-Error rejection from listSkills', async () => {
			mockListSkills.mockRejectedValueOnce({ code: 'ENOENT' });
			const result = JSON.parse(await skill_list.execute({}, tmp));
			expect(result.success).toBe(false);
		});

		it('handles undefined rejection from listSkills', async () => {
			mockListSkills.mockRejectedValueOnce(undefined);
			const result = JSON.parse(await skill_list.execute({}, tmp));
			expect(result.success).toBe(false);
		});

		it('handles null rejection from listSkills', async () => {
			mockListSkills.mockRejectedValueOnce(null);
			const result = JSON.parse(await skill_list.execute({}, tmp));
			expect(result.success).toBe(false);
		});
	});
});
