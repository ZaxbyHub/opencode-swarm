import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function def(
	facts: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>,
	name: string,
) {
	return facts.defs.find((item) => item.name === name);
}

describe('extractFileSymbols — dart hardening (#1531)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('captures import/export directives and underscore-private API convention', async () => {
		const source = `import './src/helper.dart' as helper;
import './src/util.dart' show pick, omit;
export './src/public_api.dart' show PublicApi;

class PublicWidget {}
mixin Renderable {}
enum Mode { fast }
extension StrExt on String {}
void _hidden() {}
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		// alias import: namespace prefix access, no fake named binding
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './src/helper.dart',
				importType: 'namespace',
				bindings: [],
			}),
		);
		// show import: named bindings for the shown symbols
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './src/util.dart',
				importType: 'named',
				bindings: [
					{ imported: 'pick', local: 'pick' },
					{ imported: 'omit', local: 'omit' },
				],
			}),
		);
		// export directive: a re-export edge with exported bindings
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './src/public_api.dart',
				reExport: true,
				exportedBindings: [{ imported: 'PublicApi', exported: 'PublicApi' }],
			}),
		);
		expect(def(facts!, 'PublicWidget')).toMatchObject({
			kind: 'class',
			exported: true,
		});
		expect(def(facts!, 'Renderable')).toMatchObject({
			kind: 'type',
			exported: true,
		});
		expect(def(facts!, 'Mode')).toMatchObject({
			kind: 'enum',
			exported: true,
		});
		expect(def(facts!, 'StrExt')).toMatchObject({
			kind: 'type',
			exported: true,
		});
		expect(def(facts!, '_hidden')).toMatchObject({
			kind: 'function',
			exported: false,
		});
	});

	test('body refs survive while refs inside import/export directives are dropped', async () => {
		const source = `import './a.dart' show Alpha;
export './b.dart' show Beta;

class Uses {
	void go() {
		Alpha.run();
	}
}
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		// 'Alpha' must appear as a body ref (inside go), not only on the import line
		const bodyAlpha = facts!.refs.find((r) => r.identifier === 'Alpha');
		expect(bodyAlpha).toBeDefined();
		// ...but only once: the import-line occurrence is filtered, not duplicated
		expect(facts!.refs.filter((r) => r.identifier === 'Alpha')).toHaveLength(1);
	});

	test('identical import statements collapse; distinct show-sets stay distinct', async () => {
		const source = `import 'package:a/a.dart' as a;
import 'package:a/a.dart' as b;
import 'x.dart' show One;
import 'x.dart' show Two;
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		const specifiers = facts!.imports.map((i) => i.specifier);
		// two alias imports of the same URI are one semantic namespace import
		expect(specifiers.filter((s) => s === 'package:a/a.dart')).toHaveLength(1);
		// show-sets differ → both remain
		const shown = facts!.imports.filter((i) => i.specifier === 'x.dart');
		expect(shown).toHaveLength(2);
		expect(
			shown.map((i) => i.bindings.map((b) => b.imported).join(',')),
		).toContain('One');
		expect(
			shown.map((i) => i.bindings.map((b) => b.imported).join(',')),
		).toContain('Two');
	});

	test('commented-out declarations are not augmented', async () => {
		const source = `// class Ghost {}
// enum Phantom { x }
class Real {}
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'Ghost')).toBeUndefined();
		expect(def(facts!, 'Phantom')).toBeUndefined();
		expect(def(facts!, 'Real')).toMatchObject({ kind: 'class' });
	});

	test('Dart 3 extension types, unnamed extensions, and typedefs', async () => {
		const source = `extension type Meters(int value) {}
extension on String {
	void shout() {}
}
sealed class Node {}
base class Leaf extends Node {}
typedef Callback = void Function(int);
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		// `extension type` must yield the TYPE's name — not a bogus def named
		// `type` from a bare `extension` match (reviewer finding R1)
		expect(def(facts!, 'Meters')).toMatchObject({ kind: 'type' });
		expect(def(facts!, 'type')).toBeUndefined();
		// unnamed `extension on X` carries no name — no def named `on`
		expect(def(facts!, 'on')).toBeUndefined();
		// Dart 3 class modifiers still capture the class name
		expect(def(facts!, 'Node')).toMatchObject({ kind: 'class' });
		expect(def(facts!, 'Leaf')).toMatchObject({ kind: 'class' });
		// typedef aliases are type defs
		expect(def(facts!, 'Callback')).toMatchObject({ kind: 'type' });
	});

	test('alias combined with show/hide clauses stays a namespace import', async () => {
		const source = `import 'pkg.dart' as p show Alpha, Beta;
import 'pkg2.dart' as q hide Gamma;
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'pkg.dart',
				importType: 'namespace',
				bindings: [],
			}),
		);
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'pkg2.dart',
				importType: 'namespace',
				bindings: [],
			}),
		);
	});
});

describe('extractFileSymbols — dart hardening round 2 (#2361 review)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('multiline show clause yields ONE import with all bindings (PRR-002)', async () => {
		const source = `import 'x.dart' show Alpha
    , Beta;
void main() {}
`;
		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(1);
		expect(facts!.imports[0]).toMatchObject({
			specifier: 'x.dart',
			importType: 'named',
			bindings: [
				{ imported: 'Alpha', local: 'Alpha' },
				{ imported: 'Beta', local: 'Beta' },
			],
		});
	});

	test('conditional import records both URIs (PRR-007)', async () => {
		const source = `import 'platform.dart' if (dart.library.io) 'io.dart';
void main() {}
`;
		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({ specifier: 'platform.dart' }),
		);
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({ specifier: 'io.dart' }),
		);
	});

	test('bare import stays a namespace import with no bindings (R10)', async () => {
		const facts = await extractFileSymbols('dart', "import 'm.dart';\n");
		expect(facts).not.toBeNull();
		expect(facts!.imports).toEqual([
			{ specifier: 'm.dart', importType: 'namespace', bindings: [] },
		]);
	});

	test('CRLF sources produce identical dart defs to LF', async () => {
		const lf = `class Model {}
mixin Renderable {}
void main() {}
`;
		const crlf = lf.replace(/\n/g, '\r\n');
		const lfFacts = await extractFileSymbols('dart', lf);
		const crlfFacts = await extractFileSymbols('dart', crlf);
		expect(crlfFacts!.defs).toEqual(lfFacts!.defs);
	});

	test('import-shaped text inside a multiline string is not an edge (R4)', async () => {
		const source = `var doc = '''
import 'phantom.dart';
''';
import 'real.dart';
`;
		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(
			facts!.imports.filter((i) => i.specifier.includes('phantom')),
		).toHaveLength(0);
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({ specifier: 'real.dart' }),
		);
	});

	test('triple-quoted strings with inner apostrophes do not flip the mask (round 3)', async () => {
		const source = `var doc = '''
it's here
import 'phantom.dart';
''';
import 'real2.dart';
`;
		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(
			facts!.imports.filter((i) => i.specifier.includes('phantom')),
		).toHaveLength(0);
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({ specifier: 'real2.dart' }),
		);
	});
});
