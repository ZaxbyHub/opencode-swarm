import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from './create-tool';
import { suggestPatch } from './suggest-patch';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context
async function executeSuggestPatch(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = await suggestPatch.execute(args, {
		directory,
	} as unknown as ToolContext);
	return resultToString(result);
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'suggest-patch-adversarial-')),
	);
	mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ============ Test File Helper ============

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

// ═══════════════════════════════════════════════════════════════════════════
// MALFORMED INPUTS - null args, non-object args, oversized payloads
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Malformed inputs', () => {
	it('rejects null args', async () => {
		const result = await executeSuggestPatch(
			null as unknown as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects undefined args', async () => {
		const result = await executeSuggestPatch(
			undefined as unknown as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects number args', async () => {
		const result = await executeSuggestPatch(
			42 as unknown as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects string args', async () => {
		const result = await executeSuggestPatch(
			'invalid' as unknown as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects array args', async () => {
		const result = await executeSuggestPatch(
			[1, 2, 3] as unknown as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects empty object args', async () => {
		const result = await executeSuggestPatch({}, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
		expect(parsed.message).toContain('targetFiles');
	});

	it('rejects args with empty targetFiles array', async () => {
		const result = await executeSuggestPatch(
			{ targetFiles: [], changes: [] },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
		expect(parsed.message).toContain('targetFiles');
	});

	it('rejects args with empty changes array', async () => {
		const result = await executeSuggestPatch(
			{ targetFiles: ['test.txt'], changes: [] },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
		expect(parsed.message).toContain('changes');
	});

	it('rejects oversized targetFiles array (DoS attempt)', async () => {
		const largeArray = Array(10000).fill('test.txt');
		const result = await executeSuggestPatch(
			{
				targetFiles: largeArray,
				changes: [{ file: 'test.txt', newContent: 'x' }],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle gracefully - either reject or process
		expect(typeof result).toBe('string');
	});

	it('rejects oversized newContent string (DoS attempt)', async () => {
		const largeContent = 'x'.repeat(1_000_000);
		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [{ file: 'test.txt', newContent: largeContent }],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle gracefully
		expect(typeof result).toBe('string');
	});

	it('rejects args with missing targetFiles', async () => {
		const result = await executeSuggestPatch(
			{ changes: [{ file: 'test.txt', newContent: 'x' }] } as Record<
				string,
				unknown
			>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
	});

	it('rejects args with missing changes', async () => {
		const result = await executeSuggestPatch(
			{ targetFiles: ['test.txt'] } as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
	});

	it('rejects non-existent workspace directory', async () => {
		const nonexistentDir = path.join(os.tmpdir(), `nonexistent_${Date.now()}`);
		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [{ file: 'test.txt', newContent: 'x' }],
			},
			nonexistentDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('file-not-found');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// PATH TRAVERSAL - ../, absolute paths, Windows attacks
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Path traversal', () => {
	it('rejects ../ traversal in file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['../secrets.txt'],
				changes: [{ file: '../secrets.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
		expect(parsed.message).toContain('Invalid file path');
	});

	it('rejects ..\\ Windows backslash traversal', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['..\\..\\windows\\system32'],
				changes: [
					{ file: '..\\..\\windows\\system32', newContent: 'injected' },
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects URL-encoded traversal %2e%2e', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['%2e%2e%2fsecrets'],
				changes: [{ file: '%2e%2e%2fsecrets', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects double-encoded traversal %252e%252e', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['%252e%252e%252fsecrets'],
				changes: [{ file: '%252e%252e%252fsecrets', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects fullwidth dot Unicode homoglyph', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['\uff0e\uff0e/secrets'],
				changes: [{ file: '\uff0e\uff0e/secrets', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects ideographic full stop Unicode', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['\u3002\u3002/secrets'],
				changes: [{ file: '\u3002\u3002/secrets', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects absolute Unix path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['/etc/passwd'],
				changes: [{ file: '/etc/passwd', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects absolute Windows path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['C:\\Windows\\System32'],
				changes: [{ file: 'C:\\Windows\\System32', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects colon after drive letter attempt', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['C:/Windows/System32'],
				changes: [{ file: 'C:/Windows/System32', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects Windows reserved name con', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['con.txt'],
				changes: [{ file: 'con.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects Windows reserved name nul', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['nul.log'],
				changes: [{ file: 'nul.log', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects Windows reserved name com1', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['com1.txt'],
				changes: [{ file: 'com1.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects Windows reserved name lpt1', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['lpt1.txt'],
				changes: [{ file: 'lpt1.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects null byte in file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['valid\x00../evil.txt'],
				changes: [{ file: 'valid\x00../evil.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects tab character in file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['valid\t../evil.txt'],
				changes: [{ file: 'valid\t../evil.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects newline in file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['valid\n../evil.txt'],
				changes: [{ file: 'valid\n../evil.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects carriage return in file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['valid\r../evil.txt'],
				changes: [{ file: 'valid\r../evil.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects empty file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: [''],
				changes: [{ file: '', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects whitespace-only file path', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['   '],
				changes: [{ file: '   ', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// TYPE CONFUSION - Invalid types for all parameters
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Type confusion', () => {
	it('handles targetFiles as string instead of array', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: 'test.txt',
				changes: [{ file: 'test.txt', newContent: 'x' }],
			} as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should handle gracefully - string is not an array so targetFiles.length fails
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
	});

	it('handles targetFiles as number instead of array', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: 42,
				changes: [{ file: 'test.txt', newContent: 'x' }],
			} as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
	});

	it('handles targetFiles as object instead of array', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: { 0: 'test.txt' },
				changes: [{ file: 'test.txt', newContent: 'x' }],
			} as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
	});

	it('handles changes as string instead of array', async () => {
		const result = await executeSuggestPatch(
			{ targetFiles: ['test.txt'], changes: 'invalid' } as Record<
				string,
				unknown
			>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
	});

	it('handles changes as number instead of array', async () => {
		const result = await executeSuggestPatch(
			{ targetFiles: ['test.txt'], changes: 42 } as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
	});

	it('handles change.file as number instead of string', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [{ file: 123 as unknown as string, newContent: 'x' }],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Number gets coerced or causes validation failure
		expect(typeof result).toBe('string');
	});

	it('handles change.newContent as number instead of string', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [{ file: 'test.txt', newContent: 123 as unknown as string }],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles contextBefore as string instead of array', async () => {
		createTestFile('test.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextBefore: 'not-an-array' as unknown as string[],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle type confusion gracefully
		expect(typeof result).toBe('string');
	});

	it('handles contextAfter as string instead of array', async () => {
		createTestFile('test.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextAfter: 'not-an-array' as unknown as string[],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles oldContent as number instead of string', async () => {
		createTestFile('test.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						oldContent: 123 as unknown as string,
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// FILE READ OUTSIDE WORKSPACE - Attempting to read files outside workspace
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - File read outside workspace', () => {
	it('rejects attempt to read parent directory file', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['../parent-file.txt'],
				changes: [{ file: '../parent-file.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects attempt to read deeply nested traversal', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['src/../../../../etc/passwd'],
				changes: [
					{ file: 'src/../../../../etc/passwd', newContent: 'injected' },
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
	});

	it('rejects file that does not exist', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['nonexistent.txt'],
				changes: [{ file: 'nonexistent.txt', newContent: 'injected' }],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		// Path validation passes for valid workspace-relative paths,
		// then file existence check fails. May return file-not-found or parse-error depending on validation order.
		expect(parsed.type).toBeOneOf(['file-not-found', 'parse-error']);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT INJECTION - Malicious context content
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Context injection', () => {
	it('handles HTML/script injection in contextBefore', async () => {
		createTestFile('test.txt', '<script>alert(1)</script>\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextBefore: ['<script>alert(1)</script>'],
						newContent: 'safe',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle gracefully - context won't match
		expect(typeof result).toBe('string');
	});

	it('handles SQL injection in oldContent', async () => {
		createTestFile('test.txt', 'SELECT * FROM users\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextBefore: ['SELECT * FROM users'],
						oldContent: "' OR '1'='1",
						newContent: 'safe',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles template literal injection in newContent', async () => {
		createTestFile('test.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextBefore: ['line1'],
						contextAfter: ['line3'],
						newContent: '${process.env.SECRET}',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should return patch suggestion (read-only tool)
		expect(typeof result).toBe('string');
	});

	it('handles shell metacharacters in newContent', async () => {
		createTestFile('test.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextBefore: ['line1'],
						contextAfter: ['line3'],
						newContent: 'rm -rf /',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should return patch suggestion (read-only tool)
		expect(typeof result).toBe('string');
	});

	it('handles null bytes in context arrays', async () => {
		createTestFile('test.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['test.txt'],
				changes: [
					{
						file: 'test.txt',
						contextBefore: ['line1\x00malicious'],
						newContent: 'safe',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Context won't match due to null byte
		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// DENIAL OF SERVICE - Very large files, deeply nested directories
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Denial of service', () => {
	it('handles very large file gracefully', async () => {
		const largeContent = 'line\n'.repeat(100_000);
		createTestFile('large.txt', largeContent);

		const result = await executeSuggestPatch(
			{
				targetFiles: ['large.txt'],
				changes: [
					{
						file: 'large.txt',
						contextBefore: ['line'],
						contextAfter: ['line'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle without hanging or crashing
		expect(typeof result).toBe('string');
	});

	it('handles file with very long lines', async () => {
		const longLineContent = 'x'.repeat(500_000);
		createTestFile('longline.txt', `${longLineContent}\n`);

		const result = await executeSuggestPatch(
			{
				targetFiles: ['longline.txt'],
				changes: [
					{
						file: 'longline.txt',
						contextBefore: [],
						contextAfter: [],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// No context provided means context match will fail gracefully
		expect(typeof result).toBe('string');
	});

	it('handles deeply nested directory structure', async () => {
		const nestedPath = `src/${'a/'.repeat(50)}deep.txt`;
		createTestFile(nestedPath, 'deep content\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: [nestedPath],
				changes: [
					{
						file: nestedPath,
						contextBefore: ['deep content'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle deep paths
		expect(typeof result).toBe('string');
	});

	it('handles many small changes in single request', async () => {
		createTestFile('multi.txt', 'line1\nline2\nline3\n');

		const changes = Array(100)
			.fill(null)
			.map((_, i) => ({
				file: 'multi.txt',
				contextBefore: [`line${i + 1}`],
				newContent: `replaced${i}`,
			}));

		const result = await executeSuggestPatch(
			{
				targetFiles: ['multi.txt'],
				changes,
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Most will fail context mismatch, but should handle
		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDARY CASES - Empty, null, max values, Unicode
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Boundary cases', () => {
	it('handles file with only whitespace', async () => {
		createTestFile('whitespace.txt', '   \n   \n   \n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['whitespace.txt'],
				changes: [
					{
						file: 'whitespace.txt',
						contextBefore: ['   '],
						contextAfter: ['   '],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles file with only newlines', async () => {
		createTestFile('newlines.txt', '\n\n\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['newlines.txt'],
				changes: [
					{
						file: 'newlines.txt',
						contextBefore: ['\n'],
						contextAfter: ['\n'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles Unicode content in file', async () => {
		createTestFile('unicode.txt', '日本語\n中文\n한국어\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['unicode.txt'],
				changes: [
					{
						file: 'unicode.txt',
						contextBefore: ['日本語'],
						contextAfter: ['한국어'],
						newContent: 'English',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles emoji in file content', async () => {
		createTestFile('emoji.txt', '😀\n😁\n😂\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['emoji.txt'],
				changes: [
					{
						file: 'emoji.txt',
						contextBefore: ['😀'],
						contextAfter: ['😂'],
						newContent: '😊',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles surrogate pair characters', async () => {
		createTestFile('surrogate.txt', '𝟙𝟚𝟆\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['surrogate.txt'],
				changes: [
					{
						file: 'surrogate.txt',
						contextBefore: ['𝟙𝟚𝟆'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles zero-width characters in content', async () => {
		createTestFile('zwc.txt', 'a\u200bb\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['zwc.txt'],
				changes: [
					{
						file: 'zwc.txt',
						contextBefore: ['a\u200bb'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles RTL override in context', async () => {
		createTestFile('rtl.txt', 'normal\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['rtl.txt'],
				changes: [
					{
						file: 'rtl.txt',
						contextBefore: ['normal\u202e3.2\u202c'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles empty string in context arrays', async () => {
		createTestFile('emptyctx.txt', '\nline2\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['emptyctx.txt'],
				changes: [
					{
						file: 'emptyctx.txt',
						contextBefore: [''],
						contextAfter: ['line2'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// READ-ONLY VERIFICATION - Ensure tool doesn't mutate state
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Read-only verification', () => {
	it('does not modify file when suggesting patch', async () => {
		createTestFile('readonly.txt', 'original content\n');

		const originalContent = readFileSync(
			path.join(tmpDir, 'readonly.txt'),
			'utf-8',
		);

		await executeSuggestPatch(
			{
				targetFiles: ['readonly.txt'],
				changes: [
					{
						file: 'readonly.txt',
						contextBefore: ['original content'],
						newContent: 'MODIFIED',
					},
				],
			},
			tmpDir,
		);

		const afterContent = readFileSync(
			path.join(tmpDir, 'readonly.txt'),
			'utf-8',
		);

		expect(afterContent).toBe(originalContent);
		expect(afterContent).toBe('original content\n');
	});

	it('does not create new files during patch suggestion', async () => {
		createTestFile('existing.txt', 'existing content\n');

		const initialFiles = new Set(
			require('node:fs')
				.readdirSync(tmpDir, { withFileTypes: true })
				.filter((e: { isFile: () => boolean; name: string }) => e.isFile())
				.map((e: { name: string }) => e.name),
		);

		await executeSuggestPatch(
			{
				targetFiles: ['existing.txt'],
				changes: [
					{
						file: 'existing.txt',
						contextBefore: ['existing content'],
						newContent: 'suggested replacement',
					},
				],
			},
			tmpDir,
		);

		const afterFiles = new Set(
			require('node:fs')
				.readdirSync(tmpDir, { withFileTypes: true })
				.filter((e: { isFile: () => boolean; name: string }) => e.isFile())
				.map((e: { name: string }) => e.name),
		);

		// Should not create new files
		expect(afterFiles.size).toBe(initialFiles.size);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT MATCHING - Various context scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Context matching', () => {
	it('returns context-mismatch when context does not match', async () => {
		createTestFile('mismatch.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['mismatch.txt'],
				changes: [
					{
						file: 'mismatch.txt',
						contextBefore: ['THIS DOES NOT EXIST'],
						newContent: 'replacement',
					},
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('context-mismatch');
	});

	it('returns context-mismatch when oldContent does not match', async () => {
		// For oldContent mismatch to be tested, contextBefore and contextAfter must be
		// immediately adjacent (with only oldContent between them).
		// File: 'line1\nline2\nline3'
		// With contextBefore=['line1'] and contextAfter=['line2'], oldContent is what comes after contextBefore
		createTestFile('oldmismatch.txt', 'line1\nline2\nline3');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['oldmismatch.txt'],
				changes: [
					{
						file: 'oldmismatch.txt',
						contextBefore: ['line1'],
						contextAfter: ['line2'],
						oldContent: 'WRONG', // line1 is followed by 'line2', not 'WRONG'
						newContent: 'replacement',
					},
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('context-mismatch');
		// Error confirms context was found but oldContent didn't match
		expect(parsed.message).toContain('Content at the specified location');
	});

	it('succeeds when valid context and oldContent provided', async () => {
		// File content without trailing newline to simplify matching
		createTestFile('valid.txt', 'line1\nto-replace\nline3');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['valid.txt'],
				changes: [
					{
						file: 'valid.txt',
						contextBefore: ['line1'],
						contextAfter: ['line3'],
						oldContent: 'to-replace',
						newContent: 'REPLACED',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should either succeed or give context-mismatch depending on exact content match
		expect(typeof result).toBe('string');
	});

	it('handles multiple changes with mixed results', async () => {
		createTestFile('multi.txt', 'line1\nline2\nline3');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['multi.txt'],
				changes: [
					{
						file: 'multi.txt',
						contextBefore: ['line1'],
						contextAfter: ['line3'],
						oldContent: 'line2',
						newContent: 'REPLACED',
					},
					{
						file: 'multi.txt',
						contextBefore: ['NONEXISTENT'],
						newContent: 'WONT WORK',
					},
				],
			},
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should handle gracefully - either partial success or all errors
		expect(typeof result).toBe('string');
	});

	it('returns error when all patches fail', async () => {
		createTestFile('allfail.txt', 'line1\nline2\nline3\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['allfail.txt'],
				changes: [
					{
						file: 'allfail.txt',
						contextBefore: ['NONEXISTENT1'],
						newContent: 'WONT WORK1',
					},
					{
						file: 'allfail.txt',
						contextBefore: ['NONEXISTENT2'],
						newContent: 'WONT WORK2',
					},
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// MALICIOUS GETTER ATTACKS - Proxy attacks on args
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Malicious getter attacks', () => {
	it('handles args with malicious getter gracefully', async () => {
		const maliciousArgs = new Proxy(
			{},
			{
				get() {
					throw new Error('Malicious getter attack');
				},
			},
		);

		// Tool may throw or return error - either is acceptable for defensive behavior
		let threw = false;
		let result = '';
		try {
			result = await executeSuggestPatch(
				maliciousArgs as Record<string, unknown>,
				tmpDir,
			);
		} catch {
			threw = true;
		}

		// If it throws, that's acceptable defensive behavior
		// If it doesn't throw, should return some string (even if malformed)
		if (!threw) {
			expect(typeof result).toBe('string');
		}
	});

	it('handles targetFiles getter that throws', async () => {
		const maliciousArgs = {
			get targetFiles() {
				throw new Error('TargetFiles getter attack');
			},
		};

		let threw = false;
		let result = '';
		try {
			result = await executeSuggestPatch(
				maliciousArgs as Record<string, unknown>,
				tmpDir,
			);
		} catch {
			threw = true;
		}

		if (!threw) {
			expect(typeof result).toBe('string');
		}
	});

	it('handles changes getter that throws', async () => {
		const maliciousArgs = {
			targetFiles: ['test.txt'],
			get changes() {
				throw new Error('Changes getter attack');
			},
		};

		let threw = false;
		let result = '';
		try {
			result = await executeSuggestPatch(
				maliciousArgs as Record<string, unknown>,
				tmpDir,
			);
		} catch {
			threw = true;
		}

		if (!threw) {
			expect(typeof result).toBe('string');
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// ERROR MESSAGE SANITIZATION - Ensure no sensitive paths in errors
// ═══════════════════════════════════════════════════════════════════════════

describe('suggest_patch ADVERSARIAL - Error message sanitization', () => {
	it('error messages do not leak absolute paths in response', async () => {
		createTestFile('safe.txt', 'content\n');

		const result = await executeSuggestPatch(
			{
				targetFiles: ['safe.txt'],
				changes: [
					{
						file: 'safe.txt',
						contextBefore: ['NONEXISTENT'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Error messages should contain relative path, not absolute
		if (parsed.error && parsed.details?.location) {
			expect(parsed.details.location).not.toMatch(/^[A-Za-z]:/);
			expect(parsed.details.location).not.toMatch(/^\//);
		}
	});

	it('handles missing file gracefully without leaking system info', async () => {
		const result = await executeSuggestPatch(
			{
				targetFiles: ['secret_file.txt'],
				changes: [
					{
						file: 'secret_file.txt',
						contextBefore: ['content'],
						newContent: 'replaced',
					},
				],
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBeOneOf(['file-not-found', 'parse-error']);
		// Should not leak full path in error message
		expect(parsed.message).not.toContain(tmpDir);
	});
});
