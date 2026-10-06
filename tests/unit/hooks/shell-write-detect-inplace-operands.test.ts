import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function inplaceTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
}

const rows = (cases: Array<[string, string[]]>) =>
	test.each(cases)('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});

/**
 * A glob in a detached option argument expands into several words: the
 * first is the argument, the rest are files (`sed -i --file ../[ab].sed f`
 * reads ../a.sed and edits ../b.sed and f). The argument of a file-taking
 * option splits on any glob character; any other argument only on one
 * outside quotes and backslash escapes. The argument is then reported.
 */
describe('shell-write-detect: a glob in a detached option argument', () => {
	rows([
		['sed -i --file ../[ab].sed src/a.ts', ['../[ab].sed', 'src/a.ts']],
		['sed -i -f ../[ab].sed src/a.ts', ['../[ab].sed', 'src/a.ts']],
		['sed -i --expression ../[ab] src/a.ts', ['../[ab]', 'src/a.ts']],
		['awk -i inplace -f ../[ab].awk src/a.ts', ['../[ab].awk', 'src/a.ts']],
		['sed -i -e * src/f.ts', ['*', 'src/f.ts']],
		['sed -i -e s/a*/b/ src/f.ts', ['s/a*/b/', 'src/f.ts']],
		// Controls: no glob, or a glob the shell does not expand.
		['sed -i --file s.sed src/a.ts', ['src/a.ts']],
		['sed -i -e 1d src/f.ts', ['src/f.ts']],
		["sed -i -e '*' src/f.ts", ['src/f.ts']],
		['sed -i -e "*" src/f.ts', ['src/f.ts']],
		['sed -i -e s/a\\*/b/ src/f.ts', ['src/f.ts']],
		["sed -i 's/a*/b/' f", ['f']],
		["sed -i -E -e 's/(a|b)?/x/' f", ['f']],
		["perl -i -pe 's/\\s+$//' f", ['f']],
		["awk -i inplace -F '[,;]' '{print}' f", ['f']],
		["awk -i inplace -v 're=[0-9]*' '{print}' f", ['f']],
		["awk -i inplace -v x=1 '{print}' src/f.ts", ['src/f.ts']],
	]);
});

/**
 * perl and gawk stop reading options at the first operand; sed permutes.
 * Every word after the first operand, a dash word too, is a file.
 */
describe('shell-write-detect: perl and awk stop options at the first operand', () => {
	rows([
		["awk -i inplace '{print}' src/a.ts -v ../v", ['src/a.ts', '-v', '../v']],
		['perl -i -pe X f -e ../v', ['f', '-e', '../v']],
		["awk -i inplace '{print}' f -i x", ['f', '-i', 'x']],
		// A split option argument or an unmodelled option also ends perl and
		// awk option parsing: every later word is an operand.
		['awk -i inplace -f ../[ab].awk -v', ['../[ab].awk', '-v']],
		[
			"awk -i inplace -b -v x=1 '{print}' f",
			['-b', '-v', 'x=1', '{print}', 'f'],
		],
		// G1/G2: after `--` a dash word is an operand.
		['sed -i -- 1d -e ../v', ['-e', '../v']],
		["awk -i inplace -- '{print}' -f ../v", ['-f', '../v']],
		["awk -i inplace -- '{print}' -F ../v", ['-F', '../v']],
		['sed -i -- 1d -l ../v', ['-l', '../v']],
		['sed -i -- 1d --foo f', ['--foo', 'f']],
		["awk -i inplace -- '{print}' --foo f", ['--foo', 'f']],
		['sed -i -- 1d -x f', ['-x', 'f']],
		// G8: a consumed `--` is FS, not the end of options.
		[
			`awk -i inplace -F -- --sourc='{print "X"}' ../v`,
			['--sourc={print "X"}', '../v'],
		],
		[`awk -i inplace -F -- -be'{print "X"}' ../v`, ['-be{print "X"}', '../v']],
		// G9
		['sed -i 1d - f', ['f']],
		['perl -i -Ilib -pe 1 f', ['f']],
		[`awk -i inplace -F -W '{print "X"}' ../v`, ['../v']],
	]);
});

/** GNU sed's long in-place flag and its abbreviations. */
describe('shell-write-detect: sed --in-place', () => {
	rows([
		['sed --in-place s/a/b/ ../v', ['../v']],
		['sed -s --in-place 1d ../v', ['../v']],
		['sed --in-place=.bak -e 1d ../v', ['../v']],
		['sed --in-place 1d -i ../v', ['../v']],
		['sed --in-place -e 1d src/a.ts', ['src/a.ts']],
		// An abbreviation is not modelled: reported with every positional.
		['sed --in s/a/b/ ../v', ['--in', '../v']],
		['sed -i --in-pl=.bak -e 1d ../v', ['--in-pl=.bak', '../v']],
	]);
});

/**
 * A quoted dynamic file operand is reported (and blocked as a dynamic
 * target); a quoted word is dropped as a script only when the text inside
 * the quotes is script-shaped. A word with a `..` component is a path.
 */
describe('shell-write-detect: quoted dynamic operands and .. scripts', () => {
	rows([
		['X=/etc/passwd; sed -i -e 1d "$X"', ['"$X"']],
		['X=/etc/passwd; perl -i -pe 1 "$X"', ['"$X"']],
		['X=/etc/passwd; sed -e 1d -i "$X" f', ['"$X"', 'f']],
		['sed -i -e 1d "${X}"', ['"${X}"']],
		['sed -i -e 1d "$X/f"', ['"$X/f"']],
		['sed -i -e 1d "a$X"', ['"a$X"']],
		['sed -i "`cmd`" f', ['"`cmd`"', 'f']],
		['sed -i -e 1d s/../../etc/g', ['s/../../etc/g']],
		['sed -i -e 1d y/../../etc/m', ['y/../../etc/m']],
		// Controls: quoted scripts keep their handling.
		['sed -i "s/$a/$b/" f', ['f']],
		['sed -i -e "s/$a/$b/" f', ['f']],
		['sed -i "$EXPR" f', ['f']],
		['sed -i -f s.sed -e "$X" f', ['f']],
		[`sed -i '' "s/$a/b/" f`, ['f']],
	]);
});

/** Test-engineer gap rows (G6, G7, G10). */
describe('shell-write-detect: redirects, awk -i and BSD path words', () => {
	rows([
		["S='1d ../../x'; sed -i 2>/dev/null $S src/a.ts", ['$S', 'src/a.ts']],
		["S='1d ../../x'; sed -i 2>err.log $S src/a.ts", ['$S', 'src/a.ts']],
		["S='1d ../../x'; sed -i $S 2>/dev/null src/a.ts", ['$S', 'src/a.ts']],
		["X='inplace {1} ../../v'; awk -i $X '{print}' f", ['$X', '{print}', 'f']],
		[
			"X='inplace {1} ../../v'; awk -i ${X} '{print}' f",
			['${X}', '{print}', 'f'],
		],
		["sed -i '' '/etc/a;b' f", ['/etc/a;b', 'f']],
		["sed -i '' '/etc/a;b' '/etc/c;d'", ['/etc/a;b', '/etc/c;d']],
		["sed -i '' 'y/ab/xy/' f", ['f']],
	]);
});
