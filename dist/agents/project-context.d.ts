/**
 * Build a `ProjectContext` for agent prompt template substitution.
 *
 * Called from `src/index.ts:initializeOpenCodeSwarm` immediately before
 * `getAgentConfigs(...)` (Phase 4b of the language-agnostic plugin work).
 * Wrapped in `withTimeout(2000ms)` by the caller; on timeout or any
 * failure, the caller falls open to `emptyProjectContext()` per
 * Invariant 1 (plugin init bounded + fail-open).
 *
 * Imported lazily by the caller via `await import('./agents/project-context')`
 * to keep the dispatch import graph off the synchronous init prelude.
 *
 * Invariant 1 budget — Phase 4b NOTE:
 * This module DOES NOT spawn subprocesses on the session-init critical
 * path. The full `LanguageBackend.selectTestFramework` /
 * `selectBuildCommand` hooks call `isCommandAvailable` (which spawns
 * `where`/`which` and can take 200–500ms per call on Windows). Even with
 * the 2000ms `withTimeout` wrapper, multiple sequential spawns
 * (typically 3–5 per buildProjectContext call) easily push `server()`
 * past the 400ms Invariant 1 deadline asserted by
 * `scripts/repro-704.mjs:TIMING_DEADLINE_MS`.
 *
 * The architect prompt's `TEST_CMD` / `BUILD_CMD` / `LINT_CMD` values are
 * HINTS for the LLM. If the user doesn't have the named binary installed,
 * the actual test-runner / build-runner tool will surface a clear error
 * at invocation time — there is no correctness regression from skipping
 * the PATH probe at session init.
 */
import { pickBackend, pickedProfiles } from '../lang/dispatch';
import { type ProjectContext } from './template';
/**
 * Wall-clock budget for the session-init language-backend resolution step.
 * Caller (`src/index.ts:initializeOpenCodeSwarm`) wraps `buildProjectContext`
 * in `withTimeout(LANG_BACKEND_DETECTION_TIMEOUT_MS)`. Exceeding the budget
 * fails open with `null` so the manifest still returns to the OpenCode
 * plugin host (Invariant 1).
 */
export declare const LANG_BACKEND_DETECTION_TIMEOUT_MS = 300;
declare const _internals: {
    pickBackend: typeof pickBackend;
    pickedProfiles: typeof pickedProfiles;
};
export { _internals };
/**
 * Resolve the `ProjectContext` for `directory`. Uses `pickBackend` to find
 * the dominant language, then queries the backend's PROFILE DATA (not its
 * spawn-bearing hooks) for build/test/lint commands. Calls the optional
 * `selectFramework` and `selectEntryPoints` hooks because those are
 * filesystem-only (no spawn) per the backend purity invariant.
 *
 * Per-backend constraint blocks (coder/test/reviewer) come from
 * `backend.prompts` — pure data.
 *
 * Returns `null` (caller substitutes `emptyProjectContext()`) when no
 * backend is detected — the architect's existing DISCOVER mode handles
 * the resulting `unresolved` sentinel placeholders.
 */
export declare function buildProjectContext(directory: string): Promise<ProjectContext | null>;
