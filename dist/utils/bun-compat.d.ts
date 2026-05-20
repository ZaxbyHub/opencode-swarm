/**
 * Runtime-portability shim for the small set of `Bun.*` APIs we depend on.
 *
 * Why this exists: the plugin entry (`src/index.ts`) is bundled with
 * `--target node`, but the source tree calls `Bun.file`, `Bun.write`,
 * `Bun.spawn`, `Bun.spawnSync`, and `Bun.hash` directly. OpenCode's plugin
 * host explicitly supports running plugins under Node (its own `PluginInput`
 * uses `$: typeof Bun === "undefined" ? undefined : Bun.$`). On the OpenCode
 * Desktop sidecar, plugins may execute under Node — every direct `Bun.*`
 * reference would throw `ReferenceError: Bun is not defined`.
 *
 * This module funnels all such calls through a small set of helpers that
 * detect the runtime once and dispatch to either the Bun primitive or a
 * Node fallback. The fallbacks are deliberately small — they implement
 * exactly the surface our callers use, no more.
 *
 * Cross-platform notes:
 *   - `bunWrite` performs an atomic write via temp+rename on the Node path,
 *     mirroring Bun's atomic semantics. Includes a Windows EEXIST retry loop
 *     because rename can race with file-handle release on Windows.
 *   - `bunSpawn` and `bunSpawnSync` use `node:child_process` and translate
 *     Bun's option shape into Node's. Stdout/stderr capture is wired so
 *     callers see the same `text()`/`stdout` shape regardless of runtime.
 *   - `bunHash` uses Node's `xxhash` via `Bun.hash`'s default algorithm when
 *     present and falls back to a stable djb2-derived 32-bit hash on Node.
 */
/**
 * Whether the current runtime is Bun. Cached at first call — every subsequent
 * call is a single property access.
 */
export declare function isBun(): boolean;
/**
 * Bun.file / fs read shim. Returns an object exposing the subset of
 * `BunFile` methods used in this codebase: `text()`, `arrayBuffer()`,
 * `exists()`, and `size`.
 *
 * On Bun, this is a thin wrapper around `Bun.file()` so callers see
 * identical semantics. On Node, the methods read the file lazily.
 */
export interface BunCompatFile {
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    exists(): Promise<boolean>;
    readonly size: number;
}
export declare function bunFile(filePath: string): BunCompatFile;
/**
 * Atomic file write. On Bun this delegates to `Bun.write`. On Node we write
 * to a temp file in the same directory and rename atomically — the same
 * semantics every existing call site already expects via Bun.write.
 */
export declare function bunWrite(filePath: string, data: string | Uint8Array | ArrayBuffer | ArrayBufferView): Promise<number>;
/**
 * Stable 32-bit hash. Bun's `Bun.hash` uses xxHash64 by default; on Node we
 * fall back to a 32-bit djb2 hash — identical hashes are NOT guaranteed
 * across runtimes, so callers should not rely on cross-runtime hash equality
 * (no current caller does — every `Bun.hash` use is in-process state keying
 * or a same-runtime cache key).
 */
export declare function bunHash(input: string | ArrayBufferView | ArrayBuffer): bigint;
/**
 * Process spawn. Bun's `Bun.spawn` returns an object with `exited`, `stdout`,
 * `stderr` etc. We expose a minimal compatible surface that callers actually
 * use: `exited`, `exitCode`, and `stdout`/`stderr` as `ReadableStream`-like
 * objects with `text()` and `bytes()` methods.
 */
export interface BunCompatSpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: 'inherit' | 'ignore' | 'pipe';
    stdout?: 'inherit' | 'ignore' | 'pipe';
    stderr?: 'inherit' | 'ignore' | 'pipe';
    timeout?: number;
}
export interface BunCompatStream {
    text(): Promise<string>;
    bytes(): Promise<Uint8Array>;
    /**
     * Returns a Web ReadableStream reader for incremental, bounded
     * consumption — matches the Bun runtime's `proc.stdout.getReader()`
     * shape, used by the test-runner's `readBoundedStream` to cap memory
     * for multi-GB test output.
     */
    getReader(): ReadableStreamDefaultReader<Uint8Array>;
}
export interface BunCompatSubprocess {
    readonly stdout: BunCompatStream;
    readonly stderr: BunCompatStream;
    readonly exited: Promise<number>;
    exitCode: number | null;
    kill(signal?: NodeJS.Signals | number): void;
}
export declare function bunSpawn(cmd: string[], options?: BunCompatSpawnOptions): BunCompatSubprocess;
export interface BunCompatSyncResult {
    stdout: Uint8Array;
    stderr: Uint8Array;
    exitCode: number;
    success: boolean;
}
export declare function bunSpawnSync(cmd: string[] | {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: string | Uint8Array;
    timeout?: number;
}, options?: BunCompatSpawnOptions): BunCompatSyncResult;
