import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn } from './bun-compat';

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.bunSpawn(...)` so tests can replace the function on this object
 * without touching the real `./bun-compat` module — `mock.module` from
 * `bun:test` leaks across files in Bun's shared test-runner process, which
 * would corrupt unrelated suites that import `bun-compat`. Mutating this
 * local object is file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: { bunSpawn: typeof bunSpawn } = { bunSpawn };

/**
 * Module-level flag so the warning fires at most once per process.
 * Exported for test reset purposes only — do not use in production code.
 */
export let _gitignoreWarningEmitted = false;

/**
 * Reset the deduplication flag. Exposed for test isolation only.
 */
export function resetGitignoreWarningState(): void {
	_gitignoreWarningEmitted = false;
}

/**
 * Module-level flag for ensureSwarmGitExcluded deduplication.
 * Exported for test reset purposes only.
 */
export let _swarmGitExcludedChecked = false;

/**
 * Reset the ensureSwarmGitExcluded deduplication flag. Exposed for test isolation only.
 */
export function resetSwarmGitExcludedState(): void {
	_swarmGitExcludedChecked = false;
}

/**
 * Walk up from `startDir` until a directory containing `.git/` is found.
 * Returns the git root path, or null if none is found before reaching the
 * filesystem root.
 *
 * NOTE: This function only recognises `.git` as a directory. It does NOT
 * handle Git worktrees or submodules where `.git` is a file. Use
 * `ensureSwarmGitExcluded` (which uses `git rev-parse`) for worktree safety.
 */
function findGitRoot(startDir: string): string | null {
	let current = startDir;
	while (true) {
		try {
			const gitPath = path.join(current, '.git');
			const stat = fs.statSync(gitPath);
			if (stat.isDirectory()) {
				return current;
			}
		} catch {
			// .git doesn't exist here — keep walking up
		}

		const parent = path.dirname(current);
		if (parent === current) {
			// Reached filesystem root
			return null;
		}
		current = parent;
	}
}

/**
 * Return true if any line in the file content is `.swarm` or `.swarm/`
 * (exact match, ignoring leading/trailing whitespace, ignoring comment lines).
 */
function fileCoversSwarm(content: string): boolean {
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (line.startsWith('#') || line.length === 0) continue;
		if (line === '.swarm' || line === '.swarm/') return true;
	}
	return false;
}

/**
 * Reads a file safely, returning its content or null on any error.
 */
function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Checks whether `.swarm/` is covered by `.gitignore` or `.git/info/exclude`
 * in the git repo rooted at or above `directory`. If not covered, emits a
 * single `console.warn` (unless `quiet` is true). Fires at most once per process.
 *
 * Never throws — any file-system error silently skips the check.
 *
 * @deprecated Use `ensureSwarmGitExcluded` instead. This function only recognises
 * `.git` as a directory and does NOT handle Git worktrees or submodules.
 */
export function warnIfSwarmNotGitignored(
	directory: string,
	quiet = false,
): void {
	if (_gitignoreWarningEmitted) return;

	try {
		const gitRoot = findGitRoot(directory);
		if (!gitRoot) return; // Not a git repo — skip

		const gitignoreContent = readFileSafe(path.join(gitRoot, '.gitignore'));
		if (gitignoreContent !== null && fileCoversSwarm(gitignoreContent)) {
			_gitignoreWarningEmitted = true;
			return;
		}

		const excludeContent = readFileSafe(
			path.join(gitRoot, '.git', 'info', 'exclude'),
		);
		if (excludeContent !== null && fileCoversSwarm(excludeContent)) {
			_gitignoreWarningEmitted = true;
			return;
		}

		// Not covered by either source — emit warning (suppressed when quiet:true)
		_gitignoreWarningEmitted = true;
		if (!quiet) {
			console.warn(
				'[opencode-swarm] WARNING: .swarm/ is not in your .gitignore. Shell audit logs may contain API keys. Add ".swarm/" to your .gitignore to prevent accidental commits.',
			);
		}
	} catch {
		// Silently swallow any unexpected error — never block plugin init
	}
}

export interface EnsureSwarmGitExcludedOptions {
	quiet?: boolean;
}

/**
 * Hard upper bound on the entire `ensureSwarmGitExcluded` operation when
 * called from plugin init. The plugin host (OpenCode TUI / Desktop) will
 * silently drop a plugin whose entry never resolves (issue #704); every
 * awaited call on the init path therefore has an obligation to be bounded.
 *
 * 3_000 ms is ~30× the realistic worst-case duration on a healthy host (all
 * four `git` calls land in well under 200 ms in aggregate) and ~6× the
 * per-call budget below. Slower-than-3 s hosts are pathological (NFS-stalled
 * `.git`, antivirus quarantine) and we deliberately fail-open: a debug log
 * is emitted and the plugin continues to load without the hygiene exclude.
 */
export const ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS = 3_000;

/**
 * Hard upper bound on each individual `git` subprocess invoked by
 * `ensureSwarmGitExcluded` (and reused by `validateDiffScope`). Both Bun's
 * `Bun.spawn` and the Node fallback in `bunSpawn` honor this `timeout`
 * option and kill the child on expiry (`bun-compat.ts` Node fallback calls
 * `proc.kill('SIGKILL')`; Bun kills via `killSignal`).
 *
 * 1_500 ms gives a ~30× margin over the realistic worst case and is well
 * below the outer wrapper budget so the inner kills fire first on a
 * pathological host.
 */
export const ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS = 1_500;

/**
 * Spawn options reused by every `git` subprocess in `ensureSwarmGitExcluded`
 * and `validateDiffScope`. Notes:
 *
 * - `timeout` bounds each child individually. Honored by both runtimes.
 * - `stdin: 'ignore'` removes any stdin pipe. None of the git commands in
 *   scope (`rev-parse`, `check-ignore`, `ls-files`, `diff --name-only`)
 *   read stdin, and a never-closed stdin pipe under Bun on Windows can
 *   block the child from exiting (it waits for stdin EOF that never
 *   arrives). Forcing `'ignore'` removes that failure mode.
 * - `stdout: 'pipe'` / `stderr: 'pipe'` are required so the wrapper can
 *   capture output (existing behavior).
 */
const GIT_SPAWN_OPTIONS = {
	timeout: ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS,
	stdin: 'ignore',
	stdout: 'pipe',
	stderr: 'pipe',
} as const;

/**
 * Automatically protect `.swarm/` from Git pollution before any `.swarm/` write.
 *
 * Uses git CLI (not filesystem walks) so it correctly handles Git worktrees
 * and submodules where `.git` is a file rather than a directory.
 *
 * Steps:
 * 1. Resolve git root via `git rev-parse --show-toplevel`
 * 2. Resolve local exclude path via `git rev-parse --git-path info/exclude`
 * 3. Check if `.swarm/` is already ignored via `git check-ignore -q`
 * 4. If not ignored: append `.swarm/` to the local exclude file (idempotent)
 * 5. Detect tracked `.swarm/` files via `git ls-files -- .swarm`
 * 6. If tracked: emit an unsuppressed remediation warning
 *
 * Never throws. Fires at most once per process.
 *
 * quiet option: only suppresses cosmetic logs. The exclude write and tracked-file
 * warning are never suppressed regardless of quiet mode.
 */
export async function ensureSwarmGitExcluded(
	directory: string,
	options: EnsureSwarmGitExcludedOptions = {},
): Promise<void> {
	if (_swarmGitExcludedChecked) return;
	_swarmGitExcludedChecked = true;

	const { quiet = false } = options;

	try {
		// Steps 1, 2, and 3 are independent — run them in parallel to reduce
		// startup latency. Each adds ~10-50 ms; parallelizing saves up to 100 ms
		// on cold cache.
		const [
			[gitRootExitCode, gitRootOutput],
			[excludePathExitCode, excludePathRaw],
			checkIgnoreExitCode,
		] = await Promise.all([
			// Step 1: Get git root using CLI (handles worktrees/submodules)
			(async (): Promise<[number, string]> => {
				const proc = _internals.bunSpawn(
					['git', '-C', directory, 'rev-parse', '--show-toplevel'],
					GIT_SPAWN_OPTIONS,
				);
				try {
					return (await Promise.all([proc.exited, proc.stdout.text()])) as [
						number,
						string,
					];
				} finally {
					try {
						proc.kill();
					} catch {
						// Already exited — kill is a no-op.
					}
				}
			})(),
			// Step 2: Get the correct exclude path (resolves through worktree .git files)
			(async (): Promise<[number, string]> => {
				const proc = _internals.bunSpawn(
					['git', '-C', directory, 'rev-parse', '--git-path', 'info/exclude'],
					GIT_SPAWN_OPTIONS,
				);
				try {
					return (await Promise.all([proc.exited, proc.stdout.text()])) as [
						number,
						string,
					];
				} finally {
					try {
						proc.kill();
					} catch {
						// Already exited — kill is a no-op.
					}
				}
			})(),
			// Step 3: Check if .swarm/ is already ignored by any source
			// (covers .gitignore, global gitignore, and info/exclude)
			(async (): Promise<number> => {
				const proc = _internals.bunSpawn(
					['git', '-C', directory, 'check-ignore', '-q', '.swarm/.gitkeep'],
					GIT_SPAWN_OPTIONS,
				);
				try {
					return await proc.exited;
				} finally {
					try {
						proc.kill();
					} catch {
						// Already exited — kill is a no-op.
					}
				}
			})(),
		]);

		if (gitRootExitCode !== 0) return; // Not a git repo

		const gitRoot = gitRootOutput.trim();
		if (!gitRoot) return;

		if (excludePathExitCode !== 0) return;

		const excludeRelPath = excludePathRaw.trim();
		if (!excludeRelPath) return;

		// Resolve to absolute — `git -C <directory> rev-parse --git-path` returns a path
		// relative to the -C argument (directory), not relative to the git root.
		// From a subdirectory it may be "../../.git/info/exclude"; from the root ".git/info/exclude".
		// Worktrees return an absolute path. path.join() normalizes ".." components in all cases.
		const excludePath = path.isAbsolute(excludeRelPath)
			? excludeRelPath
			: path.join(directory, excludeRelPath);

		if (checkIgnoreExitCode !== 0) {
			// .swarm/ is NOT ignored — write to local exclude file
			try {
				fs.mkdirSync(path.dirname(excludePath), { recursive: true });

				let existing = '';
				try {
					existing = fs.readFileSync(excludePath, 'utf8');
				} catch {
					// File doesn't exist yet — fine
				}

				// Only append if not already covered (handles concurrent-start duplicates
				// being harmless — git treats duplicate patterns identically)
				if (!fileCoversSwarm(existing)) {
					fs.appendFileSync(
						excludePath,
						'\n# opencode-swarm local runtime state\n.swarm/\n',
						'utf8',
					);
					if (!quiet) {
						console.warn(
							'[opencode-swarm] Added .swarm/ to .git/info/exclude to prevent runtime state from appearing in git status.',
						);
					}
				}
			} catch {
				// Failed to write exclude — non-fatal (read-only repo, permissions, etc.)
			}
		}

		// Step 4: Detect already-tracked .swarm/ files
		// NOTE: ignore rules have no effect on tracked files; git rm --cached is required.
		const trackedProc = _internals.bunSpawn(
			['git', '-C', directory, 'ls-files', '--', '.swarm'],
			GIT_SPAWN_OPTIONS,
		);
		let trackedExitCode: number;
		let trackedOutput: string;
		try {
			[trackedExitCode, trackedOutput] = await Promise.all([
				trackedProc.exited,
				trackedProc.stdout.text(),
			]);
		} finally {
			try {
				trackedProc.kill();
			} catch {
				// Already exited — kill is a no-op.
			}
		}

		if (trackedExitCode === 0 && trackedOutput.trim().length > 0) {
			// INTENTIONALLY NOT gated behind quiet — hygiene warning must always be visible
			console.warn(
				'[opencode-swarm] WARNING: .swarm/ files are tracked by Git.\n' +
					'.swarm/ contains local runtime state and may contain sensitive session data.\n' +
					'Ignoring will not affect already-tracked files. To stop tracking them, run:\n' +
					'  git rm -r --cached .swarm\n' +
					'  echo ".swarm/" >> .gitignore\n' +
					'  git commit -m "Stop tracking opencode-swarm runtime state"',
			);
		}
	} catch {
		// Never block plugin init
	}
}
