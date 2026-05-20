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
}

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
	const lines = content.split('\n');

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
								// Adjacent: always return the match immediately
								// validateOldContent in execute() will handle oldContent validation
								return {
									startLineIndex: i,
									endLineIndex: j + contextAfter.length - 1,
									matchedBefore: contextBefore,
									matchedAfter: contextAfter,
								};
							} else {
								// Non-adjacent: oldContent must match between region
								if (oldContent && oldContent.length > 0) {
									const oldContentLines = oldContent.split('\n');
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
						const oldContentLines = oldContent.split('\n');
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

/**
 * Validate that oldContent matches at the specified location.
 */
function validateOldContent(
	lines: string[],
	startIndex: number,
	endIndex: number,
	oldContent?: string,
): { valid: boolean; expected?: string; actual?: string } {
	if (!oldContent) {
		return { valid: true };
	}

	const currentContent = lines.slice(startIndex, endIndex + 1).join('\n');

	if (currentContent !== oldContent) {
		return {
			valid: false,
			expected: oldContent,
			actual: currentContent,
		};
	}

	return { valid: true };
}

// ============ Tool Definition ============

export const suggestPatch: ToolDefinition = createSwarmTool({
	description:
		'Suggest a structured patch for specified files without modifying them. ' +
		'Returns context-based patch proposals with anchors for reviewer use. ' +
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

		// Create a Set for O(1) targetFiles membership checks
		const targetFileSet = new Set(targetFiles);

		// Process each change
		for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
			const change = changes[changeIndex];

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

			const lines = content.split('\n');

			// Validate oldContent if provided
			const oldContentValidation = validateOldContent(
				lines,
				contextMatch.startLineIndex + contextMatch.matchedBefore.length,
				contextMatch.endLineIndex - contextMatch.matchedAfter.length + 1,
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
		}

		// If we have errors but also some successful patches, return both
		if (patches.length > 0) {
			return JSON.stringify(
				{
					success: true,
					patches,
					filesModified: Array.from(filesModifiedSet),
					...(errors.length > 0 && { errors }),
				} satisfies PatchSuggestion,
				null,
				2,
			);
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
