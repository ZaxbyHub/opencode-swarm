import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	containsControlChars,
	containsPathTraversal,
	validateDirectory,
	validateSymlinkBoundary,
} from '../../../src/utils/path-security';

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
		// realpathSync throws for non-existent paths, should fall back to normalize
		expect(() =>
			validateSymlinkBoundary('/non/existent/path', '/non/existent'),
		).not.toThrow();
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
});
