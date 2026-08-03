/**
 * Swarm worktree-lane context detection.
 *
 * ## Why this exists
 *
 * OpenCode partitions **all** permission state by *directory*. Every service
 * that matters — `Permission.state`, `Agent.state`, `Plugin.state`,
 * `ToolRegistry.state` — is built through the same directory-keyed
 * `InstanceState` cache. When opencode-swarm creates a worktree-lane session
 * bound to a new directory (`session.create({ query: { directory: lanePath } })`),
 * that lane gets a brand-new permission universe: an empty `approved` list, so
 * every prior "Allow always" is forgotten, and a private pending map. Because a
 * lane instance has no TUI attached, an `external_directory` prompt raised there
 * can never be answered and the lane hangs forever (the host's `Permission.ask`
 * awaits its deferred with no timeout).
 *
 * The fix is to pre-resolve permissions for lane instances via the plugin
 * `config` hook. That requires answering one question cheaply and reliably:
 * **is this directory a swarm worktree lane, and if so, what project is it a
 * worktree of?**
 *
 * ## Why there is no `git` subprocess here
 *
 * The obvious implementation is
 * `git -C <lane> rev-parse --path-format=absolute --git-common-dir`. This module
 * deliberately does not do that. `resolveLaneContext` is called from the plugin
 * `config` hook, which the host runs inside `Plugin.state` initialisation —
 * squarely on the plugin-init path that AGENTS.md invariant 1 governs, and that
 * invariant names Git commands explicitly as forbidden there.
 *
 * Instead this module reads the two files git itself would consult:
 *
 *   - `<lane>/.git` — in a linked worktree this is a *file*, not a directory,
 *     containing `gitdir: <main>/.git/worktrees/<name>`.
 *   - `<main>/.git/worktrees/<name>/commondir` — a relative pointer back to the
 *     shared `.git` directory (normally `../..`).
 *
 * That is the same information the subprocess would return, obtained with at
 * most two small synchronous reads, no child process, no timeout to get wrong,
 * and nothing to kill in a `finally`. It is strictly safer on the init path than
 * a spawn would be, and it removes an entire class of invariant-3 exposure.
 *
 * @module config/lane-context
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { addDeferredWarning } from '../services/warning-buffer';
import { matchSwarmLaneBranch, matchSwarmLanePath } from './swarm-branch';

/**
 * A resolved swarm worktree lane.
 */
export interface LaneContext {
	/** Absolute, resolved path of the lane worktree itself. */
	lanePath: string;
	/**
	 * Absolute, resolved path of the project this lane is a git worktree of —
	 * i.e. the main working tree that owns the shared `.git` directory.
	 */
	parentProjectPath: string;
}

/**
 * Maximum number of directories held in the detection cache.
 *
 * AGENTS.md invariant 8: module-level state must be bounded with an explicit
 * eviction strategy. Detection runs on hot paths (the `config` hook, and any
 * future per-call consumer), and the key space is "directories OpenCode has
 * opened an instance for" — small in practice, but not provably so across a
 * long-lived server that opens many lanes.
 */
const MAX_CACHED_DIRECTORIES = 256;

/**
 * Resolved-directory -> detection result. `null` is a real, cached answer
 * ("not a lane"), which is the common case and the one most worth caching.
 */
const laneContextCache = new Map<string, LaneContext | null>();

/**
 * Test-only dependency-injection seam (AGENTS.md invariant 7 — prefer
 * `_internals` over `mock.module`, which leaks across files in Bun's shared
 * test-runner process). Tests replace these to simulate unreadable `.git`
 * files, malformed pointers, and permission errors. Restore in `afterEach`.
 */
export const _internals = {
	readFileSync: fs.readFileSync as (p: string, enc: BufferEncoding) => string,
	statSync: fs.statSync as (p: string) => { isFile(): boolean },
	addDeferredWarning,
	/**
	 * Clears the detection cache. Test-only; production has no reason to call
	 * it because a directory's lane-ness cannot change while the process holds
	 * an OpenCode instance for that directory.
	 */
	clearCache: (): void => {
		laneContextCache.clear();
	},
};

/**
 * Hard cap on the ancestor walk that locates a lane root from a nested
 * instance directory. Bounds the work on the plugin-init path and terminates
 * even if `path.dirname` never reaches a fixed point on some exotic path.
 */
const MAX_ANCESTOR_WALK_DEPTH = 40;

/**
 * Bounded retry for the detection I/O.
 *
 * `applyLanePermissions` is called exactly once per instance from the plugin
 * `config` hook, so a transient failure has no second chance: the lane simply
 * reverts to unscoped permissions, i.e. the original unbounded-prompt hang.
 * `EMFILE` is entirely plausible under the normal swarm workload, where many
 * lanes spawn at once.
 *
 * Cost is paid only on the ERROR path. The nominal bound is
 * (MAX_DETECTION_ATTEMPTS - 1) * DETECTION_RETRY_BACKOFF_MS = 10 ms, but the
 * REAL bound is platform-dependent: `Atomics.wait` inherits the OS timer
 * granularity, and on Windows (~15.6 ms) a 5 ms request measures 14.8 ms
 * average / 16.0 ms max, giving a worst case of ~32 ms for two backoffs.
 * Measured on win32; Linux/macOS granularity is finer so the real bound there
 * should be nearer the nominal 10 ms, but that is UNMEASURED. ~32 ms against
 * the ~400 ms init deadline is acceptable, and this number is the whole
 * justification for putting a thread-blocking wait on the init path, so it is
 * stated as measured rather than as arithmetic.
 *
 * NOT fail-closed: an exhausted retry still reports "not a lane". Treating an
 * I/O failure as "this IS a lane" would inject deny rules into ordinary
 * sessions — the false-positive class that took three review rounds to
 * eliminate. Retry, then warn.
 */
const MAX_DETECTION_ATTEMPTS = 3;
const DETECTION_RETRY_BACKOFF_MS = 5;

/**
 * Synchronous sleep. `resolveLaneContext` is sync (the host's `config` hook
 * mutates a shared object and cannot be made async here), so `Atomics.wait` is
 * used rather than a spin loop: it blocks without burning CPU, and only ever
 * runs after an I/O error.
 */
function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// SharedArrayBuffer unavailable — skip the backoff, still bounded.
	}
}

/**
 * Records a NEGATIVE detection result, but only when it is a real answer.
 *
 * A transient `EACCES` / `EMFILE` / `EBUSY` while reading git metadata is not
 * evidence that a directory is "not a lane". Caching that would poison the
 * directory for the entire process lifetime, silently disabling lane permission
 * scoping. So an I/O failure is never cached — but note that on the production
 * path `applyLanePermissions` runs exactly ONCE per instance from the config
 * hook, so "not cached" does not mean "retried later": there is no later call.
 * {@link resolveLaneContext} therefore retries in-line before giving up, and
 * this function reports the exhausted case.
 *
 * The warning fires on ANY I/O failure, not only when the path carries a
 * `.swarm-worktrees` segment. Gating it on that heuristic meant the layouts the
 * heuristic cannot see — a `worktree_dir` override and the Windows `swwt`
 * fallback — got no warning at all, which are precisely the cases most likely
 * to matter.
 */
function remember(
	key: string,
	value: null,
	io: { failed: boolean },
): LaneContext | null {
	if (!io.failed) return cache(key, value);
	try {
		_internals.addDeferredWarning(
			`[swarm] Could not read git metadata for ${key} after ${MAX_DETECTION_ATTEMPTS} attempts; worktree-lane permission scoping was skipped for it. If this directory IS a swarm lane, external-directory prompts raised there cannot be answered and the lane may hang. Check filesystem permissions and open-file limits, then restart the session.`,
		);
	} catch {
		// Advisory delivery must never break detection.
	}
	return null;
}

function cache(key: string, value: LaneContext | null): LaneContext | null {
	// FIFO eviction — Map preserves insertion order, so the first key is the
	// oldest. Evict before insert so the map never exceeds the cap.
	if (laneContextCache.size >= MAX_CACHED_DIRECTORIES) {
		const oldest = laneContextCache.keys().next();
		if (!oldest.done) laneContextCache.delete(oldest.value);
	}
	laneContextCache.set(key, value);
	return value;
}

/**
 * PRIMARY ownership signal: reads `<gitDir>/HEAD` and reports whether the
 * worktree is checked out on a branch this project's `makeWorktreeBranchName`
 * produces.
 *
 * The worktree PATH is not a reliable marker. `provisionWorktree` can place a
 * lane in any of three layouts, and only the first contains
 * `.swarm-worktrees`:
 *
 *   1. `<project-parent>/.swarm-worktrees/<sessionId>/<id>` (DD-6 default)
 *   2. `path.resolve(directory, worktree.worktree_dir)` (configured override)
 *   3. `<os.tmpdir()>/swwt/<sessionId>/<laneId>` — the Windows path-budget
 *      fallback in `shortenWorktreePath()`, which fires with NO user
 *      configuration whenever the default path would exceed the 250-char
 *      budget. Windows is precisely where this defect was reported.
 *
 * The branch name is invariant across all three, and is a single cheap read of
 * a file git maintains.
 */
function isSwarmOwnedBranch(gitDir: string, io: { failed: boolean }): boolean {
	let head: string;
	try {
		head = _internals.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') io.failed = true;
		return false;
	}
	// `ref: refs/heads/<branch>`. A detached HEAD holds a bare SHA and yields
	// no branch, which correctly reports "unknown ownership" and defers to the
	// secondary path signal.
	const match = /^\s*ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
	const branch = match?.[1];
	if (!branch) return false;
	// Full-grammar match, NOT a prefix test: a user-authored branch such as
	// `swarm/my-own-experiment` must not be mistaken for a lane.
	return matchSwarmLaneBranch(branch) !== undefined;
}

/**
 * Reads `<directory>/.git` when it is a *file* (the linked-worktree shape) and
 * returns the absolute git directory it points at, or `undefined`.
 *
 * A `.git` *directory* means this is a main working tree, not a linked
 * worktree — which is a legitimate "not a lane" answer, not an error.
 */
function readLinkedWorktreeGitDir(
	directory: string,
	io: { failed: boolean },
): string | undefined {
	const dotGit = path.join(directory, '.git');
	let stat: { isFile(): boolean };
	try {
		stat = _internals.statSync(dotGit);
	} catch (err) {
		// ENOENT is a real answer ("no .git here"); anything else is an I/O
		// failure whose result must NOT be cached as a negative — see the
		// `io.failed` handling in resolveLaneContext.
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') io.failed = true;
		return undefined;
	}
	if (!stat.isFile()) return undefined;

	let contents: string;
	try {
		contents = _internals.readFileSync(dotGit, 'utf-8');
	} catch (err) {
		// The `.git` file demonstrably exists (statSync succeeded), so failing to
		// read it is always an I/O problem, never "not a lane".
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') io.failed = true;
		return undefined;
	}

	// Format: `gitdir: <path>` on the first line. The path may be absolute or
	// relative to the worktree, and git writes forward slashes even on Windows.
	const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents);
	const pointer = match?.[1];
	if (!pointer) return undefined;
	// path.resolve keeps an absolute pointer as-is and anchors a relative one
	// to the worktree, matching git's own interpretation.
	return path.resolve(directory, pointer);
}

/**
 * Resolves the main working tree that owns `gitDir`
 * (`<main>/.git/worktrees/<name>`).
 *
 * Prefers the `commondir` file, which git maintains as the authoritative
 * pointer to the shared `.git` directory and which stays correct even if the
 * administrative layout changes. Falls back to the documented layout when
 * `commondir` is absent or unreadable.
 */
function resolveMainWorktree(
	gitDir: string,
	io: { failed: boolean },
): string | undefined {
	let commonDir: string | undefined;
	try {
		const raw = _internals.readFileSync(
			path.join(gitDir, 'commondir'),
			'utf-8',
		);
		const trimmed = raw.trim();
		if (trimmed) commonDir = path.resolve(gitDir, trimmed);
	} catch (err) {
		// A missing commondir is normal for older layouts — fall through to the
		// documented `.git/worktrees/<n>` shape. Any OTHER error is real I/O
		// trouble and must not be cached as a negative.
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') io.failed = true;
	}

	if (commonDir) {
		// commondir points at the shared `.git`; its parent is the main worktree.
		const parent = path.dirname(commonDir);
		return parent && parent !== commonDir ? parent : undefined;
	}

	// Fallback: `<main>/.git/worktrees/<name>` -> strip `<name>`, `worktrees`,
	// `.git`. Verify the shape rather than blindly slicing three levels, so a
	// non-conforming pointer yields "not a lane" instead of a wrong parent.
	const worktreesDir = path.dirname(gitDir);
	if (path.basename(worktreesDir) !== 'worktrees') return undefined;
	const sharedGitDir = path.dirname(worktreesDir);
	if (path.basename(sharedGitDir) !== '.git') return undefined;
	const parent = path.dirname(sharedGitDir);
	return parent && parent !== sharedGitDir ? parent : undefined;
}

/**
 * Decides whether `directory` is a swarm worktree lane and, if so, resolves the
 * lane path and the parent project it is a worktree of.
 *
 * Detection requires two independent conditions, the second of which may be
 * satisfied either way:
 *
 *  1. REQUIRED — the directory (or a bounded number of its ancestors) is a real
 *     LINKED git worktree whose main working tree resolves. A main working tree
 *     has a `.git` directory rather than a file and is never a lane.
 *  2. REQUIRED — the worktree is swarm-OWNED, established by EITHER
 *     (a) its branch matching the full grammar in `./swarm-branch.ts`
 *         (`swarm/<purpose>/<sessionId>/<id>` or `swarm-lane/<sessionId>/<id>`,
 *         with `<sessionId>` of the form `ses_…`) — the authoritative,
 *         path-independent signal; OR
 *     (b) the path sitting under a `.swarm-worktrees` base — the fallback for a
 *         worktree whose HEAD is detached or unreadable, so its branch cannot
 *         be consulted.
 *
 * (2a) is a full-grammar match rather than a `swarm/` prefix test on purpose: a
 * user-authored `swarm/my-own-experiment` worktree must NOT be captured. A
 * false positive is worse than a false negative here — see the module note in
 * `./swarm-branch.ts`.
 *
 * A detached-HEAD swarm lane created OUTSIDE `.swarm-worktrees` (a
 * `worktree_dir` override, or the Windows path-budget fallback) satisfies
 * neither branch of (2) and is a false NEGATIVE: no permission changes, i.e.
 * today's behaviour. That is the safe direction and is left as-is.
 *
 * NEVER throws. Any error — nonexistent directory, unreadable `.git`, malformed
 * pointer, permission error, non-string input — yields `null` ("not a lane"),
 * which preserves today's behaviour for ordinary sessions. That direction is
 * the safe one: a false negative means "no permission changes at all", while a
 * false positive would apply a deny-by-default ruleset to a normal project.
 *
 * @param directory - Directory to classify (typically the plugin's own
 *                    `ctx.directory`, which under this host IS the instance
 *                    directory).
 * @returns The resolved lane context, or `null` when `directory` is not a lane.
 */
export function resolveLaneContext(directory: string): LaneContext | null {
	if (typeof directory !== 'string' || directory.trim() === '') return null;

	let resolved: string;
	try {
		resolved = path.resolve(directory);
	} catch {
		return null;
	}

	const cached = laneContextCache.get(resolved);
	if (cached !== undefined) return cached;

	// Bounded retry: a transient I/O failure must not silently downgrade a real
	// lane to "unscoped" — there is no second call on the production path.
	let io = { failed: false };
	let result: LaneContext | null = null;
	for (let attempt = 1; attempt <= MAX_DETECTION_ATTEMPTS; attempt += 1) {
		io = { failed: false };
		result = attemptDetection(resolved, io);
		// Success, or a definitive negative (no I/O trouble) — done either way.
		if (result !== null || !io.failed) break;
		if (attempt < MAX_DETECTION_ATTEMPTS) sleepSync(DETECTION_RETRY_BACKOFF_MS);
	}
	if (result !== null) return cache(resolved, result);
	return remember(resolved, null, io);
}

/**
 * One detection attempt. Returns the lane context, or `null` with `io.failed`
 * set when the negative was caused by an I/O error rather than by a real
 * answer.
 */
function attemptDetection(
	resolved: string,
	io: { failed: boolean },
): LaneContext | null {
	try {
		// Signal 1 (required): find the nearest ancestor (including `resolved`
		// itself) that is a real LINKED git worktree. A main working tree has a
		// `.git` DIRECTORY, not a file, and is never a lane.
		//
		// The walk exists because an OpenCode instance can be bound to a
		// directory NESTED below a lane root, which has no `.git` of its own; it
		// still shares the lane's permission universe and must classify the same
		// way.
		let laneRoot: string | undefined;
		let gitDir: string | undefined;
		let current = resolved;
		for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth += 1) {
			const candidate = readLinkedWorktreeGitDir(current, io);
			if (candidate) {
				laneRoot = current;
				gitDir = candidate;
				break;
			}
			const parent = path.dirname(current);
			// `path.dirname` is idempotent at a filesystem root.
			if (parent === current) break;
			current = parent;
		}
		if (!laneRoot || !gitDir) return null;

		// Signal 2 (required): the worktree must be swarm-owned. Branch name is
		// authoritative and path-independent; the `.swarm-worktrees` path
		// segment is the fallback for a detached or unreadable HEAD.
		const swarmOwned =
			isSwarmOwnedBranch(gitDir, io) ||
			matchSwarmLanePath(laneRoot) !== undefined;
		if (!swarmOwned) return null;

		const parentProjectPath = resolveMainWorktree(gitDir, io);
		if (!parentProjectPath) return null;

		// A lane must not resolve to itself as its own parent; that would mean
		// the git metadata is inconsistent and any allowlist built from it would
		// be meaningless.
		if (path.resolve(parentProjectPath) === laneRoot) {
			return null;
		}

		return {
			lanePath: laneRoot,
			parentProjectPath: path.resolve(parentProjectPath),
		};
	} catch {
		// Belt-and-braces: the helpers above already swallow their own I/O
		// errors, but detection must be total. Any unexpected throw degrades to
		// "not a lane" rather than propagating into the host's init path.
		io.failed = true;
		return null;
	}
}
