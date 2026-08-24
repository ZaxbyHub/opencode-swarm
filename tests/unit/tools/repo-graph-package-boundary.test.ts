/**
 * `packageBoundary` extraction from source declarations (issue #1529).
 *
 * Split into its own file rather than appended to `repo-graph-ontology.test.ts`
 * to keep that file well under the 500-line FR-006 cap.
 *
 * Not every test here fails on a revert of the string-masking change: the two
 * marked ORDERING COMPANION assert real behavior but pass pre-fix because the
 * declaration precedes the literal. The discriminating cases are labelled.
 */
import { describe, expect, test } from 'bun:test';
import {
	type ExtractFileOntologyInput,
	extractFileOntology,
} from '../../../src/tools/repo-graph';
import { maskMultilineStringLiterals } from '../../../src/tools/repo-graph/ontology';

const DQ = '"';
const TRIPLE = DQ.repeat(3);
const ESCAPED_QUOTE = DQ.repeat(2);
const BACKSLASH = String.fromCharCode(92);

function boundary(language: string, content: string): string {
	return extractFileOntology({
		moduleName: 'src/main/java/C',
		filePath: '/repo/src/main/java/C',
		language,
		content,
	} as ExtractFileOntologyInput).packageBoundary;
}

const CSHARP_VERBATIM_AFTER = [
	'namespace Good;',
	'',
	'public class C {',
	'  string s = @"',
	'namespace Evil;',
	'";',
	'}',
	'',
].join('\n');

const CSHARP_VERBATIM_BEFORE = [
	'string s = @"',
	'namespace Evil;',
	'";',
	'namespace Good;',
	'',
].join('\n');

const JAVA_TEXT_BLOCK_ONLY = [
	'class C {',
	`  String s = ${TRIPLE}`,
	'package com.evil;',
	`${TRIPLE};`,
	'}',
	'',
].join('\n');

const JAVA_TEXT_BLOCK_WITH_REAL = [
	'package com.good;',
	'',
	'class C {',
	`  String s = ${TRIPLE}`,
	'package com.evil;',
	`${TRIPLE};`,
	'}',
	'',
].join('\n');

const KOTLIN_RAW_STRING = [
	`val s = ${TRIPLE}`,
	'package com.evil',
	TRIPLE,
	'package com.good',
	'',
].join('\n');

// A C# verbatim string ending in an escaped quote (@"say ""hi""") contains a
// literal triple quote. Masking the triple-quote form BEFORE the verbatim form
// paired that tail with a later triple quote and blanked every line between,
// deleting a real declaration outright.
const CSHARP_ESCAPED_QUOTE_TAIL = [
	'class C {',
	`  string q = @"say ${ESCAPED_QUOTE}hi${ESCAPED_QUOTE}";`,
	'}',
	'namespace Real.App;',
	`class D { string r = @"z${ESCAPED_QUOTE}"; }`,
	'',
].join('\n');

// C# accepts either sigil order on an interpolated verbatim string. Matching
// only `@"` left `@$"` unmasked, so the spoof this masking exists to stop was
// still live.
const CSHARP_AT_DOLLAR_VERBATIM = [
	`class Q { const string S = @$${DQ}`,
	'namespace Evil.Spoofed;',
	`${DQ}; }`,
	'namespace Real.App;',
	'',
].join('\n');

// An ORDINARY string ending in `@` put the two characters `@` and `"` next to
// each other, which a bare `@"` start pattern read as a verbatim opener and ran
// forward to the next quote in the file — blanking a real declaration that had
// resolved correctly before any masking existed.
const CSHARP_STRING_ENDING_IN_AT = [
	`[assembly: AssemblyMetadata(${DQ}contact${DQ}, ${DQ}team@${DQ})]`,
	'namespace Real.App;',
	`class Z { string t = ${DQ}x${DQ}; }`,
	'',
].join('\n');

describe('packageBoundary from source declarations (issue #1529)', () => {
	// `stripComments` removes comments but keeps string literals verbatim, so a
	// line-initial package/namespace token inside a MULTI-LINE string matched the
	// anchored regex and beat the real declaration (String.match takes the first
	// hit). That is legal, compilable source — a C# @"..." block holding SQL or
	// config is ordinary — not a crafted spoof.

	// ORDERING COMPANION, not a mask proof: the real declaration precedes the
	// literal, so String.match-takes-first passes this even with masking
	// disabled. Kept because it pins that masking does not BREAK the ordinary
	// case.
	test('a namespace before a C# verbatim string is unaffected by masking', () => {
		expect(boundary('csharp', CSHARP_VERBATIM_AFTER)).toBe('Good');
	});

	// DISCRIMINATING: fails on a revert of the masking change.
	test('a C# verbatim string before the real namespace still does not win', () => {
		expect(boundary('csharp', CSHARP_VERBATIM_BEFORE)).toBe('Good');
	});

	// DISCRIMINATING.
	test('a package inside a Java text block does not win', () => {
		// Default-package file: must fall back to the path, not the literal.
		expect(boundary('java', JAVA_TEXT_BLOCK_ONLY)).toBe('src/main');
	});

	// ORDERING COMPANION - see the note above; passes with masking disabled.
	test('a real Java package before a text block is unaffected by masking', () => {
		expect(boundary('java', JAVA_TEXT_BLOCK_WITH_REAL)).toBe('com.good');
	});

	// DISCRIMINATING.
	test('a package inside a Kotlin raw string does not beat the real one', () => {
		expect(boundary('kotlin', KOTLIN_RAW_STRING)).toBe('com.good');
	});

	// DISCRIMINATING, and a regression pin for the FIRST cut of the masking fix:
	// masking must consume the verbatim form BEFORE the triple-quote form, or the
	// escaped-quote tail opens a spurious mask region. That failure mode was
	// worse than the bug it came from — the declaration was lost entirely and the
	// boundary fell back to the path.
	test('a verbatim string ending in an escaped quote does not blank real code', () => {
		expect(boundary('csharp', CSHARP_ESCAPED_QUOTE_TAIL)).toBe('Real.App');
	});

	// DISCRIMINATING, regression pin for the SECOND cut of the masking fix.
	test('an @$ interpolated verbatim string is masked, not just $@', () => {
		expect(boundary('csharp', CSHARP_AT_DOLLAR_VERBATIM)).toBe('Real.App');
	});

	// DISCRIMINATING, regression pin for the THIRD cut. This one is the reason
	// the implementation is a single left-to-right scan rather than a set of
	// regexes: only a scanner that CONSUMES ordinary string literals can know
	// that this `@"` is not a verbatim opener.
	test('an ordinary string ending in @ is not read as a verbatim opener', () => {
		expect(boundary('csharp', CSHARP_STRING_ENDING_IN_AT)).toBe('Real.App');
	});

	test('an unterminated literal leaves the rest of the file readable', () => {
		// Emitting the remainder untouched beats blanking to EOF: a later real
		// declaration must still be found.
		expect(
			boundary(
				'csharp',
				`class C { string s = @${DQ}oops\nnamespace Real.App;\n`,
			),
		).toBe('Real.App');
		expect(
			boundary('java', `class C { String s = ${TRIPLE}\npackage com.real;\n`),
		).toBe('com.real');
	});

	// DISCRIMINATING, regression pin for the FOURTH cut. A C# preprocessor
	// message is arbitrary input-characters and is never string-tokenized, so an
	// odd quote in one is not a delimiter. Consuming it to EOF desynchronized the
	// scanner: `contact@` + the following quote then read as a verbatim opener
	// and blanked forward past the real declaration. Dies if the ordinary-literal
	// consume is not bounded to its own line.
	test('an unpaired quote in a preprocessor directive does not delete a declaration', () => {
		expect(
			boundary(
				'csharp',
				[
					`#warning check ${DQ}`,
					`[assembly: B(${DQ}contact@${DQ})]`,
					'namespace Real.App;',
					`class C { string s = ${DQ}z${DQ}; }`,
					'',
				].join('\n'),
			),
		).toBe('Real.App');
	});

	// DISCRIMINATING. The same desync in its fail-to-mask direction: an
	// apostrophe in `Don't` consumed to EOF, so the verbatim block below it was
	// never masked and the spoof won outright.
	test('an apostrophe in a directive does not disable masking below it', () => {
		expect(
			boundary(
				'csharp',
				[
					"#warning Don't use",
					`[assembly: A(@${DQ}x`,
					'namespace Fake;',
					`y${DQ})]`,
					'namespace Real.App;',
					'',
				].join('\n'),
			),
		).toBe('Real.App');
	});

	// DISCRIMINATING for the doubled-quote skip specifically. The existing
	// escaped-quote fixture re-syncs by quote parity, so it survives deleting
	// that branch; this one does not. Verified by mutation.
	test('an escaped quote inside a verbatim string does not end the mask early', () => {
		expect(
			boundary(
				'csharp',
				[
					`[assembly: A(@${DQ}say ${ESCAPED_QUOTE}hi`,
					'namespace Fake;',
					`bye${ESCAPED_QUOTE} done${DQ})]`,
					'namespace Real.App;',
					'',
				].join('\n'),
			),
		).toBe('Real.App');
	});

	// DISCRIMINATING, regression pin for the FIFTH cut. A C# 11 raw string opens
	// with a run of N >= 3 quotes and closes on a run of EXACTLY N — that form
	// exists precisely so content can contain `"""`. Closing on a hard-coded
	// `"""` therefore terminated the literal on its own CONTENT, resumed the scan
	// inside the string, and blanked the real declaration below it.
	test('a 4-quote C# raw string does not delete the declaration below it', () => {
		expect(
			boundary(
				'csharp',
				[
					`[assembly: A(${DQ.repeat(4)}`,
					TRIPLE,
					`x@${DQ}`,
					`${DQ.repeat(4)})]`,
					'namespace Real.App;',
					`class C { string s = ${DQ}z${DQ}; }`,
					'',
				].join('\n'),
			),
		).toBe('Real.App');
	});

	// DISCRIMINATING: the same delimiter bug in its fail-to-mask direction — the
	// spoof inside the raw string won outright.
	test('a namespace inside a 4-quote C# raw string does not win', () => {
		expect(
			boundary(
				'csharp',
				[
					`[assembly: A(${DQ.repeat(4)}`,
					TRIPLE,
					'namespace Fake;',
					`${DQ.repeat(4)})]`,
					'namespace Real.App;',
					'',
				].join('\n'),
			),
		).toBe('Real.App');
	});

	// Java forbids an unescaped 3-quote run inside a text block and Kotlin ends a
	// raw string at the LAST three quotes of a run, so the run-length rule must
	// not change either language.
	test('java and kotlin three-quote forms are unaffected by the run-length rule', () => {
		expect(boundary('java', JAVA_TEXT_BLOCK_ONLY)).toBe('src/main');
		expect(boundary('kotlin', KOTLIN_RAW_STRING)).toBe('com.good');
		expect(
			boundary(
				'kotlin',
				`val s = ${TRIPLE}\npackage com.evil\nx${DQ}${TRIPLE}\npackage com.good\n`,
			),
		).toBe('com.good');
	});

	// DISCRIMINATING, regression pin for the SIXTH cut. A Java text block is the
	// one raw form WITH escape sequences (JLS 3.10.6), and `\"""` is the JEP 378
	// idiom for embedding a text block in a text block — only two of those three
	// quotes are unescaped, so it must not terminate. Treating it as a fence
	// closed the literal on its own content and leaked the `package` out.
	// Verified against this project's own tree-sitter-java grammar: the whole
	// block parses as one string_literal with hasError === false.
	test('an escaped quote run does not end a Java text block', () => {
		expect(
			boundary(
				'java',
				[
					'class Gen {',
					`  String template = ${TRIPLE}`,
					`      String text = ${BACKSLASH}${TRIPLE}`,
					'package com.attacker.evil;',
					`      ${BACKSLASH}${TRIPLE};`,
					`      ${TRIPLE};`,
					'}',
					'',
				].join('\n'),
			),
		).toBe('src/main');
	});

	// The other half of that discrimination: an escaped BACKSLASH leaves the run
	// unescaped, so it legitimately DOES close the block. Pins that the escape
	// handling is parity-correct rather than "ignore anything after a backslash".
	test('an escaped backslash still allows the text block to close', () => {
		expect(
			boundary(
				'java',
				[
					'class G {',
					`  String s = ${TRIPLE}`,
					`x${BACKSLASH}${BACKSLASH}${TRIPLE}`,
					'package com.evil;',
					`  ${TRIPLE};`,
					'}',
					'',
				].join('\n'),
			),
		).toBe('com.evil');
	});

	// Kotlin ends a raw string at the LAST three quotes of a run. Dies if the
	// closing index is the run START rather than run end minus the delimiter —
	// a mutant the earlier 4-quote fixture could not discriminate.
	test('a long closing quote run ends a Kotlin raw string at its last three', () => {
		expect(
			boundary(
				'kotlin',
				[
					`val s = ${TRIPLE}`,
					'package com.evil',
					`x${TRIPLE}${TRIPLE}`,
					'package com.good',
					`val t = ${TRIPLE}z${TRIPLE}`,
					'',
				].join('\n'),
			),
		).toBe('com.good');
	});

	// Malformed C# (a closing run longer than the opener is CS8998). Requiring an
	// EXACT-length run made the scan skip it and hunt forward, blanking the real
	// declaration in between; taking the last `delim` quotes bounds the damage.
	// Compilable C# cannot tell the two rules apart, so this is the only shape
	// that pins the choice.
	test('an over-long closing run does not blank past the literal', () => {
		expect(
			boundary(
				'csharp',
				[
					'class C {',
					`  string a = ${TRIPLE}`,
					'zzz',
					`${DQ.repeat(4)};`,
					'}',
					'namespace Real.App;',
					'',
				].join('\n'),
			),
		).toBe('Real.App');
	});

	test('ordinary declarations still resolve', () => {
		expect(boundary('java', 'package com.real;\n\nclass C {}\n')).toBe(
			'com.real',
		);
		expect(
			boundary('csharp', 'namespace Real.App;\n\npublic class C {}\n'),
		).toBe('Real.App');
		expect(boundary('csharp', 'namespace Real.App\n{\n}\n')).toBe('Real.App');
	});

	test('a commented-out declaration never wins', () => {
		// stripComments already guarantees this; pinned so the string-masking
		// change cannot regress it.
		expect(
			boundary(
				'java',
				'// package com.evil;\n/* package com.evil2; */\npackage com.good;\n',
			),
		).toBe('com.good');
	});

	test('declaration on the final line with no trailing newline still resolves', () => {
		expect(boundary('java', 'package com.tail;')).toBe('com.tail');
		expect(boundary('csharp', 'namespace Tail.App;')).toBe('Tail.App');
	});

	// The masker is hand-written character scanning, so its structural
	// invariants are asserted rather than hand-derived: it must terminate, and
	// it must not change the file's length or line count (both would shift every
	// downstream line/offset). Deterministic pseudo-random corpus — no clock, no
	// Math.random — built from the exact characters that drive its branches.
	test('the masker preserves length and line count over a fuzz corpus', () => {
		const alphabet = [
			DQ,
			"'",
			TRIPLE,
			ESCAPED_QUOTE,
			'@',
			'$',
			'\\',
			'\n',
			'namespace X;',
			'package y;',
			'#warning z',
			'a',
			' ',
		];
		let seed = 0x2f6e2b1;
		const next = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed;
		};
		for (let n = 0; n < 400; n++) {
			let src = '';
			const len = next() % 24;
			for (let k = 0; k < len; k++) {
				src += alphabet[next() % alphabet.length];
			}
			for (const language of ['csharp', 'java', 'kotlin']) {
				// Terminates (a hang fails the suite by timeout) and never throws.
				const masked = maskMultilineStringLiterals(src, language);
				expect(masked.length).toBe(src.length);
				expect(masked.split('\n').length).toBe(src.split('\n').length);
			}
		}
	});

	test('a file with no declaration falls back to the path', () => {
		expect(boundary('java', 'class C {}\n')).toBe('src/main');
	});

	test('kotlin package without a semicolon, and a one-line C# block namespace', () => {
		expect(boundary('kotlin', 'package com.k\n\nfun f() {}\n')).toBe('com.k');
		expect(boundary('csharp', 'namespace N { class C {} }\n')).toBe('N');
	});
});
