/**
 * Regression tests for issues #675 and #1873 — plugin runtime portability.
 *
 * The published plugin bundle (`dist/index.js`) must be loadable AND functional under
 * any conformant ESM host, not only Bun. Two historical failure classes are guarded:
 *
 *   #675  — a bare top-level `import { X } from "bun:..."` is hoisted by the ESM spec
 *           and breaks Node-resolved dynamic imports with
 *           `ERR_UNSUPPORTED_ESM_URL_SCHEME`, which OpenCode's plugin loader silently
 *           swallows — leaving users with the plugin "installed" but no agents.
 *
 *   #1873 — a *lazy* `createRequire(...)('bun:sqlite')` with no `node:sqlite` fallback
 *           passed the #675 top-level-import check but still threw
 *           `Cannot find module 'bun:sqlite'` under the Node Electron sidecar, breaking
 *           every SQLite-backed tool. The #675 check could not catch it because the
 *           require is not a top-level static import.
 *
 * Guards below:
 *   A. (#675)  no top-level `bun:` static import in the shipped bundles.
 *   B. (#1873) no *un-fenced* `bun:` runtime resolution in source — all `bun:` module
 *              resolution must route through the single fallback-providing loader
 *              (`src/db/sqlite-loader.ts`); everything else uses `import type` (erased).
 *   C. (#1873) the loader keeps BOTH a `bun:sqlite` path and a `node:sqlite` fallback.
 *   D. (#1873) if a shipped bundle references `bun:sqlite`, it also references
 *              `node:sqlite` (the fallback survived bundling/minification).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const BUNDLES = [
	join(REPO_ROOT, 'dist', 'index.js'),
	join(REPO_ROOT, 'dist', 'cli', 'index.js'),
];

const TOP_LEVEL_BUN_IMPORT_RE = /^import[^;\n]*['"]bun:[^'"\n]+['"]/m;

// Source files permitted to resolve a `bun:` module at RUNTIME — the single,
// Node-fallback-providing SQLite loader. Everything else must use `import type`
// (erased at build) or route through this module.
const RUNTIME_BUN_ALLOWLIST = new Set<string>([
	join('src', 'db', 'sqlite-loader.ts'),
]);

// Runtime resolution of a bun: module — ANY call passing a `bun:` string literal.
// Matching on the call-open `(` immediately before the literal catches every
// resolver form: `require('bun:x')`, `requireModule('bun:x')`, dynamic
// `import('bun:x')`, the inline `createRequire(...)('bun:x')`, AND the alias idiom
// `const req = createRequire(...); req('bun:x')` — the exact shape the original
// #675/#1873 code used and that the codebase idiomatically writes elsewhere
// (`req('@xenova/transformers')`). Prose like `… from 'bun:test'` has no call paren
// before the literal, so it does not trip. (See the falsifiability self-tests below.)
const RUNTIME_BUN_RESOLVE_RE = /\(\s*['"`]bun:[^'"`]+['"`]/;
// A *value* static import OR re-export of a bun: module (NOT `import type` /
// `export type`, which are erased). Anchored at line start so prompt-string prose
// (`- Use: import … from 'bun:test'`) is not matched. A value `export … from 'bun:…'`
// would become a top-level bundle import just like a value import, so it is forbidden
// outside the loader too.
const VALUE_STATIC_BUN_IMPORT_RE =
	/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"]bun:[^'"]+['"]/m;

function listSourceFiles(): string[] {
	const entries = readdirSync(SRC_DIR, { recursive: true }) as string[];
	return entries
		.filter((rel) => rel.endsWith('.ts'))
		.filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.spec.ts'))
		.map((rel) => join('src', rel));
}

describe('shipped bundle portability (#675)', () => {
	for (const bundlePath of BUNDLES) {
		test(`${bundlePath.replace(REPO_ROOT, '<repo>')} has no top-level bun: imports`, () => {
			if (!existsSync(bundlePath)) {
				throw new Error(
					`Bundle missing at ${bundlePath}. Run \`bun run build\` before this test.`,
				);
			}
			const source = readFileSync(bundlePath, 'utf-8');
			const match = source.match(TOP_LEVEL_BUN_IMPORT_RE);
			expect(
				match,
				`Top-level bun: import detected — bundle is not portable to Node ESM hosts:\n  ${match?.[0]}`,
			).toBeNull();
		});
	}
});

describe('no un-fenced bun: runtime dependency (#1873)', () => {
	test('source tree is scanned (sanity: found a non-trivial file set)', () => {
		expect(listSourceFiles().length).toBeGreaterThan(50);
	});

	test('no source file resolves a bun: module at runtime outside the loader allowlist', () => {
		const violations: string[] = [];
		for (const rel of listSourceFiles()) {
			if (RUNTIME_BUN_ALLOWLIST.has(rel)) continue;
			const source = readFileSync(join(REPO_ROOT, rel), 'utf-8');
			const runtime = source.match(RUNTIME_BUN_RESOLVE_RE);
			if (runtime)
				violations.push(`${rel}: runtime bun: resolution — ${runtime[0]}`);
			const valueImport = source.match(VALUE_STATIC_BUN_IMPORT_RE);
			if (valueImport)
				violations.push(
					`${rel}: value static bun: import/export — ${valueImport[0]}`,
				);
		}
		expect(
			violations,
			'Un-fenced bun: dependency detected. Route SQLite through ' +
				'src/db/sqlite-loader.ts (loadDatabaseCtor); use `import type` for ' +
				'bun:sqlite types; any other bun: module needs a Node fallback in a ' +
				`sanctioned loader. Offenders:\n${violations.join('\n')}`,
		).toEqual([]);
	});

	test('the loader keeps both a bun:sqlite path and a node:sqlite fallback', () => {
		const loader = readFileSync(
			join(REPO_ROOT, 'src', 'db', 'sqlite-loader.ts'),
			'utf-8',
		);
		expect(loader).toContain("requireModule('bun:sqlite')");
		expect(loader).toContain("requireModule('node:sqlite')");
	});

	// Falsifiability: prove the guard flags EVERY reintroduction form (including the
	// codebase's createRequire-alias idiom — the exact original #675/#1873 shape) and
	// does NOT flag erased type imports or prose. Without this, the guard could pass
	// while silently failing to catch a re-broken tool.
	test('the runtime guard flags every bun: resolver form (and only real ones)', () => {
		const mustFlag = [
			"require('bun:sqlite')",
			'requireModule("bun:sqlite")',
			"await import('bun:ffi')",
			"createRequire(import.meta.url)('bun:sqlite')", // inline
			"const req = createRequire(import.meta.url);\nreq('bun:sqlite')", // alias idiom
			"const db = customLoader('bun:sqlite').Database", // any aliased resolver
			'require(`bun:sqlite`)', // template-literal specifier
		];
		for (const src of mustFlag) {
			expect(
				RUNTIME_BUN_RESOLVE_RE.test(src),
				`guard must flag runtime bun: resolution: ${JSON.stringify(src)}`,
			).toBe(true);
		}
		const mustNotFlag = [
			"import type { Database } from 'bun:sqlite'",
			"- Use: import { describe } from 'bun:test'", // prompt-string prose
			'  TypeScript -> bun:test (import { x } from "bun:test")', // prose
			'// native bun:sqlite under Bun', // comment
		];
		for (const src of mustNotFlag) {
			expect(
				RUNTIME_BUN_RESOLVE_RE.test(src),
				`guard must NOT flag non-resolution text: ${JSON.stringify(src)}`,
			).toBe(false);
		}
	});

	test('the static-import guard flags value import AND export of bun: (not type)', () => {
		expect(
			VALUE_STATIC_BUN_IMPORT_RE.test("import { Database } from 'bun:sqlite'"),
		).toBe(true);
		expect(
			VALUE_STATIC_BUN_IMPORT_RE.test("export { Database } from 'bun:sqlite'"),
		).toBe(true);
		expect(
			VALUE_STATIC_BUN_IMPORT_RE.test(
				"import type { Database } from 'bun:sqlite'",
			),
		).toBe(false);
		expect(
			VALUE_STATIC_BUN_IMPORT_RE.test(
				"export type { Database } from 'bun:sqlite'",
			),
		).toBe(false);
		expect(
			VALUE_STATIC_BUN_IMPORT_RE.test("- Use: import { x } from 'bun:test'"),
		).toBe(false);
	});
});

describe('shipped bundle keeps node:sqlite beside bun:sqlite (#1873)', () => {
	for (const bundlePath of BUNDLES) {
		test(`${bundlePath.replace(REPO_ROOT, '<repo>')} pairs bun:sqlite with a node:sqlite fallback`, () => {
			if (!existsSync(bundlePath)) {
				throw new Error(
					`Bundle missing at ${bundlePath}. Run \`bun run build\` before this test.`,
				);
			}
			const source = readFileSync(bundlePath, 'utf-8');
			if (source.includes('bun:sqlite')) {
				expect(
					source.includes('node:sqlite'),
					`${bundlePath} references bun:sqlite but not node:sqlite — the Node ` +
						'fallback did not survive bundling (issue #1873).',
				).toBe(true);
			}
		});
	}

	// Guard against a vacuous pairing check: the main bundle must actually reference
	// bun:sqlite (the loader always resolves it), so the pairing assertion above is not
	// silently satisfied by bun:sqlite being tree-shaken out.
	test('<repo>/dist/index.js references BOTH bun:sqlite and node:sqlite', () => {
		const mainBundle = join(REPO_ROOT, 'dist', 'index.js');
		if (!existsSync(mainBundle)) {
			throw new Error(
				`Bundle missing at ${mainBundle}. Run \`bun run build\` before this test.`,
			);
		}
		const source = readFileSync(mainBundle, 'utf-8');
		expect(source.includes('bun:sqlite')).toBe(true);
		expect(source.includes('node:sqlite')).toBe(true);
	});
});
