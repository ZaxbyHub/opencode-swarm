/**
 * Tests for skill_inspect tool.
 *
 * Covers:
 * - Parameter validation: missing slug
 * - Happy path: delegates to inspectSkill
 * - Prefer parameter passthrough and default
 * - Error handling: when inspectSkill throws
 * - _internals seam verification
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mockInspectSkill = mock(async () => ({
	found: true,
	slug: 'test-skill',
	prefer: 'auto',
	body: '# Test Skill\n\nSome content.',
	metadata: { confidence: 0.9, status: 'active' },
}));

// Module-level mock — must be before the tool import
mock.module('../../../src/services/skill-generator.js', () => ({
	inspectSkill: mockInspectSkill,
	generateSkills: async () => ({}),
	listSkills: async () => ({ drafts: [], active: [] }),
	activateProposal: async () => ({}),
	regenerateSkill: async () => ({}),
}));

import { _internals } from '../../../src/tools/skill-inspect';

const { skill_inspect } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockInspectSkill.mockClear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'skill-inspect-test-')),
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

describe('skill_inspect tool', () => {
	describe('parameter validation', () => {
		it('returns error for missing slug', async () => {
			const result = JSON.parse(await skill_inspect.execute({}, tmp));
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for null slug', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: null as any }, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for empty string slug', async () => {
			const result = JSON.parse(await skill_inspect.execute({ slug: '' }, tmp));
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for non-string slug', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 42 as any }, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('returns error for null args', async () => {
			const result = JSON.parse(await skill_inspect.execute(null as any, tmp));
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});
	});

	describe('happy path', () => {
		it('delegates to inspectSkill and returns result', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'test-skill' }, tmp),
			);
			expect(result.found).toBe(true);
			expect(result.slug).toBe('test-skill');
			expect(mockInspectSkill).toHaveBeenCalledWith(tmp, 'test-skill', 'auto');
		});

		it('defaults prefer to "auto"', async () => {
			await skill_inspect.execute({ slug: 'test-skill' }, tmp);
			expect(mockInspectSkill).toHaveBeenCalledWith(tmp, 'test-skill', 'auto');
		});

		it('passes prefer="proposal" to inspectSkill', async () => {
			await skill_inspect.execute(
				{ slug: 'test-skill', prefer: 'proposal' },
				tmp,
			);
			expect(mockInspectSkill).toHaveBeenCalledWith(
				tmp,
				'test-skill',
				'proposal',
			);
		});

		it('passes prefer="active" to inspectSkill', async () => {
			await skill_inspect.execute(
				{ slug: 'test-skill', prefer: 'active' },
				tmp,
			);
			expect(mockInspectSkill).toHaveBeenCalledWith(
				tmp,
				'test-skill',
				'active',
			);
		});
	});

	describe('error handling', () => {
		it('returns error JSON when inspectSkill throws', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('skill not found'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'nonexistent' }, tmp),
			);
			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('execution_error');
		});
	});

	describe('_internals seam', () => {
		it('exposes skill_inspect via _internals', () => {
			expect(_internals.skill_inspect).toBeDefined();
			expect(typeof _internals.skill_inspect.execute).toBe('function');
		});
	});

	describe('ADVERSARIAL: malformed inputs and boundary violations', () => {
		it('rejects slug with path traversal attempt', async () => {
			mockInspectSkill.mockRejectedValueOnce(
				new Error('path traversal blocked'),
			);
			const result = JSON.parse(
				await skill_inspect.execute({ slug: '../../../etc/passwd' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no null byte sanitization at tool level
		it('accepts slug with null byte injection (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'skill\x00/../../../etc' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no shell metachar sanitization at tool level
		it('accepts slug with shell metacharacters (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'skill;rm -rf /' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no template literal sanitization at tool level
		it('accepts slug with template literal injection (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: '${process.env.SECRET}' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no HTML/script sanitization at tool level
		it('accepts slug with HTML/script injection (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: '<script>alert(1)</script>' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: no max length validation at tool level
		it('accepts very long slug (>= 256 chars) (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('slug too long'));
			const longSlug = 'a'.repeat(256);
			const result = JSON.parse(
				await skill_inspect.execute({ slug: longSlug }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: whitespace-only slug passes typeof check
		it('accepts slug with only whitespace (tool does not trim)', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: '   ' }, tmp),
			);
			expect(result.found).toBe(true);
		});

		// VULNERABILITY: Unicode RTL override not sanitized
		it('accepts slug with Unicode RTL override (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'skill\u202ename' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: emoji not sanitized
		it('accepts slug with emoji (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'skill🔥' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: prefer type not validated at tool level
		it('accepts invalid prefer value (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid prefer'));
			const result = JSON.parse(
				await skill_inspect.execute(
					{ slug: 'test', prefer: 'invalid' as any },
					tmp,
				),
			);
			expect(result.success).toBe(false);
		});

		// VULNERABILITY: prefer type not validated at tool level
		it('accepts prefer as number (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 'test', prefer: 1 as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug as boolean true', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: true as any }, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('rejects slug as number', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: 0 as any }, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('rejects slug as array', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: ['a', 'b'] as any }, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('rejects slug as object', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: { name: 'test' } as any }, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		// VULNERABILITY: __proto__ pollution not blocked at tool level
		it('accepts args with __proto__ pollution', async () => {
			const pollutedArgs = { __proto__: { admin: true }, slug: 'test' };
			const result = JSON.parse(
				await skill_inspect.execute(pollutedArgs as any, tmp),
			);
			expect(result.found).toBe(true);
		});

		// VULNERABILITY: constructor.prototype pollution not blocked at tool level
		it('accepts args with constructor.prototype pollution', async () => {
			const pollutedArgs = {
				constructor: { prototype: { admin: true } },
				slug: 'test',
			};
			const result = JSON.parse(
				await skill_inspect.execute(pollutedArgs as any, tmp),
			);
			expect(result.found).toBe(true);
		});

		it('rejects empty object args', async () => {
			const result = JSON.parse(await skill_inspect.execute({}, tmp));
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		it('handles undefined slug', async () => {
			const result = JSON.parse(
				await skill_inspect.execute({ slug: undefined } as any, tmp),
			);
			expect(result.found).toBe(false);
			expect(result.reason).toBe('slug required');
		});

		// VULNERABILITY: SQL injection not sanitized at tool level
		it('accepts slug with SQL injection fragment (service validates)', async () => {
			mockInspectSkill.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_inspect.execute({ slug: "'; DROP TABLE skills;--" }, tmp),
			);
			expect(result.success).toBe(false);
		});
	});
});
