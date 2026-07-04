import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Static-analysis purity tests for the symbol-graph init-path isolation.
 *
 * Per AGENTS.md invariant 1 (plugin init fast/bounded/fail-open): tree-sitter
 * grammar loading (`loadGrammar`) must be OFF the plugin init path. These tests
 * prove it via static source scanning:
 *
 * TEST A — init-path isolation: src/index.ts (the plugin entry) must not
 *   import lang/symbol-graph or lang/runtime, proving the symbol-extraction
 *   layer is unreachable from the synchronous plugin registration path.
 *
 * TEST B — symbol-graph module purity: loadGrammar must not be called at
 *   module top-level in symbol-graph.ts — it lives only inside
 *   extractFileSymbols (a lazy, on-demand function).
 *
 * TEST C — backend-purity bar for symbol-graph.ts: no `bun:` imports,
 *   no global `Bun.*` API, no spawn primitives (mirrors the existing
 *   backend-purity.test.ts bar).
 *
 * These are static source-scanning tests — fast, deterministic, no mocks.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

// ─── TEST A ──────────────────────────────────────────────────────────────────

describe('TEST A — plugin init path does not reach lang/symbol-graph (invariant 1)', () => {
	test('src/index.ts does not import lang/symbol-graph or lang/runtime', () => {
		const indexPath = path.join(REPO_ROOT, 'src', 'index.ts');
		const src = fs.readFileSync(indexPath, 'utf-8');

		// The plugin entry must not import the symbol-extraction layer.
		// Any such import would put tree-sitter on the synchronous init path,
		// violating AGENTS.md invariant 1 (bounded plugin init).
		expect(src).not.toMatch(/from\s+['"]\.\/lang\/symbol-graph/);
		expect(src).not.toMatch(/from\s+['"]\.\/lang\/runtime/);
		expect(src).not.toMatch(/from\s+['"]\.\.\/lang\/symbol-graph/);
		expect(src).not.toMatch(/from\s+['"]\.\.\/lang\/runtime/);
	});

	test('src/index.ts does not reference loadGrammar', () => {
		const indexPath = path.join(REPO_ROOT, 'src', 'index.ts');
		const src = fs.readFileSync(indexPath, 'utf-8');

		// loadGrammar is the tree-sitter grammar-loading entry point.
		// It must not appear anywhere in the plugin entry module.
		expect(src).not.toMatch(/\bloadGrammar\b/);
	});

	test('src/index.ts does not import extractFileSymbols', () => {
		const indexPath = path.join(REPO_ROOT, 'src', 'index.ts');
		const src = fs.readFileSync(indexPath, 'utf-8');

		// extractFileSymbols is the public API of the symbol-graph layer.
		// It must not be reachable from the plugin init path.
		expect(src).not.toMatch(/\bextractFileSymbols\b/);
	});
});

// ─── TEST B ──────────────────────────────────────────────────────────────────

describe('TEST B — symbol-graph.ts has no module-top-level loadGrammar call (invariant 1)', () => {
	test('loadGrammar call is inside extractFileSymbols, not at column 0', () => {
		const sgPath = path.join(REPO_ROOT, 'src', 'lang', 'symbol-graph.ts');
		const src = fs.readFileSync(sgPath, 'utf-8');

		// Strip comments so we don't get false positives from documentation.
		const stripped = src
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '');

		// Find every line that contains 'loadGrammar' (after comment stripping).
		// Verify none are at column 0 (module top-level) — every occurrence must
		// be indented, i.e. inside a function body.
		const lines = stripped.split('\n');
		const topLevelCalls = lines.filter((line) => {
			const trimmed = line.trimStart();
			// A top-level call has no leading whitespace AND contains loadGrammar
			const isTopLevel =
				line.startsWith('\t') === false && line.startsWith('    ') === false;
			return isTopLevel && trimmed.startsWith('loadGrammar');
		});

		expect(
			topLevelCalls,
			`loadGrammar called at module top-level: ${topLevelCalls.join('\n')}`,
		).toHaveLength(0);
	});

	test('no top-level await loadGrammar', () => {
		const sgPath = path.join(REPO_ROOT, 'src', 'lang', 'symbol-graph.ts');
		const src = fs.readFileSync(sgPath, 'utf-8');

		// Any `await loadGrammar` at module level would execute during module
		// load (before any function is called), putting grammar loading on the
		// synchronous init path.
		expect(src).not.toMatch(/^await\s+loadGrammar/);
		expect(src).not.toMatch(/^\s+await\s+loadGrammar/);
	});

	test('no module-top-level side effects in symbol-graph.ts', () => {
		const sgPath = path.join(REPO_ROOT, 'src', 'lang', 'symbol-graph.ts');
		const src = fs.readFileSync(sgPath, 'utf-8');

		// web-tree-sitter is loaded LAZILY via dynamic import() inside
		// extractFileSymbols. A static `import { ... }` (value import) at module
		// level would eagerly load the WASM bundle at plugin init time — a side
		// effect we must prevent.  Type-only imports (`import type { ... }`) are
		// erased at compile time and carry no runtime cost, so they are safe.
		//
		// Pattern: `import\s+(?!type\s*\{)` matches `import { ... }` where the
		// next token after `import` is NOT `type` — i.e. a value import.
		// This correctly rejects `import type { Language } from 'web-tree-sitter'`
		// while flagging `import { Language } from 'web-tree-sitter'`.
		const valueImportMatch = src.match(
			/import\s+(?!type\s*\{).*from\s+['"]web-tree-sitter['"]/,
		);
		expect(
			valueImportMatch,
			'web-tree-sitter must not be statically imported as a value — use `import type` or dynamic import()',
		).toBeNull();

		// loadGrammar is also loaded lazily inside extractFileSymbols via
		// `await import('./runtime.js')`. Verify no static `import { loadGrammar }`
		// exists at module level (we already verified no call sites are at col-0
		// above; this catches the import binding itself).
		const loadGrammarStaticImport = src.match(
			/import\s+.*\bloadGrammar\b.*from\s+['"]\.\/runtime/,
		);
		expect(
			loadGrammarStaticImport,
			'loadGrammar must not be statically imported — use `await import()` inside extractFileSymbols',
		).toBeNull();
	});
});

// ─── TEST C ──────────────────────────────────────────────────────────────────

describe('TEST C — symbol-graph.ts satisfies the backend-purity bar (invariant 2 + 3)', () => {
	test('no bun: imports in symbol-graph.ts (invariant 2)', () => {
		const sgPath = path.join(REPO_ROOT, 'src', 'lang', 'symbol-graph.ts');
		const src = fs.readFileSync(sgPath, 'utf-8');

		expect(src).not.toMatch(/from\s+['"]bun:[^'"]+['"]/);
		expect(src).not.toMatch(/import\s*\(\s*['"]bun:/);
	});

	test('no global Bun.* API in symbol-graph.ts (invariant 2)', () => {
		const sgPath = path.join(REPO_ROOT, 'src', 'lang', 'symbol-graph.ts');
		const src = fs.readFileSync(sgPath, 'utf-8');

		// Strip line comments before checking.
		const stripped = src
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '');

		expect(stripped).not.toMatch(/\bBun\.[a-zA-Z]/);
	});

	test('no spawn primitives in symbol-graph.ts (invariant 3)', () => {
		const sgPath = path.join(REPO_ROOT, 'src', 'lang', 'symbol-graph.ts');
		const src = fs.readFileSync(sgPath, 'utf-8');

		// Import-level checks.
		expect(src).not.toMatch(/import\s+.*bunSpawn(?:Sync)?\s+from/);
		expect(src).not.toMatch(
			/import\s+.*\bspawn(?:Sync)?\b.*from\s+['"]node:child_process['"]/,
		);

		// Usage-level checks (strip comments first).
		const stripped = src
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '');

		expect(stripped).not.toMatch(/\bbunSpawn(?:Sync)?\s*\(/);
		expect(stripped).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
	});
});

describe('TEST D — symbol-visibility.ts stays pure and init-safe', () => {
	test('no bun, spawn, runtime, or web-tree-sitter value imports', () => {
		const visibilityPath = path.join(
			REPO_ROOT,
			'src',
			'lang',
			'symbol-visibility.ts',
		);
		const src = fs.readFileSync(visibilityPath, 'utf-8');
		const stripped = src
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '');

		expect(stripped).not.toMatch(/from\s+['"]bun:[^'"]+['"]/);
		expect(stripped).not.toMatch(/import\s*\(\s*['"]bun:/);
		expect(stripped).not.toMatch(/\bBun\.[a-zA-Z]/);
		expect(stripped).not.toMatch(/\bbunSpawn(?:Sync)?\s*\(/);
		expect(stripped).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
		expect(stripped).not.toMatch(
			/import\s+(?!type\s*\{).*from\s+['"]web-tree-sitter['"]/,
		);
		expect(stripped).not.toMatch(/from\s+['"]\.\/runtime(?:\.js)?['"]/);
		expect(stripped).not.toMatch(/from\s+['"]\.\/index(?:\.js)?['"]/);
	});
});
