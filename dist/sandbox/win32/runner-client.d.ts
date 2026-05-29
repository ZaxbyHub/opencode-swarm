/**
 * TypeScript client for the swarm-sandbox-runner native Windows sandbox.
 *
 * Spawns the Rust binary as a bounded subprocess to execute commands under
 * real OS-level isolation (AppContainer or restricted token). Communicates
 * via JSON policy on stdin and NDJSON events on stderr.
 *
 * Invariant 1 compliance: probe() is bounded to 2s timeout and fails open.
 * Invariant 3 compliance: all spawns use explicit cwd, stdin, timeout, and
 * kill() in finally blocks.
 */
import { spawn, spawnSync } from 'node:child_process';
/** Result of probing the runner binary for capabilities. */
export interface RunnerProbeResult {
    available: boolean;
    mode: 'app-container' | 'restricted-token' | 'none';
    capabilities: {
        app_container_available: boolean;
        lpac_available: boolean;
        restricted_token_available: boolean;
        private_desktop_creatable: boolean;
        integrity_level: string;
        is_admin: boolean;
        os_version: string;
        arch: string;
    } | null;
    error?: string;
}
/** NDJSON event emitted by the runner on stderr. */
export interface RunnerEvent {
    type: 'start' | 'denial' | 'quota_exceeded' | 'exit';
    run_id?: string;
    mode?: string;
    pid?: number;
    reason?: string;
    path?: string;
    kind?: string;
    used_bytes?: number;
    cap_bytes?: number;
    elapsed_ms?: number;
    cap_ms?: number;
    exit_code?: number;
    signal?: string | null;
    ts?: string;
}
/** Result of executing a command in the sandbox. */
export interface RunnerExecuteResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    events: RunnerEvent[];
    mode: string;
}
/** Exit codes from the runner binary (stable, do not renumber). */
export declare const RUNNER_EXIT_CODES: {
    readonly SUCCESS: 0;
    readonly CHILD_NON_ZERO: 1;
    readonly POLICY_VIOLATION: 64;
    readonly QUOTA_EXCEEDED: 65;
    readonly WALL_CLOCK_TIMEOUT: 66;
    readonly LAUNCHER_MISCONFIG: 67;
    readonly OS_API_FAILURE: 68;
    readonly PROBE_FAILED: 69;
};
/** Sandbox policy passed to the runner via stdin. */
export interface SandboxPolicy {
    schema_version: 1;
    run_id: string;
    workspace_roots: string[];
    writable_roots: string[];
    read_only_subpaths: string[];
    temp_root: string;
    temp_cap_bytes: number;
    memory_cap_bytes: number;
    child_process_cap: number;
    wall_clock_timeout_ms: number;
    network_mode: 'off' | 'on';
    env_allowlist: string[];
    env_overrides: Record<string, string>;
    path_stubs: string[];
    private_desktop: boolean;
    deny_alternate_data_streams: boolean;
    deny_unc_paths: boolean;
    deny_device_paths: boolean;
    deny_symlink_egress: boolean;
}
/**
 * DI seam for testability. Exposes internal functions so tests can simulate
 * runner binary behavior without requiring the actual binary.
 */
export declare const _internals: {
    findRunnerBinary: () => string | null;
    spawnRunner: typeof spawnSync;
    spawnAsync: typeof spawn;
};
/**
 * Probe the runner binary for capabilities.
 *
 * Bounded to 2s timeout per Invariant 1 (fast, bounded, fail-open).
 * Results are cached for the session lifetime.
 */
export declare function probe(): RunnerProbeResult;
/**
 * Execute a command inside the native sandbox.
 *
 * @param command - The command and arguments to run
 * @param policy  - Sandbox policy configuration
 * @param mode    - Sandbox mode (auto, app-container, restricted-token)
 * @returns Execution result with exit code, output, and events
 */
export declare function execute(command: string[], policy: SandboxPolicy, mode?: 'auto' | 'app-container' | 'restricted-token'): Promise<RunnerExecuteResult>;
/**
 * Reset the cached probe result — useful for testing.
 * @internal
 */
export declare function _resetProbeCache(): void;
/**
 * Build a default sandbox policy for a given workspace.
 */
export declare function buildDefaultPolicy(workspaceRoot: string, runId?: string): SandboxPolicy;
