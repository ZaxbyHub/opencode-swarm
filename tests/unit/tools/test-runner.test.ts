import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const testRunnerModule = await import('../../../src/tools/test-runner');

const PESTER_PROBE =
	'if (Get-Module -ListAvailable -Name Pester) { exit 0 }; exit 1';
let hasPester = false;
try {
	const proc = Bun.spawnSync(
		['pwsh', '-NoLogo', '-NonInteractive', '-Command', PESTER_PROBE],
		{
			cwd: import.meta.dir,
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
			timeout: 10_000,
		},
	);
	hasPester = proc.exitCode === 0;
} catch {}

// Extract the exports we need
const {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MAX_SAFE_TEST_FILES,
	MAX_SAFE_SOURCE_FILES,
	SUPPORTED_FRAMEWORKS,
	test_runner,
	detectTestFramework,
	isLanguageSpecificTestFile,
	getTestFilesFromConvention,
	runTests,
} = testRunnerModule;

/**
 * Build a Bun.spawn stub that emits vitest-style JSON on stdout, so the
 * test-runner's full execute -> buildTestCommand -> runTests -> parseTestOutput
 * vitest path can be exercised deterministically without spawning a real
 * `npx vitest` (which would require a network fetch when node_modules/vitest is
 * absent — the source of intermittent coverage-gate timeouts). Mirrors the
 * rspec Bun.spawn stub pattern used later in this file.
 */
function makeVitestSpawnStub(result: {
	passed: number;
	failed: number;
	skipped: number;
}): typeof Bun.spawn {
	const encoder = new TextEncoder();
	const total = result.passed + result.failed + result.skipped;
	// Shape matched by parseTestOutput's vitest/jest/bun JSON branch:
	// a JSON object containing "testResults" plus num*Tests counters.
	const payload = JSON.stringify({
		numTotalTests: total,
		numPassedTests: result.passed,
		numFailedTests: result.failed,
		numPendingTests: result.skipped,
		testResults: [],
	});
	return (() =>
		({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(payload));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(controller) {
					controller.close();
				},
			}),
			// A failing test must produce a non-zero exit code for runTests to
			// classify the run as a regression; passing tests exit 0.
			exited: Promise.resolve(result.failed > 0 ? 1 : 0),
			exitCode: result.failed > 0 ? 1 : 0,
			kill: () => {},
		}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;
}

describe('test-runner.ts - Constants and Types', () => {
	describe('exported constants', () => {
		test('DEFAULT_TIMEOUT_MS is 60000', () => {
			expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
		});

		test('MAX_TIMEOUT_MS is 300000', () => {
			expect(MAX_TIMEOUT_MS).toBe(300_000);
		});

		test('SUPPORTED_FRAMEWORKS contains expected frameworks', () => {
			expect(SUPPORTED_FRAMEWORKS).toContain('bun');
			expect(SUPPORTED_FRAMEWORKS).toContain('vitest');
			expect(SUPPORTED_FRAMEWORKS).toContain('jest');
			expect(SUPPORTED_FRAMEWORKS).toContain('mocha');
			expect(SUPPORTED_FRAMEWORKS).toContain('pytest');
			expect(SUPPORTED_FRAMEWORKS).toContain('cargo');
			expect(SUPPORTED_FRAMEWORKS).toContain('pester');
		});
	});
});

describe('test-runner.ts - Tool Metadata', () => {
	test('has scope schema with all options', () => {
		expect(test_runner.args.scope).toBeDefined();
	});

	test('has files schema', () => {
		expect(test_runner.args.files).toBeDefined();
	});

	test('has coverage schema', () => {
		expect(test_runner.args.coverage).toBeDefined();
	});

	test('has timeout_ms schema', () => {
		expect(test_runner.args.timeout_ms).toBeDefined();
	});
});

describe('test-runner.ts - Framework Detection', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-detect-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		// Retry cleanup after a short delay
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		})();
	});

	test('detects no framework when no config exists', async () => {
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('none');
	});

	test('detects vitest from package.json scripts', async () => {
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('vitest');
	});

	test('detects jest from package.json scripts', async () => {
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'jest' },
				devDependencies: { jest: '^29.0.0' },
			}),
		);
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('jest');
	});

	test('detects mocha from package.json', async () => {
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'mocha' },
				devDependencies: { mocha: '^10.0.0' },
			}),
		);
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('mocha');
	});

	test('detects bun from package.json', async () => {
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'bun test' },
			}),
		);
		fs.writeFileSync('bun.lock', ''); // Create bun.lock file
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('bun');
	});

	test('detects pytest from pyproject.toml', async () => {
		fs.writeFileSync(
			'pyproject.toml',
			`
[project]
name = "test"

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
		);
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('pytest');
	});

	test('detects pytest from setup.cfg', async () => {
		fs.writeFileSync(
			'setup.cfg',
			`
[pytest]
testpaths = tests
`,
		);
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('pytest');
	});

	test('detects pytest from requirements.txt', async () => {
		fs.writeFileSync('requirements.txt', 'pytest>=7.0.0\n');
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('pytest');
	});

	test('detects cargo from Cargo.toml', async () => {
		fs.writeFileSync(
			'Cargo.toml',
			`
[package]
name = "test"
version = "0.1.0"

[dev-dependencies]
tokio = { version = "1.0", features = ["full"] }
`,
		);
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('cargo');
	});

	test('detects pester from pester.config.ps1', async () => {
		fs.writeFileSync('pester.config.ps1', 'configuration\n');
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('pester');
	});

	test('detects pester from tests.ps1', async () => {
		fs.writeFileSync('tests.ps1', 'Describe "Tests" { }\n');
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('pester');
	});
});

describe('test-runner.ts - Validation Tests (no execution)', () => {
	test('returns error when no framework detected', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-none-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		// Use explicit scope to reach framework detection (not scope: 'all' which is rejected first)
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['src/utils.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.framework).toBe('none');
		expect(parsed.error).toContain('No test framework');
		expect(parsed.outcome).toBe('error');

		process.chdir(originalCwd);
		// Cleanup with delay
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 10000);

	test('tool returns valid JSON structure for error case', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-json-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		const result = await test_runner.execute({}, {} as any);
		const parsed = JSON.parse(result);

		// Check structure for error case
		expect(parsed).toHaveProperty('success');
		expect(parsed.success).toBe(false);
		expect(parsed).toHaveProperty('framework');
		expect(parsed).toHaveProperty('scope');
		expect(parsed).toHaveProperty('error');
		expect(parsed.framework).toBe('none');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 10000);
});

describe('test-runner.ts - Edge Cases', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-edge-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		// Create vitest config to allow framework detection
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	});

	test('detectTestFramework correctly identifies vitest from package.json', async () => {
		// Test framework detection without executing tests
		const framework = await detectTestFramework(tempDir);
		expect(framework).toBe('vitest');
	});

	test('tool metadata has correct structure for vitest framework', () => {
		// Verify tool structure without executing - check the tool definition
		expect(test_runner.args.scope).toBeDefined();
		expect(test_runner.args.files).toBeDefined();
		expect(test_runner.args.coverage).toBeDefined();
		expect(test_runner.args.timeout_ms).toBeDefined();

		// Verify DEFAULT_TIMEOUT_MS is exported and correct
		expect(DEFAULT_TIMEOUT_MS).toBe(60000);
	});

	test('timeout defaults are defined correctly', () => {
		// Test timeout constants without running external processes
		expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
		expect(MAX_TIMEOUT_MS).toBe(300_000);
		expect(DEFAULT_TIMEOUT_MS).toBeLessThan(MAX_TIMEOUT_MS);
	});
});

describe('test-runner.ts - Security Validation', () => {
	test('rejects path traversal in files', async () => {
		const result = await test_runner.execute(
			{ files: ['../../etc/passwd'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects URL-encoded path traversal', async () => {
		const result = await test_runner.execute(
			{ files: ['%2e%2e%2fpasswd'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects fullwidth dot path traversal', async () => {
		const result = await test_runner.execute(
			{ files: ['file\uff0e\uff0epasswd'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects PowerShell metacharacters', async () => {
		const result = await test_runner.execute(
			{ files: ['file|whoami.ps1'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects control characters in files', async () => {
		const result = await test_runner.execute(
			{ files: ['file\x00test.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects newline in files', async () => {
		const result = await test_runner.execute(
			{ files: ['file\ntest.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects absolute Unix path', async () => {
		const result = await test_runner.execute(
			{ files: ['/etc/passwd'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects absolute Windows path', async () => {
		const result = await test_runner.execute(
			{ files: ['C:\\Windows\\System32\\file.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects invalid scope value', async () => {
		const result = await test_runner.execute({ scope: 'invalid' }, {} as any);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects invalid files type (string instead of array)', async () => {
		const result = await test_runner.execute(
			{ files: 'not-an-array' } as any,
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects invalid coverage type', async () => {
		const result = await test_runner.execute(
			{ coverage: 'yes' } as any,
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects invalid timeout type', async () => {
		const result = await test_runner.execute(
			{ timeout_ms: '60s' } as any,
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('accepts valid relative file path - validation only', async () => {
		// Test validation passes by checking we don't get Invalid arguments error
		// Note: We can't test execution with files as it triggers actual test run
		// This test verifies validation passes by checking the schema is defined
		expect(test_runner.args.files).toBeDefined();
	});

	test('rejects convention scope without files', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention' },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('convention');
		expect(parsed.error).toContain('require explicit files');
		expect(parsed.error).toContain('unsafe full-project discovery');
	});

	test('rejects graph scope without files', async () => {
		const result = await test_runner.execute({ scope: 'graph' }, {} as any);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('graph');
		expect(parsed.error).toContain('require explicit files');
		expect(parsed.error).toContain('unsafe full-project discovery');
	});

	test('rejects convention scope with empty files array', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: [] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('convention');
		expect(parsed.error).toContain('require explicit files');
	});

	test('rejects graph scope with empty files array', async () => {
		const result = await test_runner.execute(
			{ scope: 'graph', files: [] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('graph');
		expect(parsed.error).toContain('require explicit files');
	});

	test('rejects non-source files array for convention scope', async () => {
		// Set up a detectable framework first so we can test the non-source-file guard
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-nonsrc-conv-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create minimal package.json for vitest detection
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);

		const result = await test_runner.execute(
			{ scope: 'convention', files: ['README.md', 'config.json'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('convention');
		expect(parsed.error).toContain(
			'no recognized source files or direct test files',
		);
		expect(parsed.message).toContain(
			'direct test file in a supported test location',
		);

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 10000);

	test.skipIf(!hasPester)(
		'accepts direct test files for convention scope without source extensions',
		async () => {
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-direct-conv-')),
			);
			const originalCwd = process.cwd();
			process.chdir(tempDir);

			fs.writeFileSync('pester.config.ps1', 'configuration');
			fs.mkdirSync(path.join(tempDir, 'qa'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'qa', 'Smoke.Tests.ps1'),
				'Describe "x" {}',
			);

			const result = await test_runner.execute(
				{ scope: 'convention', files: ['qa/Smoke.Tests.ps1'] },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.framework).toBe('pester');

			process.chdir(originalCwd);
			(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			})();
		},
		10000,
	);

	test('rejects non-source files array for graph scope', async () => {
		// Set up a detectable framework first so we can test the non-source-file guard
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-nonsrc-graph-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create minimal package.json for vitest detection
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);

		const result = await test_runner.execute(
			{ scope: 'graph', files: ['README.md', 'config.json'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('graph');
		expect(parsed.error).toContain(
			'no source files with recognized extensions',
		);
		expect(parsed.message).toContain(
			'Direct test files belong in scope "convention"',
		);

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 10000);

	test('tells graph scope callers to use convention for direct test files', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-graph-testfile-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'utils.test.ts'),
			'export {};',
		);

		const result = await test_runner.execute(
			{ scope: 'graph', files: ['tests/utils.test.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain(
			'Direct test files belong in scope "convention"',
		);

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 10000);
});

describe('test-runner.ts - Interactive Bulk-Execution Guards', () => {
	test('rejects scope "all" with structured error for interactive sessions', async () => {
		const result = await test_runner.execute({ scope: 'all' }, {} as any);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('all');
		expect(parsed.error).toContain('scope "all" is blocked');
		expect(parsed.message).toContain('scope "convention"');
		expect(parsed.message).toContain('scope "graph"');
	});

	// Previously spawned `npx vitest` in a temp dir without node_modules installed,
	// which made the test depend on an npx network fetch and intermittently time
	// out under the per-file coverage gate. The execution path is now exercised
	// deterministically by stubbing Bun.spawn to emit vitest-style JSON (mirrors
	// the rspec stub pattern below), so the test still validates the full
	// execute -> buildTestCommand -> runTests -> parseTestOutput vitest path
	// without any subprocess or network dependency.
	test('allows Narrow scope requests to execute normally', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-narrow-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		// Framework detection still reads package.json — keep it so the vitest
		// path is selected by the real detectTestFramework logic.
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync(
			'src/utils.ts',
			'export const add = (a: number, b: number) => a + b;',
		);
		fs.writeFileSync(
			'src/utils.test.ts',
			'import { describe, test, expect } from "vitest"; import { add } from "./utils"; describe("add", () => { test("adds", () => { expect(add(1, 2)).toBe(3); }); });',
		);

		// Stub the spawn so no real `npx vitest` (network fetch) runs. Emit a
		// passing vitest JSON result on stdout; parseTestOutput reads num*Tests.
		const originalSpawn = Bun.spawn;
		Bun.spawn = makeVitestSpawnStub({ passed: 1, failed: 0, skipped: 0 });
		try {
			const result = await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);

			// First verify execution succeeded (not blocked by safety guards)
			expect(parsed.success).toBe(true);
			expect(parsed.outcome).toBe('pass');
			// Should NOT have an error field when successful
			expect(parsed.error).toBeUndefined();
		} finally {
			Bun.spawn = originalSpawn;
			process.chdir(originalCwd);
			(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			})();
		}
	});

	test('rejects source file with no matching test file for convention scope', async () => {
		// Create a temp directory with a source file but NO test file
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-empty-conv-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create minimal package.json for vitest detection
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);

		// Create src directory and source file WITHOUT a corresponding test file
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync(
			'src/utils.ts',
			'export const add = (a: number, b: number) => a + b;',
		);

		// Provide the source file - should be rejected because no test file exists
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['src/utils.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		// Should be rejected with clear error about no matching test files
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('convention');
		expect(parsed.error).toContain('resolved to zero test files');
		expect(parsed.message).toContain('No matching test files found');
		expect(parsed.outcome).toBe('skip');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 15000);

	test('rejects source file with no matching test file for graph scope', async () => {
		// Create a temp directory with a source file but NO test file
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-empty-graph-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create minimal package.json for vitest detection
		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);

		// Create src directory and source file WITHOUT a corresponding test file
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync(
			'src/utils.ts',
			'export const add = (a: number, b: number) => a + b;',
		);

		// Provide the source file - should be rejected because no test file exists
		const result = await test_runner.execute(
			{ scope: 'graph', files: ['src/utils.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		// Should be rejected with clear error about no matching test files
		expect(parsed.success).toBe(false);
		// Graph scope falls back to convention when imports resolution returns no results
		expect(parsed.scope).toBe('convention');
		expect(parsed.error).toContain('resolved to zero test files');
		expect(parsed.message).toContain('No matching test files found');
		expect(parsed.outcome).toBe('skip');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		})();
	}, 15000);
});

/**
 * Task 5.2: scope:"all" gated access tests
 *
 * Verifies:
 * - scope:"all" is blocked for agent use unless SWARM_ALLOW_FULL_SUITE env is set
 *   (the runtime gate is env-only; the legacy allow_full_suite arg was removed)
 * - scope:"convention" and scope:"graph" are unaffected by the scope:"all" guard
 */
describe('test-runner.ts - scope:"all" gated access (env-only)', () => {
	describe('scope "all" guard behavior', () => {
		test('scope:"all" without SWARM_ALLOW_FULL_SUITE returns error', async () => {
			const result = await test_runner.execute({ scope: 'all' }, {} as any);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('all');
			expect(parsed.error).toContain('scope "all" is blocked');
		});

		test('scope:"all" with files:[] is still blocked for agent use', async () => {
			const noFrameworkDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-allfiles-')),
			);
			const savedCwd = process.cwd();
			process.chdir(noFrameworkDir);

			const result = await test_runner.execute(
				{ scope: 'all', files: [] },
				{} as any,
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).not.toContain(
				'Provided source files resolved to zero test files',
			);
			expect(parsed.error).toContain('scope "all" is blocked');

			process.chdir(savedCwd);
			(() => {
				try {
					fs.rmSync(noFrameworkDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			})();
		});
	});

	describe('scope "convention" and "graph" are unaffected by the scope:"all" guard', () => {
		test('scope:"convention" works normally', async () => {
			// Create a temp dir so framework detection can work
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-conv-')),
			);
			const originalCwd = process.cwd();
			process.chdir(tempDir);

			// Create minimal package.json for framework detection
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);

			// Create src directory and source file
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync(
				'src/utils.ts',
				'export const add = (a: number, b: number) => a + b;',
			);

			// convention scope with a file should work (but will fail on no test file - which is fine)
			const result = await test_runner.execute(
				{ scope: 'convention', files: ['src/utils.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);

			// convention scope is not subject to the scope:"all" guard
			expect(parsed.error).not.toContain('scope "all" is blocked');

			process.chdir(originalCwd);
			(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			})();
		}, 15000);

		test('scope:"graph" works normally', async () => {
			// Create a temp dir so framework detection can work
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-graph-')),
			);
			const originalCwd = process.cwd();
			process.chdir(tempDir);

			// Create minimal package.json for framework detection
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);

			// Create src directory and source file
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync(
				'src/utils.ts',
				'export const add = (a: number, b: number) => a + b;',
			);

			// graph scope with a file should work (but will fail on no test file - which is fine)
			const result = await test_runner.execute(
				{ scope: 'graph', files: ['src/utils.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);

			// graph scope is not subject to the scope:"all" guard
			expect(parsed.error).not.toContain('scope "all" is blocked');

			process.chdir(originalCwd);
			(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			})();
		}, 15000);

		test('returns outcome "scope_exceeded" when too many test files resolved', async () => {
			// Create a temp directory with many source files to trigger MAX_SAFE_TEST_FILES limit
			const sourceFiles = Array.from(
				{ length: MAX_SAFE_TEST_FILES + 1 },
				(_, i) => `src/file${i}.spec.ts`,
			);
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-toomany-')),
			);
			const originalCwd = process.cwd();
			process.chdir(tempDir);

			// Create minimal package.json for vitest detection
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);

			// Create src directory and MORE than MAX_SAFE_TEST_FILES test files
			// Convention scope discovers test files by naming convention (.spec.ts, .test.ts)
			// so we must create actual test files, not source files
			fs.mkdirSync('src', { recursive: true });
			for (let i = 0; i < MAX_SAFE_TEST_FILES + 1; i++) {
				const filePath = path.join('src', `file${i}.spec.ts`);
				fs.writeFileSync(filePath, `export const val${i} = ${i};\n`);
			}

			// Execute with scope 'convention' - should trigger too-many-files guard
			const result = await test_runner.execute(
				{ scope: 'convention', files: sourceFiles },
				{} as any,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			expect(parsed.error).toContain('exceeds safe maximum');
			expect(parsed.message).toContain('Too many test files resolved');

			process.chdir(originalCwd);
			(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			})();
		}, 30000);

		// Previously spawned `npx vitest` in a temp dir without node_modules
		// installed (network fetch → intermittent coverage-gate timeout). Now
		// stubbed to emit a failing vitest JSON result deterministically.
		test('returns outcome "regression" when tests fail', async () => {
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-fail-')),
			);
			const originalCwd = process.cwd();
			process.chdir(tempDir);

			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync(
				'src/utils.ts',
				'export const add = (a: number, b: number) => a + b;',
			);
			// A FAILING test file (content kept for fidelity of the scenario).
			fs.writeFileSync(
				'src/utils.test.ts',
				'import { describe, test, expect } from "vitest"; import { add } from "./utils"; describe("add", () => { test("adds incorrectly", () => { expect(add(1, 2)).toBe(999); }); });',
			);

			// Stub the spawn with a FAILING vitest result (1 failed test).
			const originalSpawn = Bun.spawn;
			Bun.spawn = makeVitestSpawnStub({ passed: 0, failed: 1, skipped: 0 });
			try {
				const result = await test_runner.execute(
					{ scope: 'convention', files: ['src/utils.ts'] },
					{} as any,
				);
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(false);
				expect(parsed.outcome).toBe('regression');
				expect(parsed.totals).toBeDefined();
				expect(parsed.totals.failed).toBeGreaterThan(0);
			} finally {
				Bun.spawn = originalSpawn;
				process.chdir(originalCwd);
				(() => {
					try {
						fs.rmSync(tempDir, { recursive: true, force: true });
					} catch {
						// Ignore
					}
				})();
			}
		});
	});
});

// ============ Language-Specific Test File Detection ============

describe('test-runner.ts — isLanguageSpecificTestFile', () => {
	describe('Go convention (_test.go suffix)', () => {
		test('recognises foo_test.go', () => {
			expect(isLanguageSpecificTestFile('foo_test.go')).toBe(true);
		});
		test('recognises util_test.go', () => {
			expect(isLanguageSpecificTestFile('util_test.go')).toBe(true);
		});
		test('does not recognise foo.go (source file)', () => {
			expect(isLanguageSpecificTestFile('foo.go')).toBe(false);
		});
		test('does not recognise test_helper.go (no _test.go suffix)', () => {
			expect(isLanguageSpecificTestFile('test_helper.go')).toBe(false);
		});
	});

	describe('Python convention (test_*.py prefix and *_test.py suffix)', () => {
		test('recognises test_foo.py (pytest prefix)', () => {
			expect(isLanguageSpecificTestFile('test_foo.py')).toBe(true);
		});
		test('recognises test_utils.py', () => {
			expect(isLanguageSpecificTestFile('test_utils.py')).toBe(true);
		});
		test('recognises foo_test.py (pytest suffix)', () => {
			expect(isLanguageSpecificTestFile('foo_test.py')).toBe(true);
		});
		test('does not recognise foo.py (source)', () => {
			expect(isLanguageSpecificTestFile('foo.py')).toBe(false);
		});
		test('does not recognise conftest.py', () => {
			expect(isLanguageSpecificTestFile('conftest.py')).toBe(false);
		});
	});

	describe('Ruby convention (*_spec.rb)', () => {
		test('recognises foo_spec.rb', () => {
			expect(isLanguageSpecificTestFile('foo_spec.rb')).toBe(true);
		});
		test('recognises user_service_spec.rb', () => {
			expect(isLanguageSpecificTestFile('user_service_spec.rb')).toBe(true);
		});
		test('does not recognise foo.rb (source)', () => {
			expect(isLanguageSpecificTestFile('foo.rb')).toBe(false);
		});
	});

	describe('Java convention (Test*.java prefix and *Test.java / *Tests.java suffix)', () => {
		test('recognises FooTest.java', () => {
			expect(isLanguageSpecificTestFile('FooTest.java')).toBe(true);
		});
		test('recognises FooTests.java', () => {
			expect(isLanguageSpecificTestFile('FooTests.java')).toBe(true);
		});
		test('recognises TestFoo.java', () => {
			expect(isLanguageSpecificTestFile('TestFoo.java')).toBe(true);
		});
		test('does not recognise Foo.java (source)', () => {
			expect(isLanguageSpecificTestFile('Foo.java')).toBe(false);
		});
		test('does not recognise testutils.java (utility, not test class)', () => {
			expect(isLanguageSpecificTestFile('testutils.java')).toBe(false);
		});
		test('does not recognise testing.java (utility, not test class)', () => {
			expect(isLanguageSpecificTestFile('testing.java')).toBe(false);
		});
	});

	describe('C# convention (*Test.cs and *Tests.cs)', () => {
		test('recognises FooTest.cs', () => {
			expect(isLanguageSpecificTestFile('FooTest.cs')).toBe(true);
		});
		test('recognises FooTests.cs', () => {
			expect(isLanguageSpecificTestFile('FooTests.cs')).toBe(true);
		});
		test('does not recognise Foo.cs (source)', () => {
			expect(isLanguageSpecificTestFile('Foo.cs')).toBe(false);
		});
	});

	describe('Kotlin convention (*Test.kt and *Tests.kt)', () => {
		test('recognises FooTest.kt', () => {
			expect(isLanguageSpecificTestFile('FooTest.kt')).toBe(true);
		});
		test('recognises FooTests.kt', () => {
			expect(isLanguageSpecificTestFile('FooTests.kt')).toBe(true);
		});
		test('recognises TestFoo.kt', () => {
			expect(isLanguageSpecificTestFile('TestFoo.kt')).toBe(true);
		});
		test('does not recognise Foo.kt (source)', () => {
			expect(isLanguageSpecificTestFile('Foo.kt')).toBe(false);
		});
		test('does not recognise testutil.kt (utility, not test class)', () => {
			expect(isLanguageSpecificTestFile('testutil.kt')).toBe(false);
		});
		test('does not recognise testing.kt (utility, not test class)', () => {
			expect(isLanguageSpecificTestFile('testing.kt')).toBe(false);
		});
	});
});

describe('test-runner.ts — getTestFilesFromConvention (language-specific)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'conv-test-')),
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function write(rel: string, content = ''): string {
		const abs = path.join(tmpDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, 'utf-8');
		return abs;
	}

	describe('Go — test files passed directly', () => {
		test('foo_test.go is passed through as-is', () => {
			const testFile = write('pkg/foo_test.go', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});

		test('foo_test.go in a tests/ directory is passed through', () => {
			const testFile = write('tests/foo_test.go', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});
	});

	describe('Go — source-to-test mapping', () => {
		test('foo.go maps to colocated foo_test.go when it exists', () => {
			const src = write('pkg/foo.go', '');
			const tst = write('pkg/foo_test.go', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toContain(tst);
			expect(result).not.toContain(src);
		});

		test('foo.go produces empty result when no test file exists', () => {
			const src = write('pkg/foo.go', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toHaveLength(0);
		});
	});

	describe('Python — test files passed directly', () => {
		test('test_foo.py (prefix) is passed through as-is', () => {
			const testFile = write('test_foo.py', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});

		test('foo_test.py (suffix) is passed through as-is', () => {
			const testFile = write('src/foo_test.py', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});

		test('test_foo.py in a tests/ directory is passed through', () => {
			const testFile = write('tests/test_foo.py', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});
	});

	describe('Python — source-to-test mapping', () => {
		test('foo.py maps to colocated test_foo.py when it exists', () => {
			const src = write('src/foo.py', '');
			const tst = write('src/test_foo.py', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toContain(tst);
		});

		test('foo.py maps to colocated foo_test.py when it exists', () => {
			const src = write('src/foo.py', '');
			const tst = write('src/foo_test.py', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toContain(tst);
		});

		test('foo.py maps to tests/test_foo.py when colocated test missing', () => {
			const src = write('src/foo.py', '');
			const tst = write('src/tests/test_foo.py', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toContain(tst);
		});
	});

	describe('Ruby — test files passed directly', () => {
		test('foo_spec.rb is passed through as-is', () => {
			const testFile = write('spec/foo_spec.rb', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});

		test('foo_spec.rb colocated with source is passed through', () => {
			const testFile = write('lib/foo_spec.rb', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});
	});

	describe('Ruby — source-to-test mapping', () => {
		test('foo.rb maps to colocated foo_spec.rb when it exists', () => {
			const src = write('lib/foo.rb', '');
			const tst = write('lib/foo_spec.rb', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toContain(tst);
		});

		test('foo.rb maps to spec/foo_spec.rb when colocated missing', () => {
			const src = write('lib/foo.rb', '');
			const tst = write('lib/spec/foo_spec.rb', '');
			const result = getTestFilesFromConvention([src]);
			expect(result).toContain(tst);
		});
	});

	describe('/spec/ directory — any language', () => {
		test('file in spec/ directory is passed through as-is', () => {
			const testFile = write('spec/helpers/foo.ts', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});
	});

	describe('Java — test files passed directly', () => {
		test('FooTest.java is passed through', () => {
			const testFile = write('src/test/FooTest.java', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});

		test('TestFoo.java is passed through', () => {
			const testFile = write('src/FooDir/TestFoo.java', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});
	});

	describe('C# — test files passed directly', () => {
		test('FooTests.cs is passed through', () => {
			const testFile = write('tests/FooTests.cs', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});
	});

	describe('deduplication', () => {
		test('duplicate paths are not returned twice', () => {
			const testFile = write('pkg/foo_test.go', '');
			const result = getTestFilesFromConvention([testFile, testFile]);
			expect(result).toHaveLength(1);
		});
	});

	describe('PowerShell', () => {
		test('Foo.Tests.ps1 is passed through as-is', () => {
			const testFile = write('qa/Foo.Tests.ps1', '');
			const result = getTestFilesFromConvention([testFile]);
			expect(result).toEqual([testFile]);
		});

		test('script.ps1 maps to repo-root tests/script.Tests.ps1', () => {
			const src = write('scripts/script.ps1', '');
			const tst = write('tests/script.Tests.ps1', '');
			const result = getTestFilesFromConvention([src], tmpDir);
			expect(result).toContain(tst);
		});
	});

	describe('repo-root discovery', () => {
		test('src/utils.ts maps to repo-root tests/utils.test.ts', () => {
			const src = write('src/utils.ts', '');
			const tst = write('tests/utils.test.ts', '');
			const result = getTestFilesFromConvention([src], tmpDir);
			expect(result).toContain(tst);
		});

		test('lib/foo.rb maps to repo-root spec/foo_spec.rb', () => {
			const src = write('lib/foo.rb', '');
			const tst = write('spec/foo_spec.rb', '');
			const result = getTestFilesFromConvention([src], tmpDir);
			expect(result).toContain(tst);
		});

		test('src/main/java/Foo.java maps to src/test/java/FooTest.java', () => {
			const src = write('src/main/java/com/example/Foo.java', '');
			const tst = write('src/test/java/com/example/FooTest.java', '');
			const result = getTestFilesFromConvention([src], tmpDir);
			expect(result).toContain(tst);
		});
	});
});

describe('test-runner.ts — targeted framework safeguards', () => {
	test('returns explicit error when targeted file execution is unsupported', async () => {
		const result = await runTests(
			'go-test',
			'convention',
			['pkg/foo_test.go'],
			false,
			60_000,
			process.cwd(),
		);

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error('expected failure result');
		}
		expect(result.error).toContain(
			'does not support targeted test-file execution',
		);
		expect(result.message).toContain('go test targets packages');
	});

	test('allows targeted execution for rspec-compatible frameworks', async () => {
		const originalSpawn = Bun.spawn;
		const encoder = new TextEncoder();
		Bun.spawn = (() =>
			({
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('1 example, 0 failures'));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {},
			}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

		try {
			const result = await runTests(
				'rspec',
				'convention',
				['spec/foo_spec.rb'],
				false,
				60_000,
				process.cwd(),
			);
			expect(result.success).toBe(true);
		} finally {
			Bun.spawn = originalSpawn;
		}
	});
});

describe('test-runner.ts — targets support', () => {
	test('allows targeted execution for go-test when targets are provided', async () => {
		const originalSpawn = Bun.spawn;
		const encoder = new TextEncoder();
		let spawnArgs: string[] = [];
		Bun.spawn = ((cmd: string[], options?: any) => {
			spawnArgs = cmd;
			return {
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('ok  	pkg	0.001s'));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {},
			};
		}) as unknown as typeof Bun.spawn;

		try {
			const result = await runTests(
				'go-test',
				'convention',
				['pkg/foo_test.go'], // This alone would fail without targets
				false,
				60_000,
				process.cwd(),
				false,
				['TestFoo'], // The actual target
			);

			expect(result.success).toBe(true);
			// Should invoke: go test -run TestFoo ./...
			expect(spawnArgs).toEqual(['go', 'test', '-run', 'TestFoo', './...']);
		} finally {
			Bun.spawn = originalSpawn;
		}
	});

	test('allows targeted execution for ctest when targets are provided', async () => {
		const originalSpawn = Bun.spawn;
		const encoder = new TextEncoder();
		let spawnArgs: string[] = [];
		Bun.spawn = ((cmd: string[], options?: any) => {
			spawnArgs = cmd;
			return {
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('100% tests passed, 0 tests failed out of 1'));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {},
			};
		}) as unknown as typeof Bun.spawn;

		try {
			const result = await runTests(
				'ctest',
				'convention',
				['tests/foo.cc'], // This would normally fail since ctest wants test names, not files
				false,
				60_000,
				process.cwd(),
				false,
				['auto-src-controller-stateManager'], // The ctest target
			);

			expect(result.success).toBe(true);
			expect(spawnArgs).toContain('ctest');
			expect(spawnArgs).toContain('-R');
			expect(spawnArgs).toContain('auto-src-controller-stateManager');
		} finally {
			Bun.spawn = originalSpawn;
		}
	});

	test('targets parameter survives Zod schema validation through tool execute path', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: ['TestFoo', 'TestBar'],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		// With scope "all" and no real framework, we get a framework error — not "Invalid arguments"
		// This proves targets passed through Zod without being stripped
		expect(parsed.error).not.toBe('Invalid arguments');
	});

	test('empty string targets are rejected by validation', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: [''],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe('Invalid arguments');
	});

	test('targets with shell metacharacters are rejected', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: ['TestFoo; rm -rf /'],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe('Invalid arguments');
	});

	test('targets with regex metacharacters are allowed', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: ['TestFoo.*', 'Test?Bar', 'A|B'],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		// Valid regex metacharacters should not trigger "Invalid arguments"
		expect(parsed.error).not.toBe('Invalid arguments');
	});
});

/**
 * MAX_SAFE_SOURCE_FILES guard tests (issue #864)
 *
 * scope "graph" and scope "impact" must reject before discovery fan-out when the
 * caller provides more than MAX_SAFE_SOURCE_FILES source files.  Without this guard,
 * discovery fans out to many test files, triggers scope_exceeded, and LLMs
 * cascade to scope "all" (env-gated) — freezing the OpenCode session.
 */
describe('test-runner.ts - MAX_SAFE_SOURCE_FILES pre-discovery guard', () => {
	test('MAX_SAFE_SOURCE_FILES is exported and equals 1', () => {
		expect(MAX_SAFE_SOURCE_FILES).toBe(1);
	});

	test('scope "graph" with 1 source file does NOT trigger source-file guard', async () => {
		// A single source file is the allowed case — guard must not fire.
		// The call will fail later (no test framework in CWD), but not at the source-file guard.
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-graph-1src-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.writeFileSync('package.json', JSON.stringify({ name: 'no-runner' }));
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync('src/utils.ts', 'export const x = 1;');

		const result = await test_runner.execute(
			{ scope: 'graph', files: ['src/utils.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		// Must NOT be the source-file guard error
		expect(parsed.error).not.toContain('accepts at most');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})();
	}, 15000);

	test('scope "graph" with 2 source files returns scope_exceeded before discovery fan-out', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-graph-2src-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync('src/a.ts', 'export const a = 1;');
		fs.writeFileSync('src/b.ts', 'export const b = 2;');

		const result = await test_runner.execute(
			{ scope: 'graph', files: ['src/a.ts', 'src/b.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('graph');
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(parsed.error).toContain('accepts at most');
		expect(parsed.error).toContain('Treat this as SKIP without retry');
		expect(parsed.message).toContain('Call test_runner once per source file');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})();
	}, 15000);

	test('scope "graph" with many source files returns scope_exceeded before discovery fan-out', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-graph-manysrc-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		fs.mkdirSync('src', { recursive: true });
		const manyFiles = Array.from({ length: 20 }, (_, i) => {
			const name = `src/file${i}.ts`;
			fs.writeFileSync(name, `export const val${i} = ${i};`);
			return name;
		});

		const result = await test_runner.execute(
			{ scope: 'graph', files: manyFiles },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('graph');
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(parsed.error).toContain('got 20');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})();
	}, 15000);

	test('scope "impact" with 2 source files returns scope_exceeded before discovery fan-out', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-impact-2src-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync('src/a.ts', 'export const a = 1;');
		fs.writeFileSync('src/b.ts', 'export const b = 2;');

		const result = await test_runner.execute(
			{ scope: 'impact', files: ['src/a.ts', 'src/b.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('impact');
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(parsed.error).toContain('accepts at most');
		expect(parsed.error).toContain('Treat this as SKIP without retry');
		expect(parsed.message).toContain('Call test_runner once per source file');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})();
	}, 15000);

	test('scope "convention" with 2 source files returns scope_exceeded before discovery', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-conv-2src-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.writeFileSync(
			'package.json',
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync('src/a.ts', 'export const a = 1;');
		fs.writeFileSync('src/b.ts', 'export const b = 2;');

		const result = await test_runner.execute(
			{ scope: 'convention', files: ['src/a.ts', 'src/b.ts'] },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('convention');
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(parsed.error).toContain('accepts at most');
		expect(parsed.error).toContain('Treat this as SKIP without retry');
		expect(parsed.message).toContain('Call test_runner once per source file');

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})();
	}, 15000);

	test('scope "convention" with 1 source file + 1 direct test file does NOT trigger source-file guard', async () => {
		// Direct test files are exempt from the MAX_SAFE_SOURCE_FILES limit.
		// Only source-file discovery fans out; direct test file paths are explicitly named.
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-conv-1src1tst-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync('src', { recursive: true });
		fs.writeFileSync('src/utils.ts', 'export const x = 1;');
		fs.writeFileSync(
			'src/utils.test.ts',
			'import { x } from "./utils"; export const v = x;',
		);

		const resolved = getTestFilesFromConvention([
			'src/utils.ts',
			'src/utils.test.ts',
		]).map((p) => p.replace(/\\/g, '/'));
		expect(resolved).toEqual(['src/utils.test.ts']);

		process.chdir(originalCwd);
		(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})();
	}, 5000);

	test('scope "all" blocked error does not recommend "graph" with multiple files', async () => {
		const result = await test_runner.execute({ scope: 'all' }, {} as any);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.outcome).toBe('error');
		// Must not name the env bypass (LLMs follow such hints literally)
		expect(parsed.error).not.toContain('SWARM_ALLOW_FULL_SUITE');
		expect(parsed.message).not.toContain('SWARM_ALLOW_FULL_SUITE');
		expect(parsed.error).toContain('scope "convention"');
		expect(parsed.message).toContain('exactly one source file');
	});
});
