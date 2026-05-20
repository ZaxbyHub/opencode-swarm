import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWindows = process.platform === 'win32';

// Import the module under test
import {
	analyzeImpact,
	_internals as analyzerInternals,
	buildImpactMap,
	loadImpactMap,
} from '../analyzer.js';

describe('TestImpactAnalyzer', () => {
	let tempDir: string;
	let cacheDir: string;
	let savedValidateProjectRoot: typeof analyzerInternals.validateProjectRoot;

	beforeEach(async () => {
		// Most tests use temp dirs that may have parent .swarm/ (e.g. from the
		// project's own .swarm leaking into os.tmpdir()). Disable the guard so
		// these tests measure impact-map logic, not project-root validation.
		savedValidateProjectRoot = analyzerInternals.validateProjectRoot;
		analyzerInternals.validateProjectRoot = () => {};

		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'impact-test-'));
		cacheDir = path.join(tempDir, '.swarm', 'cache');
	});

	afterEach(async () => {
		analyzerInternals.validateProjectRoot = savedValidateProjectRoot;
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('normalizePath (via buildImpactMap behavior)', () => {
		test('handles Windows backslashes in paths', async () => {
			// Create a test file with imports
			const testDir = path.join(tempDir, 'src', '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const sourceDir = path.join(tempDir, 'src');
			const sourceFile = path.join(sourceDir, 'util.ts');
			await fs.promises.writeFile(
				sourceFile,
				'export function add(a: number, b: number) { return a + b; }',
			);

			const testFile = path.join(testDir, 'util.test.ts');
			await fs.promises.writeFile(
				testFile,
				`import { add } from '../util';\ntest('adds numbers', () => { expect(add(1, 2)).toBe(3); });`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Keys should use forward slashes regardless of platform
			const keys = Object.keys(impactMap);
			expect(keys.length).toBeGreaterThan(0);

			// All paths should use forward slashes
			for (const key of keys) {
				expect(key.includes('\\')).toBe(false);
				expect(key.includes('/')).toBe(true);
			}
		});
	});

	describe('extractImports (via buildImpactMap)', () => {
		test('finds ES import statements', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			// Create source files so imports resolve
			const fooFile = path.join(testDir, 'foo.ts');
			const barFile = path.join(testDir, 'bar.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(barFile, 'export const bar = 2;');

			const testFile = path.join(testDir, 'example.test.ts');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from './foo';
import { bar } from './bar';
test('example', () => {});`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should have entries for both foo and bar
			const keys = Object.keys(impactMap);
			expect(keys.length).toBe(2);
		});

		test('finds require() calls', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			// Create source files so imports resolve
			const fooFile = path.join(testDir, 'foo.ts');
			const barFile = path.join(testDir, 'bar.ts');
			const bazFile = path.join(testDir, 'baz.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(barFile, 'export const bar = 2;');
			await fs.promises.writeFile(bazFile, 'export const baz = 3;');

			const testFile = path.join(testDir, 'example.test.ts');
			await fs.promises.writeFile(
				testFile,
				`const foo = require('./foo');
const bar = require('./bar');
const baz = require('./baz');
test('example', () => {});`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should have entries for foo, bar, and baz
			const keys = Object.keys(impactMap);
			expect(keys.length).toBe(3);
		});

		test('handles mixed ES imports and require() calls', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			// Create source files so imports resolve
			const fooFile = path.join(testDir, 'foo.ts');
			const barFile = path.join(testDir, 'bar.ts');
			const bazFile = path.join(testDir, 'baz.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(barFile, 'export const bar = 2;');
			await fs.promises.writeFile(bazFile, 'export const baz = 3;');

			const testFile = path.join(testDir, 'example.test.ts');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from './foo';
const bar = require('./bar');
import { baz } from './baz';
test('example', () => {});`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should have entries for foo, bar, and baz
			const keys = Object.keys(impactMap);
			expect(keys.length).toBe(3);
		});

		test('returns empty result for file with no imports', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const testFile = path.join(testDir, 'example.test.ts');
			await fs.promises.writeFile(testFile, `test('example', () => {});`);

			const impactMap = await buildImpactMap(tempDir);

			// Test file with no imports should not create any entries
			expect(Object.keys(impactMap).length).toBe(0);
		});
	});

	describe('buildImpactMap', () => {
		test('creates correct source→test mapping', async () => {
			const srcDir = path.join(tempDir, 'src');
			const testDir = path.join(srcDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			// Create source files
			const fooFile = path.join(srcDir, 'foo.ts');
			const barFile = path.join(srcDir, 'bar.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(barFile, 'export const bar = 2;');

			// Create test file that imports both
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
import { bar } from '../bar';
test('foo and bar', () => { expect(foo).toBe(1); });`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Find the entry for foo.ts - should map to the test file
			const fooKey = Object.keys(impactMap).find((k) => k.endsWith('foo.ts'));
			expect(fooKey).toBeDefined();
			// Normalize paths for comparison (impactMap uses forward slashes)
			const normalizedTestFile = testFile.replace(/\\/g, '/');
			expect(impactMap[fooKey!]).toContain(normalizedTestFile);

			// Find the entry for bar.ts - should also map to the same test file
			const barKey = Object.keys(impactMap).find((k) => k.endsWith('bar.ts'));
			expect(barKey).toBeDefined();
			expect(impactMap[barKey!]).toContain(normalizedTestFile);
		});

		test('saves cache to .swarm/cache/impact-map.json', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const testFile = path.join(testDir, 'example.test.ts');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from './foo';
test('example', () => {});`,
			);

			await buildImpactMap(tempDir);

			const cachePath = path.join(cacheDir, 'impact-map.json');
			expect(fs.existsSync(cachePath)).toBe(true);

			const cacheContent = JSON.parse(
				await fs.promises.readFile(cachePath, 'utf-8'),
			);
			expect(cacheContent.generatedAt).toBeDefined();
			expect(cacheContent.fileCount).toBeDefined();
			expect(cacheContent.map).toBeDefined();
		});

		test('skips files in node_modules, dist, .git, .swarm, .cache directories', async () => {
			// Create test files in skipped directories
			const skippedDirs = [
				path.join(tempDir, 'node_modules', 'somepkg'),
				path.join(tempDir, 'dist'),
				path.join(tempDir, '.git'),
				path.join(tempDir, '.swarm'),
				path.join(tempDir, '.cache'),
			];

			for (const dir of skippedDirs) {
				await fs.promises.mkdir(dir, { recursive: true });
				const testFile = path.join(dir, 'should-skip.test.ts');
				// Create source file that this test would import
				const sourceFile = path.join(dir, 'source.ts');
				await fs.promises.writeFile(sourceFile, 'export const x = 1;');
				await fs.promises.writeFile(
					testFile,
					`import { x } from './source';
test('skip', () => { expect(x).toBe(1); });`,
				);
			}

			// Create a valid test file with import
			const validTestDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(validTestDir, { recursive: true });
			const validTestFile = path.join(validTestDir, 'valid.test.ts');
			const validSourceFile = path.join(validTestDir, 'valid.ts');
			await fs.promises.writeFile(validSourceFile, 'export const y = 2;');
			await fs.promises.writeFile(
				validTestFile,
				`import { y } from './valid';
test('valid', () => { expect(y).toBe(2); });`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should only find the valid test file (skipped dirs' tests not included)
			const allTests = Object.values(impactMap).flat();
			expect(allTests.length).toBe(1);
			expect(allTests[0].replace(/\\/g, '/')).toEndWith('valid.test.ts');
		});

		test('handles .test.ts and .spec.ts files', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			// Create source files
			const source1 = path.join(testDir, 'one.ts');
			const source2 = path.join(testDir, 'two.ts');
			await fs.promises.writeFile(source1, 'export const a = 1;');
			await fs.promises.writeFile(source2, 'export const b = 2;');

			const test1 = path.join(testDir, 'one.test.ts');
			const test2 = path.join(testDir, 'two.spec.ts');
			await fs.promises.writeFile(
				test1,
				`import { a } from './one';
test('test', () => { expect(a).toBe(1); });`,
			);
			await fs.promises.writeFile(
				test2,
				`import { b } from './two';
test('spec', () => { expect(b).toBe(2); });`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should find both test files
			const allTests = Object.values(impactMap).flat();
			expect(allTests.length).toBe(2);
		});
	});

	describe('loadImpactMap', () => {
		test('returns cached data when available', async () => {
			// First build to create cache
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const fooFile = path.join(tempDir, 'foo.ts');
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
test('foo', () => { expect(foo).toBe(1); });`,
			);

			// Build and modify cache to verify it's loaded
			await buildImpactMap(tempDir);

			const cachePath = path.join(cacheDir, 'impact-map.json');
			const cacheContent = JSON.parse(
				await fs.promises.readFile(cachePath, 'utf-8'),
			);
			const _originalGeneratedAt = cacheContent.generatedAt;

			// Wait a tiny bit so the timestamp would differ if rebuilt
			await new Promise((r) => setTimeout(r, 10));

			// Load should return cached data
			const loaded1 = await loadImpactMap(tempDir);

			// Verify the map structure matches what was cached
			expect(Object.keys(loaded1).length).toBeGreaterThan(0);

			// Create a real source file to use in modified cache
			const fakeSourceFile = path.join(tempDir, 'fakeSource.ts');
			await fs.promises.writeFile(fakeSourceFile, 'export const fake = 1;');

			// Modify the cache file with a real path and future generatedAt
			await fs.promises.writeFile(
				cachePath,
				JSON.stringify({
					generatedAt: new Date(Date.now() + 10000).toISOString(),
					fileCount: 999,
					map: { [fakeSourceFile]: [testFile] },
				}),
			);

			// Load should return the modified cache (not rebuilt)
			const loaded2 = await loadImpactMap(tempDir);
			expect(loaded2[fakeSourceFile]).toEqual([testFile]);
		});

		test('rebuilds when cache missing', async () => {
			// Don't create any cache - it should rebuild
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const fooFile = path.join(tempDir, 'foo.ts');
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
test('foo', () => { expect(foo).toBe(1); });`,
			);

			const loaded = await loadImpactMap(tempDir);

			// Should have rebuilt the map correctly
			const fooKey = Object.keys(loaded).find((k) => k.endsWith('foo.ts'));
			expect(fooKey).toBeDefined();
		});

		test('rebuilds when cache is corrupted', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const fooFile = path.join(tempDir, 'foo.ts');
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
test('foo', () => { expect(foo).toBe(1); });`,
			);

			// Create corrupted cache
			const cachePath = path.join(cacheDir, 'impact-map.json');
			await fs.promises.mkdir(cacheDir, { recursive: true });
			await fs.promises.writeFile(cachePath, 'not valid json {{{');

			const loaded = await loadImpactMap(tempDir);

			// Should have rebuilt correctly despite corruption
			const fooKey = Object.keys(loaded).find((k) => k.endsWith('foo.ts'));
			expect(fooKey).toBeDefined();
		});
	});

	describe('analyzeImpact', () => {
		test('returns impacted tests for changed files', async () => {
			const srcDir = path.join(tempDir, 'src');
			const testDir = path.join(srcDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const fooFile = path.join(srcDir, 'foo.ts');
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
test('foo', () => { expect(foo).toBe(1); });`,
			);

			const result = await analyzeImpact([fooFile], tempDir);

			expect(result.impactedTests.length).toBe(1);
			expect(result.impactedTests[0]).toEndWith('foo.test.ts');
			expect(result.untestedFiles).toEqual([]);
		});

		test('identifies untested files', async () => {
			const srcDir = path.join(tempDir, 'src');
			await fs.promises.mkdir(srcDir, { recursive: true });

			// Create a file with no corresponding test
			const untestedFile = path.join(srcDir, 'untested.ts');
			await fs.promises.writeFile(untestedFile, 'export const x = 1;');

			const result = await analyzeImpact([untestedFile], tempDir);

			expect(result.impactedTests).toEqual([]);
			expect(result.untestedFiles.length).toBe(1);
		});

		test('handles fallback path matching', async () => {
			// Create test file in __tests__ that imports a source file at root
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			// Create test file that imports a relative path without extension
			const testFile = path.join(testDir, 'util.test.ts');
			// Create the source file in same dir as test (since import is ./util)
			const utilFile = path.join(testDir, 'util.ts');
			await fs.promises.writeFile(utilFile, 'export const util = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { util } from './util';
test('util', () => { expect(util).toBe(1); });`,
			);

			const result = await analyzeImpact([utilFile], tempDir);

			expect(result.impactedTests.length).toBe(1);
			expect(result.untestedFiles).toEqual([]);
		});

		test('handles empty changedFiles array', async () => {
			const result = await analyzeImpact([], tempDir);

			expect(result.impactedTests).toEqual([]);
			expect(result.unrelatedTests).toEqual([]);
			expect(result.untestedFiles).toEqual([]);
		});

		test('returns correct impactMap in result', async () => {
			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const fooFile = path.join(tempDir, 'foo.ts');
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
test('foo', () => { expect(foo).toBe(1); });`,
			);

			const result = await analyzeImpact([fooFile], tempDir);

			expect(result.impactMap).toBeDefined();
			expect(typeof result.impactMap).toBe('object');
		});

		test('handles multiple changed files with same test', async () => {
			const srcDir = path.join(tempDir, 'src');
			const testDir = path.join(srcDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const fooFile = path.join(srcDir, 'foo.ts');
			const barFile = path.join(srcDir, 'bar.ts');
			const testFile = path.join(testDir, 'foo.test.ts');
			await fs.promises.writeFile(fooFile, 'export const foo = 1;');
			await fs.promises.writeFile(barFile, 'export const bar = 2;');
			await fs.promises.writeFile(
				testFile,
				`import { foo } from '../foo';
import { bar } from '../bar';
test('both', () => { expect(foo).toBe(1); });`,
			);

			const result = await analyzeImpact([fooFile, barFile], tempDir);

			// Both files should map to the same test
			expect(result.impactedTests.length).toBe(1);
			expect(result.impactedTests[0]).toEndWith('foo.test.ts');
		});
	});

	describe('path normalization across platforms', () => {
		test('impactMap keys use forward slashes on Windows', async () => {
			if (!isWindows) {
				test.skip('Windows-specific test', () => {});
				return;
			}

			const testDir = path.join(tempDir, '__tests__');
			await fs.promises.mkdir(testDir, { recursive: true });

			const testFile = path.join(testDir, 'example.test.ts');
			const sourceFile = path.join(tempDir, 'example.ts');
			await fs.promises.writeFile(sourceFile, 'export const x = 1;');
			await fs.promises.writeFile(
				testFile,
				`import { x } from '../example';
test('ex', () => { expect(x).toBe(1); });`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Keys should be normalized to forward slashes
			for (const key of Object.keys(impactMap)) {
				expect(key.includes('\\')).toBe(false);
			}
		});
	});

	describe('validateProjectRoot guard', () => {
		test('buildImpactMap throws when validateProjectRoot rejects directory', async () => {
			const savedValidate = analyzerInternals.validateProjectRoot;
			afterEach(() => {
				analyzerInternals.validateProjectRoot = savedValidate;
			});

			analyzerInternals.validateProjectRoot = () => {
				throw new Error(
					'Cannot write evidence in "/project/sub" — parent directory "/project" already contains a .swarm/ folder. Evidence must be written to the project root.',
				);
			};

			await expect(buildImpactMap(tempDir)).rejects.toThrow(
				'already contains a .swarm/ folder',
			);
		});

		test('saveImpactMap throws when validateProjectRoot rejects directory', async () => {
			const savedValidate = analyzerInternals.validateProjectRoot;
			afterEach(() => {
				analyzerInternals.validateProjectRoot = savedValidate;
			});

			analyzerInternals.validateProjectRoot = () => {
				throw new Error(
					'Cannot write evidence in "/project/sub" — parent "/project" already contains a .swarm/ folder. Evidence must be written to the project root.',
				);
			};

			await expect(
				analyzerInternals.saveImpactMap(tempDir, {}),
			).rejects.toThrow('already contains a .swarm/ folder');
		});
	});
});

// Helper matcher for path ending
expect.extend({
	toEndWith(received: unknown, suffix: string): any {
		const str = String(received);
		const pass = str.endsWith(suffix);
		return {
			pass,
			message: () =>
				`expected ${str} to ${pass ? 'not end' : 'end'} with ${suffix}`,
		};
	},
});
