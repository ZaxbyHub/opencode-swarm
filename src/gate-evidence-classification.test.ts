import { describe, expect, test } from 'bun:test';
import {
	isExactMarkdownPath,
	isMarkdownOnlyDeclaredScope,
	isMarkdownOnlyTaskChange,
} from './gate-evidence-classification';

describe('doc-only gate classification', () => {
	test.each([
		'README.md',
		'docs/guide.md',
		'docs\\windows.md',
		'src/example.ts.md',
	])('accepts exact final .md path %s', (candidate) => {
		expect(isExactMarkdownPath(candidate)).toBe(true);
	});

	test.each([
		'',
		'.md',
		'README.MD',
		'README.Md',
		'README.md ',
		'README.md.exe',
		'docs.md/file.ts',
		'README.md:evil.ts',
		'../README.md',
		'./README.md',
		'/tmp/README.md',
		'C:\\tmp\\README.md',
		'README.md\0.ts',
	])('rejects non-exact or unsafe path %s', (candidate) => {
		expect(isExactMarkdownPath(candidate)).toBe(false);
	});

	test('requires independent non-empty declared and observed proof', () => {
		expect(
			isMarkdownOnlyTaskChange(['README.md', 'docs/guide.md'], ['README.md']),
		).toBe(true);
		expect(isMarkdownOnlyTaskChange([], ['README.md'])).toBe(false);
		expect(isMarkdownOnlyTaskChange(['README.md'], [])).toBe(false);
		expect(isMarkdownOnlyTaskChange(['README.md'], ['src/code.ts'])).toBe(
			false,
		);
		expect(
			isMarkdownOnlyTaskChange(['README.md', 'src/code.ts'], ['README.md']),
		).toBe(false);
		expect(
			isMarkdownOnlyTaskChange(['README.md'], ['README.md', 'docs/extra.md']),
		).toBe(false);
	});

	test('cheap declared-scope pre-classification rejects ineligible tasks', () => {
		expect(isMarkdownOnlyDeclaredScope(['README.md', 'docs/guide.md'])).toBe(
			true,
		);
		expect(isMarkdownOnlyDeclaredScope([])).toBe(false);
		expect(isMarkdownOnlyDeclaredScope(['README.md', 'src/code.ts'])).toBe(
			false,
		);
		expect(isMarkdownOnlyDeclaredScope(null)).toBe(false);
	});

	test('fails closed for malformed runtime values', () => {
		expect(isMarkdownOnlyTaskChange(null, ['README.md'])).toBe(false);
		expect(isMarkdownOnlyTaskChange(['README.md'], 'README.md')).toBe(false);
		expect(isMarkdownOnlyTaskChange(['README.md'], [42])).toBe(false);
	});
});
