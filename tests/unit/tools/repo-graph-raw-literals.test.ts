/**
 * Raw-literal delimiter and escape handling in the `packageBoundary` string
 * masker (issue #1529).
 *
 * Split out of `repo-graph-package-boundary.test.ts` to stay under the 500-line
 * FR-006 cap. That file pins WHICH declaration wins; this one pins where the
 * masker decides a multi-line literal starts and ends.
 *
 * Six successive review rounds each found one more input where the masker
 * mis-identified a literal boundary, resumed scanning inside it, and either
 * blanked a real declaration or let one inside a literal win. Every test here is
 * a regression pin for one of those, and each dies under mutation of the branch
 * it covers.
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

const JAVA_TEXT_BLOCK_ONLY = [
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

describe('raw-literal delimiter and escape handling (issue #1529)', () => {
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

	// SCOPING pin. Escape awareness must apply to Java ONLY — Kotlin and C# raw
	// strings have no escape sequences at all, so a backslash immediately before
	// the closing fence is ordinary content and the fence still closes. Applying
	// Java's rule to them swallows the fence, runs on to the next one, and blanks
	// the real declaration in between. Dies if the `language === 'java'` scope is
	// widened; the Java pins above die if it is removed.
	test('a backslash before the closing fence still closes a Kotlin raw string', () => {
		expect(
			boundary(
				'kotlin',
				[
					`val s = ${TRIPLE}`,
					'package com.evil',
					`x${BACKSLASH}${TRIPLE}`,
					'package com.good',
					`val t = ${TRIPLE}z${TRIPLE}`,
					'',
				].join('\n'),
			),
		).toBe('com.good');
	});

	test('a backslash before the closing fence still closes a C# raw string', () => {
		expect(
			boundary(
				'csharp',
				[
					'class C {',
					`  string a = ${TRIPLE}`,
					`zzz${BACKSLASH}${TRIPLE};`,
					'}',
					'namespace Real.App;',
					`class D { string b = ${TRIPLE}q${TRIPLE}; }`,
					'',
				].join('\n'),
			),
		).toBe('Real.App');
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
});
