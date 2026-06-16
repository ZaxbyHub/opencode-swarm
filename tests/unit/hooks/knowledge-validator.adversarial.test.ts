/**
 * Adversarial security tests for knowledge-validator.ts
 * Focus: Attack vectors, bypass attempts, and edge case handling.
 */

import { describe, expect, it } from 'vitest';
import {
	DANGEROUS_COMMAND_PATTERNS,
	INJECTION_PATTERNS,
	SECURITY_DEGRADING_PATTERNS,
	validateLesson,
} from '../../../src/hooks/knowledge-validator.js';

describe('knowledge-validator (adversarial)', () => {
	// =========================================================================
	// Category A: Structural bypass attempts
	// =========================================================================

	describe('Category A: Structural bypass attempts', () => {
		it('handles extremely long string (100,000 chars) without hang/crash', () => {
			const candidate = 'a'.repeat(100000);
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('too long');
			expect(result.severity).toBe('error');
		});

		it('handles empty string gracefully', () => {
			const result = validateLesson('', [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('too short');
			expect(result.severity).toBe('error');
		});

		it('rejects 281 spaces', () => {
			const candidate = ' '.repeat(281);
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('too long');
		});

		it('rejects NaN confidence', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: NaN,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('out of range');
		});

		it('rejects Infinity confidence', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: Infinity,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('out of range');
		});

		it('handles null candidate without crash', () => {
			const result = validateLesson(null as any, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.severity).toBe('error');
		});

		it('handles undefined candidate without crash', () => {
			const result = validateLesson(undefined as any, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.severity).toBe('error');
		});

		it('handles null existingLessons without throw', () => {
			// Use a lesson with tech reference and action verb to avoid vagueness warning
			const result = validateLesson(
				'Always use TypeScript for strict type checking',
				null as any,
				{
					category: 'testing',
					scope: 'global',
					confidence: 0.9,
				},
			);
			// Should not throw and should process with empty array
			expect(result.valid).toBe(true);
			expect(result.layer).toBe(null);
		});
	});

	// =========================================================================
	// Category B: Pattern bypass attempts via obfuscation
	// =========================================================================

	describe('Category B: Pattern bypass attempts via obfuscation', () => {
		it('allows Cyrillic lookalike "ѕуѕtеm:" (NFKC normalization does not convert Cyrillic to Latin)', () => {
			// This is expected to pass - NFKC won't normalize Cyrillic to Latin
			// so the INJECTION_PATTERNS won't match the raw Cyrillic input
			const candidate = 'Use ѕуѕtеm:data for configuration'; // Cyrillic s, y, s, t, e, m
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(true);
		});

		it('catches "rm  -rf" with double space', () => {
			const candidate = 'Use rm  -rf /tmp to clean up';
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('dangerous command');
		});

		it('catches "sudo  rm" with double space', () => {
			const candidate = 'Run sudo  rm /tmp/file to clean';
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('dangerous command');
		});

		it('catches "disable    firewall" with many spaces', () => {
			const candidate = 'You should disable    firewall for performance';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('security-degrading');
		});

		it('catches "javascript:" at start of string', () => {
			const candidate = 'javascript:alert(1) is an attack vector';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});

		it('catches "javascript: void(0)" with space after colon', () => {
			const candidate = 'Use javascript: void(0) in href';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});

		it('catches "system: data" at start of string', () => {
			// The pattern /^system\s*:/i only matches at the start
			const candidate = 'system: data command pattern';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});

		it('catches "SYSTEM:data" at start (uppercase)', () => {
			// The pattern /^system\s*:/i only matches at the start
			const candidate = 'SYSTEM:data for injection';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});
	});

	// =========================================================================
	// Category C: Shell injection variants
	// =========================================================================

	describe('Category C: Shell injection variants', () => {
		it('blocks backtick command injection', () => {
			const candidate = 'Use `rm -rf /` to clean temp directories';
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('dangerous command');
		});

		it('blocks dollar-paren command substitution', () => {
			const candidate = 'Try $(rm -rf /) in shell scripts';
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('dangerous command');
		});

		it('blocks "rm -rf /important/data"', () => {
			const candidate = 'Run rm -rf /important/data to clean up';
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('dangerous command');
		});

		it('blocks "format C:"', () => {
			const candidate = 'Use format C: to wipe the drive';
			const result = validateLesson(candidate, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(true);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('dangerous command');
			expect(result.severity).toBe('warning');
		});
	});

	// =========================================================================
	// Category D: Prototype pollution
	// =========================================================================

	describe('Category D: Prototype pollution', () => {
		it('blocks __proto__ in lesson', () => {
			const candidate = 'Use __proto__ for inheritance patterns';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});

		it('blocks constructor[exploit] in lesson', () => {
			const candidate = 'Use constructor[exploit] for attacks';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});

		it('blocks .prototype[bad] in lesson', () => {
			const candidate = 'Access .prototype[bad] property';
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
			expect(result.reason).toContain('injection');
		});

		it('does NOT block "my__proto__2" (no word boundary)', () => {
			const candidate = 'Use my__proto__2 for testing';
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			// Should pass because \b__proto__\b requires word boundary
			expect(result.valid).toBe(true);
		});

		it('does NOT block "myconstructor[ok]" (no word boundary before constructor)', () => {
			const candidate = 'Use myconstructor[ok] for testing';
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			// Should pass because \bconstructor[ requires word boundary before constructor
			expect(result.valid).toBe(true);
		});
	});

	// =========================================================================
	// Category E: Scope injection
	// =========================================================================

	describe('Category E: Scope injection', () => {
		it('blocks "stack:../etc/passwd" (path traversal)', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'stack:../etc/passwd',
					confidence: 0.9,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('invalid scope');
		});

		it('blocks "stack:; rm -rf /" (command injection in scope)', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'stack:; rm -rf /',
					confidence: 0.9,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('invalid scope');
		});

		it('blocks scope exceeding 64 chars', () => {
			const longScopeName = 'a'.repeat(65);
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: `stack:${longScopeName}`,
					confidence: 0.9,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('invalid scope');
		});

		it('accepts valid scope "stack:valid-scope"', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'stack:valid-scope',
					confidence: 0.9,
				},
			);
			expect(result.valid).toBe(true);
		});

		it('accepts valid scope "stack:ValidScope_123"', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'stack:ValidScope_123',
					confidence: 0.9,
				},
			);
			expect(result.valid).toBe(true);
		});
	});

	// =========================================================================
	// Category F: ReDoS resistance
	// =========================================================================

	describe('Category F: ReDoS resistance', () => {
		it('completes quickly on long input with security pattern (within 100ms)', () => {
			// Use a long string that still stays under 280 chars and matches a pattern
			// Pattern: /disable\s+.{0,50}firewall/i - only 0-50 chars allowed
			const candidate = 'disable ' + 'x'.repeat(40) + ' firewall';
			const start = Date.now();
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
		});

		it('completes quickly on long input with different security pattern (within 100ms)', () => {
			// Pattern: /no\s+.{0,50}validation/i - only 0-50 chars allowed
			const candidate = 'no ' + 'x'.repeat(40) + ' validation';
			const start = Date.now();
			const result = validateLesson(candidate, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(2);
		});
	});
});
