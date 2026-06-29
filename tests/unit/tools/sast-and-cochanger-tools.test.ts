/**
 * Verification tests for sast_scan and co_change_analyzer tools
 * Tests that tools migrated to use createSwarmTool have correct directory injection behavior
 *
 * Key tests:
 * - When called with ctx = { directory: '/project' }, underlying function receives '/project'
 * - When called with ctx = undefined, underlying function receives process.cwd()
 * - Args/options are passed through correctly
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// ===== MOCK TRACKERS =====

// Track calls to sastScan
const sastScanCalls: Array<{ input: unknown; directory: string }> = [];

// Track calls to detectDarkMatter
const detectDarkMatterCalls: Array<{ directory: string; options: unknown }> =
	[];

// ===== MOCK saveEvidence =====
mock.module('../../../src/evidence/manager', () => ({
	saveEvidence: mock().mockImplementation(async () => undefined),
}));

// ===== MOCK sast-scan module =====
// We need to preserve the tool definition while tracking sastScan calls
const originalSastScanModule = await import('../../../src/tools/sast-scan');

const mockSastScan = async (
	input: unknown,
	directory: string,
	config?: unknown,
) => {
	// Track the call
	sastScanCalls.push({ input, directory });
	// Return a default result
	return {
		verdict: 'pass' as const,
		findings: [],
		summary: {
			engine: 'tier_a' as const,
			files_scanned: 0,
			findings_count: 0,
			findings_by_severity: {
				critical: 0,
				high: 0,
				medium: 0,
				low: 0,
			},
		},
	};
};

// Mock the entire module
mock.module('../../../src/tools/sast-scan', () => ({
	...originalSastScanModule,
	sastScan: mockSastScan,
}));

// ===== MOCK co-change-analyzer module =====
const originalCoChangeModule = await import(
	'../../../src/tools/co-change-analyzer'
);

const mockDetectDarkMatter = async (directory: string, options?: unknown) => {
	// Track the call
	detectDarkMatterCalls.push({ directory, options });
	// Return empty array by default
	return [];
};

// Mock the entire module
mock.module('../../../src/tools/co-change-analyzer', () => ({
	...originalCoChangeModule,
	detectDarkMatter: mockDetectDarkMatter,
}));

// ===== MOCK semgrep module =====
mock.module('../../../src/sast/semgrep', () => ({
	isSemgrepAvailable: mock(() => false),
	runSemgrep: mock().mockImplementation(async () => ({
		available: false,
		findings: [],
		engine: 'tier_a',
	})),
	resetSemgrepCache: mock(),
}));

import { co_change_analyzer } from '../../../src/tools/co-change-analyzer';
// ===== IMPORT TOOLS AFTER MOCKS =====
// Re-import to get the mocked versions
import { sast_scan } from '../../../src/tools/sast-scan';

describe('sast_scan tool directory injection verification', () => {
	beforeEach(() => {
		// Clear call trackers
		sastScanCalls.length = 0;
		detectDarkMatterCalls.length = 0;
	});

	describe('When ctx provides directory', () => {
		it('should pass ctx.directory to sastScan function', async () => {
			const testDirectory = '/test/project';
			const args = {
				directory: testDirectory,
				changed_files: ['src/test.js'],
				severity_threshold: 'medium' as const,
			};

			const result = await sast_scan.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			expect(sastScanCalls[0].directory).toBe(testDirectory);

			// Verify of input passed to sastScan
			const inputArg = sastScanCalls[0].input;
			expect(inputArg).toEqual({
				changed_files: ['src/test.js'],
				severity_threshold: 'medium',
			});
		});

		it('should pass severity_threshold correctly', async () => {
			const testDirectory = '/test/project';
			const args = {
				directory: testDirectory,
				changed_files: ['src/test.js'],
				severity_threshold: 'critical' as const,
			};

			await sast_scan.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			const inputArg = sastScanCalls[0].input as { severity_threshold: string };
			expect(inputArg.severity_threshold).toBe('critical');
		});

		it('should pass changed_files correctly', async () => {
			const testDirectory = '/test/project';
			const args = {
				directory: testDirectory,
				changed_files: ['src/a.js', 'src/b.ts', 'test/c.test.ts'],
				severity_threshold: 'high' as const,
			};

			await sast_scan.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			const inputArg = sastScanCalls[0].input as { changed_files: string[] };
			expect(inputArg.changed_files).toEqual([
				'src/a.js',
				'src/b.ts',
				'test/c.test.ts',
			]);
		});
	});

	describe('When ctx is undefined (fallback to process.cwd)', () => {
		it('should use process.cwd() as directory', async () => {
			const args = {
				directory: '/some/dir', // Tool requires directory in args
				changed_files: ['src/test.js'],
				severity_threshold: 'medium' as const,
			};

			const expectedCwd = process.cwd();

			await sast_scan.execute(args, undefined as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			expect(sastScanCalls[0].directory).toBe(expectedCwd);
		});

		it('should still pass args correctly with fallback directory', async () => {
			const args = {
				directory: '/some/dir', // Tool requires directory in args
				changed_files: ['src/test.js'],
				severity_threshold: 'low' as const,
			};

			await sast_scan.execute(args, undefined as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			const inputArg = sastScanCalls[0].input as {
				changed_files: string[];
				severity_threshold: string;
			};
			expect(inputArg.changed_files).toEqual(['src/test.js']);
			expect(inputArg.severity_threshold).toBe('low');
		});
	});

	describe('When ctx has no directory field (fallback to process.cwd)', () => {
		it('should use process.cwd() when ctx is empty object', async () => {
			const args = {
				directory: '/some/dir', // Tool requires directory in args
				changed_files: ['src/test.js'],
			};

			const expectedCwd = process.cwd();

			await sast_scan.execute(args, {} as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			expect(sastScanCalls[0].directory).toBe(expectedCwd);
		});
	});

	describe('Args with default values', () => {
		it('should use default severity_threshold when not provided', async () => {
			const testDirectory = '/test/project';
			const args = {
				directory: testDirectory,
				changed_files: ['src/test.js'],
			};

			await sast_scan.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			const inputArg = sastScanCalls[0].input as { severity_threshold: string };
			expect(inputArg.severity_threshold).toBe('medium'); // Default value
		});

		it('should default changed_files to empty array when not provided', async () => {
			const testDirectory = '/test/project';
			const args = {
				directory: testDirectory,
			};

			await sast_scan.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(sastScanCalls).toHaveLength(1);
			const inputArg = sastScanCalls[0].input as { changed_files: string[] };
			expect(inputArg.changed_files).toEqual([]);
		});
	});
});

describe('co_change_analyzer tool directory injection verification', () => {
	beforeEach(() => {
		// Clear call trackers
		sastScanCalls.length = 0;
		detectDarkMatterCalls.length = 0;
	});

	describe('When ctx provides directory', () => {
		it('should pass ctx.directory to detectDarkMatter function', async () => {
			const testDirectory = '/test/project';
			const args = {
				min_commits: 30,
				min_co_changes: 5,
				threshold: 0.7,
				max_commits: 600,
			};

			const result = await co_change_analyzer.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			expect(detectDarkMatterCalls[0].directory).toBe(testDirectory);

			// Verify of options passed to detectDarkMatter
			const optionsArg = detectDarkMatterCalls[0].options;
			expect(optionsArg).toEqual({
				minCommits: 30,
				minCoChanges: 5,
				npmiThreshold: 0.7,
				maxCommitsToAnalyze: 600,
			});
		});

		it('should pass min_commits option correctly', async () => {
			const testDirectory = '/test/project';
			const args = {
				min_commits: 50,
			};

			await co_change_analyzer.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			const optionsArg = detectDarkMatterCalls[0].options as Record<
				string,
				unknown
			>;
			expect(optionsArg.minCommits).toBe(50);
			expect(optionsArg.minCoChanges).toBeUndefined();
			expect(optionsArg.npmiThreshold).toBeUndefined();
			expect(optionsArg.maxCommitsToAnalyze).toBeUndefined();
		});

		it('should pass min_co_changes option correctly', async () => {
			const testDirectory = '/test/project';
			const args = {
				min_co_changes: 10,
			};

			await co_change_analyzer.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			const optionsArg = detectDarkMatterCalls[0].options as Record<
				string,
				unknown
			>;
			expect(optionsArg.minCoChanges).toBe(10);
		});

		it('should pass threshold option correctly (as npmiThreshold)', async () => {
			const testDirectory = '/test/project';
			const args = {
				threshold: 0.85,
			};

			await co_change_analyzer.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			const optionsArg = detectDarkMatterCalls[0].options as Record<
				string,
				unknown
			>;
			expect(optionsArg.npmiThreshold).toBe(0.85);
		});

		it('should pass max_commits option correctly (as maxCommitsToAnalyze)', async () => {
			const testDirectory = '/test/project';
			const args = {
				max_commits: 1000,
			};

			await co_change_analyzer.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			const optionsArg = detectDarkMatterCalls[0].options as Record<
				string,
				unknown
			>;
			expect(optionsArg.maxCommitsToAnalyze).toBe(1000);
		});
	});

	describe('When ctx is undefined (fallback to process.cwd)', () => {
		it('should use process.cwd() as directory', async () => {
			const args = {
				min_commits: 20,
			};

			const expectedCwd = process.cwd();

			await co_change_analyzer.execute(args, undefined as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			expect(detectDarkMatterCalls[0].directory).toBe(expectedCwd);
		});

		it('should still pass options correctly with fallback directory', async () => {
			const args = {
				min_commits: 25,
				threshold: 0.6,
			};

			await co_change_analyzer.execute(args, undefined as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			const optionsArg = detectDarkMatterCalls[0].options as Record<
				string,
				unknown
			>;
			expect(optionsArg.minCommits).toBe(25);
			expect(optionsArg.npmiThreshold).toBe(0.6);
		});
	});

	describe('When ctx has no directory field (fallback to process.cwd)', () => {
		it('should use process.cwd() when ctx is empty object', async () => {
			const args = {};

			const expectedCwd = process.cwd();

			await co_change_analyzer.execute(args, {} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			expect(detectDarkMatterCalls[0].directory).toBe(expectedCwd);
		});
	});

	describe('Options with default values', () => {
		it('should use defaults when no options provided', async () => {
			const testDirectory = '/test/project';
			const args = {};

			await co_change_analyzer.execute(args, {
				directory: testDirectory,
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(1);
			const optionsArg = detectDarkMatterCalls[0].options as Record<
				string,
				unknown
			>;
			// All options should be undefined (will use internal defaults)
			expect(optionsArg.minCommits).toBeUndefined();
			expect(optionsArg.minCoChanges).toBeUndefined();
			expect(optionsArg.npmiThreshold).toBeUndefined();
			expect(optionsArg.maxCommitsToAnalyze).toBeUndefined();
		});
	});

	describe('Multiple tool calls receive correct directories', () => {
		it('should handle multiple calls with different directories', async () => {
			const expectedCwd = process.cwd();

			// First call with explicit directory
			await co_change_analyzer.execute({ min_commits: 20 }, {
				directory: '/dir1',
			} as unknown as any);

			// Second call with no context (fallback)
			await co_change_analyzer.execute(
				{ min_commits: 30 },
				undefined as unknown as any,
			);

			// Third call with different directory
			await co_change_analyzer.execute({ min_commits: 40 }, {
				directory: '/dir3',
			} as unknown as any);

			expect(detectDarkMatterCalls).toHaveLength(3);
			expect(detectDarkMatterCalls[0].directory).toBe('/dir1');
			expect(detectDarkMatterCalls[1].directory).toBe(expectedCwd);
			expect(detectDarkMatterCalls[2].directory).toBe('/dir3');
		});
	});
});
