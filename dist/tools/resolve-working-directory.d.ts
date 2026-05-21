/**
 * Shared utility for resolving working_directory across swarm tools.
 *
 * Tools that read .swarm/ state (plan.json, evidence/) must resolve paths
 * relative to the actual project root, not process.cwd(). When the MCP host's
 * CWD differs from the project root (e.g. CWD=RAGAPPv2, project=RAGAPPv3),
 * tools that lack a working_directory parameter silently read stale data from
 * the wrong directory.
 *
 * This helper provides consistent validation and resolution, matching the
 * pattern already used by save_plan and update_task_status.
 */
export interface ResolveResult {
    success: true;
    directory: string;
}
export interface ResolveError {
    success: false;
    message: string;
}
/**
 * Resolves and validates a working directory against a fallback (injected project root).
 *
 * NOTE: This function intentionally does NOT use realpathSync for the resolved path
 * to avoid Windows 8.3 short filename issues. Symlink-based subdirectory bypasses
 * through this coarse filter are caught by the write-time validateProjectRoot guard
 * in evidence/manager.ts, which DOES use realpathSync. These two functions form a
 * defense-in-depth pair: resolveWorkingDirectory is the fast entry filter,
 * validateProjectRoot is the authoritative canonical check at write time.
 *
 * Priority: explicit working_directory param > injected directory (from createSwarmTool).
 *
 * When working_directory is provided, it is validated for:
 * - Null-byte injection
 * - Path traversal sequences (..)
 * - Windows device paths
 * - Existence on disk
 *
 * @param workingDirectory - Explicit working_directory from tool args (caller-controlled)
 * @param fallbackDirectory - Injected directory from createSwarmTool (ctx.directory ?? process.cwd())
 */
export declare function resolveWorkingDirectory(workingDirectory: string | undefined | null, fallbackDirectory: string): ResolveResult | ResolveError;
