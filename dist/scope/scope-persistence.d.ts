/**
 * Scope persistence for #519 (v6.71.1 hotfix).
 *
 * Persists declared coder scope to `.swarm/scopes/scope-{taskId}.json` so that
 * scope survives cross-process delegation — in-memory `session.declaredCoderScope`
 * is lost when a coder session starts in a separate process (#496 root cause B).
 *
 * Also exposes a fallback reader that reads `plan.json:phases[].tasks[].files_touched`
 * for the active task, so architect-authored plans become a durable scope source
 * even when `declare_scope` was never called (#496 root cause C mitigation).
 *
 * Read/write contract:
 *   - Atomic write via temp + rename (POSIX atomic on same filesystem).
 *   - File lock via proper-lockfile while writing.
 *   - Schema versioning: readers fail closed on unknown version.
 *   - TTL: default 24h from declaredAt; expired scopes return null.
 *   - Symlink guards (defence in depth):
 *       * realpath containment check on `.swarm/scopes/` (closes parent-dir attack)
 *       * O_NOFOLLOW on both write-create and read-fd (closes leaf-file TOCTOU)
 *       * taskId-in-file must match the filename (closes cross-pollination)
 *       * declaredAt must be <= now (closes future-timestamp attack)
 *       * files array capped at MAX_FILES_PER_SCOPE (DoS cap)
 *       * plan.json size capped at MAX_PLAN_BYTES (DoS cap)
 *       * Windows reserved device names rejected (CON, NUL, LPT1, …)
 *
 * RESIDUAL RISKS — explicitly accepted (#520 tracks full syscall-layer remediation):
 *   1. Bash / interpreter writes bypass the tool-layer authority check. This
 *      module does not protect against a coder process running `sed -i`,
 *      `echo >`, `python -c`, etc. Mitigation is prompt-only (see coder.ts
 *      WRITE BLOCKED PROTOCOL) until #520 lands.
 *   2. Platform-portability of symlink guards:
 *        - realpath resolves POSIX symlinks and Windows junctions, but the
 *          Windows behaviour is not covered by CI (Linux-only test matrix).
 *        - O_NOFOLLOW is a no-op on Windows (falls back to 0). The realpath
 *          containment check on `.swarm/scopes/` remains the primary guard
 *          on that platform; leaf-file TOCTOU on Windows is not closed.
 *   3. Stale lockfile DoS: a crashed writer leaves a lock for up to
 *      LOCK_STALE_MS (30s). During that window, concurrent `declare_scope`
 *      calls fail silently and the architect relies on in-memory state.
 *      Acceptable because in-memory state remains authoritative inside the
 *      live process; disk is a fallback.
 *   4. Temp-file leak: a crash between `Bun.write(tmp)` and `renameSync`
 *      leaves `scope-{id}.json.tmp.{ts}.{rand}` files. No sweeper runs today;
 *      accumulation is bounded by `/swarm close` (which rm -rf's .swarm/scopes/).
 *
 * NOT a standalone security boundary. Tool-layer write interception is now
 * implemented in shell-write-detect.ts (Phases 1-2). This module closes the
 * cross-process gap and the plan-as-scope gap. The syscall-layer fix (#520)
 * remains the durable long-term boundary.
 */
declare const SCOPE_SCHEMA_VERSION: 1;
export interface PersistedScope {
    version: typeof SCOPE_SCHEMA_VERSION;
    taskId: string;
    declaredAt: number;
    expiresAt: number;
    files: string[];
}
/**
 * Write declared scope to `.swarm/scopes/scope-{taskId}.json` atomically.
 * Safe to call concurrently — proper-lockfile serialises writers per-file.
 *
 * Silent on I/O failure: scope persistence is a defense-in-depth layer, not a
 * hard requirement. In-memory state remains authoritative for the live process.
 */
export declare function writeScopeToDisk(directory: string, taskId: string, files: string[], ttlMs?: number): Promise<void>;
/**
 * Read persisted scope for a task. Returns null on:
 *   - file missing
 *   - file is a symlink (lstat guard — prevents hostile repo pre-seeding)
 *   - unknown schema version (fail-closed)
 *   - expired TTL
 *   - malformed JSON
 *   - invalid taskId
 */
export declare function readScopeFromDisk(directory: string, taskId: string): string[] | null;
/**
 * Read declared scope for a task from `.swarm/plan.json:phases[].tasks[].files_touched`.
 * Mirrors the logic in src/hooks/diff-scope.ts:15-47 but kept independent so a
 * future diff-scope refactor doesn't ripple into authority-layer reads.
 *
 * Returns null on missing plan, task not found, no files_touched, or parse error.
 */
export declare function readPlanScope(directory: string, taskId: string): string[] | null;
/**
 * Remove scope file for a single task. Called when a task transitions to
 * completed/closed so stale scope doesn't leak into later tasks with the same id.
 */
export declare function clearScopeForTask(directory: string, taskId: string): void;
/**
 * Remove the entire `.swarm/scopes/` directory. Called by /swarm close so the
 * next session starts without inherited scope.
 */
export declare function clearAllScopes(directory: string): void;
/**
 * Resolve scope for a task with the full fallback chain:
 *   1. in-memory session.declaredCoderScope (fast path; live process)
 *   2. `.swarm/scopes/scope-{taskId}.json` (cross-process durable)
 *   3. `.swarm/plan.json:phases[].tasks[].files_touched` (architect-authored)
 *   4. caller-supplied pending-map fallback (delegation-gate module map)
 *
 * Any null/empty result falls through to the next layer. First non-empty wins.
 */
export declare function resolveScopeWithFallbacks(input: {
    directory: string;
    taskId: string | null | undefined;
    inMemoryScope: string[] | null | undefined;
    pendingMapScope: string[] | null | undefined;
}): string[] | null;
export {};
