/**
 * DD-C010: parseFileImports strips comments before scanning for imports, so
 * import-like text inside comments does not produce false graph edges. Strings
 * (which contain the real import specifiers) must stay intact, including `//`
 * sequences inside string literals (e.g. URLs).
 */

import { describe, expect, test } from 'bun:test';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';

const specifiers = (src: string): string[] =>
	builderInternals.parseFileImports(src).map((i) => i.specifier);

describe('parseFileImports comment stripping (DD-C010)', () => {
	test('ignores import statements inside a line comment', () => {
		const src = [
			"import { real } from './real';",
			"// import { fake } from './fake';",
			"const x = 1; // require('./also-fake')",
		].join('\n');
		const found = specifiers(src);
		expect(found).toContain('./real');
		expect(found).not.toContain('./fake');
		expect(found).not.toContain('./also-fake');
	});

	test('ignores import statements inside a block comment', () => {
		const src = [
			'/*',
			" import Foo from './blocked';",
			" export * from './blocked-reexport';",
			'*/',
			"import Bar from './kept';",
		].join('\n');
		const found = specifiers(src);
		expect(found).toContain('./kept');
		expect(found).not.toContain('./blocked');
		expect(found).not.toContain('./blocked-reexport');
	});

	test('does not treat // inside a string literal as a comment', () => {
		const src = [
			'const url = "http://example.com/import-from-here";',
			"import { keep } from './keep';",
		].join('\n');
		const found = specifiers(src);
		expect(found).toContain('./keep');
	});

	test('real imports on the same line before a trailing comment are kept', () => {
		const src = "import { keep } from './keep'; // import './fake'";
		const found = specifiers(src);
		expect(found).toContain('./keep');
		expect(found).not.toContain('./fake');
	});

	test('a regex literal containing /* does not eat the following import', () => {
		// Regression: without regex-literal tracking, the `/*` inside the char
		// class starts a (never-closed) block comment and deletes the import.
		const src = [
			'const re = /[/*]/;',
			"import { foo } from './real-module';",
		].join('\n');
		const found = specifiers(src);
		expect(found).toContain('./real-module');
	});

	test('a regex literal containing // does not eat the following import', () => {
		const src = ['const re = /a\\/\\//g;', "import { bar } from './bar';"].join(
			'\n',
		);
		const found = specifiers(src);
		expect(found).toContain('./bar');
	});

	test('division operators are not mistaken for a regex literal', () => {
		// `a / b / c` is division; a real block comment after it must still strip.
		const src = [
			'const x = a / b / c;',
			'/* import { gone } from "./gone"; */',
			"import { kept } from './kept';",
		].join('\n');
		const found = specifiers(src);
		expect(found).toContain('./kept');
		expect(found).not.toContain('./gone');
	});
});
