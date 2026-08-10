import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	containsControlChars,
	containsPathTraversal,
	validateDirectory,
	validateProjectDirectory,
	validateSymlinkBoundary,
} from '../../../src/utils/path-security';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('containsPathTraversal', () => {
	test('blocks basic ../', () => {
		expect(containsPathTraversal('../etc/passwd')).toBe(true);
		expect(containsPathTraversal('foo/../../bar')).toBe(true);
		expect(containsPathTraversal('..\\windows\\system32')).toBe(true);
	});

	test('blocks URL-encoded traversal %2e%2e%2f', () => {
		expect(containsPathTraversal('%2e%2e%2f')).toBe(true);
		expect(containsPathTraversal('%2E%2E%2F')).toBe(true);
	});

	test('blocks Unicode homoglyph traversal', () => {
		// Fullwidth dot U+FF0E
		expect(containsPathTraversal('\uff0e\uff0e/')).toBe(true);
		// Ideographic full stop U+3002
		expect(containsPathTraversal('\u3002\u3002/')).toBe(true);
		// Halfwidth katakana middle dot U+FF65
		expect(containsPathTraversal('\uff65\uff65/')).toBe(true);
	});

	test('blocks double-encoded traversal', () => {
		expect(containsPathTraversal('%252e%252e%252f')).toBe(true);
	});

	test('blocks backslash separator variants', () => {
		expect(containsPathTraversal('..\\foo')).toBe(true);
		expect(containsPathTraversal('%5c..%5c')).toBe(true);
	});

	test('blocks encoded forward slash', () => {
		expect(containsPathTraversal('%2f')).toBe(true);
		expect(containsPathTraversal('%2F')).toBe(true);
	});

	test('blocks mixed encoding', () => {
		expect(containsPathTraversal('%2e.')).toBe(true);
	});

	test('allows normal paths', () => {
		expect(containsPathTraversal('src/utils/index.ts')).toBe(false);
		expect(containsPathTraversal('README.md')).toBe(false);
		expect(containsPathTraversal('tests/unit/config')).toBe(false);
		expect(containsPathTraversal('.gitignore')).toBe(false);
		expect(containsPathTraversal('a.b.c')).toBe(false);
	});
});

describe('containsControlChars', () => {
	test('blocks null byte', () => {
		expect(containsControlChars('foo\0bar')).toBe(true);
	});

	test('blocks tab', () => {
		expect(containsControlChars('foo\tbar')).toBe(true);
	});

	test('blocks carriage return', () => {
		expect(containsControlChars('foo\rbar')).toBe(true);
	});

	test('blocks newline', () => {
		expect(containsControlChars('foo\nbar')).toBe(true);
	});

	test('blocks C0/C1 and bidi formatting controls', () => {
		expect(containsControlChars('foo\x1bbar')).toBe(true);
		expect(containsControlChars('foo\x7fbar')).toBe(true);
		expect(containsControlChars('safe\u202eunsafe')).toBe(true);
		expect(containsControlChars('safe\u2066unsafe')).toBe(true);
	});

	test('allows normal strings', () => {
		expect(containsControlChars('hello world')).toBe(false);
		expect(containsControlChars('src/tools/lint.ts')).toBe(false);
		expect(containsControlChars('日本語🔒')).toBe(false);
		expect(containsControlChars('')).toBe(false);
	});
});

describe('validateDirectory', () => {
	test('accepts valid directories', () => {
		expect(() => validateDirectory('src')).not.toThrow();
		expect(() => validateDirectory('tests/unit')).not.toThrow();
		expect(() => validateDirectory('my-project')).not.toThrow();
	});

	test('rejects empty directories', () => {
		expect(() => validateDirectory('')).toThrow('empty');
		expect(() => validateDirectory('   ')).toThrow('empty');
	});

	test('rejects paths with traversal', () => {
		expect(() => validateDirectory('../etc')).toThrow('path traversal');
		expect(() => validateDirectory('foo/../../bar')).toThrow('path traversal');
	});

	test('rejects paths with control chars', () => {
		expect(() => validateDirectory('foo\0bar')).toThrow('control characters');
		expect(() => validateDirectory('foo\nbar')).toThrow('control characters');
	});

	test('rejects absolute paths', () => {
		expect(() => validateDirectory('/etc/passwd')).toThrow('absolute path');
		expect(() => validateDirectory('\\windows')).toThrow('absolute path');
	});

	test('rejects Windows absolute paths', () => {
		expect(() => validateDirectory('C:\\Users')).toThrow(
			'Windows absolute path',
		);
		expect(() => validateDirectory('D:/Projects')).toThrow(
			'Windows absolute path',
		);
	});
});

describe('validateProjectDirectory', () => {
	// The trust-model counterpart to validateDirectory: the project root the
	// plugin host injects is TRUSTED and always ABSOLUTE. Both absolute forms
	// must be accepted on EVERY platform — a Linux CI runner has to validate a
	// Windows-style root string and vice versa, otherwise the same source is
	// only exercised on one host (issue #1619 follow-up).
	test('accepts POSIX-absolute roots on every platform', () => {
		expect(() =>
			validateProjectDirectory('/home/runner/work/repo'),
		).not.toThrow();
		expect(() =>
			validateProjectDirectory('/Users/dev/my project'),
		).not.toThrow();
	});

	test('accepts Windows-drive-absolute roots on every platform', () => {
		expect(() => validateProjectDirectory('C:\\Users\\dev\\app')).not.toThrow();
		expect(() =>
			validateProjectDirectory('E:/ClaudeCode/opencode-swarm'),
		).not.toThrow();
	});

	test('accepts a real absolute temp directory (the shape tests actually use)', () => {
		const dir = canonicalMkdtemp('vpd-');
		try {
			expect(() => validateProjectDirectory(dir)).not.toThrow();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// #1619 review round 4 (F5). The previous version of this test asserted the
	// BACKSLASH UNC root is accepted unconditionally. That is a Windows-only
	// truth: `path.isAbsolute` is bound to the host platform, `\\server\share`
	// is win32-absolute but NOT posix-absolute, and the drive-letter fallback
	// does not match it — so the old assertion passed on a Windows dev box and
	// would have thrown on a Linux/macOS CI runner. Both arms below assert, so
	// neither platform runs a vacuous test.
	test('UNC roots: the forward-slash form is portable, the backslash form is Windows-only', () => {
		// Mechanism, pinned platform-independently so this documents the rule on
		// every runner rather than only on the one executing it.
		expect(path.posix.isAbsolute('//server/share/project')).toBe(true);
		expect(path.win32.isAbsolute('//server/share/project')).toBe(true);
		expect(path.posix.isAbsolute('\\\\server\\share\\project')).toBe(false);
		expect(path.win32.isAbsolute('\\\\server\\share\\project')).toBe(true);

		// Forward-slash UNC is absolute under both parsers, so it validates
		// everywhere.
		expect(() =>
			validateProjectDirectory('//server/share/project'),
		).not.toThrow();

		if (process.platform === 'win32') {
			expect(() =>
				validateProjectDirectory('\\\\server\\share\\project'),
			).not.toThrow();
		} else {
			expect(() =>
				validateProjectDirectory('\\\\server\\share\\project'),
			).toThrow('must be an absolute path');
		}
	});

	test('a driveless rooted POSIX path is absolute on Windows too', () => {
		// path.win32.isAbsolute('/srv/app') is true, so this validates on both
		// platforms — the reason the docblock calls out driveless rooted paths.
		expect(path.win32.isAbsolute('/srv/app')).toBe(true);
		expect(() => validateProjectDirectory('/srv/app')).not.toThrow();
	});

	test('rejects empty and whitespace-only roots', () => {
		// An empty root makes path.resolve('', '.swarm') land on the host process
		// cwd — an invariant-4 (.swarm containment) escape, not a harmless no-op.
		expect(() => validateProjectDirectory('')).toThrow('empty');
		expect(() => validateProjectDirectory('   ')).toThrow('empty');
	});

	test('rejects traversal even when the root is otherwise absolute', () => {
		expect(() => validateProjectDirectory('/srv/app/../../etc')).toThrow(
			'path traversal',
		);
		expect(() => validateProjectDirectory('C:\\app\\..\\..\\Windows')).toThrow(
			'path traversal',
		);
		expect(() => validateProjectDirectory('/srv/%2e%2e/etc')).toThrow(
			'path traversal',
		);
	});

	test('rejects control and directional-format characters', () => {
		expect(() => validateProjectDirectory('/srv/app\0/etc')).toThrow(
			'control characters',
		);
		expect(() => validateProjectDirectory('/srv/app\nrm -rf')).toThrow(
			'control characters',
		);
		// U+202E RIGHT-TO-LEFT OVERRIDE — display-spoofing a path segment.
		expect(() => validateProjectDirectory('/srv/\u202egpj.exe')).toThrow(
			'control characters',
		);
	});

	test('rejects RELATIVE roots — they resolve against the host process cwd', () => {
		expect(() => validateProjectDirectory('src')).toThrow('absolute path');
		expect(() => validateProjectDirectory('tests/unit')).toThrow(
			'absolute path',
		);
		expect(() => validateProjectDirectory('./app')).toThrow('absolute path');
		// Drive-relative (no separator after the colon) is NOT absolute.
		expect(() => validateProjectDirectory('C:app')).toThrow('absolute path');
	});

	test('is NOT interchangeable with validateDirectory — the two are duals', () => {
		// Guards against a future "simplification" that collapses them.
		const absolute = '/srv/app';
		const relative = 'src/tools';
		expect(() => validateDirectory(absolute)).toThrow();
		expect(() => validateProjectDirectory(absolute)).not.toThrow();
		expect(() => validateDirectory(relative)).not.toThrow();
		expect(() => validateProjectDirectory(relative)).toThrow();
	});

	test('is reachable through the _internals DI seam', () => {
		expect(_internals.validateProjectDirectory).toBe(validateProjectDirectory);
	});
});

describe('validateSymlinkBoundary', () => {
	test('does not throw when target is within root', () => {
		expect(() => validateSymlinkBoundary('/foo/bar', '/foo')).not.toThrow();
	});

	test('does not throw when target equals root', () => {
		expect(() => validateSymlinkBoundary('/foo', '/foo')).not.toThrow();
	});

	test('throws when target is outside root', () => {
		expect(() => validateSymlinkBoundary('/etc/passwd', '/home/user')).toThrow(
			'Symlink resolution escaped boundary',
		);
	});

	test('handles non-existent paths gracefully', () => {
		// realpathSync throws for non-existent paths, should fall back to resolve
		expect(() =>
			validateSymlinkBoundary('/non/existent/path', '/non/existent'),
		).not.toThrow();
	});

	test('handles asymmetric root existence without drive-root writes', () => {
		const rootless = '/boundary-asymmetric-test';
		const targetRootless = `${rootless}/definitely-does-not-exist`;
		const originalRealpathSync = _internals.realpathSync;
		_internals.realpathSync = ((candidate: fs.PathLike) => {
			if (String(candidate) === rootless) return path.resolve(rootless);
			throw new Error('ENOENT: synthetic non-existent child');
		}) as typeof fs.realpathSync;
		try {
			expect(() =>
				validateSymlinkBoundary(targetRootless, rootless),
			).not.toThrow();
		} finally {
			_internals.realpathSync = originalRealpathSync;
		}
	});

	test('works with subdirectory of root', () => {
		expect(() => validateSymlinkBoundary('/foo/bar/baz', '/foo')).not.toThrow();
	});

	test('works with Windows-style paths', () => {
		// Use path.join to create platform-compatible absolute paths
		const root = path.join('C:', 'Users', 'test');
		const target = path.join(root, 'subdir', 'file.txt');
		expect(() => validateSymlinkBoundary(target, root)).not.toThrow();
	});

	test('throws for Windows path outside boundary', () => {
		const root = path.join('C:', 'Users', 'test');
		const target = path.join('C:', 'Windows', 'System32');
		expect(() => validateSymlinkBoundary(target, root)).toThrow(
			'Symlink resolution escaped boundary',
		);
	});

	test('works with temp directories for realistic testing', () => {
		const tmpDir = fs.mkdtempSync(
			path.join(fs.realpathSync(os.tmpdir()), 'symlink-test-'),
		);
		const subDir = path.join(tmpDir, 'subdir');
		fs.mkdirSync(subDir, { recursive: true });

		// Should not throw - subdir is within tmpDir
		expect(() => validateSymlinkBoundary(subDir, tmpDir)).not.toThrow();

		// Cleanup
		fs.rmSync(subDir, { recursive: true });
		fs.rmSync(tmpDir, { recursive: true });
	});

	test.skipIf(process.platform === 'win32')(
		'throws for symlink escaping boundary',
		() => {
			const tmpDir = fs.mkdtempSync(
				path.join(fs.realpathSync(os.tmpdir()), 'symlink-test-'),
			);
			const linkTarget = fs.mkdtempSync(
				path.join(fs.realpathSync(os.tmpdir()), 'symlink-target-'),
			);
			const linkPath = path.join(tmpDir, 'malicious_link');

			// Create symlink from linkPath to linkTarget
			fs.symlinkSync(linkTarget, linkPath);

			// linkPath -> linkTarget escapes tmpDir boundary
			expect(() => validateSymlinkBoundary(linkPath, tmpDir)).toThrow(
				'Symlink resolution escaped boundary',
			);

			// Cleanup
			fs.unlinkSync(linkPath);
			fs.rmSync(linkTarget, { recursive: true });
			fs.rmSync(tmpDir, { recursive: true });
		},
	);

	test('rejects a not-yet-existing target whose ".." tail would escape the root', () => {
		const root = fs.mkdtempSync(
			path.join(fs.realpathSync(os.tmpdir()), 'dotdot-tail-root-'),
		);
		try {
			// subdir/../../escaped.txt: neither 'subdir' nor 'escaped.txt'
			// exists, and the '..' segments climb out past root once resolved.
			// The fix must normalize this tail before composing with the
			// resolved ancestor, not just check the ancestor in isolation. This
			// is a general containment guard test, not #1986 regression coverage
			// — it also passes against the pre-#1986-fix implementation.
			const target = `${root}${path.sep}subdir${path.sep}..${path.sep}..${path.sep}escaped.txt`;
			expect(() => validateSymlinkBoundary(target, root)).toThrow(
				'Symlink resolution escaped boundary',
			);
		} finally {
			fs.rmSync(root, { recursive: true });
		}
	});
});

describe(
	'validateSymlinkBoundary — regression: not-yet-existing target under a ' +
		'symlinked root spuriously rejected (#1986)',
	() => {
		// Previous code resolved a not-yet-existing target via path.resolve
		// (unresolved literal path) while an existing, symlinked root resolved
		// via realpathSync (fully resolved) — an apples-to-oranges comparison
		// that spuriously threw "escaped boundary" even though the target was
		// genuinely inside the root. This mirrors macOS's /var -> /private/var
		// symlink: any workspace root under /tmp or /var hit this on first
		// write, before the target file existed.
		//
		// Both tests below are falsifiable against the pre-fix implementation:
		// reverting resolveNearestExistingCanonical to a direct
		// realpathSync-or-path.resolve fallback (the old validateSymlinkBoundary
		// body) makes the first test throw spuriously and the second test throw
		// for the wrong reason (both symptoms of the apples-to-oranges bug).
		test.skipIf(process.platform === 'win32')(
			'accepts a not-yet-existing target directly under a symlinked root',
			() => {
				const realBase = fs.mkdtempSync(
					path.join(fs.realpathSync(os.tmpdir()), 'symlink-root-real-'),
				);
				const linkRoot = path.join(
					fs.realpathSync(os.tmpdir()),
					`symlink-root-link-${process.pid}-${Date.now()}`,
				);
				fs.symlinkSync(realBase, linkRoot, 'dir');

				try {
					// repo-graph.json does not exist yet — this is the exact shape
					// of the pre-fix failure (creating .swarm/repo-graph.json under
					// a workspace root that is itself a symlink).
					const target = path.join(linkRoot, 'repo-graph.json');
					expect(() => validateSymlinkBoundary(target, linkRoot)).not.toThrow();
				} finally {
					fs.unlinkSync(linkRoot);
					fs.rmSync(realBase, { recursive: true });
				}
			},
		);

		test.skipIf(process.platform === 'win32')(
			'rejects a not-yet-existing target under a symlinked subdirectory that escapes the root',
			() => {
				const root = fs.mkdtempSync(
					path.join(fs.realpathSync(os.tmpdir()), 'symlink-escape-root-'),
				);
				const elsewhere = fs.mkdtempSync(
					path.join(fs.realpathSync(os.tmpdir()), 'symlink-escape-target-'),
				);
				const linkedSubdir = path.join(root, 'escape-link');
				fs.symlinkSync(elsewhere, linkedSubdir, 'dir');

				try {
					// evil.txt does not exist yet, but its parent (the symlinked
					// subdirectory) does — the nearest-existing-ancestor walk must
					// still resolve that symlink and reject the escape.
					const target = path.join(linkedSubdir, 'evil.txt');
					expect(() => validateSymlinkBoundary(target, root)).toThrow(
						'Symlink resolution escaped boundary',
					);
				} finally {
					fs.unlinkSync(linkedSubdir);
					fs.rmSync(root, { recursive: true });
					fs.rmSync(elsewhere, { recursive: true });
				}
			},
		);
	},
);
