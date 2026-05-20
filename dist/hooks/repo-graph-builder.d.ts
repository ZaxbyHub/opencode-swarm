/**
 * Repo Graph Builder Hook
 *
 * Startup hook that builds or refreshes the repo dependency graph when a session starts.
 * Write-trigger hook that incrementally updates the graph when write tools are called.
 * Wrapped in try/catch — failures are logged but never block plugin initialization.
 *
 * Issue #704: the previous implementation called the synchronous
 * `buildWorkspaceGraph` from inside an `async init()`. JS executes async
 * function bodies synchronously up to the first `await`, so calling
 * `init()` blocked the entire event loop on the recursive workspace scan,
 * preventing the plugin host's `await server(...)` from ever resolving and
 * hanging the OpenCode Desktop loading screen indefinitely. The fix wires
 * the async builder, yields to the event loop before doing any work, and
 * exposes the init promise so `toolAfter` can serialize incremental
 * updates after the initial scan completes.
 */
import { type RepoGraph } from '../tools/repo-graph';
export interface RepoGraphBuilderHook {
    init(): Promise<void>;
    toolAfter(input: {
        tool: string;
        sessionID: string;
        args?: unknown;
    }, output: {
        output?: unknown;
        args?: unknown;
    }): Promise<void>;
}
export interface RepoGraphDeps {
    buildWorkspaceGraph: (workspace: string, options?: {
        maxFileSizeBytes?: number;
        maxFiles?: number;
        walkBudgetMs?: number;
        followSymlinks?: boolean;
    }) => Promise<RepoGraph>;
    saveGraph: (workspace: string, graph: RepoGraph, options?: {
        createAtomic?: boolean;
    }) => Promise<void>;
    updateGraphForFiles: (workspace: string, files: string[], options?: {
        forceRebuild?: boolean;
    }) => Promise<RepoGraph>;
}
export declare function createRepoGraphBuilderHook(workspaceRoot: string, deps?: Partial<RepoGraphDeps>): RepoGraphBuilderHook;
