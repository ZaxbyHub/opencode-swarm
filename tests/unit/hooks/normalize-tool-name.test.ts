import { describe, expect, test } from 'bun:test';
import {
	normalizeToolName,
	normalizeToolNameLowerCase,
} from '../../../src/hooks/normalize-tool-name';

describe('normalizeToolName', () => {
	describe('normalizes legacy tool names to canonical form', () => {
		test('strips colon-delimited namespace prefix', () => {
			expect(normalizeToolName('opencode:write')).toBe('write');
			expect(normalizeToolName('mega:write')).toBe('write');
			expect(normalizeToolName('swarms:bash')).toBe('bash');
		});

		test('strips dot-delimited namespace prefix', () => {
			expect(normalizeToolName('opencode.bash')).toBe('bash');
			expect(normalizeToolName('mega.search')).toBe('search');
			expect(normalizeToolName('swarms.read')).toBe('read');
		});

		test('strips only the first namespace segment and its separator', () => {
			// Pattern /^[^:]+[:.]/ matches "segment:" or "segment." at the start only
			expect(normalizeToolName('mega:tool:action')).toBe('tool:action');
			expect(normalizeToolName('opencode.my.tool')).toBe('tool');
		});
	});

	describe('preserves already-canonical names', () => {
		test('returns plain tool names unchanged', () => {
			expect(normalizeToolName('write')).toBe('write');
			expect(normalizeToolName('bash')).toBe('bash');
			expect(normalizeToolName('read')).toBe('read');
		});

		test('returns canonical names with separators after first segment unchanged', () => {
			// After stripping the leading segment, the remainder is returned as-is
			expect(normalizeToolName('tool:action')).toBe('action');
			expect(normalizeToolName('my.tool.name')).toBe('name');
		});
	});

	describe('handles unknown tool names per fallback policy', () => {
		test('returns undefined for undefined input', () => {
			expect(normalizeToolName(undefined)).toBeUndefined();
		});

		test('returns undefined for null input', () => {
			expect(normalizeToolName(null)).toBeUndefined();
		});

		test('returns undefined for empty string input (falsy)', () => {
			// Empty string is falsy, so !toolName is true → returns undefined
			expect(normalizeToolName('')).toBeUndefined();
		});

		test('returns names with no separator unchanged', () => {
			expect(normalizeToolName('unknowntool')).toBe('unknowntool');
		});
	});
});

describe('normalizeToolNameLowerCase', () => {
	describe('normalizes legacy tool names to canonical lowercase form', () => {
		test('strips colon-delimited namespace prefix and lowercases', () => {
			expect(normalizeToolNameLowerCase('opencode:WRITE')).toBe('write');
			expect(normalizeToolNameLowerCase('mega:Write')).toBe('write');
			expect(normalizeToolNameLowerCase('SWARMS:BASH')).toBe('bash');
		});

		test('strips dot-delimited namespace prefix and lowercases', () => {
			expect(normalizeToolNameLowerCase('opencode.BASH')).toBe('bash');
			expect(normalizeToolNameLowerCase('mega.Search')).toBe('search');
			expect(normalizeToolNameLowerCase('SWARMS.READ')).toBe('read');
		});

		test('handles mixed-case namespace prefixes', () => {
			expect(normalizeToolNameLowerCase('Mega:Tool')).toBe('tool');
			expect(normalizeToolNameLowerCase('OpenCode.MyTool')).toBe('mytool');
		});
	});

	describe('preserves already-canonical lowercase names', () => {
		test('returns plain tool names in lowercase', () => {
			expect(normalizeToolNameLowerCase('write')).toBe('write');
			expect(normalizeToolNameLowerCase('bash')).toBe('bash');
		});

		test('lowercases already-canonical names', () => {
			expect(normalizeToolNameLowerCase('WRITE')).toBe('write');
			expect(normalizeToolNameLowerCase('Bash')).toBe('bash');
		});
	});

	describe('handles unknown tool names per fallback policy', () => {
		test('handles names with no namespace separator', () => {
			expect(normalizeToolNameLowerCase('unknowntool')).toBe('unknowntool');
			expect(normalizeToolNameLowerCase('UNKNOWNTOOL')).toBe('unknowntool');
		});

		test('handles multi-segment names', () => {
			// Pattern /^[^:]+[:.]/ greedily matches "segment." or "segment:" at the start
			expect(normalizeToolNameLowerCase('mega:tool:action')).toBe(
				'tool:action',
			);
			expect(normalizeToolNameLowerCase('opencode.my.tool')).toBe('tool');
		});
	});
});
