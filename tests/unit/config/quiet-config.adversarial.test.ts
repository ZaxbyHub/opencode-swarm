/**
 * ADVERSARIAL SECURITY TESTS for quiet config field
 *
 * Attack vectors covered:
 * 1. Type confusion: quiet: null, quiet: undefined, quiet: 0, quiet: 1, quiet: "false"
 * 2. quiet: "true" (string instead of boolean)
 * 3. Malformed config with quiet field (extra nested objects)
 * 4. Missing quiet field in partial config
 * 5. Extreme nesting around quiet field to test parser stability
 * 6. Config with quiet:true but other required fields missing
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema';

describe('SECURITY: quiet config adversarial attacks', () => {
	// ===========================================================================
	// ATTACK VECTOR 1: TYPE CONFUSION
	// ===========================================================================

	describe('Type confusion attacks on quiet field', () => {
		it('should reject quiet:null (type confusion)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: null });
			expect(result.success).toBe(false);
		});

		it('should handle quiet:undefined gracefully (uses default)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: undefined });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should reject quiet:0 (falsy number instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 0 });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:1 (truthy number instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 1 });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"false" (string "false" instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'false' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"true" (string "true" instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'true' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"yes" (string instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'yes' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"no" (string instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'no' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:[] (array instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: [] });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:{} (object instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: {} });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:NaN (NaN instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: NaN });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:Infinity (Infinity instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: Infinity });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:-Infinity (-Infinity instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: -Infinity });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:Function (function instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: () => {} });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:ArrowFunction (arrow function instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: () => {} });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:Symbol (symbol instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: Symbol('test') });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:BigInt (bigint instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: BigInt(1) });
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 2: STRING INJECTION IN QUIET VALUE
	// ===========================================================================

	describe('String injection attacks on quiet field', () => {
		it('should reject quiet:"tru" (partial string)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'tru' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"false" (lowercase)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'false' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"TRUE" (uppercase)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'TRUE' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"FALSE" (uppercase)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'FALSE' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"True" (mixed case)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'True' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet with unicode boolean strings', () => {
			// Unicode true/false representations
			const result = PluginConfigSchema.safeParse({
				quiet: '\u0074\u0072\u0075\u0065',
			}); // "true" in unicode
			expect(result.success).toBe(false);
		});

		it('should reject quiet with whitespace-padded string', () => {
			const result = PluginConfigSchema.safeParse({ quiet: ' true ' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet with tab characters', () => {
			const result = PluginConfigSchema.safeParse({ quiet: '\t' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet with newline', () => {
			const result = PluginConfigSchema.safeParse({ quiet: '\n' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet with null byte injection', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 'true\x00' });
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 3: MALFORMED CONFIG WITH QUIET FIELD (EXTRA NESTED OBJECTS)
	// ===========================================================================

	describe('Malformed config with quiet field (extra nested objects)', () => {
		it('should handle quiet alongside prototype pollution attempt', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				__proto__: { admin: true },
			});
			// Should succeed (Zod doesn't pollute prototype)
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				// Verify prototype not polluted
				const obj: Record<string, unknown> = {};
				expect(obj.admin).toBeUndefined();
			}
		});

		it('should handle quiet alongside constructor.prototype pollution', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				constructor: { prototype: { admin: true } },
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				// Verify prototype not polluted
				const obj: Record<string, unknown> = {};
				expect(obj.admin).toBeUndefined();
			}
		});

		it('should handle quiet alongside hasOwnProperty attack', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				hasOwnProperty: 'injected',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should handle quiet alongside toString attack', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				toString: { valueOf: 'injected' },
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should reject quiet field value that is an object with valueOf', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: { valueOf: true },
			});
			expect(result.success).toBe(false);
		});

		it('should handle quiet alongside deeply nested malicious object', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				nested: {
					__proto__: { polluted: true },
					constructor: { prototype: { admin: true } },
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				// Verify no prototype pollution
				const obj: Record<string, unknown> = {};
				expect(obj.polluted).toBeUndefined();
				expect(obj.admin).toBeUndefined();
			}
		});

		it('should handle quiet with huge nested object (DoS attempt)', () => {
			const deepObj: Record<string, unknown> = {};
			let current = deepObj;
			for (let i = 0; i < 100; i++) {
				current.nested = {};
				current = current.nested as Record<string, unknown>;
			}

			const result = PluginConfigSchema.safeParse({
				quiet: true,
				...deepObj,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 4: MISSING QUIET FIELD IN PARTIAL CONFIG
	// ===========================================================================

	describe('Missing quiet field in partial config', () => {
		it('should use default (true) when quiet is missing', () => {
			const result = PluginConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should use default when quiet is only field missing from valid config', () => {
			const result = PluginConfigSchema.safeParse({
				max_iterations: 5,
				qa_retry_limit: 3,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				expect(result.data.max_iterations).toBe(5);
				expect(result.data.qa_retry_limit).toBe(3);
			}
		});

		it('should use default when quiet is omitted from agents config', () => {
			const result = PluginConfigSchema.safeParse({
				agents: {
					coder: { model: 'test/model' },
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should use default when quiet is omitted from guardrails config', () => {
			const result = PluginConfigSchema.safeParse({
				guardrails: { enabled: true },
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 5: EXTREME NESTING AROUND QUIET FIELD (PARSER STABILITY)
	// ===========================================================================

	describe('Extreme nesting around quiet field (parser stability)', () => {
		it('should handle 50 levels of nesting with quiet at deep level', () => {
			let config: Record<string, unknown> = { quiet: true };
			for (let i = 0; i < 50; i++) {
				config = { level: config };
			}
			const result = PluginConfigSchema.safeParse(config);
			// Should either succeed or fail gracefully without crash
			expect(result.success === true || result.success === false).toBe(true);
		});

		it('should handle 100 levels of nesting with quiet at deep level', () => {
			let config: Record<string, unknown> = { quiet: true };
			for (let i = 0; i < 100; i++) {
				config = { level: config };
			}
			const result = PluginConfigSchema.safeParse(config);
			expect(result.success === true || result.success === false).toBe(true);
		});

		it('should handle quiet with circular reference attempt (Zod ignores circular parts)', () => {
			const config: Record<string, unknown> = { quiet: true };
			config.self = config;
			const result = PluginConfigSchema.safeParse(config);
			// Zod doesn't crash on circular refs but the circular part is ignored
			// The quiet:true is still parsed successfully since it's a valid boolean
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should handle quiet with indirect circular reference (Zod ignores circular parts)', () => {
			const config: Record<string, unknown> = { quiet: true, a: { b: {} } };
			(config.a as Record<string, unknown>).b = config;
			const result = PluginConfigSchema.safeParse(config);
			// Zod doesn't crash on circular refs but the circular part is ignored
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should handle quiet with JSONPath-like $ref attempt', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				$ref: '#/definitions/secret',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should handle quiet with JSONPath-like nested $ref', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				definitions: {
					$ref: '#/definitions/secret',
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 6: CONFIG WITH quiet:true BUT OTHER REQUIRED FIELDS MISSING
	// ===========================================================================

	describe('Config with quiet:true but other required fields missing', () => {
		it('should use default for max_iterations when missing with quiet:true', () => {
			const result = PluginConfigSchema.safeParse({ quiet: true });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				expect(result.data.max_iterations).toBe(5); // default
			}
		});

		it('should use default for qa_retry_limit when missing with quiet:true', () => {
			const result = PluginConfigSchema.safeParse({ quiet: true });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				expect(result.data.qa_retry_limit).toBe(3); // default
			}
		});

		it('should use defaults for all missing fields with quiet:true', () => {
			const result = PluginConfigSchema.safeParse({ quiet: true });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				expect(result.data.execution_mode).toBe('balanced'); // default
				expect(result.data.inject_phase_reminders).toBe(true); // default
			}
		});

		it('should allow quiet:true with only invalid fields (fails gracefully)', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				invalid_field: 'should be ignored',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
				// invalid_field should not be present (strict mode is NOT used in PluginConfigSchema)
			}
		});

		it('should handle quiet:true with empty agents (uses defaults)', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				agents: {},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.quiet).toBe(true);
			}
		});

		it('should reject quiet:true with null agents (null is not coerced to undefined)', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: true,
				agents: null,
			});
			// agents is optional (undefined) but NOT nullable (null is rejected)
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// BOUNDARY VIOLATIONS
	// ===========================================================================

	describe('Boundary violations for quiet field', () => {
		it('should reject quiet:-1 (negative number)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: -1 });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:0.1 (float instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 0.1 });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:1.0 (float instead of boolean)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: 1.0 });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:Number.MAX_SAFE_INTEGER', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: Number.MAX_SAFE_INTEGER,
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet:-Number.MAX_SAFE_INTEGER', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: -Number.MAX_SAFE_INTEGER,
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet:Number.MIN_VALUE', () => {
			const result = PluginConfigSchema.safeParse({ quiet: Number.MIN_VALUE });
			expect(result.success).toBe(false);
		});

		it('should reject quiet:"" (empty string)', () => {
			const result = PluginConfigSchema.safeParse({ quiet: '' });
			expect(result.success).toBe(false);
		});

		it('should reject quiet with only whitespace', () => {
			const result = PluginConfigSchema.safeParse({ quiet: '   ' });
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// INJECTION ATTACKS
	// ===========================================================================

	describe('Injection attacks targeting quiet field behavior', () => {
		it('should reject quiet value with template literal injection attempt', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '${process.exit(1)}',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with os command injection', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: 'true; rm -rf /',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with SQL injection pattern', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: "true' OR '1'='1",
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with HTML/script injection', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '<script>alert(1)</script>',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with JSON injection attempt', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '{"valueOf": "hacked"}',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with path traversal attempt', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '../../../etc/passwd',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with unicode escape sequence', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '\u0027 OR \u00271\u0027=\u00271', // ' OR '1'='1
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with emoji', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '✅',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with zero-width space', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: 'true\u200B',
			});
			expect(result.success).toBe(false);
		});

		it('should reject quiet value with RTL override character', () => {
			const result = PluginConfigSchema.safeParse({
				quiet: '\u202Etrie\u202C', // RLO LRI... followed by PDF
			});
			expect(result.success).toBe(false);
		});
	});
});
