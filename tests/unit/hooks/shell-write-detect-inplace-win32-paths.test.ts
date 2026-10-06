import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function inplaceTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
}

function redirectTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'redirect')
		.map((w) => w.path);
}

// A backslash, built apart from the command text so each row reads as the
// shell sees it.
const B = '\\';

const rows = (cases: Array<[string, string[]]>) =>
	test.each(cases)('%s edits %j', (command, files) => {
		expect(inplaceTargets(command)).toEqual(files);
	});

/**
 * On win32 (Git Bash, MSYS) `\` is a path separator and `C:` a drive
 * prefix. A word in the BSD script slot (after `-i ''`) that has a `..`
 * component split on `/` or `\`, a drive-absolute prefix, or (in the
 * `;`/`{`/`}` shape) any `\` or `:` is a path GNU sed edits, so it is
 * reported. Without this, `sed -i '' 's-x-\..\..\pwned-1' src/a.ts` let GNU
 * sed write two levels above the root.
 */
describe('shell-write-detect: win32 path words in the BSD script slot', () => {
	rows([
		[
			`sed -i '' 'x;${B}..${B}.env' src/a.ts -n`,
			[`x;${B}..${B}.env`, 'src/a.ts'],
		],
		[
			`sed -i '' 's-x-${B}..${B}..${B}pwned-1' src/a.ts -n`,
			[`s-x-${B}..${B}..${B}pwned-1`, 'src/a.ts'],
		],
		[
			`sed -i '' 's-x-${B}..${B}..${B}pwned-1' src/a.ts`,
			[`s-x-${B}..${B}..${B}pwned-1`, 'src/a.ts'],
		],
		[
			`sed -n -i '' 's-x-${B}..${B}..${B}pwned-1' src/a.ts`,
			[`s-x-${B}..${B}..${B}pwned-1`, 'src/a.ts'],
		],
		[
			`sed -i '' 'x;${B}..${B}..${B}pwned' src/a.ts -n`,
			[`x;${B}..${B}..${B}pwned`, 'src/a.ts'],
		],
		[
			`sed -i '' '{${B}..${B}..${B}pwned' src/a.ts -n`,
			[`{${B}..${B}..${B}pwned`, 'src/a.ts'],
		],
		[
			`sed -i '' 'y-${B}..${B}..${B}pwned-a-' src/a.ts -n`,
			[`y-${B}..${B}..${B}pwned-a-`, 'src/a.ts'],
		],
		[
			`sed -i '' 'C:${B}Users${B}x${B}Temp${B}x;y' src/a.ts -n`,
			[`C:${B}Users${B}x${B}Temp${B}x;y`, 'src/a.ts'],
		],
		[
			`sed -i '' '${B}${B}srv${B}share${B}x;y' src/a.ts`,
			// The parser decodes `\\` inside quotes, so the reported word has one
			// leading backslash; it is still a rooted path, outside the root.
			[`${B}srv${B}share${B}x;y`, 'src/a.ts'],
		],
		[
			`sed -i '' '${B}Windows${B}x;y' src/a.ts`,
			[`${B}Windows${B}x;y`, 'src/a.ts'],
		],
		[`sed -i '' 'D:x;y' src/a.ts`, ['D:x;y', 'src/a.ts']],
		[`sed -i '' 'x;${B}a' src/a.ts`, [`x;${B}a`, 'src/a.ts']],
		// A `;` word with a `:` is reported too (a sed label script there is a
		// fail-safe over-report: the architect is allowed for an in-root name).
		[`sed -i '' ':a;N;ba' src/a.ts`, [':a;N;ba', 'src/a.ts']],
		// Controls: a backslash that is not next to a `..` component keeps an
		// s / y word a script.
		[`sed -i '' 's/a${B}/b/c/' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 's/${B}t/ /g' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 's/a${B}nb/c/' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 's/${B}(a${B})${B}(b${B})/${B}2${B}1/' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 's/${B}.${B}./x/' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 's:${B}t: :g' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 'y/abc/xyz/' src/a.ts`, ['src/a.ts']],
		[`sed -i '' '1d;$d' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 'N;P;D' src/a.ts`, ['src/a.ts']],
	]);
});

/**
 * The drive-absolute rule: an `s` / `y` word whose first two characters
 * read as a drive prefix followed by a separator (`s:/…`, `y:/…`) is a
 * path on win32 (drive S: or Y:), so it is reported. A `:`-delimited
 * script whose pattern starts with `/` is caught by this (a fail-safe
 * over-report); one that does not stays a script.
 */
describe('shell-write-detect: drive-absolute s / y words in the BSD slot', () => {
	rows([
		[
			`sed -i '' 's:/usr/local:/opt:g' src/a.ts`,
			['s:/usr/local:/opt:g', 'src/a.ts'],
		],
		[`sed -i '' 's:/a:/b:' src/a.ts`, ['s:/a:/b:', 'src/a.ts']],
		[`sed -i '' 'y:/:_:' src/a.ts`, ['y:/:_:', 'src/a.ts']],
		// Controls
		[`sed -i '' 's:a:b:' src/a.ts`, ['src/a.ts']],
		[`sed -i '' 'y:abc:xyz:' src/a.ts`, ['src/a.ts']],
	]);
});

/**
 * In a file slot, a word shaped like an `s///` script is dropped only when
 * it has no `..` component split on `/` or `\`.
 */
describe('shell-write-detect: win32 .. components in file slots', () => {
	rows([
		[`sed -i -e 1d 's/..${B}..${B}x/g'`, [`s/..${B}..${B}x/g`]],
		[`sed -i -e 1d 's/a${B}..${B}..${B}x/g'`, [`s/a${B}..${B}..${B}x/g`]],
		// Controls
		[`sed -i -e 1d 's/${B}.${B}./x/' f`, ['f']],
		[`sed -i 's/a${B}/b/c/' f`, ['f']],
	]);
});

/**
 * The parser decodes C escapes inside quotes, so `>'/dev/nul\154'` parses to
 * `/dev/null` while bash writes the literal file `/dev/nul\154`. A redirect
 * is exempt as a sink device only when its source text, after quote removal
 * and without escape decoding, is the device path.
 */
describe('shell-write-detect: escaped sink devices are write targets', () => {
	test.each([
		`echo x >'/dev${B}x2fnull'`,
		`echo x >'/dev/nul${B}x6c'`,
		`echo x >'/dev/nul${B}154'`,
		`echo x >"/dev/nul${B}154"`,
	])('%s is reported', (command) => {
		expect(redirectTargets(command)).toEqual(['/dev/null']);
	});
	test("echo x >'/dev/zer\\x6f' is reported", () => {
		expect(redirectTargets(`echo x >'/dev/zer${B}x6f'`)).toEqual(['/dev/zero']);
	});
	test.each([
		'echo x >/dev/null',
		'echo x >"/dev/null"',
		"echo x >'/dev/null'",
		"echo x >/dev/nul''l",
		'echo x >/dev/n"ul"l',
		`echo x >${B}/dev/null`,
		'echo x 2>/dev/null',
		'echo x >>/dev/null 2>&1',
	])('%s stays exempt', (command) => {
		expect(redirectTargets(command)).toEqual([]);
	});
});
