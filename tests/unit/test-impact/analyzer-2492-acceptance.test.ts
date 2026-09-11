import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	analyzeImpact,
	buildImpactMap,
	loadImpactMap,
} from '../../../src/test-impact/analyzer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
let originalLoadImpactMap: typeof _internals.loadImpactMap;

beforeEach(() => {
	tempDir = canonicalMkdtemp('impact-2492-');
	originalLoadImpactMap = _internals.loadImpactMap;
});

afterEach(() => {
	_internals.loadImpactMap = originalLoadImpactMap;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function normalized(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

describe('issue #2492: impact analysis acceptance', () => {
	test('the unique-test budget ignores duplicate shared edges', async () => {
		const shared = 'tests/shared.test.ts';
		const unique = 'tests/unique.test.ts';
		const impactMap = {
			[path.join(tempDir, 'src', 'a.ts')]: [shared],
			[path.join(tempDir, 'src', 'b.ts')]: [shared],
			[path.join(tempDir, 'src', 'c.ts')]: [unique],
		};
		_internals.loadImpactMap = async () => impactMap;

		const result = await analyzeImpact(
			[
				path.join(tempDir, 'src', 'a.ts'),
				path.join(tempDir, 'src', 'b.ts'),
				path.join(tempDir, 'src', 'c.ts'),
			],
			tempDir,
			2,
		);

		expect(result.impactedTests).toEqual([shared, unique]);
		expect(result.budgetExceeded).toBe(false);
	});

	test('changing a test import invalidates the impact cache before reuse', async () => {
		const sourceDir = path.join(tempDir, 'src');
		fs.mkdirSync(sourceDir, { recursive: true });
		const foo = path.join(sourceDir, 'foo.ts');
		const bar = path.join(sourceDir, 'bar.ts');
		const testFile = path.join(sourceDir, 'foo.test.ts');
		fs.writeFileSync(foo, 'export const value = 1;\n');
		fs.writeFileSync(bar, 'export const value = 2;\n');
		fs.writeFileSync(testFile, "import { value } from './foo';\n");

		await buildImpactMap(tempDir);
		const oldTestMtime = fs.statSync(testFile).mtimeMs;
		fs.writeFileSync(testFile, "import { value } from './bar';\n");
		// Ensure the mtime-only invalidation signal is unambiguous on coarse filesystems.
		const future = new Date(oldTestMtime + 2_000);
		fs.utimesSync(testFile, future, future);

		const refreshed = await loadImpactMap(tempDir);
		const fooTests = refreshed[normalized(foo)];
		const barTests = refreshed[normalized(bar)];
		expect(fooTests ?? []).not.toContain(normalized(testFile));
		expect(barTests ?? []).toContain(normalized(testFile));
	});
});
