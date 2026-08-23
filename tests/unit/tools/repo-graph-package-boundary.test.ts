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

const TRIPLE = '"'.repeat(3);
const ESCAPED_QUOTE = '""';

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

	test('a file with no declaration falls back to the path', () => {
		expect(boundary('java', 'class C {}\n')).toBe('src/main');
	});

	test('kotlin package without a semicolon, and a one-line C# block namespace', () => {
		expect(boundary('kotlin', 'package com.k\n\nfun f() {}\n')).toBe('com.k');
		expect(boundary('csharp', 'namespace N { class C {} }\n')).toBe('N');
	});
});
