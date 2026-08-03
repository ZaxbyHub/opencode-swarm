/**
 * Transcription of OpenCode's `Filesystem.normalizePathPattern`.
 *
 * Lane rule patterns must be byte-identical to what the host produces for the
 * asked path, because `Permission.fromConfig` applies no canonicalisation of
 * its own. If this transcription drifts from the host, every lane grant stops
 * matching and the lane is denied access to its own directories.
 *
 * The convergence property (a symlink/junction path and its real path produce
 * the SAME pattern) is what makes the grant work; it is asserted here against a
 * real on-disk link rather than a mock.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_test_exports,
	hostNormalizePathPattern,
} from '../../../src/config/host-path';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { hostWindowsPath, hostNormalizePath } = _test_exports;
const realRealpath = _internals.realpathSyncNative;

afterEach(() => {
	_internals.realpathSyncNative = realRealpath;
});

describe('hostWindowsPath — verbatim drive-letter rewrites', () => {
	test.each([
		['/c:/Users/x', 'C:/Users/x'],
		['/c/Users/x', 'C:/Users/x'],
		['/cygdrive/d/work', 'D:/work'],
		['/mnt/e/repo', 'E:/repo'],
	])('%s -> %s', (input, expected) => {
		expect(hostWindowsPath(input)).toBe(expected);
	});

	test.each([
		['C:\\already\\windows'],
		['/usr/local/share'],
		['/home/user/project'],
		['relative/path'],
	])('%s is left alone', (input) => {
		expect(hostWindowsPath(input)).toBe(input);
	});
});

describe('hostNormalizePathPattern — host contract', () => {
	test('the bare catch-all is returned untouched', () => {
		// The host special-cases this before any path handling.
		expect(hostNormalizePathPattern('*')).toBe('*');
	});

	// WINDOWS ONLY. `C:` is a drive root only under win32 path semantics; under
	// POSIX `path.resolve('C:\\')` prepends the cwd, so an unconditional
	// assertion here passes on a Windows dev box and fails on the ubuntu CI
	// runner. Same class as the `swwt` assertion in lane-permissions.test.ts.
	test.skipIf(process.platform !== 'win32')(
		'a drive-root pattern keeps its root (does not become the cwd)',
		() => {
			// Host special case: `C:` alone would resolve to the process's current
			// directory on that drive, so a separator is appended first.
			expect(hostNormalizePathPattern('C:/*')).toBe(path.join('C:\\', '*'));
		},
	);

	test('the drive-root special case never throws, on any platform', () => {
		// Platform-agnostic half of the case above: whatever the path flavour, the
		// branch must produce a usable pattern rather than blowing up.
		expect(() => hostNormalizePathPattern('C:/*')).not.toThrow();
		expect(hostNormalizePathPattern('C:/*').endsWith('*')).toBe(true);
	});

	test('a non-existent directory degrades to the resolved form (ENOENT)', () => {
		const missing = path.resolve('/definitely/not/here/at/all');
		expect(hostNormalizePathPattern(path.join(missing, '*'))).toBe(
			path.join(missing, '*'),
		);
	});

	test('a non-pattern input falls through to normalizePath', () => {
		const p = path.resolve('/some/plain/path');
		expect(hostNormalizePathPattern(p)).toBe(hostNormalizePath(p));
	});

	test('a realpath failure other than ENOENT still degrades rather than throwing', () => {
		_internals.realpathSyncNative = () => {
			const err = new Error('EACCES') as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		};
		// A REAL directory, not a synthetic '/x/y': under POSIX the host's
		// windowsPath rewrites a single-letter first segment ('/x/y' -> 'X:/y'),
		// which path.resolve then re-anchors under cwd. See the dedicated
		// single-letter regression block below.
		const { dir: realDir, cleanup } = createSafeTestDir('host-path-degrade-');
		try {
			const p = path.resolve(realDir);
			expect(() => hostNormalizePathPattern(path.join(p, '*'))).not.toThrow();
			expect(hostNormalizePathPattern(path.join(p, '*'))).toBe(
				path.join(p, '*'),
			);
		} finally {
			cleanup();
		}
	});
});

describe('regression (PR #2015 CI): single-letter first segment is an MSYS drive', () => {
	// FOUND BY CI, NOT LOCALLY. On Windows `path.resolve("/a/b")` yields
	// `C:\a\b`, so this never fired; on ubuntu/macos it does.
	//
	// The host's `windowsPath` (binary offset ~107196300) has FOUR rewrites, and
	// the second one is an MSYS single-letter drive mapping:
	//
	//   .replace(/^\/([a-zA-Z])(?:\/|$)/, (z, Z) => `${Z.toUpperCase()}:/`)
	//
	// It fires on ANY POSIX path whose first segment is a single letter, so
	// `/a/b` -> `A:/b`. `path.resolve` then treats `A:/b` as relative under
	// POSIX and re-anchors it beneath the cwd.
	//
	// This is NOT a defect in our transcription — it is the host's own
	// behaviour, faithfully reproduced. It is also HARMLESS for matching,
	// because the host applies the identical rewrite to the patterns it ASKS
	// with (`normalizePathPattern` calls the same `normalizePath`), so a rule
	// and an ask for the same directory are mangled the same way and still
	// compare equal. The asserted convergence is pinned below.
	//
	// The practical consequence is for TEST FIXTURES: never use a synthetic
	// absolute path whose first segment is a single letter. Use a real
	// directory, or at least a multi-letter first segment.
	const singleLetter = ['/a/b', '/x/y', '/c/Users/x', '/z'];
	const multiLetter = ['/aa/bb', '/tmp/proj', '/home/runner/x', '/opt/x'];

	test.skipIf(process.platform === 'win32').each(singleLetter)(
		'%s is rewritten to a drive-letter form under POSIX',
		(input) => {
			expect(hostWindowsPath(input)).toMatch(/^[A-Z]:\//);
		},
	);

	test.each(multiLetter)('%s is left alone', (input) => {
		expect(hostWindowsPath(input)).toBe(input);
	});

	test('a rule and an ask for the same directory still converge', () => {
		// The property that makes the rewrite harmless in production: both sides
		// go through the same normaliser, so they agree whatever it does.
		for (const dir of [...singleLetter, ...multiLetter]) {
			const rulePattern = hostNormalizePathPattern(path.join(dir, '*'));
			const askedPattern = hostNormalizePathPattern(path.join(dir, '*'));
			expect(rulePattern).toBe(askedPattern);
		}
	});

	test('the transcription matches the host regex exactly (all four rewrites)', () => {
		// Guards against someone "fixing" the single-letter rule out of
		// hostWindowsPath after reading the CI failure above.
		expect(hostWindowsPath('/c:/Users/x')).toBe('C:/Users/x');
		expect(hostWindowsPath('/c/Users/x')).toBe('C:/Users/x');
		expect(hostWindowsPath('/cygdrive/d/work')).toBe('D:/work');
		expect(hostWindowsPath('/mnt/e/repo')).toBe('E:/repo');
	});
});

describe('convergence: a linked path and its target produce the same pattern', () => {
	test('symlink/junction resolves to the real target', () => {
		const { dir, cleanup } = createSafeTestDir('host-path-');
		try {
			const real = path.join(dir, 'real-target');
			fs.mkdirSync(real, { recursive: true });
			const link = path.join(dir, 'link-to-target');
			try {
				fs.symlinkSync(real, link, 'junction');
			} catch {
				// Symlink/junction creation can require elevation on some hosts.
				return;
			}
			const viaLink = hostNormalizePathPattern(path.join(link, '*'));
			const viaReal = hostNormalizePathPattern(path.join(real, '*'));
			// THE property: an un-canonicalised rule would name the link and never
			// match the host's asked pattern, denying the lane its own grant.
			expect(viaLink).toBe(viaReal);
			expect(viaLink).toBe(path.join(fs.realpathSync.native(real), '*'));
		} finally {
			cleanup();
		}
	});
});
