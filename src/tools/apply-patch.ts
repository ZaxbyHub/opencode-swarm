/**
 * apply-patch — Native Swarm tool for applying unified diffs in-process.
 * Parses standard unified diff format, validates paths against workspace
 * boundaries, matches hunk context exactly, and writes atomically.
 *
 * FR-001 through FR-014, SR-002 through SR-005.
 * Pure TypeScript, no shell/git/external binaries, standard node:fs sync I/O.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { findClosestLines, fuzzyFindAndReplace } from '../utils/fuzzy-match';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

/**
 * DI seam for hermetic config-load substitution in tests (AGENTS.md invariant 7).
 * Mirrors the pattern at `src/tools/context-status.ts:81-88`. Tests override
 * `_internals.loadPluginConfigWithMeta` and restore it in `afterEach` instead
 * of writing real config files or using `mock.module` (which leaks across
 * test files in Bun's shared runner).
 */
export const _internals = {
	loadPluginConfigWithMeta,
};

// ============ Types ============

/** A single line within a parsed hunk. */
interface HunkLine {
	type: 'context' | 'addition' | 'removal';
	content: string;
}

/** A single parsed hunk from a unified diff. */
interface ParsedHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: HunkLine[];
}

/** A parsed file diff containing one or more hunks. */
interface ParsedFileDiff {
	oldPath: string | null;
	newPath: string | null;
	isNewFile: boolean;
	isDelete: boolean;
	hunks: ParsedHunk[];
}

/** Per-file error detail in the structured output. */
export interface ApplyPatchFileError {
	hunkIndex: number;
	type:
		| 'context-mismatch'
		| 'file-not-found'
		| 'file-unchanged'
		| 'create-not-allowed'
		| 'delete-not-allowed'
		| 'binary-rejected'
		| 'rename-rejected';
	message: string;
	expected?: string;
	actual?: string;
	line?: number;
}

/** Per-file result in the structured output. */
export interface ApplyPatchFileResult {
	file: string;
	status: 'applied' | 'no-changes' | 'created' | 'error';
	hunks: number;
	hunksApplied: number;
	hunksFailed: number;
	errors?: ApplyPatchFileError[];
}

/** Structured JSON result returned by the tool. */
export interface ApplyPatchResult {
	success: boolean;
	dryRun?: boolean;
	files: ApplyPatchFileResult[];
	summary: {
		totalFiles: number;
		applied: number;
		failed: number;
		totalHunks: number;
	};
}

/** Arguments accepted by the apply_patch tool. */
export interface ApplyPatchArgs {
	patch: string;
	files: string[];
	dryRun?: boolean;
	allowCreates?: boolean;
	allowDeletes?: boolean;
}

// ============ Constants ============

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|:|$)/i;
const MAX_PATCH_SIZE = 500_000; // ~500KB to prevent pathological inputs

// ============ Path Validation ============

/**
 * Check for Windows-specific path attacks (reserved device names, colon injection).
 * Matches the pattern from suggest-patch.ts.
 */
function containsWindowsAttacks(filePath: string): boolean {
	if (/:[^\\/]/.test(filePath)) return true;
	const parts = filePath.split(/[/\\]/);
	for (const part of parts) {
		if (WINDOWS_RESERVED_NAMES.test(part)) return true;
	}
	return false;
}

/**
 * Check whether a path targets a protected directory (.git/, .swarm/).
 * Rejects ANY occurrence of .git or .swarm in the path (not just first segment).
 */
function isProtectedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	const segments = normalized.split('/');
	return segments.some((seg) => seg === '.git' || seg === '.swarm');
}

/**
 * Check for strict control characters (\x00-\x1F excluding \x09 tab).
 */
function containsStrictControlChars(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		if (c <= 0x1f && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
	}
	return false;
}

/**
 * Check whether a canonical path contains a protected directory (.git/, .swarm/).
 * Prevents symlink-based bypass: a symlink like `link/config` pointing to
 * `.git/` would pass lexical isProtectedPath but must be caught here.
 */
function isCanonicalProtectedPath(
	targetPath: string,
	workspace: string,
): boolean {
	try {
		const canonicalTarget = realpathSync(targetPath);
		const canonicalWorkspace = realpathSync(workspace);
		const relative = path
			.relative(canonicalWorkspace, canonicalTarget)
			.replace(/\\/g, '/');
		const segments = relative.split('/').filter(Boolean);
		return segments.some((seg) => seg === '.git' || seg === '.swarm');
	} catch {
		// Path doesn't exist — check parent directory's canonical segments
		const parentDir = path.dirname(targetPath);
		if (parentDir === targetPath) return false;
		try {
			const canonicalParent = realpathSync(parentDir);
			const canonicalWorkspace = realpathSync(workspace);
			const relative = path
				.relative(canonicalWorkspace, canonicalParent)
				.replace(/\\/g, '/');
			const segments = relative.split('/').filter(Boolean);
			return segments.some((seg) => seg === '.git' || seg === '.swarm');
		} catch {
			return false;
		}
	}
}

/**
 * Check whether a canonical (symlink-resolved) path is within the workspace.
 *
 * For existing files/dirs, resolves the path itself via realpathSync.
 * For paths that don't exist yet (e.g. new file creates), resolves the parent
 * directory instead to prevent symlink escapes through intermediate components.
 * Also re-checks protected-directory ban (.git, .swarm) on the canonical path.
 *
 * @returns true if the canonical path is safely contained within workspaceRoot.
 */
function isCanonicalPathWithinWorkspace(
	targetPath: string,
	workspaceRoot: string,
): boolean {
	try {
		const canonicalTarget = realpathSync(targetPath);
		const canonicalWorkspace = realpathSync(workspaceRoot);
		const relative = path.relative(canonicalWorkspace, canonicalTarget);
		if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
		// Re-apply protected-directory ban on the canonical target (all segments)
		const segments = relative.replace(/\\/g, '/').split('/').filter(Boolean);
		if (segments.some((seg) => seg === '.git' || seg === '.swarm'))
			return false;
		return true;
	} catch {
		// realpathSync failed (path doesn't exist) — validate parent directory instead
		const parentDir = path.dirname(targetPath);
		if (parentDir === targetPath) {
			// Can't go higher (e.g. root) — reject
			return false;
		}
		try {
			const canonicalParent = realpathSync(parentDir);
			const canonicalWorkspace = realpathSync(workspaceRoot);
			const relative = path.relative(canonicalWorkspace, canonicalParent);
			if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
			// Re-apply protected-directory ban on the canonical parent (all segments)
			const segments = relative.replace(/\\/g, '/').split('/').filter(Boolean);
			if (segments.some((seg) => seg === '.git' || seg === '.swarm'))
				return false;
			return true;
		} catch {
			// Parent also doesn't resolve — fall back to lexical check
			// (caller should handle missing-parent errors separately)
			return false;
		}
	}
}

/**
 * Validate that a patch target path is safe and within the workspace boundary.
 * Rejects: absolute paths, traversal, control chars, Windows attacks, protected dirs.
 * Uses containsPathTraversal and containsControlChars from ../utils/path-security.
 */
function validatePatchTargetPath(
	filePath: string,
	workspace: string,
): string | null {
	if (!filePath || filePath.trim() === '') {
		return 'Empty file path';
	}
	if (path.isAbsolute(filePath) || /^[A-Za-z]:[/\\]/.test(filePath)) {
		return `Absolute path rejected: ${filePath}`;
	}
	if (containsPathTraversal(filePath)) {
		return `Path traversal detected: ${filePath}`;
	}
	if (containsStrictControlChars(filePath)) {
		return `Control characters detected in path: ${filePath}`;
	}
	// Also leverage the shared utility for additional patterns
	if (containsControlChars(filePath)) {
		return `Control characters detected in path: ${filePath}`;
	}
	if (containsWindowsAttacks(filePath)) {
		return `Windows reserved name or invalid path: ${filePath}`;
	}
	if (isProtectedPath(filePath)) {
		return `Protected directory target rejected: ${filePath}`;
	}

	// Verify the resolved path stays within the workspace (lexical check)
	const resolved = path.resolve(workspace, filePath);
	const relative = path.relative(workspace, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return `Path escapes workspace: ${filePath}`;
	}

	// Symlink/junction escape check: verify canonical path stays within workspace
	if (!isCanonicalPathWithinWorkspace(resolved, workspace)) {
		return `Path escapes workspace via symlink/junction: ${filePath}`;
	}

	return null; // valid
}

// ============ Unified Diff Parser ============

/**
 * Extract the file path from a --- or +++ header line.
 * Handles a/, b/ prefixes and /dev/null.
 */
function extractHeaderPath(header: string, prefix: string): string | null {
	const trimmed = header.trim();
	if (!trimmed.startsWith(prefix)) return null;

	const rest = trimmed.slice(prefix.length).trim();
	if (rest === '/dev/null') return '/dev/null';

	// Strip a/ or b/ prefix (standard git diff format)
	if (rest.startsWith('a/') || rest.startsWith('b/')) {
		const stripped = rest.slice(2);
		if (stripped.length === 0) return null;
		return stripped;
	}

	return rest.length > 0 ? rest : null;
}

/**
 * Parse a @@ hunk header line.
 */
function parseHunkHeader(line: string): {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
} | null {
	const match = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
	if (!match) return null;

	return {
		oldStart: parseInt(match[1], 10),
		oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
		newStart: parseInt(match[3], 10),
		newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
	};
}

/**
 * Parse a complete unified diff string into structured ParsedFileDiff objects.
 * Rejects binary patches, rename/copy patches, and null bytes.
 *
 * Supports:
 * 1. Extended git format: `diff --git a/foo b/foo` followed by ---/+++ headers
 * 2. Standalone unified format: --- / +++ headers without git prefix
 */
function parseUnifiedDiff(patchText: string): {
	files: ParsedFileDiff[];
	error: string | null;
} {
	if (patchText.length > MAX_PATCH_SIZE) {
		return {
			files: [],
			error: `Patch exceeds maximum size of ${MAX_PATCH_SIZE} characters`,
		};
	}

	// Reject null bytes (binary content detection)
	if (patchText.includes('\0')) {
		return {
			files: [],
			error:
				'Binary content detected (null byte) — binary patches are not supported (FR-013)',
		};
	}

	// Normalize line endings to \n for consistent parsing
	const normalized = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	let lines = normalized.split('\n');
	// Strip trailing empty element produced by split when patch ends with \n
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines = lines.slice(0, -1);
	}

	// Reject binary patches
	for (const line of lines) {
		if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
			return { files: [], error: 'Binary patches are not supported (FR-013)' };
		}
		// Reject rename/copy patches
		if (
			line.startsWith('rename from') ||
			line.startsWith('rename to') ||
			line.startsWith('copy from') ||
			line.startsWith('copy to')
		) {
			return {
				files: [],
				error: 'Rename/copy patches are not supported (FR-013)',
			};
		}
	}

	const fileDiffs: ParsedFileDiff[] = [];
	let i = 0;

	while (i < lines.length) {
		let oldHeaderPath: string | null = null;
		let newHeaderPath: string | null = null;

		if (lines[i].startsWith('diff --git ')) {
			// Extended git format — skip to ---/+++
			i++;

			// Skip optional mode/index/similarity lines
			while (
				i < lines.length &&
				(lines[i].startsWith('index ') ||
					lines[i].startsWith('old mode ') ||
					lines[i].startsWith('new mode ') ||
					lines[i].startsWith('deleted file ') ||
					lines[i].startsWith('new file ') ||
					lines[i].startsWith('similarity index ') ||
					lines[i].startsWith('dissimilarity index '))
			) {
				i++;
			}
		}

		// Parse --- header
		if (i < lines.length && lines[i].startsWith('--- ')) {
			oldHeaderPath = extractHeaderPath(lines[i], '--- ');
			i++;
		} else if (oldHeaderPath === null) {
			// No diff header and no --- line — skip
			i++;
			continue;
		}

		// Parse +++ header
		if (i < lines.length && lines[i].startsWith('+++ ')) {
			newHeaderPath = extractHeaderPath(lines[i], '+++ ');
			i++;
		} else {
			continue; // Missing +++ — skip
		}

		if (oldHeaderPath === null || newHeaderPath === null) {
			continue;
		}

		const isNewFile = oldHeaderPath === '/dev/null';
		const isDelete = newHeaderPath === '/dev/null';
		const targetPath = isDelete ? oldHeaderPath : newHeaderPath;

		if (targetPath === '/dev/null') {
			continue; // Both sides /dev/null — nothing to apply
		}

		// Parse hunks
		const hunks: ParsedHunk[] = [];
		while (i < lines.length && lines[i].startsWith('@@')) {
			const header = parseHunkHeader(lines[i]);
			if (!header) {
				i++;
				continue;
			}
			i++;

			const hunkLines: HunkLine[] = [];
			while (i < lines.length) {
				const line = lines[i];
				if (
					line.startsWith('@@') ||
					line.startsWith('diff --git ') ||
					line.startsWith('--- ') ||
					line.startsWith('+++ ')
				) {
					break; // Next hunk or next file
				}

				if (line.startsWith('\\')) {
					// "\ No newline at end of file" marker — skip
					i++;
					continue;
				}

				// Defense-in-depth: only process lines with valid diff prefixes
				if (line.length === 0) {
					break; // Empty line signals end of hunk body
				}

				const firstChar = line[0];
				if (firstChar !== ' ' && firstChar !== '+' && firstChar !== '-') {
					break; // Unknown prefix — end of hunk body
				}

				if (firstChar === '+') {
					hunkLines.push({ type: 'addition', content: line.slice(1) });
				} else if (firstChar === '-') {
					hunkLines.push({ type: 'removal', content: line.slice(1) });
				} else {
					// Space-prefixed = context
					hunkLines.push({ type: 'context', content: line.slice(1) });
				}
				i++;
			}

			hunks.push({
				oldStart: header.oldStart,
				oldCount: header.oldCount,
				newStart: header.newStart,
				newCount: header.newCount,
				lines: hunkLines,
			});
		}

		if (hunks.length > 0) {
			fileDiffs.push({
				oldPath: oldHeaderPath,
				newPath: newHeaderPath,
				isNewFile,
				isDelete,
				hunks,
			});
		} else {
			// Zero hunks but valid headers — produce a no-changes file entry
			fileDiffs.push({
				oldPath: oldHeaderPath,
				newPath: newHeaderPath,
				isNewFile,
				isDelete,
				hunks: [],
			});
		}
	}

	return { files: fileDiffs, error: null };
}

// ============ Hunk Application ============

/**
 * Result of applying hunks to file content.
 */
interface HunkApplyResult {
	success: boolean;
	appliedLines?: string[];
	failedHunkIndex?: number;
	error?: ApplyPatchFileError;
	/**
	 * Set when a fuzzy fallback was attempted (config flag on) and failed.
	 * Used by `processFileDiff` to append a "did you mean?" hint to the
	 * diagnostic message — only when fuzzy actually ran and still missed.
	 */
	fuzzyAttempted?: boolean;
}

/**
 * Opt-in fuzzy-matching options threaded from `execute` → `processFileDiff`
 * → `applyHunks`. Both flags default false (exact-match-only, B3 decision).
 */
export interface ApplyHunksOptions {
	/** Enable fuzzy fallback (strategies 1-8) on exact-match failure. */
	fuzzyMatch: boolean;
	/** Additionally enable strategy 9 (context_aware). Only effective with fuzzyMatch. */
	fuzzyMatchContextAware: boolean;
}

/**
 * Check if two string arrays have identical content.
 */
function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let idx = 0; idx < a.length; idx++) {
		if (a[idx] !== b[idx]) return false;
	}
	return true;
}

/**
 * Attempt to apply all hunks from a ParsedFileDiff to the given file content.
 * Hunks are applied sequentially; on first failure, stops and returns diagnostics.
 *
 * Matching strategy:
 * - **Default (no options, or `fuzzyMatch: false`):** exact positional context
 *   matching only — the B3 decision. No fuzzy or offset matching.
 * - **Opt-in (`fuzzyMatch: true`):** on exact-match failure, retries the
 *   hermes-derived fuzzy text-matching chain (strategies 1-8) as a tolerance
 *   layer before returning diagnostics. `fuzzyMatchContextAware: true` adds
 *   strategy 9 (loosest). The exact `arraysEqual` path is never removed.
 *
 * Fuzzy is a per-hunk tolerance layer, not a whole-diff position searcher.
 * If a fuzzy relocation overlaps a later hunk's declared context, that later
 * hunk may still report a clean context-mismatch (not file corruption).
 *
 * @returns HunkApplyResult with success/appliedLines or the first failing hunk's diagnostics.
 */
function applyHunks(
	content: string,
	fileDiff: ParsedFileDiff,
	options?: ApplyHunksOptions,
): HunkApplyResult {
	// Normalize CRLF to LF so context matching works regardless of file line endings
	const normalizedContent = content.replace(/\r\n/g, '\n');
	const fileLines = normalizedContent.split('\n');

	// Handle new file creation (no existing content to match against)
	if (fileDiff.isNewFile) {
		const newLines: string[] = [];
		for (const hunk of fileDiff.hunks) {
			for (const line of hunk.lines) {
				if (line.type === 'addition' || line.type === 'context') {
					newLines.push(line.content);
				}
				// Removal lines in new file patch are unexpected but skip them
			}
		}
		return { success: true, appliedLines: newLines };
	}

	// Handle delete patches — result is empty
	if (fileDiff.isDelete) {
		return { success: true, appliedLines: [] };
	}

	// Track accumulated delta so subsequent hunks match at the correct
	// adjusted position after prior hunks changed line counts.
	let accumulatedDelta = 0;

	for (let hunkIdx = 0; hunkIdx < fileDiff.hunks.length; hunkIdx++) {
		const hunk = fileDiff.hunks[hunkIdx];
		// Reset per-hunk: true when fuzzy fallback ran and still missed.
		let fuzzyAttemptedThisHunk = false;

		// Compute match position: declared position adjusted by accumulated delta from prior hunks
		const searchStart = Math.max(0, hunk.oldStart - 1 + accumulatedDelta);

		// Extract expected context and removal lines from the hunk
		const expectedOldLines: string[] = [];
		const newLinesForHunk: string[] = [];

		for (const line of hunk.lines) {
			if (line.type === 'context') {
				expectedOldLines.push(line.content);
				newLinesForHunk.push(line.content);
			} else if (line.type === 'removal') {
				expectedOldLines.push(line.content);
			} else if (line.type === 'addition') {
				newLinesForHunk.push(line.content);
			}
		}

		// Match ONLY at the exact position specified by the hunk header.
		// No forward/backward search — if context shifted, report mismatch.
		const exactOffset = searchStart;
		const matchFound =
			exactOffset <= fileLines.length - expectedOldLines.length &&
			arraysEqual(
				fileLines.slice(exactOffset, exactOffset + expectedOldLines.length),
				expectedOldLines,
			);

		if (matchFound) {
			fileLines.splice(
				exactOffset,
				expectedOldLines.length,
				...newLinesForHunk,
			);
			const delta = newLinesForHunk.length - expectedOldLines.length;
			accumulatedDelta += delta;
		} else if (options?.fuzzyMatch) {
			// Opt-in fuzzy fallback (issue #1718): when exact positional match
			// fails and the config flag is set, retry via the hermes-derived
			// fuzzy chain. We feed the in-progress content (which already
			// reflects prior-hunk edits) so earlier hunks are preserved.
			//
			// `replaceAll: false` enforces uniqueness — the ambiguity guard
			// fails rather than writing an ambiguous patch. The line-count
			// delta uses the hunk's declared lines (fuzzy strategies preserve
			// line counts; they transform within-line whitespace/unicode).
			const currentContent = fileLines.join('\n');
			const oldString = expectedOldLines.join('\n');
			const newString = newLinesForHunk.join('\n');
			const fuzzy = fuzzyFindAndReplace(
				currentContent,
				oldString,
				newString,
				false,
				{
					includeContextAware: options.fuzzyMatchContextAware,
				},
			);
			if (fuzzy.error === null && fuzzy.matchCount === 1) {
				fileLines.length = 0;
				// Push line-by-line rather than `fileLines.push(...split('\n'))`:
				// the spread-into-push form throws RangeError on very large line
				// counts (~125k on Node, ~700k on Bun) because it routes through
				// Function.prototype.apply, which is stack-bound. The loop has no
				// such limit. (PRR-003 from the PR review.)
				for (const line of fuzzy.content.split('\n')) fileLines.push(line);
				accumulatedDelta += newLinesForHunk.length - expectedOldLines.length;
				continue; // next hunk — skip the mismatch return below
			}
			// Fuzzy also failed — fall through to the context-mismatch return,
			// flagging that fuzzy was attempted so the caller can append a hint.
			fuzzyAttemptedThisHunk = true;
		}

		if (!matchFound) {
			// Build diagnostic: show expected vs actual at the expected location
			const diagStart = Math.min(searchStart, fileLines.length);
			const diagEnd = Math.min(
				diagStart + expectedOldLines.length,
				fileLines.length,
			);
			const actualContent = fileLines.slice(diagStart, diagEnd).join('\n');
			const expectedContent = expectedOldLines.join('\n');

			return {
				success: false,
				failedHunkIndex: hunkIdx,
				fuzzyAttempted: fuzzyAttemptedThisHunk ? true : undefined,
				error: {
					hunkIndex: hunkIdx,
					type: 'context-mismatch',
					message: `Context mismatch in hunk ${hunkIdx + 1} at line ${searchStart + 1}: expected context does not match file content`,
					expected:
						expectedContent.length > 200
							? `${expectedContent.slice(0, 200)}... (truncated)`
							: expectedContent,
					actual:
						actualContent.length > 200
							? `${actualContent.slice(0, 200)}... (truncated)`
							: actualContent,
					line: searchStart + 1,
				},
			};
		}
	}

	return { success: true, appliedLines: fileLines };
}

// ============ Atomic Write ============

/**
 * Atomically write content to a file using temp-file + rename.
 * The temp file is created in the same directory as the target to ensure
 * the rename stays on the same filesystem.
 * Uses node:fs sync I/O (SR-003). On failure, cleans up the temp file.
 */
function atomicWriteFileSync(targetPath: string, content: string): void {
	const dir = path.dirname(targetPath);
	mkdirSync(dir, { recursive: true });

	// Create a temporary file in the same directory for same-filesystem rename
	const tempPrefix = `.apply-patch-${Date.now()}-${process.pid}`;
	let tempPath: string;
	try {
		const tempDir = realpathSync(mkdtempSync(path.join(dir, tempPrefix)));
		tempPath = path.join(tempDir, 'content');
	} catch {
		// Fallback: create a temp file directly in the target directory
		tempPath = path.join(dir, `${tempPrefix}.tmp`);
	}

	try {
		writeFileSync(tempPath, content, 'utf-8');
		renameSync(tempPath, targetPath);
	} finally {
		// Best-effort cleanup of temp file if rename failed
		if (existsSync(tempPath)) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Temp file may have already been renamed — ignore
			}
		}
		// Best-effort cleanup of temp directory if it was created
		const tempDir = path.dirname(tempPath);
		if (tempDir !== dir && existsSync(tempDir)) {
			try {
				rmdirSync(tempDir);
			} catch {
				// Directory not empty or already removed — ignore
			}
		}
	}
}

// ============ Final Newline Preservation ============

/**
 * Detect the dominant line ending in a string.
 * Returns '\r\n' if CRLF is present, '\n' otherwise.
 */
function detectLineEnding(content: string): '\r\n' | '\n' {
	return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Ensure content ends with a newline consistent with the original file (FR-014).
 * If original ended with \n, result must end with \n.
 * If original had no trailing newline, don't add one unless the patch explicitly adds it.
 */
function ensureFinalNewline(
	content: string,
	originalEndsWithNewline: boolean,
): string {
	if (originalEndsWithNewline && !content.endsWith('\n')) {
		return `${content}\n`;
	}
	if (!originalEndsWithNewline && content.endsWith('\n')) {
		return content.slice(0, -1);
	}
	return content;
}

// ============ Per-File Processing ============

/**
 * Process a single file diff: validate, apply hunks, write atomically.
 * Returns a per-file result with hunk-level diagnostics.
 */
function processFileDiff(
	fileDiff: ParsedFileDiff,
	targetPath: string,
	fullPath: string,
	workspace: string,
	dryRun: boolean,
	allowCreates: boolean,
	allowDeletes: boolean,
	hunkOptions?: ApplyHunksOptions,
): ApplyPatchFileResult {
	const hunksTotal = fileDiff.hunks.length;

	// Canonical path boundary check — prevent symlink/junction escape
	// This validates the actual on-disk location before any I/O operations
	if (!isCanonicalPathWithinWorkspace(fullPath, workspace)) {
		return {
			file: targetPath,
			status: 'error',
			hunks: hunksTotal,
			hunksApplied: 0,
			hunksFailed: hunksTotal,
			errors: [
				{
					hunkIndex: 0,
					type: 'context-mismatch',
					message: `Path escapes workspace via symlink/junction: ${targetPath}`,
				},
			],
		};
	}

	// Canonical protected-directory check — prevent symlink to .git/.swarm
	if (isCanonicalProtectedPath(fullPath, workspace)) {
		return {
			file: targetPath,
			status: 'error',
			hunks: hunksTotal,
			hunksApplied: 0,
			hunksFailed: hunksTotal,
			errors: [
				{
					hunkIndex: 0,
					type: 'context-mismatch',
					message: `Protected directory target rejected via symlink: ${targetPath}`,
				},
			],
		};
	}

	// Handle new file creation (FR-011)
	if (fileDiff.isNewFile) {
		if (!allowCreates) {
			return {
				file: targetPath,
				status: 'error',
				hunks: hunksTotal,
				hunksApplied: 0,
				hunksFailed: hunksTotal,
				errors: [
					{
						hunkIndex: 0,
						type: 'create-not-allowed',
						message: `New file creation not allowed: ${targetPath} (set allowCreates to true)`,
					},
				],
			};
		}

		// Verify parent directory exists
		const parentDir = path.dirname(fullPath);
		if (!existsSync(parentDir)) {
			return {
				file: targetPath,
				status: 'error',
				hunks: hunksTotal,
				hunksApplied: 0,
				hunksFailed: hunksTotal,
				errors: [
					{
						hunkIndex: 0,
						type: 'file-not-found',
						message: `Parent directory does not exist: ${parentDir}`,
					},
				],
			};
		}

		// Verify file doesn't already exist (stale patch detection)
		if (existsSync(fullPath)) {
			return {
				file: targetPath,
				status: 'error',
				hunks: hunksTotal,
				hunksApplied: 0,
				hunksFailed: hunksTotal,
				errors: [
					{
						hunkIndex: 0,
						type: 'file-not-found',
						message: `File already exists: ${targetPath} (cannot create — patch may be stale)`,
					},
				],
			};
		}

		if (hunksTotal === 0) {
			return {
				file: targetPath,
				status: 'no-changes',
				hunks: 0,
				hunksApplied: 0,
				hunksFailed: 0,
			};
		}

		// Apply hunks for new file (extract addition lines)
		const hunkResult = applyHunks('', fileDiff);
		if (!hunkResult.success || !hunkResult.appliedLines) {
			return {
				file: targetPath,
				status: 'error',
				hunks: hunksTotal,
				hunksApplied: 0,
				hunksFailed: hunksTotal,
				errors: hunkResult.error ? [hunkResult.error] : [],
			};
		}

		if (!dryRun) {
			const content = ensureFinalNewline(
				hunkResult.appliedLines.join('\n'),
				true,
			);
			atomicWriteFileSync(fullPath, content);
		}

		return {
			file: targetPath,
			status: 'created',
			hunks: hunksTotal,
			hunksApplied: hunksTotal,
			hunksFailed: 0,
		};
	}

	// Handle file deletion (FR-012)
	if (fileDiff.isDelete) {
		if (hunksTotal === 0) {
			return {
				file: targetPath,
				status: 'no-changes',
				hunks: 0,
				hunksApplied: 0,
				hunksFailed: 0,
			};
		}

		if (!allowDeletes) {
			return {
				file: targetPath,
				status: 'error',
				hunks: hunksTotal,
				hunksApplied: 0,
				hunksFailed: hunksTotal,
				errors: [
					{
						hunkIndex: 0,
						type: 'delete-not-allowed',
						message: `File deletion not allowed: ${targetPath} (set allowDeletes to true)`,
					},
				],
			};
		}

		if (!existsSync(fullPath)) {
			return {
				file: targetPath,
				status: 'error',
				hunks: hunksTotal,
				hunksApplied: 0,
				hunksFailed: hunksTotal,
				errors: [
					{
						hunkIndex: 0,
						type: 'file-not-found',
						message: `File not found for deletion: ${targetPath}`,
					},
				],
			};
		}

		if (!dryRun) {
			try {
				unlinkSync(fullPath);
			} catch (err) {
				return {
					file: targetPath,
					status: 'error',
					hunks: hunksTotal,
					hunksApplied: 0,
					hunksFailed: hunksTotal,
					errors: [
						{
							hunkIndex: 0,
							type: 'file-not-found',
							message: `Failed to delete file: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
				};
			}
		}

		return {
			file: targetPath,
			status: 'applied',
			hunks: hunksTotal,
			hunksApplied: hunksTotal,
			hunksFailed: 0,
		};
	}

	// --- Standard file modification path ---

	if (!existsSync(fullPath)) {
		return {
			file: targetPath,
			status: 'error',
			hunks: hunksTotal,
			hunksApplied: 0,
			hunksFailed: hunksTotal,
			errors: [
				{
					hunkIndex: 0,
					type: 'file-not-found',
					message: `File not found: ${targetPath}`,
				},
			],
		};
	}

	let content: string;
	try {
		content = readFileSync(fullPath, 'utf-8');
	} catch (err) {
		return {
			file: targetPath,
			status: 'error',
			hunks: hunksTotal,
			hunksApplied: 0,
			hunksFailed: hunksTotal,
			errors: [
				{
					hunkIndex: 0,
					type: 'file-not-found',
					message: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
		};
	}

	if (hunksTotal === 0) {
		return {
			file: targetPath,
			status: 'no-changes',
			hunks: 0,
			hunksApplied: 0,
			hunksFailed: 0,
		};
	}

	// Detect whether original file ends with a newline (FR-014)
	const originalEndsWithNewline = content.endsWith('\n');

	// Detect dominant line ending to preserve CRLF on write (Problem 2)
	const originalLineEnding = detectLineEnding(content);

	// Apply hunks with exact context matching (FR-010); opt-in fuzzy fallback
	// (issue #1718) retries the hermes chain when exact match fails and the
	// config flag is set.
	const hunkResult = applyHunks(content, fileDiff, hunkOptions);
	if (!hunkResult.success) {
		// When fuzzy was attempted and still missed, append a "did you mean?"
		// hint (ported from hermes) so the model can self-correct. We call
		// findClosestLines directly with the expected context as the anchor —
		// NOT formatNoMatchHint, whose message-prefix gate ("Could not find")
		// never matches apply-patch's "Context mismatch in hunk..." message
		// (the gate exists for hermes' shared caller where multiple error
		// types share matchCount=0; here we only call when fuzzy genuinely
		// failed, so direct findClosestLines is correct).
		let errors = hunkResult.error ? [hunkResult.error] : [];
		if (
			hunkResult.fuzzyAttempted &&
			errors.length > 0 &&
			hunkOptions?.fuzzyMatch
		) {
			const expectedAnchor = errors[0].expected ?? '';
			const hint = findClosestLines(expectedAnchor, content);
			if (hint) {
				errors = [
					{
						...errors[0],
						message: `${errors[0].message}\n\nDid you mean one of these sections?\n${hint}`,
					},
				];
			}
		}
		return {
			file: targetPath,
			status: 'error',
			hunks: hunksTotal,
			hunksApplied: 0,
			hunksFailed: hunksTotal,
			errors,
		};
	}

	// Build the result content (empty content requires allowDeletes — FR-012)
	const resultContent = hunkResult.appliedLines!.join('\n');

	// FR-012: Writing an empty file is a deletion — require allowDeletes
	if (resultContent === '' && !dryRun && !allowDeletes && content.length > 0) {
		return {
			file: targetPath,
			status: 'error',
			hunks: hunksTotal,
			hunksApplied: hunksTotal,
			hunksFailed: 0,
			errors: [
				{
					hunkIndex: 0,
					type: 'delete-not-allowed',
					message: `Patch would delete all content from ${targetPath}. Set allowDeletes to true to permit file deletion.`,
				},
			],
		};
	}

	// Empty files have no line endings to preserve — write "" directly
	// without line ending restoration (prevents extra newlines on empty content)
	let finalContent: string;
	if (resultContent === '') {
		finalContent = '';
	} else {
		// Re-apply the original line ending before comparison and write
		const withLineEnding =
			originalLineEnding === '\r\n'
				? resultContent.replace(/\n/g, '\r\n')
				: resultContent;
		finalContent = ensureFinalNewline(withLineEnding, originalEndsWithNewline);
	}
	if (finalContent === content) {
		return {
			file: targetPath,
			status: 'no-changes',
			hunks: hunksTotal,
			hunksApplied: hunksTotal,
			hunksFailed: 0,
		};
	}

	if (!dryRun) {
		atomicWriteFileSync(fullPath, finalContent);
	}

	return {
		file: targetPath,
		status: 'applied',
		hunks: hunksTotal,
		hunksApplied: hunksTotal,
		hunksFailed: 0,
	};
}

// ============ Error Result Builder ============

/**
 * Build an error result in the ApplyPatchResult shape.
 */
function buildErrorResult(message: string): ApplyPatchResult {
	return {
		success: false,
		files: [
			{
				file: '',
				status: 'error',
				hunks: 0,
				hunksApplied: 0,
				hunksFailed: 0,
				errors: [
					{
						hunkIndex: 0,
						type: 'context-mismatch',
						message,
					},
				],
			},
		],
		summary: {
			totalFiles: 0,
			applied: 0,
			failed: 1,
			totalHunks: 0,
		},
	};
}

// ============ Unsupported Format Detection ============

/**
 * Detect the *** Begin Patch / *** Update File style payload that opencode's
 * native apply_patch tool uses. The Swarm unified-diff tool does NOT support
 * this format and must hard-fail rather than silently returning no-op success.
 */
function isUnsupportedPatchFormat(patchText: string): boolean {
	const trimmed = patchText.trimStart();
	return (
		trimmed.startsWith('*** Begin Patch') ||
		trimmed.startsWith('*** Update File') ||
		trimmed.startsWith('*** Add File') ||
		trimmed.startsWith('*** Delete File') ||
		trimmed.startsWith('*** End Patch')
	);
}

// ============ Tool Definition ============

/**
 * Swarm unified-diff patch tool (formerly registered as apply_patch).
 * Renamed to swarm_apply_patch so it no longer shadows the native opencode
 * apply_patch tool. The native tool handles *** Begin Patch / *** Update File
 * style payloads; this tool handles standard unified diffs only.
 */
export const swarmApplyPatch: ToolDefinition = createSwarmTool({
	description:
		'Apply a unified diff patch to workspace files. Validates paths, matches context exactly, and writes atomically. Coder-scoped write tool. Use standard unified diff format (--- a/file / +++ b/file / @@ hunks). Does NOT support *** Begin Patch / *** Update File payloads — use the native apply_patch tool for those.',
	args: {
		patch: z.string().min(1).describe('Unified diff text to parse and apply'),
		files: z
			.array(z.string())
			.min(1)
			.describe(
				'Array of target file paths the patch is expected to touch. Every parsed target must appear in this list.',
			),
		dryRun: z
			.boolean()
			.optional()
			.default(false)
			.describe('Validate without writing files (default: false)'),
		allowCreates: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Allow creating new files from patches with --- /dev/null (default: false)',
			),
		allowDeletes: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Allow deleting files from patches with +++ /dev/null (default: false)',
			),
	},
	execute: async (args: unknown, directory: string): Promise<string> => {
		// Safe args extraction
		if (!args || typeof args !== 'object') {
			return JSON.stringify(
				buildErrorResult('Could not parse swarm_apply_patch arguments'),
				null,
				2,
			);
		}

		const obj = args as Record<string, unknown>;
		const patchText = (obj.patch as string) ?? '';
		const files = (obj.files as string[]) ?? [];
		const dryRun = (obj.dryRun as boolean) ?? false;
		const allowCreates = (obj.allowCreates as boolean) ?? false;
		const allowDeletes = (obj.allowDeletes as boolean) ?? false;

		// Load opt-in fuzzy-match config (issue #1718). Default off — preserves
		// the B3 exact-match decision. Loaded once per invocation via the
		// `_internals` DI seam so tests can substitute hermetically.
		const { config } = _internals.loadPluginConfigWithMeta(directory);
		const fuzzyMatch = config.apply_patch?.fuzzy_match === true;
		const fuzzyMatchContextAware =
			config.apply_patch?.fuzzy_match_context_aware === true;
		const hunkOptions: ApplyHunksOptions | undefined =
			fuzzyMatch || fuzzyMatchContextAware
				? { fuzzyMatch, fuzzyMatchContextAware }
				: undefined;

		// Validate workspace directory
		if (!existsSync(directory)) {
			return JSON.stringify(
				buildErrorResult('Workspace directory does not exist'),
				null,
				2,
			);
		}

		// Validate files array
		if (files.length === 0) {
			return JSON.stringify(
				buildErrorResult('files array cannot be empty'),
				null,
				2,
			);
		}

		// Validate patch text
		if (!patchText || patchText.trim() === '') {
			return JSON.stringify(
				buildErrorResult('patch text cannot be empty'),
				null,
				2,
			);
		}

		// Hard-fail unsupported *** Begin Patch / *** Update File format payloads.
		// These are produced by opencode's native apply_patch tool and are NOT
		// unified diffs. Returning success/no-op for them would silently swallow
		// the payload. Callers must use the native apply_patch tool instead.
		if (isUnsupportedPatchFormat(patchText)) {
			return JSON.stringify(
				buildErrorResult(
					'Unsupported patch format: *** Begin Patch / *** Update File style payloads are not supported by swarm_apply_patch. ' +
						'Use the native apply_patch tool for this format, or provide a standard unified diff (--- a/file / +++ b/file / @@ hunks).',
				),
				null,
				2,
			);
		}

		// Validate all declared file paths up front (FR-003, SR-005)
		for (const filePath of files) {
			const validationError = validatePatchTargetPath(filePath, directory);
			if (validationError) {
				return JSON.stringify(buildErrorResult(validationError), null, 2);
			}
		}

		// Parse the unified diff (FR-001, FR-013)
		const { files: parsedFiles, error: parseError } =
			parseUnifiedDiff(patchText);
		if (parseError) {
			return JSON.stringify(buildErrorResult(parseError), null, 2);
		}

		if (parsedFiles.length === 0) {
			return JSON.stringify(
				{
					success: true,
					dryRun,
					files: [],
					summary: { totalFiles: 0, applied: 0, failed: 0, totalHunks: 0 },
				} satisfies ApplyPatchResult,
				null,
				2,
			);
		}

		// FR-002: Every parsed target must appear in files[]
		const declaredFileSet = new Set(files);
		const undeclaredTargets: string[] = [];
		for (const fileDiff of parsedFiles) {
			const targetPath = fileDiff.isDelete
				? fileDiff.oldPath
				: fileDiff.newPath;
			if (
				targetPath &&
				targetPath !== '/dev/null' &&
				!declaredFileSet.has(targetPath)
			) {
				undeclaredTargets.push(targetPath);
			}
		}
		if (undeclaredTargets.length > 0) {
			return JSON.stringify(
				buildErrorResult(
					`Patch targets files not in the declared files array: ${undeclaredTargets.join(', ')}`,
				),
				null,
				2,
			);
		}

		// Warn for extra entries in files[] not targeted by the patch
		const parsedTargetSet = new Set(
			parsedFiles
				.map((fd) => (fd.isDelete ? fd.oldPath : fd.newPath))
				.filter(Boolean),
		);
		const extraFiles = files.filter((f) => !parsedTargetSet.has(f));

		// Process each file independently (D1 decision: partial across files)
		const fileResults: ApplyPatchFileResult[] = [];
		let totalApplied = 0;
		let totalFailed = 0;
		let totalHunks = 0;

		for (const fileDiff of parsedFiles) {
			const targetPath = fileDiff.isDelete
				? fileDiff.oldPath!
				: fileDiff.newPath!;
			const fullPath = path.resolve(directory, targetPath);
			totalHunks += fileDiff.hunks.length;

			const result = processFileDiff(
				fileDiff,
				targetPath,
				fullPath,
				directory,
				dryRun,
				allowCreates,
				allowDeletes,
				hunkOptions,
			);

			fileResults.push(result);
			if (result.status === 'applied' || result.status === 'created') {
				totalApplied++;
			} else if (result.status === 'error') {
				totalFailed++;
			}
		}

		const output: ApplyPatchResult = {
			success: totalFailed === 0,
			dryRun,
			files: fileResults,
			summary: {
				totalFiles: fileResults.length,
				applied: totalApplied,
				failed: totalFailed,
				totalHunks,
			},
		};

		// Include warnings for extra files if any
		if (extraFiles.length > 0) {
			return JSON.stringify(
				{
					...output,
					warnings: [
						`files[] contains entries not targeted by the patch: ${extraFiles.join(', ')}`,
					],
				},
				null,
				2,
			);
		}

		return JSON.stringify(output, null, 2);
	},
});
