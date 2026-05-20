import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, buildImpactMap } from '../../../src/test-impact/analyzer';

/**
 * Phase 5b — multi-language impact-map coverage. The analyzer previously
 * scanned ONLY TS/JS test files; this suite asserts Python and Go test
 * files are now walked and routed through the matching backend's
 * `extractImports`.
 *
 * Resolution scope is intentionally narrow:
 *   - Python: only relative imports (`from .foo import x`) — absolute
 *     imports would require pyproject/sys.path resolution.
 *   - Go: only relative imports (`./pkg/foo`) — module imports would
 *     require go.mod resolution.
 * Both are noted in the analyzer's source comments.
 */

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-multi-lang-')),
	);
	_internals._clearGoModuleCache();
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	_internals._clearGoModuleCache();
});

describe('analyzer: Python test file walking + import resolution', () => {
	test('walks test_*.py files', async () => {
		fs.writeFileSync(path.join(tempDir, 'foo.py'), 'def hello(): pass\n');
		fs.writeFileSync(
			path.join(tempDir, 'test_foo.py'),
			'from .foo import hello\n\ndef test_hello(): assert hello() is None\n',
		);
		const map = await buildImpactMap(tempDir);
		const fooPath = `${_internals.normalizePath(tempDir)}/foo.py`;
		expect(map[fooPath]).toBeDefined();
		expect(map[fooPath]).toEqual([
			`${_internals.normalizePath(tempDir)}/test_foo.py`,
		]);
	});

	test('walks *_test.py files', async () => {
		fs.writeFileSync(path.join(tempDir, 'bar.py'), 'BAR = 1\n');
		fs.writeFileSync(
			path.join(tempDir, 'bar_test.py'),
			'from .bar import BAR\n',
		);
		const map = await buildImpactMap(tempDir);
		const barPath = `${_internals.normalizePath(tempDir)}/bar.py`;
		expect(map[barPath]).toEqual([
			`${_internals.normalizePath(tempDir)}/bar_test.py`,
		]);
	});

	test('resolves `from . import mod` to mod.py (PR #825 review P1 #5)', async () => {
		// Pre-fix: `from . import mod` mapped to __init__.py (wrong — a
		// change to mod.py would be reported as untested). Post-fix: the
		// extractor emits ".mod" so the analyzer locates mod.py.
		const pkgDir = path.join(tempDir, 'pkg');
		fs.mkdirSync(pkgDir);
		fs.writeFileSync(path.join(pkgDir, '__init__.py'), '');
		fs.writeFileSync(path.join(pkgDir, 'mod.py'), 'V = 42\n');
		fs.writeFileSync(path.join(pkgDir, 'test_mod.py'), 'from . import mod\n');
		const map = await buildImpactMap(tempDir);
		const modPath = `${_internals.normalizePath(pkgDir)}/mod.py`;
		expect(map[modPath]).toBeDefined();
		expect(map[modPath]).toContain(
			`${_internals.normalizePath(pkgDir)}/test_mod.py`,
		);
	});

	test('`from . import a, b` resolves both a.py and b.py', async () => {
		const pkgDir = path.join(tempDir, 'pkg');
		fs.mkdirSync(pkgDir);
		fs.writeFileSync(path.join(pkgDir, '__init__.py'), '');
		fs.writeFileSync(path.join(pkgDir, 'a.py'), 'X = 1\n');
		fs.writeFileSync(path.join(pkgDir, 'b.py'), 'Y = 2\n');
		fs.writeFileSync(path.join(pkgDir, 'test_ab.py'), 'from . import a, b\n');
		const map = await buildImpactMap(tempDir);
		expect(map[`${_internals.normalizePath(pkgDir)}/a.py`]).toBeDefined();
		expect(map[`${_internals.normalizePath(pkgDir)}/b.py`]).toBeDefined();
	});

	test('absolute imports are NOT added to the graph (no sys.path resolution)', async () => {
		fs.writeFileSync(path.join(tempDir, 'foo.py'), 'pass\n');
		fs.writeFileSync(
			path.join(tempDir, 'test_foo.py'),
			'import foo\n\ndef test(): pass\n',
		);
		const map = await buildImpactMap(tempDir);
		// `import foo` is absolute (no leading dot) — analyzer ignores it.
		const fooPath = `${_internals.normalizePath(tempDir)}/foo.py`;
		expect(map[fooPath]).toBeUndefined();
	});
});

describe('analyzer: Go test file walking + import resolution', () => {
	test('walks *_test.go files', async () => {
		const pkgDir = path.join(tempDir, 'pkg');
		fs.mkdirSync(pkgDir);
		fs.writeFileSync(path.join(pkgDir, 'foo.go'), 'package pkg\n');
		fs.writeFileSync(
			path.join(tempDir, 'foo_test.go'),
			'package main\n\nimport (\n\t"./pkg"\n)\n\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		const fooPath = `${_internals.normalizePath(pkgDir)}/foo.go`;
		expect(map[fooPath]).toBeDefined();
		expect(map[fooPath]).toEqual([
			`${_internals.normalizePath(tempDir)}/foo_test.go`,
		]);
	});

	test('relative imports route to ALL .go files in target directory (excluding *_test.go)', async () => {
		const pkgDir = path.join(tempDir, 'pkg');
		fs.mkdirSync(pkgDir);
		fs.writeFileSync(path.join(pkgDir, 'a.go'), 'package pkg\n');
		fs.writeFileSync(path.join(pkgDir, 'b.go'), 'package pkg\n');
		fs.writeFileSync(path.join(pkgDir, 'b_test.go'), 'package pkg\n');
		fs.writeFileSync(
			path.join(tempDir, 'main_test.go'),
			'import "./pkg"\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		const aPath = `${_internals.normalizePath(pkgDir)}/a.go`;
		const bPath = `${_internals.normalizePath(pkgDir)}/b.go`;
		const bTestPath = `${_internals.normalizePath(pkgDir)}/b_test.go`;
		expect(map[aPath]).toBeDefined();
		expect(map[bPath]).toBeDefined();
		// _test.go files are excluded from the import target.
		expect(map[bTestPath]).toBeUndefined();
	});

	test('external module-path imports (no matching go.mod prefix) are NOT added', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'x_test.go'),
			'import "github.com/foo/bar"\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		// No go.mod, no matching module path → no edges.
		expect(Object.keys(map).length).toBe(0);
	});

	test('local module-path imports resolve via go.mod (PR #825 review P1 #4)', async () => {
		// Real Go projects address local packages by their MODULE PATH
		// (declared in go.mod), not by relative path. Pre-fix the analyzer
		// only resolved relative imports; this asserts module-path coverage.
		fs.writeFileSync(
			path.join(tempDir, 'go.mod'),
			'module github.com/myorg/myrepo\n\ngo 1.22\n',
		);
		const pkgDir = path.join(tempDir, 'pkg', 'foo');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(path.join(pkgDir, 'foo.go'), 'package foo\n');
		fs.writeFileSync(
			path.join(tempDir, 'main_test.go'),
			'import "github.com/myorg/myrepo/pkg/foo"\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		const fooPath = `${_internals.normalizePath(pkgDir)}/foo.go`;
		expect(map[fooPath]).toBeDefined();
		expect(map[fooPath]).toContain(
			`${_internals.normalizePath(tempDir)}/main_test.go`,
		);
	});

	test('go.mod walk stops at .git boundary, does not leak to ancestor dir (PR #825 adversarial D1)', async () => {
		// Create a .git directory at tempDir to simulate a project boundary.
		fs.mkdirSync(path.join(tempDir, '.git'));
		// Test file is in a subdir; there is NO go.mod here. The walk should
		// stop at .git instead of escaping into /tmp.
		const sub = path.join(tempDir, 'sub');
		fs.mkdirSync(sub);
		fs.writeFileSync(
			path.join(sub, 'x_test.go'),
			'import "example.com/other/pkg"\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		// No go.mod inside the .git-bounded project → module path can't
		// resolve → no edges. The walk MUST NOT escape past .git to find
		// a stray /tmp/go.mod or /home/user/go.mod.
		expect(Object.keys(map).length).toBe(0);
	});

	test('quoted go.mod `module "x"` is parsed correctly (PR #825 adversarial D3)', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'go.mod'),
			'module "github.com/quoted/mod"\n',
		);
		const pkgDir = path.join(tempDir, 'pkg');
		fs.mkdirSync(pkgDir);
		fs.writeFileSync(path.join(pkgDir, 'foo.go'), 'package pkg\n');
		fs.writeFileSync(
			path.join(tempDir, 'main_test.go'),
			'import "github.com/quoted/mod/pkg"\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		const fooPath = `${_internals.normalizePath(pkgDir)}/foo.go`;
		expect(map[fooPath]).toBeDefined();
	});

	test('module imports work for test files in subdirectories', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'go.mod'),
			'module example.com/svc\n\ngo 1.22\n',
		);
		const apiDir = path.join(tempDir, 'internal', 'api');
		const utilDir = path.join(tempDir, 'internal', 'util');
		fs.mkdirSync(apiDir, { recursive: true });
		fs.mkdirSync(utilDir, { recursive: true });
		fs.writeFileSync(path.join(utilDir, 'util.go'), 'package util\n');
		fs.writeFileSync(
			path.join(apiDir, 'api_test.go'),
			'import "example.com/svc/internal/util"\nfunc TestX(t *testing.T) {}\n',
		);
		const map = await buildImpactMap(tempDir);
		const utilPath = `${_internals.normalizePath(utilDir)}/util.go`;
		expect(map[utilPath]).toBeDefined();
	});
});

describe('analyzer: mixed-language repos', () => {
	test('TS + Python + Go test files coexist without interference', async () => {
		fs.writeFileSync(path.join(tempDir, 'foo.ts'), 'export const X = 1;\n');
		fs.writeFileSync(
			path.join(tempDir, 'foo.test.ts'),
			"import { X } from './foo';\nimport { describe, test } from 'bun:test';\n",
		);
		fs.writeFileSync(path.join(tempDir, 'bar.py'), 'BAR = 1\n');
		fs.writeFileSync(
			path.join(tempDir, 'test_bar.py'),
			'from .bar import BAR\n',
		);
		const pkgDir = path.join(tempDir, 'gopkg');
		fs.mkdirSync(pkgDir);
		fs.writeFileSync(path.join(pkgDir, 'pkg.go'), 'package gopkg\n');
		fs.writeFileSync(
			path.join(tempDir, 'main_test.go'),
			'import "./gopkg"\nfunc TestX(t *testing.T) {}\n',
		);

		const map = await buildImpactMap(tempDir);
		expect(map[`${_internals.normalizePath(tempDir)}/foo.ts`]).toBeDefined();
		expect(map[`${_internals.normalizePath(tempDir)}/bar.py`]).toBeDefined();
		expect(map[`${_internals.normalizePath(pkgDir)}/pkg.go`]).toBeDefined();
	});
});
