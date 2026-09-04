/**
 * Git worktree lifecycle operations for lean turbo parallel lanes.
 *
 * Provides five public functions for creating, removing, inspecting, and
 * cleaning git worktrees used by parallel coder lanes. All subprocess
 * calls go through the `_internals` DI seam so tests can replace the
 * real `bunSpawn` without leaking across Bun's shared test-runner process.
 *
 * @module worktree
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SWARM_WORKTREE_DIR_NAME } from '../config/constants';
import {
	buildSwarmBranchName,
	matchSwarmLaneBranch,
} from '../config/swarm-branch';
import { advisoryWarn } from '../services/warning-buffer';
import { log } from '../utils';
import { bunSpawn } from '../utils/bun-compat';
import { resolveGitExecutable } from '../utils/git-executable.js';
// Note: writeScopeToDisk is accessed via _internals.writeScopeToDisk at call time
// to allow DI for tests without mock.module leakage. The top-level import is intentionally
// omitted; the seam default performs a dynamic import on first use.
import type {
	DependencyPreparationStrategy,
	WorktreeHandle,
	WorktreeOptions,
	WorktreeProvisionResult,
} from './types';

// ---------------------------------------------------------------------------
// _internals DI seam
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.bunSpawn(...)` so tests can replace the function on this object
 * without touching the real `../../utils/bun-compat` module — `mock.module`
 * from `bun:test` leaks across files in Bun's shared test-runner process,
 * which would corrupt unrelated suites that import `bun-compat`. Mutating this
 * local object is file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	bunSpawn: typeof bunSpawn;
	/** Test seam for process.platform — allows non-Windows CIs to exercise Windows paths. */
	platform: string;
	/** Test seam for sleep — allows tests to skip real delays. */
	sleep: (ms: number) => Promise<void>;
	/** Test seam for os.tmpdir() — allows tests to control temp path. */
	osTmpdir: () => string;
	/**
	 * Test seam for querying `git config core.longpaths`.
	 * Returns `'true'` | `'false'` | `undefined` (not set or query failed).
	 * Production implementation runs `git config core.longpaths` via runGit.
	 */
	getCoreLongPaths: (directory: string) => Promise<string | undefined>;
	/** Test seam for filesystem ops used by deps_strategy copy/link (DI to avoid mock.module leaks). */
	fs: {
		existsSync: typeof fs.existsSync;
		cp: typeof fsPromises.cp;
		cpSync: typeof fs.cpSync;
		symlinkSync: typeof fs.symlinkSync;
	};
	/**
	 * Test seam for scope materialization into worktree lanes (FR-102).
	 * Allows tests to inject a spy without mock.module on node:fs or scope-persistence.
	 */
	writeScopeToDisk: (
		directory: string,
		taskId: string,
		files: string[],
	) => Promise<void>;
	/**
	 * Test seam for lane runtime profile materialization into worktree lanes (FR-201).
	 * Allows tests to inject a spy without mock.module on node:fs.
	 */
	writeLaneProfileToDisk: (
		worktreePath: string,
		laneIndex: number,
		envOverrides: Record<string, string>,
	) => Promise<void>;
	/**
	 * Test seam for lane profile removal at teardown (FR-205 SC-134).
	 * Allows tests to inject a spy without mock.module on node:fs.
	 */
	removeLaneProfileFromDisk: (
		worktreePath: string,
		laneIndex: number,
	) => Promise<void>;
	/** Test seam for removeWorktree — allows tests to intercept worktree removal calls. */
	removeWorktree: typeof removeWorktree;
	/**
	 * Test seam for the git binary resolution (issue #2236 hardening, lane
	 * C1b) — see `src/utils/git-executable.ts`. Allows tests to stub a
	 * deterministic value instead of exercising the real filesystem-probing
	 * resolver against a mocked `bunSpawn`.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
} = {
	bunSpawn,
	resolveGitExecutable,
	platform: process.platform,
	sleep: (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
	osTmpdir: () => os.tmpdir(),
	getCoreLongPaths: async (directory: string) => {
		const result = await runGit(['config', 'core.longpaths'], directory);
		if (result.exitCode !== 0) {
			return undefined;
		}
		const value = result.stdout.trim().toLowerCase();
		return value === '' ? undefined : value;
	},
	fs: {
		existsSync: fs.existsSync,
		cp: fsPromises.cp,
		cpSync: fs.cpSync,
		symlinkSync: fs.symlinkSync,
	},
	writeScopeToDisk: async (
		directory: string,
		taskId: string,
		files: string[],
	) => {
		// Default delegates to the real implementation.
		// Tests replace this to spy or no-op.
		const { writeScopeToDisk: realWrite } = await import(
			'../scope/scope-persistence'
		);
		return realWrite(directory, taskId, files);
	},
	writeLaneProfileToDisk: async (
		_worktreePath: string,
		_laneIndex: number,
		_envOverrides: Record<string, string>,
	) => {
		// Default delegates to the real implementation.
		// Tests replace this to spy or no-op.
		return writeLaneProfileToDiskReal(_worktreePath, _laneIndex, _envOverrides);
	},
	removeLaneProfileFromDisk: async (
		_worktreePath: string,
		_laneIndex: number,
	) => {
		// Default delegates to the real implementation.
		// Tests replace this to spy or no-op.
		return removeLaneProfileFromDiskReal(_worktreePath, _laneIndex);
	},
	removeWorktree,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * FR-201 SC-124: Writes the lane runtime profile as `.swarm/lanes/{laneIndex}.env`.
 *
 * The file is written in KEY=VAL format (one entry per line) so it can be
 * sourced by shell scripts or parsed by Node.js.
 *
 * Defense-in-depth: failures are non-fatal. The lane can still function without
 * the env file if the write fails (e.g. permissions), as long as the child
 * processes get the env vars through other means.
 *
 * @param worktreePath - Absolute path to the lane worktree root.
 * @param laneIndex    - 0-based lane index used for filename derivation.
 * @param envOverrides - Map of env var names to values (set) or null (unset).
 */
export async function writeLaneProfileToDiskReal(
	worktreePath: string,
	laneIndex: number,
	envOverrides: Record<string, string>,
): Promise<void> {
	// Build KEY=VAL lines; skip null values (unset)
	const lines: string[] = [];
	for (const [key, value] of Object.entries(envOverrides)) {
		if (value === null) continue;
		// Basic safety: skip keys that would be shell-injection vectors
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		// Skip values containing newlines — they would corrupt the KEY=VAL file format
		if (value.includes('\n') || value.includes('\r')) {
			log('writeLaneProfileToDisk: skipping env var with newline in value', {
				key,
			});
			continue;
		}
		lines.push(`${key}=${value}`);
	}

	if (lines.length === 0) return;

	// Create .swarm/lanes/ directory
	const lanesDir = path.join(worktreePath, '.swarm', 'lanes');
	await fs.promises.mkdir(lanesDir, { recursive: true });

	// Write {laneIndex}.env
	const envPath = path.join(lanesDir, `${laneIndex}.env`);
	await fs.promises.writeFile(envPath, `${lines.join('\n')}\n`, 'utf-8');
}

/**
 * FR-205 SC-134: Removes the lane runtime profile `.swarm/lanes/{laneIndex}.env`.
 *
 * Called at lane teardown to clean up the materialization created by
 * `writeLaneProfileToDiskReal`. Removing this file prevents stale lane data
 * from accumulating in `.swarm/lanes/` across phases.
 *
 * Defense-in-depth: failures are non-fatal. The lane teardown can still
 * complete even if the env file removal fails (e.g. permissions).
 *
 * @param worktreePath - Absolute path to the lane worktree root.
 * @param laneIndex   - 0-based lane index used for filename derivation.
 */
export async function removeLaneProfileFromDiskReal(
	worktreePath: string,
	laneIndex: number,
): Promise<void> {
	const envPath = path.join(
		worktreePath,
		'.swarm',
		'lanes',
		`${laneIndex}.env`,
	);
	try {
		await fs.promises.unlink(envPath);
	} catch (err) {
		// ENOENT means the file was already absent — this is fine.
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			log(
				`[worktree] Failed to remove lane profile ${envPath}: ${(err as Error).message}`,
			);
		}
	}
}

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Default timeout for git worktree operations (30 seconds). */
const WORKTREE_TIMEOUT_MS = 30_000;
/**
 * Issue #2271 bug 1: budget for the two post-provision verification probes
 * (`.git` stat + `git rev-parse --git-dir` inside the fresh lane). These run
 * on an already-created lane, so a tight bound suffices — a lane whose git
 * link cannot be probed in 5 s is broken, not slow.
 */
const WORKTREE_VERIFICATION_TIMEOUT_MS = 5_000;

/**
 * Windows MAX_PATH safety margin. The OS limit is 260 characters; we use
 * 250 to leave room for UNC prefix overhead or other edge cases.
 */
const WIN_PATH_BUDGET = 250;

/**
 * Exit code reported when git never started at all (resolution or spawn
 * failure). Mirrors `GIT_SPAWN_FAILURE_EXIT_CODE` in `./merge.ts`; kept local
 * rather than shared so `core.ts` gains no import edge on `merge.ts`.
 */
const GIT_SPAWN_FAILURE_EXIT_CODE = 1;

/**
 * Runs a git command via `_internals.bunSpawn` and returns the exit code,
 * captured stdout, and captured stderr.
 *
 * Every call uses:
 * - Array-form command (never shell-string)
 * - Explicit `cwd`
 * - `stdin: 'ignore'` (prevents Bun/Windows pipe hangs)
 * - Bounded `timeout`
 * - Best-effort `proc.kill()` in `finally`
 *
 * Never throws on a start failure. Resolution and spawn are contained
 * TOGETHER, inside one guard, and mapped onto the non-zero `GitResult` this
 * function already returns for a git that did not succeed (the containment
 * shape used by `src/review/diff-source.ts`).
 *
 * `resolveGitExecutable()` no longer throws on its own account — every
 * non-accepting outcome returns the bare `'git'` name (issue #2236 BL-1, see
 * `src/utils/git-executable.ts`) — so the containment is no longer there to
 * catch a `GitBinaryMissingError`. It stays because the guarded region is
 * still genuinely throw-capable: the spawn it wraps throws, and
 * `_internals.resolveGitExecutable` is a DI seam a caller (or a test) can
 * replace with something that does. Resolving OUTSIDE the guard would let any
 * such throw escape `runGit` entirely — structurally the same leak as the
 * original `merge.ts` defect issue #2236 fixes.
 */
async function runGit(
	args: string[],
	cwd: string,
	timeoutMs = WORKTREE_TIMEOUT_MS,
): Promise<GitResult> {
	let proc: ReturnType<typeof _internals.bunSpawn>;
	try {
		proc = _internals.bunSpawn([_internals.resolveGitExecutable(), ...args], {
			cwd,
			timeout: timeoutMs,
			stdin: 'ignore' as const,
			stdout: 'pipe' as const,
			stderr: 'pipe' as const,
			env: { ...process.env, LC_ALL: 'C' },
		});
	} catch (error) {
		return {
			exitCode: GIT_SPAWN_FAILURE_EXIT_CODE,
			stdout: '',
			stderr: `git ${args[0] ?? 'command'} could not start in ${cwd}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort — process may already be exited
		}
	}
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

// ---- Path budget (Windows) ----

interface PathBudgetOk {
	ok: true;
}

interface PathBudgetExceeded {
	ok: false;
	error: string;
	suggestion: string;
}

/**
 * Checks whether the total path length for files inside a worktree would
 * exceed the Windows MAX_PATH budget (260 chars).
 *
 * On non-Windows platforms this is a no-op and always returns `{ ok: true }`.
 *
 * If `core.longpaths` is enabled in the git config (`true`), the MAX_PATH
 * limit does not apply (Git 2.35+) and the budget check is skipped entirely.
 * If the config query fails or returns anything other than `true`, the
 * existing budget check proceeds (fail-safe).
 *
 * The check runs `git ls-files` via `_internals.bunSpawn` to discover the
 * longest relative file path in the project, then computes
 * `worktreeRoot.length + 1 + longestRelativePath.length`. If this total is
 * >= 250 (a safety margin under 260), the budget is exceeded.
 *
 * @param worktreeRoot - Absolute path to the worktree root directory.
 * @param directory    - Project root (used as `cwd` for `git ls-files`).
 */
export async function checkPathBudget(
	worktreeRoot: string,
	directory: string,
): Promise<PathBudgetOk | PathBudgetExceeded> {
	if (_internals.platform !== 'win32') {
		return { ok: true };
	}

	// If core.longpaths is enabled, skip the budget check entirely.
	// Git 2.35+ bypasses MAX_PATH when this is true.
	// If the query throws, treat as undefined and proceed with budget check (fail-safe).
	let longPaths: string | undefined;
	try {
		longPaths = await _internals.getCoreLongPaths(directory);
	} catch {
		// Fail-safe: treat as undefined and proceed with budget check
	}
	if (longPaths === 'true') {
		return { ok: true };
	}

	// Issue #2236: resolving outside this guard let a throw from the
	// resolve-then-spawn sequence escape an otherwise fail-open advisory
	// check. (`resolveGitExecutable()` itself no longer throws — BL-1 made
	// every non-accepting outcome return the bare `'git'` name — but the spawn
	// does, and `_internals.resolveGitExecutable` is a replaceable DI seam.)
	// Resolution and spawn are contained together and mapped onto this
	// function's documented fail-open contract — every other failure below
	// (non-zero exit, empty output, longpaths query throw) already returns
	// `{ ok: true }`, and a git that cannot start must not be the one failure
	// mode that blocks worktree creation.
	let proc: ReturnType<typeof _internals.bunSpawn>;
	try {
		proc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), 'ls-files'],
			{
				cwd: directory,
				timeout: WORKTREE_TIMEOUT_MS,
				stdin: 'ignore' as const,
				stdout: 'pipe' as const,
				stderr: 'ignore' as const,
				env: { ...process.env, LC_ALL: 'C' },
			},
		);
	} catch {
		return { ok: true };
	}

	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();

		if (exitCode !== 0 || stdout.trim().length === 0) {
			return { ok: true };
		}

		const files = stdout.split(/\r?\n/);
		let longest = 0;
		for (const file of files) {
			if (file.length > longest) {
				longest = file.length;
			}
		}

		const totalPathLength = worktreeRoot.length + 1 + longest;
		if (totalPathLength >= WIN_PATH_BUDGET) {
			return {
				ok: false,
				error: `Total path budget exceeded: worktree root "${worktreeRoot}" (${worktreeRoot.length} chars) + longest file "${files.find((f) => f.length === longest)}" (${longest} chars) = ${totalPathLength} chars (budget: ${WIN_PATH_BUDGET})`,
				suggestion:
					'Set config.worktree_dir to a shorter absolute path, or let the auto-shorten feature relocate the worktree to the system temp directory.',
			};
		}

		return { ok: true };
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort — process may already be exited
		}
	}
}

/**
 * Returns a shortened worktree path under the system temp directory.
 *
 * On non-Windows platforms this is not typically needed but still returns
 * a deterministic path. The returned path is
 * `<os.tmpdir()>/swwt/<sessionId>/<laneId>`.
 *
 * @param directory  - Project root (unused but kept for API symmetry).
 * @param sessionId  - Lean turbo session identifier.
 * @param laneId     - Lane identifier.
 */
export function shortenWorktreePath(
	_directory: string,
	sessionId: string,
	laneId: string,
): string {
	// Resolve os.tmpdir() through realpathSync so the shortened worktree path
	// is canonical. On the GitHub windows-latest runner, os.tmpdir() returns
	// the 8.3 short name (C:\Users\RUNNER~1\...) while git worktree porcelain
	// emits the long form (C:\Users\runneradmin\...). Building the shortened
	// fallback path from the resolved long form keeps it consistent with the
	// porcelain output and with the realpath-resolved fixtures in the tests
	// (issue #1729 Windows quarantine).
	let tmp = _internals.osTmpdir();
	try {
		tmp = fs.realpathSync(tmp);
	} catch {
		// Best-effort: if tmpdir itself doesn't resolve (shouldn't happen in
		// practice), fall through with the lexical form.
	}
	return path.join(tmp, 'swwt', sessionId, laneId);
}

export interface ProvisionSuccess extends WorktreeHandle {}

export interface ProvisionFailure {
	error: string;
}

export interface RemoveSuccess {
	success: true;
}

export interface RemoveFailure {
	error: string;
}

export interface AutoCommitSuccess {
	committed: true;
	message: string;
}

export interface AutoCommitSkip {
	committed: false;
	reason: string;
}

export interface CleanSuccess {
	cleaned: true;
}

export interface CleanFailure {
	cleaned: false;
	error: string;
}

export interface CleanCheckSuccess {
	clean: true;
}

export interface CleanCheckFailure {
	clean: false;
	error: string;
}

export function makeWorktreeBranchName(
	sessionId: string,
	id: string,
	options: Pick<WorktreeOptions, 'purpose' | 'branchStyle'>,
): string {
	// Delegates to the shared grammar in src/config/swarm-branch.ts so that this
	// producer and the lane-detection recogniser (matchSwarmLaneBranch) cannot
	// drift. A new naming style must be added to that grammar, or lanes using it
	// become invisible to lane-permission scoping.
	return buildSwarmBranchName(
		sessionId,
		id,
		options.purpose,
		options.branchStyle === 'legacy-lane' && options.purpose === 'lane',
	);
}

/**
 * Creates a new git worktree for an isolated swarm execution unit.
 *
 * Branch naming defaults to `swarm/<purpose>/<sessionId>/<id>`. Lean Turbo
 * callers pass `branchStyle: 'legacy-lane'` to preserve
 * `swarm-lane/<sessionId>/<laneId>`.
 * Worktree path uses `options.worktreeDir` when set, otherwise defaults to
 * `<project-parent>/.swarm-worktrees/<sessionId>/<id>`.
 *
 * Before creating the worktree, checks whether the branch already exists
 * (via `git branch --list`) and returns an error if so.
 *
 * @param directory  - Project root (an absolute path to the git working tree).
 * @param id        - Execution unit identifier (for example, task or lane ID).
 * @param sessionId - Parent session identifier.
 * @param options   - Worktree purpose, branch naming, and path options.
 * @returns A worktree handle on success, or `{ error: string }` on failure.
 */

/**
 * Resolves the swarm-managed worktree base directory: `directory/worktreeDir`
 * when an override is configured, otherwise the DD-6 default
 * `<project-parent>/.swarm-worktrees`. Shared by `provisionWorktree` (path
 * construction) and the destructive-command guard / removeWorktree force
 * fallback (containment checks) so both sides agree on what counts as
 * "swarm-managed".
 *
 * @param directory   - Project root (an absolute path to the git working tree).
 * @param worktreeDir - Optional worktree-dir override (relative to `directory`
 *                      or absolute). When absent, the DD-6 default base is used.
 * @returns The absolute worktree base directory.
 */
export function resolveWorktreeBaseDir(
	directory: string,
	worktreeDir?: string,
): string {
	return worktreeDir
		? path.resolve(directory, worktreeDir)
		: path.resolve(path.dirname(directory), SWARM_WORKTREE_DIR_NAME);
}

/**
 * Checks whether `targetPath` is contained within the swarm-managed worktree
 * base directory (default base, plus any `worktreeDirOverrides`), using
 * `fs.realpathSync` on both sides to resolve symlinks/junctions before the
 * containment comparison — this both establishes containment AND defeats a
 * symlink/junction escape in one step. Fails closed (returns false) if the
 * target cannot be resolved (e.g. does not exist, or a permission error).
 * Case-insensitive comparison on Windows, matching `isInDeclaredScope` in
 * `src/hooks/guardrails/helpers.ts`.
 *
 * @param targetPath           - Path to check (relative to `directory` or absolute).
 * @param directory            - Project root, used to resolve relative targets
 *                               and the default base.
 * @param worktreeDirOverrides - Additional configured worktree-dir overrides
 *                               whose resolved bases are also treated as trusted.
 * @returns `true` when the resolved target is inside a trusted base, else `false`.
 */
export function isPathUnderSwarmWorktreeBase(
	targetPath: string,
	directory: string,
	worktreeDirOverrides: string[] = [],
): boolean {
	const caseInsensitive = process.platform === 'win32';
	let realTarget: string;
	try {
		realTarget = fs.realpathSync(path.resolve(directory, targetPath));
	} catch {
		return false;
	}
	const bases = [
		resolveWorktreeBaseDir(directory),
		...worktreeDirOverrides.map((d) => resolveWorktreeBaseDir(directory, d)),
	];
	const cmpTarget = caseInsensitive ? realTarget.toLowerCase() : realTarget;
	return bases.some((base) => {
		let realBase: string;
		try {
			realBase = fs.realpathSync(base);
		} catch {
			// Base may not exist yet (e.g. no worktrees created) — fall back to
			// the literal resolved path.
			realBase = path.resolve(base);
		}
		const cmpBase = caseInsensitive ? realBase.toLowerCase() : realBase;
		if (cmpTarget === cmpBase) return true;
		const rel = path.relative(cmpBase, cmpTarget);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
}

export async function provisionWorktree(
	directory: string,
	id: string,
	sessionId: string,
	options: WorktreeOptions,
): Promise<WorktreeProvisionResult> {
	const branchName = makeWorktreeBranchName(sessionId, id, options);

	// STRUCTURAL GUARD — a lane whose branch the recogniser cannot match is a
	// lane that will HANG.
	//
	// Lane permission scoping (src/config/lane-context.ts) identifies a lane by
	// its branch. If we provision one whose branch falls outside the grammar,
	// detection silently returns "not a lane", no permissions are pre-resolved,
	// and the first external_directory request in that lane parks forever on a
	// deferred no TUI can answer — the exact defect this subsystem exists to
	// remove, reintroduced silently.
	//
	// The realistic source is an unvalidated `sessionId`: tool arguments are
	// LLM-supplied (`sessionID: z.string()`), and the host's own `SessionID`
	// brand is only `isStartsWith("ses")`, so a value like `ses-run-1` reaches
	// here intact. Asserting at the provisioning boundary makes the defect
	// unreachable no matter where the id came from.
	//
	// Hard failure, not a warning: silently creating an unrecognisable lane is
	// strictly worse than refusing to create one.
	if (!matchSwarmLaneBranch(branchName)) {
		return {
			error:
				`Refusing to provision worktree: branch "${branchName}" does not match the swarm lane grammar, ` +
				`so lane permission scoping could not recognise it and the lane would hang on the first ` +
				`external-directory prompt. This is almost always an invalid sessionId ("${sessionId}"); ` +
				`it must look like "ses_" followed by letters/digits, and the execution-unit id ("${id}") ` +
				`must be a single path segment.`,
		};
	}

	// Resolve worktree path: explicit config or DD-6 default
	let worktreePath = path.resolve(
		resolveWorktreeBaseDir(directory, options.worktreeDir),
		sessionId,
		id,
	);

	// Windows path budget check (DD-8)
	const budgetResult = await checkPathBudget(worktreePath, directory);
	if (budgetResult.ok === false) {
		if (options.worktreeDir) {
			// User explicitly set worktree_dir — warn but proceed
			advisoryWarn(
				`[swarm] Path budget warning: ${budgetResult.error} ${budgetResult.suggestion}`,
			);
		} else {
			// Try auto-shortening to temp directory
			const shortPath = shortenWorktreePath(directory, sessionId, id);
			const shortBudget = await checkPathBudget(shortPath, directory);
			if (shortBudget.ok === false) {
				return { error: budgetResult.error };
			}
			worktreePath = shortPath;
		}
	}

	// Check if the branch already exists before creating the worktree
	const checkResult = await runGit(
		['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
		directory,
	);
	if (checkResult.exitCode === 0) {
		// Branch exists — reconcile stale vs active worktree (FR-004)
		//
		// Always inspect ALL registered worktrees (not just the expected path).
		// A branch checked out in a different registered worktree (different
		// worktree_dir, shortened temp path, or previous concurrent session)
		// must be treated as an active collision even when the expected path
		// is missing on disk. Without this check, `git worktree add -f` would
		// silently create a second checkout of an active branch.
		const listResult = await runGit(
			['worktree', 'list', '--porcelain'],
			directory,
		);

		// Normalize a filesystem path for equality comparison against git
		// porcelain output. Beyond the trailing-slash/backslash normalization,
		// realpath-canonicalize so that Windows 8.3 short-name vs long-name
		// mismatches don't defeat the comparison (issue #1729 Windows quarantine:
		// GitHub's windows-latest RunnerAdmin user exposes the temp dir as
		// C:\Users\RUNNER~1\... while `git worktree list --porcelain` emits the
		// long form C:\Users\runneradmin\..., so a pure string compare silently
		// mismatches and the active-collision check at line ~409 fires
		// incorrectly — or, conversely, fails to detect a real collision).
		// realpathSync resolves both sides to the canonical underlying path.
		// Best-effort: if the path doesn't exist (e.g. a worktree whose
		// directory was removed but is still registered), fall back to the
		// lexical normalized form so porcelain parsing still works.
		const normalizeGitPath = (p: string): string => {
			const lexical = p.replace(/\\/g, '/').replace(/\/+$/, '');
			try {
				return fs.realpathSync(p).replace(/\\/g, '/').replace(/\/+$/, '');
			} catch {
				return lexical;
			}
		};
		const expectedPath = normalizeGitPath(worktreePath);

		// Parse all worktree entries from porcelain output.
		// Each entry has a "worktree <path>" line and optionally a
		// "branch refs/heads/<name>" line.
		interface ParsedWorktree {
			path: string;
			branch: string | undefined;
			/** #2208: git marks a registration `prunable` when its directory is gone. */
			prunable: boolean;
		}
		let entries: ParsedWorktree[] = [];

		if (listResult.exitCode !== 0) {
			const raw = listResult.stderr.trim() || listResult.stdout.trim();
			const bounded =
				raw.length > 500 ? `${raw.slice(0, 500)}... (truncated)` : raw;
			return {
				error: `worktree enumeration failed: ${bounded}`,
			};
		}

		const parsePorcelain = (stdout: string): ParsedWorktree[] => {
			const parsed: ParsedWorktree[] = [];
			let cur: ParsedWorktree = {
				path: '',
				branch: undefined,
				prunable: false,
			};
			for (const rawLine of stdout.split('\n')) {
				const line = rawLine.trim();
				if (line.startsWith('worktree ')) {
					if (cur.path) parsed.push(cur);
					cur = {
						path: normalizeGitPath(line.slice('worktree '.length)),
						branch: undefined,
						prunable: false,
					};
				} else if (line.startsWith('branch ')) {
					cur.branch = line.slice('branch '.length);
				} else if (line === 'prunable' || line.startsWith('prunable ')) {
					cur.prunable = true;
				}
			}
			if (cur.path) parsed.push(cur);
			return parsed;
		};
		entries = parsePorcelain(listResult.stdout);

		// #2208: a registration git itself marks `prunable` (worktree directory
		// deleted by a crash/kill mid-task while the branch survived) is stale
		// metadata, not an active lane. Without this, the classification below
		// treats the deleted path as an active collision and isCleanWorktree
		// fails on the missing directory — surfacing "expected worktree is
		// dirty" and stalling recovery. Prune the stale registration and
		// re-enumerate; the leftover branch then reconciles through the normal
		// stale-branch path below (ahead-count check + branch -d + re-add).
		const hasPrunableCollision = entries.some(
			(e) =>
				e.prunable &&
				(e.path === expectedPath || e.branch === `refs/heads/${branchName}`),
		);
		if (hasPrunableCollision) {
			const pruneResult = await runGit(['worktree', 'prune'], directory);
			if (pruneResult.exitCode !== 0) {
				return {
					error: `Failed to prune stale worktree registration: ${
						pruneResult.stderr.trim() || pruneResult.stdout.trim()
					}`,
				};
			}
			const relistResult = await runGit(
				['worktree', 'list', '--porcelain'],
				directory,
			);
			if (relistResult.exitCode !== 0) {
				const raw = relistResult.stderr.trim() || relistResult.stdout.trim();
				const bounded =
					raw.length > 500 ? `${raw.slice(0, 500)}... (truncated)` : raw;
				return {
					error: `worktree enumeration failed after prune: ${bounded}`,
				};
			}
			entries = parsePorcelain(relistResult.stdout);
		}

		// Case (b) active collision: branch is checked out in ANY registered
		// worktree, OR the expected path is itself registered (regardless of
		// on-disk presence).
		const expectedPathIsRegistered = entries.some(
			(e) => e.path === expectedPath,
		);
		const branchIsActiveAtExpectedPath = entries.some(
			(e) => e.branch === `refs/heads/${branchName}` && e.path === expectedPath,
		);
		const branchIsActiveElsewhere = entries.some(
			(e) => e.branch === `refs/heads/${branchName}` && e.path !== expectedPath,
		);

		if (
			branchIsActiveElsewhere ||
			(expectedPathIsRegistered && !branchIsActiveAtExpectedPath)
		) {
			return {
				error: `Branch already exists and worktree is active: ${branchName} (owned by another session)`,
			};
		}

		const aheadResult = await runGit(
			['rev-list', '--count', `HEAD..${branchName}`],
			directory,
		);
		if (aheadResult.exitCode !== 0) {
			return {
				error: `Failed to inspect stale worktree branch: ${aheadResult.stderr.trim() || aheadResult.stdout.trim()}`,
			};
		}
		const aheadCount = Number.parseInt(aheadResult.stdout.trim(), 10);
		if (!Number.isFinite(aheadCount) || aheadCount > 0) {
			return {
				error: `Branch already exists and has unmerged commits: ${branchName}`,
			};
		}

		if (branchIsActiveAtExpectedPath) {
			const clean = await isCleanWorktree(worktreePath);
			if (!clean) {
				return {
					error: `Branch already exists and expected worktree is dirty: ${branchName}`,
				};
			}
			const removeResult = await removeWorktree(worktreePath, directory, {
				force: true,
				worktreeDir: options.worktreeDir,
			});
			if (!('success' in removeResult)) {
				return { error: removeResult.error };
			}
		}

		const deleteResult = await runGit(['branch', '-d', branchName], directory);
		if (deleteResult.exitCode !== 0) {
			return {
				error: `Failed to delete stale worktree branch: ${deleteResult.stderr.trim() || deleteResult.stdout.trim()}`,
			};
		}
		await runGit(['worktree', 'prune'], directory);
	}

	// Create the worktree: git worktree add -b <branch> <path> HEAD
	const addResult = await runGit(
		['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'],
		directory,
	);
	if (addResult.exitCode !== 0) {
		return {
			error: `Failed to create worktree: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
		};
	}

	// Issue #2271 bug 1: `git worktree add` exiting 0 does not by itself prove
	// the lane is a registered, usable worktree — a concurrent prune, a partial
	// removal from a sibling dispatch's collision cleanup, or a half-consumed
	// `worktree remove` can leave a plain directory with no `.git` link. A coder
	// session created in such a directory writes files git can never attribute,
	// and settlement records dispatch_no_mutation even though the coder worked.
	// Probe git's own view of the lane before any session is created inside it.
	// (Deliberately a git probe, not a filesystem `.git` probe: lanes live
	// outside the project root by default, where rev-parse only succeeds inside
	// a genuinely registered worktree; and a filesystem probe breaks the
	// spawn-mocked provisioning tests whose lanes never exist on disk. A lane
	// rooted inside another repository via a custom worktree_dir would still
	// resolve — accepted residual, strictly narrower than the reported defect.)
	const revParseResult = await runGit(
		['rev-parse', '--git-dir'],
		worktreePath,
		WORKTREE_VERIFICATION_TIMEOUT_MS,
	);
	if (revParseResult.exitCode !== 0) {
		// The lane is unusable; remove the partial registration so the next
		// attempt provisions cleanly instead of colliding with this carcass.
		// removeWorktree never REJECTS — it resolves with { error } on failure
		// (Windows EBUSY/EPERM retries exhausted, non-force-refusable path) —
		// so a bare .catch() cannot observe that failure. Report the removal
		// outcome honestly instead of claiming the lane was removed.
		const removeResult = await removeWorktree(worktreePath, directory, {
			force: true,
			worktreeDir: options.worktreeDir,
		}).catch((removalError: unknown): { error: string } => ({
			error:
				removalError instanceof Error
					? removalError.message
					: String(removalError),
		}));
		const removalNote =
			'error' in removeResult
				? `The lane could NOT be removed (${removeResult.error}) — it may collide with the next provisioning attempt; clear ${worktreePath} manually if retries fail.`
				: 'The lane was removed; retry the dispatch.';
		return {
			error: `WORKTREE_VERIFICATION_FAILED: lane ${worktreePath} did not register as a usable git worktree (git rev-parse --git-dir failed in the lane: ${revParseResult.stderr.trim() || revParseResult.stdout.trim() || `exit ${revParseResult.exitCode}`}). ${removalNote}`,
		};
	}

	// Dependency preparation per depsStrategy (FR-101 / SC-101..SC-103)
	// 'skip' (default): no preparation — caller may emit advisory if task gates include test/build.
	// 'copy': recursive copy of host node_modules into lane (real files, not symlink).
	// 'link': platform-appropriate symlink/junction so lane resolves host's dependency entries at same paths.
	const strategy: DependencyPreparationStrategy =
		options.depsStrategy ?? 'skip';
	if (strategy !== 'skip') {
		const hostDepDir = path.join(directory, 'node_modules');
		const laneDepDir = path.join(worktreePath, 'node_modules');
		if (_internals.fs.existsSync(hostDepDir)) {
			try {
				if (strategy === 'copy') {
					await _internals.fs.cp(hostDepDir, laneDepDir, {
						recursive: true,
						force: true,
					});
				} else if (strategy === 'link') {
					const isWindows = _internals.platform === 'win32';
					// 'junction' on Windows for directory symlinks (no admin required for local targets);
					// 'dir' on POSIX.
					_internals.fs.symlinkSync(
						hostDepDir,
						laneDepDir,
						isWindows ? 'junction' : 'dir',
					);
				}
			} catch (e) {
				// Non-fatal: the lane may still function for tasks that do not require the deps,
				// or the subsequent commands will surface the real missing-dep error.
				log(
					`[swarm] deps_strategy '${strategy}' preparation failed for ${id}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		} else {
			// SC-103: no silent no-op for copy/link when host node_modules is absent.
			// Return error so callers can fail-fast or surface loudly instead of provisioning a lane
			// that will immediately fail on any test/build command.
			return {
				error: `WORKTREE_DEPS_STRATEGY_HOST_DIR_MISSING: deps_strategy ${strategy} requires node_modules at ${hostDepDir} but it does not exist`,
			};
		}
	}

	// FR-102 / SC-105: Materialize declared scope into the lane's .swarm/scopes/
	// so that resolveScopeWithFallbacks({ directory: worktreePath, ... }) recovers
	// the narrow scope after a plugin restart (in-memory state is lost).
	// This makes the lane self-sufficient; the scope file is written under the
	// worktree root which inherits the primary .gitignore (excludes .swarm/).
	// Write is best-effort (defense-in-depth); failure is non-fatal.
	if (options.scope?.taskId && Array.isArray(options.scope.files)) {
		try {
			await _internals.writeScopeToDisk(
				worktreePath,
				options.scope.taskId,
				options.scope.files,
			);
		} catch {
			/* non-fatal — scope persistence is defense-in-depth */
		}
	}

	// FR-201 SC-124: Materialize lane runtime profile as `.swarm/lanes/{laneIndex}.env`.
	// This file allows child processes spawned inside the lane to source lane-specific
	// env vars (PORT, TMPDIR, cache redirects, etc.) by reading this file.
	// Write is best-effort (defense-in-depth); failure is non-fatal.
	if (options.laneProfile) {
		try {
			await _internals.writeLaneProfileToDisk(
				worktreePath,
				options.laneProfile.laneIndex,
				options.laneProfile.envOverrides,
			);
		} catch {
			/* non-fatal — profile materialization is defense-in-depth */
		}
	}

	return {
		worktreePath,
		branchName,
		purpose: options.purpose,
		id,
		sessionId,
	};
}

/**
 * Removes a git worktree, **without** `--force` by default.
 *
 * On Windows (`process.platform === 'win32'`), retries up to 3 times with a
 * 2-second delay when the error contains `EBUSY` or `EPERM` (DD-10). After
 * exhausting retries the worktree is abandoned — the function returns an
 * error but does NOT throw.
 *
 * When `options.force` is set, the removal is escalated (issue #1708): if the
 * default non-forced removal gives up (either a non-retryable error such as the
 * "contains modified or untracked files, use --force" message on the first
 * attempt, or EBUSY/EPERM retries exhausted on Windows), a single
 * `git worktree remove --force` is attempted — but ONLY when `worktreePath`
 * resolves inside the swarm-managed worktree base directory
 * (`isPathUnderSwarmWorktreeBase`). A path outside that trusted base is NEVER
 * force-removed even if `force` is requested. When `force` is not set, behavior
 * is unchanged (non-force only; returns an error, does not throw, on exhaustion).
 *
 * @param worktreePath        - Absolute path to the worktree directory to remove.
 * @param projectRoot         - Absolute path to the project root (a git repository)
 *                              used as `cwd` for the `git worktree remove` command.
 *                              Required because the worktree's parent directory may
 *                              not itself be a git repository.
 * @param options             - Optional escalation controls.
 * @param options.force       - When true, opt into the forced-fallback removal
 *                              described above (scoped to the trusted base).
 * @param options.worktreeDir - The configured worktree-dir override, if any, so
 *                              the containment check trusts the same base
 *                              `provisionWorktree` used.
 * @returns `{ success: true }` on success or `{ error: string }` on failure.
 */
export async function removeWorktree(
	worktreePath: string,
	projectRoot: string,
	options?: { force?: boolean; worktreeDir?: string },
): Promise<RemoveSuccess | RemoveFailure> {
	const isWindows = _internals.platform === 'win32';
	const MAX_RETRIES = 4;
	const RETRY_DELAY_MS = 2000;

	let lastError = '';

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const result = await runGit(
			['worktree', 'remove', worktreePath],
			projectRoot,
		);

		if (result.exitCode === 0) {
			if (fs.existsSync(worktreePath)) {
				const trusted = isPathUnderSwarmWorktreeBase(
					worktreePath,
					projectRoot,
					options?.worktreeDir ? [options.worktreeDir] : [],
				);
				if (!trusted) {
					return {
						error:
							'git removed the worktree registration but the residual directory is outside the trusted swarm worktree base',
					};
				}
				try {
					fs.rmSync(worktreePath, { recursive: true, force: true });
				} catch (error) {
					return {
						error: `git removed the worktree registration but residual directory cleanup failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					};
				}
				if (fs.existsSync(worktreePath)) {
					return {
						error:
							'git removed the worktree registration but the residual directory still exists after cleanup',
					};
				}
			}
			return { success: true };
		}

		lastError = result.stderr.trim() || result.stdout.trim();

		// On Windows, retry only for EBUSY / EPERM file-lock errors
		if (
			isWindows &&
			(lastError.includes('EBUSY') || lastError.includes('EPERM')) &&
			attempt < MAX_RETRIES - 1
		) {
			await _internals.sleep(RETRY_DELAY_MS);
			continue;
		}

		// Non-retryable error or final attempt exhausted. This is the single
		// reachable give-up point (the post-loop return below is unreachable
		// because attempt 3 hits `attempt < MAX_RETRIES - 1` === false and
		// returns here). Opt-in force fallback (issue #1708): escalate to a
		// single `--force` removal, but ONLY when the target resolves inside the
		// trusted swarm worktree base. Never force-remove a path outside it.
		if (
			options?.force &&
			isPathUnderSwarmWorktreeBase(
				worktreePath,
				projectRoot,
				options.worktreeDir ? [options.worktreeDir] : [],
			)
		) {
			const forced = await runGit(
				['worktree', 'remove', '--force', worktreePath],
				projectRoot,
			);
			if (forced.exitCode === 0) {
				if (fs.existsSync(worktreePath)) {
					try {
						fs.rmSync(worktreePath, { recursive: true, force: true });
					} catch (error) {
						return {
							error: `git force-removed the worktree registration but residual directory cleanup failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						};
					}
					if (fs.existsSync(worktreePath)) {
						return {
							error:
								'git force-removed the worktree registration but the residual directory still exists after cleanup',
						};
					}
				}
				return { success: true };
			}
			// Surface the force attempt's own failure, not the stale lastError.
			return { error: forced.stderr.trim() || forced.stdout.trim() };
		}

		return { error: lastError };
	}

	return { error: lastError };
}

/**
 * Checks whether a worktree is clean — no uncommitted changes AND no
 * untracked files.
 *
 * Runs two git commands with `cwd` set to the worktree:
 * 1. `git status --porcelain` — detects staged/unstaged modifications
 * 2. `git ls-files --others --exclude-standard` — detects untracked files
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns `true` when the worktree is completely clean, `false` otherwise.
 */
export async function isCleanWorktree(worktreePath: string): Promise<boolean> {
	const [statusResult, untrackedResult] = await Promise.all([
		runGit(['status', '--porcelain'], worktreePath),
		runGit(['ls-files', '--others', '--exclude-standard'], worktreePath),
	]);

	// If either git command fails, we cannot determine cleanliness — treat as dirty
	if (statusResult.exitCode !== 0 || untrackedResult.exitCode !== 0) {
		return false;
	}

	const hasChanges = statusResult.stdout.trim().length > 0;
	const hasUntracked = untrackedResult.stdout.trim().length > 0;

	return !hasChanges && !hasUntracked;
}

/**
 * Auto-commits dirty state in a worktree before cleanup.
 *
 * Stages all files (`git add -A`) and commits with the message
 * `swarm-lane: auto-commit before cleanup`. If there is nothing to commit,
 * returns `{ committed: false, reason: 'Nothing to commit' }`.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns `{ committed: true, message }` on success or `{ committed: false, reason }`
 *          if nothing to commit or on failure.
 */
export async function autoCommitDirty(
	worktreePath: string,
): Promise<AutoCommitSuccess | AutoCommitSkip> {
	const COMMIT_MESSAGE = 'swarm-lane: auto-commit before cleanup';

	// Stage all files
	const addResult = await runGit(['add', '-A'], worktreePath);
	if (addResult.exitCode !== 0) {
		return {
			committed: false,
			reason: `git add failed: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
		};
	}

	// Attempt the commit
	const commitResult = await runGit(
		['commit', '-m', COMMIT_MESSAGE],
		worktreePath,
	);

	if (commitResult.exitCode !== 0) {
		const stderr = commitResult.stderr.trim();
		const stdout = commitResult.stdout.trim();
		if (
			stderr.includes('nothing to commit') ||
			stdout.includes('nothing to commit') ||
			stderr.includes('nothing added to commit')
		) {
			return { committed: false, reason: 'Nothing to commit' };
		}
		return {
			committed: false,
			reason: `git commit failed: ${stderr || stdout}`,
		};
	}

	return { committed: true, message: COMMIT_MESSAGE };
}

/**
 * Patterns for files/directories that are safe to remove with
 * `git clean`.  Everything else is treated as potential source code and
 * blocks the clean to prevent data loss (DD-7 safety amendment).
 *
 * Two pattern forms:
 * - **Directory patterns** (ending with `/`): match paths that start with
 *   the directory prefix or contain it as a path segment.
 * - **File suffix patterns** (not ending with `/`): match paths that end
 *   with the suffix.
 */
const SAFE_CLEAN_PATTERNS: readonly string[] = [
	'dist/',
	'build/',
	'.turbo/',
	'coverage/',
	'node_modules/.cache/',
	'.log',
	'.tmp',
	'.o',
	'.pyc',
	'.class',
];

/**
 * Determines whether a single path from `git clean -fdn` output is safe
 * to permanently delete.
 *
 * Two matching strategies based on pattern type:
 * - **Directory patterns** (ending with `/`): the candidate path must
 *   start with the pattern or contain it as a path segment.
 *   Example: `dist/bundle.js` matches `dist/` because it starts with `dist/`.
 * - **File suffix patterns** (not ending with `/`): the candidate path
 *   must end with the pattern. Example: `app.log` matches `.log`.
 */
function isSafeToClean(candidatePath: string): boolean {
	const normalized = candidatePath.replace(/\\/g, '/').toLowerCase();
	return SAFE_CLEAN_PATTERNS.some((pattern) => {
		const p = pattern.toLowerCase();
		if (p.endsWith('/')) {
			return normalized.startsWith(p) || normalized.includes(`/${p}`);
		}
		return normalized.endsWith(p);
	});
}

/**
 * Removes untracked files and directories from a worktree (DD-7 amendment).
 *
 * Before running `git clean -fd`, performs a dry-run (`git clean -fdn`) to
 * list what would be deleted.  If the list contains anything that is not
 * a known generated/temporary artifact, the clean is **skipped** to prevent
 * accidental deletion of uncommitted source files created by lane coders.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns `{ cleaned: true }` on success or `{ cleaned: false, error }`
 *          on failure or when untracked source files are detected.
 */
export async function cleanUntrackedFiles(
	worktreePath: string,
): Promise<CleanSuccess | CleanFailure> {
	// --- Dry-run safety gate ---
	const dryRun = await runGit(['clean', '-fdn'], worktreePath);

	if (dryRun.exitCode === 0) {
		const candidates = dryRun.stdout
			.trim()
			.split('\n')
			.map((line) => {
				// git clean -fdn output: "Would remove <path>"
				const match = line.match(/^Would remove (.+)$/);
				return match ? match[1].trim() : '';
			})
			.filter((p) => p.length > 0);

		const unsafePaths = candidates.filter((p) => !isSafeToClean(p));

		if (unsafePaths.length > 0) {
			advisoryWarn(
				`[swarm:cleanUntrackedFiles] Skipping clean — untracked source files detected: ${unsafePaths.join(', ')}`,
			);
			return {
				cleaned: false,
				error:
					'untracked source files detected — skipping clean to prevent data loss',
			};
		}
	}
	// If the dry-run fails we cannot verify; fail-open and proceed.

	const result = await runGit(['clean', '-fd'], worktreePath);

	if (result.exitCode !== 0) {
		return {
			cleaned: false,
			error: result.stderr.trim() || result.stdout.trim(),
		};
	}

	return { cleaned: true };
}

/**
 * Verifies that the working tree at `directory` has no uncommitted or
 * untracked changes before worktree provisioning (DD-2).
 *
 * If the working tree is dirty, returns a descriptive error message
 * instructing the user to commit or stash.
 *
 * @param directory - Project root (an absolute path to the git working tree).
 * @returns `{ clean: true }` when the working tree is clean, or
 *          `{ clean: false, error: string }` when dirty or unverifiable.
 */
export async function assertCleanWorkingTree(
	directory: string,
): Promise<CleanCheckSuccess | CleanCheckFailure> {
	const [statusResult, untrackedResult] = await Promise.all([
		runGit(['status', '--porcelain'], directory),
		runGit(['ls-files', '--others', '--exclude-standard'], directory),
	]);

	if (statusResult.exitCode !== 0) {
		return {
			clean: false,
			error: `Unable to verify working tree cleanliness: ${statusResult.stderr.trim() || statusResult.stdout.trim()}`,
		};
	}

	if (untrackedResult.exitCode !== 0) {
		return {
			clean: false,
			error: `Unable to verify working tree cleanliness: ${untrackedResult.stderr.trim() || untrackedResult.stdout.trim()}`,
		};
	}

	const hasChanges = statusResult.stdout.trim().length > 0;
	const hasUntracked = untrackedResult.stdout.trim().length > 0;

	if (hasChanges || hasUntracked) {
		return {
			clean: false,
			error:
				"Working tree has uncommitted changes. Please commit or stash before provisioning worktrees. Run 'git status' for details.",
		};
	}

	return { clean: true };
}
