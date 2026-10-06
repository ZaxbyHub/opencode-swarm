import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function inplaceTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
}

/**
 * GNU sed reads the word after a bare `-i` as the script (`sed -n -i '' f`
 * truncates f) and every later word as a file; BSD sed reads it as a backup
 * suffix. The BSD reading (skip the next word as the script) is used only
 * when that word is shaped like a sed script and a file still follows. A
 * bare command letter (`d`, `p`, `X`) is not script-shaped: it can name a
 * file, so it is reported. sed reports every file it would edit, in order.
 */
describe('shell-write-detect: GNU and BSD readings of a detached -i word', () => {
	test.each([
		["sed -n -i '' .env", ['.env']],
		["sed -i '' -n .env", ['.env']],
		["sed -i '' /etc/passwd", ['/etc/passwd']],
		["sed -E -i '' f", ['f']],
		["sed -i -i '' .env", ['.env']],
		['sed -i .x .env', ['.env']],
		["sed -i.bak '' f", ['f']],
		// An attached suffix leaves no detached one: '' is the script.
		["sed -i.bak '' X f", ['X', 'f']],
		// GNU reading: the word after '' could be a path, so it is a file.
		["sed -i '' /etc/passwd x -n", ['/etc/passwd', 'x']],
		["sed -i '' /etc/passwd -n x", ['/etc/passwd', 'x']],
		["sed -i '' .env x --silent", ['.env', 'x']],
		["sed -i '' /etc/passwd 1d", ['/etc/passwd', '1d']],
		["sed -n -i '' .env x", ['.env', 'x']],
		["sed -i '' config.txt other.txt", ['config.txt', 'other.txt']],
		["sed -i '' ../x f", ['../x', 'f']],
		["sed -i '' Makefile other", ['Makefile', 'other']],
		// A path holding ; { } is not a script (`../{a}`, `/etc/{x}`).
		["sed -i '' '../{a}' f", ['../{a}', 'f']],
		["sed -i '' '.env;x' f", ['.env;x', 'f']],
		// ...or nothing reportable would be left after it.
		["sed -i '' x 's/a/b/'", ['x']],
		["sed -i '' 1d ''", ['1d']],
		["sed -i '' f 1d", ['f', '1d']],
		["sed -E -i '' f 's|a|b|'", ['f', 's|a|b|']],
		// GNU edits every remaining word as a file; each one is reported.
		["sed -n -i.bak '' '$d' 's/a/b/' /etc/passwd", ['$d', '/etc/passwd']],
		["sed -n -i.bak '' 'N;P;D' ../x", ['N;P;D', '../x']],
		["sed -i'' -s x p .env x", ['p', '.env', 'x']],
		// A bare letter is a file, not a script: over-reported on BSD sed.
		["sed -i '' X f", ['X', 'f']],
		['sed -i .bak X f', ['X', 'f']],
		["sed -i '' d f", ['d', 'f']],
		["sed -i '' p src/a.ts", ['p', 'src/a.ts']],
		["sed -i '' f P", ['f', 'P']],
		// BSD reading: suffix, addressed or negated command, file.
		["sed -i '' 1d f", ['f']],
		["sed -i '' '$d' f", ['f']],
		["sed -i '' 3q f", ['f']],
		["sed -i '' '$!d' f", ['f']],
		["sed -i '' '!d' f", ['f']],
		["sed -i '' 1,3p f", ['f']],
		// BSD reading: suffix, other script-shaped word, file.
		["sed -i '' 's/a/b/' f", ['f']],
		["sed -i '' 's|a|b|' f", ['f']],
		["sed -i '' 'N;P;D' f", ['f']],
		["sed -i '' '1d;$d' f", ['f']],
		['sed -i .bak 1d f', ['f']],
		["sed -i .bak 's/a/b/' f", ['f']],
		["sed -i '' -e 1d f", ['f']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * A path that holds `;`, `{` or `}` once counted as a sed script, and only
 * one file of a multi-file edit was reported, so the dangerous file could be
 * the one left out. GNU sed edits every file named, and each is reported.
 */
describe('shell-write-detect: sed reports every file of a multi-file edit', () => {
	test.each([
		["sed -i -e 1d '../{a}' src/a.ts", ['../{a}', 'src/a.ts']],
		["sed -i -e 1d '/etc/x;y' src/a.ts", ['/etc/x;y', 'src/a.ts']],
		["sed -i 1d '/opt/a;b' src/a.ts", ['/opt/a;b', 'src/a.ts']],
		["sed -i '' 1d '/etc/{x}' ok", ['/etc/{x}', 'ok']],
		['sed -i -e 1d f g h', ['f', 'g', 'h']],
		['sed -i s/a/b/ f1 f2', ['f1', 'f2']],
		[
			'sed -i -e 1d src/a.ts ../x /etc/passwd',
			['src/a.ts', '../x', '/etc/passwd'],
		],
		["sed -i.bak -e 's/a/b/' -e 1d a b", ['a', 'b']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});

	// perl -i and gawk -i inplace also edit every file, so every file is
	// reported; perl and awk keep their own script and program slots.
	test.each([
		['perl -i -pe s/a/b/ f1 f2', ['f1', 'f2']],
		['perl -pe s/a/b/ -i f1 f2', ['f1', 'f2']],
		["awk -i inplace '{print}' f1 f2", ['f1', 'f2']],
		['perl -i -pe X src/a.ts /etc/passwd', ['src/a.ts', '/etc/passwd']],
		[
			"awk -i inplace '{print}' src/a.ts /etc/passwd",
			['src/a.ts', '/etc/passwd'],
		],
		// A var=val operand is not a file; it is over-reported (fail-safe).
		["awk -i inplace '{print}' x=1 src/a.ts", ['x=1', 'src/a.ts']],
	])('perl and awk report every file: %s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * The BSD reading applies only to a pure literal word. A word with an
 * expansion (`$D`, `${D}`, `$(pwd)`, backticks, `$((1))`), a brace expansion
 * or a glob character becomes another word, possibly an absolute path, so it
 * is always reported, as the parser exposes it.
 */
describe('shell-write-detect: only a pure literal word is the BSD script', () => {
	test.each([
		["D=/etc/passwd; sed -i '' ${D} src/a.ts -n", ['${D}', 'src/a.ts']],
		["D=/etc/passwd; sed -i '' $D src/a.ts -n", ['$D', 'src/a.ts']],
		["D=.swarm/plan.json; sed -i '' $D src/a.ts -n", ['$D', 'src/a.ts']],
		["sed -i '' x${D} src/a.ts -n", ['x${D}', 'src/a.ts']],
		["sed -i '' ${D}x src/a.ts -n", ['${D}x', 'src/a.ts']],
		["sed -i '' ${HISTFILE} src/a.ts -n", ['${HISTFILE}', 'src/a.ts']],
		["sed -i '' $(cd;pwd) src/a.ts -n", ['$(cd;pwd)', 'src/a.ts']],
		["sed -i '' $((1))d src/a.ts -n", ['$((1))d', 'src/a.ts']],
		[
			"sed -i '' s-x-/$D/victim-1 src/a.ts -n",
			['s-x-/$D/victim-1', 'src/a.ts'],
		],
		[
			"sed -i '' s-x-/`printf ..`/victim-1 src/a.ts -n",
			['s-x-/`printf ..`/victim-1', 'src/a.ts'],
		],
		[
			"sed -i '' s-x-/{..,a}/{..,b}/outside/victimH-1 src/a.ts -n",
			['s-x-/{..,a}/{..,b}/outside/victimH-1', 'src/a.ts'],
		],
		[
			"sed -i '' s-x-/.?/.?/outside/victimG-1 src/a.ts -n",
			['s-x-/.?/.?/outside/victimG-1', 'src/a.ts'],
		],
		// Single-quoted literal scripts keep the BSD reading.
		["sed -i '' '$d' f", ['f']],
		["sed -i '' '1d' f", ['f']],
		["sed -i '' 'N;P;D' f", ['f']],
		["sed -i '' '1!G;h;$!d' f", ['f']],
		["sed -i '' 1d src/a.ts", ['src/a.ts']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * An expansion in the `-i` flag word itself can split it into `-i`, a script
 * and files (`X=' 1d ../v'; sed -i$X f` runs `sed -i 1d ../v f`). The flag
 * word is then reported (a dynamic candidate) and no later word is the
 * script.
 */
describe('shell-write-detect: an expansion in the -i flag word', () => {
	test.each([
		["X=' 1d ../v'; sed -i$X f", ['-i$X', 'f']],
		["X=' 1d ../v'; sed -i${X} f", ['-i${X}', 'f']],
		["X=' 1d ../v'; sed -i.$X f", ['-i.$X', 'f']],
		["sed -i`printf ' 1d'` ../v", ["-i`printf ' 1d'`", '../v']],
		["sed -i$(echo ' 1d ../v') f", ["-i$(echo ' 1d ../v')", 'f']],
		["X=' 1d ../v'; sed -n -i$X src/a.ts", ['-i$X', 'src/a.ts']],
		["X=' 1d ../v'; sed -i$X -e 1d f", ['-i$X', 'f']],
		// Literal flag words are unchanged.
		['sed -i.bak 1d f', ['f']],
		["sed -i'' 1d f", ['f']],
		['sed -i 1d f', ['f']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * The same holds for any option word: an expansion or brace expansion can
 * split it into options, a script and files, so it never supplies or
 * consumes the script and is reported as a candidate.
 */
describe('shell-write-detect: an expansion in any option word', () => {
	test.each([
		["X=' 1d ../../v'; sed -e$X -i src/a.ts", ['-e$X', 'src/a.ts']],
		["X=' -e 1d ../../v'; sed -n$X -i src/a.ts", ['-n$X', 'src/a.ts']],
		["X=' s.sed ../../v'; sed -f$X -i src/a.ts", ['-f$X', 'src/a.ts']],
		["X=' -e 1d ../../v'; sed -E$X -i src/a.ts", ['-E$X', 'src/a.ts']],
		["X=' -e 1d ../../v'; sed -s$X -i src/a.ts", ['-s$X', 'src/a.ts']],
		[
			"X='1d ../../v'; sed --expression=$X -i src/a.ts",
			['--expression=$X', 'src/a.ts'],
		],
		["X='s.sed ../../v'; sed --file=$X -i src/a.ts", ['--file=$X', 'src/a.ts']],
		['sed -e{1d,x} -i f', ['-e{1d,x}', 'f']],
		// An expanding -e does not count as a script flag, so `.bak` after a
		// bare -i is not taken for a BSD suffix: GNU edits it as a file.
		["X=' 1d ../../v'; sed -e$X -i .bak f", ['-e$X', '.bak', 'f']],
		// Literal option words are unchanged.
		['sed -e1d -i f', ['f']],
		['sed -n -i 1d f', ['f']],
		['sed --expression=1d -i f', ['f']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * The detached argument of an option (`-e X`, `-f X`, `-l N`) is skipped as
 * that option's argument only while it stays one word. An unquoted expansion
 * there field-splits into the argument plus files, so it is reported. A plain
 * double-quoted parameter expansion is not split and keeps its old handling.
 */
describe('shell-write-detect: an expansion in a detached option argument', () => {
	test.each([
		["X='1d ../../v'; sed -e $X -i src/a.ts", ['$X', 'src/a.ts']],
		["X='s.sed ../../v'; sed -f $X -i src/a.ts", ['$X', 'src/a.ts']],
		["X='5 ../../v'; sed -l $X -i 1d src/a.ts", ['$X', '1d', 'src/a.ts']],
		["X='1d ../../v'; sed --expression $X -i src/a.ts", ['$X', 'src/a.ts']],
		// perl and awk do not permute: the extra words of the split argument
		// are operands, so every later word is reported.
		[
			"X='x=1 ../../v'; awk -v $X -i inplace '{print}' f",
			['$X', '-i', 'inplace', '{print}', 'f'],
		],
		[
			"X=', ../../v'; awk -F $X -i inplace '{print}' f",
			['$X', '-i', 'inplace', '{print}', 'f'],
		],
		["X='1 ../../v'; perl -e $X -i f", ['$X', '-i', 'f']],
		['sed -e {1d,../../v} -i src/a.ts', ['{1d,../../v}', 'src/a.ts']],
		// Literal arguments and double-quoted expansions are unchanged.
		['sed -e 1d -i f', ['f']],
		['sed -l 5 -i 1d f', ['f']],
		['sed -i -e "s/$a/$b/" src/f.ts', ['src/f.ts']],
		['sed -i -e"s/$a/$b/" src/f.ts', ['src/f.ts']],
		['sed -i --expression="s/$a/$b/" src/f.ts', ['src/f.ts']],
		['sed -e "$X" -i f', ['f']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * Only a plain double-quoted parameter expansion is taken to stay one word.
 * A command or arithmetic substitution anywhere in the word (quote characters
 * inside it would mislead a quote scan) and a list expansion (`$@`, `$*`,
 * `${A[@]}`, which split even inside double quotes) make the word one that
 * may split: it is reported in every slot, and a quoted one is not filtered
 * as a quoted script.
 */
describe('shell-write-detect: a quoted word that may still split', () => {
	describe('a command substitution anywhere in the word', () => {
		test.each([
			[
				'X=\'1d /etc/passwd\'; sed "$(: "\'")"$X -i src/f.ts',
				['"$(: "\'")"$X', 'src/f.ts'],
			],
			[
				'X=\'1d /etc/passwd\'; sed -i -n "$(: "\'")"$X src/f.ts',
				['"$(: "\'")"$X', 'src/f.ts'],
			],
			['sed -i -- "$(: "\'")"$X src/f.ts', ['"$(: "\'")"$X', 'src/f.ts']],
			['sed -e"$(: "\'")"$X -i src/f.ts', ['-e"$(: "\'")"$X', 'src/f.ts']],
			[
				'X=\'1d .env\'; sed -i -n "$(: "\'")"$X src/f.ts',
				['"$(: "\'")"$X', 'src/f.ts'],
			],
			['sed -i -e "$(cat s.sed)" src/f.ts', ['"$(cat s.sed)"', 'src/f.ts']],
			['sed -i "$((n))d" f', ['"$((n))d"', 'f']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	describe('a list expansion, quoted or not', () => {
		test.each([
			['sed -e"${A[@]}" -i f', ['-e"${A[@]}"', 'f']],
			['sed -e"$@" -i f', ['-e"$@"', 'f']],
			['sed --expression="${A[@]}" -i f', ['--expression="${A[@]}"', 'f']],
			['sed -e "$@" -i f', ['"$@"', 'f']],
			['sed -e"${!P@}" -i f', ['-e"${!P@}"', 'f']],
			['sed -e"${A[*]}" -i f', ['-e"${A[*]}"', 'f']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	describe('a quoted word that may split is not filtered as a script', () => {
		test.each([
			['sed -i "$@" f', ['"$@"', 'f']],
			['sed -i "${A[@]}" f', ['"${A[@]}"', 'f']],
			['sed -i "$*" f', ['"$*"', 'f']],
			['sed -i "$(cmd)" f', ['"$(cmd)"', 'f']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	describe('a plain double-quoted parameter expansion stays one word', () => {
		test.each([
			['sed -i -e "s/$a/$b/" src/f.ts', ['src/f.ts']],
			['sed -i -e"s/$a/$b/" src/f.ts', ['src/f.ts']],
			['sed -i --expression="s/$a/$b/" src/f.ts', ['src/f.ts']],
			['sed -i "$EXPR" src/f.ts', ['src/f.ts']],
			['sed -i "${X:-a b}" src/f.ts', ['src/f.ts']],
			["sed -i -e 's/$@/x/' src/f.ts", ['src/f.ts']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	// A double quote inside single quotes opens nothing: the `$X` after `'"'`
	// is unquoted and splits.
	describe('a quote character inside single quotes', () => {
		test.each([
			[`X='1d /etc/passwd'; sed -i -n '"'$X src/f.ts`, [`'"'$X`, 'src/f.ts']],
			[`X='1d /etc/passwd'; sed '"'$X -i src/f.ts`, [`'"'$X`, 'src/f.ts']],
			[`X='1d /etc/passwd'; sed -e'"'$X -i src/f.ts`, [`-e'"'$X`, 'src/f.ts']],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});

	// A backslash-escaped quote opens nothing: the `$X` after `\"` or `\'` is
	// unquoted and splits.
	describe('a backslash-escaped quote character', () => {
		test.each([
			[
				String.raw`X='1d /etc/passwd'; sed -i -n \"$X src/f.ts`,
				[String.raw`\"$X`, 'src/f.ts'],
			],
			[
				String.raw`X='1d /etc/passwd'; sed \"$X -i src/f.ts`,
				[String.raw`\"$X`, 'src/f.ts'],
			],
			[
				String.raw`X='1d /etc/passwd'; sed -i -n "a\"b"$X src/f.ts`,
				[String.raw`"a\"b"$X`, 'src/f.ts'],
			],
			[
				String.raw`X='1d /etc/passwd'; sed -i -n \'$X src/f.ts`,
				[String.raw`\'$X`, 'src/f.ts'],
			],
		])('%s edits %j', (command, files) => {
			expect(inplaceTargets(command)).toEqual(files);
		});
	});
});

/**
 * Pins for neighbouring picker behaviour: perl's `-i` never takes a detached
 * suffix (its script is the first positional; every later word is a file),
 * a BSD-shaped suffix with a
 * literal script still reports each later word, repeated script flags, and
 * words after `--` that GNU reads as operands.
 */
describe('shell-write-detect: neighbouring picker pins', () => {
	test.each([
		['perl -i ./s.pl 1d f', ['1d', 'f']],
		['perl -i .bak 1d f', ['1d', 'f']],
		['perl -pe 1 -i .bak f', ['.bak', 'f']],
		["sed -i '' 1d 2d", ['1d', '2d']],
		["X='1d ../v'; sed -e $X -i .bak f", ['$X', '.bak', 'f']],
		['sed -ne p -ne 1d -i f', ['f']],
		['sed -i -ne p -ne 1d f', ['f']],
		['sed -- 1d -i f', ['1d', '-i', 'f']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * In the GNU script slot (no script flag), a word that can turn into several
 * words is never consumed as the script: a brace expansion or an unquoted
 * expansion yields the script plus files. Quoted scripts, even with glob
 * characters, are still the script.
 */
describe('shell-write-detect: a multi-word expansion is never the GNU script', () => {
	test.each([
		[
			'sed -i {1d,../../outside/v} src/a.ts',
			['{1d,../../outside/v}', 'src/a.ts'],
		],
		['sed -E -i -s a{,..}/x ../x -n', ['a{,..}/x', '../x']],
		["sed -E -i'' -n a{,..}/x .env -n", ['a{,..}/x', '.env']],
		['sed -i.bak {1d,../v} src/a.ts', ['{1d,../v}', 'src/a.ts']],
		['sed 1d{,x} -i src/a.ts', ['1d{,x}', 'src/a.ts']],
		["S='1d ../../x'; sed -i $S src/a.ts", ['$S', 'src/a.ts']],
		// Quoted scripts in the script slot stay the script.
		["sed -i '1d' src/a.ts", ['src/a.ts']],
		["sed -i 's/a/b/' src/a.ts", ['src/a.ts']],
		["sed -i '/^\\s*$/d' src/a.ts", ['src/a.ts']],
		["sed -i '$d' src/a.ts", ['src/a.ts']],
		["sed '1d' -i src/a.ts", ['src/a.ts']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * After `-i ''`, GNU sed reads '' as the script and the next word as a file.
 * A word with a `..` path component is never taken for the BSD script,
 * whatever its delimiter, because as a file it can sit outside the root.
 */
describe('shell-write-detect: a word with a .. component is never the BSD script', () => {
	test.each([
		[
			"sed -i '' 's-x-/../../victim-1' src/a.ts -n",
			['s-x-/../../victim-1', 'src/a.ts'],
		],
		[
			"sed -i '' 's-x-/../.swarm/plan-1' src/a.ts -n",
			['s-x-/../.swarm/plan-1', 'src/a.ts'],
		],
		[
			"sed -i '' 's_a_/../../../home/u/notes_2' src/a.ts -n",
			['s_a_/../../../home/u/notes_2', 'src/a.ts'],
		],
		["sed -i '' s/../../p src/a.ts -n", ['s/../../p', 'src/a.ts']],
		// A script without a .. component keeps the BSD reading.
		["sed -i '' 's/a/b/' f", ['f']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * GNU sed permutes its arguments: with no script flag, the first positional
 * word is the script even when it comes before `-i`, and every other
 * positional is a file. `sed 1d -i ../x` edits ../x.
 */
describe('shell-write-detect: a sed script before the in-place flag', () => {
	test.each([
		['sed 1d -i F', ['F']],
		['sed s/a/b/ -i F', ['F']],
		['sed -n 1d -i F', ['F']],
		['sed 1d -i.bak F', ['F']],
		['sed 1d -i F G', ['F', 'G']],
		['sed 1d -i ../x', ['../x']],
		["sed 1d -i '' F", ['F']],
		// GNU reads .bak here as a second file.
		['sed 1d -i .bak F', ['.bak', 'F']],
		// An option's argument is neither the script nor a file.
		['sed -l 5 1d -i F', ['F']],
		['sed --line-length 5 1d -i F', ['F']],
		['sed -nl 5 1d -i F', ['F']],
		['sed -i 1d -l 5 f', ['f']],
		// Shapes with the script after the in-place flag are unchanged.
		['sed -i 1d F', ['F']],
		['sed -i -n 1d F', ['F']],
		['sed -i -- 1d F', ['F']],
		['sed -n -i p F', ['F']],
		["sed -i.bak 's/a/b/' F", ['F']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});

/**
 * With a script flag, GNU sed reads the word after a bare `-i` as a file;
 * BSD sed reads it as a backup suffix. Only a conventional backup suffix is
 * taken as the BSD suffix; any other dot-word is a file.
 */
describe('shell-write-detect: a dot-word after a bare -i with a script flag', () => {
	test.each([
		['sed -e s/a/b/ -i ../x f', ['../x', 'f']],
		['sed -e 1d -i .env f', ['.env', 'f']],
		['sed -e 1d -i ./etc/passwd src/a.ts', ['./etc/passwd', 'src/a.ts']],
		['sed -e 1d -i .bashrc f', ['.bashrc', 'f']],
		['sed -e 1d -i .a/b f', ['.a/b', 'f']],
		['sed -e 1d -i .env', ['.env']],
		// BSD backup suffixes stay suffixes.
		["sed -i .bak -e 's/a/b/' src/f", ['src/f']],
		['sed -e X -i .orig f', ['f']],
		['sed -e X -i .BAK f', ['f']],
		["sed -e 1d -i '' f", ['f']],
		// A suffix with nothing after it is the only candidate, so it is reported.
		['sed -e 1d -i .bak', ['.bak']],
	])('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});
});
