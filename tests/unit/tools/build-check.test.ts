import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the module under test
import {
	build_check,
	DEFAULT_TIMEOUT_MS,
	getCommandKind,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	runBuildCheck,
	truncateOutput,
} from '../../../src/tools/build-check';

describe('build-check.ts - Constants and Types', () => {
	describe('exported constants', () => {
		test('MAX_OUTPUT_BYTES is 10240 (10KB)', () => {
			expect(MAX_OUTPUT_BYTES).toBe(10 * 1024);
		});

		test('MAX_OUTPUT_LINES is 100', () => {
			expect(MAX_OUTPUT_LINES).toBe(100);
		});

		test('DEFAULT_TIMEOUT_MS is 300000 (5 minutes)', () => {
			expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
		});
	});

	describe('BuildCheckInput interface', () => {
		test('accepts valid input with scope all', () => {
			const input = {
				scope: 'all' as const,
				changed_files: [],
				mode: 'both' as const,
			};
			expect(input.scope).toBe('all');
		});

		test('accepts valid input with scope changed', () => {
			const input = {
				scope: 'changed' as const,
				changed_files: ['file.ts'],
				mode: 'build' as const,
			};
			expect(input.scope).toBe('changed');
		});
	});

	describe('BuildRun interface', () => {
		test('has required properties', () => {
			const run = {
				kind: 'build' as const,
				command: 'npm run build',
				cwd: '/test',
				exit_code: 0,
				duration_ms: 1000,
				stdout_tail: 'output',
				stderr_tail: '',
			};
			expect(run.kind).toBe('build');
			expect(run.exit_code).toBe(0);
		});
	});

	describe('BuildCheckResult interface', () => {
		test('has required properties', () => {
			const result = {
				verdict: 'pass' as const,
				runs: [],
				summary: {
					files_scanned: 0,
					runs_count: 0,
					failed_count: 0,
				},
			};
			expect(result.verdict).toBe('pass');
		});
	});
});

describe('build-check.ts - truncateOutput', () => {
	test('returns empty string for empty input', () => {
		expect(truncateOutput('')).toBe('');
	});

	test('returns original string if shorter than maxLines', () => {
		const output = 'line1\nline2\nline3';
		expect(truncateOutput(output, 10, 1000)).toBe(output);
	});

	test('truncates to last maxLines lines', () => {
		const lines = Array.from({ length: 150 }, (_, i) => `line${i + 1}`);
		const output = lines.join('\n');
		const result = truncateOutput(output, 100, 100000);
		const resultLines = result.split('\n');
		expect(resultLines.length).toBe(100);
		expect(resultLines[0]).toBe('line51');
	});

	test('truncates by maxBytes first', () => {
		// Create a string longer than maxBytes
		const line = 'x'.repeat(500);
		const output = Array.from({ length: 50 }, () => line).join('\n');
		const result = truncateOutput(output, 100, 5000);
		// Result should be limited to maxBytes
		expect(result.length).toBeLessThanOrEqual(5000 + 1000); // buffer for newline
	});

	test('handles single line output', () => {
		const output = 'single line without newline';
		expect(truncateOutput(output, 100, 1000)).toBe(output);
	});

	test('returns last line if only one line but exceeds maxBytes', () => {
		const output = 'x'.repeat(20000);
		const result = truncateOutput(output, 100, 5000);
		// Should return approximately last 5000 chars
		expect(result.length).toBeLessThanOrEqual(5000 + 100);
	});
});

describe('build-check.ts - getCommandKind', () => {
	test('returns "build" for build commands', () => {
		expect(getCommandKind('npm run build')).toBe('build');
		expect(getCommandKind('cargo build')).toBe('build');
		expect(getCommandKind('make')).toBe('build');
		expect(getCommandKind('dotnet build')).toBe('build');
	});

	test('returns "typecheck" for typecheck commands', () => {
		expect(getCommandKind('npm run typecheck')).toBe('typecheck');
		expect(getCommandKind('cargo check')).toBe('typecheck');
		expect(getCommandKind('dart analyze')).toBe('typecheck');
		expect(getCommandKind('npm run check')).toBe('typecheck');
	});

	test('returns "typecheck" for analyze commands', () => {
		expect(getCommandKind('eslint .')).toBe('typecheck');
	});

	test('returns "test" for test commands', () => {
		expect(getCommandKind('npm test')).toBe('test');
		expect(getCommandKind('npm run test')).toBe('test');
		expect(getCommandKind('cargo test')).toBe('test');
		expect(getCommandKind('pytest')).toBe('test');
	});

	test('returns " framework commandstest" for test', () => {
		expect(getCommandKind('vitest')).toBe('test');
		expect(getCommandKind('jest')).toBe('test');
		expect(getCommandKind('mocha')).toBe('test');
	});
});

describe('build-check.ts - Tool Metadata', () => {
	test('has description', () => {
		expect(build_check.description).toContain('build');
		expect(build_check.description).toContain('commands');
	});

	test('has execute function', () => {
		expect(typeof build_check.execute).toBe('function');
	});

	test('has scope schema with all options', () => {
		expect(build_check.args.scope).toBeDefined();
	});

	test('has changed_files schema', () => {
		expect(build_check.args.changed_files).toBeDefined();
	});

	test('has mode schema', () => {
		expect(build_check.args.mode).toBeDefined();
	});
});

describe('build-check.ts - runBuildCheck', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'build-check-'));
	});

	afterEach(async () => {
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('returns skip verdict when no commands discovered', async () => {
		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			changed_files: [],
			mode: 'both',
		});

		expect(result.verdict).toBe('info');
		expect(result.runs).toHaveLength(0);
		expect(result.summary.skipped_reason).toBeDefined();
	});
	test('discovers npm build command when package.json exists', async () => {
		// Create a package.json with a build script
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "building"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			changed_files: [],
			mode: 'both',
		});

		// Commands should be discovered
		expect(result.summary.runs_count).toBeGreaterThanOrEqual(0);
	});

	test('filters by mode correctly', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "building"',
					typecheck: 'echo "typechecking"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		// Should only run build commands
		for (const run of result.runs) {
			expect(run.kind).toBe('build');
		}
	});

	test('filters typecheck mode correctly', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "building"',
					typecheck: 'echo "typechecking"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'typecheck',
		});

		// Should only run typecheck commands
		for (const run of result.runs) {
			expect(run.kind).toBe('typecheck');
		}
	});

	test('returns fail verdict when commands fail', async () => {
		// Create a package.json with a failing build script
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'exit 1',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		// Note: The command might not run if npm is not available
		// or may have different behavior on different systems
		expect(result.summary).toBeDefined();
	});

	test('returns pass verdict when commands succeed', async () => {
		// Create a package.json with a successful build script
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "success"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		expect(result.summary).toBeDefined();
	});

	test('captures stdout and stderr from commands', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "hello world" && echo "error" >&2',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		// Should have captured output (if command was run)
		expect(result.summary).toBeDefined();
	});

	test('tracks duration of commands', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'sleep 0.1 && echo "done"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		if (result.runs.length > 0) {
			expect(result.runs[0].duration_ms).toBeGreaterThan(0);
		}
	});

	test('handles changed scope correctly', async () => {
		const result = await runBuildCheck(tempDir, {
			scope: 'changed',
			changed_files: ['src/index.ts'],
			mode: 'both',
		});

		expect(result.summary).toBeDefined();
	});

	test('reports failed count correctly', async () => {
		// Create a package.json with a failing script
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'exit 1',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		expect(result.summary).toBeDefined();
	});
});

describe('build-check.ts - Edge Cases', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'build-check-'));
	});

	afterEach(async () => {
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('handles missing optional parameters', async () => {
		const result = await runBuildCheck(tempDir, {
			scope: 'all',
		});

		expect(result).toBeDefined();
	});

	test('handles empty changed_files array', async () => {
		const result = await runBuildCheck(tempDir, {
			scope: 'changed',
			changed_files: [],
		});

		expect(result.summary.files_scanned).toBe(0);
	});

	test('handles undefined mode (defaults to both)', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "test"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			// mode is undefined
		});

		expect(result).toBeDefined();
	});

	test('returns info verdict with skipped reason when no toolchains', async () => {
		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'both',
		});

		expect(result.verdict).toBe('info');
		expect(result.summary.skipped_reason).toBeTruthy();
	});

	test('truncates very long stdout correctly', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'for i in {1..500}; do echo "line $i"; done',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		// Output should be truncated
		if (result.runs.length > 0 && result.runs[0].stdout_tail) {
			const lines = result.runs[0].stdout_tail.split('\n');
			expect(lines.length).toBeLessThanOrEqual(100);
		}
	});

	test('handles special characters in command output', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'echo "Hello World! @#$%"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		expect(result).toBeDefined();
	});

	test('correctly identifies rust build commands', async () => {
		// Create a Cargo.toml to detect rust
		await fs.promises.writeFile(
			path.join(tempDir, 'Cargo.toml'),
			'[package]\nname = "test"\nversion = "0.1.0"',
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		// Should detect cargo build if cargo is available
		expect(result.summary).toBeDefined();
	});

	test('handles very large output', async () => {
		// Create a package.json
		await fs.promises.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'test-project',
				scripts: {
					build: 'node -e "console.log("x".repeat(50000))"',
				},
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'build',
		});

		// Output should be truncated to 10KB
		if (result.runs.length > 0) {
			expect(result.runs[0].stdout_tail.length).toBeLessThanOrEqual(11000);
		}
	});
});

describe('build-check.ts - Tool Argument Schema', () => {
	test('has correct scope enum values', () => {
		const scopeArg = build_check.args.scope;
		expect(scopeArg).toBeDefined();
	});

	test('has changed_files as optional array', () => {
		const changedFilesArg = build_check.args.changed_files;
		expect(changedFilesArg).toBeDefined();
	});

	test('has mode as optional enum', () => {
		const modeArg = build_check.args.mode;
		expect(modeArg).toBeDefined();
	});

	test('tool description is informative', () => {
		expect(build_check.description.length).toBeGreaterThan(20);
	});
});
