/**
 * The bare-rmdir empty-directory-removal tag (issue #3450, PR #3456 closeout)
 * survives only on a PLAIN_COMMAND_LINE: a command text made solely of ASCII
 * letters, digits, space, tab, newline and `_ . / - = & | ; < >`. bash also
 * evaluates code it finds in QUOTED text at run time (arithmetic on a
 * variable, a `test -v` / `[ -v` array subscript), and a bash 5.3
 * `${ cd ..; }` body there runs in the current shell, which no AST rule can
 * see. The character rule makes every such context unreachable by
 * construction. The real-gate cases live in the -cwd test file.
 */

import { describe, expect, it } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

/** The tag flag of every rmdir write detectPosixWrites reports. */
function rmdirTags(command: string): boolean[] {
	return detectPosixWrites(command)
		.writes.filter((w) => w.operator.toLowerCase() === 'rmdir')
		.map((w) => w.emptyDirectoryRemoval === true);
}

describe('detectPosixWrites: runtime-evaluated quoted code loses the tag', () => {
	it.each([
		["x='a[${ cd ../o; }]'; echo $((x)); rmdir a"],
		["[ -v 'a[${ cd ../o; }]' ]; rmdir a"],
		["test -v 'a[${ cd ../o; }]'; rmdir a"],
		[`x='a[$'"{ cd ../o; }]"; echo $((x)); rmdir a`],
		["[ -v 'a[${ cd .swarm; }]' ]; rmdir lk"],
	])('strips the tag from %s', (command) => {
		expect(rmdirTags(command)).toEqual([false]);
	});
});

describe('detectPosixWrites: only a plain command line keeps the tag', () => {
	it.each([
		['rmdir .scratch-a/tmp1', [true]],
		['rmdir dir/', [true]],
		['rmdir ./dir', [true]],
		['rmdir a && rmdir b', [true, true]],
		['mkdir x && rmdir x', [true]],
		['rmdir a 2>/dev/null || true', [true]],
		['rmdir a && echo done', [true]],
		['FOO=1 rmdir a', [true]],
		['rmdir a\nrmdir b\n', [true, true]],
	])('keeps the tag for %j', (command, expected) => {
		expect(rmdirTags(command)).toEqual(expected);
	});

	// Accepted effect: each of these ran only cwd-neutral commands and kept
	// the tag before the character rule.
	it.each([
		['rmdir a && echo "done"'],
		['echo $HOME; rmdir a'],
		['[ -d src ] && rmdir a'],
		['rmdir a+b'],
		['rmdir a,b'],
		['rmdir a:b'],
		['rmdir a@b'],
		['rmdir a%b'],
	])('withdraws the exemption from %s (accepted effect)', (command) => {
		expect(rmdirTags(command)).toEqual([false]);
	});

	// One excluded character per case, in a position that parses. A lone
	// parenthesis does not parse (no tag either way), so parentheses are
	// covered as a pair. `#` is excluded because bash starts a comment only
	// at a word start (`rmdir d#/x` removes the one directory `d#/x`).
	it.each([
		['a double quote', 'rmdir a; echo "x"'],
		['a single quote', "rmdir a; echo 'x'"],
		['a backslash', 'rmdir a; echo x\\y'],
		['a dollar sign', 'rmdir a; echo $x'],
		['a backtick', 'rmdir a; echo `true`'],
		['parentheses', 'rmdir a; (true)'],
		['an opening brace', 'rmdir a; echo x{'],
		['a closing brace', 'rmdir a; echo x}'],
		['an opening bracket', 'rmdir a; echo x['],
		['a closing bracket', 'rmdir a; echo x]'],
		['an asterisk', 'rmdir a; echo x*'],
		['a question mark', 'rmdir a; echo x?'],
		['a tilde', 'rmdir a; echo ~'],
		['an exclamation mark', 'rmdir a; echo x!'],
		['a percent sign', 'rmdir a; echo x%'],
		['a plus sign', 'rmdir a; echo x+'],
		['a comma', 'rmdir a; echo x,y'],
		['a colon', 'rmdir a; echo x:y'],
		['an at sign', 'rmdir a; echo x@y'],
		['a carriage return', 'rmdir a\r\n'],
		['a non-ASCII character', 'rmdir a; echo é'],
		['a comment', 'rmdir a # note'],
		['a mid-word hash', 'rmdir d#/x'],
	])('strips the tag for %s', (_label, command) => {
		expect(rmdirTags(command)).toEqual([false]);
	});
});
