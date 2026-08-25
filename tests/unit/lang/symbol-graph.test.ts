import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import {
	extractFileSymbols,
	type FileSymbolFacts,
} from '../../../src/lang/symbol-graph';

describe('extractFileSymbols — typescript grammar (task 1.1)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('extracts defs, imports, and refs from a TS snippet', async () => {
		const source = `
import { foo as bar } from './m';

export function myFunc() {
	bar();
}
`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		// One exported function def
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'myFunc',
			kind: 'function',
			exported: true,
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// One named import with aliased binding
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: './m',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'foo', local: 'bar' },
		]);

		// bar() call inside myFunc has enclosingDecl = myFunc
		const barRef = facts!.refs.find((r) => r.identifier === 'bar');
		expect(barRef).toBeDefined();
		expect(barRef!.enclosingDecl).toBe('myFunc');
	});

	test('parses JavaScript source under grammarId typescript', async () => {
		const source = `
function hello() {
	console.log('hi');
}
`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0].name).toBe('hello');
		expect(facts!.defs[0].kind).toBe('function');
	});

	test('returns null for an unknown grammarId (fail-open)', async () => {
		const facts = await extractFileSymbols('nonexistent-lang', 'const x = 1;');
		expect(facts).toBeNull();
	});

	// -------------------------------------------------------------------------
	// FIX 3 — JavaScript grammarId alias (phase-council reviewer finding)
	// The 'javascript' key mirrors 'typescript'; this test verifies it works.
	// Uses plain JS syntax (no TypeScript-only type annotations).
	// -------------------------------------------------------------------------
	test('javascript grammarId alias: function f() {} resolves', async () => {
		const source = 'function f() { return 1; }';

		const facts = await extractFileSymbols('javascript', source);
		expect(facts).not.toBeNull();
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'f',
			kind: 'function',
		});
	});

	test('reference inside anonymous callback gets nearest top-level decl', async () => {
		const source = `
function outer() {
	const callback = () => {
		inner();
	};
}
`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		const innerRef = facts!.refs.find((r) => r.identifier === 'inner');
		expect(innerRef).toBeDefined();
		// inner() is inside an anonymous arrow inside outer,
		// so enclosingDecl falls back to the nearest named top-level decl: outer
		expect(innerRef!.enclosingDecl).toBe('outer');
	});

	test('reference at module scope falls back to <module>', async () => {
		const source = `x;\n`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		const xRef = facts!.refs.find((r) => r.identifier === 'x');
		expect(xRef).toBeDefined();
		expect(xRef!.enclosingDecl).toBe('<module>');
	});
});

// -----------------------------------------------------------------------
// Regression tests — reviewer-flagged bugs
// These documents gaps that the coder must fix in src/lang/symbol-graph.ts
// -----------------------------------------------------------------------

describe('extractFileSymbols — regression: reviewer bugs', () => {
	beforeEach(() => {
		clearParserCache();
	});

	// -------------------------------------------------------------------------
	// BUG (a) — C6 misattribution: isNodeInside uses row-only containment.
	// FIX: isNodeInside now uses byte-offset (startIndex/endIndex) containment,
	// so same-line minified code attributes references to the correct scope.
	// -------------------------------------------------------------------------
	test('bug a: minified same-line functions — enclosingDecl uses column bounds', async () => {
		// foo: cols 0-16 (function foo(){})
		// bar: cols 17-39 (function bar(){ baz(); })
		// baz: col 27 — inside bar, outside foo
		const source = 'function foo(){} function bar(){ baz(); }';

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		const bazRef = facts!.refs.find((r) => r.identifier === 'baz');
		expect(bazRef).toBeDefined();
		// With byte-offset containment, baz is correctly inside bar.
		expect(bazRef!.enclosingDecl).toBe('bar');
	});

	// -------------------------------------------------------------------------
	// BUG (b) — C7 completeness: generator function* declarations captured.
	// FIX: added `(generator_function_declaration ...)` to the defs query.
	// -------------------------------------------------------------------------
	test('bug b: generator function* gen(){} produces a def entry', async () => {
		const source = 'function* gen() { yield 1; }';

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0].name).toBe('gen');
		expect(facts!.defs[0].kind).toBe('function');
	});

	// -------------------------------------------------------------------------
	// BUG (c) — C7 completeness: import type { Foo } syntax is handled.
	// FIX: parseEsmImport strips the optional `type` qualifier from the
	// import statement and from individual bindings inline.
	// -------------------------------------------------------------------------
	test('bug c.1: import type { Foo } from "./m" produces a named import entry', async () => {
		const source = "import type { Foo } from './m';";

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		// parseEsmImport now strips the `type` qualifier and captures the named import
		const fooImport = facts!.imports.find((i) => i.specifier === './m');
		expect(fooImport).toBeDefined();
		expect(fooImport!.importType).toBe('named');
		// Type-only import has no runtime bindings
		expect(fooImport!.bindings).toEqual([]);
	});

	test('bug c.2: import { type Bar } from "./m" omits type-only runtime bindings', async () => {
		const source = "import { type Bar } from './m';";

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		const barImport = facts!.imports.find((i) => i.specifier === './m');
		expect(barImport).toBeDefined();
		expect(barImport!.importType).toBe('named');
		// Type-only imports do not create runtime binding facts.
		expect(barImport!.bindings).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// FIX 1 — Combined ESM imports (phase-council reviewer finding)
	// `import Default, { named } from 'spec'` and `import Default, * as ns from 'spec'`
	// -------------------------------------------------------------------------
	test('combined ESM: import React, { useState as use } from "react"', async () => {
		const source = `import React, { useState as use } from 'react';

export function App() {
	const [s, set] = use();
	return React.createElement('div', null, s);
}`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		const reactImport = facts!.imports.find((i) => i.specifier === 'react');
		expect(reactImport).toBeDefined();
		expect(reactImport!.importType).toBe('named');
		// Default binding + aliased named binding
		expect(reactImport!.bindings).toEqual([
			{ imported: 'default', local: 'React' },
			{ imported: 'useState', local: 'use' },
		]);
	});

	test('combined ESM with namespace: import Def, * as ns from "mod"', async () => {
		const source = `import Def, * as ns from 'mod';`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		const modImport = facts!.imports.find((i) => i.specifier === 'mod');
		expect(modImport).toBeDefined();
		expect(modImport!.importType).toBe('named');
		expect(modImport!.bindings).toEqual([
			{ imported: 'default', local: 'Def' },
			{ imported: '*', local: 'ns' },
		]);
	});

	// -------------------------------------------------------------------------
	// FIX 2 — Default-export naming divergence (phase-council reviewer finding)
	// `export default function go()` must record the exported def name as 'default'
	// (not 'go') so node.exports/exportRanges key on 'default', matching the
	// 'default' sentinel used by parseEsmImport for `import go from './m'`
	// and the sync builder's export naming.
	// -------------------------------------------------------------------------
	test('default export: export default function go() records name as "default"', async () => {
		const source = 'export default function go() { return 1; }';

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		// The def name is 'default' (not the local 'go') so node.exports/exportRanges
		// key on 'default', matching the edge 'default' sentinel + sync path.
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0].name).toBe('default');
		expect(facts!.defs[0].kind).toBe('function');
		expect(facts!.defs[0].exported).toBe(true);
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);
	});

	test('default export javascript grammar: export default class Foo', async () => {
		const source = 'export default class Foo { }';

		const facts = await extractFileSymbols('javascript', source);
		expect(facts).not.toBeNull();

		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0].name).toBe('default');
		expect(facts!.defs[0].kind).toBe('class');
		expect(facts!.defs[0].exported).toBe(true);
	});

	test('named export is unaffected by default-export normalization', async () => {
		const source = `export function go() { return 1; }
export default function also() { return 2; }`;

		const facts = await extractFileSymbols('typescript', source);
		expect(facts).not.toBeNull();

		// go is a named export → name stays 'go'
		const goDef = facts!.defs.find((d) => d.name === 'go');
		expect(goDef).toBeDefined();
		expect(goDef!.exported).toBe(true);

		// also is a default export → name becomes 'default'
		const defaultDef = facts!.defs.find((d) => d.name === 'default');
		expect(defaultDef).toBeDefined();
		expect(defaultDef!.exported).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Adversarial security / robustness tests
// Verify fail-open: extractFileSymbols never throws, never hangs,
// and returns null or safe partial facts for every malformed input.
// ---------------------------------------------------------------------------

describe('extractFileSymbols — adversarial attack vectors (task 1.1 step 5m)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	// -----------------------------------------------------------------------
	// Vector 1: Malformed / garbage source — binary bytes, null bytes,
	// random control chars, truncated code. Must not throw.
	// -----------------------------------------------------------------------
	test('vector 1: binary-looking bytes and null bytes — fail-open', async () => {
		// Null bytes embedded in source — tree-sitter's TypeScript parser
		// tolerates embedded nulls and parses the valid portions; fail-open
		// means no crash, which is satisfied here.
		const garbage = 'function f\x00() {\x00return 1;\x00}';
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', garbage);
		const elapsed = Date.now() - start;
		// Must not throw; null OR partial facts both acceptable fail-open
		expect(
			facts === null ||
				(typeof facts === 'object' && Array.isArray(facts.defs)),
		).toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	test('vector 1b: random control chars — fail-open', async () => {
		// Mix of control characters (BEL, ENQ, SUB, etc.)
		const ctrl = 'fun\x07ction \x1b f\x10() { ret\x03urn 42; }';
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', ctrl);
		const elapsed = Date.now() - start;
		// Must not throw; null is acceptable fail-open
		expect(facts === null || Array.isArray(facts.defs)).toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	test('vector 1c: truncated/incomplete code — fail-open', async () => {
		// Half-written code cut mid-token
		const truncated = 'function incoplete { return';
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', truncated);
		const elapsed = Date.now() - start;
		// Must not throw; null or partial facts both acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	// -----------------------------------------------------------------------
	// Vector 2: Syntax-error TS source. Must not throw.
	// -----------------------------------------------------------------------
	test('vector 2: severe syntax errors — fail-open', async () => {
		const broken = 'function {{{{ {{}}}}}}}}}}}';
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', broken);
		const elapsed = Date.now() - start;
		// Must not throw; null is acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	// -----------------------------------------------------------------------
	// Vector 3: Empty string source. Must not throw.
	// -----------------------------------------------------------------------
	test('vector 3: empty string — fail-open', async () => {
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', '');
		const elapsed = Date.now() - start;
		// Must not throw; null or empty-object facts both acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	// -----------------------------------------------------------------------
	// Vector 4: Oversized source (2 MB+). Must be bounded and fail-open.
	// The 500 ms AST_TIMEOUT_MS race should bound the operation, but
	// parser.parse() is synchronous — if it exceeds 500 ms the outer race
	// fires when it rejects, not when the parse is aborted. We assert the
	// call returns within a generous wall-clock (3 s) without hanging.
	// -----------------------------------------------------------------------
	test('vector 4: 2 MB+ repeated declarations — bounded, no hang', async () => {
		// ~2.2 MB string — repeating pattern that exercises both parser and query
		const decl = 'function __gen() { return 1; } ';
		// 70 000 repetitions ≈ 2.17 MB
		const source = decl.repeat(70_000);
		expect(source.length).toBeGreaterThan(2 * 1024 * 1024);

		const start = Date.now();
		const facts = await extractFileSymbols('typescript', source);
		const elapsed = Date.now() - start;

		// Must not throw; null (timeout) or partial facts both acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		// Must complete within a generous wall-clock. Coverage instrumentation
		// adds overhead on Windows, so keep this as a bounded-hang assertion
		// rather than a micro-benchmark.
		expect(elapsed).toBeLessThan(5000);
	});

	// -----------------------------------------------------------------------
	// Vector 5: Wrong-grammar source. Feed Python under 'typescript'.
	// Must not throw.
	// -----------------------------------------------------------------------
	test('vector 5: Python source parsed as TypeScript grammar — fail-open', async () => {
		const python = 'def f(): pass\nclass C: pass';
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', python);
		const elapsed = Date.now() - start;
		// Must not throw; null or partial/empty facts acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	// -----------------------------------------------------------------------
	// Vector 6: Pathological nesting — 500 levels of nested IIFEs.
	// Must not stack-overflow or hang; fail-open acceptable.
	// -----------------------------------------------------------------------
	test('vector 6: 500 levels of nested callbacks — bounded', async () => {
		// Build 500-level nesting: () => () => () => ...
		const levels = 500;
		let src = 'const x = ';
		for (let i = 0; i < levels; i++) {
			src += '(() => ';
		}
		src += '1';
		src += ')'.repeat(levels) + ';';
		expect(src.length).toBeLessThan(100_000); // ~6 KB, manageable size

		const start = Date.now();
		const facts = await extractFileSymbols('typescript', src);
		const elapsed = Date.now() - start;

		// Must not throw; null or partial facts both acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	// -----------------------------------------------------------------------
	// Vector 7: Unicode / emoji in identifiers and string content.
	// Must not throw.
	// -----------------------------------------------------------------------
	test('vector 7: Unicode and emoji identifiers — fail-open', async () => {
		const source =
			'function 名称() { return "こんにちは"; }\n' +
			'function 🐍() { return 42; }\n' +
			'const 变量 = 1;\n' +
			'class Élément { }\n';
		const start = Date.now();
		const facts = await extractFileSymbols('typescript', source);
		const elapsed = Date.now() - start;
		// Must not throw; null or partial facts both acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	// -----------------------------------------------------------------------
	// Vector 8: Pathological parse — source engineered to stress the
	// (identifier) @ref.identifier query with 50 000 identifiers.
	// The 500 ms AST_TIMEOUT_MS race should bound overall time.
	// -----------------------------------------------------------------------
	test('vector 8: 50 000 identifiers stress-test — bounded, no hang', async () => {
		// 50 000 single-identifier statements: "x0; x1; x2; ..."
		// All 50 000 identifiers are refs that must be matched by the query.
		const ids: string[] = [];
		for (let i = 0; i < 50_000; i++) ids.push(`x${i}`);
		const source = ids.join('; ') + ';';

		const start = Date.now();
		const facts = await extractFileSymbols('typescript', source);
		const elapsed = Date.now() - start;

		// Must not throw; null (timeout) or partial facts both acceptable
		expect(facts === null || typeof facts === 'object').toBe(true);
		// Must complete within a generous wall-clock — the 500 ms AST_TIMEOUT_MS
		// provides the hard bound for the overall operation.
		expect(elapsed).toBeLessThan(3000);
	});
});

// ---------------------------------------------------------------------------
// Per-grammar tests — task 1.2
// Each grammarId is exercised with: one exported/named def, one aliased
// import (where the language supports it), and one cross-symbol ref inside
// the def.  If a grammar's query captures the wrong node type, the test
// silently returns empty (safeMatches → no crash); we assert on exact
// shape so a wrong node type produces a FAIL — documenting a real bug to fix.
// ---------------------------------------------------------------------------

describe('extractFileSymbols — python grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased import + cross-symbol ref', async () => {
		// from os import path as p   → aliased binding
		// def main(): ...            → top-level def
		// p.join(...)                → cross-symbol ref inside main
		const source = `from os import path as p

def main():
    return p.join('a', 'b')
`;

		const facts = await extractFileSymbols('python', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: from os import path as p
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'os',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'path', local: 'p' },
		]);

		// ref: p.join inside main → enclosingDecl = 'main'
		const pRef = facts!.refs.find((r) => r.identifier === 'p');
		expect(pRef).toBeDefined();
		expect(pRef!.enclosingDecl).toBe('main');
	});

	test('decorators, methods, multi-imports, and star imports', async () => {
		const source = `import os, sys as system
from .pkg import Public as Alias, helper
from plugins import *

class Service:
    @cached
    async def run(self):
        return helper(os.getcwd())
`;

		const facts = await extractFileSymbols('python', source);
		expect(facts).not.toBeNull();

		const service = facts!.defs.find((d) => d.name === 'Service');
		const run = facts!.defs.find((d) => d.name === 'run');
		expect(service).toMatchObject({ kind: 'class', exported: true });
		expect(run).toMatchObject({ kind: 'method', exported: true });
		expect(run!.startLine).toBe(6);

		expect(facts!.imports).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: 'os',
					importType: 'namespace',
					bindings: [{ imported: 'os', local: 'os' }],
				}),
				expect.objectContaining({
					specifier: 'sys',
					importType: 'named',
					bindings: [{ imported: 'sys', local: 'system' }],
				}),
				expect.objectContaining({
					specifier: './pkg',
					importType: 'named',
					bindings: [
						{ imported: 'Public', local: 'Alias' },
						{ imported: 'helper', local: 'helper' },
					],
				}),
				expect.objectContaining({
					specifier: 'plugins',
					importType: 'namespace',
					bindings: [],
				}),
			]),
		);
	});

	test('FB-002: exported class methods are marked exported, private methods are not', async () => {
		// Regression test: tree-sitter path should match regex extractor behavior
		// for Python class method exported determination
		const source = `class Foo:
    def public_method(self): pass
    def _private_method(self): pass
`;
		const facts = await extractFileSymbols('python', source);
		expect(facts).not.toBeNull();

		const foo = facts!.defs.find((d) => d.name === 'Foo');
		const publicMethod = facts!.defs.find((d) => d.name === 'public_method');
		const privateMethod = facts!.defs.find((d) => d.name === '_private_method');

		// Foo is exported (public naming convention, no __all__)
		expect(foo).toMatchObject({ kind: 'class', exported: true });

		// public_method is exported because its parent class is exported
		expect(publicMethod).toMatchObject({ kind: 'method', exported: true });

		// _private_method is NOT exported (starts with _)
		expect(privateMethod).toMatchObject({ kind: 'method', exported: false });
	});

	test('FB-002: __init__ method is not exported even on exported class', async () => {
		const source = `class Foo:
    def __init__(self): pass
`;
		const facts = await extractFileSymbols('python', source);
		expect(facts).not.toBeNull();

		const foo = facts!.defs.find((d) => d.name === 'Foo');
		const init = facts!.defs.find((d) => d.name === '__init__');

		expect(foo).toMatchObject({ kind: 'class', exported: true });
		// __init__ is special: not exported even on exported class
		expect(init).toMatchObject({ kind: 'method', exported: false });
	});

	test('FB-002: methods on private class are not exported', async () => {
		const source = `class _Private:
    def public_method(self): pass
`;
		const facts = await extractFileSymbols('python', source);
		expect(facts).not.toBeNull();

		const privateClass = facts!.defs.find((d) => d.name === '_Private');
		const publicMethod = facts!.defs.find((d) => d.name === 'public_method');

		// _Private is not exported (starts with _)
		expect(privateClass).toMatchObject({ kind: 'class', exported: false });

		// public_method is NOT exported because its parent class is private
		expect(publicMethod).toMatchObject({ kind: 'method', exported: false });
	});

	test('FB-002: __all__ controls class export status, methods follow parent', async () => {
		const source = `__all__ = ['Foo', 'Bar']

class Foo:
    def foo_method(self): pass

class Bar:
    def bar_method(self): pass

class Baz:
    def baz_method(self): pass
`;
		const facts = await extractFileSymbols('python', source);
		expect(facts).not.toBeNull();

		const foo = facts!.defs.find((d) => d.name === 'Foo');
		const bar = facts!.defs.find((d) => d.name === 'Bar');
		const baz = facts!.defs.find((d) => d.name === 'Baz');
		const fooMethod = facts!.defs.find((d) => d.name === 'foo_method');
		const barMethod = facts!.defs.find((d) => d.name === 'bar_method');
		const bazMethod = facts!.defs.find((d) => d.name === 'baz_method');

		// Foo and Bar are in __all__, Baz is not
		expect(foo).toMatchObject({ kind: 'class', exported: true });
		expect(bar).toMatchObject({ kind: 'class', exported: true });
		expect(baz).toMatchObject({ kind: 'class', exported: false });

		// Methods on exported classes are exported
		expect(fooMethod).toMatchObject({ kind: 'method', exported: true });
		expect(barMethod).toMatchObject({ kind: 'method', exported: true });

		// Method on non-exported class is not exported
		expect(bazMethod).toMatchObject({ kind: 'method', exported: false });
	});
});

describe('extractFileSymbols — rust grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased use + cross-symbol ref', async () => {
		// use std::collections::HashMap as Map;  → aliased binding
		// fn main() { ... }                      → top-level def
		// Map::new()                             → cross-symbol ref inside main
		const source = `use std::collections::HashMap as Map;

fn main() {
    let _m: Map<u32, u32> = Map::new();
}
`;

		const facts = await extractFileSymbols('rust', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: use std::collections::HashMap as Map
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'std::collections',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'HashMap', local: 'Map' },
		]);

		// ref: Map inside main → enclosingDecl = 'main'
		const mapRef = facts!.refs.find((r) => r.identifier === 'Map');
		expect(mapRef).toBeDefined();
		expect(mapRef!.enclosingDecl).toBe('main');
	});

	test('captures Rust visibility, item kinds, impl methods, and grouped uses', async () => {
		const source = `use crate::models::{User, Account as Acct};

pub fn public_api() {}
pub(crate) struct InternalThing;
pub enum Mode { Fast }
pub trait Runner {}
mod private_mod {}

impl InternalThing {
    pub fn run(&self) {
        User::new();
    }
}
`;

		const facts = await extractFileSymbols('rust', source);
		expect(facts).not.toBeNull();

		expect(facts!.defs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'public_api',
					kind: 'function',
					exported: true,
					visibilityInfo: expect.objectContaining({ visibility: 'public' }),
				}),
				expect.objectContaining({
					name: 'InternalThing',
					kind: 'type',
					exported: true,
					visibilityInfo: expect.objectContaining({ visibility: 'internal' }),
				}),
				expect.objectContaining({ name: 'Mode', kind: 'enum', exported: true }),
				expect.objectContaining({
					name: 'Runner',
					kind: 'interface',
					exported: true,
				}),
				expect.objectContaining({
					name: 'private_mod',
					kind: 'type',
					exported: false,
				}),
				expect.objectContaining({ name: 'run', kind: 'method' }),
			]),
		);

		expect(facts!.imports[0]).toMatchObject({
			specifier: 'crate::models',
			importType: 'named',
			bindings: [
				{ imported: 'User', local: 'User' },
				{ imported: 'Account', local: 'Acct' },
			],
		});
	});
});

describe('extractFileSymbols — go grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased import + cross-symbol ref', async () => {
		// import f "fmt"   → aliased import (f is local alias for fmt)
		// func main() { }  → top-level def
		// f.Println(...)    → cross-symbol ref inside main
		const source = `import f "fmt"

func main() {
	f.Println("hello")
}
`;

		const facts = await extractFileSymbols('go', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: import f "fmt"
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'fmt',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'fmt', local: 'f' },
		]);

		// ref: f.Println inside main → enclosingDecl = 'main'
		const fRef = facts!.refs.find((r) => r.identifier === 'f');
		expect(fRef).toBeDefined();
		expect(fRef!.enclosingDecl).toBe('main');
	});

	test('go block imports (import (...)) resolve each specifier', async () => {
		// import ( "fmt" "os" ) — each specifier is a separate @import.specifier
		// capture fed as a bare quoted string to parseGoImport
		const source = `package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println(os.Args)
}
`;

		const facts = await extractFileSymbols('go', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});

		// imports: both "fmt" and "os" must resolve as namespace imports
		expect(facts!.imports).toHaveLength(2);
		const specifiers = facts!.imports.map((i) => i.specifier);
		expect(specifiers).toContain('fmt');
		expect(specifiers).toContain('os');
		expect(facts!.imports.every((i) => i.importType === 'namespace')).toBe(
			true,
		);

		// ref: fmt.Println and os.Args inside main → enclosingDecl = 'main'
		const fmtRef = facts!.refs.find((r) => r.identifier === 'fmt');
		expect(fmtRef).toBeDefined();
		expect(fmtRef!.enclosingDecl).toBe('main');
		const osRef = facts!.refs.find((r) => r.identifier === 'os');
		expect(osRef).toBeDefined();
		expect(osRef!.enclosingDecl).toBe('main');
	});

	// -------------------------------------------------------------------------
	// FIX 2 — Go aliased block imports (phase-council sme finding)
	// `import ( f "fmt" )` — parseGoImport previously required an `import ` prefix
	// on the aliased regex, so bare `f "fmt"` from a block-import child returned null.
	// -------------------------------------------------------------------------
	test('go aliased block import: import ( f "fmt" )', async () => {
		const source = `package main

import (
	f "fmt"
)

func main() {
	f.Println("hello")
}
`;

		const facts = await extractFileSymbols('go', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0].name).toBe('main');

		// import: f "fmt" aliased block spec → named with local alias 'f'
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'fmt',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'fmt', local: 'f' },
		]);

		// ref: f.Println inside main → enclosingDecl = 'main'
		const fRef = facts!.refs.find((r) => r.identifier === 'f');
		expect(fRef).toBeDefined();
		expect(fRef!.enclosingDecl).toBe('main');
	});

	test('captures Go exported names, methods, vars, consts, and special imports', async () => {
		const source = `package main

import (
	. "math"
	_ "embed"
	f "fmt"
)

type Service struct{}
var Version = "1"
const MaxRetries = 3

func PublicFunc() {
	f.Println(Sqrt(4))
}

func privateFunc() {}

func (s Service) Run() {
	PublicFunc()
}
`;

		const facts = await extractFileSymbols('go', source);
		expect(facts).not.toBeNull();

		expect(facts!.defs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'Service',
					kind: 'type',
					exported: true,
				}),
				expect.objectContaining({
					name: 'Version',
					kind: 'const',
					exported: true,
				}),
				expect.objectContaining({
					name: 'MaxRetries',
					kind: 'const',
					exported: true,
				}),
				expect.objectContaining({
					name: 'PublicFunc',
					kind: 'function',
					exported: true,
				}),
				expect.objectContaining({
					name: 'privateFunc',
					kind: 'function',
					exported: false,
				}),
				expect.objectContaining({
					name: 'Run',
					kind: 'method',
					exported: true,
				}),
			]),
		);

		expect(facts!.imports).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					specifier: 'math',
					importType: 'namespace',
					bindings: [{ imported: '*', local: '.' }],
				}),
				expect.objectContaining({
					specifier: 'embed',
					importType: 'sideeffect',
					bindings: [],
				}),
				expect.objectContaining({
					specifier: 'fmt',
					importType: 'named',
					bindings: [{ imported: 'fmt', local: 'f' }],
				}),
			]),
		);
	});
});

describe('extractFileSymbols — cpp grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + include import + cross-symbol ref', async () => {
		// #include <cstdio>  → preproc_include
		// int main() { }      → function_definition
		// std::printf(...)    → cross-symbol ref inside main
		const source = `#include <cstdio>

int main() {
	std::printf("x");
	return 0;
}
`;

		const facts = await extractFileSymbols('cpp', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: #include <cstdio>
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'cstdio',
			importType: 'namespace',
		});

		// ref: std (or printf) inside main
		// std::printf — 'std' is an identifier in a namespace qualifier context
		const stdRef = facts!.refs.find((r) => r.identifier === 'std');
		expect(stdRef).toBeDefined();
		expect(stdRef!.enclosingDecl).toBe('main');
	});
});

describe('extractFileSymbols — swift grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + import + cross-symbol ref', async () => {
		// import Foundation   → import_declaration
		// func main() { }     → function_declaration
		// print(Date())       → cross-symbol ref inside main
		const source = `import Foundation

func main() {
	print(Date())
}
`;

		const facts = await extractFileSymbols('swift', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: import Foundation
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'Foundation',
			importType: 'namespace',
		});

		// ref: Date() inside main → enclosingDecl = 'main'
		const dateRef = facts!.refs.find((r) => r.identifier === 'Date');
		expect(dateRef).toBeDefined();
		expect(dateRef!.enclosingDecl).toBe('main');
	});
});

describe('extractFileSymbols — dart grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased import + cross-symbol ref', async () => {
		// import 'dart:io' as io;   → aliased import
		// void main() { }          → function_signature
		// io.stdout.writeln(...)   → cross-symbol ref (io) inside main
		const source = `import 'dart:io' as io;

void main() {
	io.stdout.writeln('x');
}
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: import 'dart:io' as io
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'dart:io',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'dart:io', local: 'io' },
		]);

		// ref: io.stdout... inside main → enclosingDecl = 'main'
		const ioRef = facts!.refs.find((r) => r.identifier === 'io');
		expect(ioRef).toBeDefined();
		expect(ioRef!.enclosingDecl).toBe('main');
	});
});

describe('extractFileSymbols — ruby grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + require import + cross-symbol ref', async () => {
		// require 'json'        → call_expression require
		// def main; ... end    → method (ruby top-level def is a method node)
		// JSON.parse(...)      → cross-symbol ref (JSON) inside main
		const source = `require 'json'

def main
	JSON.parse('{}')
end
`;

		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();

		// def: main method
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: require 'json'
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'json',
			importType: 'namespace',
		});

		// ref: parse inside main → enclosingDecl = 'main'
		// Note: 'JSON' is a constant node in Ruby's tree-sitter grammar (not identifier),
		// so it is not captured by (identifier) @ref.identifier; 'parse' is the identifier.
		const parseRef = facts!.refs.find((r) => r.identifier === 'parse');
		expect(parseRef).toBeDefined();
		expect(parseRef!.enclosingDecl).toBe('main');
	});
});

describe('extractFileSymbols — php grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased use + cross-symbol ref', async () => {
		// use Ns\\Foo as F;   → namespace_use_declaration with alias
		// function main() { } → function_definition
		// F::bar()            → cross-symbol ref (F) inside main
		const source = `<?php
use Ns\\Foo as F;

function main() {
	F::bar();
}
`;

		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();

		// def: main function
		expect(facts!.defs).toHaveLength(1);
		expect(facts!.defs[0]).toMatchObject({
			name: 'main',
			kind: 'function',
		});
		expect(facts!.defs[0].startLine).toBeGreaterThan(0);
		expect(facts!.defs[0].endLine).toBeGreaterThanOrEqual(
			facts!.defs[0].startLine,
		);

		// import: use Ns\Foo as F
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'Ns\\Foo',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'Ns\\Foo', local: 'F' },
		]);

		// ref: F::bar() inside main → enclosingDecl = 'main'
		const fRef = facts!.refs.find((r) => r.identifier === 'F');
		expect(fRef).toBeDefined();
		expect(fRef!.enclosingDecl).toBe('main');
	});
});
