import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/sandbox/macos/sandbox-exec-executor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Seatbelt matches `subpath` against the kernel-resolved path, so the profile
 * must embed resolved paths: an unresolved system prefix (macOS `/tmp`, `/var`,
 * `/etc`) never matches and every in-scope write is denied. Only those three
 * prefixes are rewritten, and only when this host confirms the link; every
 * other path is left as written (fail closed), so a project symlink can never
 * widen the profile to its target.
 */
const posix = process.platform !== 'win32';

// A host whose /tmp, /var and /etc are the macOS links into /private.
const macLinks = {
	realpath: (p: string): string => {
		if (['/tmp', '/var', '/etc'].includes(p)) return `/private${p}`;
		throw new Error('unexpected realpath');
	},
};
// A hostile host that claims EVERY path is a link into /private: only the
// prefix allowlist (not the host check) can keep other paths unchanged.
const everythingLinked = { realpath: (p: string): string => `/private${p}` };
// A host (Linux) where they are ordinary directories.
const plainDirs = { realpath: (p: string): string => p };

describe.skipIf(!posix)(
	'realpathOrSelf rewrites only the macOS system links',
	() => {
		test.each([
			['/tmp/work', '/private/tmp/work'],
			['/var/folders/ab/T/x', '/private/var/folders/ab/T/x'],
			['/etc/hosts', '/private/etc/hosts'],
			['/var', '/private/var'],
			// not-yet-created children are just the same prefix swap
			['/tmp/new/sub/dir', '/private/tmp/new/sub/dir'],
		])('%s -> %s', (input, expected) => {
			expect(_internals.realpathOrSelf(input, macLinks)).toBe(expected);
		});

		test.each([
			'/proj/link/x', // a project path: never rewritten, whatever it links to
			'/Users/someone/projects/a',
			'/tmpfoo/x', // prefix boundary
			'/variable/x',
			'/private/tmp/x', // already resolved
			'/etc2',
		])('%s is returned unchanged (negative control)', (input) => {
			expect(_internals.realpathOrSelf(input, macLinks)).toBe(input);
			expect(_internals.realpathOrSelf(input, everythingLinked)).toBe(input);
		});

		test('a host where the system link is absent leaves the path unchanged', () => {
			expect(_internals.realpathOrSelf('/tmp/work', plainDirs)).toBe(
				'/tmp/work',
			);
		});

		test('an unreadable link leaves the path unchanged', () => {
			const broken = {
				realpath: (): string => {
					throw new Error('EACCES');
				},
			};
			expect(_internals.realpathOrSelf('/tmp/work', broken)).toBe('/tmp/work');
		});

		test('a real project symlink is never followed', () => {
			const real = canonicalMkdtemp('sbpl-user-link-');
			const link = `${real}-link`;
			fs.symlinkSync(real, link);
			expect(_internals.realpathOrSelf(link)).toBe(link);
		});
	},
);

// Real macOS: the system temp root lives under the root-owned /var -> /private/var link.
const sandboxExec = '/usr/bin/sandbox-exec';
const darwin = process.platform === 'darwin' && fs.existsSync(sandboxExec);

function logicalTmp(): { real: string; logical: string } {
	const real = canonicalMkdtemp('sbpl-system-link-');
	return { real, logical: real.replace(/^\/private/, '') };
}

describe.skipIf(!darwin)(
	'macOS profile uses the resolved system path (darwin)',
	() => {
		test('the profile embeds /private/… for a scope path under /var or /tmp', () => {
			const { real, logical } = logicalTmp();
			const profile = _internals.buildSandboxProfile([logical], '');
			expect(profile).toContain(`(subpath "${real}")`);
			expect(_internals.buildProbeProfile(logical)).toContain(
				`(subpath "${real}")`,
			);
		});

		test('an in-scope write through the logical path succeeds; a sibling write is denied', () => {
			const { real, logical } = logicalTmp();
			const profileFile = path.join(canonicalMkdtemp('sbpl-profile-'), 'p.sb');
			fs.writeFileSync(
				profileFile,
				_internals.buildSandboxProfile([logical], ''),
			);
			const inScope = spawnSync(
				sandboxExec,
				['-f', profileFile, '/bin/sh', '-c', `echo x > '${logical}/ok.txt'`],
				{ encoding: 'utf-8' },
			);
			expect(inScope.status).toBe(0);
			expect(fs.existsSync(path.join(real, 'ok.txt'))).toBe(true);

			const outside = canonicalMkdtemp('sbpl-outside-');
			const denied = spawnSync(
				sandboxExec,
				['-f', profileFile, '/bin/sh', '-c', `echo x > '${outside}/no.txt'`],
				{ encoding: 'utf-8' },
			);
			expect(denied.status).not.toBe(0);
			expect(fs.existsSync(path.join(outside, 'no.txt'))).toBe(false);
		});
	},
);
