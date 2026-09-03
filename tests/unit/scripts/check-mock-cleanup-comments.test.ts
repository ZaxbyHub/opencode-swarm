import { describe, expect, test } from 'bun:test';
import {
	assessMockFile,
	stripCommentsPreservingLines,
} from '../../../scripts/check-mock-cleanup';

describe('check-mock-cleanup comment awareness — issue #2267', () => {
	test('ignores line and block comments for cleanup and node spread checks', () => {
		const source = [
			"// mock.module('node:fs', () => ({}));",
			'/*',
			"mock.module('node:path', () => ({}));",
			'*/',
		].join('\n');
		expect(assessMockFile(source)).toEqual({
			missingCleanup: false,
			spreadViolations: [],
			delegationViolations: [],
		});
	});

	test('strips inline comments but preserves adjacent live code and line numbers', () => {
		const source = [
			"const url = 'https://example.test/a//b';",
			"/* mock.module('node:path', () => ({})); */",
			"mock.module('node:fs', () => ({})); // live violation above",
		].join('\n');
		const result = assessMockFile(source);
		expect(result.missingCleanup).toBe(true);
		expect(result.spreadViolations).toEqual([
			{ module: 'fs', line: 3, spreadVar: 'realFs' },
		]);
	});

	test('preserves comment tokens inside strings, templates, and regex literals', () => {
		const source = [
			"const a = '/* not a comment */';",
			'const b = `// not a comment`;',
			'const c = /\\/\\/|\\/\\*/;',
		].join('\n');
		expect(stripCommentsPreservingLines(source)).toBe(source);
		expect(assessMockFile(source)).toEqual({
			missingCleanup: false,
			spreadViolations: [],
			delegationViolations: [],
		});
	});
});
