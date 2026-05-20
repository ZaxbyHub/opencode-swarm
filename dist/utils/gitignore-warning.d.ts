import { bunSpawn } from './bun-compat';
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.bunSpawn(...)` so tests can replace the function on this object
 * without touching the real `./bun-compat` module — `mock.module` from
 * `bun:test` leaks across files in Bun's shared test-runner process, which
 * would corrupt unrelated suites that import `bun-compat`. Mutating this
 * local object is file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    bunSpawn: typeof bunSpawn;
};
/**
 * Module-level flag so the warning fires at most once per process.
 * Exported for test reset purposes only — do not use in production code.
 */
export declare let _gitignoreWarningEmitted: boolean;
/**
 * Reset the deduplication flag. Exposed for test isolation only.
 */
export declare function resetGitignoreWarningState(): void;
/**
 * Module-level flag for ensureSwarmGitExcluded deduplication.
 * Exported for test reset purposes only.
 */
export declare let _swarmGitExcludedChecked: boolean;
/**
 * Reset the ensureSwarmGitExcluded deduplication flag. Exposed for test isolation only.
 */
export declare function resetSwarmGitExcludedState(): void;
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
export declare function warnIfSwarmNotGitignored(directory: string, quiet?: boolean): void;
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
export declare const ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS = 3000;
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
export declare const ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS = 1500;
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
export declare function ensureSwarmGitExcluded(directory: string, options?: EnsureSwarmGitExcludedOptions): Promise<void>;
