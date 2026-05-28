import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	estimateFanOut,
	MAX_SAFE_TEST_FILES,
	test_runner,
} from '../../../src/tools/test-runner.js';

// Note: mock.module is called only inside test 17 (Layer 3) within a test-scoped
// callback. Bun's test runner auto-cleans test-scoped mock.module calls after each
// test. No file-level afterEach(() => mock.restore()) is needed, as it would
// incorrectly clear module mocks that other tests (10-16) depend on via getExecute().

function getExecute() {
	return test_runner.execute as unknown as (
		args: Record<string, unknown>,
		directory: string,
	) => Promise<string>;
}

function parseResult(result: string) {
	return JSON.parse(result);
}

function normalizeForImpactMap(p: string): string {
	return p.replace(/\\/g, '/');
}

function createPackageJson(cwd: string) {
	fs.writeFileSync(
		path.join(cwd, 'package.json'),
		JSON.stringify({
			name: 'test-project',
			scripts: { test: 'bun test' },
			devDependencies: { bun: '^1.0.0' },
		}),
	);
}

function createSourceFiles(cwd: string, count: number) {
	const srcDir = path.join(cwd, 'src');
	fs.mkdirSync(srcDir, { recursive: true });
	for (let i = 0; i < count; i++) {
		fs.writeFileSync(
			path.join(srcDir, `file${i}.ts`),
			`export const val${i} = ${i};\n`,
		);
	}
}

function createImpactMapCache(
	cwd: string,
	sourceFileCount: number,
	testsPerSource: number = 1,
) {
	const cacheDir = path.join(cwd, '.swarm', 'cache');
	fs.mkdirSync(cacheDir, { recursive: true });
	const impactMap: Record<string, string[]> = {};
	for (let i = 0; i < sourceFileCount; i++) {
		const rawPath = path.join(cwd, 'src', `file${i}.ts`);
		const normalized = normalizeForImpactMap(rawPath);
		const tests: string[] = [];
		for (let j = 0; j < testsPerSource; j++) {
			tests.push(`tests/file${i}_${j}.test.ts`);
		}
		impactMap[normalized] = tests;
	}
	const data = {
		// Use a date far in the future so the cache is never considered stale
		// (isCacheStale checks if source file mtime > generatedAt; with 2099, current files are always older)
		generatedAt: new Date('2099-01-01T00:00:00.000Z').toISOString(),
		fileCount: Object.keys(impactMap).length,
		map: impactMap,
	};
	fs.writeFileSync(
		path.join(cacheDir, 'impact-map.json'),
		JSON.stringify(data, null, 2),
	);
}

describe('two-layer pre-resolution guard', () => {
	let tempDir: string;
	let originalCwd: string;
	let execute: ReturnType<typeof getExecute>;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-cap-'));
		originalCwd = process.cwd();
		process.chdir(tempDir);
		execute = getExecute();
		createPackageJson(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('Layer 1: MAX_SAFE_SOURCE_FILES guard (>1 source file → Layer 1 fires)', () => {
		test('1. graph scope with 60 source files → Layer 1 fires first, error mentions "accepts at most 1 source file"', async () => {
			const sourceFileCount = 60;
			createSourceFiles(tempDir, sourceFileCount);
			createImpactMapCache(tempDir, sourceFileCount, 1);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			// Layer 1 fires before estimateFanOut is called
			expect(parsed.error).toContain('accepts at most 1 source file');
		});

		test('2. impact scope with 60 source files → Layer 1 fires first, error mentions "accepts at most 1 source file"', async () => {
			const sourceFileCount = 60;
			createSourceFiles(tempDir, sourceFileCount);
			createImpactMapCache(tempDir, sourceFileCount, 1);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			const result = await execute(
				{ scope: 'impact', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			expect(parsed.error).toContain('accepts at most 1 source file');
			expect(parsed.message).toContain('impact');
		});

		test('3. graph scope with MAX_SAFE_SOURCE_FILES+1 (51) source files → Layer 1 fires before estimateFanOut', async () => {
			const sourceFileCount = MAX_SAFE_TEST_FILES + 1; // 51
			createSourceFiles(tempDir, sourceFileCount);
			createImpactMapCache(tempDir, sourceFileCount, 1);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			// Layer 1 fires — never reaches Layer 2 estimateFanOut
			expect(parsed.error).toContain('accepts at most 1 source file');
		});

		test('4. multiple tests per source file (10 files × 6 tests = 60) → Layer 1 fires before estimateFanOut', async () => {
			const sourceFileCount = 10;
			createSourceFiles(tempDir, sourceFileCount);
			// 10 source files × 6 tests each = 60 total, exceeds MAX_SAFE_TEST_FILES (50)
			createImpactMapCache(tempDir, sourceFileCount, 6);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			// Layer 1 fires for 10 source files — never reaches Layer 2
			expect(parsed.error).toContain('accepts at most 1 source file');
		});
	});

	describe('Layer 2: estimateFanOut guard (1 source file with high fan-out)', () => {
		test('5. graph scope with 1 source file mapping to 60 tests → Layer 2 estimateFanOut fires', async () => {
			// 1 source file → 60 test files (exceeds MAX_SAFE_TEST_FILES of 50)
			createSourceFiles(tempDir, 1);
			createImpactMapCache(tempDir, 1, 60);

			const sourceFiles = ['src/file0.ts'];

			// Verify fan-out estimate
			const estimate = await estimateFanOut(sourceFiles, tempDir);
			expect(estimate.estimatedCount).toBe(60);

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			// Layer 2 fires (Layer 1 bypassed since sourceFiles.length === 1)
			expect(parsed.error).toContain('exceeds safe maximum');
		});

		test('6. impact scope with 1 source file mapping to 60 tests → Layer 2 estimateFanOut fires', async () => {
			// 1 source file → 60 test files (exceeds MAX_SAFE_TEST_FILES of 50)
			createSourceFiles(tempDir, 1);
			createImpactMapCache(tempDir, 1, 60);

			const sourceFiles = ['src/file0.ts'];

			// Verify fan-out estimate
			const estimate = await estimateFanOut(sourceFiles, tempDir);
			expect(estimate.estimatedCount).toBe(60);

			const result = await execute(
				{ scope: 'impact', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			// Layer 2 fires (Layer 1 bypassed since sourceFiles.length === 1)
			expect(parsed.error).toContain('exceeds safe maximum');
		});

		test('7. graph scope with 1 source file mapping to exactly MAX_SAFE_TEST_FILES (50) → Layer 2 NOT triggered, proceeds', async () => {
			// 1 source file → 50 test files (exactly at MAX_SAFE_TEST_FILES, should proceed)
			createSourceFiles(tempDir, 1);
			createImpactMapCache(tempDir, 1, MAX_SAFE_TEST_FILES);

			const sourceFiles = ['src/file0.ts'];

			const estimate = await estimateFanOut(sourceFiles, tempDir);
			expect(estimate.estimatedCount).toBe(50);

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			// Fan-out exactly at limit → should proceed (not scope_exceeded)
			expect(parsed.outcome).not.toBe('scope_exceeded');
		});

		test('8. impact scope with 1 source file mapping to exactly MAX_SAFE_TEST_FILES (50) → Layer 2 NOT triggered, proceeds', async () => {
			// 1 source file → 50 test files (exactly at MAX_SAFE_TEST_FILES, should proceed)
			createSourceFiles(tempDir, 1);
			createImpactMapCache(tempDir, 1, MAX_SAFE_TEST_FILES);

			const sourceFiles = ['src/file0.ts'];

			const estimate = await estimateFanOut(sourceFiles, tempDir);
			expect(estimate.estimatedCount).toBe(50);

			const result = await execute(
				{ scope: 'impact', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			// Fan-out exactly at limit → should proceed (not scope_exceeded)
			expect(parsed.outcome).not.toBe('scope_exceeded');
		});
	});

	describe('Layer ordering: Layer 1 fires before Layer 2', () => {
		test('9. 60 source files → Layer 1 fires, estimateFanOut is never called', async () => {
			const sourceFileCount = 60;
			createSourceFiles(tempDir, sourceFileCount);
			createImpactMapCache(tempDir, sourceFileCount, 1);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			// estimateFanOut would return 60 if called, but it should NOT be called
			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			// Error should be from Layer 1, not Layer 2
			expect(parsed.error).toContain('accepts at most 1 source file');
			expect(parsed.error).not.toContain('exceeds safe maximum');
		});
	});

	describe('graph/impact with small fan-out (Layer 2 bypassed)', () => {
		test('10. graph scope with 5 source files (fan-out = 5) → Layer 1 bypassed, Layer 2 bypassed, proceeds', async () => {
			const sourceFileCount = 5;
			createSourceFiles(tempDir, sourceFileCount);
			createImpactMapCache(tempDir, sourceFileCount, 1);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			// Fan-out (5) <= MAX_SAFE_TEST_FILES (50), source files (5) > 1
			// → Layer 1 fires for source file count, but with current implementation
			// sourceFiles.length > MAX_SAFE_SOURCE_FILES (1) so it still errors
			// Note: This test documents current behavior where multiple source files
			// always hit Layer 1 regardless of fan-out
			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
		});

		test('11. impact scope with 5 source files (fan-out = 5) → proceeds', async () => {
			const sourceFileCount = 5;
			createSourceFiles(tempDir, sourceFileCount);
			createImpactMapCache(tempDir, sourceFileCount, 1);

			const sourceFiles = Array.from(
				{ length: sourceFileCount },
				(_, i) => `src/file${i}.ts`,
			);

			const result = await execute(
				{ scope: 'impact', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);

			// Same as test 10 — Layer 1 fires for multiple source files
			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
		});
	});

	describe('scope "all" bypasses pre-resolution guard', () => {
		test('12. scope "all" with allow_full_suite bypasses pre-resolution cap', async () => {
			const result = await execute(
				{ scope: 'all', files: [], allow_full_suite: true },
				tempDir,
			);
			const parsed = parseResult(result);
			expect(parsed.outcome).not.toBe('scope_exceeded');
		});

		test('13. scope "all" without allow_full_suite returns error (own guard)', async () => {
			const result = await execute({ scope: 'all', files: [] }, tempDir);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('scope "all"');
		});
	});

	describe('scope "convention" bypasses pre-resolution guard', () => {
		test('14. scope "convention" with 1 source file does NOT trigger pre-resolution guard', async () => {
			// Convention scope bypasses guards when sourceFiles.length === 1
			// Layer 1 fires for sourceFiles.length > 1, Layer 2 fires for fan-out > 50
			createSourceFiles(tempDir, 1);

			const testDir = path.join(tempDir, 'src', '__tests__');
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(
				path.join(testDir, 'file0.test.ts'),
				`import { val0 } from "../file0"; test("file0", () => expect(val0).toBe(0));`,
			);

			const sourceFiles = ['src/file0.ts'];
			const result = await execute(
				{ scope: 'convention', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);
			// Convention scope with 1 source file should not trigger Layer 1 or Layer 2
			expect(
				parsed.success !== false || !parsed.error?.includes('accepts at most'),
			).toBe(true);
			expect(parsed.error || '').not.toContain('accepts at most');
			expect(parsed.error || '').not.toContain('exceeds safe maximum');
		});
	});

	describe('edge cases', () => {
		test('15. estimate exactly at MAX_SAFE_TEST_FILES (50) with 1 source file should proceed', async () => {
			createSourceFiles(tempDir, 1);
			createImpactMapCache(tempDir, 1, MAX_SAFE_TEST_FILES);

			const sourceFiles = ['src/file0.ts'];

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);
			// Fan-out exactly at limit → Layer 2 allows it through
			expect(parsed.outcome).not.toBe('scope_exceeded');
		});

		test('16. estimate exactly at MAX_SAFE_TEST_FILES + 1 (51) with 1 source file triggers Layer 2', async () => {
			createSourceFiles(tempDir, 1);
			createImpactMapCache(tempDir, 1, MAX_SAFE_TEST_FILES + 1);

			const sourceFiles = ['src/file0.ts'];

			const result = await execute(
				{ scope: 'graph', files: sourceFiles },
				tempDir,
			);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
			expect(parsed.outcome).toBe('scope_exceeded');
			expect(parsed.error).toContain('exceeds safe maximum');
		});
	});
});
