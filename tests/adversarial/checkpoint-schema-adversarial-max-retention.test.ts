import { describe, expect, it } from 'bun:test';
import { CheckpointConfigSchema } from '../../src/config/schema';

describe('ADVERSARIAL: CheckpointConfigSchema security tests', () => {
	// ============================================
	// ATTACK VECTOR: Invalid number type for 'max_retention'
	// ============================================
	describe('ATTACK VECTOR: Invalid max_retention type', () => {
		it('rejects string instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: '5',
			});
			expect(result.success).toBe(false);
		});

		it('rejects boolean instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: true,
			});
			expect(result.success).toBe(false);
		});

		it('rejects null instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: null,
			});
			expect(result.success).toBe(false);
		});

		it('accepts undefined (falls back to default)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: undefined,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_retention).toBe(20);
			}
		});

		it('rejects object instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: { value: 5 },
			});
			expect(result.success).toBe(false);
		});

		it('rejects array instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: [5],
			});
			expect(result.success).toBe(false);
		});

		it('rejects BigInt instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: BigInt(5),
			});
			expect(result.success).toBe(false);
		});

		it('rejects empty string', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: '',
			});
			expect(result.success).toBe(false);
		});
	});

	// ============================================
	// ATTACK VECTOR: Out of range values for 'max_retention'
	// ============================================
	describe('ATTACK VECTOR: Out of range max_retention', () => {
		it('rejects value below minimum (0)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 0,
			});
			expect(result.success).toBe(false);
		});

		it('rejects value above maximum (101)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 101,
			});
			expect(result.success).toBe(false);
		});

		it('rejects negative value (-1)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: -1,
			});
			expect(result.success).toBe(false);
		});

		it('rejects non-integer (3.5)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 3.5,
			});
			expect(result.success).toBe(false);
		});

		it('accepts default value (20)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 20,
			});
			expect(result.success).toBe(true);
		});

		it('accepts middle value (50)', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 50,
			});
			expect(result.success).toBe(true);
		});
	});

	// ============================================
	// ATTACK VECTOR: Combined malformed inputs
	// ============================================
	describe('ATTACK VECTOR: Combined malformed inputs', () => {
		it('rejects both fields invalid', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: 'true',
				auto_checkpoint_threshold: '5',
				max_retention: '20',
			});
			expect(result.success).toBe(false);
		});

		it('rejects enabled as number, threshold as string, max_retention as string', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: 1,
				auto_checkpoint_threshold: 'abc',
				max_retention: 'def',
			});
			expect(result.success).toBe(false);
		});

		it('rejects extreme values with extra fields', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				auto_checkpoint_threshold: 999999,
				max_retention: 999999,
				exec: 'malicious',
			});
			expect(result.success).toBe(false);
		});

		it('rejects nested object injection', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: { valueOf: () => true },
				auto_checkpoint_threshold: { valueOf: () => 5 },
				max_retention: { valueOf: () => 20 },
			});
			expect(result.success).toBe(false);
		});
	});

	// ============================================
	// VALID: Happy path tests
	// ============================================
	describe('VALID: Happy path configurations', () => {
		it('accepts minimal config (all defaults)', () => {
			const result = CheckpointConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.enabled).toBe(true);
				expect(result.data.auto_checkpoint_threshold).toBe(3);
				expect(result.data.max_retention).toBe(20);
			}
		});

		it('accepts explicit enabled: true', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: true });
			expect(result.success).toBe(true);
		});

		it('accepts explicit enabled: false', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: false });
			expect(result.success).toBe(true);
		});

		it('accepts explicit threshold at min', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1,
			});
			expect(result.success).toBe(true);
		});

		it('accepts explicit threshold at max', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 20,
			});
			expect(result.success).toBe(true);
		});

		it('accepts explicit max_retention at min', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 1,
			});
			expect(result.success).toBe(true);
		});

		it('accepts explicit max_retention at max', () => {
			const result = CheckpointConfigSchema.safeParse({
				max_retention: 100,
			});
			expect(result.success).toBe(true);
		});

		it('accepts full explicit config', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				auto_checkpoint_threshold: 5,
				max_retention: 50,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.enabled).toBe(true);
				expect(result.data.auto_checkpoint_threshold).toBe(5);
				expect(result.data.max_retention).toBe(50);
			}
		});

		it('accepts disabled with threshold', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: false,
				auto_checkpoint_threshold: 10,
			});
			expect(result.success).toBe(true);
		});
	});
});
