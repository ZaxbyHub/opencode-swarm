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
