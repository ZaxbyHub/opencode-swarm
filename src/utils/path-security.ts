import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Canonical path security utilities.
 * Consolidated from 6+ local implementations across the codebase.
 * Use these instead of defining local copies.
 */

/**
 * Check if a string contains path traversal patterns.
 * Based on the most comprehensive implementation (test-runner.ts).
 * Checks: basic ../, isolated double dots, URL-encoded traversal,
 * double-encoded traversal, Unicode homoglyphs, and encoded separators.
 */
export function containsPathTraversal(str: string): boolean {
	// Check for basic path traversal patterns
	if (/\.\.[/\\]/.test(str)) return true;

	// Check for isolated double dots (at start or after separator)
	if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(str)) return true;

	// Check for URL-encoded traversal patterns
	if (/%2e%2e/i.test(str)) return true; // .. URL encoded
	if (/%2e\./i.test(str)) return true; // .%2e
	if (/%2e/i.test(str) && /\.\./.test(str)) return true; // Mixed encoding
	if (/%252e%252e/i.test(str)) return true; // Double encoded ..

	// Check for Unicode/Unicode-like traversal attempts
	// Fullwidth dot (U+FF0E) - looks like dot but isn't
	if (/\uff0e/.test(str)) return true;
	// Ideographic full stop (U+3002)
	if (/\u3002/.test(str)) return true;
	// Halfwidth katakana middle dot (U+FF65)
	if (/\uff65/.test(str)) return true;

	// Check for path separator variants
	// Forward slash encoded as %2f
	if (/%2f/i.test(str)) return true;
	// Backslash encoded as %5c
	if (/%5c/i.test(str)) return true;

	return false;
}

/**
 * Check if a string contains control characters that could be used
 * for injection attacks. Matches null byte, tab, carriage return, and newline.
 */
export function containsControlChars(str: string): boolean {
	return /[\0\t\r\n]/.test(str);
}

/**
 * Validate a directory path for safety.
 * Rejects empty paths, paths with traversal, control characters, and absolute paths.
 * Throws an Error if the directory is invalid.
 *
 * @param directory - The directory string to validate
 * @throws Error if directory is invalid
 */
export function validateDirectory(directory: string): void {
	if (!directory || directory.trim() === '') {
		throw new Error('Invalid directory: empty');
	}
	if (containsPathTraversal(directory)) {
		throw new Error('Invalid directory: path traversal detected');
	}
	if (containsControlChars(directory)) {
		throw new Error('Invalid directory: control characters detected');
	}
	if (directory.startsWith('/') || directory.startsWith('\\')) {
		throw new Error('Invalid directory: absolute path');
	}
	if (/^[A-Za-z]:[/\\]/.test(directory)) {
		throw new Error('Invalid directory: Windows absolute path');
	}
}

/**
 * Validate that a resolved path stays within an allowed root directory.
 * Resolves symlinks via realpathSync for both the target path and the root,
 * then verifies the resolved target is within the resolved root.
 *
 * @param targetPath - The path to validate (absolute)
 * @param rootPath - The root directory boundary (absolute)
 * @throws Error if the resolved target escapes the root boundary
 */
export function validateSymlinkBoundary(
	targetPath: string,
	rootPath: string,
): void {
	let realTarget: string;
	try {
		realTarget = fs.realpathSync(targetPath);
	} catch {
		realTarget = path.normalize(targetPath);
	}

	let realRoot: string;
	try {
		realRoot = fs.realpathSync(rootPath);
	} catch {
		realRoot = path.normalize(rootPath);
	}

	const normalizedTarget = path.normalize(realTarget);
	const normalizedRoot = path.normalize(realRoot);

	if (
		!normalizedTarget.startsWith(normalizedRoot + path.sep) &&
		normalizedTarget !== normalizedRoot
	) {
		throw new Error(
			`Symlink resolution escaped boundary: ${realTarget} is not within ${realRoot}`,
		);
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	containsPathTraversal: typeof containsPathTraversal;
	containsControlChars: typeof containsControlChars;
	validateDirectory: typeof validateDirectory;
	validateSymlinkBoundary: typeof validateSymlinkBoundary;
} = {
	containsPathTraversal,
	containsControlChars,
	validateDirectory,
	validateSymlinkBoundary,
} as const;
