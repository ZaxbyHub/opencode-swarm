/**
 * Verification tests for profile-driven SAST scan behavior
 * Testing Task 5.1 changes in src/tools/sast-scan.ts
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
		return mockExecuteRulesSyncResult;
	},
}));

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

describe('SAST Scan - Profile-Driven Behavior', () => {
	let tmpDir: string;

	beforeEach(() => {
		// Create a temp directory for test files
		tmpDir = mkdtempSync(join(tmpdir(), 'sast-test-'));

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

	it('Scenario 1: Feature flag disabled → returns pass with 0 files scanned', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir, {
			gates: { sast_scan: { enabled: false } },
		} as any);

		// Assert
		expect(result.verdict).toBe('pass');
		expect(result.findings).toEqual([]);
		expect(result.summary.files_scanned).toBe(0);
		expect(result.summary.engine).toBe('tier_a');
		expect(mockExecuteRulesSyncCalls.length).toBe(0);
		expect(mockRunSemgrepCalls.length).toBe(0);
	});

	it('Scenario 2: Kotlin file (nativeRuleSet=null, semgrepSupport=beta) → Tier A NOT called, Semgrep with auto mode', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.kt');
		writeFileSync(testFile, 'fun main() {}');

		mockGetProfileForFileResult = {
			id: 'kotlin',
			sast: { nativeRuleSet: null, semgrepSupport: 'beta' },
		};
		mockGetLanguageForExtResult = null;

		// Act
		const result = await sastScan({ changed_files: ['test.kt'] }, tmpDir);

		// Assert
		expect(result.verdict).toBe('pass');
		expect(result.summary.files_scanned).toBe(1);
		expect(mockExecuteRulesSyncCalls.length).toBe(0); // Tier A NOT called
		expect(mockRunSemgrepCalls.length).toBe(1);
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBe(true);
		expect(mockRunSemgrepCalls[0].lang).toBe('kotlin');
		expect(mockRunSemgrepCalls[0].files).toContain(testFile);
	});

	it('Scenario 3: TypeScript file (nativeRuleSet=javascript, semgrepSupport=ga) → Tier A called, Semgrep without auto', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};
		mockGetLanguageForExtResult = null;

		mockExecuteRulesSyncResult = [
			{
				rule_id: 'test-rule',
				severity: 'low',
				message: 'Test finding',
				location: { file: testFile, line: 1 },
			},
		];

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert
		expect(result.summary.files_scanned).toBe(1);
		expect(mockExecuteRulesSyncCalls.length).toBe(1); // Tier A called
		expect(mockExecuteRulesSyncCalls[0]).toBe('typescript');
		expect(mockRunSemgrepCalls.length).toBe(1);
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBeUndefined(); // No auto mode
		expect(mockRunSemgrepCalls[0].lang).toBeUndefined();
		expect(mockRunSemgrepCalls[0].files).toContain(testFile);
	});

	it('Scenario 4: Dart file (nativeRuleSet=null, semgrepSupport=none) → Tier A NOT called, Semgrep NOT called, file counted', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.dart');
		writeFileSync(testFile, 'void main() {}');

		mockGetProfileForFileResult = {
			id: 'dart',
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
		};
		mockGetLanguageForExtResult = null;

		// Act
		const result = await sastScan({ changed_files: ['test.dart'] }, tmpDir);

		// Assert
		expect(result.summary.files_scanned).toBe(1);
		expect(result.summary.engine).toBe('tier_a+tier_b');
		expect(mockExecuteRulesSyncCalls.length).toBe(0); // Tier A NOT called
		expect(mockRunSemgrepCalls.length).toBe(0); // Semgrep NOT called
	});

	it('Scenario 5: Unknown extension → file skipped, 0 files scanned', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.xyz');
		writeFileSync(testFile, 'some content');

		mockGetProfileForFileResult = null;
		mockGetLanguageForExtResult = null;

		// Act
		const result = await sastScan({ changed_files: ['test.xyz'] }, tmpDir);

		// Assert
		expect(result.summary.files_scanned).toBe(0);
		expect(mockExecuteRulesSyncCalls.length).toBe(0);
		expect(mockRunSemgrepCalls.length).toBe(0);
	});

	it('Scenario 6: Semgrep unavailable → runSemgrep NEVER called, Tier A findings returned', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.py');
		writeFileSync(testFile, 'print("hello")');

		mockSemgrepAvailable = false;
		mockGetProfileForFileResult = {
			id: 'python',
			sast: { nativeRuleSet: 'python', semgrepSupport: 'ga' },
		};
		mockGetLanguageForExtResult = null;

		mockExecuteRulesSyncResult = [
			{
				rule_id: 'python-rule',
				severity: 'medium',
				message: 'Python finding',
				location: { file: testFile, line: 1 },
			},
		];

		// Act
		const result = await sastScan({ changed_files: ['test.py'] }, tmpDir);

		// Assert
		expect(result.summary.engine).toBe('tier_a');
		expect(result.summary.files_scanned).toBe(1);
		expect(result.findings.length).toBe(1);
		expect(result.findings[0].rule_id).toBe('python-rule');
		expect(mockExecuteRulesSyncCalls.length).toBe(1);
		expect(mockRunSemgrepCalls.length).toBe(0); // Semgrep NOT called
	});

	it('Scenario 7: Semgrep throws → no crash, Tier A findings still returned', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.ts');
		writeFileSync(testFile, 'const x = 1;');

		mockRunSemgrepShouldThrow = true;
		mockGetProfileForFileResult = {
			id: 'typescript',
			sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
		};
		mockGetLanguageForExtResult = null;

		mockExecuteRulesSyncResult = [
			{
				rule_id: 'ts-rule',
				severity: 'high',
				message: 'TypeScript finding',
				location: { file: testFile, line: 1 },
			},
		];

		// Act
		const result = await sastScan({ changed_files: ['test.ts'] }, tmpDir);

		// Assert - no crash, Tier A findings returned
		expect(result.summary.files_scanned).toBe(1);
		expect(result.findings.length).toBe(1);
		expect(result.findings[0].rule_id).toBe('ts-rule');
		expect(mockExecuteRulesSyncCalls.length).toBe(1);
	});

	it('Scenario 8: Old registry fallback → getProfileForFile returns null, getLanguageForExtension returns python → Tier A with python, Semgrep bucket python', async () => {
		// Arrange
		const testFile = join(tmpDir, 'test.py');
		writeFileSync(testFile, 'print("hello")');

		mockGetProfileForFileResult = null; // No profile
		mockGetLanguageForExtResult = { id: 'python' }; // Old registry knows it

		mockExecuteRulesSyncResult = [
			{
				rule_id: 'old-registry-rule',
				severity: 'low',
				message: 'Old registry finding',
				location: { file: testFile, line: 1 },
			},
		];

		// Act
		const result = await sastScan({ changed_files: ['test.py'] }, tmpDir);

		// Assert
		expect(result.summary.files_scanned).toBe(1);
		expect(mockExecuteRulesSyncCalls.length).toBe(1); // Tier A called
		expect(mockExecuteRulesSyncCalls[0]).toBe('python');
		expect(mockRunSemgrepCalls.length).toBe(1);
		expect(mockRunSemgrepCalls[0].useAutoConfig).toBeUndefined(); // No auto mode for old registry
		expect(mockRunSemgrepCalls[0].lang).toBeUndefined();
		expect(mockRunSemgrepCalls[0].files).toContain(testFile);
	});
});
