/**
 * Diff scope validator — compares files changed in git against the declared scope
 * for a given task in plan.json. Returns a warning string if undeclared files
 * were modified, or null if in-scope, no scope declared, or git unavailable.
 * Never throws.
 */
import { bunSpawn } from '../utils/bun-compat';
/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    bunSpawn: typeof bunSpawn;
};
/**
 * Validate that git-changed files match the declared scope for a task.
 * Returns a warning string if undeclared files were modified, null otherwise.
 * Never throws.
 */
export declare function validateDiffScope(taskId: string, directory: string): Promise<string | null>;
