/**
 * ADVERSARIAL SECURITY TEST SUITE
 * Target: AdversarialDetectionConfigSchema in src/config/schema.ts
 *
 * Attack vectors tested:
 * 1. Deeply nested arrays in `pairs` (should reject non-tuple)
 * 2. Empty-string agent names in `pairs`
 * 3. `policy` with Unicode trick values or whitespace
 * 4. Oversized `pairs` array (1000+ entries)
 * 5. `pairs` with null, undefined, __proto__, constructor values
 * 6. Prototype pollution attempts
 * 7. `enabled` with truthy non-boolean values
 */

import { describe, expect, it } from 'bun:test';
import { AdversarialDetectionConfigSchema } from '../../../src/config/schema';

describe('AdversarialDetectionConfigSchema - ADVERSARIAL SECURITY TESTS', () => {
	// ATTACK VECTOR 1: Deeply nested arrays in `pairs` (should reject non-tuple)
	describe('AV1: Deeply nested arrays - tuple enforcement', () => {
		it('should reject pairs with deeply nested arrays', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [
					[
						['agent1', 'agent2'],
						['agent3', 'agent4'],
					], // nested arrays - should fail
				],
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].code).toMatch(/invalid_type|too_small/);
			}
		});

		it('should reject pairs with single-element arrays (not 2-tuples)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [['agent1']], // 1-tuple - should fail
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].code).toMatch(/invalid_type|too_small/);
			}
		});

		it('should reject pairs with 3+ element arrays (not 2-tuples)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [
					['agent1', 'agent2', 'agent3'], // 3-tuple - should fail
					['agent4', 'agent5', 'agent6', 'agent7'], // 4-tuple - should fail
				],
			});
			expect(result.success).toBe(false);
		});

		it('should accept valid 2-tuple pairs', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [
					['coder', 'reviewer'],
					['architect', 'reviewer'],
				],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pairs).toEqual([
					['coder', 'reviewer'],
					['architect', 'reviewer'],
				]);
			}
		});
	});

	// ATTACK VECTOR 2: Empty-string agent names in `pairs`
	describe('AV2: Empty-string agent names', () => {
		it('should accept empty-string agent names in pairs (Zod string() allows this)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [
					['', 'reviewer'],
					['coder', ''],
					['', ''],
				],
			});
			// NOTE: Zod's string() accepts empty strings by default
			// This is expected behavior - downstream validation should catch this
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pairs).toEqual([
					['', 'reviewer'],
					['coder', ''],
					['', ''],
				]);
			}
		});
	});

	// ATTACK VECTOR 3: `policy` with Unicode trick values or whitespace
	describe('AV3: Policy with Unicode trick values and whitespace', () => {
		it('should reject policy with null bytes', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				policy: 'wa\u0000rn', // null byte injection
			});
			expect(result.success).toBe(false);
		});

		it('should reject policy with leading/trailing whitespace', () => {
			const result1 = AdversarialDetectionConfigSchema.safeParse({
				policy: ' warn', // leading whitespace
			});
			expect(result1.success).toBe(false);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'warn ', // trailing whitespace
			});
			expect(result2.success).toBe(false);

			const result3 = AdversarialDetectionConfigSchema.safeParse({
				policy: ' warn ', // both
			});
			expect(result3.success).toBe(false);
		});

		it('should reject policy with tab/newline characters', () => {
			const result1 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'war\tn', // tab injection
			});
			expect(result1.success).toBe(false);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'war\nn', // newline injection
			});
			expect(result2.success).toBe(false);
		});

		it('should reject policy with homoglyph attacks (look-alike characters)', () => {
			const result1 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'wаrn', // Cyrillic 'а' instead of 'a'
			});
			expect(result1.success).toBe(false);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'gate\u200b', // zero-width space
			});
			expect(result2.success).toBe(false);
		});

		it('should reject policy with mixed-case variants', () => {
			const result1 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'Warn', // capital W
			});
			expect(result1.success).toBe(false);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'WARN', // all caps
			});
			expect(result2.success).toBe(false);

			const result3 = AdversarialDetectionConfigSchema.safeParse({
				policy: 'GATE', // all caps
			});
			expect(result3.success).toBe(false);
		});

		it('should accept valid policy values', () => {
			const validPolicies = ['warn', 'gate', 'ignore'];
			for (const policy of validPolicies) {
				const result = AdversarialDetectionConfigSchema.safeParse({ policy });
				expect(result.success).toBe(true);
			}
		});
	});

	// ATTACK VECTOR 4: Oversized `pairs` array (1000+ entries)
	describe('AV4: Oversized pairs array', () => {
		it('should accept 1000+ pair entries (no max constraint)', () => {
			const largePairs = Array.from({ length: 1000 }, (_, i) => [
				`agent${i}`,
				`reviewer${i % 5}`,
			]);

			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: largePairs,
			});

			// Zod accepts this - no max constraint
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pairs.length).toBe(1000);
			}
		});

		it('should accept 10,000 pair entries', () => {
			const hugePairs = Array.from({ length: 10000 }, (_, i) => [
				`agent${i}`,
				`reviewer${i % 10}`,
			]);

			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: hugePairs,
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pairs.length).toBe(10000);
			}
		});
	});

	// ATTACK VECTOR 5: `pairs` with null, undefined, __proto__, constructor values
	describe('AV5: Pairs with special values', () => {
		it('should reject pairs containing null values', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [['coder', null] as any],
			});
			expect(result.success).toBe(false);
		});

		it('should reject pairs containing undefined values', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [[undefined, 'reviewer'] as any],
			});
			expect(result.success).toBe(false);
		});

		it('should accept __proto__ as a string value (not prototype pollution)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [
					['__proto__', 'reviewer'],
					['coder', 'constructor'],
				],
			});

			// Zod's string() accepts "__proto__" and "constructor" as regular strings
			// This is not prototype pollution - just string values
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pairs).toEqual([
					['__proto__', 'reviewer'],
					['coder', 'constructor'],
				]);
			}
		});

		it('should reject non-string values in pairs', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [[123, 'reviewer'] as any],
			});
			expect(result.success).toBe(false);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				pairs: [['coder', {}] as any],
			});
			expect(result2.success).toBe(false);
		});
	});

	// ATTACK VECTOR 6: Prototype pollution attempts
	describe('AV6: Prototype pollution attacks', () => {
		it('should strip __proto__ property from root object', () => {
			const result = AdversarialDetectionConfigSchema.parse({
				__proto__: { enabled: false }, // should be stripped
				enabled: true,
				pairs: [['coder', 'reviewer']],
			} as any);

			// Zod strips unknown properties by default
			expect(result).toEqual({
				enabled: true,
				policy: 'warn', // default
				pairs: [['coder', 'reviewer']],
			});
		});

		it('should strip constructor property from root object', () => {
			const result = AdversarialDetectionConfigSchema.parse({
				constructor: { prototype: { polluted: true } },
				enabled: true,
			} as any);

			// Zod strips unknown properties
			expect(result).toEqual({
				enabled: true,
				policy: 'warn',
				pairs: [['coder', 'reviewer']], // default
			});
		});

		it('should strip prototype property from root object', () => {
			const result = AdversarialDetectionConfigSchema.parse({
				prototype: { polluted: true },
				policy: 'gate',
			} as any);

			expect(result).toEqual({
				enabled: true, // default
				policy: 'gate',
				pairs: [['coder', 'reviewer']], // default
			});
		});

		it('should not pollute Object.prototype via successful parse', () => {
			// Verify Object.prototype is clean before
			expect((Object.prototype as any).polluted).toBeUndefined();

			AdversarialDetectionConfigSchema.parse({
				__proto__: { polluted: 'attack' },
				enabled: true,
			} as any);

			// Verify Object.prototype is still clean after
			expect((Object.prototype as any).polluted).toBeUndefined();
		});

		it('should strip nested prototype pollution attempts in pairs', () => {
			// Note: Since pairs are validated as tuples of strings,
			// object injection is not possible here
			const result = AdversarialDetectionConfigSchema.safeParse({
				pairs: [{ __proto__: { polluted: true } }] as any,
			});

			// Should fail because pairs must be tuples of strings
			expect(result.success).toBe(false);
		});
	});

	// ATTACK VECTOR 7: `enabled` with truthy non-boolean values
	describe('AV7: Enabled field with non-boolean values', () => {
		it('should reject 0 (not coerced to false by z.boolean)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({ enabled: 0 });
			// Zod's z.boolean() does NOT coerce - it requires actual boolean
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].message).toContain('boolean');
			}
		});

		it('should reject 1 (not coerced to true by z.boolean)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({ enabled: 1 });
			expect(result.success).toBe(false);
		});

		it('should reject "true" string (not coerced to true by z.boolean)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				enabled: 'true',
			});
			expect(result.success).toBe(false);
		});

		it('should reject "false" string (not coerced to false by z.boolean)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				enabled: 'false',
			});
			expect(result.success).toBe(false);
		});

		it('should reject null (not coerced to false by z.boolean)', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				enabled: null,
			});
			expect(result.success).toBe(false);
		});

		it('should reject object and array values for enabled', () => {
			const result1 = AdversarialDetectionConfigSchema.safeParse({
				enabled: {} as any,
			});
			expect(result1.success).toBe(false);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				enabled: [] as any,
			});
			expect(result2.success).toBe(false);
		});

		it('should accept boolean values', () => {
			const result1 = AdversarialDetectionConfigSchema.safeParse({
				enabled: true,
			});
			expect(result1.success).toBe(true);

			const result2 = AdversarialDetectionConfigSchema.safeParse({
				enabled: false,
			});
			expect(result2.success).toBe(true);
		});
	});

	// COMBINED ATTACKS: Multiple vectors together
	describe('COMBINED ATTACKS: Multiple vectors', () => {
		it('should reject input with multiple attack vectors', () => {
			const result = AdversarialDetectionConfigSchema.safeParse({
				__proto__: { polluted: true },
				enabled: 'hackme',
				policy: 'gate\u0000',
				pairs: [[['nested', 'array']], null, ['coder', 'reviewer']] as any,
			} as any);

			// Should fail due to multiple issues
			expect(result.success).toBe(false);
		});

		it('should accept valid configuration even with unknown properties stripped', () => {
			const result = AdversarialDetectionConfigSchema.parse({
				__proto__: { enabled: false }, // stripped
				constructor: { name: 'Attack' }, // stripped
				extraField: 'malicious', // stripped
				enabled: true,
				policy: 'warn',
				pairs: [['coder', 'reviewer']],
			} as any);

			expect(result).toEqual({
				enabled: true,
				policy: 'warn',
				pairs: [['coder', 'reviewer']],
			});
		});
	});
});
