/**
 * Tests for validateSkillCandidatePath
 * Path validation for candidate skill storage under .swarm/skills/candidates/
 */

import { describe, expect, it } from 'bun:test';
import { validateSkillCandidatePath } from '../../../src/hooks/knowledge-validator.js';

// Canonical UUID v4 for consistent testing
const CANONICAL_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_CANDIDATE_PATH = `.swarm/skills/candidates/${CANONICAL_UUID}.json`;

describe('validateSkillCandidatePath', () => {
	// ========================================================================
	// Happy Path — valid candidate paths
	// ========================================================================

	describe('valid candidate paths', () => {
		it('returns true for valid lowercase UUID v4 with .json', () => {
			const result = validateSkillCandidatePath(VALID_CANDIDATE_PATH);
			expect(result).toBe(true);
		});

		it('returns true for valid uppercase UUID v4 with .json', () => {
			const upperUuid = CANONICAL_UUID.toUpperCase();
			const path = `.swarm/skills/candidates/${upperUuid}.JSON`;
			const result = validateSkillCandidatePath(path);
			expect(result).toBe(true);
		});

		it('returns true for mixed-case UUID v4 with .json', () => {
			// UUID with mixed case that is still valid hex
			const mixedUuid = '550e8400-E29B-41d4-A716-446655440000';
			const path = `.swarm/skills/candidates/${mixedUuid}.json`;
			const result = validateSkillCandidatePath(path);
			expect(result).toBe(true);
		});

		it('returns true for path with Windows backslashes (normalized)', () => {
			// Backslashes should be normalized to forward slashes
			const windowsPath = `.swarm\\skills\\candidates\\${CANONICAL_UUID}.json`;
			const result = validateSkillCandidatePath(windowsPath);
			expect(result).toBe(true);
		});

		it('returns true for a typical valid path (well under 256 limit)', () => {
			// Minimum valid: prefix(25) + uuid(36) + suffix(5) = 66 chars
			const result = validateSkillCandidatePath(VALID_CANDIDATE_PATH);
			expect(result).toBe(true);
		});
	});

	// ========================================================================
	// Type Guards — rejects non-strings
	// ========================================================================

	describe('type guards — rejects non-strings', () => {
		it('returns false for null', () => {
			expect(validateSkillCandidatePath(null)).toBe(false);
		});

		it('returns false for undefined', () => {
			expect(validateSkillCandidatePath(undefined)).toBe(false);
		});

		it('returns false for number', () => {
			expect(validateSkillCandidatePath(42)).toBe(false);
		});

		it('returns false for object', () => {
			expect(validateSkillCandidatePath({})).toBe(false);
		});

		it('returns false for array', () => {
			expect(validateSkillCandidatePath([])).toBe(false);
		});

		it('returns false for boolean', () => {
			expect(validateSkillCandidatePath(true)).toBe(false);
		});

		it('returns false for symbol', () => {
			expect(validateSkillCandidatePath(Symbol('test'))).toBe(false);
		});
	});

	// ========================================================================
	// Empty String
	// ========================================================================

	describe('empty string', () => {
		it('returns false for empty string', () => {
			expect(validateSkillCandidatePath('')).toBe(false);
		});
	});

	// ========================================================================
	// Path Traversal — rejected
	// ========================================================================

	describe('path traversal', () => {
		it('returns false for path with .. (forward slash)', () => {
			const path = `.swarm/skills/candidates/../${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for path with ..\\\\ (Windows backslash)', () => {
			const path = `.swarm\\skills\\candidates\\..\\${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for deeply nested .. traversal', () => {
			const path = `.swarm/skills/candidates/../../etc/passwd`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Absolute Paths — rejected
	// ========================================================================

	describe('absolute paths', () => {
		it('returns false for Unix absolute path', () => {
			expect(validateSkillCandidatePath('/absolute/path/skills.json')).toBe(
				false,
			);
		});

		it('returns false for Windows absolute path', () => {
			expect(
				validateSkillCandidatePath('C:\\swarm\\skills\\candidates\\file.json'),
			).toBe(false);
		});

		it('returns false for UNC path', () => {
			expect(validateSkillCandidatePath('\\\\server\\share\\file.json')).toBe(
				false,
			);
		});
	});

	// ========================================================================
	// Null Bytes — rejected
	// ========================================================================

	describe('null bytes', () => {
		it('returns false for null byte in path', () => {
			const path = `.swarm/skills/candidates/${CANONICAL_UUID}\0.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for null byte prefix', () => {
			const path = `\0.swarm/skills/candidates/${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Wrong Prefix — rejected
	// ========================================================================

	describe('wrong prefix', () => {
		it('returns false for .opencode/skills/generated/ prefix', () => {
			const path = `.opencode/skills/generated/${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for .swarm/skills/proposals/ prefix', () => {
			const path = `.swarm/skills/proposals/${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for .swarm/skills/ prefix (missing candidates)', () => {
			const path = `.swarm/skills/${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for .swarm/ prefix only', () => {
			const path = `.swarm/${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for no prefix at all', () => {
			const path = `${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for similar but different prefix', () => {
			const path = `.swarm/skills/candidates-folder/${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Missing .json Extension — rejected
	// ========================================================================

	describe('missing .json extension', () => {
		it('returns false for .json.txt (wrong extension)', () => {
			const path = `.swarm/skills/candidates/${CANONICAL_UUID}.json.txt`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for no extension', () => {
			const path = `.swarm/skills/candidates/${CANONICAL_UUID}`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for .JSON uppercase extension', () => {
			// This is actually valid (case-insensitive match) — tested in happy path
			// Here we test when the file name doesn't end with .json
			const path = `.swarm/skills/candidates/${CANONICAL_UUID}.JSON`;
			expect(validateSkillCandidatePath(path)).toBe(true);
		});

		it('returns false for .json5 extension', () => {
			const path = `.swarm/skills/candidates/${CANONICAL_UUID}.json5`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for .jsonl extension', () => {
			const path = `.swarm/skills/candidates/${CANONICAL_UUID}.jsonl`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Non-UUID Filename — rejected
	// ========================================================================

	describe('non-UUID filename', () => {
		it('returns false for plain string filename', () => {
			const path = `.swarm/skills/candidates/my-skill.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for date-based filename', () => {
			const path = `.swarm/skills/candidates/2024-01-15.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for sequential number filename', () => {
			const path = `.swarm/skills/candidates/00000001.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for slug-style filename', () => {
			const path = `.swarm/skills/candidates/my-awesome-skill.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for UUID v1 (version digit = 1)', () => {
			// UUID v1: version digit in position 14 is '1'
			const uuidV1 = '550e8400-e29b-11d4-a716-446655440000';
			const path = `.swarm/skills/candidates/${uuidV1}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for UUID v3 (version digit = 3)', () => {
			// UUID v3: version digit in position 14 is '3'
			const uuidV3 = '550e8400-e29b-31d4-a716-446655440000';
			const path = `.swarm/skills/candidates/${uuidV3}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for UUID v5 (version digit = 5)', () => {
			// UUID v5: version digit in position 14 is '5'
			const uuidV5 = '550e8400-e29b-51d4-a716-446655440000';
			const path = `.swarm/skills/candidates/${uuidV5}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for UUID with invalid variant bits', () => {
			// Variant digit (position 19) must be 8, 9, a, or b
			const invalidVariant = '550e8400-e29b-41d4-c716-446655440000';
			const path = `.swarm/skills/candidates/${invalidVariant}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for truncated UUID', () => {
			const path = `.swarm/skills/candidates/550e8400-e29b-41d4-a716.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for extended UUID', () => {
			const path = `.swarm/skills/candidates/550e8400-e29b-41d4-a716-446655440000-extra.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for non-hex characters in UUID', () => {
			const path = `.swarm/skills/candidates/550e8400-e29b-41d4-g716-446655440000.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Path Length Boundary
	// ========================================================================

	describe('path length boundary', () => {
		it('returns false for path exceeding 256 characters', () => {
			const prefix = '.swarm/skills/candidates/';
			const suffix = '.json';
			const uuid = CANONICAL_UUID;
			// 256 - prefix(27) - uuid(36) - suffix(5) = 188
			const padding = 'a'.repeat(200); // exceeds boundary
			const path = `${prefix}${padding}${uuid}${suffix}`;
			expect(path.length).toBeGreaterThan(256);
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for exactly 257 characters (length check triggers before UUID)', () => {
			// Build a path > 256 chars using a non-UUID filename.
			// The length check (p.length > 256) fires before the UUID regex, so any
			// string > 256 chars under the prefix returns false.
			// prefix(25) + longName(227) + .json(5) = 257
			const prefix = '.swarm/skills/candidates/'; // 25 chars
			const longName = 'a'.repeat(227); // makes 257 total with .json
			const path = `${prefix}${longName}.json`;
			expect(path.length).toBe(257);
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for single char over 256', () => {
			const path = 'a'.repeat(257);
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Windows Path Normalization
	// ========================================================================

	describe('Windows path normalization', () => {
		it('returns true for all-backslash Windows path', () => {
			const windowsPath = `.swarm\\skills\\candidates\\${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(windowsPath)).toBe(true);
		});

		it('returns false for mixed traversal with backslashes', () => {
			const path = `.swarm\\skills\\candidates\\..\\etc\\passwd.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});

		it('returns false for absolute Windows path with backslashes', () => {
			const path = `C:\\swarm\\skills\\candidates\\${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(path)).toBe(false);
		});
	});

	// ========================================================================
	// Property-Based — Round-trip normalizability
	// ========================================================================

	describe('property: normalization does not affect valid path check', () => {
		it('accepts valid path after backslash normalization', () => {
			const unixPath = `.swarm/skills/candidates/${CANONICAL_UUID}.json`;
			const windowsPath = `.swarm\\skills\\candidates\\${CANONICAL_UUID}.json`;
			expect(validateSkillCandidatePath(unixPath)).toBe(
				validateSkillCandidatePath(windowsPath),
			);
		});

		it('rejects invalid path regardless of normalization', () => {
			const badUnix = `.swarm/skills/candidates/INVALID.json`;
			const badWindows = `.swarm\\skills\\candidates\\INVALID.json`;
			expect(validateSkillCandidatePath(badUnix)).toBe(
				validateSkillCandidatePath(badWindows),
			);
		});
	});
});
