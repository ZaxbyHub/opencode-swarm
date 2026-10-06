import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function inplaceTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
}

// A backslash, for escapes written apart from String.raw (a `\u` escape).
const BS = '\\';

const rows = (cases: Array<[string, string[]]>) =>
	test.each(cases)('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});

/**
 * Whether a detached option argument holds an unquoted glob or brace is
 * read from the command's source text. bash-parser decodes C escapes inside
 * quotes (`'s/\t/ /'` parses to a real TAB), so the source text and the
 * parsed word differ for every quoted escape; that difference is not a
 * reason to distrust the source text. Each command below edits only its
 * file, as it did before the glob rule existed.
 */
describe('shell-write-detect: quoted C escapes in a detached argument', () => {
	rows([
		[String.raw`sed -i -e 's/\t/ /g' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e 's/\r$//' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e 's/a\nb/c/' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e "s/\t/ /" src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i --expression 's/\t//' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e 's/\x41/A/' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e 's/\101/A/' src/a.ts`, ['src/a.ts']],
		[`sed -i -e 's/${BS}u00e9/e/' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e 'a\\b' src/a.ts`, ['src/a.ts']],
		[String.raw`perl -i -pe 's/\t/ /g' src/a.ts`, ['src/a.ts']],
		[String.raw`perl -i -pe 's/\r//' src/a.ts`, ['src/a.ts']],
		[String.raw`perl -i -pe 's/\n//' src/a.ts`, ['src/a.ts']],
		[String.raw`awk -i inplace -e '{gsub(/\t/," ")}1' src/a.ts`, ['src/a.ts']],
		[String.raw`awk -i inplace -v OFS='\t' '{$1=$1}1' src/a.ts`, ['src/a.ts']],
		[String.raw`awk -i inplace -F '\t' '{print $2}' src/a.ts`, ['src/a.ts']],
		[String.raw`awk -i inplace -F "\t" '{print $2}' src/a.ts`, ['src/a.ts']],
		[String.raw`awk -i inplace -F '[\t ]' '{print}' src/a.ts`, ['src/a.ts']],
		// Quoted glob characters next to an escape the parser keeps or decodes.
		[String.raw`sed -i -e '\e*' src/a.ts`, ['src/a.ts']],
		[String.raw`sed -i -e '[\x41]*' src/a.ts`, ['src/a.ts']],
		// Inside double quotes a backslash before `[` is kept: one word.
		[String.raw`sed -i -e "../\[ab]" src/a.ts`, ['src/a.ts']],
		// An unquoted glob next to a quoted escape still splits the word.
		[String.raw`sed -i -e '\t'* src/a.ts`, ['\t*', 'src/a.ts']],
		[String.raw`sed -i -e "\t"?? src/a.ts`, ['\t??', 'src/a.ts']],
	]);
});

/**
 * bash-parser counts source offsets in code points, so a character outside
 * the BMP shifts every later UTF-16 index. The offsets are mapped before the
 * source text is sliced: an unquoted glob after an emoji is still seen, and a
 * quoted one is still ignored.
 */
describe('shell-write-detect: characters outside the BMP', () => {
	rows([
		['echo 😀; sed -i -e * ../v f', ['*', '../v', 'f']],
		['sed -i -e 😀* ../v f', ['😀*', '../v', 'f']],
		['echo 😀\nsed -i -e * ../v f', ['*', '../v', 'f']],
		[String.raw`echo 😀; sed -i -e 's/\t/'* ../v f`, ['s/\t/*', '../v', 'f']],
		// Controls: a quoted glob after or inside an emoji is one word.
		["echo 😀; sed -i -e 's/a*/b/' f", ['f']],
		["sed -i -e '😀*' f", ['f']],
		[String.raw`echo 😀; sed -i -e "s/\t/ /" f`, ['f']],
	]);
});

/**
 * A brace expansion multiplies a word only when its braces and comma (or
 * `..`) are outside quotes and backslash escapes.
 */
describe('shell-write-detect: quoted braces are not a brace expansion', () => {
	rows([
		['sed -i -e {1d,../v} f', ['{1d,../v}', 'f']],
		['sed -i {1d,../v} f', ['{1d,../v}', 'f']],
		["sed -i -e {1d,'../v'} f", ['{1d,../v}', 'f']],
		['awk -i inplace -e {gsub,x} f', ['{gsub,x}', 'f']],
		// Controls
		["sed -i '{1d,x}' f", ['f']],
		["sed -i -e '{1d,x}' f", ['f']],
		['sed -i -e "{1d,x}" f', ['f']],
		["sed -i -e '{'1d,../v'}' f", ['f']],
		[String.raw`sed -i -e \{1d,x} f`, ['f']],
		["awk -i inplace -v 'x={a,b}' '{print}' f", ['f']],
		["awk -i inplace -F, '{print $1,$2}' f", ['f']],
	]);
});

/**
 * Source text that does not read back as the parsed word is not trusted, and
 * the word counts as holding a glob. bash-parser misreads `'\''` inside a
 * single-quoted script (it takes the backslash as an escape), so the word is
 * reported rather than read as one quoted script.
 */
describe('shell-write-detect: untrusted source text is fail-safe', () => {
	rows([[String.raw`sed -i -e 's/\'"'"'/x/' f`, ["s/'", 'f']]]);
});

/** Test-engineer rows: `--` bounds, list expansions, globs in arguments. */
describe('shell-write-detect: round-16 picker rows', () => {
	rows([
		['perl -i -- -x ../victim', ['../victim']],
		['perl -i -w -- -x f g', ['f', 'g']],
		['sed -i "s/$@/x/" f', ['"s/$@/x/"', 'f']],
		['sed -i "s/${A[@]}/x/" f', ['"s/${A[@]}/x/"', 'f']],
		['sed -i -e ../?.sed src/a.ts', ['../?.sed', 'src/a.ts']],
		['sed -i -l ?? src/a.ts', ['??', 'src/a.ts']],
		["awk -i inplace -v x=? '{print}' f", ['x=?', '{print}', 'f']],
		['sed -i -f ../*.sed src/a.ts', ['../*.sed', 'src/a.ts']],
		['sed -i -f ../?.sed src/a.ts', ['../?.sed', 'src/a.ts']],
		['awk -i inplace -f ?.awk f', ['?.awk', 'f']],
	]);
});

/** Pins for behaviour the earlier rounds settled. */
describe('shell-write-detect: in-place picker pins', () => {
	rows([
		["sed -i -f '*' f", ['*', 'f']],
		['perl -i X f -e ../v', ['f', '-e', '../v']],
		["awk -i inplace '{print}' f -b", ['f', '-b']],
		['perl -i -pe X f -- ../v', ['f', '--', '../v']],
		["sed -i '' 1d 's/../../etc/g'", ['s/../../etc/g']],
		['sed -i -l -e 1d f', ['f']],
		['sed -i d 1d f', ['1d', 'f']],
		["awk -i inplace -c '{print}' f", ['f']],
		["sed -i '' y/a/b/ f", ['f']],
		['sed --in-place=.bak 1d ../v', ['../v']],
	]);
});
