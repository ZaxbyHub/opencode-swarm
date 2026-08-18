import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Guard for the CLI's PACKAGE_ROOT arithmetic (PR #2226 regression).
 *
 * `src/cli/index.ts` sits one directory deeper than the main plugin entry:
 *   - main entry  builds to  <root>/dist/index.js      (src/index.ts)
 *   - CLI  entry  builds to  <root>/dist/cli/index.js  (src/cli/index.ts)
 *
 * Copying `src/index.ts`'s single `'..'` into the CLI resolves PACKAGE_ROOT to
 * `<root>/dist` (built) or `<root>/src` (dev). Both are wrong, and both fail
 * SILENTLY: `performBundledProjectSkillSyncAsync` looks for a nonexistent
 * `<packageRoot>/.opencode/skills` and no-ops, while `gate-audit` overrides its
 * correct DEFAULT_PACKAGE_ROOT with a path that hard-throws ENOENT.
 *
 * These tests derive the level count from the actual source expression rather
 * than restating it, so they fail if the arity regresses.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_SOURCE = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

/** Directories this module can run from: dev (bun src) and built (bin). */
const RUNTIME_MODULE_DIRS = [
	path.join(REPO_ROOT, 'src', 'cli'),
	path.join(REPO_ROOT, 'dist', 'cli'),
];

/** Count the `'..'` segments in the PACKAGE_ROOT expression as shipped. */
function parsePackageRootLevels(source: string): number {
	const match = source.match(
		/const\s+PACKAGE_ROOT\s*=\s*path\.resolve\(([\s\S]*?)\);/,
	);
	if (!match) throw new Error('PACKAGE_ROOT expression not found');
	return (match[1].match(/'\.\.'/g) ?? []).length;
}

describe('CLI PACKAGE_ROOT resolution', () => {
	const source = readFileSync(CLI_SOURCE, 'utf-8');
	const levels = parsePackageRootLevels(source);

	it('is derived from import.meta.url, not cwd', () => {
		expect(source).toContain('fileURLToPath(import.meta.url)');
	});

	it('walks up two levels (cli/ is one deeper than the main entry)', () => {
		expect(levels).toBe(2);
	});

	it.each(
		RUNTIME_MODULE_DIRS,
	)('resolves to the real package root from %s', (moduleDir) => {
		const resolved = path.resolve(moduleDir, ...Array(levels).fill('..'));

		expect(resolved).toBe(REPO_ROOT);

		// The package root must actually look like this package...
		const manifest = path.join(resolved, 'package.json');
		expect(existsSync(manifest)).toBe(true);
		expect(JSON.parse(readFileSync(manifest, 'utf-8')).name).toBe(
			'opencode-swarm',
		);

		// ...and must contain the bundled-skill source tree the sync reads,
		// which is the exact lookup that silently no-oped with a wrong root.
		expect(existsSync(path.join(resolved, '.opencode', 'skills'))).toBe(true);
	});

	it('would not resolve correctly with a single level (regression pin)', () => {
		for (const moduleDir of RUNTIME_MODULE_DIRS) {
			const wrong = path.resolve(moduleDir, '..');
			expect(wrong).not.toBe(REPO_ROOT);
			expect(existsSync(path.join(wrong, '.opencode', 'skills'))).toBe(false);
		}
	});
});
