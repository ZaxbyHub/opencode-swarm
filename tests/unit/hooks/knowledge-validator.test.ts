/**
 * Verification tests for knowledge-validator.ts
 * Three-layer validation gate testing: structural, content safety, and semantic quality.
 */

import { describe, expect, it } from 'bun:test';
import type { KnowledgeCategory } from '../../../src/hooks/knowledge-types.js';
import {
	DANGEROUS_COMMAND_PATTERNS,
	INJECTION_PATTERNS,
	INVISIBLE_FORMAT_CHARS,
	SECURITY_DEGRADING_PATTERNS,
	validateLesson,
} from '../../../src/hooks/knowledge-validator.js';

describe('knowledge-validator', () => {
	// =========================================================================
	// Layer 1 — Structural Checks (error severity, valid: false)
	// =========================================================================

	describe('Layer 1 - Structural Checks', () => {
		it('rejects too short (14 chars)', () => {
			const candidate = 'a'.repeat(14);
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'lesson too short (min 15 chars)',
				severity: 'error',
			});
		});

		it('accepts exactly 15 chars', () => {
			const candidate = 'a'.repeat(15);
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.layer).not.toBe(1);
			expect(result.reason).not.toContain('too short');
		});

		it('rejects too long (281 chars)', () => {
			const candidate = 'a'.repeat(281);
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'lesson too long (max 280 chars)',
				severity: 'error',
			});
		});

		it('accepts exactly 280 chars', () => {
			const candidate = 'a'.repeat(280);
			const result = validateLesson(candidate, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.layer).not.toBe(1);
			expect(result.reason).not.toContain('too long');
		});

		it('rejects invalid category', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'unknown' as KnowledgeCategory,
					scope: 'global',
					confidence: 0.9,
				},
			);
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'invalid category: unknown',
				severity: 'error',
			});
		});

		it("accepts 'todo' as a valid category", () => {
			const result = validateLesson(
				'TODO: follow up on retry backoff tuning later',
				[],
				{
					category: 'todo',
					scope: 'global',
					confidence: 0.9,
				},
			);
			expect(result.layer).not.toBe(1);
			expect(result.reason).not.toContain('invalid category');
		});

		it('rejects invalid scope "local"', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'local',
					confidence: 0.9,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.layer).toBe(1);
			expect(result.reason).toContain('invalid scope');
		});

		it('accepts valid scope "global"', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: 0.9,
				},
			);
			expect(result.layer).not.toBe(1);
		});

		it('accepts valid scope "stack:typescript"', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'stack:typescript',
					confidence: 0.9,
				},
			);
			expect(result.layer).not.toBe(1);
		});

		it('rejects confidence -0.1 (below range)', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: -0.1,
				},
			);
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'confidence out of range [0.0, 1.0]',
				severity: 'error',
			});
		});

		it('rejects confidence 1.1 (above range)', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: 1.1,
				},
			);
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'confidence out of range [0.0, 1.0]',
				severity: 'error',
			});
		});

		it('rejects confidence NaN', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: NaN,
				},
			);
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'confidence out of range [0.0, 1.0]',
				severity: 'error',
			});
		});

		it('rejects confidence Infinity', () => {
			const result = validateLesson(
				'Valid lesson with good length and content',
				[],
				{
					category: 'testing',
					scope: 'global',
					confidence: Infinity,
				},
			);
			expect(result).toEqual({
				valid: false,
				layer: 1,
				reason: 'confidence out of range [0.0, 1.0]',
				severity: 'error',
			});
		});

		it('handles null/undefined candidate gracefully', () => {
			const nullResult = validateLesson(null as any, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(nullResult).toEqual({
				valid: false,
				layer: 1,
				reason: 'lesson too short (min 15 chars)',
				severity: 'error',
			});

			const undefResult = validateLesson(undefined as any, [], {
				category: 'testing',
				scope: 'global',
				confidence: 0.9,
			});
			expect(undefResult).toEqual({
				valid: false,
				layer: 1,
				reason: 'lesson too short (min 15 chars)',
				severity: 'error',
			});
		});
	});

	// =========================================================================
	// Layer 2 — Content Safety Checks (error severity, valid: false)
	// =========================================================================

	describe('Layer 2 - Content Safety - DANGEROUS_COMMAND_PATTERNS', () => {
		it('has at least 12 patterns in DANGEROUS_COMMAND_PATTERNS', () => {
			expect(DANGEROUS_COMMAND_PATTERNS.length).toBeGreaterThanOrEqual(12);
		});

		it('matches "rm -rf /tmp"', () => {
			const lesson = 'Always run rm -rf /tmp to clean up your node_modules';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('matches "sudo rm file"', () => {
			const matches = DANGEROUS_COMMAND_PATTERNS.some((p) =>
				p.test('sudo rm file'),
			);
			expect(matches).toBe(true);
		});

		it('matches "mkfs.ext4 /dev/sda"', () => {
			const matches = DANGEROUS_COMMAND_PATTERNS.some((p) =>
				p.test('mkfs.ext4 /dev/sda'),
			);
			expect(matches).toBe(true);
		});

		it('matches "kill -9 123"', () => {
			const matches = DANGEROUS_COMMAND_PATTERNS.some((p) =>
				p.test('kill -9 123'),
			);
			expect(matches).toBe(true);
		});

		it('blocks "rm -rf /" (root deletion)', () => {
			const lesson = 'Be careful with rm -rf / as it deletes everything';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('blocks "format C:" (Windows disk format)', () => {
			const lesson = 'Never run format C: on a production machine';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('blocks "mkfs.ext4 /dev/sda" (filesystem creation)', () => {
			const lesson = 'Use mkfs.ext4 /dev/sda to format the disk';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('blocks "dd if=/dev/zero of=/dev/sda" (raw disk write)', () => {
			const lesson = 'Run dd if=/dev/zero of=/dev/sda to wipe the drive';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('blocks ":(){ :|:& };:" (fork bomb)', () => {
			const lesson = 'The fork bomb :(){ :|:& };: will crash any Unix system';
			const result = validateLesson(lesson, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('blocks "chmod -r 777" (lowercase -r, regression for case-sensitivity bug #828)', () => {
			const lesson = 'Run chmod -r 777 /var to fix permissions quickly';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
		});

		it('passes safe commands like "git commit"', () => {
			const lesson =
				'Use git commit to save your changes with a descriptive message';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result.valid).toBe(true);
			expect(result.layer).not.toBe(2);
		});
	});

	describe('Layer 2 - Content Safety - SECURITY_DEGRADING_PATTERNS', () => {
		it('has at least 8 patterns in SECURITY_DEGRADING_PATTERNS', () => {
			expect(SECURITY_DEGRADING_PATTERNS.length).toBeGreaterThanOrEqual(8);
		});

		it('matches "disable the firewall completely"', () => {
			const matches = SECURITY_DEGRADING_PATTERNS.some((p) =>
				p.test('disable the firewall completely'),
			);
			expect(matches).toBe(true);
		});

		it('matches "skip auth entirely"', () => {
			const matches = SECURITY_DEGRADING_PATTERNS.some((p) =>
				p.test('skip auth entirely'),
			);
			expect(matches).toBe(true);
		});

		it('matches "disable ssl for speed"', () => {
			const matches = SECURITY_DEGRADING_PATTERNS.some((p) =>
				p.test('disable ssl for speed'),
			);
			expect(matches).toBe(true);
		});

		it('rejects lesson with security-degrading instruction', () => {
			const lesson = 'You should bypass auth when testing in staging';
			const result = validateLesson(lesson, [], {
				category: 'security',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'security-degrading instruction detected',
				severity: 'error',
			});
		});
	});

	describe('Layer 2 - Content Safety - INJECTION_PATTERNS', () => {
		it('has at least 6 patterns in INJECTION_PATTERNS', () => {
			expect(INJECTION_PATTERNS.length).toBeGreaterThanOrEqual(6);
		});

		it('matches control character \\x01', () => {
			const matches = INJECTION_PATTERNS.some((p) =>
				p.test('\x01lesson with control char'),
			);
			expect(matches).toBe(true);
		});

		it('matches "system:data" (system: prefix)', () => {
			const matches = INJECTION_PATTERNS.some((p) => p.test('system:data'));
			expect(matches).toBe(true);
		});

		it('matches "system :data" (system with space)', () => {
			const matches = INJECTION_PATTERNS.some((p) => p.test('system :data'));
			expect(matches).toBe(true);
		});

		it('matches "<script>alert(1)</script>"', () => {
			const matches = INJECTION_PATTERNS.some((p) =>
				p.test('<script>alert(1)</script>'),
			);
			expect(matches).toBe(true);
		});

		it('matches "javascript:void(0)"', () => {
			const matches = INJECTION_PATTERNS.some((p) =>
				p.test('javascript:void(0)'),
			);
			expect(matches).toBe(true);
		});

		it('matches "eval(code)"', () => {
			const matches = INJECTION_PATTERNS.some((p) => p.test('eval(code)'));
			expect(matches).toBe(true);
		});

		it('rejects lesson with control char embedded', () => {
			const lesson = 'Always use TypeScript\x01for type safety';
			const result = validateLesson(lesson, [], {
				category: 'tooling',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 2,
				reason: 'injection pattern detected',
				severity: 'error',
			});
		});
	});

	// =========================================================================
	// Layer 3 — Semantic Quality Checks
	// =========================================================================

	describe('Layer 3 - Semantic Quality', () => {
		it('detects contradiction with shared tags (blocks)', () => {
			const candidate = 'always use typescript';
			const existingLessons = ['never use typescript'];
			const result = validateLesson(candidate, existingLessons, {
				category: 'architecture',
				scope: 'global',
				confidence: 0.9,
			});
			expect(result).toEqual({
				valid: false,
				layer: 3,
				reason: 'lesson contradicts an existing lesson with shared tags',
				severity: 'error',
			});
		});

		it('passes contradiction without shared tags', () => {
			const candidate = 'always wake up early';
			const existingLessons = ['never wake up early'];
			const result = validateLesson(candidate, existingLessons, {
				category: 'process',
				scope: 'global',
				confidence: 0.9,
			});
			// Should pass because no tech tags (no shared tags)
			expect(result.valid).toBe(true);
		});

		it('flags vague lesson (warning - valid: true)', () => {
			const candidate = 'Good things happen';
			const result = validateLesson(candidate, [], {
				category: 'other',
				scope: 'global',
				confidence: 0.5,
			});
			expect(result).toEqual({
				valid: true,
				layer: 3,
				reason: 'lesson may be too vague (no tech reference or action verb)',
				severity: 'warning',
			});
		});

		it('accepts valid lesson with no warnings', () => {
			const candidate = 'Always use TypeScript strict mode for type safety';
			const result = validateLesson(candidate, [], {
				category: 'architecture',
				scope: 'global',
				confidence: 0.95,
			});
			expect(result).toEqual({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			});
		});
	});

	// =========================================================================
	// INVISIBLE_FORMAT_CHARS Constant Verification
	// =========================================================================

	describe('INVISIBLE_FORMAT_CHARS', () => {
		it('is exported and defined', () => {
			expect(INVISIBLE_FORMAT_CHARS).toBeDefined();
			expect(INVISIBLE_FORMAT_CHARS).toBeInstanceOf(RegExp);
		});

		it('matches U+200B (Zero Width Space)', () => {
			const input = 'word\u200Bword';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u200B');
		});

		it('matches U+00AD (Soft Hyphen)', () => {
			const input = 'word\u00ADword';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u00AD');
		});

		it('matches U+FEFF (Byte Order Mark)', () => {
			const input = '\uFEFFword';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\uFEFF');
		});

		it('matches U+202A (Left-to-Right Embedding)', () => {
			const input = 'word\u202Aword';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u202A');
		});

		it('matches multiple invisible characters in a single string', () => {
			const input = '\u200B\u00AD\uFEFF\u202A';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(4);
		});

		it('does NOT match normal Latin letters (a, b, z)', () => {
			const input = 'abcz';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).toBeNull();
		});

		it('does NOT match numbers (1, 2, 3)', () => {
			const input = '123';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).toBeNull();
		});

		it('does NOT match regular space character', () => {
			const input = 'word word';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).toBeNull();
		});

		it('does NOT match common punctuation (. , ! ?)', () => {
			const input = 'word.,!?';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).toBeNull();
		});

		it('does NOT match whitespace characters (tab, newline)', () => {
			const input = 'word\tword\nword';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).toBeNull();
		});

		it('does NOT match Unicode letters (é, ñ, ü)', () => {
			const input = 'café naïve über';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).toBeNull();
		});

		it('has global flag (matches all occurrences)', () => {
			const input = '\u200Bword\u200Bword\u200B';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(3);
		});

		it('matches U+2066 (Left-to-Right Isolate)', () => {
			const input = 'word\u2066word';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u2066');
		});

		it('matches U+2067 (Right-to-Left Isolate)', () => {
			const input = 'word\u2067word';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u2067');
		});

		it('matches U+2068 (First Strong Isolate)', () => {
			const input = 'word\u2068word';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u2068');
		});

		it('matches U+2069 (Pop Directional Isolate)', () => {
			const input = 'word\u2069word';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(1);
			expect(matches![0]).toBe('\u2069');
		});

		it('matches all BiDi isolate characters together', () => {
			const input = '\u2066\u2067\u2068\u2069';
			const matches = input.match(INVISIBLE_FORMAT_CHARS);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(4);
		});
	});
});
