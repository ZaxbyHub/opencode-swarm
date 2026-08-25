import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function byName(
	defs: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>['defs'],
	name: string,
) {
	return defs.find((d) => d.name === name);
}

function byNameAndKind(
	defs: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>['defs'],
	name: string,
	kind: string,
) {
	return defs.find((d) => d.name === name && d.kind === kind);
}

describe('extractFileSymbols — java grammar visibility, kinds, nested types', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('public class + public method: exported/vis semantics', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class C { public void m() {} }',
		);
		expect(facts).not.toBeNull();
		const cDef = byName(facts!.defs, 'C');
		const mDef = byName(facts!.defs, 'm');
		expect(cDef?.exported).toBe(true);
		expect(cDef?.visibilityInfo?.visibility).toBe('public');
		expect(mDef?.exported).toBe(false);
		expect(mDef?.visibilityInfo?.visibility).toBe('public');
	});

	test('package-private method inside a public class', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class C { int m() { return 1; } }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'm')?.visibilityInfo?.visibility).toBe(
			'package',
		);
	});

	test('protected and private modifiers map to distinct visibility', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class C { protected void p() {} private void q() {} }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'p')?.visibilityInfo?.visibility).toBe(
			'protected',
		);
		const q = byName(facts!.defs, 'q');
		expect(q?.visibilityInfo?.visibility).toBe('private');
		expect(q?.visibilityInfo?.apiSurfaceKind).toBe('private');
	});

	test('interface members are implicitly public', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public interface I { void h(); }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'h')?.visibilityInfo?.visibility).toBe('public');
	});

	test('nested types (class/interface/enum) are vis=public exported=false (regression pin)', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class Outer { public static class Builder {} public interface Cb {} public enum Mode { A } }',
		);
		expect(facts).not.toBeNull();
		for (const name of ['Builder', 'Cb', 'Mode']) {
			const def = byName(facts!.defs, name);
			expect(def, `${name} should be captured`).toBeDefined();
			expect(def?.visibilityInfo?.visibility, `${name} vis`).toBe('public');
			expect(def?.exported, `${name} exported`).toBe(false);
		}
	});

	test('annotations do not block modifier reads (exportedReason stays "modifier")', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class C {\n@Override\npublic void a() {}\n@Deprecated\nprivate void b() {}\n}',
		);
		expect(facts).not.toBeNull();
		const a = byName(facts!.defs, 'a');
		expect(a?.visibilityInfo?.visibility).toBe('public');
		expect(a?.visibilityInfo?.exportedReason).toBe('modifier');
		expect(a?.visibilityInfo?.exportedReason).not.toBe('module_public');
		expect(byName(facts!.defs, 'b')?.visibilityInfo?.visibility).toBe(
			'private',
		);
	});

	test('enum/record/constructor kinds captured without leaking members/constants', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public enum E { A, B }\npublic record R(int x) {}\npublic class K { public K() {} }',
		);
		expect(facts).not.toBeNull();
		const eDef = byName(facts!.defs, 'E');
		expect(eDef?.kind).toBe('enum');
		expect(byName(facts!.defs, 'A')).toBeUndefined();
		expect(byName(facts!.defs, 'B')).toBeUndefined();

		const rDef = byName(facts!.defs, 'R');
		expect(rDef?.kind).toBe('class');
		expect(byName(facts!.defs, 'x')).toBeUndefined();

		const kClass = byNameAndKind(facts!.defs, 'K', 'class');
		const kCtor = byNameAndKind(facts!.defs, 'K', 'method');
		expect(kClass).toBeDefined();
		expect(kClass?.exported).toBe(true);
		expect(kCtor).toBeDefined();
		expect(kCtor?.exported).toBe(false);
		expect(facts!.defs.filter((d) => d.name === 'K').length).toBe(2);
	});
});

describe('extractFileSymbols — csharp grammar visibility, kinds, nested types', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('class member with no modifier defaults to private', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class C { void m() {} }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'm')?.visibilityInfo?.visibility).toBe(
			'private',
		);
	});

	test('struct member with no modifier defaults to private', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public struct S { void m() {} }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'm')?.visibilityInfo?.visibility).toBe(
			'private',
		);
	});

	test('attributes do not block modifier reads', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class C {\n[Test]\npublic void Foo() {}\n[Obsolete]\nprivate void Bar() {}\n}',
		);
		expect(facts).not.toBeNull();
		const foo = byName(facts!.defs, 'Foo');
		expect(foo?.visibilityInfo?.visibility).toBe('public');
		expect(foo?.visibilityInfo?.exportedReason).toBe('modifier');
		expect(byName(facts!.defs, 'Bar')?.visibilityInfo?.visibility).toBe(
			'private',
		);
	});

	test('explicit internal and protected on a member are respected', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class C { internal void I() {} protected void P() {} }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'I')?.visibilityInfo?.visibility).toBe(
			'internal',
		);
		expect(byName(facts!.defs, 'P')?.visibilityInfo?.visibility).toBe(
			'protected',
		);
	});

	test('a nested type body applies the container default to its own members', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class Outer { public class Inner { void hidden() {} } }',
		);
		expect(facts).not.toBeNull();
		// C# class members default to private, including one nesting level down.
		expect(byName(facts!.defs, 'hidden')?.visibilityInfo?.visibility).toBe(
			'private',
		);
	});

	test('enum/record/constructor/struct kinds captured', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public enum E { A }\npublic record R(int X);\npublic struct S {}\npublic class K { public K() {} }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'E')?.kind).toBe('enum');
		expect(byName(facts!.defs, 'R')?.kind).toBe('class');
		expect(byName(facts!.defs, 'S')).toBeDefined();
		const kCtor = byNameAndKind(facts!.defs, 'K', 'method');
		expect(kCtor).toBeDefined();
	});
});

describe('extractFileSymbols — kotlin grammar visibility, kinds, extension functions', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('top-level function is public by default (regression pin, was internal before fix)', async () => {
		const facts = await extractFileSymbols('kotlin', 'fun topLevel() {}');
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'topLevel')?.visibilityInfo?.visibility).toBe(
			'public',
		);
	});

	test('internal and private modifiers are respected', async () => {
		const facts = await extractFileSymbols(
			'kotlin',
			'internal fun f() {}\nprivate fun g() {}',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'f')?.visibilityInfo?.visibility).toBe(
			'internal',
		);
		expect(byName(facts!.defs, 'g')?.visibilityInfo?.visibility).toBe(
			'private',
		);
	});

	test('object and enum class declarations are captured', async () => {
		const facts = await extractFileSymbols(
			'kotlin',
			'object O { fun get() {} }\nenum class Color { RED }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'O')).toBeDefined();
		expect(byName(facts!.defs, 'Color')).toBeDefined();
	});

	test('extension functions are extracted under their BARE name, not receiver-qualified', async () => {
		// An earlier cut of this change qualified the def as `String.shout`. That
		// was reverted: an import binding is always the bare final segment
		// (`finalDottedSegment`), so a qualified def key can never be matched by
		// an import and symbol edges for extension functions dropped to zero —
		// a regression against acceptance criterion 6. The receiver type is
		// simply not recorded; see the Kotlin caveat in
		// docs/repo-graph-symbol-graph.md.
		const facts = await extractFileSymbols(
			'kotlin',
			'fun String.shout() {}\nfun String?.foo() {}',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'shout')).toBeDefined();
		expect(byName(facts!.defs, 'String.shout')).toBeUndefined();
		expect(byName(facts!.defs, 'foo')).toBeDefined();
	});
});

describe('extractFileSymbols — jvm/dotnet malformed input fail-open', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('malformed java source does not throw', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class { void m( int x {} ]]] garbage ###',
		);
		expect(facts === null || typeof facts === 'object').toBe(true);
	});

	test('malformed kotlin source does not throw', async () => {
		const facts = await extractFileSymbols(
			'kotlin',
			'fun ((( class object : : private internal @@@ ---',
		);
		expect(facts === null || typeof facts === 'object').toBe(true);
	});

	test('malformed csharp source does not throw', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class { void Foo( [Attr] int x {{{ ]]] ###',
		);
		expect(facts === null || typeof facts === 'object').toBe(true);
	});
});

/**
 * Implementation-review regressions (issue #1529). The first cut skipped
 * leading annotations with a regex whose argument-list classes could not match
 * nested brackets, so a NESTED bracket left the annotation in the scanned text
 * and the member resolved to `private` — a wrong fact about public API, not a
 * missing one.
 */
describe('JVM/.NET annotation-aware modifier scanning', () => {
	beforeEach(() => {
		clearParserCache();
	});

	const cases: Array<{
		label: string;
		grammarId: string;
		source: string;
		symbol: string;
		visibility: string;
	}> = [
		{
			label: 'csharp attribute with a nested collection initializer',
			grammarId: 'csharp',
			source: 'public class C { [Attr(new[] { 1 })] public void M() {} }',
			symbol: 'M',
			visibility: 'public',
		},
		{
			label: 'csharp attribute with nested generic type args',
			grammarId: 'csharp',
			source:
				'public class C { [JsonConverter(typeof(List<int>))] public void M() {} }',
			symbol: 'M',
			visibility: 'public',
		},
		{
			label: 'java annotation whose argument STRING contains a modifier word',
			grammarId: 'java',
			source: 'public class C { @Foo(bar("private")) public void m() {} }',
			symbol: 'm',
			visibility: 'public',
		},
		{
			label: 'java modifier keyword inside a body string literal',
			grammarId: 'java',
			source: 'public class C { public void m() { String s = "private"; } }',
			symbol: 'm',
			visibility: 'public',
		},
		{
			label: 'kotlin use-site annotation target',
			grammarId: 'kotlin',
			source: 'class C { @field:Inject private fun x() {} }',
			symbol: 'x',
			visibility: 'private',
		},
	];

	for (const c of cases) {
		test(`${c.label} -> ${c.visibility}`, async () => {
			const facts = await extractFileSymbols(c.grammarId, c.source);
			expect(facts).not.toBeNull();
			const def = facts!.defs.find((d) => d.name === c.symbol);
			expect(def, `${c.symbol} should be extracted`).toBeDefined();
			expect(def!.visibilityInfo?.visibility).toBe(c.visibility);
		});
	}

	// C# verbatim strings (@"...") treat backslash as a LITERAL character and
	// use a doubled "" as the quote escape. Applying C-style backslash escaping
	// to @"C:\temp\" swallows the closing quote, so the attribute never closes
	// and the annotation stays in the scanned text -> the member resolved to
	// `private`. Found by implementation review round 2.
	const verbatimCases: Array<{ label: string; source: string }> = [
		{
			label: 'trailing backslash',
			source: 'public class C { [Attr(@"C:\\temp\\")] public void M() {} }',
		},
		{
			label: 'doubled-quote escape containing a modifier word',
			source:
				'public class C { [Attr(@"say ""private"" now")] public void M() {} }',
		},
		{
			label: 'embedded path separators',
			source: 'public class C { [Attr(@"a\\b\\c")] public void M() {} }',
		},
	];

	for (const c of verbatimCases) {
		test(`csharp verbatim string in an attribute (${c.label}) -> public`, async () => {
			const facts = await extractFileSymbols('csharp', c.source);
			expect(facts).not.toBeNull();
			const def = facts!.defs.find((d) => d.name === 'M');
			expect(def).toBeDefined();
			expect(def!.visibilityInfo?.visibility).toBe('public');
		});
	}

	// An UNMODELLED string flavor whose quotes do not pair evenly. The
	// quote-aware pass runs off the end of the text, so only the bracket-only
	// retry in skipBalancedResilient can close the attribute; without it the
	// annotation stays in the scanned text and the member resolves to `private`.
	//
	// Verified by mutation: replacing skipBalancedResilient's body with the
	// strict call alone flips this case public -> private. An EVEN-quote fixture
	// (e.g. `[Attr("""x""")]` or `[Attr($@"a{1}b")]`) does NOT reach the retry —
	// the strict pass closes those on its own — so it cannot pin this branch.
	test('an odd-quote raw string still resolves the modifier via the bracket-only retry', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class C { [Attr("""a"b""")] public void M() {} }',
		);
		expect(facts).not.toBeNull();
		const def = facts!.defs.find((d) => d.name === 'M');
		expect(def).toBeDefined();
		expect(def!.visibilityInfo?.visibility).toBe('public');
	});

	// maskStringLiterals: a modifier keyword inside a default-argument string
	// sits in the declaration prefix AFTER annotation stripping, and
	// `visibilityFromText` tests /private/ before /public/, so without masking
	// each of these resolves `private`. Verified by mutation (identity mask).
	const maskCases: Array<{
		label: string;
		grammarId: string;
		source: string;
		symbol: string;
	}> = [
		{
			label: 'csharp default-argument string',
			grammarId: 'csharp',
			source: 'public class C { public void M(string s = "private") {} }',
			symbol: 'M',
		},
		{
			label: 'kotlin top-level default-argument string',
			grammarId: 'kotlin',
			source: 'fun f(x: String = "private") {}',
			symbol: 'f',
		},
		{
			label: 'kotlin member with two default arguments',
			grammarId: 'kotlin',
			source: 'class C { fun g(a: String = "private", b: Int = 1) {} }',
			symbol: 'g',
		},
	];

	for (const c of maskCases) {
		test(`a modifier word inside a default-argument string is masked (${c.label})`, async () => {
			const facts = await extractFileSymbols(c.grammarId, c.source);
			expect(facts).not.toBeNull();
			const def = facts!.defs.find((d) => d.name === c.symbol);
			expect(def).toBeDefined();
			expect(def!.visibilityInfo?.visibility).toBe('public');
		});
	}

	test('a verbatim string containing a bracket defeats the bracket-only retry', async () => {
		// This is the case that makes verbatim modelling load-bearing rather than
		// redundant with skipBalancedResilient: the `]` inside @"x]y\" would close
		// the attribute early under a bracket-only scan, and the trailing
		// backslash defeats C-style escaping. Verified by mutation — forcing
		// `verbatim = false` flips this to `private` while the sibling case
		// `[Attr(@"a]b")]` (no trailing backslash) still passes.
		const facts = await extractFileSymbols(
			'csharp',
			'public class C { [Attr(@"x]y\\")] public void M() {} }',
		);
		expect(facts).not.toBeNull();
		expect(
			facts!.defs.find((d) => d.name === 'M')?.visibilityInfo?.visibility,
		).toBe('public');
	});

	test('a bare @ does not discard the modifier that follows it', async () => {
		// stripLeadingAnnotations skips the stray character and keeps scanning;
		// aborting there (its behavior before this issue) loses the modifier.
		const facts = await extractFileSymbols(
			'java',
			'public class C {\n  @\n  public void m() {}\n}',
		);
		expect(facts).not.toBeNull();
		expect(
			facts!.defs.find((d) => d.name === 'm')?.visibilityInfo?.visibility,
		).toBe('public');
	});

	test('an unbalanced attribute list neither throws nor hangs', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'public class C { [Attr( public void M() {} }',
		);
		expect(facts === null || typeof facts === 'object').toBe(true);
	});
});
