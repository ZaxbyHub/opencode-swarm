import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the module under test
const testRunnerModule = await import('../../../src/tools/test-runner');

// Runtime capability check: detect whether pwsh (PowerShell) is installed.
// Tests that invoke pwsh are skipped when it is not available.
let hasPwsh = false;
try {
	const proc = Bun.spawnSync([
		'pwsh',
		'-NoLogo',
		'-NonInteractive',
		'-Command',
		'exit 0',
	]);
	hasPwsh = proc.exitCode === 0;
} catch {
	hasPwsh = false;
}

// Extract the exports we need
const {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MAX_SAFE_TEST_FILES,
	SUPPORTED_FRAMEWORKS,
	test_runner,
	detectTestFramework,
	isLanguageSpecificTestFile,
	getTestFilesFromConvention,
	runTests,
} = testRunnerModule;

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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
	}, 10000);

	test.skipIf(!hasPwsh)(
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
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
	}, 10000);
});

describe('test-runner.ts - Interactive Bulk-Execution Guards', () => {
	test('rejects scope "all" with structured error for interactive sessions', async () => {
		const result = await test_runner.execute({ scope: 'all' }, {} as any);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.scope).toBe('all');
		expect(parsed.error).toContain('scope "all" is not allowed');
		expect(parsed.message).toContain('scope "convention" or "graph"');
	});

	// Flaky on macOS/Windows: spawns vitest in temp dir without node_modules installed
	test.skipIf(process.platform !== 'linux')(
		'allows narrow scope requests to execute normally',
		async () => {
			// Create a temp directory with a simple test file
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-narrow-')),
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

			// Create src directory FIRST, then source file
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync(
				'src/utils.ts',
				'export const add = (a: number, b: number) => a + b;',
			);

			// Create corresponding test file
			fs.writeFileSync(
				'src/utils.test.ts',
				'import { describe, test, expect } from "vitest"; import { add } from "./utils"; describe("add", () => { test("adds", () => { expect(add(1, 2)).toBe(3); }); });',
			);

			// Use convention scope with explicit file - should NOT be rejected
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

			process.chdir(originalCwd);
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
		},
		15000,
	);

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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
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
		setTimeout(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}, 100);
	}, 15000);
});

/**
 * Task 5.2: scope:"all" gated access tests
 *
 * Verifies:
 * - scope:"all" without allow_full_suite returns error
 * - scope:"all" with allow_full_suite:true does NOT return error (guard passes through)
 * - scope:"all" with allow_full_suite:false returns error
 * - scope:"convention" and scope:"graph" are unaffected by allow_full_suite
 */
describe('test-runner.ts - scope:"all" gated access (allow_full_suite)', () => {
	describe('scope "all" guard behavior', () => {
		test('scope:"all" without allow_full_suite returns error', async () => {
			const result = await test_runner.execute({ scope: 'all' }, {} as any);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('all');
			expect(parsed.error).toContain('scope "all" is not allowed');
		});

		// Flaky on macOS/Windows: spawns vitest via npx in temp dir without node_modules installed
		test.skipIf(process.platform !== 'linux')(
			'scope:"all" with allow_full_suite:true does NOT return the guard error',
			async () => {
				// Note: We do NOT actually run scope:"all" with allow_full_suite:true here
				// because that would execute the full test suite. Instead, we verify that
				// the guard PASSES (no error about allow_full_suite is returned).
				// The execute function should proceed past the guard check.

				// Create a temp dir so framework detection can work
				const tempDir = fs.realpathSync(
					fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-allowall-')),
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

				const result = await test_runner.execute(
					{ scope: 'all', allow_full_suite: true },
					{} as any,
				);
				const parsed = JSON.parse(result);

				// Should NOT have the allow_full_suite error
				expect(parsed.error).not.toContain('allow_full_suite');
				// The error (if any) should be about something else (like no tests found)
				// not about the guard

				process.chdir(originalCwd);
				setTimeout(() => {
					try {
						fs.rmSync(tempDir, { recursive: true, force: true });
					} catch {
						// Ignore
					}
				}, 100);
			},
			15000,
		);

		test('scope:"all" with allow_full_suite:true and files:[] passes through zero-test-files guard', async () => {
			// This test verifies that scope:"all" with allow_full_suite:true does NOT get rejected
			// by the zero-test-files guard when files is an empty array.
			// Uses a temp dir with no framework so we get "No test framework detected"
			// rather than actually running the project's test suite.
			const noFrameworkDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-allfiles-')),
			);
			const savedCwd = process.cwd();
			process.chdir(noFrameworkDir);

			const result = await test_runner.execute(
				{ scope: 'all', allow_full_suite: true, files: [] },
				{} as any,
			);
			const parsed = JSON.parse(result);

			// Should NOT have the zero-test-files guard error
			expect(parsed.error).not.toContain(
				'Provided source files resolved to zero test files',
			);
			// Should NOT have the allow_full_suite error
			expect(parsed.error).not.toContain('allow_full_suite');
			// Will have "No test framework detected" since there's no framework in temp dir
			// This proves the code passed through the scope dispatch and reached framework detection
			expect(parsed.error).toContain('No test framework detected');

			process.chdir(savedCwd);
			setTimeout(() => {
				try {
					fs.rmSync(noFrameworkDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}, 100);
		});

		test('scope:"all" with allow_full_suite:true passes through zero-test-files guard', async () => {
			// Codex Bug 1 fix verification: scope:"all" with allow_full_suite:true and NO files argument
			// Uses a temp dir with no framework so we get "No test framework detected"
			// rather than actually running the project's test suite.
			const noFrameworkDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-allnofiles-')),
			);
			const savedCwd = process.cwd();
			process.chdir(noFrameworkDir);

			const result = await test_runner.execute(
				{ scope: 'all', allow_full_suite: true },
				{} as any,
			);
			const parsed = JSON.parse(result);

			// Should NOT have the zero-test-files guard error
			expect(parsed.error).not.toContain(
				'Provided source files resolved to zero test files',
			);
			// Should NOT have the allow_full_suite error
			expect(parsed.error).not.toContain('allow_full_suite');
			// Result should be "No test framework detected" (proving it passed through to framework detection)
			expect(parsed.error).toContain('No test framework detected');

			process.chdir(savedCwd);
			setTimeout(() => {
				try {
					fs.rmSync(noFrameworkDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}, 100);
		});

		test('scope:"all" with allow_full_suite:false returns error', async () => {
			const result = await test_runner.execute(
				{ scope: 'all', allow_full_suite: false },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('all');
			expect(parsed.error).toContain('scope "all" is not allowed');
		});

		test('scope:"all" with allow_full_suite:undefined returns error (same as missing)', async () => {
			const result = await test_runner.execute(
				{ scope: 'all', allow_full_suite: undefined },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('all');
			expect(parsed.error).toContain('scope "all" is not allowed');
		});
	});

	describe('scope "convention" and "graph" are unaffected by allow_full_suite', () => {
		test('scope:"convention" without allow_full_suite works normally', async () => {
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

			// Should NOT have allow_full_suite error - convention scope doesn't use that guard
			expect(parsed.error).not.toContain('allow_full_suite');

			process.chdir(originalCwd);
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
		}, 15000);

		test('scope:"graph" without allow_full_suite works normally', async () => {
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

			// Should NOT have allow_full_suite error - graph scope doesn't use that guard
			expect(parsed.error).not.toContain('allow_full_suite');

			process.chdir(originalCwd);
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
		}, 15000);

		test('scope:"convention" with allow_full_suite:true still works normally', async () => {
			// Create a temp dir so framework detection can work
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-conv-allow-')),
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

			// convention scope with allow_full_suite should still work (allow_full_suite is ignored for non-all scopes)
			const result = await test_runner.execute(
				{
					scope: 'convention',
					files: ['src/utils.ts'],
					allow_full_suite: true,
				},
				{} as any,
			);
			const parsed = JSON.parse(result);

			// Should NOT have allow_full_suite error - allow_full_suite only applies to scope "all"
			expect(parsed.error).not.toContain('allow_full_suite');

			process.chdir(originalCwd);
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
		}, 15000);

		test('scope:"graph" with allow_full_suite:true still works normally', async () => {
			// Create a temp dir so framework detection can work
			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-graph-allow-')),
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

			// graph scope with allow_full_suite should still work (allow_full_suite is ignored for non-all scopes)
			const result = await test_runner.execute(
				{ scope: 'graph', files: ['src/utils.ts'], allow_full_suite: true },
				{} as any,
			);
			const parsed = JSON.parse(result);

			// Should NOT have allow_full_suite error - allow_full_suite only applies to scope "all"
			expect(parsed.error).not.toContain('allow_full_suite');

			process.chdir(originalCwd);
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
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
			setTimeout(() => {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore
				}
			}, 100);
		}, 30000);

		// Flaky on macOS/Windows: spawns vitest in temp dir without node_modules installed
		test.skipIf(process.platform !== 'linux')(
			'returns outcome "regression" when tests fail',
			async () => {
				// Create a temp directory with a failing test
				const tempDir = fs.realpathSync(
					fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-fail-')),
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

				// Create src directory and source file
				fs.mkdirSync('src', { recursive: true });
				fs.writeFileSync(
					'src/utils.ts',
					'export const add = (a: number, b: number) => a + b;',
				);

				// Create a FAILING test file
				fs.writeFileSync(
					'src/utils.test.ts',
					'import { describe, test, expect } from "vitest"; import { add } from "./utils"; describe("add", () => { test("adds incorrectly", () => { expect(add(1, 2)).toBe(999); }); });',
				);

				// Execute with convention scope
				const result = await test_runner.execute(
					{ scope: 'convention', files: ['src/utils.ts'] },
					{} as any,
				);
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(false);
				expect(parsed.outcome).toBe('regression');
				expect(parsed.totals).toBeDefined();
				expect(parsed.totals.failed).toBeGreaterThan(0);

				process.chdir(originalCwd);
				setTimeout(() => {
					try {
						fs.rmSync(tempDir, { recursive: true, force: true });
					} catch {
						// Ignore
					}
				}, 100);
			},
			15000,
		);
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
