import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildTypescriptBackend,
	_internals as tsInternals,
} from '../../../src/lang/backends/typescript';

/**
 * Locks in the regression guards from Phase 2 reviewer feedback:
 *   - extractImports must cover ES, BARE, REQUIRE, DYNAMIC, REEXPORT
 *     (matching `src/test-impact/analyzer.ts:11–14`'s ES + REQUIRE +
 *     REEXPORT plus BARE + DYNAMIC for graph completeness).
 *   - selectTestFramework must fall back to devDependencies when
 *     scripts.test does not match (mirroring `test-runner.ts:309–312`),
 *     not just stop at scripts.test.
 */

describe('typescript backend — extractImports', () => {
	const backend = buildTypescriptBackend();

	test('captures ES6 named imports', () => {
		const out = backend.extractImports!(
			'foo.ts',
			"import { x, y } from 'foo';\nimport z from 'bar';",
		);
		expect(out).toEqual(expect.arrayContaining(['foo', 'bar']));
	});

	test('captures bare side-effect imports', () => {
		const out = backend.extractImports!('foo.ts', "import 'side-effect';");
		expect(out).toContain('side-effect');
	});

	test('captures CommonJS require', () => {
		const out = backend.extractImports!(
			'foo.ts',
			"const x = require('cjs-mod'); const y = require( 'spaced' );",
		);
		expect(out).toEqual(expect.arrayContaining(['cjs-mod', 'spaced']));
	});

	test('captures dynamic import()', () => {
		const out = backend.extractImports!(
			'foo.ts',
			"const m = await import('dyn'); const n = await import( 'spaced-dyn' );",
		);
		expect(out).toEqual(expect.arrayContaining(['dyn', 'spaced-dyn']));
	});

	test('captures re-exports (regression guard for analyzer.ts parity)', () => {
		// Without REEXPORT support, Phase 3's wired analyzer would silently
		// shrink the impact graph. See reviewer feedback for Phase 2.
		const out = backend.extractImports!(
			'foo.ts',
			"export { a, b } from 'reexp-named';\nexport * from 'reexp-star';",
		);
		expect(out).toEqual(expect.arrayContaining(['reexp-named', 'reexp-star']));
	});

	test('returns unique imports (no duplicates from multiple regex matches)', () => {
		const out = backend.extractImports!(
			'foo.ts',
			"import { x } from 'same'; import { y } from 'same';",
		);
		expect(out.filter((p) => p === 'same')).toHaveLength(1);
	});
});

describe('typescript backend — selectTestFramework', () => {
	let tempDir: string;
	const backend = buildTypescriptBackend();

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'ts-backend-test-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('returns null when no package.json (and no profile detect-files)', async () => {
		const sel = await backend.selectTestFramework!(tempDir);
		expect(sel).toBeNull();
	});

	test('honors scripts.test when it matches a known framework', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ scripts: { test: 'vitest run' } }),
		);
		const sel = await backend.selectTestFramework!(tempDir);
		expect(sel).not.toBeNull();
		expect(sel!.name).toBe('vitest');
		expect(sel!.detectedVia).toBe('package.json#scripts.test');
	});

	test('falls back to devDependencies when scripts.test is custom (regression guard for test-runner.ts:309-312 parity)', async () => {
		// scripts.test = "make test" — no framework name in it. devDeps has
		// vitest. Existing test-runner.ts logic returns 'vitest'; pre-fix
		// backend would have returned null or fallen through to defaultSelect
		// (which requires vitest.config.ts to be present — it isn't).
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				scripts: { test: 'make test' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		const sel = await backend.selectTestFramework!(tempDir);
		expect(sel).not.toBeNull();
		expect(sel!.name).toBe('vitest');
		expect(sel!.detectedVia).toBe('package.json#devDependencies');
	});

	test('@types/jest devDep also resolves to jest', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				scripts: { test: 'echo no-test' },
				devDependencies: { '@types/jest': '^29.0.0' },
			}),
		);
		const sel = await backend.selectTestFramework!(tempDir);
		expect(sel).not.toBeNull();
		expect(sel!.name).toBe('jest');
	});

	test('frameworkFromScriptsTest mapping', () => {
		expect(tsInternals.frameworkFromScriptsTest('vitest run')).toBe('vitest');
		expect(tsInternals.frameworkFromScriptsTest('npx jest')).toBe('jest');
		expect(tsInternals.frameworkFromScriptsTest('mocha tests/**')).toBe(
			'mocha',
		);
		expect(tsInternals.frameworkFromScriptsTest('bun test')).toBe('bun:test');
		expect(tsInternals.frameworkFromScriptsTest('make test')).toBeNull();
	});
});
