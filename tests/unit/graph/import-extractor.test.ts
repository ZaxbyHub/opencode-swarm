import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	extractImports,
	getLanguageFromExtension,
	SOURCE_EXTENSIONS,
} from '../../../src/graph/import-extractor';

let tmp: string;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-import-'));
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
	const abs = path.join(tmp, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return abs;
}

describe('getLanguageFromExtension', () => {
	it('maps known extensions', () => {
		expect(getLanguageFromExtension('.ts')).toBe('typescript');
		expect(getLanguageFromExtension('.tsx')).toBe('typescript');
		expect(getLanguageFromExtension('.js')).toBe('javascript');
		expect(getLanguageFromExtension('.py')).toBe('python');
		expect(getLanguageFromExtension('.pyw')).toBe('python');
		expect(getLanguageFromExtension('.go')).toBe('go');
		expect(getLanguageFromExtension('.rs')).toBe('rust');
	});
	it('returns null for unknown extensions', () => {
		expect(getLanguageFromExtension('.xyz')).toBeNull();
		expect(getLanguageFromExtension('')).toBeNull();
	});
	it('exports the source extensions array', () => {
		expect(SOURCE_EXTENSIONS).toContain('.ts');
		expect(SOURCE_EXTENSIONS).toContain('.py');
		expect(SOURCE_EXTENSIONS).toContain('.pyw');
	});
});

describe('extractImports — TypeScript/JavaScript', () => {
	it('resolves a relative named import to a sibling .ts file', () => {
		write('utils.ts', 'export const x = 1;\n');
		const a = write('a.ts', "import { x } from './utils';\nconsole.log(x);\n");
		const edges = extractImports({ absoluteFilePath: a, workspaceRoot: tmp });
		expect(edges).toHaveLength(1);
		expect(edges[0].source).toBe('a.ts');
		expect(edges[0].target).toBe('utils.ts');
		expect(edges[0].importedSymbols).toEqual(['x']);
		expect(edges[0].importType).toBe('named');
	});

	it('resolves index files', () => {
		write('lib/index.ts', 'export const y = 2;\n');
		const b = write('b.ts', "import { y } from './lib';\n");
		const edges = extractImports({ absoluteFilePath: b, workspaceRoot: tmp });
		expect(edges).toHaveLength(1);
		expect(edges[0].target).toBe('lib/index.ts');
	});

	it('captures default and namespace imports', () => {
		write('mod-d.ts', 'export default 1;\n');
		write('mod-n.ts', 'export const z = 3;\n');
		const c = write(
			'c.ts',
			"import D from './mod-d';\nimport * as N from './mod-n';\n",
		);
		const edges = extractImports({ absoluteFilePath: c, workspaceRoot: tmp });
		const types = edges.map((e) => e.importType).sort();
		expect(types).toEqual(['default', 'namespace']);
	});

	it('records external package imports with empty target (no graph edge)', () => {
		const d = write('d.ts', "import { something } from 'react';\n");
		const edges = extractImports({ absoluteFilePath: d, workspaceRoot: tmp });
		// External packages still appear in the import list (rawModule preserved)
		// but have no resolved target, so they produce no reverse-graph edge.
		expect(edges.every((e) => e.target === '')).toBe(true);
	});

	it('handles ESM .js suffix pointing at a .ts source', () => {
		write('helper.ts', 'export const h = 4;\n');
		const e = write('e.ts', "import { h } from './helper.js';\n");
		const edges = extractImports({ absoluteFilePath: e, workspaceRoot: tmp });
		expect(edges).toHaveLength(1);
		expect(edges[0].target).toBe('helper.ts');
	});

	it('records the ORIGINAL exported name for aliased imports', () => {
		// Symbol-consumer queries match on exported names. Storing only the
		// local alias `sum` would under-report `getSymbolConsumers(g, util, "add")`.
		write(
			'util.ts',
			'export function add(a: number, b: number) { return a + b; }\n',
		);
		const f = write(
			'caller.ts',
			"import { add as sum } from './util';\nconsole.log(sum(1, 2));\n",
		);
		const edges = extractImports({ absoluteFilePath: f, workspaceRoot: tmp });
		expect(edges).toHaveLength(1);
		expect(edges[0].importedSymbols).toEqual(['add']);
	});

	it('does not match `import ... from ...` text inside string literals', () => {
		// Templating/codegen/docs frequently contain import-like prose. The
		// extractor must not synthesise phantom edges from those strings.
		write('real-target.ts', 'export const r = 1;\n');
		const g = write(
			'codegen.ts',
			[
				"import { r } from './real-target';",
				'const example = "import { fake } from \\"./does-not-exist\\";";',
				'const tpl = `import { other } from "./also-not-real";`;',
				'console.log(r, example, tpl);',
			].join('\n'),
		);
		const edges = extractImports({ absoluteFilePath: g, workspaceRoot: tmp });
		// Only the real import should show up.
		expect(edges).toHaveLength(1);
		expect(edges[0].rawModule).toBe('./real-target');
		expect(edges[0].target).toBe('real-target.ts');
	});

	it('does not match `require(...)` / dynamic `import(...)` inside strings', () => {
		write('real-dep.ts', 'export const d = 1;\n');
		const h = write(
			'host.ts',
			[
				"const real = require('./real-dep');",
				'const docs = "require(\\"./fake-dep\\")";',
				'const more = \'await import(\\"./also-fake\\")\';',
				'console.log(real, docs, more);',
			].join('\n'),
		);
		const edges = extractImports({ absoluteFilePath: h, workspaceRoot: tmp });
		expect(edges).toHaveLength(1);
		expect(edges[0].rawModule).toBe('./real-dep');
		expect(edges[0].target).toBe('real-dep.ts');
	});
});

describe('extractImports — Python', () => {
	it('resolves a relative `from x import y`', () => {
		write('pkg/__init__.py', '');
		write('pkg/util.py', 'def foo(): pass\n');
		const a = write('pkg/main.py', 'from .util import foo\n');
		const edges = extractImports({ absoluteFilePath: a, workspaceRoot: tmp });
		expect(edges.length).toBeGreaterThanOrEqual(1);
		const target = edges[0].target;
		expect(target.endsWith('util.py')).toBe(true);
	});

	it('recognizes .pyw as Python', () => {
		write('pkg/util.pyw', 'def foo(): pass\n');
		const a = write('pkg/main.pyw', 'from .util import foo\n');
		const edges = extractImports({ absoluteFilePath: a, workspaceRoot: tmp });
		expect(edges[0].target.endsWith('util.pyw')).toBe(true);
	});
});

describe('extractImports - Go and Rust', () => {
	it('marks Go blank imports as side effects', () => {
		const a = write('main.go', 'package main\n\nimport _ "embed"\n');
		const edges = extractImports({ absoluteFilePath: a, workspaceRoot: tmp });
		expect(edges[0]).toMatchObject({
			rawModule: 'embed',
			importType: 'sideeffect',
		});
	});

	it('decomposes Rust grouped uses into named imported symbols', () => {
		const a = write('lib.rs', 'use crate::models::{User, Account as Acct};\n');
		const edges = extractImports({ absoluteFilePath: a, workspaceRoot: tmp });
		expect(edges[0]).toMatchObject({
			rawModule: 'crate::models',
			importType: 'named',
			importedSymbols: ['User', 'Acct'],
		});
	});

	it('extracts symbols with :: paths inside grouped braces (FB-003)', () => {
		const a = write(
			'lib.rs',
			'use crate::{Item, submodule::Item2, alias_name::Item3 as Renamed};\n',
		);
		const edges = extractImports({ absoluteFilePath: a, workspaceRoot: tmp });
		expect(edges[0]).toMatchObject({
			rawModule: 'crate',
			importType: 'named',
			importedSymbols: ['Item', 'Item2', 'Renamed'],
		});
	});
});

describe('extractImports — regression: paren-preceded strings (F1)', () => {
	it('does not synthesise edges from arbitrary call(arg) strings', () => {
		// A previous fix used a too-permissive `content[j] === '('` lookback,
		// which whitelisted ANY (-preceded string literal as an "import source"
		// — including innocent function arguments like `console.log("./fake")`.
		// The keyword check must require literal `require(`/`import(`/`from`.
		write('real-x.ts', 'export const x = 1;\n');
		const f = write(
			'caller.ts',
			[
				"import { x } from './real-x';",
				"console.log('./does-not-exist');",
				"throw new Error('./also-not-real');",
				"someHelper('./and-not-this-either');",
				'console.log(x);',
			].join('\n'),
		);
		const edges = extractImports({ absoluteFilePath: f, workspaceRoot: tmp });
		expect(edges).toHaveLength(1);
		expect(edges[0].rawModule).toBe('./real-x');
	});

	it('does not synthesise edges from member-expression require/import (F1.1)', () => {
		// `\brequire` / `\bimport` are satisfied by a leading `.` (a non-word
		// char), so `obj.require("./x")` and `obj.import("./x")` previously
		// slipped through. Both the regex pass and the string-range lookback
		// must reject member-expression calls.
		write('real-z.ts', 'export const z = 1;\n');
		const f = write(
			'member.ts',
			[
				"import { z } from './real-z';",
				"someHelper.require('./fake-member-require');",
				"obj.import('./fake-member-import');",
				"const docs = 'someHelper.require(\\'./also-fake\\')';",
				'console.log(z);',
			].join('\n'),
		);
		const edges = extractImports({ absoluteFilePath: f, workspaceRoot: tmp });
		// Only the real `import { z } from './real-z'` survives.
		expect(edges).toHaveLength(1);
		expect(edges[0].rawModule).toBe('./real-z');
	});

	it('still recognises real require/import calls preceded by a (', () => {
		// Word-boundary keyword matching must not false-negative the real cases.
		write('real-y.ts', 'export const y = 2;\n');
		const f = write(
			'caller2.ts',
			[
				"const r = require('./real-y');",
				"const d = await import('./real-y');",
				'console.log(r, d);',
			].join('\n'),
		);
		const edges = extractImports({ absoluteFilePath: f, workspaceRoot: tmp });
		// require + dynamic import → 2 edges to real-y.ts
		expect(edges.length).toBe(2);
		expect(edges.every((e) => e.target === 'real-y.ts')).toBe(true);
	});
});

describe('extractImports — regression: line numbers for non-first imports (F2)', () => {
	it('reports the actual import line, not line - 1', () => {
		// The TS_IMPORT_RE / TS_SIDEEFFECT_RE patterns consume a leading `\n`,
		// so `m.index` points at the newline (the previous line). Line numbers
		// must be computed from the keyword offset, not m.index.
		write('a.ts', 'export const a = 1;\n');
		write('b.ts', 'export const b = 2;\n');
		const c = write(
			'consumer.ts',
			[
				'// header comment',
				"import { a } from './a';",
				"import { b } from './b';",
			].join('\n'),
		);
		const edges = extractImports({ absoluteFilePath: c, workspaceRoot: tmp });
		const aEdge = edges.find((e) => e.target === 'a.ts');
		const bEdge = edges.find((e) => e.target === 'b.ts');
		expect(aEdge?.line).toBe(2);
		expect(bEdge?.line).toBe(3);
	});
});

describe('extractImports — error handling', () => {
	it('returns [] for unsupported extensions', () => {
		const f = write('readme.md', '# hi\n');
		const edges = extractImports({ absoluteFilePath: f, workspaceRoot: tmp });
		expect(edges).toEqual([]);
	});

	it('returns [] for missing files', () => {
		const edges = extractImports({
			absoluteFilePath: path.join(tmp, 'does-not-exist.ts'),
			workspaceRoot: tmp,
		});
		expect(edges).toEqual([]);
	});
});

describe('extractImports — regression: control characters in import specifiers (F3)', () => {
	// Prior to this fix, the TS/JS regex used [^'"`]+ and Go used [^"`]+, neither
	// excluding control characters.  A file whose import path contains a literal
	// CR (\r), LF (\n), TAB (\t), or NUL (\0) byte caused the dirty character to
	// propagate into ImportEdge.rawModule and ultimately into the saved graph JSON.
	// The same class of bug was fixed in src/tools/repo-graph.ts in #538 via a
	// belt-and-suspenders containsControlChars() guard.  This block is the
	// equivalent regression guard for src/graph/import-extractor.ts.

	it('does not produce edges when a TS import specifier contains a CR byte', () => {
		// Write the file in binary mode so the CR is a literal byte, not \\r.
		const cr = String.fromCharCode(13);
		const abs = path.join(tmp, 'ctrl-cr.ts');
		fs.writeFileSync(
			abs,
			`import x from './bar${cr}.js';\nimport y from './ok-ctrl';\n`,
			'binary',
		);
		write('ok-ctrl.ts', 'export {};');
		const edges = extractImports({ absoluteFilePath: abs, workspaceRoot: tmp });
		// The dirty edge must be dropped; only the clean one survives.
		for (const e of edges) {
			expect(containsControlCharsTest(e.rawModule)).toBe(false);
		}
		const targets = edges.map((e) => e.target);
		expect(targets).toContain('ok-ctrl.ts');
		expect(targets.some((t) => t.includes(cr))).toBe(false);
	});

	it('does not produce edges when a TS require() specifier contains a null byte', () => {
		const nul = String.fromCharCode(0);
		const abs = path.join(tmp, 'ctrl-nul.ts');
		fs.writeFileSync(
			abs,
			`const r = require('./bad${nul}module');\nconst s = require('./good-ctrl');\n`,
			'binary',
		);
		write('good-ctrl.ts', 'export {};');
		const edges = extractImports({ absoluteFilePath: abs, workspaceRoot: tmp });
		for (const e of edges) {
			expect(containsControlCharsTest(e.rawModule)).toBe(false);
		}
	});

	it('does not produce edges when a Go import specifier contains a CR byte', () => {
		const cr = String.fromCharCode(13);
		const abs = path.join(tmp, 'main.go');
		fs.writeFileSync(
			abs,
			`package main\nimport (\n  "fmt"\n  "my/pkg${cr}/sub"\n)\n`,
			'binary',
		);
		const edges = extractImports({ absoluteFilePath: abs, workspaceRoot: tmp });
		for (const e of edges) {
			expect(containsControlCharsTest(e.rawModule)).toBe(false);
		}
	});

	it('retains clean specifiers when a file mixes dirty and clean imports', () => {
		const cr = String.fromCharCode(13);
		write('clean-sibling.ts', 'export const ok = 1;\n');
		const abs = path.join(tmp, 'mixed-ctrl.ts');
		fs.writeFileSync(
			abs,
			[
				`import bad from './dirty${cr}.js';`,
				"import { ok } from './clean-sibling';",
			].join('\n'),
			'binary',
		);
		const edges = extractImports({ absoluteFilePath: abs, workspaceRoot: tmp });
		// dirty edge dropped; clean edge kept
		expect(edges).toHaveLength(1);
		expect(edges[0].rawModule).toBe('./clean-sibling');
		expect(edges[0].target).toBe('clean-sibling.ts');
	});
});

/** Helper mirrors containsControlChars from path-security (avoids importing it in tests). */
function containsControlCharsTest(s: string): boolean {
	return /[\0\t\r\n]/.test(s);
}
