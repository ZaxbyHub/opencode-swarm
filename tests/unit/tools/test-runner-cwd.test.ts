/**
 * Tests for cwd threading fix in test-runner.ts
 *
 * These tests verify that the cwd (current working directory) parameter
 * is correctly threaded through:
 * 1. detectTestFramework(cwd) - uses cwd for all path joins
 * 2. runTests(..., cwd) - passes cwd to Bun.spawn
 * 3. execute() - extracts workingDir from ToolContext and passes it correctly
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the module under test
const testRunnerModule = await import('../../../src/tools/test-runner');

// Extract the exports we need
const { test_runner, detectTestFramework, runTests } = testRunnerModule;

// Helper to create temp test directories
function createTempDir(): string {
	// Use realpathSync to resolve macOS /var→/private/var symlink so that
	// process.cwd() (which resolves symlinks after chdir) matches tempDir.
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-cwd-')),
	);
}

// Helper to create test files
function createTestFile(
	dir: string,
	filename: string,
	content: string,
): string {
	const filePath = path.join(dir, filename);
	const parentDir = path.dirname(filePath);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

// Helper to parse JSON result
function parseResult(result: string): any {
	return JSON.parse(result);
}

// Mock for Bun.spawn
let originalSpawn: typeof Bun.spawn;
let spawnCalls: Array<{ cmd: string[]; opts: unknown }> = [];
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';

function mockSpawn(cmd: string[], opts: unknown) {
	spawnCalls.push({ cmd, opts });

	// Create mock readable streams
	const encoder = new TextEncoder();
	const stdoutReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStdout));
			controller.close();
		},
	});
	const stderrReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStderr));
			controller.close();
		},
	});

	return {
		stdout: stdoutReadable,
		stderr: stderrReadable,
		exited: Promise.resolve(mockExitCode),
		exitCode: mockExitCode,
		kill: () => {},
	} as unknown as ReturnType<typeof Bun.spawn>;
}

describe('test-runner.ts - CWD Threading', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = createTempDir();
		originalCwd = process.cwd();
		// Save original spawn
		originalSpawn = Bun.spawn;
		spawnCalls = [];
		mockExitCode = 0;
		mockStdout = '';
		mockStderr = '';
	});

	afterEach(() => {
		process.chdir(originalCwd);
		Bun.spawn = originalSpawn;
		// Cleanup temp dir
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('detectTestFramework(cwd) - bun detection', () => {
		test('uses provided cwd for path joins when detecting bun framework', async () => {
			// Create package.json in tempDir
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'bun test' },
				}),
			);
			createTestFile(tempDir, 'bun.lock', '');

			// Call with explicit cwd (tempDir)
			const framework = await detectTestFramework(tempDir);

			// Verify result
			expect(framework).toBe('bun');
		});

		test('uses cwd for bun.lockb detection', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'bun run test' },
				}),
			);
			// Create bun.lockb (empty file simulates it)
			createTestFile(tempDir, 'bun.lockb', '');

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('bun');
		});
	});

	describe('detectTestFramework(cwd) - pytest detection', () => {
		test('uses provided cwd for requirements.txt detection', async () => {
			createTestFile(
				tempDir,
				'requirements.txt',
				'pytest>=7.0.0\nrequests>=2.0.0',
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('pytest');
		});

		test('uses cwd for pyproject.toml detection', async () => {
			createTestFile(
				tempDir,
				'pyproject.toml',
				`
[tool.pytest.ini_options]
testpaths = ["tests"]
`,
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('pytest');
		});

		test('uses cwd for setup.cfg detection', async () => {
			createTestFile(
				tempDir,
				'setup.cfg',
				`
[pytest]
testpaths = tests
`,
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('pytest');
		});
	});

	describe('detectTestFramework() - fallback to none', () => {
		test('returns "none" when no config files exist in cwd', async () => {
			// tempDir is empty, so no framework should be detected
			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('none');
		});
	});

	describe('detectTestFramework(cwd) - cargo detection', () => {
		test('uses provided cwd for Cargo.toml detection', async () => {
			createTestFile(
				tempDir,
				'Cargo.toml',
				`
[package]
name = "test-rs"
version = "0.1.0"

[dev-dependencies]
tokio = { version = "1.0", features = ["full"] }
`,
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('cargo');
		});
	});

	describe('detectTestFramework(cwd) - pester detection', () => {
		test('uses provided cwd for pester config detection', async () => {
			createTestFile(tempDir, 'pester.config.ps1', 'configuration');

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('pester');
		});

		test('uses provided cwd for tests.ps1 detection', async () => {
			createTestFile(tempDir, 'tests.ps1', 'Describe "Tests" { }');

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('pester');
		});
	});

	describe('runTests cwd parameter', () => {
		test('passes cwd to Bun.spawn when provided', async () => {
			const fakeCwd = '/fake/cwd/for/runtests';
			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});

			// Set up mock spawn
			Bun.spawn = mockSpawn as any;

			await runTests('bun', 'all', [], false, 60000, fakeCwd);

			// Verify the cwd was passed correctly
			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(fakeCwd);
			expect(spawnCalls[0].cmd).toEqual(['bun', 'test']);
		});

		test('legacy Bun command avoids unsupported JSON reporter', async () => {
			const fakeCwd = '/fake/cwd/for/runtests';
			const priorBackend = process.env.SWARM_LANG_BACKEND;
			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			try {
				process.env.SWARM_LANG_BACKEND = 'legacy';
				await runTests('bun', 'all', [], false, 60000, fakeCwd);
			} finally {
				if (priorBackend === undefined) delete process.env.SWARM_LANG_BACKEND;
				else process.env.SWARM_LANG_BACKEND = priorBackend;
			}

			// Bun 1.3.x rejects --reporter=json before it runs any tests.
			expect(spawnCalls.length).toBeGreaterThan(0);
			expect(spawnCalls[0].cmd).toEqual(['bun', 'test']);
		});

		test('passes cwd to Bun.spawn for vitest framework', async () => {
			const fakeCwd = '/fake/vitest/project';
			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});

			Bun.spawn = mockSpawn as any;

			await runTests('vitest', 'all', [], false, 60000, fakeCwd);

			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(fakeCwd);
		});

		test('passes cwd to Bun.spawn for pytest framework', async () => {
			const fakeCwd = '/fake/pytest/project';
			mockStdout = '1 passed';

			Bun.spawn = mockSpawn as any;

			await runTests('pytest', 'all', [], false, 60000, fakeCwd);

			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(fakeCwd);
		});

		test('passes cwd to Bun.spawn for jest framework', async () => {
			const fakeCwd = '/fake/jest/project';
			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});

			Bun.spawn = mockSpawn as any;

			await runTests('jest', 'all', [], false, 60000, fakeCwd);

			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(fakeCwd);
		});

		test('passes cwd to Bun.spawn for mocha framework', async () => {
			const fakeCwd = '/fake/mocha/project';
			mockStdout = '1 passing';

			Bun.spawn = mockSpawn as any;

			await runTests('mocha', 'all', [], false, 60000, fakeCwd);

			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(fakeCwd);
		});

		test('passes cwd to Bun.spawn for cargo framework', async () => {
			const fakeCwd = '/fake/cargo/project';
			mockStdout = 'test result: ok. 1 passed';

			Bun.spawn = mockSpawn as any;

			await runTests('cargo', 'all', [], false, 60000, fakeCwd);

			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(fakeCwd);
		});

		test('extracts per-test cases from jest JSON output', async () => {
			const fakeCwd = '/fake/jest/project';
			mockStdout = JSON.stringify({
				testResults: [
					{
						name: '/fake/jest/project/src/foo.test.ts',
						assertionResults: [
							{
								fullName: 'foo suite passes',
								status: 'passed',
								duration: 12,
								failureMessages: [],
							},
							{
								fullName: 'foo suite fails',
								status: 'failed',
								duration: 8,
								failureMessages: [
									'Error: expected true to be false\n    at foo',
								],
							},
						],
					},
				],
				numTotalTests: 2,
				numPassedTests: 1,
				numFailedTests: 1,
				numPendingTests: 0,
			});

			Bun.spawn = mockSpawn as any;

			const result = await runTests('jest', 'all', [], false, 60000, fakeCwd);
			expect(result.success).toBe(false);
			expect(result.testCases).toBeDefined();
			expect(result.testCases?.length).toBe(2);
			expect(result.testCases?.[0].testName).toBe('foo suite passes');
			expect(result.testCases?.[1].result).toBe('fail');
		});

		test('extracts per-test cases from bun JSON-lines output', async () => {
			const fakeCwd = '/fake/bun/project';
			mockStdout = [
				'{"file":"src/a.test.ts","name":"a passes","status":"passed","durationMs":5}',
				'{"file":"src/a.test.ts","name":"a fails","status":"failed","durationMs":7,"error":{"message":"Error: boom","stack":"Error: boom\\n    at a"}}',
			].join('\n');

			Bun.spawn = mockSpawn as any;

			const result = await runTests('bun', 'all', [], false, 60000, fakeCwd);
			expect(result.testCases).toBeDefined();
			expect(result.testCases?.length).toBe(2);
			expect(result.testCases?.[0].result).toBe('pass');
			expect(result.testCases?.[1].errorMessage).toContain('Error: boom');
		});
	});

	describe('execute() ToolContext extraction', () => {
		test('uses ctx.directory as workingDir when provided', async () => {
			// Set up a real vitest project in tempDir so scope: 'convention' can run fully
			process.chdir(tempDir);
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
			createTestFile(
				tempDir,
				'src/utils.test.ts',
				'import {describe,test,expect} from "vitest"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
			);

			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			// Pass ctx.directory explicitly — createSwarmTool extracts ctx?.directory ?? process.cwd()
			await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{ directory: tempDir } as any,
			);

			// Verify cwd passed to spawn was ctx.directory (tempDir)
			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(tempDir);
		});

		test('ctx.worktree is NOT used as fallback — createSwarmTool only supports ctx.directory', async () => {
			// The createSwarmTool implementation is: const directory = ctx?.directory ?? process.cwd()
			// ctx.worktree is NOT consulted. When only worktree is provided, process.cwd() is used.
			process.chdir(tempDir);
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
			createTestFile(
				tempDir,
				'src/utils.test.ts',
				'import {describe,test,expect} from "vitest"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
			);

			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			// Provide only worktree (no directory) — createSwarmTool will use process.cwd() instead
			await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{ worktree: '/some/other/path' } as any,
			);

			// Spawn cwd should be process.cwd() (tempDir), NOT the worktree path
			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(tempDir);
		});

		test('falls back to process.cwd() when neither directory nor worktree is provided', async () => {
			// Change to tempDir and set up vitest framework there
			process.chdir(tempDir);
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
			createTestFile(
				tempDir,
				'src/utils.test.ts',
				'import {describe,test,expect} from "vitest"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
			);

			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			// Call with empty context (should fall back to process.cwd())
			await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{} as any,
			);

			expect(spawnCalls.length).toBeGreaterThan(0);
			expect((spawnCalls[0].opts as any)?.cwd).toBe(tempDir);
		});

		test('ctx.directory is used (not worktree) when both are provided', async () => {
			// Set up vitest framework in tempDir (used as ctx.directory)
			process.chdir(tempDir);
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
			createTestFile(
				tempDir,
				'src/utils.test.ts',
				'import {describe,test,expect} from "vitest"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
			);

			// Create another dir for worktree (not used by createSwarmTool)
			const worktreeDir = createTempDir();

			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			try {
				await test_runner.execute(
					{ scope: 'convention', files: ['src/utils.ts'] },
					{ directory: tempDir, worktree: worktreeDir } as any,
				);

				// createSwarmTool uses ctx.directory (tempDir), not worktree
				expect(spawnCalls.length).toBeGreaterThan(0);
				expect((spawnCalls[0].opts as any)?.cwd).toBe(tempDir);
			} finally {
				try {
					fs.rmSync(worktreeDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}
		});

		test('working_directory drives repo-root discovery when cwd differs', async () => {
			const callerDir = createTempDir();
			process.chdir(callerDir);

			try {
				createTestFile(
					tempDir,
					'package.json',
					JSON.stringify({
						scripts: { test: 'vitest run' },
						devDependencies: { vitest: '^1.0.0' },
					}),
				);
				createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
				createTestFile(
					tempDir,
					'tests/utils.test.ts',
					'import { describe, test, expect } from "vitest"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
				);

				mockStdout = JSON.stringify({
					numTotalTests: 1,
					numPassedTests: 1,
					numFailedTests: 0,
				});
				Bun.spawn = mockSpawn as any;

				await test_runner.execute(
					{
						scope: 'convention',
						files: ['src/utils.ts'],
						working_directory: tempDir,
					},
					{ directory: callerDir } as any,
				);

				expect(spawnCalls.length).toBeGreaterThan(0);
				expect((spawnCalls[0].opts as any)?.cwd).toBe(tempDir);
				expect(spawnCalls[0].cmd.join('/').replace(/\\/g, '/')).toContain(
					'tests/utils.test.ts',
				);
			} finally {
				try {
					fs.rmSync(callerDir, { recursive: true, force: true });
				} catch {
					// Windows EBUSY: subprocess may still hold directory handle.
					// Temp dirs are cleaned by the OS; safe to ignore.
				}
			}
		});

		test('working_directory accepts direct PowerShell test files outside source directories', async () => {
			const callerDir = createTempDir();
			process.chdir(callerDir);

			try {
				createTestFile(tempDir, 'pester.config.ps1', 'configuration');
				createTestFile(
					tempDir,
					'qa/Smoke.Tests.ps1',
					'Describe "Smoke" { It "passes" { $true | Should -Be $true } }',
				);

				mockStdout = 'Passed: 1 Failed: 0 Skipped: 0';
				Bun.spawn = mockSpawn as any;

				await test_runner.execute(
					{
						scope: 'convention',
						files: ['qa/Smoke.Tests.ps1'],
						working_directory: tempDir,
					},
					{ directory: callerDir } as any,
				);

				expect(spawnCalls.length).toBeGreaterThan(0);
				expect((spawnCalls[0].opts as any)?.cwd).toBe(tempDir);
				expect(spawnCalls[0].cmd[0]).toBe('pwsh');
			} finally {
				try {
					fs.rmSync(callerDir, { recursive: true, force: true });
				} catch {
					// Windows EBUSY: subprocess may still hold directory handle.
					// Temp dirs are cleaned by the OS; safe to ignore.
				}
			}
		});

		test('correctly detects vitest framework from ctx.directory path', async () => {
			// Set up vitest framework in tempDir
			process.chdir(tempDir);
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
			createTestFile(
				tempDir,
				'src/utils.test.ts',
				'import {describe,test,expect} from "vitest"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
			);

			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			const result = await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{ directory: tempDir } as any,
			);

			const parsed = parseResult(result);
			// Verify the correct framework was detected from ctx.directory (tempDir)
			expect(parsed.framework).toBe('vitest');
		});

		test('correctly detects jest framework from ctx.directory path', async () => {
			process.chdir(tempDir);
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'jest' },
					devDependencies: { jest: '^29.0.0' },
				}),
			);
			createTestFile(tempDir, 'src/utils.ts', 'export const x = 1;');
			createTestFile(
				tempDir,
				'src/utils.test.ts',
				'import { describe, test, expect } from "@jest/globals"; describe("x", () => { test("x", () => expect(1).toBe(1)); });',
			);

			mockStdout = JSON.stringify({
				numTotalTests: 1,
				numPassedTests: 1,
				numFailedTests: 0,
			});
			Bun.spawn = mockSpawn as any;

			const result = await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{ directory: tempDir } as any,
			);

			const parsed = parseResult(result);
			expect(parsed.framework).toBe('jest');
		});

		test('correctly detects pytest framework from ctx.directory path', async () => {
			process.chdir(tempDir);
			createTestFile(tempDir, 'requirements.txt', 'pytest>=7.0.0');
			createTestFile(tempDir, 'utils.py', 'def add(a, b): return a + b');
			createTestFile(
				tempDir,
				'utils_test.py',
				'from utils import add\ndef test_add(): assert add(1, 2) == 3',
			);

			mockStdout = '1 passed';
			Bun.spawn = mockSpawn as any;

			const result = await test_runner.execute(
				{ scope: 'convention', files: ['utils.py'] },
				{ directory: tempDir } as any,
			);

			const parsed = parseResult(result);
			expect(parsed.framework).toBe('pytest');
		});

		test('returns "none" framework when ctx.directory has no test framework', async () => {
			// tempDir is empty (no framework markers)
			const result = await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{ directory: tempDir } as any,
			);

			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('none');
			expect(parsed.error).toContain('No test framework');
		});
	});

	describe('detectTestFramework(cwd) - vitest detection', () => {
		test('uses cwd for vitest detection via scripts', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
				}),
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('vitest');
		});

		test('uses cwd for vitest detection via devDependencies', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					devDependencies: { vitest: '^1.0.0' },
				}),
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('vitest');
		});
	});

	describe('detectTestFramework(cwd) - jest detection', () => {
		test('uses cwd for jest detection via scripts', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'jest' },
				}),
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('jest');
		});

		test('uses cwd for jest detection via devDependencies', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					devDependencies: { jest: '^29.0.0' },
				}),
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('jest');
		});
	});

	describe('detectTestFramework(cwd) - mocha detection', () => {
		test('uses cwd for mocha detection via scripts', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					scripts: { test: 'mocha' },
				}),
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('mocha');
		});

		test('uses cwd for mocha detection via devDependencies', async () => {
			createTestFile(
				tempDir,
				'package.json',
				JSON.stringify({
					devDependencies: { mocha: '^10.0.0' },
				}),
			);

			const framework = await detectTestFramework(tempDir);
			expect(framework).toBe('mocha');
		});
	});
});
