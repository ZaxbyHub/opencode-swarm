/**
 * C/C++ and Swift import-form coverage for issue #1530. Mirrors the KG-08
 * `symbol-graph-jvm-dotnet-imports.test.ts` structure: real grammars, no
 * mocks, asserting the normalized import records the graph builder consumes.
 *
 * The include/import distinction is an acceptance criterion: quoted local
 * includes become './'-relative namespace imports (whole-file semantics,
 * resolvable to file edges by resolveModuleSpecifier); angle-bracket includes
 * stay external/unresolved namespace imports; Swift kind-qualified imports
 * split module vs symbol.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

describe('extractFileSymbols C/C++ include forms (issue #1530)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('quoted include is a ./-relative whole-file (namespace) import', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'#include "util.h"\nint main() { return 0; }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: './util.h',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('quoted include with subpath keeps its relative shape', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'#include "sub/nested.h"\n#include "../other/up.h"\nint main() { return 0; }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: './sub/nested.h',
			importType: 'namespace',
			bindings: [],
		});
		// Already-relative specifiers are not re-prefixed.
		expect(facts!.imports).toContainEqual({
			specifier: '../other/up.h',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('angle include stays an external namespace import', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'#include <stdio.h>\n#include <vector>\nint main() { return 0; }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'stdio.h',
			importType: 'namespace',
			bindings: [],
		});
		expect(facts!.imports).toContainEqual({
			specifier: 'vector',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('using declaration and using directive are namespace imports', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'using engine::Engine;',
				'using namespace std;',
				'int main() { return 0; }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'engine::Engine',
			importType: 'namespace',
			bindings: [],
		});
		expect(facts!.imports).toContainEqual({
			specifier: 'std',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('non-include preprocessor lines are not imports', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'#define MAX 10\n#ifdef WIN32\n#endif\nint main() { return MAX; }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports.length).toBe(0);
	});
});

describe('extractFileSymbols Swift import forms (issue #1530)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('bare module import is a namespace import', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'import Foundation\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'Foundation',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('kind-qualified import splits module specifier and named binding', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'import class Foo.Bar',
				'import struct Foundation.Date',
				'import func Darwin.exit',
				'func f() { return 1 }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'Foo',
			importType: 'named',
			bindings: [{ imported: 'Bar', local: 'Bar' }],
		});
		expect(facts!.imports).toContainEqual({
			specifier: 'Foundation',
			importType: 'named',
			bindings: [{ imported: 'Date', local: 'Date' }],
		});
		expect(facts!.imports).toContainEqual({
			specifier: 'Darwin',
			importType: 'named',
			bindings: [{ imported: 'exit', local: 'exit' }],
		});
	});

	test('submodule dotted import without a kind stays a namespace import', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'import Foo.Sub\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'Foo.Sub',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('multi-dot kind-qualified import resolves module and trailing symbol', async () => {
		// Pre-fix regression (review finding): `import class Foo.Bar.Baz` was
		// silently dropped (null) — the qualified regex allowed exactly one dot.
		const facts = await extractFileSymbols(
			'swift',
			'import class Foo.Bar.Baz\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'Foo',
			importType: 'named',
			bindings: [{ imported: 'Baz', local: 'Baz' }],
		});
	});

	test('kind keyword without a dotted path is kept, not dropped', async () => {
		// Not valid Swift, but the conservative behavior is a namespace import
		// of the written specifier — never a silently missing import.
		const facts = await extractFileSymbols(
			'swift',
			'import classFoo\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'classFoo',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('attribute with nested parens on an import is a documented drop', async () => {
		// Known limitation (PR #2351 review PRR-003): the attribute-argument
		// scanner stops at the first ')' and cannot span nested parens, so
		// `@objc(foo(bar)) import X` fails to parse and yields no import.
		// Real Swift import attributes (@_testable, @_exported,
		// @_implementationOnly) never carry nested parens; pinned so a change
		// here is conscious.
		const facts = await extractFileSymbols(
			'swift',
			'@objc(foo(bar)) import Foundation\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports.length).toBe(0);
	});

	test('attribute-prefixed imports are parsed, not dropped', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'@_testable import MyApp\n@_exported import Foundation\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual({
			specifier: 'MyApp',
			importType: 'namespace',
			bindings: [],
		});
		expect(facts!.imports).toContainEqual({
			specifier: 'Foundation',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('import identifiers do not leak into refs', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'import Foundation\nfunc f() { return 1 }\n',
		);
		expect(facts).not.toBeNull();
		expect(facts!.refs.some((r) => r.identifier === 'Foundation')).toBe(false);
	});

	test('swift parameter names are filtered from refs', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'func f(_ input: Int) -> Int { return input }\n',
		);
		expect(facts).not.toBeNull();
		// The parameter NAMES ('_', 'input') are declarations, not references;
		// the body usage of `input` IS a reference.
		expect(facts!.refs.some((r) => r.identifier === '_')).toBe(false);
		const bodyUses = facts!.refs.filter((r) => r.identifier === 'input');
		expect(bodyUses.length).toBe(1);
	});

	test('swift type references appear in refs (type_identifier capture)', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'class Holder {}',
				'',
				'func make(_ h: Holder) -> Holder {',
				'    return Holder()',
				'}',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		// Return-type AND constructor-call type references surface (pins the
		// (type_identifier) @ref.identifier pattern in the swift refs query).
		// The parameter-position `h: Holder` does NOT — the swift-only
		// parameter-node ref filter (see SWIFT_REF_PARAM_TYPES) skips the
		// whole parameter node, so exactly 2 remain.
		const holderRefs = facts!.refs.filter((r) => r.identifier === 'Holder');
		expect(holderRefs.length).toBe(2);
	});

	test('parameter-position type refs stay captured for csharp/kotlin (final-critic pin)', async () => {
		// The swift-only `parameter` ref skip must NOT leak into grammars that
		// share the node-type name: a Kotlin named-import binding referenced
		// ONLY in parameter position must still count as used (it feeds
		// usedSymbols and symbol edges in the graph builder).
		const kotlinFacts = await extractFileSymbols(
			'kotlin',
			'import m.Widget\n\nfun build(w: Widget) { }\n',
		);
		expect(kotlinFacts).not.toBeNull();
		expect(
			kotlinFacts!.refs.some((r) => r.identifier === 'Widget'),
			'kotlin parameter-position type ref must stay a ref',
		).toBe(true);

		const csharpFacts = await extractFileSymbols(
			'csharp',
			'using M.Thing;\n\nclass C {\n    void Handle(Thing t) { }\n}\n',
		);
		expect(csharpFacts).not.toBeNull();
		expect(
			csharpFacts!.refs.some((r) => r.identifier === 'Thing'),
			'csharp parameter-position type ref must stay a ref',
		).toBe(true);
	});
});
