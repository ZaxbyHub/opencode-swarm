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

describe('suggest-patch unified format', () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'suggest-patch-unified-test-'),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	async function callTool(
		args: Record<string, unknown>,
		dir?: string,
	): Promise<string> {
		const result = await suggestPatch.execute(args, {
			directory: dir ?? workspaceDir,
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

	function createBinaryFile(relativePath: string): void {
		const fullPath = path.join(workspaceDir, relativePath);
		const dir = path.dirname(fullPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Write PNG magic bytes
		fs.writeFileSync(fullPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	}

	// ─────────────────────────────────────────────────────────────────────────
	// TC1: Single change, format='unified' — verify unifiedPatch returned
	// ─────────────────────────────────────────────────────────────────────────
	test('TC1: format=unified returns unifiedPatch alongside suggestions', async () => {
		createFile('example.txt', 'A\nB\nC');

		const result = await callTool({
			targetFiles: ['example.txt'],
			changes: [
				{
					file: 'example.txt',
					contextBefore: ['A'],
					contextAfter: ['C'],
					oldContent: 'B',
					newContent: 'REPLACED',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.unifiedPatch).toBeDefined();
		expect(typeof parsed.unifiedPatch).toBe('string');
		// Must contain a valid unified diff header
		expect(parsed.unifiedPatch).toContain(
			'diff --git a/example.txt b/example.txt',
		);
		expect(parsed.unifiedPatch).toContain('--- a/example.txt');
		expect(parsed.unifiedPatch).toContain('+++ b/example.txt');
		// Must contain hunk header
		expect(parsed.unifiedPatch).toContain('@@');
		// Must contain change markers
		expect(parsed.unifiedPatch).toContain('-B');
		expect(parsed.unifiedPatch).toContain('+REPLACED');
		// Context lines should have space prefix
		expect(parsed.unifiedPatch).toContain(' A');
		expect(parsed.unifiedPatch).toContain(' C');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC2: Multiple changes same file — verify single diff --git with multiple hunks
	// ─────────────────────────────────────────────────────────────────────────
	test('TC2: multiple changes same file produces one diff --git header with multiple hunks', async () => {
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
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.unifiedPatch).toBeDefined();

		const unified: string = parsed.unifiedPatch;
		// Only ONE diff --git header for this file
		const diffGitMatches = unified.match(/^diff --git/gm);
		expect(diffGitMatches).toHaveLength(1);
		// Exactly TWO hunk headers
		const hunkMatches = unified.match(/^@@ -[\d,]+ \+[\d,]+ @@/gm);
		expect(hunkMatches).toHaveLength(2);
		// Both changes present
		expect(unified).toContain('-B');
		expect(unified).toContain('+X');
		expect(unified).toContain('-D');
		expect(unified).toContain('+Y');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC3: Multiple changes different files — verify separate diff --git sections
	// ─────────────────────────────────────────────────────────────────────────
	test('TC3: changes to different files produce separate diff --git sections', async () => {
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
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.unifiedPatch).toBeDefined();

		const unified: string = parsed.unifiedPatch;
		// TWO diff --git headers
		const diffGitMatches = unified.match(/^diff --git/gm);
		expect(diffGitMatches).toHaveLength(2);
		// Both file sections present
		expect(unified).toContain('diff --git a/file1.txt b/file1.txt');
		expect(unified).toContain('diff --git a/file2.txt b/file2.txt');
		// Content from both files
		expect(unified).toContain('-B');
		expect(unified).toContain('+X');
		expect(unified).toContain('-D');
		expect(unified).toContain('+Y');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC4: Binary file rejection in unified mode — verify error returned
	// When ONLY binary files are provided (no valid changes), success is false
	// because patches array is empty. When mixed with real files, success is true.
	// ─────────────────────────────────────────────────────────────────────────
	test('TC4: binary file only returns error with success=false (no patches)', async () => {
		createBinaryFile('image.png');

		const result = await callTool({
			targetFiles: ['image.png'],
			changes: [
				{
					file: 'image.png',
					contextBefore: [],
					contextAfter: [],
					oldContent: '',
					newContent: 'REPLACED',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		// When all changes fail, success is false
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
		expect(parsed.message).toContain('Binary files are not supported');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC5: format='json' (default) — verify unifiedPatch is NOT present
	// ─────────────────────────────────────────────────────────────────────────
	test('TC5: format=json does not include unifiedPatch field', async () => {
		createFile('example.txt', 'A\nB\nC');

		// Explicit json format
		const jsonResult = await callTool({
			targetFiles: ['example.txt'],
			changes: [
				{
					file: 'example.txt',
					contextBefore: ['A'],
					contextAfter: ['C'],
					oldContent: 'B',
					newContent: 'REPLACED',
				},
			],
			format: 'json',
		});

		const jsonParsed = JSON.parse(jsonResult);
		expect(jsonParsed.success).toBe(true);
		expect(jsonParsed.unifiedPatch).toBeUndefined();

		// Default (no format specified)
		const defaultResult = await callTool({
			targetFiles: ['example.txt'],
			changes: [
				{
					file: 'example.txt',
					contextBefore: ['A'],
					contextAfter: ['C'],
					oldContent: 'B',
					newContent: 'REPLACED',
				},
			],
		});

		const defaultParsed = JSON.parse(defaultResult);
		expect(defaultParsed.success).toBe(true);
		expect(defaultParsed.unifiedPatch).toBeUndefined();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC6: contextBefore + oldContent + contextAfter — correct removal and context
	// ─────────────────────────────────────────────────────────────────────────
	test('TC6: unified diff shows correct context before, removal, and context after lines', async () => {
		// File: "header\nOLD\nfooter"
		// Change: replace OLD with NEW using header/footer as context
		createFile('context.txt', 'header\nOLD\nfooter');

		const result = await callTool({
			targetFiles: ['context.txt'],
			changes: [
				{
					file: 'context.txt',
					contextBefore: ['header'],
					contextAfter: ['footer'],
					oldContent: 'OLD',
					newContent: 'NEW',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const unified: string = parsed.unifiedPatch;

		// Context lines appear as space-prefixed
		expect(unified).toContain(' header');
		expect(unified).toContain(' footer');
		// Removal line is minus-prefixed
		expect(unified).toContain('-OLD');
		// Addition line is plus-prefixed
		expect(unified).toContain('+NEW');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC7: Trailing newline handling — \ No newline at end of file markers
	// ─────────────────────────────────────────────────────────────────────────
	test('TC7: file without trailing newline gets no-newline marker in unified diff', async () => {
		// Write file WITHOUT trailing newline (binary mode to prevent auto-conversion)
		const fullPath = path.join(workspaceDir, 'notrail.txt');
		fs.writeFileSync(fullPath, 'A\nB', 'utf-8'); // no trailing \n

		const result = await callTool({
			targetFiles: ['notrail.txt'],
			changes: [
				{
					file: 'notrail.txt',
					contextBefore: ['A'],
					contextAfter: [],
					oldContent: 'B',
					newContent: 'C',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const unified: string = parsed.unifiedPatch;

		// Should contain the no-newline marker at EOF
		expect(unified).toContain('\\ No newline at end of file');
		// The marker should appear after the last content line of the hunk
		// (which could be on old side, new side, or both depending on content)
	});

	test('TC7b: file with trailing newline but newContent without — marker appears on new side', async () => {
		// File has trailing newline but newContent does not
		createFile('withtrail.txt', 'A\nB\n');

		const result = await callTool({
			targetFiles: ['withtrail.txt'],
			changes: [
				{
					file: 'withtrail.txt',
					contextBefore: ['A'],
					contextAfter: [],
					oldContent: 'B',
					newContent: 'C', // no trailing newline in new content
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const unified: string = parsed.unifiedPatch;

		// Marker SHOULD appear because newContent lacks trailing newline at EOF
		expect(unified).toContain('\\ No newline at end of file');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC8: Empty newContent (pure deletion) — correct unified output
	// ─────────────────────────────────────────────────────────────────────────
	test('TC8: empty newContent produces a deletion diff', async () => {
		createFile('delete.txt', 'A\nB\nC');

		const result = await callTool({
			targetFiles: ['delete.txt'],
			changes: [
				{
					file: 'delete.txt',
					contextBefore: ['A'],
					contextAfter: ['C'],
					oldContent: 'B',
					newContent: '',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const unified: string = parsed.unifiedPatch;

		// Removal line should be present
		expect(unified).toContain('-B');
		// No addition of empty string (no "+" for empty newContent)
		// Context preserved
		expect(unified).toContain(' A');
		expect(unified).toContain(' C');
		// Should have valid hunk header
		expect(unified).toContain('@@');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC8b: Pure insertion (no oldContent) — correct unified output
	// ─────────────────────────────────────────────────────────────────────────
	test('TC8b: no oldContent produces an insertion diff', async () => {
		createFile('insert.txt', 'A\nC');

		const result = await callTool({
			targetFiles: ['insert.txt'],
			changes: [
				{
					file: 'insert.txt',
					contextBefore: ['A'],
					contextAfter: ['C'],
					oldContent: '', // no oldContent = pure insertion
					newContent: 'B',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const unified: string = parsed.unifiedPatch;

		// Addition line should be present
		expect(unified).toContain('+B');
		// Context preserved
		expect(unified).toContain(' A');
		expect(unified).toContain(' C');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC9: unifiedPatch is parseable structure (roundtrip sanity)
	// ─────────────────────────────────────────────────────────────────────────
	test('TC9: unifiedPatch contains only valid unified diff markers', async () => {
		createFile('markers.txt', 'line1\nline2\nline3\nline4\nline5');

		const result = await callTool({
			targetFiles: ['markers.txt'],
			changes: [
				{
					file: 'markers.txt',
					contextBefore: ['line1'],
					contextAfter: ['line3'],
					oldContent: 'line2',
					newContent: 'MODIFIED',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const unified: string = parsed.unifiedPatch;

		// Every diff line should start with a valid unified diff marker
		// Valid markers: diff --git, ---, +++, @@, space (context), +, -, \ No newline
		const diffLines = unified.split('\n');
		for (const line of diffLines) {
			if (line === '') continue; // empty lines ok
			// Each line must start with a valid marker
			const startsWithValidMarker =
				line.startsWith('diff --git') ||
				line.startsWith('--- ') ||
				line.startsWith('+++ ') ||
				line.startsWith('@@ ') ||
				line.startsWith('+') ||
				line.startsWith('-') ||
				line.startsWith(' ') ||
				line.startsWith('\\ No newline');
			expect(startsWithValidMarker).toBe(true);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC10: format=unified but binary files alongside real files — partial success
	// ─────────────────────────────────────────────────────────────────────────
	test('TC10: real files still produce unifiedPatch even when binary files are rejected', async () => {
		createBinaryFile('bad.png');
		createFile('good.txt', 'A\nB\nC');

		const result = await callTool({
			targetFiles: ['bad.png', 'good.txt'],
			changes: [
				{
					file: 'bad.png',
					contextBefore: [],
					contextAfter: [],
					oldContent: '',
					newContent: 'REPLACED',
				},
				{
					file: 'good.txt',
					contextBefore: ['A'],
					contextAfter: ['C'],
					oldContent: 'B',
					newContent: 'X',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		// Partial success — binary fails but good file succeeds
		expect(parsed.success).toBe(true);
		expect(parsed.patches.length).toBe(1);
		expect(parsed.filesModified).toEqual(['good.txt']);
		expect(parsed.errors).toBeDefined();
		expect(parsed.errors.length).toBe(1);

		// unifiedPatch should contain the good file diff
		expect(parsed.unifiedPatch).toBeDefined();
		expect(parsed.unifiedPatch).toContain('good.txt');
		expect(parsed.unifiedPatch).toContain('-B');
		expect(parsed.unifiedPatch).toContain('+X');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// TC11: rename/copy detection — unified mode rejects non-normal patches
	// (rename/copy detection is not implemented yet; verify that binary
	// rejection at minimum is enforced)
	// ─────────────────────────────────────────────────────────────────────────
	test('TC11: binary-only change in unified mode returns error with success=false', async () => {
		createBinaryFile('logo.png');

		const result = await callTool({
			targetFiles: ['logo.png'],
			changes: [
				{
					file: 'logo.png',
					contextBefore: [],
					contextAfter: [],
					oldContent: '',
					newContent: 'NEW BINARY',
				},
			],
			format: 'unified',
		});

		const parsed = JSON.parse(result);
		// Binary-only change: all patches fail, success=false
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('parse-error');
		expect(parsed.message).toContain('Binary files are not supported');
	});
});
