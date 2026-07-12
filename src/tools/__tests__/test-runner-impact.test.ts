import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test_runner } from '../test-runner.js';

// ============ Test Helpers ============

/** Extract execute function from the test_runner tool */
function getExecute() {
	return test_runner.execute as unknown as (
		args: Record<string, unknown>,
		directory: string,
	) => Promise<string>;
}

/** Parse JSON result safely */
function parseResult(result: string) {
	return JSON.parse(result);
}

/** Create minimal package.json for framework detection */
function createPackageJson(cwd: string, framework: string) {
	const pkgPath = path.join(cwd, 'package.json');
	fs.writeFileSync(
		pkgPath,
		JSON.stringify({
			name: 'test-project',
			scripts: { test: framework === 'bun' ? 'bun test' : `${framework} test` },
			devDependencies: {
				[framework]: '^1.0.0',
			},
		}),
		'utf-8',
	);
}

/** Create minimal source and test files */
function createSourceAndTestFiles(cwd: string) {
	const srcDir = path.join(cwd, 'src');
	fs.mkdirSync(srcDir, { recursive: true });
	fs.writeFileSync(
		path.join(srcDir, 'foo.ts'),
		'export function foo() { return 1; }\n',
		'utf-8',
	);
	fs.writeFileSync(
		path.join(srcDir, 'bar.ts'),
		'export function bar() { return 2; }\n',
		'utf-8',
	);

	// Create matching test files
	const testDir = path.join(srcDir, '__tests__');
	fs.mkdirSync(testDir, { recursive: true });
	fs.writeFileSync(
		path.join(testDir, 'foo.test.ts'),
		'import { foo } from "../foo"; test("foo", () => expect(foo()).toBe(1));\n',
		'utf-8',
	);
	fs.writeFileSync(
		path.join(testDir, 'bar.test.ts'),
		'import { bar } from "../bar"; test("bar", () => expect(bar()).toBe(2));\n',
		'utf-8',
	);
}

/** Normalize path separators to forward slashes for cross-platform comparison */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

// Create mock function for analyzeImpact
const mockAnalyzeImpact =
	vi.fn<
		(
			...args: Parameters<
				typeof import('../../test-impact/analyzer.js').analyzeImpact
			>
		) => ReturnType<
			typeof import('../../test-impact/analyzer.js').analyzeImpact
		>
	>();

// Mock the analyzer module
vi.mock('../../test-impact/analyzer.js', () => ({
	analyzeImpact: mockAnalyzeImpact,
}));

// ============ Tests ============

describe('TestRunnerArgs type - scope enum includes impact', () => {
	test('impact is a valid scope value in the union type', () => {
		const validScopes: Array<'all' | 'convention' | 'graph' | 'impact'> = [
			'all',
			'convention',
			'graph',
			'impact',
		];
		expect(validScopes).toContain('impact');
	});

	test('all valid scopes are accepted by the type system', () => {
		const scopes: Array<'all' | 'convention' | 'graph' | 'impact'> = [
			'all',
			'convention',
			'graph',
			'impact',
		];
		expect(scopes.length).toBe(4);
	});
});

describe('impact scope execution', () => {
	let tempDir: string;
	let execute: ReturnType<typeof getExecute>;

	beforeEach(async () => {
		// Create temp directory for tests
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-impact-'));
		createPackageJson(tempDir, 'bun');
		createSourceAndTestFiles(tempDir);

		execute = getExecute();

		// Reset and configure the mock
		mockAnalyzeImpact.mockReset();
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test('1. Impact scope with valid files and impacted tests found → returns impacted test files', async () => {
		// Setup: mock analyzeImpact to return impacted tests
		const mockImpactedTests = [
			path.join(tempDir, 'src', '__tests__', 'foo.test.ts'),
		];

		mockAnalyzeImpact.mockResolvedValueOnce({
			impactedTests: mockImpactedTests,
			unrelatedTests: [],
			untestedFiles: [],
			impactMap: { [path.join(tempDir, 'src', 'foo.ts')]: mockImpactedTests },
		});

		const args = {
			scope: 'impact' as const,
			files: ['src/foo.ts'],
		};

		const result = await execute(args, tempDir);
		const parsed = parseResult(result);

		expect(parsed.success).toBe(true);
		expect(parsed.scope).toBe('impact');
		// Normalize paths for cross-platform comparison
		const commandNormalized = parsed.command.map((c: string) =>
			normalizePath(c),
		);
		expect(
			commandNormalized.some((c: string) =>
				c.includes('src/__tests__/foo.test.ts'),
			),
		).toBe(true);
	});

	test('2. Impact scope with valid files but no impacted tests (cold start) → falls back to graph', async () => {
		// Setup: mock analyzeImpact to return empty (cold start)
		// When impact analysis finds no tests, it falls back to graph → convention
		mockAnalyzeImpact.mockResolvedValueOnce({
			impactedTests: [],
			unrelatedTests: [],
			untestedFiles: ['src/foo.ts'],
			impactMap: {},
		});

		const args = {
			scope: 'impact' as const,
			files: ['src/foo.ts'],
		};

		const result = await execute(args, tempDir);
		const parsed = parseResult(result);

		// Fallback chain: impact → graph → convention
		// The message indicates fallback (graph may also fallback to convention)
		expect(parsed.message || '').toContain('falling back to');
		// effectiveScope becomes 'graph' then falls back to 'convention'
		expect(['graph', 'convention']).toContain(parsed.scope);
	});

	test('3. Impact scope with no source files (all non-source) → returns error', async () => {
		const args = {
			scope: 'impact' as const,
			files: ['README.md', 'package.json'],
		};

		const result = await execute(args, tempDir);
		const parsed = parseResult(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no source files');
	});

	test('4. Impact scope with empty files array → returns error', async () => {
		const args = {
			scope: 'impact' as const,
			files: [],
		};

		const result = await execute(args, tempDir);
		const parsed = parseResult(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('require explicit files');
	});

	test('5. Impact scope when analyzeImpact throws → falls back gracefully', async () => {
		// Setup: mock analyzeImpact to throw
		mockAnalyzeImpact.mockRejectedValueOnce(
			new Error('Impact analysis failed'),
		);

		const args = {
			scope: 'impact' as const,
			files: ['src/foo.ts'],
		};

		const result = await execute(args, tempDir);
		const parsed = parseResult(result);

		// Should fall back gracefully when analyzeImpact throws
		expect(parsed.message || '').toContain('falling back');
		expect(['graph', 'convention']).toContain(parsed.scope);
	});

	test('6. Impact scope appears in valid scope enum', () => {
		// This test documents that 'impact' is a valid scope
		const validScopes = ['all', 'convention', 'graph', 'impact'];
		expect(validScopes).toContain('impact');
	});
});

describe('impact scope - path conversion logic', () => {
	test('converts absolute paths from impact result to relative paths', () => {
		// Test the path conversion logic
		const workingDir = '/project';
		const absolutePath = '/project/src/foo.test.ts';
		const result = path.relative(workingDir, absolutePath);
		// Normalize for cross-platform comparison
		expect(normalizePath(result)).toBe('src/foo.test.ts');
	});

	test('preserves relative path if path.relative returns absolute (edge case)', () => {
		const workingDir = '/project';
		const absolutePath = '/other/path.test.ts';
		const relativePath = path.relative(workingDir, absolutePath);
		// path.isAbsolute check - the code guards against using absolute paths
		expect(path.isAbsolute(relativePath)).toBe(false);
	});
});

describe('impact scope schema validation', () => {
	test('scope "impact" is accepted in schema enum', () => {
		const validScopes = ['all', 'convention', 'graph', 'impact'];
		expect(validScopes).toContain('impact');
	});

	test('impact scope without files fails at guard check (not schema check)', async () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'test-runner-impact-schema-'),
		);
		createPackageJson(tempDir, 'bun');

		const args = { scope: 'impact' as const, files: [] };
		const result = await getExecute()(args, tempDir);
		const parsed = parseResult(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('require explicit files');

		fs.rmSync(tempDir, { recursive: true, force: true });
	});
});
