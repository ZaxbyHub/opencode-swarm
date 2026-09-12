import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals as analyzerInternals } from '../analyzer.js';

/**
 * Impact-cache test-side staleness (issue #2492 AC5): changing ONLY a test
 * file (imports or content) must refresh the affected source/test mapping —
 * the staleness check covers the mapped test side, mirroring the source side
 * (analyzer.ts deletion handling included). Mirrors frozen check
 * c5-test-side-cache-staleness.ts.
 */

const { loadImpactMap } = analyzerInternals as unknown as {
	loadImpactMap: (dir: string) => Promise<Record<string, string[]>>;
};

function makeFixture(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'impact-stale-')),
	);
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
	fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
	fs.writeFileSync(
		path.join(dir, 'tests/a.test.ts'),
		"const { a } = require('../src/a');\n",
	);
	return dir;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

describe('impact-cache test-side staleness (issue #2492 AC5)', () => {
	test('a test-file-only import change refreshes the source/test mapping', async () => {
		const dir = makeFixture();
		// Build the map: a.ts -> tests/a.test.ts
		const map1 = await loadImpactMap(dir);
		expect(map1[norm(path.join(dir, 'src/a.ts'))]).toBeDefined();

		// Repoint the test's import from src/a.ts to src/b.ts — ONLY the test
		// file changes; every source mtime stays older than the cache.
		fs.writeFileSync(
			path.join(dir, 'tests/a.test.ts'),
			"const { b } = require('../src/b');\n",
		);

		const map2 = await loadImpactMap(dir);
		// The stale map must NOT be served: after the refresh, b.ts carries the
		// test (the exact audit-proven stale-map scenario).
		expect(map2[norm(path.join(dir, 'src/b.ts'))]).toBeDefined();
	}, 30_000);

	test('deleting a mapped test file marks the cache stale (rebuild drops it)', async () => {
		const dir = makeFixture();
		const map1 = await loadImpactDir(dir);
		expect(map1[norm(path.join(dir, 'src/a.ts'))]).toBeDefined();
		fs.rmSync(path.join(dir, 'tests/a.test.ts'));
		const map2 = await loadImpactDir(dir);
		expect(map2[norm(path.join(dir, 'src/a.ts'))]).toBeUndefined();
	}, 30_000);

	test('missing cache takes the bounded rebuild path (preserving)', async () => {
		const dir = makeFixture();
		const map = await loadImpactDir(dir);
		expect(Object.keys(map).length).toBeGreaterThan(0);
	}, 30_000);
});

async function loadImpactDir(dir: string): Promise<Record<string, string[]>> {
	return loadImpactMap(dir);
}
