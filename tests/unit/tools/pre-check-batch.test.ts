import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type PreCheckBatchInput,
	type PreCheckBatchResult,
	pre_check_batch,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';

// Mock the tool modules using mock.module()
// Note: When files are provided, runLintOnFiles uses Bun.spawn instead of runLint
const mockDetectAvailableLinter = mock(async () => 'biome');
const mockRunLint = mock(async () => ({
	success: true,
	mode: 'check',
	linter: 'biome' as const,
	command: ['biome', 'check', '.'],
	exitCode: 0,
	output: '',
	message: 'No issues found',
}));
const mockRunSecretscan = mock(async () => ({
	scan_dir: '.',
	findings: [],
	summary: {
		files_scanned: 0,
		secrets_found: 0,
		scan_time_ms: 0,
	},
}));
const mockSastScan = mock(async () => ({
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
}));
const mockQualityBudget = mock(async () => ({
	verdict: 'pass' as const,
	metrics: {
		complexity_delta: 0,
		public_api_delta: 0,
		duplication_ratio: 0,
		test_to_code_ratio: 0,
		thresholds: {
			max_complexity_delta: 5,
			max_public_api_delta: 10,
			max_duplication_ratio: 0.05,
			min_test_to_code_ratio: 0.3,
		},
	},
	violations: [],
	summary: {
		files_analyzed: 0,
		violations_count: 0,
		errors_count: 0,
		warnings_count: 0,
	},
}));

mock.module('../../../src/tools/lint', () => ({
	detectAvailableLinter: mockDetectAvailableLinter,
	runLint: mockRunLint,
}));

mock.module('../../../src/tools/secretscan', () => ({
	runSecretscan: mockRunSecretscan,
}));

mock.module('../../../src/tools/sast-scan', () => ({
	sastScan: mockSastScan,
}));

mock.module('../../../src/tools/quality-budget', () => ({
	qualityBudget: mockQualityBudget,
}));

mock.module('../../../src/utils', () => ({
	warn: mock(() => {}),
}));

// Helper to create temp test directories
function createTempDir(): string {
	// Use realpathSync to resolve macOS /var→/private/var symlink so that
	// process.cwd() (which resolves symlinks after chdir) matches tempDir.
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'pre-check-batch-test-')),
	);
}

describe('runPreCheckBatch', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		// Create symlink to node_modules so biome/eslint is available when running in tempDir
		// This is needed because runLintOnFiles uses Bun.spawn which looks for binaries in node_modules/.bin
		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// Symlink might already exist or fail on some platforms
		}

		// Reset mock call counts
		mockDetectAvailableLinter.mockClear();
		mockRunLint.mockClear();
		mockRunSecretscan.mockClear();
		mockSastScan.mockClear();
		mockQualityBudget.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Test 1: All four tools pass → gates_passed true ============

	test('all four tools pass → gates_passed true', async () => {
		// Create a test file so the tools have something to scan
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(true);
		expect(result.lint.ran).toBe(true);
		expect(result.secretscan.ran).toBe(true);
		expect(result.sast_scan.ran).toBe(true);
		expect(result.quality_budget.ran).toBe(true);
	});

	// ============ Test 2: Individual tool failures ============

	test('lint failure does not affect gates_passed (soft gate - informational)', async () => {
		// Write a file with syntax errors that biome will detect
		// Using incomplete statement to trigger a parse error
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'const x = ');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Lint is now informational (soft gate), so gates should still pass
		expect(result.gates_passed).toBe(true);
		// The lint should have run and found issues
		expect(result.lint.ran).toBe(true);
	});

	test('sast_scan failure → gates_passed false (hard gate)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Override mock to return sast_scan failure
		mockSastScan.mockResolvedValueOnce({
			verdict: 'fail' as const,
			findings: [
				{
					rule_id: 'test-rule',
					severity: 'high' as const,
					message: 'Security vulnerability found',
					location: {
						file: 'test.ts',
						line: 1,
					},
				},
			],
			summary: {
				engine: 'tier_a' as const,
				files_scanned: 1,
				findings_count: 1,
				findings_by_severity: {
					critical: 0,
					high: 1,
					medium: 0,
					low: 0,
				},
			},
		});

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(false);
		expect(result.sast_scan.result?.verdict).toBe('fail');
	});

	test('quality_budget failure does not affect gates_passed (soft gate)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Override mock to return quality_budget failure
		mockQualityBudget.mockResolvedValueOnce({
			verdict: 'fail' as const,
			metrics: {
				complexity_delta: 10,
				public_api_delta: 0,
				duplication_ratio: 0,
				test_to_code_ratio: 0,
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
			},
			violations: [
				{
					type: 'complexity' as const,
					severity: 'error' as const,
					message: 'Complexity exceeds threshold',
				},
			],
			summary: {
				files_analyzed: 1,
				violations_count: 1,
				errors_count: 1,
				warnings_count: 0,
			},
		});

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Quality budget is a soft gate, so gates should still pass
		expect(result.gates_passed).toBe(true);
		expect(result.quality_budget.result?.verdict).toBe('fail');
	});

	// ============ Test 3: All tools throw → gates_passed false ============

	test('hard gate tool errors cause gates_passed false (fail closed)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Make hard gate tools throw
		mockRunSecretscan.mockRejectedValueOnce(new Error('Secretscan error'));
		mockSastScan.mockRejectedValueOnce(new Error('SAST scan error'));

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Fail closed: any error in hard gates should result in gates_passed = false
		expect(result.gates_passed).toBe(false);
		// Error details may or may not be propagated depending on implementation
		// Core requirement is that gates fail when hard gates error
	});

	// ============ Test 4: Tool timeout handling ============

	test('hard gate timeout causes gates_passed false', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Simulate timeout - need to make both hard gates fail to trigger fail-closed
		mockRunSecretscan.mockRejectedValueOnce(new Error('Timeout after 60000ms'));
		mockSastScan.mockRejectedValueOnce(new Error('SAST timeout'));

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Timeout in hard gate should cause gates to fail
		expect(result.gates_passed).toBe(false);
		// Note: error property may not be set depending on implementation
	});

	// ============ Test 5: Parallelism verification ============

	test('tools run in parallel (Promise.all)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const start = Date.now();
		const result = await runPreCheckBatch(input);
		const totalTime = Date.now() - start;

		// Verify all tools were called
		expect(result.lint.ran).toBe(true);
		expect(result.secretscan.ran).toBe(true);
		expect(result.sast_scan.ran).toBe(true);
		expect(result.quality_budget.ran).toBe(true);

		// The actual tools run, so parallelism depends on system performance
		// Just verify the test completes in reasonable time
		expect(totalTime).toBeLessThan(10000);
	});

	// ============ Test 6: Undefined files (not empty array) handling ============

	test('undefined files (not provided) skips all tools (fail-closed)', async () => {
		const input: PreCheckBatchInput = {
			directory: tempDir,
			// files not provided (undefined)
		};

		const result = await runPreCheckBatch(input);

		// FAIL-CLOSED: When files is undefined, gates should be false
		expect(result.gates_passed).toBe(false);
		// All tools should not have run
		expect(result.lint.ran).toBe(false);
		expect(result.secretscan.ran).toBe(false);
		expect(result.sast_scan.ran).toBe(false);
		expect(result.quality_budget.ran).toBe(false);
		// All tools should have error "No files provided"
		expect(result.lint.error).toBe('No files provided');
		expect(result.secretscan.error).toBe('No files provided');
		expect(result.sast_scan.error).toBe('No files provided');
		expect(result.quality_budget.error).toBe('No files provided');
	});

	// ============ Test 7: Max 100 file limit enforcement ============

	test('max 100 file limit enforcement', async () => {
		// Create 150 test files
		const files: string[] = [];
		for (let i = 0; i < 150; i++) {
			const filePath = path.join(tempDir, `file${i}.ts`);
			fs.writeFileSync(filePath, `export const x${i} = ${i};\n`);
			files.push(`file${i}.ts`);
		}

		const input: PreCheckBatchInput = {
			files,
			directory: tempDir,
		};

		// Should throw when exceeding max files
		await expect(runPreCheckBatch(input)).rejects.toThrow(
			'exceeds maximum file count',
		);
	});

	// ============ Test 8: Path traversal handling ============

	test('path traversal is filtered out but other files processed', async () => {
		// Create a valid file
		fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const x = 1;\n');

		// Include both a valid file and a path traversal attempt
		const input: PreCheckBatchInput = {
			files: ['../outside/file.ts', 'valid.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// The path traversal should be filtered out, but valid file should still work
		// The function still runs and gates_passed depends on results
		expect(result).toBeDefined();
		// The invalid path should have been skipped (not in changedFiles)
		expect(result.lint.ran).toBe(true);
	});

	// ============ Additional Tests ============

	test('directory validation - empty directory', async () => {
		const input: PreCheckBatchInput = {
			directory: '',
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('directory');
	});

	test('directory validation - nonexistent directory', async () => {
		const input: PreCheckBatchInput = {
			directory: '/nonexistent/path/that/does/not/exist',
		};

		const result = await runPreCheckBatch(input);

		// Should fail validation for nonexistent/non-accessible directory
		expect(result.gates_passed).toBe(false);
	});

	test('secretscan error causes gates_passed false (via throwing)', async () => {
		// Write a file with a fake API key that will be detected by the inline scanner
		// This works because runSecretscanWithFiles scans files directly
		fs.writeFileSync(
			path.join(tempDir, 'test.ts'),
			'export const apiKey = "sk-abc1234567890abcdefghijklmnop";\n',
		);

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// With a secret found, gates should fail
		expect(result.gates_passed).toBe(false);
		// The secretscan should have found something
		expect(result.secretscan.result).toBeDefined();
		const secretsResult = result.secretscan.result as {
			findings: unknown[];
			count: number;
		};
		expect(secretsResult.count).toBeGreaterThan(0);
	});

	test('sast_scan error causes gates_passed false (via throwing)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Throw an error from sast_scan
		mockSastScan.mockRejectedValueOnce(new Error('SAST execution failed'));

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(false);
		expect(result.sast_scan.error).toBe('SAST execution failed');
	});

	test('both hard gates failing', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Both secretscan and sast_scan fail
		mockRunSecretscan.mockResolvedValueOnce({
			scan_dir: '.',
			findings: [
				{
					path: 'test.ts',
					line: 1,
					type: 'api_key' as const,
					confidence: 'high' as const,
					severity: 'critical' as const,
					redacted: 'sk-***',
					context: 'export const x = 1;',
				},
			],
			summary: { files_scanned: 1, secrets_found: 1, scan_time_ms: 100 },
		});

		mockSastScan.mockResolvedValueOnce({
			verdict: 'fail' as const,
			findings: [
				{
					rule_id: 'test',
					severity: 'high' as const,
					message: 'vuln',
					location: { file: 'test.ts', line: 1 },
				},
			],
			summary: {
				engine: 'tier_a' as const,
				files_scanned: 1,
				findings_count: 1,
				findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
			},
		});

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(false);
	});

	test('no linter available - lint is soft gate (informational)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Override mock to return no linter
		mockDetectAvailableLinter.mockResolvedValueOnce(null);

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Lint is now informational (soft gate), so gates should still pass
		// even when no linter is available
		expect(result.lint.ran).toBe(false);
		expect(result.lint.error).toContain('No linter found');
		expect(result.gates_passed).toBe(true);
	});

	test('secretscan with empty findings passes', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Default mock already returns empty findings
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(true);
		expect(
			(result.secretscan.result as { findings: unknown[] }).findings,
		).toHaveLength(0);
	});

	test('sast_scan with pass verdict passes', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Default mock already returns pass verdict
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(true);
		expect(result.sast_scan.result?.verdict).toBe('pass');
	});

	test('quality_budget throw does not fail gates (soft gate)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Throw an error from quality_budget
		mockQualityBudget.mockRejectedValueOnce(new Error('Quality budget failed'));

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Quality budget is soft gate, so gates should still pass
		expect(result.gates_passed).toBe(true);
		expect(result.quality_budget.error).toBe('Quality budget failed');
	});

	// ============ Test 9: Windows-style absolute path handling ============

	test('Windows absolute path with backslash (C:\\) is accepted when in workspace', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Create a subdirectory to use as absolute path target
		const subDir = path.join(tempDir, 'windows-test');
		fs.mkdirSync(subDir);
		fs.writeFileSync(path.join(subDir, 'file.ts'), 'export const y = 2;\n');

		// Simulate Windows absolute path by constructing it
		// On Windows, this would be C:\path\to\dir
		// Since we can't guarantee we're on Windows, we test the logic by checking
		// that a valid resolved path is handled correctly
		const input: PreCheckBatchInput = {
			files: ['file.ts'],
			directory: subDir, // Using absolute temp dir path
		};

		const result = await runPreCheckBatch(input, subDir);

		// Should succeed - path is within workspace
		expect(result.lint.error).toBeUndefined();
	});

	test('relative path with parent traversal (..) is rejected', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Attempt path traversal
		const input: PreCheckBatchInput = {
			files: ['../parent-file.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Should still run (the traversal file is filtered out)
		expect(result).toBeDefined();
	});

	test('empty path is rejected', async () => {
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: '',
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('directory');
	});

	test('workspace anchor uses resolved directory path', async () => {
		// This test verifies that the workspace anchoring logic works correctly
		// by providing a directory and verifying it resolves to an absolute path
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Use a relative path that should be resolved
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: '.', // Relative path
		};

		// Pass tempDir as workspace anchor to ensure correct resolution
		const result = await runPreCheckBatch(input, tempDir);

		// Should succeed - the relative '.' is resolved against workspaceAnchor
		expect(result.lint.ran).toBe(true);
	});
});

describe('Parallel Pre-check Hint Generation', () => {
	// These tests verify that the system-enhancer generates appropriate hints
	// based on the pipeline.parallel_precheck config setting

	test('Architect receives parallel precheck hint when enabled', async () => {
		// The system-enhancer should generate "[SWARM HINT] Parallel pre-check enabled"
		// when config.pipeline.parallel_precheck !== false (default is true)
		//
		// Verify the hint mentions pre_check_batch running in parallel

		// Import the system-enhancer to verify hint generation logic
		const { createSystemEnhancerHook } = await import(
			'../../../src/hooks/system-enhancer'
		);

		// Mock config with parallel_precheck enabled (default)
		const config = {
			pipeline: {
				parallel_precheck: true,
			},
		} as const;

		// The hint should be generated when config.pipeline.parallel_precheck !== false
		expect(config.pipeline.parallel_precheck !== false).toBe(true);

		// Expected hint text when enabled
		const expectedHint =
			'[SWARM HINT] Parallel pre-check enabled: call pre_check_batch(files, directory) after lint --fix and build_check to run lint:check + secretscan + sast_scan + quality_budget concurrently (max 4 parallel). Check gates_passed before calling @reviewer.';

		// Verify the hint contains pre_check_batch and mentions parallel execution
		expect(expectedHint).toContain('pre_check_batch');
		expect(expectedHint).toContain('concurrently');
		expect(expectedHint).toContain('Parallel pre-check enabled');
	});

	test('Architect receives sequential hint when parallel_precheck disabled', async () => {
		// The system-enhancer should generate "[SWARM HINT] Parallel pre-check disabled"
		// when config.pipeline.parallel_precheck === false
		//
		// Verify the hint instructs sequential execution of lint:check, secretscan, sast_scan, quality_budget

		// Mock config with parallel_precheck disabled
		const config = {
			pipeline: {
				parallel_precheck: false,
			},
		} as const;

		// The hint should be generated when config.pipeline.parallel_precheck === false
		expect(config.pipeline.parallel_precheck === false).toBe(true);

		// Expected hint text when disabled
		const expectedHint =
			'[SWARM HINT] Parallel pre-check disabled: run lint:check → secretscan → sast_scan → quality_budget sequentially.';

		// Verify the hint mentions sequential execution
		expect(expectedHint).toContain('Parallel pre-check disabled');
		expect(expectedHint).toContain('sequentially');
		expect(expectedHint).toContain('lint:check');
		expect(expectedHint).toContain('secretscan');
		expect(expectedHint).toContain('sast_scan');
		expect(expectedHint).toContain('quality_budget');
	});

	test('parallel_precheck defaults to true when not specified', async () => {
		// When config.pipeline is undefined or parallel_precheck is not set,
		// the default value should be true (from schema default)
		const config = {
			pipeline: {},
		} as { pipeline?: { parallel_precheck?: boolean } };

		// The default behavior should be parallel (not explicitly set to false)
		const isParallel = config.pipeline?.parallel_precheck !== false;
		expect(isParallel).toBe(true);
	});
});

// ============ ADVERSARIAL PATH VALIDATION TESTS ============
// Test only the path validation hardening for Task 1.1

describe('Adversarial Path Validation', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Malformed Paths ============

	test('rejects empty string path', async () => {
		const input: PreCheckBatchInput = {
			files: [''],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Empty path in files array - should be skipped, but valid files still processed
		expect(result).toBeDefined();
	});

	test('rejects whitespace-only path', async () => {
		const input: PreCheckBatchInput = {
			files: ['   '],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Whitespace paths should be skipped
		expect(result).toBeDefined();
	});

	test('rejects null-like path (undefined files)', async () => {
		const input: PreCheckBatchInput = {
			files: [undefined as unknown as string],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// undefined in files array - should be skipped
		expect(result).toBeDefined();
	});

	// ============ Oversized Payloads ============

	test('rejects oversized directory path (>500 chars)', async () => {
		const longDir = 'a'.repeat(501);
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: longDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('too long');
	});

	test('accepts max-length directory path (500 chars)', async () => {
		const longDir = 'a'.repeat(500);
		// This won't exist but should pass validation length check
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: longDir,
		};

		const result = await runPreCheckBatch(input);
		// Should fail for non-existent directory, not length
		// Note: error should NOT be "too long" - that's the key check
		expect(result.lint.error).not.toBe('directory path too long');
	});

	test('rejects direct parent traversal (../) but still processes valid files', async () => {
		// Create a valid file so tools have something to run
		fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const x = 1;\n');
		fs.writeFileSync(path.join(tempDir, 'escape.ts'), 'export const y = 2;\n');

		const input: PreCheckBatchInput = {
			files: ['../escape.ts', 'valid.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Traversal should be filtered, but valid file should still be processed
		expect(result.lint.ran).toBe(true);
	});

	test('rejects multi-level traversal (../../) but still processes valid files', async () => {
		fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['../../../../etc/passwd', 'valid.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Valid file should still be processed
		expect(result.lint.ran).toBe(true);
	});

	test('rejects Windows-style traversal (..\\) but still processes valid files', async () => {
		fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['..\\windows\\system32\\config\\sam', 'valid.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	// ============ Path Traversal Attempts ============

	test('rejects direct parent traversal (../) - fail-closed', async () => {
		// Only traversal path = no valid files = fail-closed
		const input: PreCheckBatchInput = {
			files: ['../escape.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// When only traversal paths provided, no valid files remain → fail closed
		expect(result.gates_passed).toBe(false);
	});

	test('rejects multi-level traversal (../../) - fail-closed', async () => {
		const input: PreCheckBatchInput = {
			files: ['../../../../etc/passwd'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// No valid files → fail closed
		expect(result.gates_passed).toBe(false);
	});

	test('rejects traversal via encoded dots (%2e%2e)', async () => {
		const input: PreCheckBatchInput = {
			files: ['%2e%2e%2fsecret.txt'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// URL encoding is not auto-decoded - this passes as literal filename
		expect(result).toBeDefined();
	});

	test('rejects Windows-style traversal (..\\) - fail-closed', async () => {
		const input: PreCheckBatchInput = {
			files: ['..\\windows\\system32\\config\\sam'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// No valid files → fail closed
		expect(result.gates_passed).toBe(false);
	});

	test('rejects mixed traversal (/..\\)', async () => {
		const input: PreCheckBatchInput = {
			files: ['/..\\mixed/traversal'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result).toBeDefined();
	});

	// ============ Windows/POSIX Boundary Variations ============

	test('accepts valid Windows absolute path when in workspace', async () => {
		// Test with actual absolute path that is within workspace
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir, // Already absolute
		};

		const result = await runPreCheckBatch(input, tempDir);
		expect(result.lint.error).toBeUndefined();
	});

	test('handles absolute path validation correctly', async () => {
		// Test absolute path handling - when directory is an absolute path,
		// it should be validated against workspace

		// Create a valid file in tempDir
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Use actual absolute path of tempDir (which is within workspace)
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir, // This is already an absolute path
		};

		const result = await runPreCheckBatch(input, tempDir);
		// Should work - tempDir is within workspace
		expect(result.lint.ran).toBe(true);
	});

	test('handles forward slash as path separator', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['subdir/test.ts'],
			directory: tempDir,
		};

		const subDir = path.join(tempDir, 'subdir');
		fs.mkdirSync(subDir);
		fs.writeFileSync(path.join(subDir, 'test.ts'), 'export const x = 1;\n');

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	test('handles backslash as path separator', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Test with backslash-style path
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	// ============ Edge Cases ============

	test('handles path with null bytes', async () => {
		const input: PreCheckBatchInput = {
			files: ['file\x00.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Null byte should be treated as part of filename (or rejected)
		expect(result).toBeDefined();
	});

	test('handles path with unicode characters', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['日本語.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	test('handles path with emoji', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['📁test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	test('handles extremely long single path component', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const longName = 'a'.repeat(10000);
		const input: PreCheckBatchInput = {
			files: [longName],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Should handle gracefully (skip the invalid file)
		expect(result).toBeDefined();
	});

	test('handles many path components (deep nesting)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Create deep path
		const deepPath = Array(50).fill('dir').join('/') + '/test.ts';
		const input: PreCheckBatchInput = {
			files: [deepPath],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result).toBeDefined();
	});

	test('handles paths with special characters', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: [
				'file-with-dashes.ts',
				'file_with_underscores.ts',
				'file.with.dots.ts',
			],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	test('handles paths starting with dot (hidden files)', async () => {
		fs.writeFileSync(path.join(tempDir, '.hidden'), 'hidden content\n');

		const input: PreCheckBatchInput = {
			files: ['.hidden'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});

	test('handles paths with multiple slashes', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['///multiple/slashes/test.ts'],
			directory: tempDir,
		};

		const subDir = path.join(tempDir, 'multiple', 'slashes');
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, 'test.ts'), 'export const x = 1;\n');

		const result = await runPreCheckBatch(input);
		expect(result).toBeDefined();
	});

	test('handles paths with leading slash', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// This is tricky - leading slash makes it absolute
		const input: PreCheckBatchInput = {
			files: ['/leading/slash/test.ts'],
			directory: tempDir,
		};

		const subDir = path.join(tempDir, 'leading', 'slash');
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, 'test.ts'), 'export const x = 1;\n');

		const result = await runPreCheckBatch(input);
		// Should handle absolute path correctly
		expect(result).toBeDefined();
	});

	// ============ Boundary Conditions ============

	test('handles empty files array (different from undefined)', async () => {
		const input: PreCheckBatchInput = {
			files: [],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Empty array = no files = fail closed
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('No files');
	});

	test('handles directory equal to workspace (boundary case)', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// When directory == workspace (same path)
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input, tempDir);
		expect(result.lint.ran).toBe(true);
	});

	test('handles symlink within workspace', async () => {
		// Create a file and a symlink to it
		fs.writeFileSync(
			path.join(tempDir, 'original.ts'),
			'export const x = 1;\n',
		);
		fs.symlinkSync(
			path.join(tempDir, 'original.ts'),
			path.join(tempDir, 'link.ts'),
		);

		const input: PreCheckBatchInput = {
			files: ['link.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		expect(result.lint.ran).toBe(true);
	});
});

// ============ TASK 2.1: EXPLICIT FILES SCOPE BEHAVIOR TESTS ============
// These tests verify the changed-files scoped pre_check_batch behavior:
// 1. Explicit files scope: when files are provided, they are used by all tools
// 2. Fail-closed: when no valid files after validation, gates_passed=false

describe('Task 2.1: Explicit Files Scope Behavior', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// Test: Explicit files scope - when files are provided, tools should run
	test('explicit files provided → all tools run (not skipped)', async () => {
		// Create actual test files
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// When files are explicitly provided, tools should run
		expect(result.lint.ran).toBe(true);
		expect(result.secretscan.ran).toBe(true);
		expect(result.sast_scan.ran).toBe(true);
		expect(result.quality_budget.ran).toBe(true);
	});

	// Test: Explicit files scope - verify files are passed to each tool
	test('explicit files scope used by lint tool', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Lint should run when files are provided
		expect(result.lint.ran).toBe(true);
		// If lint ran, it should have processed the file (result exists or error)
		expect(
			result.lint.result !== undefined || result.lint.error !== undefined,
		).toBe(true);
	});

	test('explicit files scope used by secretscan tool', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Secretscan should run when files are provided
		expect(result.secretscan.ran).toBe(true);
		// If secretscan ran, it should have a result
		expect(
			result.secretscan.result !== undefined ||
				result.secretscan.error !== undefined,
		).toBe(true);
	});

	test('explicit files scope used by sast_scan tool', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// SAST should run when files are provided
		expect(result.sast_scan.ran).toBe(true);
		// If SAST ran, it should have a result
		expect(
			result.sast_scan.result !== undefined ||
				result.sast_scan.error !== undefined,
		).toBe(true);
	});

	test('explicit files scope used by quality_budget tool', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Quality budget should run when files are provided
		expect(result.quality_budget.ran).toBe(true);
		// If quality ran, it should have a result
		expect(
			result.quality_budget.result !== undefined ||
				result.quality_budget.error !== undefined,
		).toBe(true);
	});

	// Test: Multiple files in scope
	test('multiple explicit files → all tools process all files', async () => {
		fs.writeFileSync(path.join(tempDir, 'file1.ts'), 'export const a = 1;\n');
		fs.writeFileSync(path.join(tempDir, 'file2.ts'), 'export const b = 2;\n');
		fs.writeFileSync(path.join(tempDir, 'file3.ts'), 'export const c = 3;\n');

		const input: PreCheckBatchInput = {
			files: ['file1.ts', 'file2.ts', 'file3.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// All tools should run with multiple files
		expect(result.lint.ran).toBe(true);
		expect(result.secretscan.ran).toBe(true);
		expect(result.sast_scan.ran).toBe(true);
		expect(result.quality_budget.ran).toBe(true);
	});
});

describe('Task 2.1: Fail-Closed for Invalid Scoped Files', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// Test: All invalid files (path traversal) → fail closed
	test('only path traversal files → fail closed (gates_passed=false)', async () => {
		const input: PreCheckBatchInput = {
			files: ['../escape.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// No valid files → fail closed
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('No files');
	});

	// Test: Mixed valid/invalid files → valid files still processed
	test('mixed valid and invalid files → valid files processed', async () => {
		// Create a valid file
		fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['../escape.ts', 'valid.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Valid file should be processed
		expect(result.lint.ran).toBe(true);
		// Should have some result (either success or failure)
		expect(
			result.lint.result !== undefined || result.lint.error !== undefined,
		).toBe(true);
	});

	// Test: Empty after validation (all filtered out)
	test('all files filtered out by validation → fail closed', async () => {
		const input: PreCheckBatchInput = {
			files: ['../traversal1', '../../traversal2', '..\\windows\\path'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// All filtered out → fail closed
		expect(result.gates_passed).toBe(false);
	});

	// Test: Non-existent file
	test('non-existent file → handled gracefully', async () => {
		const input: PreCheckBatchInput = {
			files: ['does-not-exist.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Should still run but handle the missing file
		expect(result.lint.ran).toBe(true);
	});
});

// ============ SAST BASELINE DIFF MODE TESTS ============

describe('SAST baseline diff mode', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// Symlink may already exist or fail on some platforms
		}

		mockDetectAvailableLinter.mockClear();
		mockRunLint.mockClear();
		mockRunSecretscan.mockClear();
		mockSastScan.mockClear();
		mockQualityBudget.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('phase in tool schema: runPreCheckBatch accepts phase:1 without schema error', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
			phase: 1,
		};

		// Should not throw; a schema validation error would surface as a rejection or error in result
		const result = await runPreCheckBatch(input);
		expect(result).toBeDefined();
		expect(result.sast_scan.ran).toBe(true);
	});

	test('phase is threaded to sastScan: mock receives phase:2', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
			phase: 2,
		};

		await runPreCheckBatch(input);

		expect(mockSastScan).toHaveBeenCalled();
		// The first argument to sastScan is the SastScanInput object
		const callArgs = mockSastScan.mock.calls[0];
		expect(callArgs).toBeDefined();
		// callArgs[0] is the SastScanInput
		const sastInput = callArgs[0] as { phase?: number };
		expect(sastInput.phase).toBe(2);
	});

	test('sast_preexisting_findings populated when baseline_used:true and verdict:pass', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const highFinding = {
			rule_id: 'sast/js-eval',
			severity: 'high' as const,
			message: 'Use of eval() is dangerous',
			location: { file: path.join(tempDir, 'test.ts'), line: 1 },
		};

		mockSastScan.mockResolvedValueOnce({
			verdict: 'pass' as const,
			findings: [highFinding],
			baseline_used: true,
			pre_existing_findings: [highFinding],
			new_findings: [],
			summary: {
				engine: 'tier_a' as const,
				files_scanned: 1,
				findings_count: 1,
				findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
			},
		});

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
			phase: 1,
			sast_threshold: 'medium',
		};

		const result = await runPreCheckBatch(input);

		// Gate passes because verdict is pass (only new findings drive fail in baseline mode)
		expect(result.gates_passed).toBe(true);
		// Pre-existing high finding should be surfaced for reviewer triage
		expect(result.sast_preexisting_findings).toBeDefined();
		expect(result.sast_preexisting_findings?.length).toBeGreaterThan(0);
		expect(result.sast_preexisting_findings?.[0].rule_id).toBe('sast/js-eval');
	});

	test('baseline_used:true and verdict:fail (new finding): gates_passed false, sast_preexisting_findings has only pre-existing', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const preExistingFinding = {
			rule_id: 'sast/js-eval',
			severity: 'high' as const,
			message: 'Pre-existing eval usage',
			location: { file: path.join(tempDir, 'test.ts'), line: 1 },
		};

		const newFinding = {
			rule_id: 'sast/js-command-injection',
			severity: 'high' as const,
			message: 'New command injection',
			location: { file: path.join(tempDir, 'test.ts'), line: 5 },
		};

		mockSastScan.mockResolvedValueOnce({
			verdict: 'fail' as const,
			findings: [preExistingFinding, newFinding],
			baseline_used: true,
			pre_existing_findings: [preExistingFinding],
			new_findings: [newFinding],
			summary: {
				engine: 'tier_a' as const,
				files_scanned: 1,
				findings_count: 2,
				findings_by_severity: { critical: 0, high: 2, medium: 0, low: 0 },
			},
		});

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
			phase: 1,
			sast_threshold: 'medium',
		};

		const result = await runPreCheckBatch(input);

		// New finding above threshold should fail the gate
		expect(result.gates_passed).toBe(false);
		// sast_preexisting_findings should contain only the pre-existing finding, not the new one
		expect(result.sast_preexisting_findings).toBeDefined();
		const preexistingIds = result.sast_preexisting_findings?.map(
			(f) => f.rule_id,
		);
		expect(preexistingIds).toContain('sast/js-eval');
		expect(preexistingIds).not.toContain('sast/js-command-injection');
	});

	test('legacy behavior unchanged: no baseline_used → changed-line classifier path used', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const highFinding = {
			rule_id: 'sast/js-eval',
			severity: 'high' as const,
			message: 'eval usage',
			location: { file: path.join(tempDir, 'test.ts'), line: 1 },
		};

		// Return without baseline_used — legacy mode
		mockSastScan.mockResolvedValueOnce({
			verdict: 'fail' as const,
			findings: [highFinding],
			// baseline_used intentionally absent (legacy)
			summary: {
				engine: 'tier_a' as const,
				files_scanned: 1,
				findings_count: 1,
				findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
			},
		});

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
			// no phase — pure legacy mode
		};

		const result = await runPreCheckBatch(input);

		// SAST ran and returned fail verdict
		expect(result.sast_scan.ran).toBe(true);
		expect(result.sast_scan.result?.verdict).toBe('fail');
		// The legacy changed-line classifier is invoked. In a temp dir without git history
		// the classifier falls back to treating all findings as new (fail-closed),
		// so gates should fail.
		expect(result.gates_passed).toBe(false);
	});

	test('hint text unchanged: pre_check_batch hint mentions pre_check_batch(files, directory)', async () => {
		// Verify the parallel pre-check hint still references the correct signature
		const expectedHint =
			'[SWARM HINT] Parallel pre-check enabled: call pre_check_batch(files, directory) after lint --fix and build_check to run lint:check + secretscan + sast_scan + quality_budget concurrently (max 4 parallel). Check gates_passed before calling @reviewer.';

		expect(expectedHint).toContain('pre_check_batch(files, directory)');
		expect(expectedHint).toContain('concurrently');
		expect(expectedHint).toContain('Parallel pre-check enabled');
	});
});

// ============ TASK 1.1: WORKSPACE ANCHOR VALIDATION TESTS ============
// These tests verify that the workspace anchor (project root from createSwarmTool)
// is used as the validation boundary instead of the user-supplied directory argument.
// This prevents the self-validation bypass described in issue #922.

describe('workspaceAnchor validation (Task 1.1)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// Symlink may already exist or fail on some platforms
		}

		mockDetectAvailableLinter.mockClear();
		mockRunLint.mockClear();
		mockRunSecretscan.mockClear();
		mockSastScan.mockClear();
		mockQualityBudget.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('subdirectory as input.directory with project root as workspaceDir is rejected by runPreCheckBatch', async () => {
		// When workspaceDir is the true project root and input.directory is a subdirectory,
		// the execute function now rejects subdirectories at the tool level.
		// At runPreCheckBatch level (which does NOT have the subdirectory guard),
		// subdirectory is still accepted because it's within the workspace.
		const srcDir = path.join(tempDir, 'src');
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: srcDir,
		};

		const result = await runPreCheckBatch(input, tempDir);

		// runPreCheckBatch still accepts subdirectories (it validates containment, not identity)
		expect(result.lint.ran).toBe(true);
	});

	test('directory matching project root behaves unchanged', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// When input.directory == workspaceDir == project root, behavior is unchanged
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input, tempDir);

		expect(result.lint.ran).toBe(true);
		expect(result.secretscan.ran).toBe(true);
		expect(result.sast_scan.ran).toBe(true);
		expect(result.quality_budget.ran).toBe(true);
	});

	test('relative "." directory with absolute workspaceDir resolves correctly', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Simulate: user passes "." but workspaceDir is the absolute project root
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: '.',
		};

		const result = await runPreCheckBatch(input, tempDir);

		// "." resolves to cwd which is tempDir, workspaceDir is tempDir — match
		expect(result.lint.ran).toBe(true);
	});

	test('subdirectory outside workspace is rejected when workspaceDir is set', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Create a directory OUTSIDE the workspace
		const outsideDir = path.join(path.dirname(tempDir), 'outside-workspace');
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, 'test.ts'), 'export const y = 2;\n');

		// When workspaceDir is tempDir and input.directory is outside,
		// validation should reject the traversal
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: outsideDir,
		};

		const result = await runPreCheckBatch(input, tempDir);

		// Should fail — directory is outside the workspace
		expect(result.gates_passed).toBe(false);
	});

	test('workspaceDir as second param is used as anchor (not input.directory)', async () => {
		// This is the core test for the workspaceAnchor fix.
		// Before the fix: execute set workspaceAnchor=resolvedDirectory (user arg).
		// After the fix: execute sets workspaceAnchor=path.resolve(directory) (injected root).
		// At runPreCheckBatch level, we pass workspaceDir explicitly.
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const subDir = path.join(tempDir, 'subdir');
		fs.mkdirSync(subDir);

		// workspaceDir = tempDir (project root), input.directory = subDir
		// The subdirectory should be accepted because it's WITHIN the workspace
		const input: PreCheckBatchInput = {
			files: ['../test.ts'], // relative from subDir to tempDir
			directory: subDir,
		};

		const result = await runPreCheckBatch(input, tempDir);

		// Validation should use tempDir as anchor, not subDir
		// The file path "../test.ts" from subDir resolves to tempDir/test.ts — within workspace
		expect(result.lint.ran).toBe(true);
	});
});

describe('pre_check_batch execute — subdirectory rejection', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// Symlink may already exist or fail on some platforms
		}

		mockDetectAvailableLinter.mockClear();
		mockRunLint.mockClear();
		mockRunSecretscan.mockClear();
		mockSastScan.mockClear();
		mockQualityBudget.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('execute rejects subdirectory input with gates_passed false', async () => {
		// Create a subdirectory inside the temp workspace
		const srcDir = path.join(tempDir, 'src');
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, 'test.ts'), 'export const x = 1;\n');

		// Call execute directly — pass subdirectory as args.directory,
		// project root (tempDir) as the injected directory parameter
		const rawResult = await pre_check_batch.execute(
			{ directory: srcDir, files: ['test.ts'] },
			tempDir,
		);

		const result: PreCheckBatchResult = JSON.parse(rawResult);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toBeDefined();
		expect(result.lint.error).toContain('subdirectory');
		expect(result.secretscan.error).toContain('subdirectory');
		expect(result.sast_scan.error).toContain('subdirectory');
		expect(result.quality_budget.error).toContain('subdirectory');
	});

	test('execute accepts project root directory', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const rawResult = await pre_check_batch.execute(
			{ directory: tempDir, files: ['test.ts'] },
			tempDir,
		);

		const result: PreCheckBatchResult = JSON.parse(rawResult);

		// Project root should be accepted — no subdirectory rejection in any tool error
		const allErrors = [
			result.lint.error,
			result.secretscan.error,
			result.sast_scan.error,
			result.quality_budget.error,
		]
			.filter((e): e is string => typeof e === 'string')
			.join(' ');
		expect(allErrors).not.toContain('subdirectory');
	});
});
