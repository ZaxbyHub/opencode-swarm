import { describe, expect, test } from 'bun:test';
import { ParallelizationConfigSchema } from '../../../src/config/schema';

/**
 * Phase 3 Task 3.2 — ParallelizationConfigSchema extension
 *
 * Tests for the new top-level fields:
 * - max_coders: z.number().int().min(1).max(16).default(3)
 * - max_reviewers: z.number().int().min(1).max(16).default(2)
 */
describe('ParallelizationConfigSchema — max_coders and max_reviewers fields', () => {
	describe('defaults', () => {
		test('max_coders defaults to 3', () => {
			const result = ParallelizationConfigSchema.parse({});
			expect(result.max_coders).toBe(3);
		});

		test('max_reviewers defaults to 2', () => {
			const result = ParallelizationConfigSchema.parse({});
			expect(result.max_reviewers).toBe(2);
		});
	});

	describe('schema validation — max_coders', () => {
		test('accepts valid max_coders value at lower bound (1)', () => {
			const result = ParallelizationConfigSchema.parse({ max_coders: 1 });
			expect(result.max_coders).toBe(1);
		});

		test('accepts valid max_coders value at upper bound (16)', () => {
			const result = ParallelizationConfigSchema.parse({ max_coders: 16 });
			expect(result.max_coders).toBe(16);
		});

		test('accepts typical value (3)', () => {
			const result = ParallelizationConfigSchema.parse({ max_coders: 3 });
			expect(result.max_coders).toBe(3);
		});

		test('rejects max_coders below minimum (0)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: 0 }),
			).toThrow();
		});

		test('rejects max_coders below minimum (-1)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: -1 }),
			).toThrow();
		});

		test('rejects max_coders above maximum (17)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: 17 }),
			).toThrow();
		});

		test('rejects non-integer max_coders (3.5)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: 3.5 }),
			).toThrow();
		});

		test('rejects non-integer max_coders (2.9)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: 2.9 }),
			).toThrow();
		});

		test('rejects non-number max_coders ("3")', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: '3' as any }),
			).toThrow();
		});

		test('rejects null max_coders', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_coders: null as any }),
			).toThrow();
		});
	});

	describe('schema validation — max_reviewers', () => {
		test('accepts valid max_reviewers value at lower bound (1)', () => {
			const result = ParallelizationConfigSchema.parse({ max_reviewers: 1 });
			expect(result.max_reviewers).toBe(1);
		});

		test('accepts valid max_reviewers value at upper bound (16)', () => {
			const result = ParallelizationConfigSchema.parse({ max_reviewers: 16 });
			expect(result.max_reviewers).toBe(16);
		});

		test('accepts typical value (2)', () => {
			const result = ParallelizationConfigSchema.parse({ max_reviewers: 2 });
			expect(result.max_reviewers).toBe(2);
		});

		test('rejects max_reviewers below minimum (0)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_reviewers: 0 }),
			).toThrow();
		});

		test('rejects max_reviewers below minimum (-1)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_reviewers: -1 }),
			).toThrow();
		});

		test('rejects max_reviewers above maximum (17)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_reviewers: 17 }),
			).toThrow();
		});

		test('rejects non-integer max_reviewers (1.5)', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_reviewers: 1.5 }),
			).toThrow();
		});

		test('rejects non-number max_reviewers ("2")', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_reviewers: '2' as any }),
			).toThrow();
		});

		test('rejects null max_reviewers', () => {
			expect(() =>
				ParallelizationConfigSchema.parse({ max_reviewers: null as any }),
			).toThrow();
		});
	});

	describe('field position — top level', () => {
		test('max_coders is at top level of config', () => {
			const result = ParallelizationConfigSchema.parse({
				max_coders: 5,
				max_reviewers: 4,
			});
			// Verify it's at top level, not nested
			expect(result.max_coders).toBe(5);
			expect(result.max_reviewers).toBe(4);
		});

		test('fields coexist: max_coders/max_reviewers alongside existing config', () => {
			const result = ParallelizationConfigSchema.parse({
				enabled: true,
				maxConcurrentTasks: 4,
				max_coders: 3,
				max_reviewers: 2,
			});
			expect(result.enabled).toBe(true);
			expect(result.maxConcurrentTasks).toBe(4);
			expect(result.max_coders).toBe(3);
			expect(result.max_reviewers).toBe(2);
		});
	});

	describe('backward compatibility — existing fields still work', () => {
		test('enabled defaults to false', () => {
			const result = ParallelizationConfigSchema.parse({});
			expect(result.enabled).toBe(false);
		});

		test('maxConcurrentTasks defaults to 1', () => {
			const result = ParallelizationConfigSchema.parse({});
			expect(result.maxConcurrentTasks).toBe(1);
		});

		test('evidenceLockTimeoutMs defaults to 60000', () => {
			const result = ParallelizationConfigSchema.parse({});
			expect(result.evidenceLockTimeoutMs).toBe(60000);
		});
	});
});
