import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeImpact, buildImpactMap } from '../analyzer';

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-adversarial-'));
	return dir;
}

function cleanup(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

describe('analyzeImpact — adversarial inputs', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tempDir);
	});

	// 1. Path traversal in changedFiles
	test('handles path traversal attempts in changedFiles', async () => {
		const result = await analyzeImpact(
			['../etc/passwd', '../../../root/.ssh/id_rsa'],
			tempDir,
		);
		// Should not crash, should return valid result with path traversal attempts as untested
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
		expect(result).toHaveProperty('impactMap');
		expect(Array.isArray(result.impactedTests)).toBe(true);
		expect(Array.isArray(result.untestedFiles)).toBe(true);
		expect(Array.isArray(result.impactMap)).toBe(false); // should be object
	});

	// 2. Empty string in changedFiles array
	test('handles empty string in changedFiles', async () => {
		const result = await analyzeImpact([''], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
		expect(result).toHaveProperty('impactMap');
		// Empty strings are filtered out as invalid inputs
		expect(result.untestedFiles).not.toContain('');
		expect(result.impactedTests).toEqual([]);
	});

	// 3. Non-string types in changedFiles (numbers, null, undefined)
	test('handles non-string types in changedFiles', async () => {
		// @ts-expect-error - testing runtime behavior with invalid input
		const result1 = await analyzeImpact([42, null, undefined, NaN], tempDir);
		expect(result1).toHaveProperty('impactedTests');
		expect(result1).toHaveProperty('untestedFiles');
		// Should not crash with type coercion
		expect(Array.isArray(result1.impactedTests)).toBe(true);
	});

	// 4. Extremely long file paths (10000+ chars)
	test('handles extremely long file paths', async () => {
		const longPath = 'a'.repeat(10000);
		const result = await analyzeImpact([longPath], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
		expect(result.untestedFiles).toContain(longPath);
	});

	// 5. Files with special characters (spaces, unicode, null bytes)
	test('handles filenames with spaces', async () => {
		const specialDir = path.join(tempDir, 'dir with spaces');
		fs.mkdirSync(specialDir, { recursive: true });
		const testFile = path.join(specialDir, 'test file.ts');
		fs.writeFileSync(testFile, "import { foo } from './foo';\n");
		const result = await analyzeImpact([testFile], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles filenames with unicode characters', async () => {
		const specialDir = path.join(tempDir, 'dír with ünîcödë');
		fs.mkdirSync(specialDir, { recursive: true });
		const testFile = path.join(specialDir, 'tëst-fïlé.ts');
		fs.writeFileSync(testFile, "import { foo } from './foo';\n");
		const result = await analyzeImpact([testFile], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles filenames with null bytes gracefully', async () => {
		// Null byte in filename - create a file with null byte in name (on supported systems)
		// This tests the module's resilience to malformed paths
		const nullPath = path.join(tempDir, 'file\x00null.txt');
		const result = await analyzeImpact([nullPath], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
		// Should not crash
	});

	// 6. Circular symlink directories (prevent infinite recursion)
	test('handles circular symlink directories without infinite loop', async () => {
		const dirA = path.join(tempDir, 'dirA');
		const dirB = path.join(tempDir, 'dirB');
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });

		// Create circular symlinks
		const linkA = path.join(dirA, 'linkToB');
		const linkB = path.join(dirB, 'linkToA');
		fs.symlinkSync(dirB, linkA);
		fs.symlinkSync(dirA, linkB);

		// This should not hang or crash
		const startTime = Date.now();
		const result = await analyzeImpact(['someFile.ts'], tempDir);
		const elapsed = Date.now() - startTime;

		// Should complete in reasonable time (< 5 seconds)
		expect(elapsed).toBeLessThan(5000);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	// 7. Binary files in test directories (should be skipped gracefully)
	test('handles binary files in test directories gracefully', async () => {
		const testDir = path.join(tempDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });

		// Create a binary file disguised as a test
		const binaryContent = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		fs.writeFileSync(path.join(testDir, 'fake.test.js'), binaryContent);

		// This should not crash
		const result = await analyzeImpact([], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result.impactMap).toBeDefined();
	});

	// 8. Malformed import statements
	test('handles truncated import statements', async () => {
		const testDir = path.join(tempDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });

		// Truncated import
		fs.writeFileSync(
			path.join(testDir, 'truncated.test.ts'),
			"import { foo } from './foo',\n",
		);

		const result = await analyzeImpact([], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('impactMap');
	});

	test('handles multiline import statements', async () => {
		const testDir = path.join(tempDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });

		// Multiline import
		fs.writeFileSync(
			path.join(testDir, 'multiline.test.ts'),
			`import {
				foo,
				bar
			} from './utils';`,
		);

		const result = await analyzeImpact([], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('impactMap');
	});

	test('handles template literal imports', async () => {
		const testDir = path.join(tempDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });

		// Template literal in import (edge case)
		fs.writeFileSync(
			path.join(testDir, 'template.test.ts'),
			'import { foo } from `./foo`;\n',
		);

		const result = await analyzeImpact([], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('impactMap');
	});

	// 9. Massively nested directory structures (depth 100+)
	test('handles deeply nested directory structures', async () => {
		// Create a test file 100 levels deep
		let currentDir = tempDir;
		for (let i = 0; i < 100; i++) {
			currentDir = path.join(currentDir, `level${i}`);
		}
		fs.mkdirSync(currentDir, { recursive: true });

		const testDir = path.join(currentDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });
		fs.writeFileSync(
			path.join(testDir, 'deep.test.ts'),
			"import { foo } from './foo';\n",
		);

		// This should not crash or hang
		const startTime = Date.now();
		const result = await analyzeImpact([], tempDir);
		const elapsed = Date.now() - startTime;

		expect(elapsed).toBeLessThan(10000); // Should complete in < 10 seconds
		expect(result).toHaveProperty('impactedTests');
	});

	// 10. Concurrent cache writes
	test('handles concurrent buildImpactMap calls gracefully', async () => {
		// Create a test file
		const testDir = path.join(tempDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });
		fs.writeFileSync(
			path.join(testDir, 'concurrent.test.ts'),
			"import { foo } from './foo';\n",
		);

		// Run two buildImpactMap calls concurrently
		const [result1, result2] = await Promise.all([
			buildImpactMap(tempDir),
			buildImpactMap(tempDir),
		]);

		expect(result1).toBeDefined();
		expect(result2).toBeDefined();
		// Both should return valid impact maps
		expect(typeof result1).toBe('object');
		expect(typeof result2).toBe('object');
	});

	// Additional edge cases

	test('handles empty changedFiles array', async () => {
		const result = await analyzeImpact([], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
		expect(result.impactedTests).toEqual([]);
	});

	test('handles non-existent cwd gracefully', async () => {
		const nonExistent = path.join(tempDir, 'non-existent-dir-12345');
		const result = await analyzeImpact(['someFile.ts'], nonExistent);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles files with only whitespace content', async () => {
		const testDir = path.join(tempDir, '__tests__');
		fs.mkdirSync(testDir, { recursive: true });
		fs.writeFileSync(path.join(testDir, 'whitespace.test.ts'), '   \n\n\n  \n');

		const result = await analyzeImpact([], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result.impactMap).toBeDefined();
	});

	test('handles duplicate changedFiles entries', async () => {
		const result = await analyzeImpact(
			['file.ts', 'file.ts', 'file.ts'],
			tempDir,
		);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
		// Should not duplicate results
	});

	test('handles array-like objects passed as changedFiles', async () => {
		// @ts-expect-error - testing runtime behavior
		const result = await analyzeImpact({ 0: 'file.ts', length: 1 }, tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles Symbol in changedFiles', async () => {
		// @ts-expect-error - testing runtime behavior
		const result = await analyzeImpact([Symbol('test')], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles objects with toString in changedFiles', async () => {
		const obj = { toString: () => 'mapped-file.ts' };
		// @ts-expect-error - testing runtime behavior
		const result = await analyzeImpact([obj], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles negative numbers in changedFiles', async () => {
		// @ts-expect-error - testing runtime behavior
		const result = await analyzeImpact([-1, -100], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles Infinity and -Infinity in changedFiles', async () => {
		// @ts-expect-error - testing runtime behavior
		const result = await analyzeImpact([Infinity, -Infinity], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});

	test('handles arrays with holes in changedFiles', async () => {
		const result = await analyzeImpact([, 1, , 2] as any[], tempDir);
		expect(result).toHaveProperty('impactedTests');
		expect(result).toHaveProperty('untestedFiles');
	});
});
