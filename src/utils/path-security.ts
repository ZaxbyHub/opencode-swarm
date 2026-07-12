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
 * Check if a string contains control or directional-format characters that
 * could be used for injection attacks.
 */
export function containsControlChars(str: string): boolean {
	for (const ch of str) {
		const code = ch.codePointAt(0);
		if (code === undefined) continue;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
		if (code >= 0x202a && code <= 0x202e) return true;
		if (code >= 0x2066 && code <= 0x2069) return true;
	}
	return false;
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
 * Verify that a target path canonically resolves inside a root directory.
 * For targets that do not exist yet (e.g. new-file creation), resolves the
 * nearest existing ancestor instead, so a symlinked intermediate directory
 * cannot be used to escape the root. Mirrors the containment used by
 * swarm_apply_patch (the correct template for write tools).
 *
 * @param targetPath - absolute path to validate
 * @param rootPath - absolute root boundary
 * @returns true if the canonical target is within the canonical root
 */
export function isCanonicalPathWithinRoot(
	targetPath: string,
	rootPath: string,
): boolean {
	let canonicalRoot: string;
	try {
		canonicalRoot = fs.realpathSync(rootPath);
	} catch {
		canonicalRoot = path.normalize(rootPath);
	}

	// Walk up to the nearest existing ancestor of the (possibly not-yet-created)
	// target so symlinks on any existing component are resolved.
	let probe = path.normalize(targetPath);
	// Guard against an unbounded loop on malformed input.
	for (let i = 0; i < 4096; i++) {
		try {
			const canonicalProbe = fs.realpathSync(probe);
			const relative = path.relative(canonicalRoot, canonicalProbe);
			return !relative.startsWith('..') && !path.isAbsolute(relative);
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return false; // reached filesystem root, nothing resolved
			probe = parent;
		}
	}
	return false;
}

/**
 * Validate that a caller-supplied path stays within an allowed root directory.
 * Rejects empty paths, absolute paths (POSIX + Windows drive), traversal,
 * control characters, lexical escape, and symlink/junction escape.
 * Returns a human-readable reason string on rejection, or null when valid.
 *
 * This is the shared containment primitive for write-capable tools whose
 * target path is derived from untrusted input (e.g. extract_code_blocks'
 * output_dir and `# filename:` comments).
 *
 * @param filePath - the caller-supplied path (relative to root, or absolute-rejected)
 * @param root - the absolute root boundary (workspace directory)
 */
export function validateTargetWithinRoot(
	filePath: string,
	root: string,
): string | null {
	if (!filePath || filePath.trim() === '') {
		return 'Empty path';
	}
	if (path.isAbsolute(filePath) || /^[A-Za-z]:[/\\]/.test(filePath)) {
		return `Absolute path rejected: ${filePath}`;
	}
	if (containsPathTraversal(filePath)) {
		return `Path traversal detected: ${filePath}`;
	}
	if (containsControlChars(filePath)) {
		return `Control characters detected in path: ${filePath}`;
	}
	const resolved = path.resolve(root, filePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return `Path escapes root: ${filePath}`;
	}
	if (!isCanonicalPathWithinRoot(resolved, root)) {
		return `Path escapes root via symlink/junction: ${filePath}`;
	}
	return null; // valid
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
	isCanonicalPathWithinRoot: typeof isCanonicalPathWithinRoot;
	validateTargetWithinRoot: typeof validateTargetWithinRoot;
} = {
	containsPathTraversal,
	containsControlChars,
	validateDirectory,
	validateSymlinkBoundary,
	isCanonicalPathWithinRoot,
	validateTargetWithinRoot,
} as const;
