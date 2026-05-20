/**
 * Adversarial tests for SAST scan behavior
 * Testing attack vectors, boundary violations, and malformed input handling
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable mock state
let mockSemgrepAvailable = false;
const mockRunSemgrepCalls: any[] = [];
let mockRunSemgrepResult: {
	findings: any[];
	engine: 'tier_a' | 'tier_a+tier_b';
} = {
	findings: [],
	engine: 'tier_a+tier_b',
};
let mockRunSemgrepShouldThrow = false;
const mockExecuteRulesSyncCalls: string[] = [];
let mockExecuteRulesSyncResult: any[] = [];
let mockGetProfileForFileResult: any = null;
let mockGetLanguageForExtResult: any = null;

mock.module('../../../src/sast/semgrep', () => ({
	isSemgrepAvailable: () => mockSemgrepAvailable,
	runSemgrep: async (opts: any) => {
		mockRunSemgrepCalls.push(opts);
		if (mockRunSemgrepShouldThrow) {
			throw new Error('Semgrep failed');
		}
		return mockRunSemgrepResult;
	},
}));

mock.module('../../../src/sast/rules/index', () => ({
	executeRulesSync: (filePath: string, content: string, lang: string) => {
		mockExecuteRulesSyncCalls.push(lang);
		if (mockExecuteRulesSyncShouldThrow) {
			throw new Error('Tier A execution failed');
		}
		return mockExecuteRulesSyncResult;
	},
}));

let mockExecuteRulesSyncShouldThrow = false;

mock.module('../../../src/lang/detector', () => ({
	getProfileForFile: (_filePath: string) => mockGetProfileForFileResult,
}));

mock.module('../../../src/lang/registry', () => ({
	getLanguageForExtension: (_ext: string) => mockGetLanguageForExtResult,
}));

mock.module('../../../src/evidence/manager', () => ({
	saveEvidence: async () => {},
}));

// Dynamic import AFTER mocking
const { sastScan } = await import('../../../src/tools/sast-scan');

describe('SAST Scan - Adversarial Tests', () => {
	let tmpDir: string;

	beforeEach(() => {
		// Create a temp directory for test files
		tmpDir = mkdtempSync(join(tmpdir(), 'sast-adversarial-'));

		// Reset all mock state
		mockSemgrepAvailable = true;
		mockRunSemgrepCalls.length = 0;
		mockRunSemgrepResult = {
			findings: [],
			engine: 'tier_a+tier_b',
		};
		mockRunSemgrepShouldThrow = false;
		mockExecuteRulesSyncCalls.length = 0;
		mockExecuteRulesSyncResult = [];
		mockExecuteRulesSyncShouldThrow = false;
		mockGetProfileForFileResult = null;
		mockGetLanguageForExtResult = null;
	});

	afterEach(() => {
		// Clean up temp directory
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		// Restore cross-module mocks to prevent contamination
		mock.restore();
	});

	it('Adversarial 1: Oversized file list → cap at MAX_FILES_SCANNED (1000) + warn', async () => {
		// Arrange - Create 2000 valid file paths
		const fileList: string[] = [];
		for (let i = 0; i < 2000; i++) {
			const fileName = `test${i}.ts`;
			const filePath = join(tmpDir, fileName);
			writeFileSync(filePath, `const x${i} = ${i};`);
			fileList.push(fileName);
		}

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		// Act
		const result = await sastScan({ changed_files: fileList }, tmpDir);

		// Assert - Should cap at 1000
		expect(result.summary.files_scanned).toBeLessThanOrEqual(1000);
		expect(result.summary.files_scanned).toBe(1000); // Should be exactly 1000
	});

	it('Adversarial 2: Null/undefined/empty string in changed_files → skip gracefully, no crash', async () => {
		// Arrange
		const testFile = join(tmpDir, 'valid.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		// Act - Pass null, undefined, empty string mixed with valid file
		const result = await sastScan(
			{ changed_files: [null as any, undefined as any, '', 'valid.ts'] },
			tmpDir,
		);

		// Assert - Should not crash, should scan only the valid file
		expect(result.summary.files_scanned).toBe(1);
		expect(result.findings).toBeDefined();
	});

	it('Adversarial 3: Path traversal in file path → non-existent file, skipped, no crash', async () => {
		// Arrange
		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		// Act - Path traversal attempt
		const result = await sastScan(
			{ changed_files: ['../../../etc/passwd'] },
			tmpDir,
		);

		// Assert - Should skip gracefully, 0 files scanned, no crash
		expect(result.summary.files_scanned).toBe(0);
		expect(result.findings).toEqual([]);
	});

	it('Adversarial 4: Profile with unexpected semgrepSupport value → treated as auto-mode bucket', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.kt');
		writeFileSync(testFile, 'fun main() {}');

		// Profile with unexpected semgrepSupport value
		mockGetProfileForFileResult = {
			id: 'kotlin',
			sast: { nativeRuleSet: null, semgrepSupport: 'unknown_value' as any },
		};

		// Act
		const result = await sastScan({ changed_files: ['test.kt'] }, tmpDir);

		// Assert - Since semgrepSupport !== 'none', should be treated as truthy → auto mode
		expect(result.summary.files_scanned).toBe(1);
		expect(mockExecuteRulesSyncCalls.length).toBe(0); // Tier A NOT called (nativeRuleSet === null)
		expect(mockRunSemgrepCalls.length).toBe(1);
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBe(true); // Auto mode used
		expect(mockRunSemgrepCalls[0].lang).toBe('kotlin');
	});

	it('Adversarial 5: runSemgrep returns malformed findings → must not crash', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		// Malformed findings with null/undefined fields
		mockRunSemgrepResult = {
			findings: [
				{
					rule_id: null,
					severity: undefined,
					message: null,
					location: null,
				},
				{
					rule_id: 'valid-rule',
					severity: 'high',
					message: 'Valid finding',
					location: { file: testFile, line: 1 },
				},
			],
			engine: 'tier_a+tier_b',
		};

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert - Should not crash, should include what it can
		expect(result.findings).toBeDefined();
		expect(mockRunSemgrepCalls.length).toBe(1);
	});

	it('Adversarial 6: executeRulesSync throws → caught by try/catch, returns [], scan continues', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		mockExecuteRulesSyncShouldThrow = true;
		mockRunSemgrepResult = {
			findings: [
				{
					rule_id: 'semgrep-rule',
					severity: 'medium',
					message: 'Semgrep finding',
					location: { file: testFile, line: 1 },
				},
			],
			engine: 'tier_a+tier_b',
		};

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert - Should catch the throw, return empty Tier A findings, but continue to Semgrep
		expect(result.summary.files_scanned).toBe(1);
		expect(mockExecuteRulesSyncCalls.length).toBe(1); // Was called but threw
		expect(mockRunSemgrepCalls.length).toBe(1); // Semgrep still called
		expect(result.findings.length).toBe(1); // Only Semgrep finding
		expect(result.findings[0].rule_id).toBe('semgrep-rule');
	});

	it('Adversarial 7: Concurrent Semgrep auto + local buckets → runSemgrep called twice per bucket', async () => {
		// Arrange
		const kotlinFile = join(tmpDir, 'test.kt');
		writeFileSync(kotlinFile, 'fun main() {}');

		const tsFile = join(tmpDir, 'test.ts');
		writeFileSync(tsFile, 'const x = 1;');

		// For this test, we need Kotlin to use auto mode (nativeRuleSet=null, semgrepSupport=beta)
		// and TypeScript to use local mode (nativeRuleSet=javascript, semgrepSupport=ga)
		// Since our mock doesn't support per-file logic, we test each scenario separately
		// First test with TypeScript (local bucket)
		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		mockRunSemgrepResult = {
			findings: [],
			engine: 'tier_a+tier_b',
		};

		mockExecuteRulesSyncResult = [
			{
				rule_id: 'ts-rule',
				severity: 'low',
				message: 'TypeScript finding',
				location: { file: tsFile, line: 1 },
			},
		];

		// Act - scan TypeScript file
		const result1 = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert - local mode used
		expect(result1.summary.files_scanned).toBe(1);
		expect(mockRunSemgrepCalls.length).toBe(1);
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBeUndefined(); // No auto mode
		expect(mockRunSemgrepCalls[0].lang).toBeUndefined();
		expect(mockRunSemgrepCalls[0].files).toContain(tsFile);

		// Reset mocks
		mockRunSemgrepCalls.length = 0;
		mockExecuteRulesSyncCalls.length = 0;

		// Now test with Kotlin (auto bucket)
		mockGetProfileForFileResult = {
			id: 'kotlin',
			sast: { nativeRuleSet: null, semgrepSupport: 'beta' },
		};

		mockExecuteRulesSyncResult = [];

		// Act - scan Kotlin file
		const result2 = await sastScan({ changed_files: ['test.kt'] }, tmpDir);

		// Assert - auto mode used
		expect(result2.summary.files_scanned).toBe(1);
		expect(mockRunSemgrepCalls.length).toBe(1);
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBe(true); // Auto mode
		expect(mockRunSemgrepCalls[0].lang).toBe('kotlin');
		expect(mockRunSemgrepCalls[0].files).toContain(kotlinFile);

		// Combined: Both buckets work correctly
		expect(result1.summary.files_scanned + result2.summary.files_scanned).toBe(
			2,
		);
	});

	it('Adversarial 8: Profile nativeRuleSet is empty string → Tier A runs (empty string !== null)', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.java');
		writeFileSync(testFile, 'public class Test {}');

		mockGetProfileForFileResult = {
			id: 'java',
			sast: { nativeRuleSet: '', semgrepSupport: 'ga' }, // Empty string, not null
		};

		mockExecuteRulesSyncResult = [
			{
				rule_id: 'java-rule',
				severity: 'medium',
				message: 'Java finding',
				location: { file: testFile, line: 1 },
			},
		];

		// Act
		const result = await sastScan({ changed_files: ['test.java'] }, tmpDir);

		// Assert - nativeRuleSet !== null means Tier A runs (even with empty string)
		expect(result.summary.files_scanned).toBe(1);
		expect(mockExecuteRulesSyncCalls.length).toBe(1); // Tier A called
		expect(mockExecuteRulesSyncCalls[0]).toBe('java');
		expect(mockRunSemgrepCalls.length).toBe(1); // Semgrep also called (local bucket)
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBeUndefined();
	});

	it('Adversarial 9: Semgrep returns duplicate findings matching Tier A → deduplication kicks in', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		// Tier A finding
		mockExecuteRulesSyncResult = [
			{
				rule_id: 'duplicate-rule',
				severity: 'high',
				message: 'Tier A finding',
				location: { file: testFile, line: 5 },
			},
		];

		// Semgrep returns exact duplicate finding
		mockRunSemgrepResult = {
			findings: [
				{
					rule_id: 'duplicate-rule',
					severity: 'high',
					message: 'Semgrep finding',
					location: { file: testFile, line: 5 },
				},
			],
			engine: 'tier_a+tier_b',
		};

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert - Deduplication should remove the duplicate
		expect(result.summary.files_scanned).toBe(1);
		expect(result.findings.length).toBe(1); // Only 1 finding (deduplicated)
		expect(result.findings[0].rule_id).toBe('duplicate-rule');
		expect(mockExecuteRulesSyncCalls.length).toBe(1);
		expect(mockRunSemgrepCalls.length).toBe(1);
	});

	it('Adversarial 10: MAX_FINDINGS cap → 150 findings → capped at 100', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};

		// Generate 150 findings from Tier A
		const tierAFindings = [];
		for (let i = 0; i < 150; i++) {
			tierAFindings.push({
				rule_id: `rule-${i}`,
				severity: 'medium',
				message: `Finding ${i}`,
				location: { file: testFile, line: 1 },
			});
		}
		mockExecuteRulesSyncResult = tierAFindings;

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert - Should cap at 100 findings (MAX_FINDINGS)
		expect(result.summary.files_scanned).toBe(1);
		expect(result.findings.length).toBe(100); // Capped
		expect(result.summary.findings_count).toBe(100);
	});
});
