import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ApplyPatchResult } from './apply-patch';
import { swarmApplyPatch } from './apply-patch';

// Helper: create a temp directory
function createTempDir(): string {
	return mkdtempSync(path.join(tmpdir(), 'apply-patch-test-'));
}

// Helper: create a test file with given content
function createFile(dir: string, relativePath: string, content: string): void {
	const fullPath = path.join(dir, relativePath);
	writeFileSync(fullPath, content, 'utf-8');
}

// Helper: read file content
function readFileContent(dir: string, relativePath: string): string {
	return readFileSync(path.join(dir, relativePath), 'utf-8');
}

// Helper: parse JSON result
function parseResult(result: string): ApplyPatchResult {
	return JSON.parse(result) as ApplyPatchResult;
}

// Helper: build a simple unified diff for a single file
function buildDiff(
	oldPath: string,
	newPath: string,
	oldContent: string,
	newContent: string,
): string {
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');

	// Find the common prefix and suffix
	let prefixLen = 0;
	while (
		prefixLen < oldLines.length &&
		prefixLen < newLines.length &&
		oldLines[prefixLen] === newLines[prefixLen]
	) {
		prefixLen++;
	}

	let suffixLen = 0;
	while (
		suffixLen < oldLines.length - prefixLen &&
		suffixLen < newLines.length - prefixLen &&
		oldLines[oldLines.length - 1 - suffixLen] ===
			newLines[newLines.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const oldBody = oldLines.slice(prefixLen, oldLines.length - suffixLen);
	const newBody = newLines.slice(prefixLen, newLines.length - suffixLen);

	// Compute adjusted suffix length excluding trailing empty element (newline artifact)
	// When content ends with '\n', split('\n') produces a trailing empty element.
	// This trailing empty should NOT be counted as a suffix line.
	const trailingEmptyOld =
		oldLines.length > 0 && oldLines[oldLines.length - 1] === '' ? 1 : 0;
	const trailingEmptyNew =
		newLines.length > 0 && newLines[newLines.length - 1] === '' ? 1 : 0;
	const adjustedSuffixLen = Math.max(0, suffixLen - trailingEmptyOld);
	const adjustedSuffixLenNew = Math.max(0, suffixLen - trailingEmptyNew);

	// oldStart is the position of the first line in the hunk (0-indexed prefix)
	const oldStart = prefixLen;
	const oldCount = oldBody.length + prefixLen + adjustedSuffixLen;
	const newStart = prefixLen;
	const newCount = newBody.length + prefixLen + adjustedSuffixLenNew;

	const hunkLines: string[] = [];
	// Add prefix context lines
	for (let i = 0; i < prefixLen; i++) {
		hunkLines.push(` ${oldLines[i]}`);
	}
	// Add removal and addition lines
	for (const line of oldBody) {
		hunkLines.push(`-${line}`);
	}
	for (const line of newBody) {
		hunkLines.push(`+${line}`);
	}
	// Add suffix context lines (only non-empty ones)
	for (let i = 0; i < adjustedSuffixLen; i++) {
		const contextLine = oldLines[prefixLen + oldBody.length + i] ?? '';
		hunkLines.push(` ${contextLine}`);
	}

	return `--- ${oldPath}\n+++ ${newPath}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${hunkLines.join('\n')}\n`;
}

// Helper: build a new file creation diff
function buildCreateDiff(newPath: string, content: string): string {
	// Split and filter out empty trailing element from trailing newline
	const lines = content
		.split('\n')
		.filter((l, i, arr) => i < arr.length - 1 || l !== '');
	const hunkLines: string[] = [];
	for (const line of lines) {
		hunkLines.push(`+${line}`);
	}
	return `--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${lines.length} @@\n${hunkLines.join('\n')}\n`;
}

// Helper: build a delete diff
function buildDeleteDiff(delPath: string, content: string): string {
	const lines = content.split('\n');
	const hunkLines: string[] = [];
	for (const line of lines) {
		hunkLines.push(`-${line}`);
	}
	return `--- ${delPath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${hunkLines.join('\n')}\n`;
}

// Helper: call swarmApplyPatch.execute with correct ctx argument
async function applyPatchExec(args: {
	patch: string;
	files: string[];
	dryRun?: boolean;
	allowCreates?: boolean;
	allowDeletes?: boolean;
	directory: string;
}): Promise<string> {
	// The createSwarmTool wrapper expects ctx as second arg, not directory
	// It extracts directory from ctx.directory
	return swarmApplyPatch.execute(args, { directory: args.directory } as any);
}

// Helper: workspace for execute call
function workspaceOf(dir: string) {
	return { directory: dir };
}

describe('swarm_apply_patch tool', () => {
	let workspace: string;

	beforeEach(() => {
		workspace = createTempDir();
	});

	afterEach(() => {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ===== Test 1: Applies a simple single-file replacement patch =====
	test('applies a simple single-file replacement patch', async () => {
		const targetFile = 'example.txt';
		createFile(workspace, targetFile, 'line1\nline2\nline3\n');

		const patch = buildDiff(
			targetFile,
			targetFile,
			'line1\nline2\nline3\n',
			'line1\nline2-modified\nline3\n',
		);

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.summary.totalFiles).toBe(1);
		expect(result.summary.applied).toBe(1);
		expect(result.files[0]?.status).toBe('applied');
		expect(readFileContent(workspace, targetFile)).toBe(
			'line1\nline2-modified\nline3\n',
		);
	});

	// ===== Test 2: Applies a multi-hunk patch to one file =====
	test('applies a multi-hunk patch to one file', async () => {
		const targetFile = 'multihunk.js';

		const patch1 = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,4 +1,4 @@\n const x = 1;\n-const y = 2;\n+const y = 99;\n const z = 3;\n const w = 4;\n`;
		const patch2 = `--- ${targetFile}\n+++ ${targetFile}\n@@ -3,4 +3,4 @@\n const z = 3;\n const w = 4;\n+console.log('added');\n const final = true;\n`;

		// Write initial file
		createFile(
			workspace,
			targetFile,
			'const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst final = true;\n',
		);

		const combinedPatch = patch1 + patch2;
		const resultStr = await swarmApplyPatch.execute(
			{ patch: combinedPatch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('applied');
		const content = readFileContent(workspace, targetFile);
		expect(content).toContain('const y = 99;');
		expect(content).toContain("console.log('added');");
	});

	// ===== Test 3: Applies a multi-file patch when all files are declared =====
	test('applies a multi-file patch when all files are declared', async () => {
		const fileA = 'a.txt';
		const fileB = 'b.txt';
		createFile(workspace, fileA, 'hello\nworld\n');
		createFile(workspace, fileB, 'foo\nbar\n');

		const patchA = buildDiff(fileA, fileA, 'hello\nworld\n', 'hello\nswarm\n');
		const patchB = buildDiff(fileB, fileB, 'foo\nbar\n', 'foo\nbaz\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch: patchA + patchB, files: [fileA, fileB] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.summary.totalFiles).toBe(2);
		expect(result.summary.applied).toBe(2);
		expect(readFileContent(workspace, fileA)).toBe('hello\nswarm\n');
		expect(readFileContent(workspace, fileB)).toBe('foo\nbaz\n');
	});

	// ===== Test 4: dryRun reports success without changing files =====
	test('dryRun: true reports success without changing files', async () => {
		const targetFile = 'dryrun.txt';
		createFile(workspace, targetFile, 'original\n');

		const patch = buildDiff(targetFile, targetFile, 'original\n', 'modified\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile], dryRun: true },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe('original\n');
		expect(result.files[0]?.status).toBe('applied');
	});

	// ===== Test 5: Rejects when parsed patch target is not in files[] =====
	test('rejects when parsed patch target is not in files[]', async () => {
		const targetFile = 'only-in-patch.txt';
		createFile(workspace, 'other.txt', 'content\n');

		const patch = buildDiff(targetFile, targetFile, 'old\n', 'new\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: ['other.txt'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.type).toBe('context-mismatch');
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'not in the declared files array',
		);
	});

	// ===== Test 6: Warns when files[] has extra entries not in patch =====
	test('warns when files[] has extra entries not in patch', async () => {
		const targetFile = 'patched.txt';
		const extraFile = 'extra.txt';
		createFile(workspace, targetFile, 'line1\nline2\nline3\n');
		createFile(workspace, extraFile, 'extra content\n');

		const patch = buildDiff(
			targetFile,
			targetFile,
			'line1\nline2\nline3\n',
			'line1\nline2-modified\nline3\n',
		);

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile, extraFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		// Should still succeed with warning
		expect(result.success).toBe(true);
		expect(result.warnings).toBeDefined();
		expect(result.warnings?.[0]).toContain('extra.txt');
	});

	// ===== Test 7: Rejects context mismatch with diagnostics =====
	test('rejects context mismatch with diagnostics', async () => {
		const targetFile = 'mismatch.txt';
		// File has different content than what patch expects
		createFile(workspace, targetFile, 'line1\nDIFFERENT\nline3\n');

		const patch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.status).toBe('error');
		expect(result.files[0]?.errors?.[0]?.type).toBe('context-mismatch');
		expect(result.files[0]?.errors?.[0]?.expected).toBeDefined();
		expect(result.files[0]?.errors?.[0]?.actual).toBeDefined();
	});

	// ===== Test 8: Rejects absolute paths =====
	test('rejects absolute paths', async () => {
		const patch = '--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-old\n+new\n';

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: ['/etc/passwd'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain('Absolute path');
	});

	// ===== Test 9: Rejects ../ traversal =====
	test('rejects ../ traversal', async () => {
		const patch = `--- ../secret.txt\n+++ ../secret.txt\n@@ -1 +1 @@\n-old\n+new\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: ['../secret.txt'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain('traversal');
	});

	// ===== Test 10: Rejects .git/ and .swarm/ targets =====
	test('rejects .git/ and .swarm/ protected directory targets', async () => {
		const gitPatch = `--- .git/config\n+++ .git/config\n@@ -1 +1 @@\n-old\n+new\n`;
		const resultStr = await swarmApplyPatch.execute(
			{ patch: gitPatch, files: ['.git/config'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);
		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Protected directory',
		);

		const swarmPatch = `--- .swarm/secret.txt\n+++ .swarm/secret.txt\n@@ -1 +1 @@\n-old\n+new\n`;
		const resultStr2 = await swarmApplyPatch.execute(
			{ patch: swarmPatch, files: ['.swarm/secret.txt'] },
			workspaceOf(workspace) as any,
		);
		const result2 = parseResult(resultStr2);
		expect(result2.success).toBe(false);
		expect(result2.files[0]?.errors?.[0]?.message).toContain(
			'Protected directory',
		);
	});

	// ===== Test 10b: Rejects NESTED .git/ and .swarm/ targets (regression: Fix-apply-patch-nested-protected) =====
	// Prior code checked ONLY the first path segment, so `src/.git/config` would pass
	// isProtectedPath because segment[0] === 'src' !== '.git'. The fix uses
	// segments.some() to check ALL segments, correctly rejecting nested protected dirs.
	test('rejects .git/ hidden inside a subdirectory path (src/.git/config)', async () => {
		const nestedGitPatch = `--- src/.git/config\n+++ src/.git/config\n@@ -1 +1 @@\n-old\n+new\n`;
		const resultStr = await swarmApplyPatch.execute(
			{ patch: nestedGitPatch, files: ['src/.git/config'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);
		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Protected directory',
		);
	});

	test('rejects .swarm/ hidden inside a subdirectory path (src/.swarm/state)', async () => {
		const nestedSwarmPatch = `--- src/.swarm/state\n+++ src/.swarm/state\n@@ -1 +1 @@\n-old\n+new\n`;
		const resultStr = await swarmApplyPatch.execute(
			{ patch: nestedSwarmPatch, files: ['src/.swarm/state'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);
		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Protected directory',
		);
	});

	test('rejects .git/ at arbitrary depth (a/b/.git/c)', async () => {
		const deepGitPatch = `--- a/b/.git/c\n+++ a/b/.git/c\n@@ -1 +1 @@\n-old\n+new\n`;
		const resultStr = await swarmApplyPatch.execute(
			{ patch: deepGitPatch, files: ['a/b/.git/c'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);
		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Protected directory',
		);
	});

	// ===== Test 11: Creates new file when allowCreates=true =====
	test('creates new file when allowCreates=true', async () => {
		const newFile = 'brand-new.txt';
		const content = 'brand new content\n';
		const patch = buildCreateDiff(newFile, content);

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [newFile], allowCreates: true },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('created');
		expect(existsSync(path.join(workspace, newFile))).toBe(true);
		expect(readFileContent(workspace, newFile)).toBe(content);
	});

	// ===== Test 12: Rejects create when allowCreates=false (default) =====
	test('rejects create when allowCreates=false (default)', async () => {
		const newFile = 'not-created.txt';
		const patch = buildCreateDiff(newFile, 'some content\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [newFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.status).toBe('error');
		expect(result.files[0]?.errors?.[0]?.type).toBe('create-not-allowed');
		expect(existsSync(path.join(workspace, newFile))).toBe(false);
	});

	// ===== Test 13: Rejects delete by default =====
	test('rejects delete by default (allowDeletes=false)', async () => {
		const targetFile = 'to-delete.txt';
		createFile(workspace, targetFile, 'content to delete\n');
		const patch = buildDeleteDiff(targetFile, 'content to delete\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.status).toBe('error');
		expect(result.files[0]?.errors?.[0]?.type).toBe('delete-not-allowed');
		expect(existsSync(path.join(workspace, targetFile))).toBe(true);
	});

	// ===== Test 14: Allows delete when allowDeletes=true =====
	test('allows delete when allowDeletes=true', async () => {
		const targetFile = 'to-delete.txt';
		createFile(workspace, targetFile, 'content to delete\n');
		const patch = buildDeleteDiff(targetFile, 'content to delete\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile], allowDeletes: true },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('applied');
		expect(existsSync(path.join(workspace, targetFile))).toBe(false);
	});

	// ===== Test 15: Rejects binary patches =====
	test('rejects binary patches', async () => {
		const targetFile = 'binary.txt';
		createFile(workspace, targetFile, 'original\n');

		const binaryPatch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\nGIT binary patch\nliteral 1\nH Pf\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch: binaryPatch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		// Binary detection happens at parse time — whole patch fails
		expect(result.files[0]?.errors?.[0]?.message).toContain('Binary');
	});

	// ===== Test 16: Rejects rename/copy patches =====
	test('rejects rename/copy patches', async () => {
		const oldFile = 'old-name.txt';
		const newFile = 'new-name.txt';
		createFile(workspace, oldFile, 'content\n');

		const renamePatch = `--- ${oldFile}\n+++ ${newFile}\nrename from ${oldFile}\nrename to ${newFile}\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch: renamePatch, files: [oldFile, newFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain('Rename/copy');
	});

	// ===== Test 17: Preserves unrelated content =====
	test('preserves unrelated content when only one file is patched', async () => {
		const patchedFile = 'patched.txt';
		const unrelatedFile = 'unrelated.txt';
		createFile(workspace, patchedFile, 'line1\nline2\nline3\n');
		createFile(workspace, unrelatedFile, 'unchanged content\n');

		const patch = buildDiff(
			patchedFile,
			patchedFile,
			'line1\nline2\nline3\n',
			'line1\nmodified\nline3\n',
		);

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [patchedFile, unrelatedFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(readFileContent(workspace, unrelatedFile)).toBe(
			'unchanged content\n',
		);
	});

	// ===== Test 18: Atomic writes — no temp files left =====
	test('atomic writes leave no temp files behind', async () => {
		const targetFile = 'atomic.txt';
		createFile(workspace, targetFile, 'original\n');

		const patch = buildDiff(targetFile, targetFile, 'original\n', 'modified\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe('modified\n');

		// Verify no temp files are left in the workspace
		const entries = readdirSync(workspace).filter((n) =>
			n.includes('.apply-patch-'),
		);
		expect(entries).toHaveLength(0);
	});

	// ===== Test 19: Handles \\r\\n line endings =====
	test('handles \\r\\n line endings correctly', async () => {
		const targetFile = 'crlf.txt';
		// File with CRLF line endings
		createFile(workspace, targetFile, 'line1\r\nline2\r\nline3\r\n');

		const patch = buildDiff(
			targetFile,
			targetFile,
			'line1\r\nline2\r\nline3\r\n',
			'line1\r\nline2-modified\r\nline3\r\n',
		);

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('applied');
		const content = readFileSync(
			path.join(workspace, targetFile),
			'utf-8',
		).replace(/\r\n/g, '\n');
		expect(content).toContain('line2-modified');
	});

	test('handles file with no trailing newline', async () => {
		const targetFile = 'nonl.txt';
		// File WITHOUT trailing newline
		writeFileSync(
			path.join(workspace, targetFile),
			'line1\nline2\nline3',
			'utf-8',
		);

		const patch = buildDiff(
			targetFile,
			targetFile,
			'line1\nline2\nline3',
			'line1\nline2-modified\nline3',
		);

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		const content = readFileSync(path.join(workspace, targetFile), 'utf-8');
		// Should preserve no-trailing-newline
		expect(content).not.toEndWith('\n');
		expect(content).toContain('line2-modified');
	});

	test('empty patch returns success with no-changes status', async () => {
		const targetFile = 'empty-patch.txt';
		createFile(workspace, targetFile, 'content\n');

		// Patch with no hunks (just headers)
		const emptyPatch = `--- ${targetFile}\n+++ ${targetFile}\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch: emptyPatch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('no-changes');
		expect(result.summary.applied).toBe(0);
	});

	// ===== Test 22: Partial application (one file succeeds, another fails) =====
	test('partial application: one file succeeds, another fails', async () => {
		const goodFile = 'good.txt';
		const badFile = 'bad.txt';
		createFile(workspace, goodFile, 'line1\nline2\nline3\n');
		createFile(workspace, badFile, 'different content\n');

		const goodPatch = buildDiff(
			goodFile,
			goodFile,
			'line1\nline2\nline3\n',
			'line1\nmodified\nline3\n',
		);
		const badPatch = `--- ${badFile}\n+++ ${badFile}\n@@ -1 +1 @@\n-old\n+new\n`;

		const combinedPatch = goodPatch + badPatch;
		const resultStr = await swarmApplyPatch.execute(
			{ patch: combinedPatch, files: [goodFile, badFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.summary.failed).toBeGreaterThan(0);
		// Good file should have been applied despite bad file failure
		expect(readFileContent(workspace, goodFile)).toBe(
			'line1\nmodified\nline3\n',
		);
	});

	// ===== Test 23: Rejects Windows reserved names =====
	test('rejects Windows reserved names', async () => {
		const reservedNames = ['nul', 'NUL', 'aux', 'prn', 'com1', 'lpt9'];
		for (const name of reservedNames) {
			const patch = `--- ${name}.txt\n+++ ${name}.txt\n@@ -1 +1 @@\n-old\n+new\n`;

			const resultStr = await swarmApplyPatch.execute(
				{ patch, files: [`${name}.txt`] },
				workspaceOf(workspace) as any,
			);
			const result = parseResult(resultStr);

			expect(result.success).toBe(false);
			expect(result.files[0]?.errors?.[0]?.message).toContain(
				'Windows reserved name',
			);
		}
	});

	// ===== Test 24: Rejects control characters in paths =====
	test('rejects control characters in file paths', async () => {
		const badPath = 'file\x00with\x01control.txt';
		const patch = `--- ${badPath}\n+++ ${badPath}\n@@ -1 +1 @@\n-old\n+new\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [badPath] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Control characters',
		);
	});

	// ===== Test 25: Whitespace-only result is written as empty file, not deleted =====
	test('whitespace-only result is written as empty file, not deleted', async () => {
		const targetFile = 'whitespace.txt';
		createFile(workspace, targetFile, 'some content\n');

		// Replace all content with spaces/tabs/newlines
		const patch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1 +1 @@\n-some content\n+   \t  \n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('applied');
		// File must still exist (NOT deleted)
		expect(existsSync(path.join(workspace, targetFile))).toBe(true);
	});

	// ===== Test 26: Patch removing all content requires allowDeletes =====
	test('patch removing all lines is rejected by default (allowDeletes=false)', async () => {
		const targetFile = 'empty-result.txt';
		createFile(workspace, targetFile, 'line1\nline2\nline3\n');

		const patch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,3 +0,0 @@\n-line1\n-line2\n-line3\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.status).toBe('error');
		expect(result.files[0]?.errors?.[0]?.type).toBe('delete-not-allowed');
		// File must still exist with original content
		expect(existsSync(path.join(workspace, targetFile))).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe(
			'line1\nline2\nline3\n',
		);
	});

	test('patch removing all lines writes empty file with allowDeletes=true', async () => {
		const targetFile = 'empty-result.txt';
		createFile(workspace, targetFile, 'line1\nline2\nline3\n');

		const patch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,3 +0,0 @@\n-line1\n-line2\n-line3\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile], allowDeletes: true },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(true);
		expect(result.files[0]?.status).toBe('applied');
		// File should exist as an empty file
		expect(existsSync(path.join(workspace, targetFile))).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe('');
	});

	// ===== Test 27: Stale patch (shifted context) is rejected, not silently applied =====
	test('stale patch with shifted context reports mismatch', async () => {
		const targetFile = 'stale.txt';
		// Create a file with duplicate blocks separated by an insertion point
		createFile(
			workspace,
			targetFile,
			'block-a\nblock-a\nINSERTED\nblock-b\nblock-b\n',
		);

		// Hunk declares @@ -1,2 +1,2 @@ targeting the first block-a lines.
		// If forward-search existed, it would silently match a later block.
		// With exact-match-only, it should fail if the context at line 1 differs.
		const patch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,2 +1,2 @@\n block-x\n block-x\n+added\n`;

		const resultStr = await swarmApplyPatch.execute(
			{ patch, files: [targetFile] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.status).toBe('error');
		expect(result.files[0]?.errors?.[0]?.type).toBe('context-mismatch');
	});

	// ===== Test 28: Hard-fail on unsupported *** Begin Patch / *** Update File format =====
	test('rejects *** Begin Patch / *** Update File style payload with hard error', async () => {
		const unsupportedPayload = [
			'*** Begin Patch',
			'*** Update File: src/foo.ts',
			'@@',
			'-old line',
			'+new line',
			'*** End Patch',
		].join('\n');

		const resultStr = await swarmApplyPatch.execute(
			{ patch: unsupportedPayload, files: ['src/foo.ts'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Unsupported patch format',
		);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'swarm_apply_patch',
		);
	});

	test('rejects *** Update File style payload (no Begin Patch header)', async () => {
		const unsupportedPayload = '*** Update File: src/bar.ts\n@@\n-old\n+new\n';

		const resultStr = await swarmApplyPatch.execute(
			{ patch: unsupportedPayload, files: ['src/bar.ts'] },
			workspaceOf(workspace) as any,
		);
		const result = parseResult(resultStr);

		expect(result.success).toBe(false);
		expect(result.files[0]?.errors?.[0]?.message).toContain(
			'Unsupported patch format',
		);
	});
});
