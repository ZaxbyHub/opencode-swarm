/**
 * `packageBoundary` extraction from source declarations (issue #1529).
 *
 * Split into its own file rather than appended to `repo-graph-ontology.test.ts`
 * to keep that file well under the 500-line FR-006 cap.
 */
import { describe, expect, test } from 'bun:test';
import {
	type ExtractFileOntologyInput,
	extractFileOntology,
} from '../../../src/tools/repo-graph';

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
	'  String s = """',
	'package com.evil;',
	'""";',
	'}',
	'',
].join('\n');

const JAVA_TEXT_BLOCK_WITH_REAL = [
	'package com.good;',
	'',
	'class C {',
	'  String s = """',
	'package com.evil;',
	'""";',
	'}',
	'',
].join('\n');

const KOTLIN_RAW_STRING = [
	'val s = """',
	'package com.evil',
	'"""',
	'package com.good',
	'',
].join('\n');

describe('packageBoundary from source declarations (issue #1529)', () => {
	// `stripComments` removes comments but keeps string literals verbatim, so a
	// line-initial package/namespace token inside a MULTI-LINE string matched the
	// anchored regex and beat the real declaration (String.match takes the first
	// hit). That is legal, compilable source — a C# @"..." block holding SQL or
	// config is ordinary — not a crafted spoof.
	test('a namespace inside a C# verbatim string does not win', () => {
		expect(boundary('csharp', CSHARP_VERBATIM_AFTER)).toBe('Good');
	});

	test('a C# verbatim string before the real namespace still does not win', () => {
		expect(boundary('csharp', CSHARP_VERBATIM_BEFORE)).toBe('Good');
	});

	test('a package inside a Java text block does not win', () => {
		// Default-package file: must fall back to the path, not the literal.
		expect(boundary('java', JAVA_TEXT_BLOCK_ONLY)).toBe('src/main');
	});

	test('a real Java package beats one inside a text block', () => {
		expect(boundary('java', JAVA_TEXT_BLOCK_WITH_REAL)).toBe('com.good');
	});

	test('a package inside a Kotlin raw string does not beat the real one', () => {
		expect(boundary('kotlin', KOTLIN_RAW_STRING)).toBe('com.good');
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
});
