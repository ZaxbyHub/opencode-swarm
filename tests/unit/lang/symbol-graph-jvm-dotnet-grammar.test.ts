/**
 * Java / Kotlin / C# grammar coverage for `extractFileSymbols`.
 *
 * Extracted from `symbol-graph.test.ts` for issue #1529: that file is far over
 * the 500-line FR-006 cap, and the diff-scoped ratchet forbids an over-cap file
 * the PR touches from growing. The JVM/.NET blocks moved here verbatim (plus
 * the import-binding realignments this issue required), which shrinks the
 * original well below its previous size and keeps these cases beside their
 * siblings in `symbol-graph-jvm-dotnet*.test.ts`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

describe('extractFileSymbols — java grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + import + cross-symbol ref', async () => {
		// import java.util.List;   → no alias in Java
		// public class C { ... }   → class def
		// void m(){ List x = null; } → method def + List ref inside
		const source = `import java.util.List;

public class C {
	void m() {
		List<String> x = null;
	}
}
`;

		const facts = await extractFileSymbols('java', source);
		expect(facts).not.toBeNull();

		// defs: class C + method m
		const defNames = facts!.defs.map((d) => d.name);
		expect(defNames).toContain('C');
		expect(defNames).toContain('m');

		// import: java.util.List
		// Realigned for issue #1529. A Java single-type import binds exactly one
		// name, so it is a NAMED import carrying a binding — not a namespace
		// import. The binding is load-bearing: the graph builder populates
		// `localToImported` solely from `imp.bindings` and emits
		// `toSymbol: mapping.imported`, so `bindings: []` made a Java symbol edge
		// impossible to form. `imported` is the final dotted segment because it is
		// matched against def names in the TARGET file.
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'java.util.List',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'List', local: 'List' },
		]);

		// ref: List inside method m → enclosingDecl = 'C' (class, nearest top-level decl)
		const listRef = facts!.refs.find((r) => r.identifier === 'List');
		expect(listRef).toBeDefined();
		expect(listRef!.enclosingDecl).toBe('C');
	});

	// -------------------------------------------------------------------------
	// FIX 4 (Java portion) — interface declaration + static import
	// -------------------------------------------------------------------------
	test('def + interface def + static import + cross-symbol ref', async () => {
		// import java.util.Collections;         → regular import
		// import static java.lang.Math.max;     → static import
		// public interface I { }                → interface def
		// class C implements I {                → class def
		//   int m() { return max(1, 2); }       → method def + max ref
		const source = `import java.util.Collections;
import static java.lang.Math.max;

public interface I { }

class C implements I {
	int m() {
		return max(1, 2);
	}
}
`;

		const facts = await extractFileSymbols('java', source);
		expect(facts).not.toBeNull();

		// defs: interface I, class C, method m
		const defNames = facts!.defs.map((d) => d.name);
		expect(defNames).toContain('I');
		expect(defNames).toContain('C');
		expect(defNames).toContain('m');

		// Interface I must be captured as interface kind
		const iDef = facts!.defs.find((d) => d.name === 'I');
		expect(iDef).toBeDefined();
		expect(iDef!.kind).toBe('interface');

		// imports: Collections (regular) + Math.max (static)
		expect(facts!.imports.length).toBeGreaterThanOrEqual(2);
		// Realigned for issue #1529 — see the note on the single-type import above.
		const collImport = facts!.imports.find(
			(i) => i.specifier === 'java.util.Collections',
		);
		expect(collImport).toBeDefined();
		expect(collImport!.importType).toBe('named');
		expect(collImport!.bindings).toEqual([
			{ imported: 'Collections', local: 'Collections' },
		]);

		// A static import names a MEMBER of a type, so the module specifier is the
		// declaring type and the member becomes the binding. Keeping the member
		// glued onto the specifier (`java.lang.Math.max`) gave
		// `resolveModuleSpecifier` a target that can never name a file.
		const maxImport = facts!.imports.find(
			(i) => i.specifier === 'java.lang.Math',
		);
		expect(maxImport).toBeDefined();
		expect(maxImport!.importType).toBe('named');
		expect(maxImport!.bindings).toEqual([{ imported: 'max', local: 'max' }]);

		// ref: max inside method m → enclosingDecl = 'C' (class, nearest top-level)
		const maxRef = facts!.refs.find((r) => r.identifier === 'max');
		expect(maxRef).toBeDefined();
		expect(maxRef!.enclosingDecl).toBe('C');
	});
});

describe('extractFileSymbols — kotlin grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased import + cross-symbol ref', async () => {
		// import kotlin.collections.List as L  → aliased binding
		// fun main() { }                      → top-level def
		// val x: L<String> = ...              → cross-symbol ref inside main
		const source = `import kotlin.collections.List as L

fun main() {
	val x: L<String> = listOf()
}
`;

		const facts = await extractFileSymbols('kotlin', source);
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

		// import: import kotlin.collections.List as L
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'kotlin.collections.List',
			importType: 'named',
		});
		// Realigned for issue #1529. `imported` must be the symbol name as defined
		// in the target file, because the builder emits it as `toSymbol` and
		// matches it against that file's def names. The previous full dotted path
		// could never match any def, so the resulting symbol edge was permanently
		// unresolvable — the assertion pinned a bug.
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'List', local: 'L' },
		]);

		// ref: L inside main → enclosingDecl = 'main'
		const lRef = facts!.refs.find((r) => r.identifier === 'L');
		expect(lRef).toBeDefined();
		expect(lRef!.enclosingDecl).toBe('main');
	});
});

describe('extractFileSymbols — csharp grammar', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('def + aliased using + cross-symbol ref', async () => {
		// using S = System;  → aliased using directive
		// void M() { }       → method def inside class
		// S.Console.WriteLine()  → cross-symbol ref inside M
		const source = `using S = System;

class C {
	void M() {
		S.Console.WriteLine("x");
	}
}
`;

		const facts = await extractFileSymbols('csharp', source);
		expect(facts).not.toBeNull();

		// defs: class C + method M
		const defNames = facts!.defs.map((d) => d.name);
		expect(defNames).toContain('C');
		expect(defNames).toContain('M');

		// import: using S = System
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'System',
			importType: 'named',
		});
		expect(facts!.imports[0].bindings).toEqual([
			{ imported: 'System', local: 'S' },
		]);

		// ref: S.Console... inside M → enclosingDecl = 'C' (class, nearest top-level decl)
		const sRef = facts!.refs.find((r) => r.identifier === 'S');
		expect(sRef).toBeDefined();
		expect(sRef!.enclosingDecl).toBe('C');
	});
});
