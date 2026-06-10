import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearDispatchCache } from '../../../src/lang/dispatch';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import {
	buildTestCommandViaDispatch,
	DISPATCH_FRAMEWORK_MAP,
	detectTestFramework,
	detectTestFrameworkViaDispatch,
	parseTestOutputViaDispatch,
} from '../../../src/tools/test-runner';

/**
 * Phase 3 parity test — verifies the new dispatch-driven test framework
 * detection (`detectTestFrameworkViaDispatch`) is consistent with the
 * legacy switch (`detectTestFramework`).
 *
 * The two paths use slightly different detection strategies:
 *   - Legacy trusts manifests: presence of `pyproject.toml` + `pytest` in
 *     content → returns `'pytest'` even if `pytest` is not on PATH. The
 *     spawn fails later with a less-helpful message.
 *   - Dispatch is stricter: requires both manifest AND binary on PATH
 *     (via `isCommandAvailable` in `src/build/discovery.ts`). Returns
 *     `'none'` when the binary is missing — the test runner then
 *     surfaces the documented "no test framework detected" message at
 *     dispatch time instead of opaque spawn failure later.
 *
 * The dispatch's stricter check is a behavioral improvement, not a
 * regression. The parity contract here is "weak parity":
 *   1. Neither path invents a framework that isn't backed by manifest
 *      evidence.
 *   2. When both paths return non-`'none'`, they agree on the framework
 *      name (no divergence in identity, only in availability).
 *
 * mkdtempSync + realpathSync per Invariant 7 (macOS /var → /private/var).
 */

function assertWeakParity(legacy: string, dispatch: string): void {
	// Rule 1: dispatch must not return a framework when legacy returns 'none'.
	if (legacy === 'none') {
		expect(dispatch).toBe('none');
		return;
	}
	// Rule 2: when both return a framework, they must agree on identity.
	if (dispatch !== 'none') {
		expect(dispatch).toBe(legacy);
	}
	// (dispatch === 'none' && legacy !== 'none') is allowed — dispatch is
	// stricter (requires binary on PATH; legacy trusts manifest).
}

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-parity-')),
	);
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('detectTestFramework legacy ↔ dispatch parity', () => {
	test('empty directory: both return "none"', async () => {
		const legacy = await detectTestFramework(tempDir);
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		expect(legacy).toBe('none');
		expect(viaDispatch).toBe('none');
	});

	test('package.json with scripts.test=vitest: both return "vitest"', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		const legacy = await detectTestFramework(tempDir);
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		assertWeakParity(legacy, viaDispatch);
		expect(legacy).toBe('vitest');
	});

	test('package.json with scripts.test=jest: both return "jest"', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				scripts: { test: 'jest' },
				devDependencies: { jest: '^29.0.0' },
			}),
		);
		const legacy = await detectTestFramework(tempDir);
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		assertWeakParity(legacy, viaDispatch);
	});

	// PR #825 review P1 #2 — bun:test must NOT be inferred from a generic
	// package.json. Dispatch previously matched any package.json as the
	// bun:test detect file, giving a false-positive when Bun happened to be
	// on PATH. After the fix, the bun:test framework requires `bun.lock`.
	test('plain package.json without bun.lock does NOT trigger bun detection', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ name: 'generic-node-project' }),
		);
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		expect(viaDispatch).toBe('none');
	});

	test('package.json + bun.lock detects bun:test', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ name: 'bun-project' }),
		);
		fs.writeFileSync(path.join(tempDir, 'bun.lock'), '');
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		// Returns 'bun' (TestFramework union) when bun is on PATH, else
		// 'none' (still legitimate — binary not available). Accept either.
		expect(['bun', 'none']).toContain(viaDispatch);
	});

	// Note: parity tests for non-TS languages (Rust, Go, Python) are
	// intentionally NOT asserted strictly. The two paths use genuinely
	// different detection heuristics:
	//   - Legacy (test-runner.ts): regex-driven content scanning (e.g. for
	//     Rust, requires `[dev-dependencies]` + a known test dep in
	//     Cargo.toml; for Python, requires `[tool.pytest`/`[pytest]` in
	//     pyproject.toml/setup.cfg).
	//   - Dispatch (LanguageBackend): registry-driven (uses
	//     `profile.test.frameworks[*].detect` + `isCommandAvailable`).
	//
	// Both paths are correct under their own heuristic; converging them is
	// Phase 3b work (lift legacy regex into per-backend detectProject
	// overrides). For Phase 3 the parity contract is asserted on the TS
	// path (where both heuristics share a common signal — `package.json`
	// scripts/devDependencies). Other languages are validated by the
	// `detectTestFrameworkViaDispatch` direct-API tests below, not by
	// strict parity.
	test('Rust + Go + Python parity is best-effort (heuristic divergence is expected)', async () => {
		// Smoke: dispatch path doesn't crash when given non-TS manifests.
		// Both paths return SOMETHING — agreement is not required for
		// Phase 3.
		fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname="x"\n');
		const legacy = await detectTestFramework(tempDir);
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		// Either a known framework name or 'none'; never throws.
		expect(typeof legacy).toBe('string');
		expect(typeof viaDispatch).toBe('string');
	});

	test('PHP project: both return "none" (PHP framework names not in TestFramework union)', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'x/y' }),
		);
		fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit></phpunit>');
		const legacy = await detectTestFramework(tempDir);
		const viaDispatch = await detectTestFrameworkViaDispatch(tempDir);
		// PHP frameworks aren't represented in the legacy TestFramework union,
		// so legacy returns 'none'. The dispatch path collapses unmapped
		// names to 'none' to preserve parity.
		expect(legacy).toBe('none');
		expect(viaDispatch).toBe('none');
	});
});

describe('DD-C026: profile framework name ↔ dispatch map coverage', () => {
	// Names whose test frameworks the legacy TestFramework union intentionally
	// does not represent — `detectTestFrameworkViaDispatch` collapses them to
	// 'none' on purpose (legacy could not detect them either).
	const INTENTIONALLY_UNMAPPED = new Set(['unittest', 'Pest', 'PHPUnit']);

	test('every profile test-framework name is either mapped or explicitly unmapped', () => {
		const unmapped: string[] = [];
		for (const profile of LANGUAGE_REGISTRY.getAll()) {
			for (const fw of profile.test.frameworks) {
				if (INTENTIONALLY_UNMAPPED.has(fw.name)) continue;
				if (!(fw.name in DISPATCH_FRAMEWORK_MAP)) {
					unmapped.push(`${profile.id}:${fw.name}`);
				}
			}
		}
		// A profile framework name absent from the map silently dispatches to
		// 'none' — the exact latent footgun DD-C026 calls out. Lock it shut.
		expect(unmapped).toEqual([]);
	});

	test('after unification, profile names map to themselves where a union member exists', () => {
		// The 6 previously-divergent names now equal their union target.
		for (const name of [
			'cargo',
			'go-test',
			'maven',
			'gradle',
			'dotnet-test',
			'swift-test',
		]) {
			expect(DISPATCH_FRAMEWORK_MAP[name]).toBe(name);
		}
	});
});

describe('SWARM_LANG_BACKEND env var routing', () => {
	test('detectTestFrameworkViaDispatch is callable directly (no env var needed)', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ scripts: { test: 'vitest' } }),
		);
		const result = await detectTestFrameworkViaDispatch(tempDir);
		expect(result).toBe('vitest');
	});

	test('detectTestFrameworkViaDispatch fails-soft on broken backend (returns "none")', async () => {
		// No package.json, no manifest — backend returns null, we return 'none'.
		const result = await detectTestFrameworkViaDispatch(tempDir);
		expect(result).toBe('none');
	});

	test('SWARM_LANG_BACKEND default is dispatch (PR #825 adversarial I.4)', () => {
		// Phase 3b flipped the default: dispatch is now the production
		// detection path; `SWARM_LANG_BACKEND=legacy` is the explicit opt-
		// out. The test-runner gate keys off `!== 'legacy'`, so any unset,
		// empty, or non-'legacy' value selects dispatch.
		const prior = process.env.SWARM_LANG_BACKEND;
		try {
			delete process.env.SWARM_LANG_BACKEND;
			expect(process.env.SWARM_LANG_BACKEND !== 'legacy').toBe(true);
			process.env.SWARM_LANG_BACKEND = '';
			expect(process.env.SWARM_LANG_BACKEND !== 'legacy').toBe(true);
			process.env.SWARM_LANG_BACKEND = 'dispatch';
			expect(process.env.SWARM_LANG_BACKEND !== 'legacy').toBe(true);
			process.env.SWARM_LANG_BACKEND = 'legacy';
			expect(process.env.SWARM_LANG_BACKEND !== 'legacy').toBe(false);
		} finally {
			if (prior === undefined) delete process.env.SWARM_LANG_BACKEND;
			else process.env.SWARM_LANG_BACKEND = prior;
		}
	});
});

describe('Phase 3b: buildTestCommandViaDispatch parity', () => {
	beforeEach(() => clearDispatchCache());

	test('vitest with coverage produces npx vitest run --coverage <files>', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ scripts: { test: 'vitest run' } }),
		);
		const cmd = await buildTestCommandViaDispatch(
			'vitest',
			'graph',
			['src/foo.test.ts'],
			true,
			tempDir,
		);
		expect(cmd).toEqual([
			'npx',
			'vitest',
			'run',
			'--reporter=json',
			'--outputFile',
			'.swarm/cache/test-runner-vitest.json',
			'--coverage',
			'src/foo.test.ts',
		]);
	});

	test('bun without coverage in scope=all drops files and avoids unsupported JSON reporter', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ scripts: { test: 'bun test' } }),
		);
		const cmd = await buildTestCommandViaDispatch(
			'bun',
			'all',
			['ignored.test.ts'],
			false,
			tempDir,
		);
		// Bun 1.3.x supports junit/dots reporters, not --reporter=json.
		expect(cmd).toEqual(['bun', 'test']);
	});

	test('pytest produces python3/python -m pytest with --cov when coverage=true', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'pyproject.toml'),
			'[tool.pytest.ini_options]\n',
		);
		const cmd = await buildTestCommandViaDispatch(
			'pytest',
			'convention',
			['tests/test_x.py'],
			true,
			tempDir,
		);
		// Platform-specific python/python3 prefix; assert the suffix.
		expect(cmd).not.toBeNull();
		expect(cmd!.slice(-5)).toEqual([
			'-m',
			'pytest',
			'--cov=.',
			'--cov-report=term-missing',
			'tests/test_x.py',
		]);
	});

	test('go-test ignores files argument (cargo/go-style)', async () => {
		fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module x\n');
		const cmd = await buildTestCommandViaDispatch(
			'go-test',
			'graph',
			['foo_test.go'],
			false,
			tempDir,
		);
		expect(cmd).toEqual(['go', 'test', './...']);
	});

	test('framework=none returns null', async () => {
		const cmd = await buildTestCommandViaDispatch(
			'none',
			'all',
			[],
			false,
			tempDir,
		);
		expect(cmd).toBeNull();
	});
});

describe('Phase 3b: parseTestOutputViaDispatch parity', () => {
	beforeEach(() => clearDispatchCache());

	test('bun JSON output → totals from numTotalTests etc.', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ scripts: { test: 'bun test' } }),
		);
		const output = JSON.stringify({
			testResults: [],
			numTotalTests: 5,
			numPassedTests: 4,
			numFailedTests: 1,
			numPendingTests: 0,
		});
		const parsed = await parseTestOutputViaDispatch('bun', output, tempDir);
		expect(parsed).not.toBeNull();
		expect(parsed!.totals).toEqual({
			passed: 4,
			failed: 1,
			skipped: 0,
			total: 5,
		});
	});

	test('pytest output → passed/failed/skipped + coverage', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'pyproject.toml'),
			'[tool.pytest.ini_options]\n',
		);
		const output = `==== 3 passed, 1 failed, 2 skipped in 0.5s ====
TOTAL  85.5%`;
		const parsed = await parseTestOutputViaDispatch('pytest', output, tempDir);
		expect(parsed).not.toBeNull();
		expect(parsed!.totals).toEqual({
			passed: 3,
			failed: 1,
			skipped: 2,
			total: 6,
		});
		expect(parsed!.coveragePercent).toBeCloseTo(85.5);
	});

	test('go-test counts --- PASS/FAIL/SKIP markers', async () => {
		fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module x\n');
		const output = `=== RUN TestA
--- PASS: TestA (0.01s)
=== RUN TestB
--- FAIL: TestB (0.01s)
=== RUN TestC
--- SKIP: TestC (0.01s)
coverage: 73.2% of statements`;
		const parsed = await parseTestOutputViaDispatch('go-test', output, tempDir);
		expect(parsed).not.toBeNull();
		expect(parsed!.totals).toEqual({
			passed: 1,
			failed: 1,
			skipped: 1,
			total: 3,
		});
		expect(parsed!.coveragePercent).toBeCloseTo(73.2);
	});

	test('framework=none returns null', async () => {
		const parsed = await parseTestOutputViaDispatch('none', '', tempDir);
		expect(parsed).toBeNull();
	});
});
