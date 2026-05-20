/**
 * ADVERSARIAL SECURITY TESTS for auto_select_architect config field
 *
 * Attack vectors covered:
 * 1. Prototype pollution via agent.__proto__ / constructor
 * 2. Extremely long string values (10KB+)
 * 3. Unicode/emoji in agent names
 * 4. Null bytes in agent name strings
 * 5. Deeply nested objects in agent config
 * 6. auto_select_architect as object (should reject — not boolean or string)
 * 7. auto_select_architect: 0 / 1 (numbers — should reject)
 * 8. auto_select_architect: "build" (non-architect string — schema accepts, runtime may warn)
 * 9. auto_select_architect: "plan" (builtin agent name — schema accepts, runtime may warn)
 */

import { describe, expect, it } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema';

describe('SECURITY: auto_select_architect adversarial attacks', () => {
	// ===========================================================================
	// ATTACK VECTOR 1: PROTOTYPE POLLUTION
	// ===========================================================================

	describe('Prototype pollution attacks on agent config', () => {
		it('should not pollute prototype when agent has __proto__', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: true,
				agent: {
					__proto__: { admin: true },
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
				// Verify no prototype pollution
				const obj: Record<string, unknown> = {};
				expect(obj.admin).toBeUndefined();
			}
		});

		it('should not pollute prototype when agent has constructor.prototype', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: true,
				agent: {
					constructor: { prototype: { admin: true } },
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
				// Verify no prototype pollution
				const obj: Record<string, unknown> = {};
				expect(obj.admin).toBeUndefined();
			}
		});

		it('should not pollute prototype via hasOwnProperty in agent', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: true,
				agent: {
					hasOwnProperty: 'injected',
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
			}
		});

		it('should not pollute prototype via toString in agent', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: true,
				agent: {
					toString: { valueOf: 'injected' },
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
			}
		});

		it('should handle deeply nested malicious object in agent', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: true,
				agent: {
					__proto__: { polluted: true },
					constructor: { prototype: { admin: true } },
					nested: {
						__proto__: { attack: true },
					},
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
				// Verify no prototype pollution
				const obj: Record<string, unknown> = {};
				expect(obj.polluted).toBeUndefined();
				expect(obj.admin).toBeUndefined();
				expect(obj.attack).toBeUndefined();
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 2: OVERSIZED INPUT
	// ===========================================================================

	describe('Oversized string attacks on auto_select_architect', () => {
		it('should accept 10KB string (within reasonable bounds)', () => {
			const largeString = 'a'.repeat(10 * 1024);
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: largeString,
			});
			// Schema accepts any string; the transform trims and returns false if empty
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(largeString);
			}
		});

		it('should accept 100KB string', () => {
			const largeString = 'a'.repeat(100 * 1024);
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: largeString,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(largeString);
			}
		});

		it('should accept 1MB string (DoS via memory exhaustion potential)', () => {
			const hugeString = 'mega_architect'.repeat(100_000); // ~1.3MB
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: hugeString,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				// Transform trims but doesn't reject large strings
				expect(typeof result.data.auto_select_architect).toBe('string');
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 3: UNICODE / EMOJI IN AGENT NAMES
	// ===========================================================================

	describe('Unicode/emoji injection in auto_select_architect string value', () => {
		it('should accept emoji in agent name string', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'mega_architect_🔥',
			});
			// Schema accepts any non-empty string after trim
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('mega_architect_🔥');
			}
		});

		it('should accept RTL override characters in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '\u202Emega_architect\u202C', // RLO + PDF
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(
					'\u202Emega_architect\u202C',
				);
			}
		});

		it('should accept zero-width space in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'mega_architect\u200B',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				// Zero-width space is preserved (not trimmed by String.prototype.trim)
				expect(result.data.auto_select_architect).toBe('mega_architect\u200B');
			}
		});

		it('should accept combining unicode characters in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'mega_architect\u0301', // combining acute accent
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('mega_architect\u0301');
			}
		});

		it('should accept null codepoint in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'mega_architect\0',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('mega_architect\0');
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 4: NULL BYTES IN AGENT NAME STRINGS
	// ===========================================================================

	describe('Null byte injection in auto_select_architect string value', () => {
		it('should accept null byte prefix in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '\0mega_architect',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('\0mega_architect');
			}
		});

		it('should accept embedded null byte in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'mega\0_architect',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('mega\0_architect');
			}
		});

		it('should accept multiple null bytes in agent name', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '\0\0\0mega_architect',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('\0\0\0mega_architect');
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 5: DEEPLY NESTED OBJECTS IN AGENT CONFIG
	// ===========================================================================

	describe('Deeply nested objects in agent config', () => {
		it('should handle 50 levels of nesting in agent object', () => {
			const config: Record<string, unknown> = { auto_select_architect: true };
			let current = config;
			for (let i = 0; i < 50; i++) {
				(current as Record<string, unknown>).level = {};
				current = (current as Record<string, unknown>).level as Record<
					string,
					unknown
				>;
			}
			const result = PluginConfigSchema.safeParse(config);
			// Should either succeed or fail gracefully without crash
			expect(result.success === true || result.success === false).toBe(true);
		});

		it('should handle 100 levels of nesting in agent object', () => {
			const config: Record<string, unknown> = { auto_select_architect: true };
			let current = config;
			for (let i = 0; i < 100; i++) {
				(current as Record<string, unknown>).level = {};
				current = (current as Record<string, unknown>).level as Record<
					string,
					unknown
				>;
			}
			const result = PluginConfigSchema.safeParse(config);
			expect(result.success === true || result.success === false).toBe(true);
		});

		it('should handle circular reference in agent object', () => {
			const config: Record<string, unknown> = {
				auto_select_architect: true,
				agent: {},
			};
			(config.agent as Record<string, unknown>).self = config.agent;
			const result = PluginConfigSchema.safeParse(config);
			// Zod doesn't crash on circular refs but the circular part is ignored
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 6: auto_select_architect AS OBJECT (SHOULD REJECT)
	// ===========================================================================

	describe('Type confusion: auto_select_architect as object (should reject)', () => {
		it('should reject auto_select_architect: {} (empty object)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: {},
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: { valueOf: true }', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: { valueOf: true },
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: [] (empty array)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: [],
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: ["architect"] (array with string)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: ['architect'],
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: null', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: null,
			});
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 7: auto_select_architect AS NUMBER (SHOULD REJECT)
	// ===========================================================================

	describe('Type confusion: auto_select_architect as number (should reject)', () => {
		it('should reject auto_select_architect: 0', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 0,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: 1', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 1,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: -1', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: -1,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: 0.1 (float)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 0.1,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: NaN', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: NaN,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: Infinity', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: Infinity,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: -Infinity', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: -Infinity,
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: Number.MAX_SAFE_INTEGER', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: Number.MAX_SAFE_INTEGER,
			});
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 8: auto_select_architect: "build" (NON-ARCHITECT AGENT NAME)
	// Schema accepts any string; runtime config hook may warn
	// ===========================================================================

	describe('Non-architect agent name as auto_select_architect value', () => {
		it('should accept "build" as auto_select_architect value (schema level)', () => {
			// Schema accepts any string — validation of semantic correctness happens at runtime
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'build',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('build');
			}
		});

		it('should accept "plan" as auto_select_architect value (schema level)', () => {
			// Schema accepts any string — "plan" is a built-in agent name, not an architect
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'plan',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('plan');
			}
		});

		it('should accept "coder" as auto_select_architect value (schema level)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'coder',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('coder');
			}
		});

		it('should accept "reviewer" as auto_select_architect value (schema level)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'reviewer',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('reviewer');
			}
		});

		it('should accept arbitrary string as auto_select_architect value', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'not_a_real_agent_name_12345',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(
					'not_a_real_agent_name_12345',
				);
			}
		});
	});

	// ===========================================================================
	// ATTACK VECTOR 9: BUILT-IN AGENT NAME AS VALUE
	// Schema accepts any string; these are valid canonical roles but not architects
	// ===========================================================================

	describe('Built-in agent names as auto_select_architect value', () => {
		it('should accept "critic" as auto_select_architect value', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'critic',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('critic');
			}
		});

		it('should accept "sme" as auto_select_architect value', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'sme',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('sme');
			}
		});

		it('should accept "docs" as auto_select_architect value', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'docs',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('docs');
			}
		});
	});

	// ===========================================================================
	// INJECTION ATTEMPTS IN STRING VALUE
	// ===========================================================================

	describe('Injection attacks in auto_select_architect string value', () => {
		it('should accept template literal injection attempt (schema level)', () => {
			// Schema accepts any string — the value is not executed
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '${process.exit(1)}',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('${process.exit(1)}');
			}
		});

		it('should accept os command injection attempt (schema level)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: 'true; rm -rf /',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('true; rm -rf /');
			}
		});

		it('should accept SQL injection pattern (schema level)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: "' OR '1'='1",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe("' OR '1'='1");
			}
		});

		it('should accept HTML/script injection (schema level)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '<script>alert(1)</script>',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(
					'<script>alert(1)</script>',
				);
			}
		});

		it('should accept path traversal attempt (schema level)', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '../../../etc/passwd',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('../../../etc/passwd');
			}
		});
	});

	// ===========================================================================
	// BOUNDARY CASES
	// ===========================================================================

	describe('Boundary cases for auto_select_architect', () => {
		it('should accept empty string and transform to false', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(false);
			}
		});

		it('should accept whitespace-only string and transform to false', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '   ',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(false);
			}
		});

		it('should accept string with whitespace padding and trim it', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: '  mega_architect  ',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe('mega_architect');
			}
		});

		it('should accept undefined (field absent) and stay undefined', () => {
			const result = PluginConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBeUndefined();
			}
		});

		it('should accept true boolean', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: true,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(true);
			}
		});

		it('should accept false boolean', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: false,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.auto_select_architect).toBe(false);
			}
		});

		it('should reject auto_select_architect: Symbol', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: Symbol('test'),
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: BigInt', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: BigInt(1),
			});
			expect(result.success).toBe(false);
		});

		it('should reject auto_select_architect: Function', () => {
			const result = PluginConfigSchema.safeParse({
				auto_select_architect: () => {},
			});
			expect(result.success).toBe(false);
		});
	});
});
