/**
 * Tests for the isWriteToEvidenceFile predicate in knowledge-curator.ts
 * Tests path matching for evidence file writes across different scenarios.
 */

import { describe, expect, test } from 'vitest';
import {
	isEvidencePath,
	isWriteToEvidenceFile,
} from '../../../src/hooks/knowledge-curator.js';

// ============================================================================
// Positive matches (should return true)
// ============================================================================

describe('isWriteToEvidenceFile - positive matches', () => {
	test('write to .swarm/evidence/retro-3/evidence.json', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('edit to .swarm/evidence/retro-phase1/evidence.json', () => {
		const input = {
			toolName: 'edit',
			file: '.swarm/evidence/retro-phase1/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('apply_patch to .swarm/evidence/retro-99/evidence.json', () => {
		const input = {
			toolName: 'apply_patch',
			path: '.swarm/evidence/retro-99/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('Windows path with backslashes: .swarm\\evidence\\retro-3\\evidence.json', () => {
		const input = {
			toolName: 'write',
			path: '.swarm\\evidence\\retro-3\\evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('absolute Windows path with .swarm in it: C:\\project\\.swarm\\evidence\\retro-1\\evidence.json', () => {
		const input = {
			toolName: 'write',
			path: 'C:\\project\\.swarm\\evidence\\retro-1\\evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .swarm/evidence/retro-123/evidence.json (three-digit retro)', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-123/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('edit with retro prefix containing letters: .swarm/evidence/retro-phase-alpha/evidence.json', () => {
		const input = {
			toolName: 'edit',
			file: '.swarm/evidence/retro-phase-alpha/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .swarm/evidence/retro-3/evidence.json with extra path segments', () => {
		const input = {
			toolName: 'write',
			path: 'prefix/.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});
});

// ============================================================================
// Negative matches (should return false)
// ============================================================================

describe('isWriteToEvidenceFile - negative matches', () => {
	test('write to .swarm/plan.md - wrong file', () => {
		const input = { toolName: 'write', path: '.swarm/plan.md' };
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('write to .swarm/evidence/other.json - now correctly blocked by broad guard', () => {
		const input = { toolName: 'write', path: '.swarm/evidence/other.json' };
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .swarm/evidence/retro-3/other.json - now correctly blocked by broad guard', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3/other.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('read to .swarm/evidence/retro-3/evidence.json - read is not a write op', () => {
		const input = {
			toolName: 'read',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('null input', () => {
		expect(isWriteToEvidenceFile(null)).toBe(false);
	});

	test('undefined input', () => {
		expect(isWriteToEvidenceFile(undefined)).toBe(false);
	});

	test('number input (42)', () => {
		expect(isWriteToEvidenceFile(42)).toBe(false);
	});

	test('string input', () => {
		expect(isWriteToEvidenceFile('.swarm/evidence/retro-3/evidence.json')).toBe(
			false,
		);
	});

	test('empty object - missing toolName', () => {
		const input = {};
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('object with null toolName', () => {
		const input = {
			toolName: null,
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('object with undefined toolName', () => {
		const input = {
			toolName: undefined,
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('object with string toolName but not write/edit/apply_patch', () => {
		const input = {
			toolName: 'delete',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('object with toolName but no path or file', () => {
		const input = { toolName: 'write' };
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('write to .swarm/evidence.json - missing retro- subdirectory', () => {
		const input = { toolName: 'write', path: '.swarm/evidence.json' };
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('write to .swarm/evidence/retro-3/ - directory path without file - now correctly blocked', () => {
		const input = { toolName: 'write', path: '.swarm/evidence/retro-3/' };
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .swarm/evidence/retro-/evidence.json - empty retro identifier - now correctly blocked', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .swarm/evidence/retro-3/evidence.json.md - wrong extension - now correctly blocked', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3/evidence.json.md',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to evidence.json - missing .swarm prefix', () => {
		const input = { toolName: 'write', path: 'evidence/retro-3/evidence.json' };
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('array input', () => {
		const input = ['toolName', 'write'];
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('boolean input', () => {
		expect(isWriteToEvidenceFile(true)).toBe(false);
		expect(isWriteToEvidenceFile(false)).toBe(false);
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe('isWriteToEvidenceFile - edge cases', () => {
	test('mixed slashes in path', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence\\retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('path with trailing slash - now correctly blocked by broad guard', () => {
		const input = { toolName: 'write', path: '.swarm/evidence/retro-3/' };
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('path with leading slash', () => {
		const input = {
			toolName: 'write',
			path: '/.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('both path and file fields present - path takes precedence', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3/evidence.json',
			file: 'other.txt',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('path field is evidence file, file field is not - should match via path', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3/evidence.json',
			file: '.swarm/plan.md',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('file field is evidence file, path field is not - should match via file', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/plan.md',
			file: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('retro identifier with special characters: retro-3_2', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3_2/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('retro identifier with hyphens: retro-phase-1-complete', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-phase-1-complete/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('path with double backslashes (escaped) - correctly blocked (normalizes to double-slash path)', () => {
		const input = {
			toolName: 'write',
			path: '.swarm\\\\evidence\\\\retro-3\\\\evidence.json',
		};
		// Double backslashes normalize to double slashes (.swarm//evidence//) which the broad guard correctly blocks
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('object with extra properties should still match', () => {
		const input = {
			toolName: 'write',
			path: '.swarm/evidence/retro-3/evidence.json',
			extra: 'property',
			sessionID: 'test',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('edit tool with evidence file', () => {
		const input = {
			toolName: 'edit',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('apply_patch tool with evidence file', () => {
		const input = {
			toolName: 'apply_patch',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('WRITE tool (uppercase) should work - check case sensitivity', () => {
		const input = {
			toolName: 'WRITE',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		// The function checks exact string matches in array, so uppercase should fail
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('Write tool (mixed case) should work - check case sensitivity', () => {
		const input = {
			toolName: 'Write',
			path: '.swarm/evidence/retro-3/evidence.json',
		};
		// The function checks exact string matches in array, so mixed case should fail
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});
});

// ============================================================================
// Broadened guard — previously-negative now correctly blocked (plan task 2.2)
// ============================================================================

describe('isWriteToEvidenceFile - broadened guard (plan task 2.2)', () => {
	test('write to .swarm/evidence/3.1.json returns true', () => {
		const input = { toolName: 'write', path: '.swarm/evidence/3.1.json' };
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('edit to .swarm/evidence/phase-2/results.json returns true', () => {
		const input = {
			toolName: 'edit',
			file: '.swarm/evidence/phase-2/results.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('apply_patch to .swarm/evidence/retro-1/evidence.json returns true (legacy pattern still works)', () => {
		const input = {
			toolName: 'apply_patch',
			path: '.swarm/evidence/retro-1/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .swarm/plan.json returns false (not under evidence/)', () => {
		const input = { toolName: 'write', path: '.swarm/plan.json' };
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});

	test('read to .swarm/evidence/3.1.json returns false (read is not a write op)', () => {
		const input = { toolName: 'read', path: '.swarm/evidence/3.1.json' };
		expect(isWriteToEvidenceFile(input)).toBe(false);
	});
});

// ============================================================================
// Case-insensitive path matching (security fix — /i flag)
// ============================================================================

describe('isWriteToEvidenceFile - case-insensitive path guard', () => {
	test('write to .swarm/EVIDENCE/file.json returns true (uppercase EVIDENCE)', () => {
		const input = { toolName: 'write', path: '.swarm/EVIDENCE/file.json' };
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .SWARM/EVIDENCE/retro-1/evidence.json returns true (fully uppercase)', () => {
		const input = {
			toolName: 'write',
			path: '.SWARM/EVIDENCE/retro-1/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});

	test('write to .Swarm/Evidence/Retro-1/evidence.json returns true (mixed case)', () => {
		const input = {
			toolName: 'write',
			path: '.Swarm/Evidence/Retro-1/evidence.json',
		};
		expect(isWriteToEvidenceFile(input)).toBe(true);
	});
});

// ============================================================================
// FB-002 regression: isEvidencePath must not match spurious substring paths
// ============================================================================

describe('isEvidencePath - FB-002 regression (no spurious substring matches)', () => {
	test('FB-002: isEvidencePath returns false for foo.swarm/evidence/bar (substring, not directory component)', () => {
		expect(isEvidencePath('foo.swarm/evidence/bar')).toBe(false);
	});

	test('FB-002: isEvidencePath returns false for E:/repo/foo.swarm/evidence/a.json (substring)', () => {
		expect(isEvidencePath('E:/repo/foo.swarm/evidence/a.json')).toBe(false);
	});

	test('FB-002: isEvidencePath returns true for legitimate .swarm/evidence paths', () => {
		expect(isEvidencePath('.swarm/evidence/bar')).toBe(true);
		expect(isEvidencePath('E:/repo/.swarm/evidence/a.json')).toBe(true);
		expect(
			isEvidencePath('/project/.swarm/evidence/retro-1/evidence.json'),
		).toBe(true);
	});
});
