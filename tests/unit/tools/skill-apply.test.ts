/**
 * Tests for skill_apply tool.
 *
 * Covers:
 * - Parameter validation: missing slug
 * - Happy path: delegates to activateProposal
 * - Force parameter passthrough
 * - Error handling: when activateProposal throws
 * - _internals seam verification
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mockActivateProposal = mock(async () => ({
	activated: true,
	path: '.opencode/skills/generated/test-skill/SKILL.md',
}));

// Module-level mock — must be before the tool import
mock.module('../../../src/services/skill-generator.js', () => ({
	activateProposal: mockActivateProposal,
	generateSkills: async () => ({}),
	listSkills: async () => ({ drafts: [], active: [], stale: [] }),
	inspectSkill: async () => ({}),
	regenerateSkill: async () => ({}),
}));

import { _internals } from '../../../src/tools/skill-apply';

const { skill_apply } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockActivateProposal.mockClear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'skill-apply-test-')),
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

describe('skill_apply tool', () => {
	describe('parameter validation', () => {
		it('returns error for missing slug', async () => {
			const result = JSON.parse(await skill_apply.execute({}, tmp));
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for null slug', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: null as any }, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for empty string slug', async () => {
			const result = JSON.parse(await skill_apply.execute({ slug: '' }, tmp));
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for non-string slug', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: 123 as any }, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for null args', async () => {
			const result = JSON.parse(await skill_apply.execute(null as any, tmp));
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});
	});

	describe('happy path', () => {
		it('delegates to activateProposal and returns success', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'test-skill' }, tmp),
			);
			expect(result.activated).toBe(true);
			expect(result.path).toContain('test-skill');
			expect(mockActivateProposal).toHaveBeenCalledWith(
				tmp,
				'test-skill',
				false,
				{ evaluate: false },
			);
		});

		it('passes force=true to activateProposal', async () => {
			await skill_apply.execute({ slug: 'test-skill', force: true }, tmp);
			expect(mockActivateProposal).toHaveBeenCalledWith(
				tmp,
				'test-skill',
				true,
				{ evaluate: false },
			);
		});

		it('defaults force to false', async () => {
			await skill_apply.execute({ slug: 'test-skill' }, tmp);
			expect(mockActivateProposal).toHaveBeenCalledWith(
				tmp,
				'test-skill',
				false,
				{ evaluate: false },
			);
		});

		it('passes evaluate=true to activateProposal', async () => {
			await skill_apply.execute({ slug: 'test-skill', evaluate: true }, tmp);
			expect(mockActivateProposal).toHaveBeenCalledWith(
				tmp,
				'test-skill',
				false,
				{ evaluate: true },
			);
		});
	});

	describe('error handling', () => {
		it('returns error JSON when activateProposal throws', async () => {
			mockActivateProposal.mockRejectedValueOnce(
				new Error('proposal not found'),
			);
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'nonexistent' }, tmp),
			);
			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('execution_error');
		});
	});

	describe('_internals seam', () => {
		it('exposes skill_apply via _internals', () => {
			expect(_internals.skill_apply).toBeDefined();
			expect(typeof _internals.skill_apply.execute).toBe('function');
		});
	});

	describe('ADVERSARIAL: malformed inputs and boundary violations', () => {
		it('rejects slug with path traversal attempt', async () => {
			mockActivateProposal.mockRejectedValueOnce(
				new Error('path traversal blocked'),
			);
			const result = JSON.parse(
				await skill_apply.execute({ slug: '../../../etc/passwd' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no null byte sanitization at tool level
		it('accepts slug with null byte injection', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'skill\x00/../../../etc' }, tmp),
			);
			// Tool passes to service which rejects, returns execution_error
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no shell metachar sanitization at tool level
		it('accepts slug with shell metacharacters (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'skill;rm -rf /' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no template literal sanitization at tool level
		it('accepts slug with template literal injection (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: '${process.env.SECRET}' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no HTML/script sanitization at tool level
		it('accepts slug with HTML/script injection (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: '<script>alert(1)</script>' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no max length validation at tool level
		it('accepts very long slug (>= 256 chars) (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('slug too long'));
			const longSlug = 'a'.repeat(256);
			const result = JSON.parse(
				await skill_apply.execute({ slug: longSlug }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: whitespace-only slug passes typeof check
		it('accepts slug with only whitespace (tool does not trim)', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: '   ' }, tmp),
			);
			expect(result.activated).toBe(true);
		});

		// VULNERABILITY: null bytes pass typeof string check
		it('accepts slug with only null bytes (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: '\x00\x00\x00' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: Unicode RTL override not sanitized
		it('accepts slug with Unicode RTL override (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'skill\u202ename' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: emoji not sanitized
		it('accepts slug with emoji (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'skill🔥' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: force type not validated at tool level
		it('accepts force as non-boolean string (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'test', force: 'yes' as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: force type not validated at tool level
		it('accepts force as number (service validates)', async () => {
			mockActivateProposal.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_apply.execute({ slug: 'test', force: 1 as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug as boolean true', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: true as any }, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('rejects slug as number', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: 0 as any }, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('rejects slug as array', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: ['a', 'b'] as any }, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('rejects slug as object', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: { name: 'test' } as any }, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		// VULNERABILITY: __proto__ pollution not blocked at tool level
		it('accepts args with __proto__ pollution', async () => {
			const pollutedArgs = { __proto__: { admin: true }, slug: 'test' };
			const result = JSON.parse(
				await skill_apply.execute(pollutedArgs as any, tmp),
			);
			expect(result.activated).toBe(true);
		});

		// VULNERABILITY: constructor.prototype pollution not blocked at tool level
		it('accepts args with constructor.prototype pollution', async () => {
			const pollutedArgs = {
				constructor: { prototype: { admin: true } },
				slug: 'test',
			};
			const result = JSON.parse(
				await skill_apply.execute(pollutedArgs as any, tmp),
			);
			expect(result.activated).toBe(true);
		});

		it('rejects empty object args', async () => {
			const result = JSON.parse(await skill_apply.execute({}, tmp));
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('handles undefined slug', async () => {
			const result = JSON.parse(
				await skill_apply.execute({ slug: undefined } as any, tmp),
			);
			expect(result.activated).toBe(false);
			expect(result.reason).toBe('slug required');
		});
	});
});
