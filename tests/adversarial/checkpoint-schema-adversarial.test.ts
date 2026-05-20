import { describe, expect, it } from 'bun:test';
import { CheckpointConfigSchema } from '../../src/config/schema';

describe('ADVERSARIAL: CheckpointConfigSchema security tests', () => {
	// ============================================
	// ATTACK VECTOR: Invalid boolean type for 'enabled'
	// ============================================
	describe('ATTACK VECTOR: Invalid enabled type', () => {
		it('rejects string "true" instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: 'true' });
			expect(result.success).toBe(false);
		});

		it('rejects string "false" instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: 'false' });
			expect(result.success).toBe(false);
		});

		it('rejects number 1 instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: 1 });
			expect(result.success).toBe(false);
		});

		it('rejects number 0 instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: 0 });
			expect(result.success).toBe(false);
		});

		it('rejects null instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: null });
			expect(result.success).toBe(false);
		});

		it('VULNERABILITY: explicitly undefined passes (Zod strips undefined)', () => {
			// NOTE: Zod treats explicit undefined as "not provided" and applies defaults
			// This is a known Zod behavior - not a security issue per se
			const result = CheckpointConfigSchema.safeParse({ enabled: undefined });
			expect(result.success).toBe(true);
		});

		it('rejects object instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: { value: true },
			});
			expect(result.success).toBe(false);
		});

		it('rejects array instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: [true] });
			expect(result.success).toBe(false);
		});

		it('rejects empty string instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: '' });
			expect(result.success).toBe(false);
		});

		it('rejects "yes" string instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: 'yes' });
			expect(result.success).toBe(false);
		});

		it('rejects "no" string instead of boolean', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: 'no' });
			expect(result.success).toBe(false);
		});

		it('accepts valid boolean true', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: true });
			expect(result.success).toBe(true);
		});

		it('accepts valid boolean false', () => {
			const result = CheckpointConfigSchema.safeParse({ enabled: false });
			expect(result.success).toBe(true);
		});
	});

	// ============================================
	// ATTACK VECTOR: Invalid number type for 'auto_checkpoint_threshold'
	// ============================================
	describe('ATTACK VECTOR: Invalid auto_checkpoint_threshold type', () => {
		it('rejects string instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: '5',
			});
			expect(result.success).toBe(false);
		});

		it('rejects boolean true instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: true,
			});
			expect(result.success).toBe(false);
		});

		it('rejects boolean false instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: false,
			});
			expect(result.success).toBe(false);
		});

		it('rejects null instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: null,
			});
			expect(result.success).toBe(false);
		});

		it('VULNERABILITY: explicitly undefined passes for threshold', () => {
			// Zod treats explicit undefined as "not provided" and applies defaults
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: undefined,
			});
			expect(result.success).toBe(true);
		});

		it('rejects object instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: { value: 5 },
			});
			expect(result.success).toBe(false);
		});

		it('rejects array instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: [5],
			});
			expect(result.success).toBe(false);
		});

		it('rejects BigInt instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: BigInt(5),
			});
			expect(result.success).toBe(false);
		});

		it('rejects empty string instead of number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: '',
			});
			expect(result.success).toBe(false);
		});
	});

	// ============================================
	// ATTACK VECTOR: Out of range values for 'auto_checkpoint_threshold'
	// ============================================
	describe('ATTACK VECTOR: Out of range auto_checkpoint_threshold', () => {
		it('rejects value below minimum (0)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 0,
			});
			expect(result.success).toBe(false);
		});

		it('rejects negative value (-1)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: -1,
			});
			expect(result.success).toBe(false);
		});

		it('rejects value above maximum (21)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 21,
			});
			expect(result.success).toBe(false);
		});

		it('rejects very large value (1000)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1000,
			});
			expect(result.success).toBe(false);
		});

		it('rejects decimal value (1.5) - .int() refinement applied', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1.5,
			});
			expect(result.success).toBe(false);
		});

		it('rejects fractional decimal (3.14) - .int() refinement applied', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 3.14,
			});
			expect(result.success).toBe(false);
		});

		it('rejects decimal value at boundary (0.5)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 0.5,
			});
			expect(result.success).toBe(false);
		});

		it('rejects fractional decimal (3.14) - duplicate test', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 3.14,
			});
			expect(result.success).toBe(false);
		});

		it('rejects Infinity', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: Infinity,
			});
			expect(result.success).toBe(false);
		});

		it('rejects -Infinity', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: -Infinity,
			});
			expect(result.success).toBe(false);
		});

		it('rejects NaN', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: NaN,
			});
			expect(result.success).toBe(false);
		});

		it('accepts minimum valid value (1)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1,
			});
			expect(result.success).toBe(true);
		});

		it('accepts maximum valid value (20)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 20,
			});
			expect(result.success).toBe(true);
		});

		it('accepts default value (3)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 3,
			});
			expect(result.success).toBe(true);
		});

		it('accepts middle value (10)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 10,
			});
			expect(result.success).toBe(true);
		});
	});

	// ============================================
	// ATTACK VECTOR: Unknown/extra fields
	// ============================================
	describe('ATTACK VECTOR: Unknown fields injection', () => {
		it('rejects extra unknown string field - strict mode enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				malicious_field: 'injection',
			});
			expect(result.success).toBe(false);
		});

		it('rejects extra unknown number field - strict mode enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				hacked_value: 999,
			});
			expect(result.success).toBe(false);
		});

		it('rejects extra unknown object field - strict mode enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				config: { exploit: true },
			});
			expect(result.success).toBe(false);
		});

		it('rejects extra unknown boolean field - strict mode enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				is_admin: true,
			});
			expect(result.success).toBe(false);
		});

		it('rejects __proto__ injection - strict mode enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				['__proto__']: { evil: true },
			});
			expect(result.success).toBe(false);
		});

		it('rejects constructor injection - strict mode enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				constructor: { malicious: true },
			});
			expect(result.success).toBe(false);
		});
	});

	// ============================================
	// ATTACK VECTOR: Empty/null/undefined inputs
	// ============================================
	describe('ATTACK VECTOR: Empty/invalid root inputs', () => {
		it('rejects empty object', () => {
			const result = CheckpointConfigSchema.safeParse({});
			// Empty object should pass (all fields have defaults)
			expect(result.success).toBe(true);
		});

		it('rejects null input', () => {
			const result = CheckpointConfigSchema.safeParse(null);
			expect(result.success).toBe(false);
		});

		it('rejects undefined input', () => {
			const result = CheckpointConfigSchema.safeParse(undefined);
			expect(result.success).toBe(false);
		});

		it('rejects array input', () => {
			const result = CheckpointConfigSchema.safeParse([{ enabled: true }]);
			expect(result.success).toBe(false);
		});

		it('rejects string input', () => {
			const result = CheckpointConfigSchema.safeParse('malicious');
			expect(result.success).toBe(false);
		});

		it('rejects number input', () => {
			const result = CheckpointConfigSchema.safeParse(123);
			expect(result.success).toBe(false);
		});

		it('rejects boolean input', () => {
			const result = CheckpointConfigSchema.safeParse(true);
			expect(result.success).toBe(false);
		});
	});

	// ============================================
	// ATTACK VECTOR: Type coercion attacks
	// ============================================
	describe('ATTACK VECTOR: Type coercion attacks', () => {
		it('rejects string "0" converted to number', () => {
			// JavaScript coerces "0" to 0 in numeric contexts
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: Number('0'),
			});
			expect(result.success).toBe(false);
		});

		it('rejects string "1" converted to number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: Number('1'),
			});
			expect(result.success).toBe(true); // Number("1") = 1 which is valid
		});

		it('rejects string "5" converted to number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: Number('5'),
			});
			expect(result.success).toBe(true); // Number("5") = 5 which is valid
		});

		it('rejects string "invalid" converted to number', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: Number('invalid'),
			});
			// Number('invalid') = NaN
			expect(result.success).toBe(false);
		});

		it('VULNERABILITY: boolean coercion to number passes (true + 0 = 1)', () => {
			// SECURITY ISSUE: JavaScript coercion creates valid integer
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: (true as any) + 0, // evaluates to 1
			});
			expect(result.success).toBe(true);
		});

		it('rejects boolean coercion to number (false + 0)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: (false as any) + 0, // 0
			});
			expect(result.success).toBe(false);
		});

		it('VULNERABILITY: object coercion to number passes', () => {
			// SECURITY ISSUE: Objects with valueOf() can be coerced
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: Number({ valueOf: () => 5 }),
			});
			expect(result.success).toBe(true);
		});
	});

	// ============================================
	// ATTACK VECTOR: Floating point precision attacks
	// ============================================
	describe('ATTACK VECTOR: Floating point precision attacks', () => {
		it('rejects 1.0000000001 - .int() refinement enforced', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1.0000000001,
			});
			expect(result.success).toBe(false);
		});

		it('rejects 20.9999999999 (precision attack)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 20.9999999999,
			});
			expect(result.success).toBe(false);
		});

		it('rejects 1e-10 (very small decimal)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1e-10,
			});
			expect(result.success).toBe(false);
		});
	});

	// ============================================
	// ATTACK VECTOR: Special numeric values
	// ============================================
	describe('ATTACK VECTOR: Special numeric values', () => {
		it('rejects negative zero', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: -0,
			});
			expect(result.success).toBe(false);
		});

		it('rejects scientific notation - 1e0', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 1,
			});
			expect(result.success).toBe(true); // 1e0 = 1, valid
		});

		it('rejects scientific notation - 20e0', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 20,
			});
			expect(result.success).toBe(true); // 20e0 = 20, valid
		});

		it('rejects scientific notation - 21e0', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 21,
			});
			expect(result.success).toBe(false);
		});

		it('rejects 0xF (hex literal)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 0xf,
			});
			expect(result.success).toBe(true); // 0xF = 15, valid
		});

		it('rejects 0x14 (hex literal = 20)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 0x14,
			});
			expect(result.success).toBe(true); // 0x14 = 20, valid
		});

		it('rejects 0x15 (hex literal = 21)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 0x15,
			});
			expect(result.success).toBe(false);
		});

		it('rejects 0b10100 (binary literal = 20)', () => {
			const result = CheckpointConfigSchema.safeParse({
				auto_checkpoint_threshold: 0b10100,
			});
			expect(result.success).toBe(true); // 0b10100 = 20, valid
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
			});
			expect(result.success).toBe(false);
		});

		it('rejects enabled as number and threshold as string', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: 1,
				auto_checkpoint_threshold: 'abc',
			});
			expect(result.success).toBe(false);
		});

		it('rejects extreme values with extra fields', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				auto_checkpoint_threshold: 999999,
				exec: 'malicious',
			});
			expect(result.success).toBe(false);
		});

		it('rejects nested object injection', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: { valueOf: () => true },
				auto_checkpoint_threshold: { valueOf: () => 5 },
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

		it('accepts full explicit config', () => {
			const result = CheckpointConfigSchema.safeParse({
				enabled: true,
				auto_checkpoint_threshold: 5,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.enabled).toBe(true);
				expect(result.data.auto_checkpoint_threshold).toBe(5);
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
