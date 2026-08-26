import { beforeEach, describe, expect, test } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

/**
 * RECURRENCE GUARDRAIL — issue #1529, Phase 4.2.
 *
 * Defect class: "a language is registered in LANGUAGE_REGISTRY and has a
 * QUERIES entry, but its extraction path was never specialised, so it silently
 * produces no member-level or binding-level facts."
 *
 * That is exactly how #1529 escaped: Java/Kotlin/C# were fully registered and
 * DID produce defs and imports, so any 'at least one def' smoke check passed
 * on the broken code. What was missing was narrower and invisible:
 *   - class members were typed 'function' instead of 'method', and
 *   - imports carried `bindings: []`, making symbol edges impossible.
 *
 * This table therefore asserts MEMBER-LEVEL and BINDING-LEVEL facts, not def
 * counts. It is exhaustive over the registry by construction: a profile with no
 * entry in EXPECTATIONS fails the completeness test below, so adding a language
 * forces a conscious decision rather than a silent skip.
 *
 * HOW TO DEMONSTRATE IT BITES (re-run after either mutation; both must fail):
 *   1. In src/lang/symbol-graph.ts, delete `'java'` from JVM_GRAMMARS so Java
 *      members stop being re-typed to 'method'  -> the java row fails on
 *      expectMethods. (This is the ACTUAL #1529 failure mode. Deleting a whole
 *      QUERIES entry is NOT an adequate demo: that makes extractFileSymbols
 *      return null, which is a different, louder bug.)
 *   2. In src/lang/symbol-graph.ts, make parseJavaImport return `bindings: []`
 *      -> the java row fails on expectBindings.
 */

interface Expectation {
	/** Minimal source exercising an import, a type, and a member. */
	source: string;
	/** Does this grammar type container members as kind 'method'? */
	expectMethods: boolean;
	/** Does this grammar produce at least one import carrying bindings? */
	expectBindings: boolean;
	/** Required whenever an expect* flag is false: why that is correct today. */
	reason?: string;
}

const EXPECTATIONS: Record<string, Expectation> = {
	typescript: {
		source:
			"import { a } from './m';\nexport class C { public m(): number { return a; } }\n",
		expectMethods: true,
		expectBindings: true,
	},
	javascript: {
		source: "import { a } from './m';\nexport class C { m() { return a; } }\n",
		expectMethods: true,
		expectBindings: true,
	},
	python: {
		source: 'from m import a\nclass C:\n    def m(self):\n        return a\n',
		expectMethods: true,
		expectBindings: true,
	},
	rust: {
		source:
			'use m::a;\npub struct C;\nimpl C { pub fn m(&self) -> u32 { a } }\n',
		expectMethods: true,
		expectBindings: true,
	},
	go: {
		// Explicitly ALIASED import. A bare `import "m"` genuinely has no
		// bindings — Go binds the package name implicitly — so asserting
		// `expectBindings` against a bare import was asserting the wrong thing.
		// It passed only because the single-line bare form captured the literal
		// keyword `import` as an alias, emitting `{imported:'m', local:'import'}`;
		// the block form correctly emitted none, so the two disagreed. With that
		// fixed, this row needs an import that really does carry a binding.
		source:
			'package p\nimport m "m"\ntype C struct{}\nfunc (c C) M() { m.A() }\n',
		expectMethods: true,
		expectBindings: true,
	},
	java: {
		source:
			'package p;\nimport m.A;\npublic class C { public void m() { A.x(); } }\n',
		expectMethods: true,
		expectBindings: true,
	},
	kotlin: {
		source: 'package p\nimport m.A\nclass C { fun m() { A.x() } }\n',
		expectMethods: true,
		expectBindings: true,
	},
	csharp: {
		source:
			'namespace P;\nusing A = M.Thing;\npublic class C { public void M2() { } }\n',
		expectMethods: true,
		expectBindings: true,
	},
	cpp: {
		source: '#include <m>\nclass C { public: void m() {} };\n',
		expectMethods: true,
		// C/C++ includes bind no named symbol: a quoted include imports the
		// whole file and an angle include is external (issue #1530).
		expectBindings: false,
		reason:
			'C/C++ includes never carry named bindings: quoted includes import the whole file, angle includes are external/unresolved.',
	},
	swift: {
		source: 'import M\npublic class C { public func m() {} }\n',
		expectMethods: true,
		// A bare `import M` binds a whole module; only kind-qualified imports
		// (`import class M.C`) carry a named binding (issue #1530).
		expectBindings: false,
		reason:
			'A bare Swift `import M` binds a whole module; named bindings require a kind-qualified import (`import class M.C`).',
	},
	dart: {
		// A `show` clause is the only import form that binds names (a bare or
		// aliased Dart import binds a namespace/prefix).
		source: "import 'm.dart' show A;\nclass C { void m() {} }\n",
		expectMethods: false,
		expectBindings: true,
		reason:
			'Dart class members are not def-captured as methods: the tree-sitter path captures top-level function_signature defs and class/mixin/enum/extension types; augmentation (#1531) adds no member defs. Bindings come from `show` clauses.',
	},
	ruby: {
		source: "require 'm'\nclass C\n  def m\n  end\nend\n",
		expectMethods: true,
		expectBindings: false,
		reason:
			'Ruby require/require_relative load whole files and bind no names (module-level require semantics); mixin inclusion (include/extend) is not an import edge in this extractor. Methods are typed via the #1531 augmentation layer.',
	},
	php: {
		source:
			'<?php\nuse M\\A as Alias;\nclass C { public function m() { Alias::x(); } }\n',
		expectMethods: true,
		expectBindings: true,
	},
};

function registryGrammarIds(): string[] {
	return LANGUAGE_REGISTRY.getAll()
		.filter((p) => !p.parserOnly)
		.map((p) => p.treeSitter.grammarId);
}

describe('language extraction coverage (issue #1529 recurrence guardrail)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('every registered non-parserOnly profile has an explicit expectation', () => {
		const missing = registryGrammarIds().filter(
			(id) => !Object.hasOwn(EXPECTATIONS, id),
		);
		expect(
			missing,
			`Language(s) registered in LANGUAGE_REGISTRY with no entry in EXPECTATIONS: ${missing.join(', ')}. ` +
				'Add a row asserting what extraction this language actually produces. ' +
				'A registered language with no extraction path is the exact defect class ' +
				'this guardrail exists to catch (issue #1529) — do not delete this test to pass it.',
		).toEqual([]);
	});

	test('every expectation that opts out records why', () => {
		for (const [id, e] of Object.entries(EXPECTATIONS)) {
			if (e.expectMethods && e.expectBindings) continue;
			expect(
				e.reason,
				`${id} opts out of a check without a reason`,
			).toBeTruthy();
		}
	});

	for (const grammarId of Object.keys(EXPECTATIONS)) {
		const e = EXPECTATIONS[grammarId];

		test(`${grammarId}: produces extractable facts`, async () => {
			const facts = await extractFileSymbols(grammarId, e.source);
			expect(facts, `${grammarId} returned null`).not.toBeNull();
			expect(
				facts!.defs.length,
				`${grammarId} produced no defs`,
			).toBeGreaterThan(0);

			// Every def must carry a resolved visibility. 'unknown' means the
			// visibility layer has no branch for this grammar — the silent-skip
			// symptom of the defect class.
			for (const d of facts!.defs) {
				expect(
					d.visibilityInfo?.visibility,
					`${grammarId} def '${d.name}' has unresolved visibility`,
				).not.toBe('unknown');
			}
		});

		test(`${grammarId}: member typing is ${e.expectMethods ? 'wired' : 'not wired (documented)'}`, async () => {
			const facts = await extractFileSymbols(grammarId, e.source);
			expect(facts).not.toBeNull();
			const methods = facts!.defs.filter((d) => d.kind === 'method');
			if (e.expectMethods) {
				expect(
					methods.length,
					`${grammarId} typed no container member as kind 'method'. This is the #1529 failure mode: ` +
						'the language is registered and produces defs, but members are mis-typed as top-level functions, ' +
						'so visibility and range facts for the API surface are wrong.',
				).toBeGreaterThan(0);
			} else {
				expect(methods.length, `${grammarId}: ${e.reason}`).toBe(0);
			}
		});

		test(`${grammarId}: import bindings are ${e.expectBindings ? 'wired' : 'not wired (documented)'}`, async () => {
			const facts = await extractFileSymbols(grammarId, e.source);
			expect(facts).not.toBeNull();
			expect(
				facts!.imports.length,
				`${grammarId} produced no imports`,
			).toBeGreaterThan(0);

			const withBindings = facts!.imports.filter((i) => i.bindings.length > 0);
			if (e.expectBindings) {
				expect(
					withBindings.length,
					`${grammarId} produced imports but none carry bindings. The graph builder populates ` +
						'localToImported solely from imp.bindings and emits toSymbol: binding.imported, so ' +
						'bindings: [] makes symbol edges impossible for this language (issue #1529 RC-6).',
				).toBeGreaterThan(0);
				for (const imp of withBindings) {
					for (const b of imp.bindings) {
						// `imported` is matched against def names in the TARGET file,
						// so a dotted path can never resolve.
						expect(
							b.imported,
							`${grammarId} binding 'imported' must be a bare symbol name, not a dotted path`,
						).not.toContain('.');
					}
				}
			} else {
				expect(withBindings.length, `${grammarId}: ${e.reason}`).toBe(0);
			}
		});
	}
});
