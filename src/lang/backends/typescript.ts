/**
 * TypeScript / JavaScript backend.
 *
 * Overrides the default backend's `selectTestFramework` to honor
 * `package.json#scripts.test` (the canonical signal in the JS ecosystem)
 * and `extractImports` to parse ES6 + CommonJS imports for the
 * graph/impact analyzer.
 *
 * Phase 2 deliverable: this backend exists and registers itself, but
 * `src/tools/test-runner.ts` and `src/test-impact/analyzer.ts` do not yet
 * call into it — they still use their existing switch-statement helpers.
 * Phase 3 wires the test-runner dispatch through this backend.
 *
 * Invariants:
 *   - No subprocess calls (defers to `isCommandAvailable` from
 *     `../../build/discovery` for binary checks; that helper already
 *     satisfies invariant 3).
 *   - No `bun:` imports, no `Bun.*` calls (invariant 2).
 *   - No mutation of LANGUAGE_REGISTRY at import time — only registers a
 *     backend in LANGUAGE_BACKEND_REGISTRY via `backends/index.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BuildTestCommandOpts,
	FrameworkSelection,
	LanguageBackend,
	TestFrameworkSelection,
	TestRunSummary,
} from '../backend';
import {
	defaultBuildTestCommand,
	defaultParseTestOutput,
	defaultSelectBuildCommand,
	defaultSelectTestFramework,
	defaultTestFilesFor,
	tokenizeCommand,
} from '../default-backend';
import { LANGUAGE_REGISTRY, type LanguageProfile } from '../profiles';

const PROFILE_ID = 'typescript';

/**
 * ES6 + CommonJS import patterns. Mirrors the patterns used by
 * `src/test-impact/analyzer.ts:11–14` (ES, REQUIRE, REEXPORT) and adds
 * BARE and DYNAMIC to widen graph coverage for Phase 5. Phase 3 will
 * route the analyzer through this backend; the inputs must remain a
 * superset of what the analyzer produces today, so REEXPORT is
 * required (loss would silently shrink the impact graph and is
 * caught by `tests/unit/lang/typescript-backend-imports.test.ts`).
 */
// Use [\s\S] (not .) so multi-line `import {\n  foo,\n  bar\n} from 'mod'`
// is captured. The dot character does not match newlines without /s, and
// adding /s would broaden too much; explicit char class is the standard
// workaround. Bounded the body by [^'"]+ in the source-string match to
// keep the lazy quantifier from spanning past the closing quote.
const IMPORT_REGEX_ES = /import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_BARE = /import\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_DYNAMIC = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_REEXPORT =
	/export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

interface PackageJsonShape {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/**
 * Read package.json. Returns null when missing or malformed. Bounded by a
 * single sync `fs.readFileSync` — no subprocess.
 *
 * Routed through `_internals.readPackageJsonRaw` so tests can substitute a
 * different reader without touching the filesystem. The adversarial review
 * (PR #825) flagged that this seam was advertised but unused.
 */
function readPackageJsonRaw(dir: string): PackageJsonShape | null {
	try {
		const content = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
		return JSON.parse(content) as PackageJsonShape;
	} catch {
		return null;
	}
}

function readPackageJson(dir: string): PackageJsonShape | null {
	return _internals.readPackageJsonRaw(dir);
}

/** Convenience: read just `scripts.test` (used by tests). */
function readPackageJsonTestScript(dir: string): string | null {
	return readPackageJson(dir)?.scripts?.test ?? null;
}

/**
 * Map a `package.json#scripts.test` invocation to a framework name. The
 * mapping mirrors `detectTestFramework` in `src/tools/test-runner.ts:286–326`.
 */
function frameworkFromScriptsTest(script: string): string | null {
	if (script.includes('vitest')) return 'vitest';
	if (script.includes('jest')) return 'jest';
	if (script.includes('mocha')) return 'mocha';
	if (script.includes('bun test')) return 'bun:test';
	return null;
}

/**
 * Detect a JS test framework by presence in `devDependencies`. Mirrors
 * `test-runner.ts:309–312` so when the user has `devDependencies.vitest`
 * but no `vitest.config.ts` and a custom `scripts.test` (e.g.
 * "make test"), we still resolve to vitest as the existing logic does.
 */
function frameworkFromDevDeps(
	devDeps: Record<string, string> | undefined,
): string | null {
	if (!devDeps) return null;
	if (devDeps.vitest || devDeps['@vitest/ui']) return 'vitest';
	if (devDeps.jest || devDeps['@types/jest']) return 'jest';
	if (devDeps.mocha || devDeps['@types/mocha']) return 'mocha';
	return null;
}

function selectionFromFramework(
	profile: LanguageProfile,
	fwName: string,
	dir: string,
	detectedVia: string,
): TestFrameworkSelection | null {
	const fw = profile.test.frameworks.find((f) => f.name === fwName);
	if (!fw) return null;
	const argv = tokenizeCommand(fw.cmd);
	if (argv.length === 0) return null;
	return {
		name: fw.name,
		cmd: argv,
		cwd: dir,
		detectedVia,
		filesIgnored: false,
	};
}

async function selectTestFramework(
	dir: string,
): Promise<TestFrameworkSelection | null> {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	const pkg = readPackageJson(dir);

	// 1. Honor scripts.test — the canonical signal in JS projects.
	const script = pkg?.scripts?.test;
	if (script) {
		const fwName = frameworkFromScriptsTest(script);
		if (fwName) {
			const sel = selectionFromFramework(
				profile,
				fwName,
				dir,
				'package.json#scripts.test',
			);
			if (sel) return sel;
		}
	}

	// 2. Fall back to devDependencies — mirrors the existing behavior in
	//    `src/tools/test-runner.ts:309–312`. Without this, a project with
	//    `devDependencies.vitest` and no `vitest.config.ts` would silently
	//    miss vitest under the default's `detectFile`-driven selection.
	const devDepsFw = frameworkFromDevDeps(pkg?.devDependencies);
	if (devDepsFw) {
		const sel = selectionFromFramework(
			profile,
			devDepsFw,
			dir,
			'package.json#devDependencies',
		);
		if (sel) return sel;
	}

	// 3. Fall back to the default registry-driven selection (detectFile +
	//    binary-on-PATH check from the profile's framework list).
	return defaultSelectTestFramework(profile, dir);
}

function buildTestCommand(
	framework: string,
	files: string[],
	dir: string,
	opts?: BuildTestCommandOpts,
): string[] | null {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	return defaultBuildTestCommand(profile, framework, files, dir, opts);
}

function parseTestOutput(
	framework: string,
	stdout: string,
	stderr: string,
	exitCode: number,
): TestRunSummary {
	return defaultParseTestOutput(framework, stdout, stderr, exitCode);
}

/**
 * Detect the dominant JS/TS web/UI framework. Reads package.json
 * dependencies; returns the highest-priority match. Resolution order
 * mirrors common conventions (Next/Nuxt are full-stack so beat raw
 * React/Vue; Express signals an API server independent of UI).
 */
async function selectFramework(
	dir: string,
): Promise<FrameworkSelection | null> {
	const pkg = readPackageJson(dir);
	if (!pkg) return null;
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const order: Array<[string, string]> = [
		['next', 'next'],
		['nuxt', 'nuxt'],
		['@angular/core', 'angular'],
		['svelte', 'svelte'],
		['react', 'react'],
		['vue', 'vue'],
		['express', 'express'],
		['fastify', 'fastify'],
		['@nestjs/core', 'nestjs'],
	];
	for (const [pkgName, displayName] of order) {
		if (deps[pkgName]) {
			return {
				name: displayName,
				detectedVia: `package.json#dependencies.${pkgName}`,
			};
		}
	}
	return null;
}

/**
 * Identify primary entry points. Resolution order:
 *   1. `package.json#bin` (CLI tools — usually the most important)
 *   2. `package.json#main` (CommonJS entry)
 *   3. `package.json#module` (ESM entry)
 *   4. `package.json#exports['.']`
 * Returns repo-relative paths.
 */
async function selectEntryPoints(dir: string): Promise<string[]> {
	const pkg = readPackageJson(dir);
	if (!pkg) return [];
	const points: string[] = [];
	const obj = pkg as PackageJsonShape & {
		main?: string;
		module?: string;
		bin?: string | Record<string, string>;
		exports?: string | Record<string, unknown>;
	};
	if (obj.bin) {
		if (typeof obj.bin === 'string') points.push(obj.bin);
		else for (const v of Object.values(obj.bin)) points.push(v);
	}
	if (obj.main) points.push(obj.main);
	if (obj.module && obj.module !== obj.main) points.push(obj.module);
	if (obj.exports && typeof obj.exports === 'object') {
		const root = (obj.exports as Record<string, unknown>)['.'];
		if (typeof root === 'string' && !points.includes(root)) points.push(root);
	}
	// Dedupe in order, drop empty.
	return [...new Set(points.filter((p) => p.length > 0))];
}

/**
 * Extract import paths from a TS/JS source file. Mirrors the four regex
 * passes in `src/test-impact/analyzer.ts` so Phase 5 can route extraction
 * through the backend.
 */
function extractImports(_sourceFile: string, source: string): string[] {
	const out = new Set<string>();
	for (const re of [
		IMPORT_REGEX_ES,
		IMPORT_REGEX_BARE,
		IMPORT_REGEX_REQUIRE,
		IMPORT_REGEX_DYNAMIC,
		IMPORT_REGEX_REEXPORT,
	]) {
		// Each regex has /g; reset lastIndex defensively because we share the
		// regex constants across calls.
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(source);
		while (m !== null) {
			out.add(m[1]);
			m = re.exec(source);
		}
	}
	return [...out];
}

async function selectBuildCommand(dir: string) {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	return defaultSelectBuildCommand(profile, dir);
}

async function testFilesFor(
	sourceFile: string,
	dir: string,
): Promise<string[]> {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return [];
	return defaultTestFilesFor(profile, sourceFile, dir);
}

/**
 * Build the TypeScript backend from the registered profile. Backend
 * registration happens in `./index.ts` (the single import-and-register
 * surface) — this module just exports the factory so the registration
 * site is explicit.
 */
export function buildTypescriptBackend(): LanguageBackend {
	const profile: LanguageProfile | undefined =
		LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildTypescriptBackend: typescript profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
	return {
		...profile,
		selectTestFramework,
		buildTestCommand,
		parseTestOutput,
		extractImports,
		selectBuildCommand,
		testFilesFor,
		selectFramework,
		selectEntryPoints,
	};
}

// Internals exposed for test-only override without resorting to mock.module
// (per engineering-conventions skill).
export const _internals: {
	readPackageJsonRaw: typeof readPackageJsonRaw;
	readPackageJsonTestScript: typeof readPackageJsonTestScript;
	frameworkFromScriptsTest: typeof frameworkFromScriptsTest;
} = {
	readPackageJsonRaw,
	readPackageJsonTestScript,
	frameworkFromScriptsTest,
};
