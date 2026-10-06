/**
 * A redirect into a sink device (`2>/dev/null`, `>/dev/null 2>&1`) is not a
 * write target. Before this exemption the AST redirect path reported it as a
 * write to `/dev/null`, the authority layer resolved that outside the
 * workspace, and every agent that silenced stderr the usual way was blocked
 * with AUTHORITY_ROOT_ESCAPE. The exemption matches the literal word only, so
 * a relative `dev/null`, a dynamic `$X/dev/null`, or a traversal through the
 * device (`/dev/null/../x`) is still a write target.
 */

import { describe, expect, test } from 'bun:test';
import {
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';

const WS = '/ws';

describe('shell-write-detect: sink-device redirects are not write targets', () => {
	test.each([
		'ls -la .swarm 2>/dev/null',
		'cat package.json 2>/dev/null; ls -la',
		'node t.js >/dev/null 2>&1 && echo PASS',
		'cmd > /dev/null',
		"cmd > '/dev/null'",
		'cmd > "/dev/null"',
		'cmd &>/dev/null',
		'cmd >| /dev/null',
		'cmd 2>>/dev/null',
		'(cd src && cmd 2>/dev/null)',
		'(cmd) 2>/dev/null',
		'for f in tests/unit/*.test.js; do node "$f" >/dev/null 2>&1 && echo "PASS $f"; done',
	])('no write for %s', (command) => {
		const result = detectPosixWrites(command);
		expect(result.parseError).toBeUndefined();
		expect(result.hasWrites).toBe(false);
		expect(result.writes).toEqual([]);
	});

	test('other sink devices from the shared helper are exempt too', () => {
		expect(detectPosixWrites('cmd > /dev/zero').hasWrites).toBe(false);
		expect(detectPosixWrites('cmd > /dev/urandom').hasWrites).toBe(false);
	});

	test('a real redirect beside a /dev/null redirect is still detected', () => {
		const result = detectPosixWrites('cmd > out.txt 2>/dev/null');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'out.txt' },
		]);
		const resolved = resolveWriteTargets(
			'cmd > out.txt 2>/dev/null',
			result.writes,
			WS,
		);
		expect(resolved.map((r) => r.resolvedPath)).toEqual([`${WS}/out.txt`]);
	});

	test('a builtin write beside a /dev/null redirect is still detected', () => {
		const result = detectPosixWrites('tee out.txt 2>/dev/null');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'tee', path: 'out.txt' },
		]);
	});

	test.each([
		['traversal through the device', 'cmd > /dev/null/../../etc/passwd'],
		['relative dot path', 'cmd > ./dev/null'],
		['relative path', 'cmd > dev/null'],
		['dynamic prefix', 'cmd > $X/dev/null'],
		['device name as a prefix of another name', 'cmd > /dev/null.txt'],
	])('%s is still a write target', (_label, command) => {
		const result = detectPosixWrites(command);
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toHaveLength(1);
		expect(result.writes[0]?.category).toBe('redirect');
	});

	test('traversal through the device resolves outside the workspace', () => {
		const command = 'cmd > /dev/null/../../etc/passwd';
		const result = detectPosixWrites(command);
		const resolved = resolveWriteTargets(command, result.writes, WS);
		expect(resolved.map((r) => r.resolvedPath)).toEqual(['/etc/passwd']);
	});

	test('a here-doc delimiter named like the device is still a here-doc marker', () => {
		const result = detectPosixWrites('cmd << /dev/null');
		expect(result.writes.map((w) => w.category)).toEqual(['here_doc']);
	});

	test('reading from /dev/null was never a write', () => {
		expect(detectPosixWrites('cmd < /dev/null').hasWrites).toBe(false);
	});

	// Intentional: only /dev/null, /dev/zero and /dev/urandom are exempt.
	test.each([
		['cmd 2>/dev/stderr', '/dev/stderr'],
		['echo hi >/dev/stdout', '/dev/stdout'],
	])('%s is still reported as a redirect write', (command, path) => {
		expect(detectPosixWrites(command).writes).toEqual([
			{ category: 'redirect', operator: '>', path },
		]);
	});
});

/**
 * detectPosixWrites never reports a sink-device redirect, but the Windows
 * detectors still do, and tool-before / scope-validate / the explain service
 * pass those writes to resolveWriteTargets with the same command string. The
 * resolver's redirect collector skips sink devices, so such a write resolves
 * against the caller's cwd; collected, it would resolve against the POSIX cd
 * tracker's context, which for a Windows cwd is a mangled path that can sit
 * on another drive.
 */
describe('shell-write-detect: resolver skips sink-device redirects', () => {
	test.each([
		['cd sub && echo x > /dev/null', 'D:\\', 'D:\\dev\\null'],
		['cd .. ; echo x 2>/dev/null', 'C:\\ws', 'C:\\dev\\null'],
	])('%s from %s resolves against the caller cwd', (command, cwd, expected) => {
		const writes = detectWindowsWrites(command, 'powershell').writes;
		const sink = writes.filter((w) => w.path === '/dev/null');
		expect(sink).toEqual([
			{ category: 'redirect', operator: '>', path: '/dev/null' },
		]);
		const resolved = resolveWriteTargets(command, sink, cwd);
		expect(resolved.map((r) => r.resolvedPath)).toEqual([expected]);
	});
});

/**
 * The "last argument is the destination" pickers (cp, mv, install, ln, tar
 * -C, unzip -d) used to see a trailing redirect as an empty-string argument
 * and report an empty path. With the /dev/null redirect no longer reported
 * on its own, that empty path was the only thing left and it resolved to the
 * workspace root, so `cp a /etc/passwd 2>/dev/null` lost its real target.
 * Redirect nodes are not arguments; the picker now skips them.
 */
describe('shell-write-detect: a trailing redirect does not hide a builtin destination', () => {
	test.each([
		['cp a /etc/passwd 2>/dev/null', 'cp', '/etc/passwd'],
		['cp a b 2>/dev/null', 'cp', 'b'],
		['cp a 2>/dev/null b', 'cp', 'b'],
		['cp a b >/dev/null 2>&1', 'cp', 'b'],
		['mv a b 2>/dev/null', 'mv', 'b'],
		['install a b 2>/dev/null', 'install', 'b'],
		['ln -s a b 2>/dev/null', 'ln', 'b'],
	])('%s reports the real destination', (command, operator, dest) => {
		const result = detectPosixWrites(command);
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator, path: dest },
		]);
		const resolved = resolveWriteTargets(command, result.writes, WS);
		expect(resolved[0]?.resolvedPath).toBe(
			dest.startsWith('/') ? dest : `${WS}/${dest}`,
		);
	});

	test('a trailing redirect to a real file is reported beside the destination', () => {
		const result = detectPosixWrites('cp a b 2>err.log');
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'err.log' },
			{ category: 'builtin_write', operator: 'cp', path: 'b' },
		]);
	});

	test('archive extraction targets survive a trailing redirect', () => {
		expect(
			detectPosixWrites('tar -xzf p.tgz -C vendor/ 2>/dev/null').writes,
		).toEqual([
			{ category: 'archive_extract', operator: 'tar -x', path: 'vendor/' },
		]);
		expect(detectPosixWrites('unzip p.zip -d d 2>/dev/null').writes).toEqual([
			{ category: 'archive_extract', operator: 'unzip', path: 'd' },
		]);
	});

	test('no write ever has an empty path', () => {
		for (const command of [
			'cp a b 2>/dev/null',
			'mv a b >out.txt',
			'tar -xzf p.tgz -C vendor/ 2>/dev/null',
			'cp -r a/ b/ 2>/dev/null | tee log',
		]) {
			for (const w of detectPosixWrites(command).writes) {
				expect(w.path).not.toBe('');
			}
		}
	});
});

/**
 * In-place edit flags. A bare `-i` used to consume the next suffix word
 * unconditionally; once a trailing redirect stopped leaving a "" placeholder
 * there, `sed -e X -i 2>/dev/null f` consumed `f` itself and reported
 * nothing. GNU sed and perl never take a detached backup suffix; BSD sed
 * does (`-i ''` or `-i .bak`), and only that form consumes the next word.
 */
describe('shell-write-detect: in-place edits keep their file beside a redirect', () => {
	test.each([
		['sed -e s/a/b/ -i 2>/dev/null f', 'sed -i', 'f'],
		['perl -pe s/a/b/ -i 2>/dev/null f', 'perl -i', 'f'],
		['sed -e s/a/b/ -i f', 'sed -i', 'f'],
		['sed -e s/a/b/ -i /etc/passwd 2>/dev/null', 'sed -i', '/etc/passwd'],
		['sed -i "s/foo/bar/g" file.txt 2>/dev/null', 'sed -i', 'file.txt'],
		["sed -i '' s/a/b/ f", 'sed -i', 'f'],
		['sed -i .bak s/a/b/ f', 'sed -i', 'f'],
		['sed -i.bak s/a/b/ f', 'sed -i', 'f'],
		['sed -e s/a/b/ -i.bak f', 'sed -i', 'f'],
		['sed -ibak "s/foo/bar/" script.sh', 'sed -i', 'script.sh'],
		['perl -i -pe "s/foo/bar/" data.csv', 'perl -i', 'data.csv'],
		['perl -i.orig -pe s/a/b/ data.csv', 'perl -i', 'data.csv'],
		// Non-s/// scripts after a bare -i: the script is consumed, not reported
		["sed -i '1d' f", 'sed -i', 'f'],
		["sed -i '/^$/d' f", 'sed -i', 'f'],
		['sed -i 1d /etc/passwd 2>/dev/null', 'sed -i', '/etc/passwd'],
		["sed -i '' 1d f", 'sed -i', 'f'],
		['sed -i.bak 1d f', 'sed -i', 'f'],
		// `--` and bare switches are never the file
		['sed -i -- s/a/b/ /etc/passwd', 'sed -i', '/etc/passwd'],
		['sed -e s/a/b/ -i -- /etc/passwd', 'sed -i', '/etc/passwd'],
		['sed -n -i p f', 'sed -i', 'f'],
		['sed -E -i 1d f', 'sed -i', 'f'],
		['sed -i s/a/b/ -- -dash', 'sed -i', '-dash'],
		['sed --expression=s/a/b/ -i f', 'sed -i', 'f'],
		// GNU switch bundles ending in -e supply the script
		["sed -i -ne 's/x/y/p' /etc/passwd", 'sed -i', '/etc/passwd'],
		["sed -ne 's/x/y/p' -i /etc/passwd", 'sed -i', '/etc/passwd'],
		['sed -i -ne p f', 'sed -i', 'f'],
		['sed -Ee s/a/b/ -i f', 'sed -i', 'f'],
		// Bare switches between -i and the script
		['sed -i -n 1d f', 'sed -i', 'f'],
		["sed -i -n 's/x/y/p' f", 'sed -i', 'f'],
		['sed -i -E -n 1d f', 'sed -i', 'f'],
		['sed -i -E 1d /etc/passwd', 'sed -i', '/etc/passwd'],
		['sed -i -s 1d f', 'sed -i', 'f'],
		['sed -i -- 1d /etc/passwd', 'sed -i', '/etc/passwd'],
		['sed -ibak -n p f', 'sed -i', 'f'],
		["sed -i '' -n 1d f", 'sed -i', 'f'],
		['sed -i 1d -- --', 'sed -i', '--'],
		['awk -iinplace -F : {print} f', 'awk -i', 'f'],
		// GNU: a dot word after -i with a script flag is the file when nothing follows
		['sed -e s/a/b/ -i .env', 'sed -i', '.env'],
		['sed -e s/a/b/ -i .bak f', 'sed -i', 'f'],
		// gawk
		['awk -i inplace "{print $1}" records.txt', 'awk -i', 'records.txt'],
		['awk -i inplace {print} f 2>/dev/null', 'awk -i', 'f'],
		['awk -iinplace {print} /etc/passwd', 'awk -i', '/etc/passwd'],
		['awk -f prog.awk -i inplace f', 'awk -i', 'f'],
		['awk -i inplace -F , -v x=1 {print} f', 'awk -i', 'f'],
	])('%s edits %s', (command, operator, file) => {
		const inplace = detectPosixWrites(command).writes.filter(
			(w) => w.category === 'inplace_edit',
		);
		expect(inplace).toEqual([
			{ category: 'inplace_edit', operator, path: file },
		]);
	});

	test('a redirect to a real file is reported beside the in-place target', () => {
		expect(detectPosixWrites('sed -i s/a/b/ f 2>err.log').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'err.log' },
			{ category: 'inplace_edit', operator: 'sed -i', path: 'f' },
		]);
	});
});

/**
 * In-place edits whose script is supplied by an ATTACHED flag (`-e's/a/b/'`,
 * `-e1d`, `-fs.sed`, perl `-pe1`, gawk `-fprog` / `-e'{...}'`) must still
 * report the real file. When the detector failed to see the attached script
 * flag, it took the word after a bare `-i` to be the implicit script, so the
 * real file was swallowed and the command reached the write-authority layer
 * with no write at all: `sed -i -e's/a/b/' /etc/passwd` and `sed -i -e1d .env`
 * were admitted for every role. Every expected path below was checked against
 * the real GNU sed 4.9, perl 5.42 and gawk 5.4 in a sandbox: the file named is
 * the one the real binary rewrote, except rows marked as conservative.
 */
function inplaceTargets(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'inplace_edit')
		.map((w) => w.path);
}

const FILES = ['f.txt', '/etc/passwd', '.env'];

describe('shell-write-detect: attached sed script flags keep the real file', () => {
	const forms = [
		"sed -i -e's/a/b/' FILE",
		'sed -i -es/a/b/ FILE',
		'sed -i -fs.sed FILE',
		'sed -i -e1d FILE',
		'sed -i -Ee1p FILE',
		'sed -E -i -e1d FILE',
		'sed -s -i -e1d FILE',
		"sed -i -e's/a/b/' -e's/c/d/' FILE",
		'sed -i.bak -e1d FILE',
		'sed -n -i -e1p FILE',
		'sed -i -ne1p FILE',
		'sed --expression=1d -i FILE',
		'sed -i --expression 1d FILE',
	];
	test.each(
		forms.flatMap((form) =>
			FILES.map((file) => [form.replace('FILE', file), file]),
		),
	)('%s edits %s', (command, file) => {
		expect(inplaceTargets(command)).toEqual([file]);
	});

	test('a dot word after a bare -i is the file when an attached flag holds the script', () => {
		expect(inplaceTargets('sed -e1d -i .env')).toEqual(['.env']);
	});

	test('a detached -nf bundle consumes the script file, not the target', () => {
		expect(inplaceTargets('sed -nf s.sed -i /etc/passwd')).toEqual([
			'/etc/passwd',
		]);
	});

	test('a word after -- that looks like a script flag is an operand', () => {
		expect(inplaceTargets('sed -i 1d -- -e/../../etc/passwd')).toEqual([
			'-e/../../etc/passwd',
		]);
	});
});

describe('shell-write-detect: perl in-place forms keep the real file', () => {
	test.each([
		// Real perl rewrites FILE. perl has no detached backup suffix, so
		// ./s.pl is the script and FILE the file.
		['perl -i ./s.pl FILE', false],
		['perl -i -pe1 FILE', false],
		['perl -i -pes/a/b/ FILE', false],
		['perl -i -wpe1 FILE', false],
		['perl -i -0777pe1 FILE', false],
		// Reported conservatively: without -p/-n real perl never reads FILE,
		// but the detector cannot tell whether the script loops over <>.
		['perl -i -le1 FILE', false],
		['perl -le print -i FILE', false],
		['perl -i -e1 FILE', true],
		['perl -i.bak -e1 FILE', true],
		['perl -i -es/a/b/ FILE', true],
		['perl -i -Esay FILE', true],
	] as const)('%s', (form, evalToo) => {
		for (const file of FILES) {
			const command = form.replace('FILE', file);
			expect(inplaceTargets(command)).toEqual([file]);
			const evals = detectPosixWrites(command).writes.filter(
				(w) => w.category === 'interpreter_eval',
			);
			expect(evals).toHaveLength(evalToo ? 1 : 0);
		}
	});

	test.each([
		'perl -E say -i f',
		"perl -E 'say 1' -i f",
		'perl -E say -i.bak f',
	])('a detached -E script is consumed (conservative report): %s', (command) => {
		expect(inplaceTargets(command)).toEqual(['f']);
	});

	test('a dot-prefixed word after a bare -i is a perl file, not a suffix', () => {
		expect(inplaceTargets('perl -pe s/a/b/ -i ../outside.txt f')).toEqual([
			'../outside.txt',
			'f',
		]);
	});
});

describe('shell-write-detect: gawk program files and program text keep the real file', () => {
	test.each([
		'awk -i inplace -fprog FILE',
		'awk -i inplace --file=p.awk FILE',
		'awk -i inplace -fprog -v x=1 FILE',
		'awk -i inplace -F: -fprog FILE',
		"awk -i inplace -e'{print}' FILE",
		"awk -i inplace -e '{print}' FILE",
		"awk -i inplace --source='{print}' FILE",
		"awk -i inplace -e '{print}' -e 1 FILE",
	])('%s', (form) => {
		for (const file of FILES) {
			expect(inplaceTargets(form.replace('FILE', file))).toEqual([file]);
		}
	});

	test('an option argument that looks like -f is not a program file', () => {
		// -F consumes `-fx` as the field separator; {print} is the program.
		expect(inplaceTargets("awk -F -fx -i inplace '{print}' f")).toEqual(['f']);
	});
});

describe('shell-write-detect: in-place controls are unchanged', () => {
	test.each([
		["sed -i 's/a/b/' f", ['f']],
		["sed -i -e 's/a/b/' f", ['f']],
		["sed -i.bak 's/a/b/' f", ['f']],
		['sed -n -i p f', ['f']],
		['sed -i -- X f', ['f']],
		['sed -e X -i f', ['f']],
		['perl -i.bak -pe X f', ['f']],
		["awk -i inplace '{print}' f", ['f']],
		["awk -v x=1 -i inplace '{print}' f", ['f']],
		// A bare letter after a detached suffix may be a file: both reported.
		["sed -i '' X f", ['X', 'f']],
		['sed -i .bak X f', ['X', 'f']],
		["sed -i '' 1d f", ['f']],
		// GNU reads -ie as -i with backup suffix `e`; the script is next.
		['sed -ie s/a/b/ f', ['f']],
	] as const)('%s', (command, expected) => {
		expect(inplaceTargets(command)).toEqual([...expected]);
	});

	test('perl -pi -e X f stays an interpreter eval only', () => {
		expect(detectPosixWrites('perl -pi -e X f').writes).toEqual([
			{ category: 'interpreter_eval', operator: 'perl [eval]', path: null },
		]);
	});
});

describe('shell-write-detect: empty words are never reported as the file', () => {
	test.each([
		"sed -e s/a/b/ -i '' f",
		"sed -e X '' -i f",
		"sed -e s/a/b/ '' f -i",
	])('%s edits f', (command) => {
		expect(inplaceTargets(command)).toEqual(['f']);
	});
});

describe('shell-write-detect: repeated in-place flags', () => {
	test('only the first -i places the implicit script', () => {
		// GNU sed: script 1d, file f (the second -i is a repeated switch).
		expect(inplaceTargets('sed -i 1d -i f')).toEqual(['f']);
	});

	test('a long run of -i flags is detected in linear time', () => {
		// Each -i used to rescan the whole switch run: N=40000 took ~13 s.
		const command = `sed${' -i'.repeat(40_000)} 1d f`;
		const start = performance.now();
		const targets = inplaceTargets(command);
		const elapsed = performance.now() - start;
		expect(targets).toEqual(['f']);
		expect(elapsed).toBeLessThan(5_000);
	}, 60_000);
});

describe('shell-write-detect: multi-file in-place edits', () => {
	test('sed reports every file it edits', () => {
		expect(inplaceTargets('sed -i s/a/b/ f1 f2')).toEqual(['f1', 'f2']);
	});

	test('perl and awk report every file they edit', () => {
		expect(inplaceTargets('perl -i -pe s/a/b/ f1 f2')).toEqual(['f1', 'f2']);
		expect(inplaceTargets("awk -i inplace '{print}' f1 f2")).toEqual([
			'f1',
			'f2',
		]);
	});
});
