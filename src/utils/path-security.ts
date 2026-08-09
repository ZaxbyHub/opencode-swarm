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
 * Resolve a path to its canonical (symlink-free) form, tolerating the case
 * where the path (or some suffix of it) does not exist yet.
 *
 * Strategy:
 * 1. Try `resolver(inputPath)` directly — the common case where the path
 *    already exists. This preserves the exact historical behavior (and the
 *    exact string handed to the resolver) for existing paths.
 * 2. On failure (ENOENT — the path, or a not-yet-created tail of it, does
 *    not exist), lexically resolve the input with `path.resolve` (attaches a
 *    drive letter on Windows, matching what `realpathSync` would produce for
 *    a path that DOES exist — see the drive-letter-consistency note on
 *    `validateSymlinkBoundary` below) so any `..`/`.` segments in the input
 *    are collapsed BEFORE any ancestor is examined. This is what prevents a
 *    `..` in the non-existent tail from surviving into the composed result
 *    and climbing back out of a resolved ancestor.
 * 3. Walk up the lexically-resolved path one component at a time (bounded
 *    to 4096 iterations to guard against unbounded loops on malformed
 *    input), calling `resolver` on each shorter ancestor. The first
 *    ancestor that resolves successfully is the nearest EXISTING ancestor —
 *    resolving it follows any symlink on that component (or any component
 *    above it). The already-lexically-normalized tail (which cannot contain
 *    `..`) is then rejoined onto that canonical ancestor, so the returned
 *    path reflects every symlink that exists on disk today while still
 *    describing the not-yet-created target.
 * 4. If no ancestor resolves (walk reaches the filesystem root without a
 *    single successful `resolver` call — effectively unreachable on a real
 *    OS, since the filesystem root always exists), fall back to the
 *    lexically-resolved path.
 */
function resolveNearestExistingCanonical(
	inputPath: string,
	resolver: (p: string) => string,
): string {
	try {
		return resolver(inputPath);
	} catch {
		// Path (or a suffix of it) does not exist yet — fall through to the
		// ancestor walk below.
	}

	const lexicallyResolved = path.resolve(inputPath);
	let probe = lexicallyResolved;
	const tail: string[] = [];
	for (let i = 0; i < 4096; i++) {
		const parent = path.dirname(probe);
		if (parent === probe) {
			// Reached the filesystem root without finding an existing ancestor.
			return lexicallyResolved;
		}
		// unshift runs before every resolver() attempt below, so by the time
		// resolver(probe) can succeed, tail always has at least one entry —
		// the composed-path branch below is the only reachable outcome.
		tail.unshift(path.basename(probe));
		probe = parent;
		try {
			const canonicalAncestor = resolver(probe);
			// tail contains only plain path components — lexicallyResolved was
			// already normalized above, so no '..'/'.' segment can be present —
			// rejoining it onto the canonical ancestor cannot escape further
			// than the ancestor itself already has.
			return path.normalize(path.join(canonicalAncestor, ...tail));
		} catch {
			// Keep climbing.
		}
	}
	return lexicallyResolved;
}

/**
 * Validate that a resolved path stays within an allowed root directory.
 * Resolves symlinks via realpathSync for both the target path and the root,
 * then verifies the resolved target is within the resolved root.
 *
 * The non-existent-path fallback uses path.resolve (not path.normalize):
 * path.resolve anchors a rootless-absolute path (e.g. POSIX-style '/foo/bar'
 * passed on Windows) to the current drive, matching what realpathSync would
 * produce for a path that DOES exist. path.normalize does not add a drive
 * letter. Without this, a case where exactly one of targetPath/rootPath
 * happens to exist on disk (e.g. leftover state from an unrelated test, or
 * any incidental real path) resolves that side via realpathSync (drive
 * letter attached) while the other falls back to normalize (no drive
 * letter) — an apples-to-oranges comparison that spuriously throws
 * regardless of whether a real boundary escape occurred. Using resolve for
 * both fallback branches keeps the comparison basis consistent whether
 * realpathSync succeeds or not, independent of incidental filesystem state.
 *
 * Not-yet-existing targets (e.g. a file about to be created by an atomic
 * write) are handled the same way: realpathSync on the full target throws
 * ENOENT, so resolution falls back to `resolveNearestExistingCanonical`,
 * which walks up to the nearest existing ancestor, resolves symlinks on
 * that ancestor (and everything above it), and rejoins the not-yet-existing
 * tail. Without this, a target under a workspace root that itself sits
 * behind a symlink (e.g. macOS `/tmp` and `/var`, which are symlinks to
 * `/private/tmp` and `/private/var`) would resolve to its unresolved literal
 * path while the (already-existing) root resolves to its `/private/...`
 * form, producing a spurious boundary-escape error even though the target
 * is genuinely inside the root. See issue #1986.
 *
 * This also TIGHTENS containment versus the pre-#1986-fix behavior in one
 * case: if `.swarm/` or any other ancestor between the target and the
 * workspace root is itself a symlink/junction pointing outside the
 * workspace, the old fallback (unresolved `path.resolve`) could let a
 * not-yet-existing target through on its first write; the ancestor walk now
 * resolves that symlinked ancestor and correctly throws. If a deployment
 * relies on a symlinked `.swarm/` (or similar) pointing outside the
 * workspace root, that setup will now be rejected — this is the intended,
 * correct behavior, not a regression.
 *
 * @param targetPath - The path to validate (absolute)
 * @param rootPath - The root directory boundary (absolute)
 * @throws Error if the resolved target escapes the root boundary
 */
export function validateSymlinkBoundary(
	targetPath: string,
	rootPath: string,
): void {
	const realTarget = resolveNearestExistingCanonical(
		targetPath,
		_internals.realpathSync,
	);
	const realRoot = resolveNearestExistingCanonical(
		rootPath,
		_internals.realpathSync,
	);

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
	realpathSync: typeof fs.realpathSync;
	containsPathTraversal: typeof containsPathTraversal;
	containsControlChars: typeof containsControlChars;
	validateDirectory: typeof validateDirectory;
	validateSymlinkBoundary: typeof validateSymlinkBoundary;
	isCanonicalPathWithinRoot: typeof isCanonicalPathWithinRoot;
	validateTargetWithinRoot: typeof validateTargetWithinRoot;
} = {
	realpathSync: fs.realpathSync,
	containsPathTraversal,
	containsControlChars,
	validateDirectory,
	validateSymlinkBoundary,
	isCanonicalPathWithinRoot,
	validateTargetWithinRoot,
} as const;
