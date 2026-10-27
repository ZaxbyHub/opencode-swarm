import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/sandbox/macos/sandbox-exec-executor';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

/**
 * Seatbelt matches `subpath` against the kernel-resolved path, so the profile
 * must embed resolved paths: an unresolved system prefix (macOS `/tmp`, `/var`,
 * `/etc`) never matches and its allow line is inert. Only those three prefixes
 * are rewritten, and only when this host confirms the link; every other path is
 * left as written (fail closed), so a project symlink can never widen the
 * profile to its target.
 */
const posix = process.platform !== 'win32';

// Every directory/symlink this file creates, removed once the file is done.
const fixtures = new Set<string>();
function track(p: string): string {
	fixtures.add(p);
	return p;
}
afterAll(() => {
	// rmSync removes a symlink itself without following it.
	for (const p of fixtures) removeTreeWithRetry(p);
	fixtures.clear();
});

const SYSTEM_ROOTS = ['/tmp', '/var', '/etc'];

// A host whose /tmp, /var and /etc are the macOS links into /private.
const macLinks = {
	realpath: (p: string): string => {
		if (SYSTEM_ROOTS.includes(p)) return `/private${p}`;
		throw new Error('unexpected realpath');
	},
};
// A hostile host that claims EVERY path is a link into /private: only the
// prefix allowlist (not the host check) can keep other paths unchanged.
const everythingLinked = { realpath: (p: string): string => `/private${p}` };
// A host (Linux) where they are ordinary directories.
const plainDirs = { realpath: (p: string): string => p };

// A macOS host that records every path it is asked about and would map any
// project path that is (wrongly) resolved to a hostile target. The function
// must consult it for the system root ONLY, so a mutant that follows a project
// link after confirming the host fails these cases directly.
function spyHost(hostile: Record<string, string> = {}) {
	const calls: string[] = [];
	return {
		calls,
		realpath(p: string): string {
			calls.push(p);
			if (SYSTEM_ROOTS.includes(p)) return `/private${p}`;
			if (p in hostile) return hostile[p] as string;
			throw new Error(`realpath consulted a non-system path: ${p}`);
		},
	};
}

describe('realpathOrSelf rewrites only the macOS system links', () => {
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
		expect(_internals.realpathOrSelf('/tmp/work', plainDirs)).toBe('/tmp/work');
	});

	test('an unreadable link leaves the path unchanged', () => {
		const broken = {
			realpath: (): string => {
				throw new Error('EACCES');
			},
		};
		expect(_internals.realpathOrSelf('/tmp/work', broken)).toBe('/tmp/work');
	});

	test('a project symlink under a confirmed system prefix is never resolved or followed', () => {
		const host = spyHost({ '/tmp/proj/link': '/private/Users/victim' });
		expect(_internals.realpathOrSelf('/tmp/proj/link', host)).toBe(
			'/private/tmp/proj/link',
		);
		// Only the system root was consulted; the project path was not.
		expect(host.calls).toEqual(['/tmp']);
	});

	test.each([
		'/tmp/a/b',
		'/var/folders/x/T/y',
		'/etc/z',
	])('%s consults only its own system root', (input) => {
		const host = spyHost({ [input]: '/private/Users/victim' });
		expect(_internals.realpathOrSelf(input, host)).toBe(`/private${input}`);
		expect(host.calls).toEqual([`/${input.split('/')[1]}`]);
	});
});

// Real macOS: the system temp root lives under the root-owned /var -> /private/var link.
const sandboxExec = '/usr/bin/sandbox-exec';
const darwin = process.platform === 'darwin' && fs.existsSync(sandboxExec);

function logicalTmp(): { real: string; logical: string } {
	const real = track(canonicalMkdtemp('sbpl-system-link-'));
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

		test('the temp dir is embedded in resolved form too', () => {
			const { real, logical } = logicalTmp();
			expect(_internals.buildSandboxProfile([], logical)).toContain(
				`(subpath "${real}")`,
			);
		});

		test('a real symlink inside the logical tmp tree embeds the link, not its target', () => {
			const { real, logical } = logicalTmp();
			const victim = track(canonicalMkdtemp('sbpl-victim-'));
			fs.symlinkSync(victim, path.join(real, 'link'));
			const profile = _internals.buildSandboxProfile([`${logical}/link`], '');
			expect(profile).toContain(`(subpath "${real}/link")`);
			expect(profile).not.toContain(`(subpath "${victim}")`);
		});

		test('an in-scope write through the logical path succeeds; a sibling write is denied', () => {
			const { real, logical } = logicalTmp();
			// Passed inline (-p), exactly as wrapCommand does: no profile file.
			const profile = _internals.buildSandboxProfile([logical], '');
			const inScope = spawnSync(
				sandboxExec,
				['-p', profile, '/bin/sh', '-c', `echo x > '${logical}/ok.txt'`],
				{ encoding: 'utf-8', timeout: 10_000 },
			);
			expect(inScope.status).toBe(0);
			expect(fs.existsSync(path.join(real, 'ok.txt'))).toBe(true);

			const outside = track(canonicalMkdtemp('sbpl-outside-'));
			const denied = spawnSync(
				sandboxExec,
				['-p', profile, '/bin/sh', '-c', `echo x > '${outside}/no.txt'`],
				{ encoding: 'utf-8', timeout: 10_000 },
			);
			expect(denied.status).not.toBe(0);
			expect(fs.existsSync(path.join(outside, 'no.txt'))).toBe(false);
		});
	},
);
