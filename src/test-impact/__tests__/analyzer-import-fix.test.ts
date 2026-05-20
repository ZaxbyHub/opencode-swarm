import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_internals as analyzerInternals,
	buildImpactMap,
} from '../analyzer.js';

describe('analyzer-import-fix', () => {
	let tempDir: string;
	let savedValidateProjectRoot: typeof analyzerInternals.validateProjectRoot;

	beforeEach(() => {
		// Disable validateProjectRoot for tests using temp dirs under os.tmpdir()
		savedValidateProjectRoot = analyzerInternals.validateProjectRoot;
		analyzerInternals.validateProjectRoot = () => {};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-fix-test-'));
	});

	afterEach(() => {
		analyzerInternals.validateProjectRoot = savedValidateProjectRoot;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('re-export regex captures export...from patterns', () => {
		test('captures export { foo } from "./bar"', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'reexport.test.ts');
			fs.writeFileSync(
				testFile,
				"export { foo } from './bar';\ntest('reexport', () => {});",
			);

			// Create the source file so it can be resolved
			const barFile = path.join(testDir, 'bar.ts');
			fs.writeFileSync(barFile, 'export const foo = 1;');

			const impactMap = await buildImpactMap(tempDir);

			// Should have entry for bar.ts
			const barKey = Object.keys(impactMap).find((k) => k.endsWith('bar.ts'));
			expect(barKey).toBeDefined();
			expect(impactMap[barKey!]).toContain(testFile.replace(/\\/g, '/'));
		});

		test('captures export * from "./baz"', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'reexport.test.ts');
			fs.writeFileSync(
				testFile,
				"export * from './baz';\ntest('reexport', () => {});",
			);

			// Create the source file so it can be resolved
			const bazFile = path.join(testDir, 'baz.ts');
			fs.writeFileSync(bazFile, 'export const baz = 1;');

			const impactMap = await buildImpactMap(tempDir);

			// Should have entry for baz.ts
			const bazKey = Object.keys(impactMap).find((k) => k.endsWith('baz.ts'));
			expect(bazKey).toBeDefined();
			expect(impactMap[bazKey!]).toContain(testFile.replace(/\\/g, '/'));
		});

		test('captures export { default as X } from "./lib"', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'reexport.test.ts');
			fs.writeFileSync(
				testFile,
				"export { default as X } from './lib';\ntest('reexport', () => {});",
			);

			// Create the source file so it can be resolved
			const libFile = path.join(testDir, 'lib.ts');
			fs.writeFileSync(libFile, 'export default 42;');

			const impactMap = await buildImpactMap(tempDir);

			// Should have entry for lib.ts
			const libKey = Object.keys(impactMap).find((k) => k.endsWith('lib.ts'));
			expect(libKey).toBeDefined();
			expect(impactMap[libKey!]).toContain(testFile.replace(/\\/g, '/'));
		});

		test('captures export { foo, bar } from "./multi"', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'reexport.test.ts');
			fs.writeFileSync(
				testFile,
				"export { foo, bar } from './multi';\ntest('reexport', () => {});",
			);

			// Create the source file so it can be resolved
			const multiFile = path.join(testDir, 'multi.ts');
			fs.writeFileSync(
				multiFile,
				'export const foo = 1; export const bar = 2;',
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should have entry for multi.ts
			const multiKey = Object.keys(impactMap).find((k) =>
				k.endsWith('multi.ts'),
			);
			expect(multiKey).toBeDefined();
			expect(impactMap[multiKey!]).toContain(testFile.replace(/\\/g, '/'));
		});

		test('captures all three: import + require + export...from', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'mixed.test.ts');
			fs.writeFileSync(
				testFile,
				`import { foo } from './es-module';
const bar = require('./commonjs');
export { baz } from './reexported';
test('mixed', () => {});`,
			);

			// Create all source files
			const esFile = path.join(testDir, 'es-module.ts');
			const cjsFile = path.join(testDir, 'commonjs.ts');
			const reexFile = path.join(testDir, 'reexported.ts');
			fs.writeFileSync(esFile, 'export const foo = 1;');
			fs.writeFileSync(cjsFile, 'export const bar = 2;');
			fs.writeFileSync(reexFile, 'export const baz = 3;');

			const impactMap = await buildImpactMap(tempDir);

			// Should have entries for all three source files
			const keys = Object.keys(impactMap);
			expect(keys.length).toBe(3);

			const esKey = keys.find((k) => k.endsWith('es-module.ts'));
			const cjsKey = keys.find((k) => k.endsWith('commonjs.ts'));
			const reexKey = keys.find((k) => k.endsWith('reexported.ts'));

			expect(esKey).toBeDefined();
			expect(cjsKey).toBeDefined();
			expect(reexKey).toBeDefined();

			const normalizedTestFile = testFile.replace(/\\/g, '/');
			expect(impactMap[esKey!]).toContain(normalizedTestFile);
			expect(impactMap[cjsKey!]).toContain(normalizedTestFile);
			expect(impactMap[reexKey!]).toContain(normalizedTestFile);
		});
	});

	describe('resolveRelativeImport returns null for non-existent files', () => {
		test('import to non-existent file ./nonexistent returns null (excluded from impact map)', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'phantom.test.ts');
			fs.writeFileSync(
				testFile,
				"import { foo } from './nonexistent';\ntest('phantom', () => {});",
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should NOT have any entries for nonexistent.ts (phantom path)
			const phantomKeys = Object.keys(impactMap).filter((k) =>
				k.includes('nonexistent'),
			);
			expect(phantomKeys.length).toBe(0);

			// The phantom test file itself should not appear in the impact map
			// since it has no resolvable imports
			const allTests = Object.values(impactMap).flat();
			expect(allTests).not.toContain(testFile.replace(/\\/g, '/'));
		});

		test('import to non-existent file ./also-missing.ts returns null (excluded from impact map)', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			const testFile = path.join(testDir, 'phantom.test.ts');
			fs.writeFileSync(
				testFile,
				"import { bar } from './also-missing';\ntest('phantom', () => {});",
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should NOT have any entries for also-missing.ts
			const phantomKeys = Object.keys(impactMap).filter((k) =>
				k.includes('also-missing'),
			);
			expect(phantomKeys.length).toBe(0);
		});

		test('import to existing file returns normalized path (positive case)', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			// Create the test file and source file
			const testFile = path.join(testDir, 'real.test.ts');
			const sourceFile = path.join(testDir, 'real.ts');
			fs.writeFileSync(sourceFile, 'export const real = 1;');
			fs.writeFileSync(
				testFile,
				"import { real } from './real';\ntest('real', () => {});",
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should have entry for real.ts with forward slashes
			const realKey = Object.keys(impactMap).find((k) => k.endsWith('real.ts'));
			expect(realKey).toBeDefined();
			expect(realKey).not.toContain('\\'); // Should use forward slashes

			const normalizedTestFile = testFile.replace(/\\/g, '/');
			expect(impactMap[realKey!]).toContain(normalizedTestFile);
		});
	});

	describe('impact map excludes phantom entries', () => {
		test('test file importing non-existent source creates NO entry in impact map', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			// Create test file that imports a file that doesn't exist
			const phantomTestFile = path.join(testDir, 'phantom-import.test.ts');
			fs.writeFileSync(
				phantomTestFile,
				"import { missing } from './this-does-not-exist';\ntest('phantom', () => {});",
			);

			const impactMap = await buildImpactMap(tempDir);

			// No entries should be created for non-existent source files
			// The impact map should be empty since all imports resolve to null
			const entriesForPhantom = Object.keys(impactMap).filter((k) =>
				k.includes('this-does-not-exist'),
			);
			expect(entriesForPhantom.length).toBe(0);

			// Verify the phantom test file itself is not in the values
			const normalizedPhantomTest = phantomTestFile.replace(/\\/g, '/');
			const allReferencedTests = Object.values(impactMap).flat();
			expect(allReferencedTests).not.toContain(normalizedPhantomTest);
		});

		test('test file with mixed valid and invalid imports only includes valid ones', async () => {
			const testDir = path.join(tempDir, '__tests__');
			fs.mkdirSync(testDir, { recursive: true });

			// Create test file with one valid import and one invalid
			const testFile = path.join(testDir, 'mixed.test.ts');
			const validSource = path.join(testDir, 'valid.ts');
			fs.writeFileSync(validSource, 'export const valid = 1;');
			fs.writeFileSync(
				testFile,
				`import { valid } from './valid';
import { invalid } from './non-existent';
test('mixed', () => {});`,
			);

			const impactMap = await buildImpactMap(tempDir);

			// Should only have entry for valid.ts, not for non-existent
			const validKey = Object.keys(impactMap).find((k) =>
				k.endsWith('valid.ts'),
			);
			expect(validKey).toBeDefined();

			const invalidKeys = Object.keys(impactMap).filter((k) =>
				k.includes('non-existent'),
			);
			expect(invalidKeys.length).toBe(0);
		});
	});
});
