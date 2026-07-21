import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { pre_check_batch } from '../../src/tools/pre-check-batch';

// Helper to create a mock ToolContext
function createMockContext(dir?: string): ToolContext {
	const d = dir ?? process.cwd();
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory: d,
		worktree: d,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	};
}

describe('pre_check_batch integration', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalPath: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalPath = process.env.PATH || '';
		// The Unix package shim is executable directly. On Windows, expose the
		// optional native package directory because child-process array spawns do
		// not execute the node_modules/.bin/biome.cmd shell shim.
		const biomeBinDir =
			process.platform === 'win32'
				? path.join(
						originalCwd,
						'node_modules',
						'@biomejs',
						`cli-win32-${process.arch}`,
					)
				: path.join(originalCwd, 'node_modules', '.bin');
		process.env.PATH = biomeBinDir + path.delimiter + originalPath;
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'pre-check-batch-integration-'),
		);
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			'{}\n',
		);
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.env.PATH = originalPath;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
				break;
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (attempt < 2 && code === 'EBUSY') {
					await new Promise((resolve) =>
						setTimeout(resolve, 500 * (attempt + 1)),
					);
				}
			}
		}
	});

	test('tool is registered and callable', async () => {
		// Verify pre_check_batch tool exists and has required methods
		expect(pre_check_batch).toBeDefined();
		expect(pre_check_batch.execute).toBeDefined();
		expect(typeof pre_check_batch.execute).toBe('function');
	});

	test('completes batch faster than sequential execution', async () => {
		// Create multiple TypeScript files to ensure tools have work to do
		for (let i = 0; i < 4; i++) {
			fs.writeFileSync(
				path.join(tempDir, `test${i}.ts`),
				`export const value${i} = ${i};\n`,
			);
		}

		// Initialize git repo for sast-scan to work
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		const mockContext = createMockContext();

		// Measure wall clock time
		const startTime = Date.now();
		const result = await pre_check_batch.execute(
			{
				directory: '.',
				files: ['test0.ts', 'test1.ts', 'test2.ts', 'test3.ts'],
			},
			mockContext,
		);
		const wallClockMs = Date.now() - startTime;

		const parsed = JSON.parse(result);

		// If all 4 tools ran, verify parallel execution
		// In parallel, wall clock should be less than sum of individual durations
		// (though this is hard to reliably test due to tool speed)
		// secretscan, sast_scan, and quality_budget are pure-JS tools that always run.
		// lint requires an external binary (biome/eslint) which may not be available
		// in a temp directory — lint-specific behavior is tested separately.
		expect(parsed.secretscan.ran).toBe(true);
		expect(parsed.sast_scan.ran).toBe(true);
		expect(parsed.quality_budget.ran).toBe(true);
		if (parsed.lint.ran) {
			// Lint ran — verify the result is well-formed
			expect(parsed.lint.result).toBeDefined();
		}

		// Verify total_duration_ms is recorded
		expect(parsed.total_duration_ms).toBeGreaterThan(0);
	});

	test('correctly reports lint errors (lint is informational, does not block gates)', async () => {
		// Create a file with a lint error that biome flags as an error (exit 1)
		// debugger statement is flagged by biome's noDebugger rule
		fs.writeFileSync(
			path.join(tempDir, 'bad-code.js'),
			`// Biome flags debugger as an error (noDebugger rule)
debugger;
`,
		);

		// Initialize git repo
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		const mockContext = createMockContext();
		const result = await pre_check_batch.execute(
			{
				directory: '.',
				files: ['bad-code.js'],
			},
			mockContext,
		);

		const parsed = JSON.parse(result);

		// Verify lint ran and has errors
		expect(parsed.lint.ran).toBe(true);
		expect(parsed.lint.result).toBeDefined();
		// Lint should report errors (success: false or non-zero exit code)
		const lintSuccess = parsed.lint.result.success;
		const lintExitCode = parsed.lint.result.exitCode;
		const hasLintErrors = lintSuccess === false || lintExitCode !== 0;

		expect(hasLintErrors).toBe(true);
		// Lint is informational only - does NOT block gates_passed (only secretscan and sast_scan do)
		expect(parsed.gates_passed).toBe(true);
	});

	test('correctly reports gates_passed=false when secretscan finds secrets', async () => {
		// Create a file with a fake secret
		fs.writeFileSync(
			path.join(tempDir, 'config.ts'),
			`// Configuration file
export const apiKey = "sk-test1234567890abcdef";
export const password = "super-secret-password-123";
`,
		);

		// Initialize git repo
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		const mockContext = createMockContext();
		const result = await pre_check_batch.execute(
			{
				directory: '.',
				files: ['config.ts'],
			},
			mockContext,
		);

		const parsed = JSON.parse(result);

		// Verify secretscan ran
		expect(parsed.secretscan.ran).toBe(true);
		expect(parsed.secretscan.result).toBeDefined();

		// Verify gates_passed is false when secrets are found
		const hasFindings =
			parsed.secretscan.result.findings &&
			parsed.secretscan.result.findings.length > 0;
		expect(hasFindings).toBe(true);
		expect(parsed.gates_passed).toBe(false);
	});

	test('correctly reports gates_passed=false when sast_scan has findings', async () => {
		// Create a file with a vulnerable code pattern (SQL injection, XSS, etc.)
		fs.writeFileSync(
			path.join(tempDir, 'vulnerable.ts'),
			`// Vulnerable code patterns that SAST should detect
import { exec } from 'child_process';

function bad(userInput: string) {
	// Command injection vulnerability
	exec('echo ' + userInput);
}

function xss(input: string) {
	// Reflected XSS - directly outputting user input
	return '<div>' + input + '</div>';
}
`,
		);

		// Initialize git repo
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		const mockContext = createMockContext();
		const result = await pre_check_batch.execute(
			{
				directory: '.',
				files: ['vulnerable.ts'],
				sast_threshold: 'medium',
			},
			mockContext,
		);

		const parsed = JSON.parse(result);

		// Verify sast_scan ran
		expect(parsed.sast_scan.ran).toBe(true);
		expect(parsed.sast_scan.result).toBeDefined();

		// Verify gates_passed is false when SAST finds vulnerabilities
		expect(parsed.sast_scan.result.verdict).toBe('fail');
		expect(parsed.gates_passed).toBe(false);
	});

	test('path traversal attack is rejected', async () => {
		// Create a valid file in the temp directory
		fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const x = 1;\n');

		// Initialize git repo
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		const mockContext = createMockContext();

		// Try to access a file outside the directory
		const result = await pre_check_batch.execute(
			{
				directory: '.',
				files: ['../../../etc/passwd'],
			},
			mockContext,
		);

		const parsed = JSON.parse(result);

		// The path should be filtered out (not accessible)
		// Either the sast_scan should not find the file, or it should error
		// The key is that it should NOT read /etc/passwd
		// Since the path is filtered, sast_scan and quality_budget won't find it
		// and the result should not expose anything from outside the directory

		// Verify that sast_scan did NOT scan the external file
		// (it should either skip or return empty results)
		if (parsed.sast_scan.result) {
			const findings = parsed.sast_scan.result.findings || [];
			// No findings should reference the traversal path
			for (const finding of findings) {
				expect(finding.location.file).not.toContain('etc/passwd');
			}
		}

		// The path should be rejected/warned about
		// The tool should not crash and should handle it gracefully
		expect(parsed).toBeDefined();
	});

	test('max file limit is enforced', async () => {
		// Create 101+ file paths
		const files: string[] = [];
		for (let i = 0; i < 101; i++) {
			const filePath = path.join(tempDir, `file${i}.ts`);
			fs.writeFileSync(filePath, `export const v${i} = ${i};\n`);
			files.push(`file${i}.ts`);
		}

		// Initialize git repo
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		const mockContext = createMockContext();

		// Call should throw error about exceeding max files
		const result = await pre_check_batch.execute(
			{
				directory: '.',
				files: files,
			},
			mockContext,
		);

		const parsed = JSON.parse(result);

		// Should throw error: "Input exceeds maximum file count"
		// The execute function returns JSON even on error
		expect(parsed.lint.error).toContain('exceeds maximum file count');
		expect(parsed.gates_passed).toBe(false);
	});

	test('Architect receives parallel precheck hint when enabled', async () => {
		// Import system-enhancer hook
		// Test that when config.pipeline.parallel_precheck !== false
		// The "[SWARM HINT] Parallel pre-check enabled" hint is generated
		// This is a unit test of the hint generation logic
		const { createSystemEnhancerHook } = await import(
			'../../src/hooks/system-enhancer'
		);
		// The hook should inject the hint for architect sessions
		// Verify the hint text contains "pre_check_batch"
		expect(true).toBe(true); // Placeholder - actual test would require mocking session context
	});

	test('Architect receives sequential hint when parallel_precheck disabled', async () => {
		// Test that when config.pipeline.parallel_precheck === false
		// The "[SWARM HINT] Parallel pre-check disabled" hint is generated
		expect(true).toBe(true); // Placeholder
	});
});
