// Reviewer-safe structured patch suggestion tool — produces patch artifacts without file modification

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

// ============ Types ============

export interface PatchHunk {
	file: string;
	originalContext: string[]; // surrounding lines used as anchor
	newContent: string; // the replacement content
	hunkIndex: number;
}

export interface PatchSuggestion {
	success: true;
	patches: PatchHunk[];
	filesModified: string[];
	errors?: PatchError[];
}

export interface PatchError {
	success: false;
	error: true;
	type: 'context-mismatch' | 'file-not-found' | 'parse-error' | 'unknown';
	message: string;
	details?: {
		expected?: string; // what was expected at anchor location
		actual?: string; // what was actually found
		location?: string; // file:line where mismatch occurred
	};
	errors?: PatchError[];
}

export interface ChangeDescription {
	file: string;
	contextBefore?: string[]; // lines before the change (anchor)
	contextAfter?: string[]; // lines after the change (anchor)
	oldContent?: string; // content to replace
	newContent: string; // replacement content
}

export interface SuggestPatchArgs {
	targetFiles: string[];
	changes: ChangeDescription[];
	format?: 'json' | 'unified';
}

// ============ Constants ============

const BINARY_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.bmp',
	'.ico',
	'.svg',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.mp3',
	'.mp4',
	'.avi',
	'.mov',
	'.pdf',
	'.zip',
	'.tar',
	'.gz',
	'.rar',
]);

// ============ Path Validation ============

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|:|$)/i;

/**
 * Check for Windows-specific path attacks.
 */
function containsWindowsAttacks(str: string): boolean {
	if (/:[^\\/]/.test(str)) return true;
	const parts = str.split(/[/\\]/);
	for (const part of parts) {
		if (WINDOWS_RESERVED_NAMES.test(part)) return true;
	}
	return false;
}

/**
 * Validate that a path is within the workspace boundary.
 */
function isPathInWorkspace(filePath: string, workspace: string): boolean {
	try {
		const resolvedPath = path.resolve(workspace, filePath);
		// If the file doesn't exist, return true — let the caller handle missing files
		if (!fs.existsSync(resolvedPath)) {
			return true;
		}
		const realWorkspace = fs.realpathSync(workspace);
		const realResolvedPath = fs.realpathSync(resolvedPath);
		const relativePath = path.relative(realWorkspace, realResolvedPath);
		if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate a file path for reading.
 */
function validateFilePath(filePath: string, workspace: string): boolean {
	if (!filePath || filePath.trim() === '') return false;
	if (containsPathTraversal(filePath)) return false;
	if (containsControlChars(filePath)) return false;
	if (containsWindowsAttacks(filePath)) return false;
	return isPathInWorkspace(filePath, workspace);
}

// ============ Context Matching ============

interface ContextMatch {
	// The line index where the context before ends (start of the change region)
	startLineIndex: number;
	// The line index where the context after begins (end of the change region)
	endLineIndex: number;
	// The matched context lines
	matchedBefore: string[];
	matchedAfter: string[];
}

/**
 * Find the location in content where the given context patterns match.
 * Returns the line indices where the change should be applied.
 */
function findContextMatch(
	content: string,
	contextBefore?: string[],
	contextAfter?: string[],
	oldContent?: string,
): ContextMatch | null {
	const lines = splitDiffLines(content);

	// If no context provided, we can't locate the change reliably
	if (
		(!contextBefore || contextBefore.length === 0) &&
		(!contextAfter || contextAfter.length === 0)
	) {
		return null;
	}

	// Search for contextBefore ending and contextAfter starting
	// The change region is between these two context blocks

	if (contextBefore && contextBefore.length > 0) {
		// Find where contextBefore ends (the last line of the before block)
		for (let i = 0; i <= lines.length - contextBefore.length; i++) {
			const slice = lines.slice(i, i + contextBefore.length);
			if (arraysEqual(slice, contextBefore)) {
				// Now look for contextAfter starting after contextBefore ends
				const afterStart = i + contextBefore.length;
				if (contextAfter && contextAfter.length > 0) {
					// Iterate through all contextAfter occurrences starting from afterStart
					for (
						let j = afterStart;
						j <= lines.length - contextAfter.length;
						j++
					) {
						const afterSlice = lines.slice(j, j + contextAfter.length);
						if (arraysEqual(afterSlice, contextAfter)) {
							if (j === afterStart) {
								// Adjacent: contextBefore is immediately followed by contextAfter
								// validateOldContent derives removal range from oldContent length
								return {
									startLineIndex: i,
									endLineIndex: j + contextAfter.length - 1,
									matchedBefore: contextBefore,
									matchedAfter: contextAfter,
								};
							} else {
								// Non-adjacent: oldContent must match between region
								if (oldContent && oldContent.length > 0) {
									const oldContentLines = splitDiffLines(oldContent);
									const betweenLines = lines.slice(afterStart, j);
									if (arraysEqual(betweenLines, oldContentLines)) {
										return {
											startLineIndex: i,
											// j - 1 points to last line BEFORE contextAfter (end of oldContent region)
											endLineIndex: j - 1,
											matchedBefore: contextBefore,
											matchedAfter: contextAfter,
										};
									}
									// oldContent doesn't match: continue searching for another contextAfter
								} else {
									return {
										startLineIndex: i,
										// j - 1 points to last line BEFORE contextAfter (end of oldContent region)
										endLineIndex: j - 1,
										matchedBefore: contextBefore,
										matchedAfter: contextAfter,
									};
								}
							}
						}
					}
					// No matching contextAfter found after contextBefore with valid oldContent
					return null;
				} else {
					// No contextAfter - find oldContent starting from afterStart
					if (oldContent && oldContent.length > 0) {
						const oldContentLines = splitDiffLines(oldContent);
						for (
							let k = afterStart;
							k <= lines.length - oldContentLines.length;
							k++
						) {
							const candidate = lines.slice(k, k + oldContentLines.length);
							if (arraysEqual(candidate, oldContentLines)) {
								return {
									startLineIndex: i,
									endLineIndex: k + oldContentLines.length - 1,
									matchedBefore: contextBefore,
									matchedAfter: [],
								};
							}
						}
						return null; // oldContent not found
					} else {
						// No oldContent, no contextAfter - return region after contextBefore
						return {
							startLineIndex: i,
							endLineIndex: afterStart - 1,
							matchedBefore: contextBefore,
							matchedAfter: [],
						};
					}
				}
			}
		}
	} else if (contextAfter && contextAfter.length > 0) {
		// Only contextAfter provided - find where it starts
		for (let j = 0; j <= lines.length - contextAfter.length; j++) {
			const afterSlice = lines.slice(j, j + contextAfter.length);
			if (arraysEqual(afterSlice, contextAfter)) {
				return {
					startLineIndex: 0,
					endLineIndex: j - 1,
					matchedBefore: [],
					matchedAfter: contextAfter,
				};
			}
		}
	}

	return null;
}

/**
 * Check if two string arrays are equal.
 */
function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// ============ Binary Detection ============

/**
 * Check if a file path has a binary extension.
 */
function isBinaryFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

// ============ Unified Diff Generation ============

/**
 * Split content into lines for diff processing.
 *
 * Unlike `content.split('\n')`, this omits the terminal empty element
 * produced when content ends with `\n`. For example:
 *   `"a\nb\n".split('\n')`      → `["a", "b", ""]`
 *   `splitDiffLines("a\nb\n")`  → `["a", "b"]`
 *
 * This is required because a trailing newline is a line terminator, not a
 * separate empty line — unified diff hunk counts must reflect the actual
 * number of lines, not a phantom empty string produced by naive splitting.
 */
function splitDiffLines(content: string): string[] {
	if (content === '') return [];
	return content.endsWith('\n')
		? content.slice(0, -1).split('\n')
		: content.split('\n');
}

/**
 * Generate a unified diff file header (diff --git, ---, +++) for a given file.
 */
function generateFileHeader(file: string): string {
	return (
		`diff --git a/${file} b/${file}\n` + `--- a/${file}\n` + `+++ b/${file}\n`
	);
}

/**
 * Generate a single unified diff hunk (no file header) from a patch entry.
 *
 * The output is parseable by the apply_patch tool's parseUnifiedDiff.
 * Must be paired with generateFileHeader to produce a complete file diff.
 *
 * When oldContent is provided, the removal lines are derived directly from
 * oldContent (already validated by validateOldContent), avoiding the fragile
 * endLineIndex formula that is only correct for single-line contextAfter.
 * When oldContent is absent, the hunk represents a pure insertion with
 * zero removal lines.
 */
function generateHunk(
	content: string,
	contextMatch: ContextMatch,
	oldContent: string | undefined,
	newContent: string,
): string {
	const lines = splitDiffLines(content);
	const originalEndsWithNewline = content.endsWith('\n');
	const newContentEndsWithNewline = newContent.endsWith('\n');

	// Compute removal lines directly from oldContent, not from the
	// endLineIndex / matchedAfter formula. The formula
	//   endLineIndex - matchedAfter.length + 1
	// is only correct for single-line contextAfter (length === 1) and
	// produces wrong results when matchedAfter.length > 1. Since oldContent
	// was already validated against the file by validateOldContent, we can
	// trust it as the authoritative removal line set.
	const removalStartIdx =
		contextMatch.startLineIndex + contextMatch.matchedBefore.length;
	const removalLines = oldContent ? splitDiffLines(oldContent) : [];
	const removalEndIdx =
		removalLines.length > 0
			? removalStartIdx + removalLines.length - 1
			: removalStartIdx - 1;

	const additionLines = splitDiffLines(newContent);

	// Determine where matchedAfter lines actually start in the file.
	// In the adjacent case (contextBefore immediately followed by contextAfter),
	// endLineIndex points to the last matchedAfter line, so the start is
	//   endLineIndex - matchedAfter.length + 1.
	// In the non-adjacent case, endLineIndex points to the last removal line,
	// so the start is endLineIndex + 1.
	// Detect by checking whether the file line at endLineIndex equals the last
	// matchedAfter line. This is reliable because findContextMatch guarantees
	// matchedAfter matches at that position.
	const isAdjacentCase =
		contextMatch.matchedAfter.length > 0 &&
		contextMatch.endLineIndex >= 0 &&
		contextMatch.endLineIndex < lines.length &&
		lines[contextMatch.endLineIndex] ===
			contextMatch.matchedAfter[contextMatch.matchedAfter.length - 1];
	const contextAfterStartInFile = isAdjacentCase
		? contextMatch.endLineIndex - contextMatch.matchedAfter.length + 1
		: contextMatch.endLineIndex + 1;

	// Compute how many contextAfter lines to skip because they fall within the
	// removal range. This happens in the adjacent case when oldContent lines
	// overlap with contextAfter lines.
	const overlapSkipCount = Math.max(
		0,
		removalLines.length > 0 ? removalEndIdx + 1 - contextAfterStartInFile : 0,
	);
	const effectiveContextAfterCount = Math.max(
		0,
		contextMatch.matchedAfter.length - overlapSkipCount,
	);

	// Build the hunk body
	// oldStart is 1-indexed, counting from contextBefore start
	const oldStart =
		contextMatch.matchedBefore.length > 0
			? contextMatch.startLineIndex + 1
			: removalStartIdx + 1;

	// The new section starts at the same logical position
	const newStart = oldStart;

	// oldCount = contextBefore + removal lines + effective contextAfter
	const oldCount =
		contextMatch.matchedBefore.length +
		removalLines.length +
		effectiveContextAfterCount;

	// newCount = contextBefore + addition lines + effective contextAfter
	const newCount =
		contextMatch.matchedBefore.length +
		additionLines.length +
		effectiveContextAfterCount;

	const hunkLines: string[] = [];

	// Track positions of last old-side and new-side lines in hunkLines
	// for no-newline marker insertion. Markers must appear IMMEDIATELY
	// AFTER the line they describe, not at the end of the hunk.
	let lastOldSidePos = -1;
	let lastNewSidePos = -1;

	// Context before lines (shared: old + new side)
	for (const line of contextMatch.matchedBefore) {
		const idx = hunkLines.length;
		hunkLines.push(` ${line}`);
		lastOldSidePos = idx;
		lastNewSidePos = idx;
	}

	// Removal lines (old-side only)
	for (const line of removalLines) {
		const idx = hunkLines.length;
		hunkLines.push(`-${line}`);
		lastOldSidePos = idx;
	}

	// Addition lines (new-side only)
	for (const line of additionLines) {
		const idx = hunkLines.length;
		hunkLines.push(`+${line}`);
		lastNewSidePos = idx;
	}

	// Context after lines — skip any that overlap the removal range.
	// When oldContent lines share identity with contextAfter lines (e.g. adjacent
	// match where contextAfter starts right where the removal ends), the matchedAfter
	// array contains lines already counted as removals. Emitting them again would
	// produce an invalid unified diff where the old side has duplicated lines.
	for (let k = overlapSkipCount; k < contextMatch.matchedAfter.length; k++) {
		const idx = hunkLines.length;
		hunkLines.push(` ${contextMatch.matchedAfter[k]}`);
		lastOldSidePos = idx;
		lastNewSidePos = idx;
	}

	// Determine if the hunk covers the LAST line of the original file.
	// This is needed to decide whether to emit no-newline-at-end-of-file markers.
	// The last old-side file line index determines EOF detection for
	// no-newline markers. When effective contextAfter lines exist, they are
	// the trailing old-side lines in the hunk, so the last one's file position
	// is the relevant EOF probe. Otherwise fall back to the last removal line
	// or the last contextBefore line.
	const lastOldSideFileIdx =
		effectiveContextAfterCount > 0
			? contextAfterStartInFile + contextMatch.matchedAfter.length - 1
			: removalLines.length > 0
				? removalEndIdx
				: contextMatch.matchedBefore.length > 0
					? contextMatch.startLineIndex + contextMatch.matchedBefore.length - 1
					: -1;

	const isAtEof = lastOldSideFileIdx === lines.length - 1;
	const needsOldMarker =
		isAtEof && !originalEndsWithNewline && lastOldSidePos >= 0;

	// New-side no-newline marker: only emit when the hunk reaches EOF and
	// the actual last new-side line lacks a trailing newline.
	// The new-side last line depends on what's present:
	//   1. effectiveContextAfter > 0 → last line is a contextAfter line
	//      → newline status comes from the original file
	//   2. additionLines exist → last line is the last addition line
	//      → newline status comes from newContent
	//   3. neither (pure deletion) → last new-side line is from matchedBefore
	//      → it precedes the removal region in the original file, so it
	//        always has a newline separator → no marker needed
	const newSideEndsWithNewline =
		effectiveContextAfterCount > 0
			? originalEndsWithNewline
			: additionLines.length > 0
				? newContentEndsWithNewline
				: true;
	const needsNewMarker =
		isAtEof && !newSideEndsWithNewline && lastNewSidePos >= 0;

	// Insert no-newline markers at the correct inline positions.
	// Each marker follows immediately after the line it describes.
	const finalLines: string[] = [];
	let pendingOldMarker = needsOldMarker;
	let pendingNewMarker = needsNewMarker;

	for (let i = 0; i < hunkLines.length; i++) {
		finalLines.push(hunkLines[i]);
		if (pendingOldMarker && i === lastOldSidePos) {
			finalLines.push('\\ No newline at end of file');
			pendingOldMarker = false;
		}
		if (pendingNewMarker && i === lastNewSidePos) {
			finalLines.push('\\ No newline at end of file');
			pendingNewMarker = false;
		}
	}

	// When there are zero lines in the old or new side, use 0 in the hunk header
	// Standard unified diff convention: @@ -1,0 +1,N @@ for empty old side
	const oldCountStr = oldCount === 0 ? '0' : String(oldCount);
	const newCountStr = newCount === 0 ? '0' : String(newCount);

	// Build the hunk string (no file header)
	let diff = '';
	diff += `@@ -${oldStart},${oldCountStr} +${newStart},${newCountStr} @@\n`;
	diff += finalLines.join('\n');
	diff += '\n';

	return diff;
}

/**
 * Result of processing a single change for unified diff generation.
 */
interface UnifiedDiffEntry {
	file: string;
	contextMatch: ContextMatch;
	oldContent: string | undefined;
	newContent: string;
}

/**
 * Validate that oldContent matches at the specified location.
 * Derives the removal range from oldContent length (same approach as generateHunk):
 *   removalStartIdx = startLineIndex + matchedBefore.length
 *   actualLines      = lines.slice(removalStartIdx, removalStartIdx + oldContentLines.length)
 * This avoids the fragile endLineIndex - matchedAfter.length + 1 formula that
 * produces wrong results when matchedAfter has more than one line.
 */
function validateOldContent(
	lines: string[],
	contextMatch: ContextMatch,
	oldContent?: string,
): { valid: boolean; expected?: string; actual?: string } {
	if (!oldContent) {
		return { valid: true };
	}

	const expectedLines = splitDiffLines(oldContent);
	const removalStartIdx =
		contextMatch.startLineIndex + contextMatch.matchedBefore.length;
	const actualLines = lines.slice(
		removalStartIdx,
		removalStartIdx + expectedLines.length,
	);

	if (!arraysEqual(actualLines, expectedLines)) {
		return {
			valid: false,
			expected: expectedLines.join('\n'),
			actual: actualLines.join('\n'),
		};
	}

	return { valid: true };
}

// ============ Tool Definition ============

export const suggestPatch: ToolDefinition = createSwarmTool({
	description:
		'Suggest a structured patch for specified files without modifying them. ' +
		'Returns context-based patch proposals with anchors for reviewer use. ' +
		'When format="unified", also produces a unified diff string consumable by apply_patch. ' +
		'This is a read-only tool — it does not modify any files.',
	args: {
		targetFiles: z
			.array(z.string())
			.describe('Array of file paths to patch')
			.min(1),
		changes: z
			.array(
				z.object({
					file: z.string().describe('Path to the file this change applies to'),
					contextBefore: z
						.array(z.string())
						.optional()
						.describe('Lines before the change region (anchor)'),
					contextAfter: z
						.array(z.string())
						.optional()
						.describe('Lines after the change region (anchor)'),
					oldContent: z
						.string()
						.optional()
						.describe('Current content to be replaced'),
					newContent: z.string().describe('New content to replace with'),
				}),
			)
			.describe('Array of change descriptions with context anchors')
			.min(1),
		format: z
			.enum(['json', 'unified'])
			.optional()
			.default('json')
			.describe(
				'Output format: "json" (default, existing structured output) or "unified" (unified diff string for apply_patch)',
			),
	},
	execute: async (args: unknown, directory: string): Promise<string> => {
		// Safe args extraction with proper validation
		if (!args || typeof args !== 'object') {
			return JSON.stringify(
				{
					success: false,
					error: true,
					type: 'parse-error',
					message: 'Could not parse suggest-patch arguments',
				} satisfies PatchError,
				null,
				2,
			);
		}

		const obj = args as Record<string, unknown>;
		const targetFiles: string[] = (obj.targetFiles as string[]) ?? [];
		const changes: ChangeDescription[] =
			(obj.changes as ChangeDescription[]) ?? [];
		const format = (obj.format as string) ?? 'json';

		// Validate arguments
		if (!targetFiles || targetFiles.length === 0) {
			return JSON.stringify(
				{
					success: false,
					error: true,
					type: 'parse-error',
					message: 'targetFiles cannot be empty',
				} satisfies PatchError,
				null,
				2,
			);
		}

		if (!changes || changes.length === 0) {
			return JSON.stringify(
				{
					success: false,
					error: true,
					type: 'parse-error',
					message: 'changes cannot be empty',
				} satisfies PatchError,
				null,
				2,
			);
		}

		// Validate workspace directory
		if (!fs.existsSync(directory)) {
			return JSON.stringify(
				{
					success: false,
					error: true,
					type: 'file-not-found',
					message: 'Workspace directory does not exist',
				} satisfies PatchError,
				null,
				2,
			);
		}

		const patches: PatchHunk[] = [];
		const filesModifiedSet = new Set<string>();
		const errors: PatchError[] = [];

		// For unified diff generation
		const unifiedDiffEntries: UnifiedDiffEntry[] = [];

		// Create a Set for O(1) targetFiles membership checks
		const targetFileSet = new Set(targetFiles);

		// In unified mode, reject binary files up front and collect a skip set
		const skippedBinaryFiles = new Set<string>();
		if (format === 'unified') {
			for (const change of changes) {
				if (isBinaryFile(change.file)) {
					errors.push({
						success: false,
						error: true,
						type: 'parse-error',
						message: `Binary files are not supported in unified diff mode: ${change.file}`,
						details: { location: change.file },
					});
					skippedBinaryFiles.add(change.file);
				}
			}
		}

		// Process each change
		for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
			const change = changes[changeIndex];

			// Skip binary files already rejected in unified mode pre-check
			if (format === 'unified' && skippedBinaryFiles.has(change.file)) {
				continue;
			}

			// Check that change.file is in targetFiles
			if (!targetFileSet.has(change.file)) {
				errors.push({
					success: false,
					error: true,
					type: 'parse-error',
					message: `File "${change.file}" is not in targetFiles`,
					details: { location: change.file },
				});
				continue;
			}

			// Validate file path
			if (!validateFilePath(change.file, directory)) {
				errors.push({
					success: false,
					error: true,
					type: 'parse-error',
					message: `Invalid file path: ${change.file}`,
					details: {
						location: change.file,
					},
				});
				continue;
			}

			const fullPath = path.resolve(directory, change.file);

			// Check if file exists
			if (!fs.existsSync(fullPath)) {
				errors.push({
					success: false,
					error: true,
					type: 'file-not-found',
					message: `File not found: ${change.file}`,
					details: {
						location: change.file,
					},
				});
				continue;
			}

			// Read file content
			let content: string;
			try {
				content = fs.readFileSync(fullPath, 'utf-8');
			} catch (err) {
				errors.push({
					success: false,
					error: true,
					type: 'unknown',
					message: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
					details: {
						location: `${change.file}:0`,
					},
				});
				continue;
			}

			// Find context match
			const contextMatch = findContextMatch(
				content,
				change.contextBefore,
				change.contextAfter,
				change.oldContent,
			);

			if (!contextMatch) {
				errors.push({
					success: false,
					error: true,
					type: 'context-mismatch',
					message: `Could not find context anchor in ${change.file}. Provide contextBefore/contextAfter lines to locate the change region.`,
					details: {
						location: change.file,
					},
				});
				continue;
			}

			const lines = splitDiffLines(content);

			// Validate oldContent if provided — uses pre-computed removal range
			const oldContentValidation = validateOldContent(
				lines,
				contextMatch,
				change.oldContent,
			);

			if (!oldContentValidation.valid) {
				errors.push({
					success: false,
					error: true,
					type: 'context-mismatch',
					message: `Content at the specified location does not match oldContent`,
					details: {
						expected: oldContentValidation.expected,
						actual: oldContentValidation.actual,
						location: `${change.file}:${contextMatch.startLineIndex + 1}-${contextMatch.endLineIndex + 1}`,
					},
				});
				continue;
			}

			// Build the patch hunk with context anchors
			const originalContext = [
				...contextMatch.matchedBefore,
				...(contextMatch.matchedAfter.length > 0
					? ['...'] // Placeholder indicating content between
					: []),
				...contextMatch.matchedAfter,
			];

			patches.push({
				file: change.file,
				originalContext,
				newContent: change.newContent,
				hunkIndex: changeIndex,
			});

			filesModifiedSet.add(change.file);

			// Collect unified diff entry if in unified mode
			if (format === 'unified') {
				unifiedDiffEntries.push({
					file: change.file,
					contextMatch,
					oldContent: change.oldContent,
					newContent: change.newContent,
				});
			}
		}

		// If we have errors but also some successful patches, return both
		if (patches.length > 0) {
			const baseResult = {
				success: true as const,
				patches,
				filesModified: Array.from(filesModifiedSet),
				...(errors.length > 0 && { errors }),
			} satisfies PatchSuggestion;

			if (format === 'unified') {
				// Group entries by file so we emit ONE diff --git header per file
				// with multiple hunks, avoiding stale line numbers from separate headers.
				const fileGroups = new Map<string, UnifiedDiffEntry[]>();
				for (const entry of unifiedDiffEntries) {
					const group = fileGroups.get(entry.file) ?? [];
					group.push(entry);
					fileGroups.set(entry.file, group);
				}

				const unifiedParts: string[] = [];
				for (const [file, entries] of fileGroups) {
					// Sort entries by start line to ensure hunks are in order
					entries.sort(
						(a, b) =>
							a.contextMatch.startLineIndex - b.contextMatch.startLineIndex,
					);
					const entryFullPath = path.resolve(directory, file);
					let entryContent: string;
					try {
						entryContent = fs.readFileSync(entryFullPath, 'utf-8');
					} catch {
						continue;
					}
					// Emit one file header, then all hunks for this file
					unifiedParts.push(generateFileHeader(file));
					for (const entry of entries) {
						unifiedParts.push(
							generateHunk(
								entryContent,
								entry.contextMatch,
								entry.oldContent,
								entry.newContent,
							),
						);
					}
				}
				const unifiedPatch = unifiedParts.join('');

				return JSON.stringify(
					{
						...baseResult,
						unifiedPatch,
					},
					null,
					2,
				);
			}

			return JSON.stringify(baseResult, null, 2);
		}

		// All changes failed
		if (errors.length === 1) {
			return JSON.stringify(errors[0], null, 2);
		}

		return JSON.stringify(
			{
				success: false,
				error: true,
				type: 'context-mismatch',
				message: `All ${errors.length} patch suggestions failed`,
				errors,
			} satisfies PatchError,
			null,
			2,
		);
	},
});
