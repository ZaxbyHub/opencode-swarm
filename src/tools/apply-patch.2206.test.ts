import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { ApplyPatchResult } from './apply-patch';
import { swarmApplyPatch } from './apply-patch';

// Split out of the over-cap src/tools/apply-patch.test.ts (FR-006 ratchet):
// issue #2206 scenarios — payload alias args and uniformly indented diffs.

function createTempDir(): string {
	return mkdtempSync(path.join(realpathSync(tmpdir()), 'apply-patch-2206-'));
}
function createFile(dir: string, relativePath: string, content: string): void {
	writeFileSync(path.join(dir, relativePath), content, 'utf-8');
}
function readFileContent(dir: string, relativePath: string): string {
	return readFileSync(path.join(dir, relativePath), 'utf-8');
}
function parseResult(result: string): ApplyPatchResult {
	return JSON.parse(result) as ApplyPatchResult;
}
function workspaceOf(dir: string) {
	return { directory: dir, worktree: dir };
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

// NOTE on call shape: `swarmApplyPatch.execute(args, ctx)` receives the
// ToolContext-shaped second argument that the createSwarmTool wrapper passes
// through (directory derived from ctx.directory) — the same `workspaceOf(...)
// as any` pattern as the parent apply-patch.test.ts suite. A future
// createSwarmTool signature change breaks these call sites intentionally
// loudly.

// ===== Issue #2206: schema aliases + uniformly indented patch payloads =====

describe('swarm_apply_patch #2206 alias + indent tolerance', () => {
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

	// Indent every non-empty line by N spaces — simulates a diff pasted inside
	// a fenced markdown / YAML / JSON block.
	function indent(diffText: string, spaces: number): string {
		const pad = ' '.repeat(spaces);
		return diffText
			.split('\n')
			.map((line) => (line.length === 0 ? line : pad + line))
			.join('\n');
	}

	test('applies a uniformly 2-space-indented unified diff (#2206)', async () => {
		const targetFile = 'indented2.txt';
		createFile(workspace, targetFile, 'alpha\nbeta\ngamma\n');
		const patch = indent(
			buildDiff(
				targetFile,
				targetFile,
				'alpha\nbeta\ngamma\n',
				'alpha\nBETA\ngamma\n',
			),
			2,
		);
		const result = parseResult(
			await swarmApplyPatch.execute(
				{ patch, files: [targetFile] },
				workspaceOf(workspace) as any,
			),
		);
		expect(result.success).toBe(true);
		expect(result.summary.applied).toBe(1);
		expect(readFileContent(workspace, targetFile)).toBe('alpha\nBETA\ngamma\n');
	});

	test('applies a uniformly 4-space-indented unified diff with CRLF line endings (#2206)', async () => {
		const targetFile = 'indented4.txt';
		createFile(workspace, targetFile, 'one\ntwo\n');
		const patch = indent(
			buildDiff(targetFile, targetFile, 'one\ntwo\n', 'one\nTWO\n'),
			4,
		).replace(/\n/g, '\r\n');
		const result = parseResult(
			await swarmApplyPatch.execute(
				{ patch, files: [targetFile] },
				workspaceOf(workspace) as any,
			),
		);
		expect(result.success).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe('one\nTWO\n');
	});

	test('preserves real content indentation beyond the stripped block indent (#2206)', async () => {
		// Python-style body: content lines themselves start with spaces. The
		// min-common-indent strip removes only the wrapper indent; the hunk
		// marker space and the content's own indentation survive.
		const targetFile = 'code.py';
		createFile(workspace, targetFile, 'def f():\n    return 1\n');
		const inner = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2\n`;
		const patch = indent(inner, 2);
		const result = parseResult(
			await swarmApplyPatch.execute(
				{ patch, files: [targetFile] },
				workspaceOf(workspace) as any,
			),
		);
		expect(result.success).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe(
			'def f():\n    return 2\n',
		);
	});

	test.each([
		'patchText',
		'patch_text',
		'patchPayload',
	] as const)('applies the patch when only the %s alias carries the payload (#2206)', async (aliasKey) => {
		const targetFile = 'alias.txt';
		createFile(workspace, targetFile, 'a\n');
		const patch = buildDiff(targetFile, targetFile, 'a\n', 'b\n');
		const args: Record<string, unknown> = { files: [targetFile] };
		args[aliasKey] = patch;
		const result = parseResult(
			await swarmApplyPatch.execute(args, workspaceOf(workspace) as any),
		);
		expect(result.success).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe('b\n');
	});

	test('errors with patch text cannot be empty when no canonical or alias payload is present (#2206)', async () => {
		const result = parseResult(
			await swarmApplyPatch.execute(
				{ files: ['whatever.txt'] } as Record<string, unknown>,
				workspaceOf(workspace) as any,
			),
		);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('patch text cannot be empty');
	});

	// === PRR-006: review-handoff test-gap coverage (closure of #2206 review) ===

	test('canonical patch wins when all four payload fields are populated (#2206 review)', async () => {
		const targetFile = 'precedence.txt';
		createFile(workspace, targetFile, 'a\n');
		const canonicalPatch = buildDiff(
			targetFile,
			targetFile,
			'a\n',
			'CANONICAL\n',
		);
		const aliasPatch = buildDiff(targetFile, targetFile, 'a\n', 'ALIAS\n');
		const args: Record<string, unknown> = {
			files: [targetFile],
			patch: canonicalPatch,
			patchText: aliasPatch,
			patch_text: aliasPatch,
			patchPayload: aliasPatch,
		};
		const result = parseResult(
			await swarmApplyPatch.execute(args, workspaceOf(workspace) as any),
		);
		expect(result.success).toBe(true);
		// Canonical `patch` wins; alias fields are silently ignored.
		expect(readFileContent(workspace, targetFile)).toBe('CANONICAL\n');
	});

	test('alias precedence is positional first-truthy: patchText > patch_text > patchPayload (#2206 review)', async () => {
		const targetFile = 'positional.txt';
		createFile(workspace, targetFile, 'a\n');
		const patchA = buildDiff(targetFile, targetFile, 'a\n', 'A\n');
		const patchB = buildDiff(targetFile, targetFile, 'a\n', 'B\n');
		const patchC = buildDiff(targetFile, targetFile, 'a\n', 'C\n');
		const args: Record<string, unknown> = {
			files: [targetFile],
			patch_text: patchB,
			patchPayload: patchC,
			patchText: patchA,
		};
		const result = parseResult(
			await swarmApplyPatch.execute(args, workspaceOf(workspace) as any),
		);
		expect(result.success).toBe(true);
		// patchText is the first positional among the aliases → wins.
		expect(readFileContent(workspace, targetFile)).toBe('A\n');
	});

	test('an empty canonical patch falls through to the first non-empty alias (#2206 review)', async () => {
		const targetFile = 'empty-canonical.txt';
		createFile(workspace, targetFile, 'a\n');
		const aliasPatch = buildDiff(targetFile, targetFile, 'a\n', 'ALIAS\n');
		const args: Record<string, unknown> = {
			files: [targetFile],
			patch: '',
			patchText: aliasPatch,
		};
		const result = parseResult(
			await swarmApplyPatch.execute(args, workspaceOf(workspace) as any),
		);
		expect(result.success).toBe(true);
		// Schema accepts empty-string patch (now optional); execute-side
		// find() predicate `value.length > 0` falls through to the alias.
		expect(readFileContent(workspace, targetFile)).toBe('ALIAS\n');
	});

	test('applies a uniformly TAB-indented unified diff (#2206 review / edge parity)', async () => {
		const targetFile = 'tab-indent.txt';
		createFile(workspace, targetFile, 'a\nb\n');
		const inner = buildDiff(targetFile, targetFile, 'a\nb\n', 'a\nB\n');
		// Single leading tab per non-empty line.
		const tabbed = inner
			.split('\n')
			.map((line) => (line.length === 0 ? line : '\t' + line))
			.join('\n');
		const result = parseResult(
			await swarmApplyPatch.execute(
				{ patch: tabbed, files: [targetFile] },
				workspaceOf(workspace) as any,
			),
		);
		expect(result.success).toBe(true);
		expect(readFileContent(workspace, targetFile)).toBe('a\nB\n');
	});
});

// ===== Issue #2206 (final-critic finding): pin the DECLARED schema surface =====
// `tool()` from @opencode-ai/plugin is an identity function and createSwarmTool
// passes `args` through, so execute-path tests never touch the schema. Strict
// hosts strip undeclared fields BEFORE execute runs — this suite pins that the
// alias names are actually declared on the tool contract.

describe('swarm_apply_patch args schema declares the payload aliases (#2206)', () => {
	const args = swarmApplyPatch.args as Record<string, unknown>;

	test('patch, patchText, patch_text, and patchPayload are all declared', () => {
		expect(Object.keys(args)).toContain('patch');
		expect(Object.keys(args)).toContain('patchText');
		expect(Object.keys(args)).toContain('patch_text');
		expect(Object.keys(args)).toContain('patchPayload');
	});

	test('an alias-only invocation validates against the declared schema (strict hosts pass it through)', () => {
		const schema = z.object(args as z.ZodRawShape);
		const aliasOnly = schema.safeParse({
			patchText: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
			files: ['f'],
		});
		expect(aliasOnly.success).toBe(true);
		// `patch` is optional: an alias-only payload must not fail on the
		// missing canonical field.
		const noCanonicalIssues = aliasOnly.success
			? (aliasOnly.data as Record<string, unknown>)
			: {};
		expect(noCanonicalIssues.patchText).toBeDefined();
	});

	test('the declared schema still rejects invalid shapes (files min 1)', () => {
		const schema = z.object(args as z.ZodRawShape);
		expect(schema.safeParse({ patch: 'x', files: [] }).success).toBe(false);
		expect(schema.safeParse({ files: ['f'] }).success).toBe(true);
	});
});
