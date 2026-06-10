/**
 * LeanTurboConfigSchema tests — Phase 1 Task 1.1
 *
 * Tests for worktree_isolation field (previously hard-rejected via .refine(),
 * now accepted), and the new merge_strategy and worktree_dir fields.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../src/config/constants';
import { LeanTurboConfigSchema } from '../../../src/config/schema';

describe('LeanTurboConfigSchema — worktree_isolation field', () => {
	describe('worktree_isolation acceptance (previously rejected)', () => {
		test('accepts worktree_isolation: true', () => {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_isolation: true,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_isolation).toBe(true);
			}
		});

		test('accepts worktree_isolation: false', () => {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_isolation: false,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_isolation).toBe(false);
			}
		});

		test('accepts worktree_isolation omitted (defaults to false)', () => {
			const result = LeanTurboConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_isolation).toBe(false);
			}
		});
	});
});

describe('LeanTurboConfigSchema — merge_strategy field', () => {
	describe('valid values', () => {
		test('accepts merge_strategy: "merge" (default)', () => {
			const result = LeanTurboConfigSchema.safeParse({
				merge_strategy: 'merge',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.merge_strategy).toBe('merge');
			}
		});

		test('accepts merge_strategy: "rebase"', () => {
			const result = LeanTurboConfigSchema.safeParse({
				merge_strategy: 'rebase',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.merge_strategy).toBe('rebase');
			}
		});

		test('accepts merge_strategy: "cherry-pick"', () => {
			const result = LeanTurboConfigSchema.safeParse({
				merge_strategy: 'cherry-pick',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.merge_strategy).toBe('cherry-pick');
			}
		});

		test('accepts merge_strategy omitted (defaults to "merge")', () => {
			const result = LeanTurboConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.merge_strategy).toBe('merge');
			}
		});
	});

	describe('invalid values', () => {
		test('rejects merge_strategy: "squash" (not a valid enum value)', () => {
			const result = LeanTurboConfigSchema.safeParse({
				merge_strategy: 'squash',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join('.'));
				expect(paths).toContain('merge_strategy');
			}
		});

		test('rejects merge_strategy: "fast-forward"', () => {
			const result = LeanTurboConfigSchema.safeParse({
				merge_strategy: 'fast-forward',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join('.'));
				expect(paths).toContain('merge_strategy');
			}
		});

		test('rejects merge_strategy as number', () => {
			const result = LeanTurboConfigSchema.safeParse({
				merge_strategy: 1 as any,
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join('.'));
				expect(paths).toContain('merge_strategy');
			}
		});
	});
});

describe('LeanTurboConfigSchema — worktree_dir field', () => {
	describe('valid values', () => {
		test('accepts worktree_dir: "/some/path" (absolute Unix path)', () => {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_dir: '/some/path',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_dir).toBe('/some/path');
			}
		});

		test('accepts worktree_dir: "C:\\worktrees" (Windows path)', () => {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_dir: 'C:\\worktrees',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_dir).toBe('C:\\worktrees');
			}
		});

		test('accepts worktree_dir omitted (optional)', () => {
			const result = LeanTurboConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_dir).toBeUndefined();
			}
		});

		test('accepts worktree_dir: undefined (explicit)', () => {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_dir: undefined,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_dir).toBeUndefined();
			}
		});
	});
});

describe('LeanTurboConfigSchema — default config', () => {
	test('parses empty object as full defaults', () => {
		const result = LeanTurboConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_parallel_coders).toBe(4);
			expect(result.data.require_declared_scope).toBe(true);
			expect(result.data.conflict_policy).toBe('serialize');
			expect(result.data.degrade_on_risk).toBe(true);
			expect(result.data.phase_reviewer).toBe(true);
			expect(result.data.phase_critic).toBe(true);
			expect(result.data.integrated_diff_required).toBe(true);
			expect(result.data.allow_docs_only_without_reviewer).toBe(false);
			expect(result.data.worktree_isolation).toBe(false);
			expect(result.data.merge_strategy).toBe('merge');
			expect(result.data.worktree_dir).toBeUndefined();
		}
	});
});

describe('DEFAULT_LEAN_TURBO_CONFIG constants', () => {
	test('has worktree_isolation: false', () => {
		expect(DEFAULT_LEAN_TURBO_CONFIG.worktree_isolation).toBe(false);
	});

	test('has merge_strategy: "merge"', () => {
		expect(DEFAULT_LEAN_TURBO_CONFIG.merge_strategy).toBe('merge');
	});

	test('has worktree_dir: undefined', () => {
		expect(DEFAULT_LEAN_TURBO_CONFIG.worktree_dir).toBeUndefined();
	});
});

describe('LeanTurboConfigSchema — combined worktree fields', () => {
	test('accepts worktree_isolation: true with merge_strategy and worktree_dir', () => {
		const result = LeanTurboConfigSchema.safeParse({
			worktree_isolation: true,
			merge_strategy: 'rebase',
			worktree_dir: '/custom/worktrees',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.worktree_isolation).toBe(true);
			expect(result.data.merge_strategy).toBe('rebase');
			expect(result.data.worktree_dir).toBe('/custom/worktrees');
		}
	});

	test('accepts all three merge strategies alongside worktree_isolation: true', () => {
		for (const strategy of ['merge', 'rebase', 'cherry-pick'] as const) {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_isolation: true,
				merge_strategy: strategy,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.merge_strategy).toBe(strategy);
			}
		}
	});
});
