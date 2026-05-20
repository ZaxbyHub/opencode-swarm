import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from './create-tool';
import { suggestPatch } from './suggest-patch';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

describe('suggest-patch tool', () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'suggest-patch-test-'),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	async function callTool(args: Record<string, unknown>): Promise<string> {
		const result = await suggestPatch.execute(args, {
			directory: workspaceDir,
		} as unknown as ToolContext);
		return resultToString(result);
	}

	function createFile(relativePath: string, content: string): void {
		const fullPath = path.join(workspaceDir, relativePath);
		const dir = path.dirname(fullPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(fullPath, content, 'utf-8');
	}

	describe('single hunk suggestions', () => {
		test('replace single line content', async () => {
			createFile('example.txt', 'A\nB\nC');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'NEW',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches.length).toBe(1);
			expect(parsed.patches[0].newContent).toBe('NEW');
			expect(parsed.filesModified).toEqual(['example.txt']);
		});

		test('replace last line with append pattern', async () => {
			createFile('example.txt', 'A\nB\nOLD');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						contextBefore: ['A', 'B'],
						oldContent: 'OLD',
						newContent: 'NEW',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches[0].newContent).toBe('NEW');
		});
	});

	describe('multi-hunk suggestions', () => {
		test('multiple changes in same file', async () => {
			createFile('multi.txt', 'A\nB\nC\nD\nE');

			const result = await callTool({
				targetFiles: ['multi.txt'],
				changes: [
					{
						file: 'multi.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'X',
					},
					{
						file: 'multi.txt',
						contextBefore: ['C'],
						contextAfter: ['D'],
						oldContent: 'D',
						newContent: 'Y',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches.length).toBe(2);
			expect(parsed.filesModified).toEqual(['multi.txt']);
		});

		test('changes across multiple files', async () => {
			createFile('file1.txt', 'A\nB');
			createFile('file2.txt', 'C\nD');

			const result = await callTool({
				targetFiles: ['file1.txt', 'file2.txt'],
				changes: [
					{
						file: 'file1.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'X',
					},
					{
						file: 'file2.txt',
						contextBefore: ['C'],
						contextAfter: ['D'],
						oldContent: 'D',
						newContent: 'Y',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches.length).toBe(2);
			expect(parsed.filesModified).toEqual(['file1.txt', 'file2.txt']);
		});
	});

	describe('context mismatch errors', () => {
		test('context anchor not found in file', async () => {
			createFile('example.txt', 'A\nB\nC');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						contextBefore: ['nonexistent'],
						contextAfter: ['C'],
						oldContent: 'B',
						newContent: 'new content',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe(true);
			expect(parsed.type).toBe('context-mismatch');
			expect(parsed.message).toContain('Could not find context anchor');
		});

		test('oldContent does not match content at location', async () => {
			createFile('example.txt', 'header\nactual content\nfooter');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						contextBefore: ['header'],
						contextAfter: ['actual content', 'footer'],
						oldContent: 'wrong content',
						newContent: 'correct content',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('context-mismatch');
			expect(parsed.details.expected).toBe('wrong content');
			expect(parsed.details.actual).toBe('actual content');
		});

		test('nonexistent file returns parse-error', async () => {
			const result = await callTool({
				targetFiles: ['nonexistent.txt'],
				changes: [
					{
						file: 'nonexistent.txt',
						contextBefore: ['some'],
						contextAfter: ['context'],
						oldContent: 'some',
						newContent: 'new content',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('file-not-found');
		});

		test('no context provided returns context-mismatch', async () => {
			createFile('example.txt', 'some content');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						newContent: 'new content',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('context-mismatch');
		});
	});

	describe('no file mutation verification', () => {
		test('file content unchanged after suggestion', async () => {
			const originalContent = 'A\nB\nC';
			createFile('immutable.txt', originalContent);

			await callTool({
				targetFiles: ['immutable.txt'],
				changes: [
					{
						file: 'immutable.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'REPLACED',
					},
				],
			});

			const afterContent = fs.readFileSync(
				path.join(workspaceDir, 'immutable.txt'),
				'utf-8',
			);
			expect(afterContent).toBe(originalContent);
		});

		test('file mtime unchanged after suggestion', async () => {
			createFile('perm.txt', 'A\nB');

			const beforeStat = fs.statSync(path.join(workspaceDir, 'perm.txt'));

			await callTool({
				targetFiles: ['perm.txt'],
				changes: [
					{
						file: 'perm.txt',
						contextBefore: ['A', 'B'],
						oldContent: 'B',
						newContent: 'new',
					},
				],
			});

			const afterStat = fs.statSync(path.join(workspaceDir, 'perm.txt'));
			expect(afterStat.mtime.getTime()).toBe(beforeStat.mtime.getTime());
		});
	});

	describe('path escape attempts blocked', () => {
		test('path traversal with ../ blocked', async () => {
			createFile('safe.txt', 'content');

			const result = await callTool({
				targetFiles: ['../escape.txt'],
				changes: [
					{
						file: '../escape.txt',
						contextBefore: ['something'],
						contextAfter: ['here'],
						oldContent: 'something',
						newContent: 'malicious',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
			expect(parsed.message).toContain('Invalid file path');
		});

		test('absolute path blocked', async () => {
			const result = await callTool({
				targetFiles: ['/etc/passwd'],
				changes: [
					{
						file: '/etc/passwd',
						contextBefore: ['root'],
						oldContent: 'root',
						newContent: 'hacked',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});

		test('Windows path traversal blocked', async () => {
			createFile('safe.txt', 'content');

			const result = await callTool({
				targetFiles: ['..\\windows\\escape.txt'],
				changes: [
					{
						file: '..\\windows\\escape.txt',
						contextBefore: ['x'],
						contextAfter: ['y'],
						oldContent: 'x',
						newContent: 'malicious',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});

		test('control characters in path blocked', async () => {
			const result = await callTool({
				targetFiles: ['file\twith\0null.txt'],
				changes: [
					{
						file: 'file\twith\0null.txt',
						contextBefore: ['x'],
						contextAfter: ['y'],
						oldContent: 'x',
						newContent: 'bad',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});

		test('URL-encoded path traversal blocked', async () => {
			const result = await callTool({
				targetFiles: ['..%2f..%2fescape.txt'],
				changes: [
					{
						file: '..%2f..%2fescape.txt',
						contextBefore: ['x'],
						contextAfter: ['y'],
						oldContent: 'x',
						newContent: 'malicious',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});

		test('Unicode path traversal blocked (fullwidth dot)', async () => {
			const result = await callTool({
				targetFiles: ['\uff0e\uff0e/escape.txt'],
				changes: [
					{
						file: '\uff0e\uff0e/escape.txt',
						contextBefore: ['x'],
						contextAfter: ['y'],
						oldContent: 'x',
						newContent: 'malicious',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});
	});

	describe('partial failure reporting', () => {
		test('some patches succeed, some fail', async () => {
			createFile('good.txt', 'A\nB\nC');

			const result = await callTool({
				targetFiles: ['good.txt', 'bad.txt'],
				changes: [
					{
						file: 'good.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'REPLACED',
					},
					{
						file: 'bad.txt',
						contextBefore: ['nonexistent'],
						contextAfter: ['context'],
						oldContent: 'nonexistent',
						newContent: 'new content',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches.length).toBe(1);
			expect(parsed.filesModified).toEqual(['good.txt']);
			expect(parsed.errors).toBeDefined();
			expect(parsed.errors.length).toBe(1);
			expect(parsed.errors[0].type).toBe('file-not-found');
		});

		test('all patches fail returns error structure', async () => {
			const result = await callTool({
				targetFiles: ['missing1.txt', 'missing2.txt'],
				changes: [
					{
						file: 'missing1.txt',
						contextBefore: ['x'],
						contextAfter: ['y'],
						oldContent: 'x',
						newContent: 'new',
					},
					{
						file: 'missing2.txt',
						contextBefore: ['a'],
						contextAfter: ['b'],
						oldContent: 'a',
						newContent: 'content',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe(true);
		});
	});

	describe('argument validation', () => {
		test('empty targetFiles returns parse-error', async () => {
			const result = await callTool({
				targetFiles: [],
				changes: [{ file: 'x.txt', newContent: 'y' }],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
			expect(parsed.message).toContain('targetFiles cannot be empty');
		});

		test('empty changes returns parse-error', async () => {
			const result = await callTool({
				targetFiles: ['file.txt'],
				changes: [],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
			expect(parsed.message).toContain('changes cannot be empty');
		});

		test('invalid args type returns parse-error', async () => {
			const result = await suggestPatch.execute(
				42 as unknown as Record<string, unknown>,
				{ directory: workspaceDir } as unknown as ToolContext,
			);

			const parsed = JSON.parse(resultToString(result));
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});

		test('workspace directory not found returns parse-error', async () => {
			const badWorkspace = `/nonexistent/workspace/${Date.now()}`;
			const result = await suggestPatch.execute({}, {
				directory: badWorkspace,
			} as unknown as ToolContext);

			const parsed = JSON.parse(resultToString(result));
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('parse-error');
		});
	});

	describe('edge cases', () => {
		test('special characters in content preserved', async () => {
			createFile('special.txt', 'A\nB\nC');
			const specialContent = 'REPLACED <script>alert("xss")</script>';

			const result = await callTool({
				targetFiles: ['special.txt'],
				changes: [
					{
						file: 'special.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: specialContent,
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches[0].newContent).toBe(specialContent);
		});

		test('unicode content in file preserved', async () => {
			createFile('unicode.txt', '日本語\nB\nC');

			const result = await callTool({
				targetFiles: ['unicode.txt'],
				changes: [
					{
						file: 'unicode.txt',
						contextBefore: ['日本語'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: '新しいテキスト',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches[0].newContent).toBe('新しいテキスト');
		});

		test('large newContent handled', async () => {
			createFile('large.txt', 'A\nB\nC');
			const largeContent = 'x'.repeat(10000);

			const result = await callTool({
				targetFiles: ['large.txt'],
				changes: [
					{
						file: 'large.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: largeContent,
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches[0].newContent.length).toBe(10000);
		});
	});

	describe('property-based invariants', () => {
		test('idempotency: calling tool twice produces same patch structure', async () => {
			createFile('idem.txt', 'A\nB\nC');

			const result1 = await callTool({
				targetFiles: ['idem.txt'],
				changes: [
					{
						file: 'idem.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'NEW',
					},
				],
			});

			const result2 = await callTool({
				targetFiles: ['idem.txt'],
				changes: [
					{
						file: 'idem.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'NEW',
					},
				],
			});

			const parsed1 = JSON.parse(result1);
			const parsed2 = JSON.parse(result2);
			expect(parsed1.patches[0].originalContext).toEqual(
				parsed2.patches[0].originalContext,
			);
			expect(parsed1.patches[0].newContent).toEqual(
				parsed2.patches[0].newContent,
			);
		});

		test('patch hunks maintain correct indices', async () => {
			createFile('index.txt', 'A\nB\nC\nD\nE');

			const result = await callTool({
				targetFiles: ['index.txt'],
				changes: [
					{
						file: 'index.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'B',
						newContent: 'X',
					},
					{
						file: 'index.txt',
						contextBefore: ['C'],
						contextAfter: ['D'],
						oldContent: 'D',
						newContent: 'Y',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.patches[0].hunkIndex).toBe(0);
			expect(parsed.patches[1].hunkIndex).toBe(1);
		});
	});

	describe('anchor occurrence selection with multiple matches', () => {
		test('contextAfter appears multiple times — selects correct occurrence based on oldContent', async () => {
			// File content: 'A\nOLD\nB\nA\nX\nB\nC'
			// Lines: ['A','OLD','B','A','X','B','C']
			// First B at index 2 has OLD between first A and it
			// Second B at index 5 has X between second A and it
			createFile('example.txt', 'A\nOLD\nB\nA\nX\nB\nC');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'OLD',
						newContent: 'NEW',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.patches.length).toBe(1);
			expect(parsed.patches[0].newContent).toBe('NEW');
		});

		test('wrong oldContent with multiple contextAfter occurrences returns context-mismatch', async () => {
			// Same file but oldContent='WRONG' — neither B has 'WRONG' between first A and itself
			createFile('example.txt', 'A\nOLD\nB\nA\nX\nB\nC');

			const result = await callTool({
				targetFiles: ['example.txt'],
				changes: [
					{
						file: 'example.txt',
						contextBefore: ['A'],
						contextAfter: ['B'],
						oldContent: 'WRONG',
						newContent: 'NEW',
					},
				],
			});

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('context-mismatch');
		});
	});
});
