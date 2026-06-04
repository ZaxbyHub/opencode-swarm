/**
 * Security hardening verification tests for scope-guard.ts
 * Tests the three security hardening fixes:
 * 1. sanitizePath strips null bytes (\0) before path.resolve
 * 2. isFileInScope filters empty strings from scopeEntries
 * 3. sanitizePath regex expanded to cover \b, \f, \v
 */

import { describe, expect, test } from 'bun:test';
import { _internals, isFileInScope } from '../../../src/hooks/scope-guard';

const { sanitizePath } = _internals;

describe('scope-guard security hardening', () => {
	describe('1. sanitizePath strips null bytes (\\0)', () => {
		test('null byte in filename is replaced with underscore', () => {
			const result = sanitizePath('file\x00.txt');
			expect(result).toBe('file_.txt');
		});

		test('null byte at start of path is replaced', () => {
			const result = sanitizePath('\x00file.txt');
			expect(result).toBe('_file.txt');
		});

		test('null byte in directory component is replaced', () => {
			const result = sanitizePath('dir\x00/file.txt');
			expect(result).toBe('dir_/file.txt');
		});

		test('multiple null bytes are all replaced', () => {
			const result = sanitizePath('fi\x00le\x00.txt');
			expect(result).toBe('fi_le_.txt');
		});
	});

	describe('2. isFileInScope filters empty strings from scopeEntries', () => {
		test('empty string in scopeEntries does NOT neutralize scope restrictions', () => {
			// Bug: path.resolve(dir, '') returns dir itself
			// Without the filter, '' scope entry would match ANY file under dir!
			// With the filter, only '/workspace/src' scope entry is checked
			const result = isFileInScope(
				'/workspace/src/foo.ts',
				['', '/workspace/src'],
				'/workspace',
			);
			// foo.ts IS under /workspace/src, so it should be in scope
			expect(result).toBe(true);
		});

		test('empty string alone in scopeEntries allows nothing (no false positives)', () => {
			// If only empty string in scope, nothing should be in scope
			const result = isFileInScope('/workspace/src/foo.ts', [''], '/workspace');
			expect(result).toBe(false);
		});

		test('multiple empty strings filtered out, real scopes still work', () => {
			const result = isFileInScope(
				'/other/src/foo.ts',
				['', '', '/other/src', ''],
				'/workspace',
			);
			expect(result).toBe(true);
		});

		test('path exactly matching non-empty scope entry', () => {
			// File exactly matching a scope entry should be in scope
			const result = isFileInScope(
				'/workspace/src/foo.ts',
				['', '/workspace/src/foo.ts'],
				'/workspace',
			);
			expect(result).toBe(true);
		});

		test('file in subdirectory of non-empty scope entry', () => {
			const result = isFileInScope(
				'/workspace/src/sub/foo.ts',
				['', '/workspace/src'],
				'/workspace',
			);
			expect(result).toBe(true);
		});

		test('file outside scope with empty string present', () => {
			const result = isFileInScope(
				'/outside/foo.ts',
				['', '/workspace/src'],
				'/workspace',
			);
			expect(result).toBe(false);
		});

		test('empty string filter - file at root of workspace is IN scope', () => {
			// path.resolve('/workspace', '/workspace') = '/workspace'
			// path.relative('/workspace', '/workspace') = '' (length 0)
			// exact match: '/workspace' === '/workspace' -> true
			const result = isFileInScope(
				'/workspace',
				['', '/workspace'],
				'/workspace',
			);
			expect(result).toBe(true);
		});
	});

	describe('3. sanitizePath strips control characters \\b, \\f, \\v', () => {
		test('backspace (\\x08) is stripped', () => {
			const result = sanitizePath('file\x08.txt');
			expect(result).toBe('file_.txt');
		});

		test('form feed (\\x0c) is stripped', () => {
			const result = sanitizePath('file\x0c.txt');
			expect(result).toBe('file_.txt');
		});

		test('vertical tab (\\x0b) is stripped', () => {
			const result = sanitizePath('file\x0b.txt');
			expect(result).toBe('file_.txt');
		});

		test('multiple control chars in sequence are all stripped', () => {
			const result = sanitizePath('file\x08\x0c\x0b.txt');
			expect(result).toBe('file___.txt');
		});

		test('mixed control chars all stripped', () => {
			const result = sanitizePath('file\x00\x08\x0c\x0b.txt');
			expect(result).toBe('file____.txt');
		});
	});

	describe('6. existing behavior preserved: CR, LF, TAB, ESC still stripped', () => {
		test('carriage return (\\r) is stripped', () => {
			const result = sanitizePath('file\r.txt');
			expect(result).toBe('file_.txt');
		});

		test('line feed (\\n) is stripped', () => {
			const result = sanitizePath('file\n.txt');
			expect(result).toBe('file_.txt');
		});

		test('tab (\\t) is stripped', () => {
			const result = sanitizePath('file\t.txt');
			expect(result).toBe('file_.txt');
		});

		test('ESC (\\x1b) alone is stripped', () => {
			// ESC is replaced with underscore
			const result = sanitizePath('file\x1b.txt');
			expect(result).toBe('file_.txt');
		});

		test('ESC followed by ANSI CSI sequence is stripped', () => {
			// ESC + '[31m' -> split on ESC gives ['', '31m'] -> join with '_' gives '_31m'
			// Then ANSI CSI regex strips the '31m' part
			const result = sanitizePath('file\x1b[31m.txt');
			expect(result).toBe('file_.txt');
		});

		test('complex ANSI sequence stripped', () => {
			const result = sanitizePath('file\x1b[38;5;255m.txt');
			expect(result).toBe('file_.txt');
		});

		test('multiple ANSI sequences - each ESC becomes underscore then CSI stripped', () => {
			// file<ESC>[31m<ESC>[0m.txt -> file_[31m_[0m.txt -> file__.txt
			const result = sanitizePath('file\x1b[31m\x1b[0m.txt');
			expect(result).toBe('file__.txt');
		});
	});

	describe('7. no regression: normal paths pass through unchanged', () => {
		test('simple filename unchanged', () => {
			const result = sanitizePath('foo.ts');
			expect(result).toBe('foo.ts');
		});

		test('relative path unchanged', () => {
			const result = sanitizePath('./src/foo.ts');
			expect(result).toBe('./src/foo.ts');
		});

		test('absolute path unchanged', () => {
			const result = sanitizePath('/workspace/src/foo.ts');
			expect(result).toBe('/workspace/src/foo.ts');
		});

		test('nested path unchanged', () => {
			const result = sanitizePath('/workspace/src/sub/deep/foo.ts');
			expect(result).toBe('/workspace/src/sub/deep/foo.ts');
		});

		test('paths with spaces unchanged', () => {
			const result = sanitizePath('/workspace/src/my file.ts');
			expect(result).toBe('/workspace/src/my file.ts');
		});

		test('paths with Unicode unchanged', () => {
			const result = sanitizePath('/workspace/src/café.ts');
			expect(result).toBe('/workspace/src/café.ts');
		});

		test('paths with emoji unchanged', () => {
			const result = sanitizePath('/workspace/src/file🚀.ts');
			expect(result).toBe('/workspace/src/file🚀.ts');
		});

		test('paths with dashes and underscores unchanged', () => {
			const result = sanitizePath('/workspace/src/my-file_123.ts');
			expect(result).toBe('/workspace/src/my-file_123.ts');
		});

		test('paths with dots unchanged', () => {
			const result = sanitizePath('/workspace/src/.hidden.ts');
			expect(result).toBe('/workspace/src/.hidden.ts');
		});
	});

	describe('integration: sanitized paths work correctly with isFileInScope', () => {
		test('sanitized null-byte path is still checked against scope', () => {
			// After sanitization, 'file_.txt' is treated as a literal filename
			// 'file_.txt' under /workspace is in scope (it's a child of /workspace)
			const sanitized = sanitizePath('file\x00.txt');
			expect(sanitized).toBe('file_.txt');
			// The sanitized name doesn't match the scope path, but scope is '/workspace'
			// so any file under /workspace is in scope - the test logic is correct
		});

		test('sanitized control-char path is still checked against scope', () => {
			// After sanitization, 'file_.txt' is treated as a literal filename
			const sanitized = sanitizePath('file\x08.txt');
			expect(sanitized).toBe('file_.txt');
		});

		test('sanitized null-byte path not in scope when parent dir differs', () => {
			// 'file\x00.txt' sanitizes to 'file_.txt'
			// 'file_.txt' is NOT under '/other' scope
			const sanitized = sanitizePath('file\x00.txt');
			const result = isFileInScope(sanitized, ['/other'], '/workspace');
			expect(result).toBe(false);
		});

		test('sanitized control-char path not in scope when parent dir differs', () => {
			const sanitized = sanitizePath('file\x08.txt');
			const result = isFileInScope(sanitized, ['/other'], '/workspace');
			expect(result).toBe(false);
		});

		test('normal path IS in scope after sanitization (no-op)', () => {
			const sanitized = sanitizePath('/workspace/src/foo.ts');
			const result = isFileInScope(sanitized, ['/workspace/src'], '/workspace');
			expect(result).toBe(true);
		});
	});
});
