import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalExistingFilesystemPath } from './filesystem-identity.js';

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
 * Validate a **project/workspace root** for safety.
 *
 * Distinct from {@link validateDirectory}, which additionally rejects absolute
 * paths and is therefore only correct for a *relative sub-path*. A workspace
 * root is absolute by contract — `ctx.directory` injected by `createSwarmTool`
 * is always an absolute project root (AGENTS.md invariant 4) — so applying
 * `validateDirectory` to one rejects 100% of real inputs and silently kills
 * whatever feature depends on it. That is exactly how `.swarm/run-memory.jsonl`
 * came to have no producer and a consumer that threw on every call.
 *
 * This validator keeps the checks that are meaningful for a root (empty,
 * traversal segments, control/bidi characters). Containment of the actual FILE
 * is not this function's job and is unchanged: `validateSwarmPath(directory,
 * filename)` resolves the target under `<directory>/.swarm`, rejects any path
 * that escapes it, and rejects a symlinked `.swarm` base.
 *
 * It ALSO requires the root to be absolute and to not be a filesystem or system
 * location — see `validateProjectDirectory` below, which this function
 * delegates to, for why those two checks are load-bearing rather than
 * defensive. In short: `validateSwarmPath` pins the write *inside* the root, so
 * it cannot help when the root itself is `E:\` or `/etc`, and a RELATIVE root
 * resolves `.swarm/` against the host process cwd — the same invariant-4 hazard
 * as an empty root.
 *
 * @param directory - The workspace root to validate
 * @throws Error if the root is invalid
 */
export function validateWorkspaceRoot(directory: string): void {
	validateProjectDirectory(directory);
}

/**
 * Validate a relative directory path for safety.
 * Rejects empty paths, paths with traversal, control characters, and absolute paths.
 * Throws an Error if the directory is invalid.
 *
 * Do NOT use this on a project/workspace root — see {@link validateWorkspaceRoot}.
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
 * Validate a TRUSTED, already-absolute project root directory.
 *
 * This is the trust-model counterpart to `validateDirectory` above, NOT a
 * relaxation of it. `validateDirectory` guards UNTRUSTED, RELATIVE sub-path
 * input and therefore rejects absolute paths by design. A project root that
 * the plugin host injects (`ctx.directory`, or the documented direct-CLI /
 * test `process.cwd()` fallback) is ALWAYS absolute, so handing one to
 * `validateDirectory` throws unconditionally — the misapplication that made
 * the context-budget and run-memory features dead on every real invocation
 * (issue #1619 follow-up).
 *
 * What this still enforces — every check that is meaningful for a root:
 * - Non-empty. An empty root makes `path.resolve('', '.swarm')` land on
 *   whatever the host process cwd happens to be, which is an invariant-4
 *   (`.swarm/` containment) violation, not a harmless no-op.
 * - No traversal and no control / directional-format characters. A root
 *   carrying `..`, a NUL byte, or a bidi override is never a legitimate
 *   injected project root.
 * - MUST be absolute. A relative root resolves against the host's process cwd
 *   — the same invariant-4 hazard as the empty case, and the reason this is a
 *   positive requirement rather than merely "absolute is tolerated".
 *
 * WHAT "ABSOLUTE" MEANS HERE IS PARTLY PLATFORM-DEPENDENT. The check is
 * `path.isAbsolute(directory) || /^[A-Za-z]:[/\\]/.test(directory)`, and
 * `path.isAbsolute` is bound to the host platform. Measured, not assumed
 * (2026-08-10, issue #1619 review round 4, F5):
 *
 *   | root                        | POSIX host | Windows host |
 *   | --------------------------- | ---------- | ------------ |
 *   | `/srv/app`                  | accepted   | accepted     |
 *   | `C:/app`, `C:\app`          | accepted   | accepted     |
 *   | `//server/share/project`    | accepted   | accepted     |
 *   | `\\server\share\project`    | REJECTED   | accepted     |
 *   | `app/relative`              | rejected   | rejected     |
 *
 * So the drive-letter fallback is what makes Windows drive roots portable, and
 * a POSIX root is absolute on Windows too (`path.win32.isAbsolute('/srv')` is
 * true — a driveless rooted path passes there, resolving against the current
 * drive). But the BACKSLASH UNC form is not portable: it is win32-absolute and
 * not posix-absolute, and no fallback covers it, so it validates on Windows and
 * throws on a Linux CI runner. Only the forward-slash UNC spelling is accepted
 * on both.
 *
 * UNC paths are intentionally accepted ON WINDOWS: they are absolute there and
 * can be a legitimate project root. Rejecting them would silently re-create the
 * dead-feature class this function exists to fix, because every caller sits
 * behind a debug-gated catch. Nothing is lost by the POSIX rejection — a
 * `\\server\share` root is not a usable path on POSIX in the first place.
 *
 * NOT interchangeable with `validateProjectRoot` (src/evidence/manager.ts).
 * That one is a filesystem-touching, fail-closed check that the directory is
 * the OUTERMOST project root (no ancestor owns a `.swarm/`). It does I/O
 * (realpathSync plus a bounded ancestor walk) on every call and it correctly
 * REJECTS a linked git worktree whose parent checkout has a `.swarm/` — right
 * for a one-shot evidence write, wrong for a per-turn chat-transform hook.
 * Reserve it for writes that must be pinned to the outermost project root.
 *
 * @param directory - the injected, trusted project root
 * @throws Error if the directory is not a usable absolute project root
 */
export function validateProjectDirectory(directory: string): void {
	if (!directory || directory.trim() === '') {
		throw new Error('Invalid project directory: empty');
	}
	if (containsPathTraversal(directory)) {
		throw new Error('Invalid project directory: path traversal detected');
	}
	if (containsControlChars(directory)) {
		throw new Error('Invalid project directory: control characters detected');
	}
	if (!path.isAbsolute(directory) && !/^[A-Za-z]:[/\\]/.test(directory)) {
		throw new Error('Invalid project directory: must be an absolute path');
	}
	assertNotSystemLocation(directory);
}

/**
 * Directory names that must never HOST a project root, checked as the first
 * segment below the filesystem/drive root and denied together with everything
 * under them.
 *
 * Both lists are applied on every platform, deliberately: a Windows host can be
 * handed a driveless rooted path (`path.win32.isAbsolute('/etc')` is true) and a
 * POSIX-shaped deny list evaluated only on POSIX would let `/etc` through there.
 * Platform-independent evaluation also keeps the contract identical on a Linux
 * CI runner and a Windows dev host, which is the property the UNC divergence
 * above cost us.
 *
 * `var` is deliberately ABSENT: macOS `os.tmpdir()` is `/var/folders/...`, and
 * denying that subtree would reject every temp-rooted test workspace.
 */
const DENIED_ROOT_SUBTREES = new Set([
	// POSIX system hierarchy
	'etc',
	'usr',
	'bin',
	'sbin',
	'lib',
	'lib64',
	'boot',
	'dev',
	'proc',
	'sys',
	// Windows system hierarchy, denied on ANY drive: the harm this prevents was
	// observed at `E:\Windows`, not `C:\Windows` (issue #1619).
	'windows',
	'winnt',
	'program files',
	'program files (x86)',
	'programdata',
	'system volume information',
]);

/**
 * Directory names that are denied only as an EXACT root child, not as a
 * subtree. `C:\Users` is never a project root; `C:\Users\brett\repo` is the
 * normal case and must keep working.
 */
const DENIED_EXACT_ROOT_CHILDREN = new Set(['users', 'home', 'root']);

/**
 * Reject a filesystem/drive root or a system location as a project root.
 *
 * WHY THIS EXISTS (issue #1619). `validateProjectDirectory` requires an
 * absolute path, and absoluteness alone is not containment: every caller
 * ultimately writes under `<root>/.swarm/`, so a root of `E:\` or `\Windows`
 * produces real writes at a drive root. That is not hypothetical — running
 * `tests/security/adversarial/services-path-traversal.test.ts` against the
 * absolute-accepting validator created `E:\.swarm\session\budget-state.json`,
 * `E:\Windows\` and `E:\Users\Brett\AppData\Local\` on the author's machine.
 * The pre-#1619 assertions that "an absolute directory is rejected" were
 * covering this, and reinstating the coverage — rather than the mechanism,
 * which also made the features dead — is what keeps the fix honest.
 *
 * Purely lexical, like the rest of this function: no `realpathSync`, no
 * ancestor walk, no I/O. Callers sit on a per-turn hot path behind a
 * debug-gated catch, so an I/O-bound check here would be both a latency
 * regression and a silent-failure risk. Canonical containment of the WRITE
 * remains owned by `validateSwarmPath` / `validateSymlinkBoundary`.
 */
function assertNotSystemLocation(directory: string): void {
	// Evaluated under BOTH parsers, never the host's `path`. `path.resolve` is
	// bound to the running platform, and on POSIX a backslash is an ordinary
	// filename character — so `path.resolve('C:\\Windows')` on Linux yields
	// `<cwd>/C:\Windows`, whose first segment is `home`, and the deny list never
	// sees `Windows`. That made the guard pass on a Windows dev host and fail on
	// an ubuntu CI runner (PR #2129). Checking both parsers and rejecting if
	// EITHER flags the path keeps the contract identical everywhere, which is the
	// same property the UNC divergence above cost us.
	for (const parser of [path.win32, path.posix]) {
		if (!parser.isAbsolute(directory)) continue;

		const normalized = parser.normalize(directory);
		const { root } = parser.parse(normalized);
		const segments = normalized
			.slice(root.length)
			.split(/[/\\]/)
			.filter((segment) => segment.length > 0);

		if (segments.length === 0) {
			throw new Error(
				`Invalid project directory: filesystem root is not a project root (${directory})`,
			);
		}

		const first = (segments[0] ?? '').toLowerCase();
		if (
			DENIED_ROOT_SUBTREES.has(first) ||
			(segments.length === 1 && DENIED_EXACT_ROOT_CHILDREN.has(first))
		) {
			throw new Error(
				`Invalid project directory: system location is not a project root (${directory})`,
			);
		}
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
	const canonicalRoot = canonicalExistingFilesystemPath(rootPath);
	if (canonicalRoot === null) return false;
	const rootPrefix = canonicalRoot.endsWith('/')
		? canonicalRoot
		: `${canonicalRoot}/`;

	// Walk up to the nearest existing ancestor of the (possibly not-yet-created)
	// target so symlinks on any existing component are resolved.
	let probe = path.resolve(targetPath);
	// Guard against an unbounded loop on malformed input.
	for (let i = 0; i < 4096; i++) {
		const canonicalProbe = canonicalExistingFilesystemPath(probe);
		if (canonicalProbe !== null) {
			return (
				canonicalProbe === canonicalRoot ||
				canonicalProbe.startsWith(rootPrefix)
			);
		}
		const parent = path.dirname(probe);
		if (parent === probe) return false; // reached filesystem root, nothing resolved
		probe = parent;
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
	validateProjectDirectory: typeof validateProjectDirectory;
	validateSymlinkBoundary: typeof validateSymlinkBoundary;
	isCanonicalPathWithinRoot: typeof isCanonicalPathWithinRoot;
	validateTargetWithinRoot: typeof validateTargetWithinRoot;
} = {
	realpathSync: fs.realpathSync,
	containsPathTraversal,
	containsControlChars,
	validateDirectory,
	validateProjectDirectory,
	validateSymlinkBoundary,
	isCanonicalPathWithinRoot,
	validateTargetWithinRoot,
} as const;
