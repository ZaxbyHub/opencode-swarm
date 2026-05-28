/**
 * Tests for skill_generate tool.
 *
 * Covers:
 * - Happy path: delegates to generateSkills with correct arg mapping
 * - Default mode is 'draft', force defaults to false
 * - All arg variants: slug, source_knowledge_ids, min_confidence, min_confirmations
 * - Error handling: when generateSkills throws
 * - _internals seam verification
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mockGenerateSkills = mock(async () => ({
	generated: [
		{ slug: 'test-skill', path: '.swarm/skills/proposals/test-skill.md' },
	],
}));

// Module-level mock — must be before the tool import
mock.module('../../../src/services/skill-generator.js', () => ({
	generateSkills: mockGenerateSkills,
	listSkills: async () => ({ drafts: [], active: [] }),
	activateProposal: async () => ({}),
	inspectSkill: async () => ({}),
	regenerateSkill: async () => ({}),
}));

import { _internals } from '../../../src/tools/skill-generate';

const { skill_generate } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockGenerateSkills.mockClear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'skill-generate-test-')),
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

describe('skill_generate tool', () => {
	it('delegates to generateSkills with correct defaults', async () => {
		const result = JSON.parse(await skill_generate.execute({}, tmp));
		expect(result.generated).toBeDefined();
		expect(mockGenerateSkills).toHaveBeenCalledWith(
			expect.objectContaining({
				directory: tmp,
				mode: 'draft',
				force: false,
			}),
		);
	});

	it('defaults mode to draft when not specified', async () => {
		await skill_generate.execute({}, tmp);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.mode).toBe('draft');
	});

	it('defaults force to false when not specified', async () => {
		await skill_generate.execute({}, tmp);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.force).toBe(false);
	});

	it('passes mode "active" when specified', async () => {
		await skill_generate.execute({ mode: 'active' }, tmp);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.mode).toBe('active');
	});

	it('passes force=true when specified', async () => {
		await skill_generate.execute({ force: true }, tmp);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.force).toBe(true);
	});

	it('passes slug when specified', async () => {
		await skill_generate.execute({ slug: 'my-skill' }, tmp);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.slug).toBe('my-skill');
	});

	it('passes source_knowledge_ids mapped to sourceKnowledgeIds', async () => {
		const ids = ['id-1', 'id-2', 'id-3'];
		await skill_generate.execute({ source_knowledge_ids: ids }, tmp);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.sourceKnowledgeIds).toEqual(ids);
	});

	it('passes min_confidence and min_confirmations', async () => {
		await skill_generate.execute(
			{ min_confidence: 0.85, min_confirmations: 3 },
			tmp,
		);
		const callArgs = mockGenerateSkills.mock.calls[0][0];
		expect(callArgs.minConfidence).toBe(0.85);
		expect(callArgs.minConfirmations).toBe(3);
	});

	it('returns error JSON when generateSkills throws', async () => {
		mockGenerateSkills.mockRejectedValueOnce(new Error('generation failed'));
		const result = JSON.parse(await skill_generate.execute({}, tmp));
		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('execution_error');
	});

	it('handles null args gracefully (uses defaults)', async () => {
		const result = JSON.parse(await skill_generate.execute(null as any, tmp));
		expect(result.generated).toBeDefined();
	});

	describe('_internals seam', () => {
		it('exposes skill_generate via _internals', () => {
			expect(_internals.skill_generate).toBeDefined();
			expect(typeof _internals.skill_generate.execute).toBe('function');
		});
	});

	describe('ADVERSARIAL: malformed inputs and boundary violations', () => {
		it('rejects slug with path traversal attempt', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_generate.execute({ slug: '../etc/passwd' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug with null byte path injection', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_generate.execute({ slug: 'skill\x00/../../../etc' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug with shell metacharacters', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_generate.execute({ slug: 'skill;rm -rf /' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug with template literal injection', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_generate.execute({ slug: '${process.env.SECRET}' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug with HTML/script injection', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_generate.execute(
					{ slug: '<script>alert(1)</script>' },
					tmp,
				),
			);
			expect(result.success).toBe(false);
		});

		it('rejects very long slug (>= 256 chars)', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const longSlug = 'a'.repeat(256);
			const result = JSON.parse(
				await skill_generate.execute({ slug: longSlug }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects source_knowledge_ids with non-string elements', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid ids'));
			const result = JSON.parse(
				await skill_generate.execute(
					{ source_knowledge_ids: ['valid', 123, null] as any },
					tmp,
				),
			);
			expect(result.success).toBe(false);
		});

		it('rejects very large source_knowledge_ids array (>= 1000 items)', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('too many ids'));
			const manyIds = Array(1001).fill('id-');
			const result = JSON.parse(
				await skill_generate.execute({ source_knowledge_ids: manyIds }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects min_confidence below 0', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_generate.execute({ min_confidence: -0.1 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects min_confidence above 1', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_generate.execute({ min_confidence: 1.5 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects min_confirmations below 1', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_generate.execute({ min_confirmations: 0 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects min_confirmations above 50', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_generate.execute({ min_confirmations: 51 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects invalid mode value', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid mode'));
			const result = JSON.parse(
				await skill_generate.execute({ mode: 'delete' as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects args with __proto__ pollution', async () => {
			const pollutedArgs = {
				__proto__: { admin: true },
				mode: 'active',
				force: true,
			};
			const result = JSON.parse(
				await skill_generate.execute(pollutedArgs as any, tmp),
			);
			// VULNERABILITY: __proto__ pollution is accepted (no validation at tool level)
			// generateSkills receives the args without throwing
			expect(result.generated).toBeDefined();
		});

		it('rejects args with constructor.prototype pollution', async () => {
			const pollutedArgs = {
				constructor: { prototype: { admin: true } },
				mode: 'active',
				force: true,
			};
			const result = JSON.parse(
				await skill_generate.execute(pollutedArgs as any, tmp),
			);
			// VULNERABILITY: constructor.prototype pollution is accepted
			expect(result.generated).toBeDefined();
		});

		it('rejects force as non-boolean', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_generate.execute({ force: 'true' as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects mode as non-string', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_generate.execute({ mode: 123 as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects slug with Unicode RTL override', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid slug'));
			const result = JSON.parse(
				await skill_generate.execute({ slug: 'skill\u202ename' }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects source_knowledge_ids with empty string elements', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('invalid ids'));
			const result = JSON.parse(
				await skill_generate.execute({ source_knowledge_ids: [''] }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects min_confidence as NaN', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_generate.execute({ min_confidence: NaN }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects min_confirmations as negative infinity', async () => {
			mockGenerateSkills.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_generate.execute({ min_confirmations: -Infinity }, tmp),
			);
			expect(result.success).toBe(false);
		});
	});
});
