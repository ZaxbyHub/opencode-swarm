import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

const targets = (c: string) =>
	detectPosixWrites(c)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
/**
 * Pins found by the review's mutation survivors: escapes the parser decodes
 * or keeps, double-quote backslash and apostrophe handling, a line
 * continuation, quoted globs in file-taking options, range braces, and the
 * alignment of suffix nodes and expansion flags with the words when a
 * redirect sits before an option argument or the BSD script slot.
 */
const rows = (name: string, cases: Array<[string, string[]]>) =>
	describe(`shell-write-detect: ${name}`, () => {
		test.each(cases)('%s edits %j', (c, files) => {
			expect(targets(c)).toEqual(files);
		});
	});

rows('O4 emoji then last-word quoted glob', [
	["echo 😀; sed -i f -e 's/a*/b/'", ['f']],
]);
rows('D-U', [[String.raw`sed -i -e 's/\U0001F600/x/' f`, ['f']]]);
rows('D-octal 1-digit (backreference)', [
	[String.raw`sed -i -e 's/\(a\)\(b\)/\2\1/' f`, ['f']],
	[String.raw`sed -i -e 's/\1/x/' f`, ['f']],
]);
rows('D-b/f/v', [
	[String.raw`sed -i -e 's/\bfoo\b/bar/' f`, ['f']],
	[String.raw`sed -i -e 's/\f/x/' f`, ['f']],
	[String.raw`sed -i -e 's/\v/x/' f`, ['f']],
]);
rows('D-dq D-sq', [
	[String.raw`sed -i -e 's/\"/x/' f`, ['f']],
	[String.raw`sed -i -e "s/\'/x/" f`, ['f']],
]);
rows('D-global (two escapes in one word)', [
	[String.raw`sed -i -e 's/\t/\n/' f`, ['f']],
	[String.raw`perl -i -pe 's/\t/\t\t/' f`, ['f']],
]);
rows('P1d apostrophe inside double quotes', [
	[`sed -i -e "s/don't/do not/" f`, ['f']],
]);
rows('P3d P3e dq backslash class', [
	[String.raw`sed -i -e "s/\"/x/" f`, ['f']],
	[String.raw`sed -i -e "s/a\\b/x/" f`, ['f']],
]);
rows('P4b line continuation', [['sed -i -e x\\\ny f', ['f']]]);
rows('G14/16/17 quoted glob in file-taking option stays conservative', [
	["sed -i --file '*' f", ['*', 'f']],
	["sed -i -nf '*' f", ['*', 'f']],
	["awk -i inplace -f '*.awk' f", ['*.awk', 'f']],
]);
rows('B4 range brace', [
	['sed -i {1..3} f', ['{1..3}', 'f']],
	['sed -i -e {1..3} f', ['{1..3}', 'f']],
]);
rows('SN1 node/word alignment with a redirect before the option arg', [
	['sed -i >/dev/null -e ../*.x f', ['../*.x', 'f']],
	['sed -i 2>/dev/null -e ../*.x f', ['../*.x', 'f']],
]);
rows('EF1 expansion flag alignment with a redirect before the BSD slot', [
	["sed -i '' >/dev/null $D f", ['$D', 'f']],
	["sed -i '' 2>/dev/null ${D} f", ['${D}', 'f']],
]);
