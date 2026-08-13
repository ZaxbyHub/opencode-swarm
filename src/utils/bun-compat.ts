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

import {
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
} from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

const WINDOWS_RENAME_MAX_RETRIES = 3;
const WINDOWS_RENAME_RETRY_DELAY_MS = 50;

// Counter used by `bunWrite` to disambiguate temp file names when two
// concurrent calls arrive in the same millisecond.
let tempCounter = 0;

/**
 * Returns a reference to the global `Bun` object when running under Bun,
 * `undefined` otherwise.
 */
function getBun(): typeof globalThis extends { Bun: infer B } ? B : undefined {
	const g = globalThis as { Bun?: unknown };
	// biome-ignore lint/suspicious/noExplicitAny: runtime detection must be permissive
	return g.Bun as any;
}

/**
 * Whether the current runtime is Bun. Cached at first call — every subsequent
 * call is a single property access.
 */
export function isBun(): boolean {
	return getBun() !== undefined;
}

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

export function bunFile(filePath: string): BunCompatFile {
	const bun = getBun() as { file?: (p: string) => BunCompatFile } | undefined;
	if (bun?.file) {
		return bun.file(filePath);
	}
	// Node fallback. `size` is computed lazily on first access — Bun.file's
	// `size` is also effectively a stat under the hood, so this matches.
	let cachedSize: number | undefined;
	return {
		async text(): Promise<string> {
			return fsPromises.readFile(filePath, 'utf-8');
		},
		async arrayBuffer(): Promise<ArrayBuffer> {
			const buf = await fsPromises.readFile(filePath);
			// Copy into a fresh ArrayBuffer to avoid handing out the underlying
			// SharedArrayBuffer view from Node's Buffer pool.
			const ab = new ArrayBuffer(buf.byteLength);
			new Uint8Array(ab).set(buf);
			return ab;
		},
		async exists(): Promise<boolean> {
			try {
				await fsPromises.access(filePath, fsSync.constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		get size(): number {
			if (cachedSize !== undefined) return cachedSize;
			try {
				cachedSize = fsSync.statSync(filePath).size;
			} catch {
				cachedSize = 0;
			}
			return cachedSize;
		},
	};
}

/**
 * Atomic file write. On Bun this delegates to `Bun.write`. On Node we write
 * to a temp file in the same directory and rename atomically — the same
 * semantics every existing call site already expects via Bun.write.
 */
export async function bunWrite(
	filePath: string,
	data: string | Uint8Array | ArrayBuffer | ArrayBufferView,
): Promise<number> {
	const bun = getBun() as
		| { write?: (p: string, d: unknown) => Promise<number> }
		| undefined;
	if (bun?.write) {
		return bun.write(filePath, data);
	}
	// Node fallback. Atomic write via temp + rename in the destination dir
	// so the rename is guaranteed to be on the same filesystem.
	const dir = path.dirname(filePath);
	// Unique temp name per call to prevent concurrent-write clobbering on the
	// Node fallback path. Two `bunWrite` calls scheduled in the same
	// millisecond would otherwise share a tempPath, causing one rename to
	// overwrite the other (regression: `appendLedgerEvent` concurrent test).
	const tempName = `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempCounter++}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	const tempPath = path.join(dir, tempName);

	let buffer: string | Uint8Array;
	if (typeof data === 'string') {
		buffer = data;
	} else if (data instanceof ArrayBuffer) {
		buffer = new Uint8Array(data);
	} else if (ArrayBuffer.isView(data)) {
		buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	} else {
		buffer = new Uint8Array(0);
	}

	// Ensure the parent directory exists. Mirrors Bun.write behavior, which
	// creates parent directories when missing.
	try {
		await fsPromises.mkdir(dir, { recursive: true });
	} catch {
		// If mkdir fails for a non-ENOENT reason (e.g. permission), the
		// subsequent writeFile will surface the underlying error.
	}

	await fsPromises.writeFile(tempPath, buffer);

	// Windows can briefly hold a file handle after close, so retry on EEXIST/EBUSY.
	let lastError: unknown;
	for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
		try {
			await fsPromises.rename(tempPath, filePath);
			lastError = undefined;
			break;
		} catch (err) {
			lastError = err;
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM') {
				break;
			}
			await new Promise((r) => setTimeout(r, WINDOWS_RENAME_RETRY_DELAY_MS));
		}
	}
	if (lastError) {
		// Rename failed permanently. Best-effort temp cleanup.
		try {
			await fsPromises.unlink(tempPath);
		} catch {
			// ignore — original error is what matters
		}
		throw lastError;
	}

	// fsync the parent directory so the rename is durable on macOS/APFS.
	// On macOS the rename can complete before the directory entry is flushed;
	// subsequent reads may see stale data or null without this.
	try {
		const dirFd = await fsPromises.open(dir, 'r');
		try {
			await dirFd.sync();
		} finally {
			await dirFd.close();
		}
	} catch {
		// fsync is best-effort; some filesystems/OSes don't support directory fsync.
	}

	const stats = await fsPromises.stat(filePath);
	return stats.size;
}

/**
 * Cross-runtime sleep. Uses `Bun.sleep` when available (Bun), falls back to
 * a `setTimeout`-based Promise on Node. This is the only correct way to
 * introduce delays in plugin code that must run under both runtimes.
 */
export function sleep(ms: number): Promise<void> {
	const bun = getBun() as { sleep?: (ms: number) => Promise<void> } | undefined;
	if (bun?.sleep) {
		return bun.sleep(ms);
	}
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stable 32-bit hash. Bun's `Bun.hash` uses xxHash64 by default; on Node we
 * fall back to a 32-bit djb2 hash — identical hashes are NOT guaranteed
 * across runtimes, so callers should not rely on cross-runtime hash equality
 * (no current caller does — every `Bun.hash` use is in-process state keying
 * or a same-runtime cache key).
 */
export function bunHash(input: string | ArrayBufferView | ArrayBuffer): bigint {
	const bun = getBun() as
		| { hash?: (i: unknown) => bigint | number }
		| undefined;
	if (bun?.hash) {
		const r = bun.hash(input);
		return typeof r === 'bigint' ? r : BigInt(r);
	}
	// Node fallback: djb2 on the byte stream, returned as bigint for shape parity.
	let bytes: Uint8Array;
	if (typeof input === 'string') {
		bytes = new TextEncoder().encode(input);
	} else if (input instanceof ArrayBuffer) {
		bytes = new Uint8Array(input);
	} else {
		bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	}
	let hash = 5381n;
	for (const b of bytes) {
		hash = (hash * 33n + BigInt(b)) & 0xffffffffffffffffn;
	}
	return hash;
}

/**
 * Process spawn. Bun's `Bun.spawn` returns an object with `exited`, `stdout`,
 * `stderr` etc. We expose a minimal compatible surface that callers actually
 * use: `exited`, `exitCode`, and `stdout`/`stderr` as `ReadableStream`-like
 * objects with `text()` and `bytes()` methods.
 */
export interface BunCompatSpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/**
	 * Per-call env overlay merged into the child env at spawn time.
	 * - string value: sets KEY=value on the child env
	 * - null value:    deletes KEY from the child env (use to scrub inherited vars)
	 * Absent keys are inherited from the parent process.env.
	 * Used by FR-201/202 lane runtime profile to inject per-lane PORT,
	 * TMPDIR, etc., without copying process.env.
	 */
	envOverrides?: Record<string, string | null>;
	stdin?: 'inherit' | 'ignore' | 'pipe';
	stdout?: 'inherit' | 'ignore' | 'pipe';
	stderr?: 'inherit' | 'ignore' | 'pipe';
	timeout?: number;
	/** Preserve the caller's exact Windows argv quoting (required for cmd.exe /c). */
	windowsVerbatimArguments?: boolean;
	/**
	 * When true, spawn the child as its own process-group leader (Node path:
	 * `detached`) and kill the entire descendant tree on `kill()`/timeout
	 * rather than only the direct child. A test runner that forks worker
	 * processes (jest/vitest, or a runaway suite) can otherwise outlive a
	 * `proc.kill()` of the parent and keep consuming memory after the timeout.
	 * Opt-in because the default single-child kill is correct for the many
	 * short-lived `bunSpawn` callers (git, lint, version checks).
	 */
	killProcessTree?: boolean;
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
	readonly signalCode?: NodeJS.Signals | null;
	/**
	 * Asynchronous process-creation failure reported by Node's ChildProcess
	 * `error` event (for example ENOENT). Bun reports equivalent failures by
	 * throwing from `Bun.spawn`, so this is populated only by the Node fallback.
	 */
	readonly spawnError?: Error | null;
	kill(signal?: NodeJS.Signals | number): void;
	/** Awaitable best-effort descendant-tree termination for bounded runners. */
	killTree?(signal?: NodeJS.Signals | number): Promise<void>;
}

/**
 * Best-effort kill of a process and all its descendants. On Windows uses
 * `taskkill /T` (tree) keyed off the pid. On POSIX, when the child was spawned
 * detached (its own group leader) we signal the negative pid to reach the whole
 * group; otherwise we fall back to signalling the direct child.
 */
async function killProcessTreeImpl(
	pid: number | undefined,
	signal: NodeJS.Signals | number | undefined,
	directKill: (signal?: NodeJS.Signals | number) => void,
	wasDetached: boolean,
): Promise<void> {
	if (typeof pid !== 'number' || pid <= 0) {
		directKill(signal);
		return;
	}
	if (_internals.platform() === 'win32') {
		let taskkill: ReturnType<typeof nodeSpawn> | undefined;
		try {
			taskkill = _internals.spawnTaskkill(['/PID', String(pid), '/T', '/F'], {
				cwd: _internals.cwd(),
				stdio: ['ignore', 'ignore', 'ignore'],
				timeout: 5_000,
				killSignal: 'SIGKILL',
				windowsHide: true,
			});
			const succeeded = await new Promise<boolean>((resolve) => {
				let settled = false;
				const finish = (value: boolean) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
				taskkill?.once('error', () => finish(false));
				taskkill?.once('exit', (code) => finish(code === 0));
			});
			if (succeeded) return;
		} catch {
			// taskkill unavailable; fall through to direct kill.
		} finally {
			try {
				taskkill?.kill('SIGKILL');
			} catch {
				// already exited
			}
		}
		directKill(signal);
		throw new Error('Windows process-tree termination could not be confirmed');
	}
	if (wasDetached) {
		try {
			process.kill(-pid, (signal as NodeJS.Signals) ?? 'SIGKILL');
			return;
		} catch {
			// group gone or never created — fall through to direct kill
		}
	}
	directKill(signal);
}

function createProcessTreeKiller(
	pid: number | undefined,
	directKill: (signal?: NodeJS.Signals | number) => void,
	wasDetached: boolean,
): (signal?: NodeJS.Signals | number) => Promise<void> {
	// Every escalation attempt is independent. In particular, a failed Windows
	// taskkill/SIGTERM fallback must not consume a later SIGKILL request.
	return (signal) => killProcessTreeImpl(pid, signal, directKill, wasDetached);
}

export const _internals = {
	platform: () => process.platform,
	cwd: () => process.cwd(),
	spawnTaskkill: (args: string[], options: Parameters<typeof nodeSpawn>[2]) =>
		nodeSpawn('taskkill', args, options),
	createProcessTreeKiller,
};

function streamFromNode(
	pipe: NodeJS.ReadableStream | null | undefined,
): BunCompatStream {
	// Expose either full buffered output (`text()`/`bytes()`) or a Web reader for
	// incremental bounded consumption. Claim exactly one mode lazily: Node
	// streams start paused, so a bounded reader must not run beside an eager,
	// unbounded chunk collector.
	let collected: Promise<Buffer> | undefined;
	let readerClaimed = false;
	const collect = (): Promise<Buffer> => {
		if (readerClaimed) {
			return Promise.reject(
				new TypeError('Subprocess output is already consumed by a reader'),
			);
		}
		collected ??= new Promise((resolve) => {
			if (!pipe) {
				resolve(Buffer.alloc(0));
				return;
			}
			const chunks: Buffer[] = [];
			pipe.on('data', (chunk: Buffer | string) => {
				chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			});
			pipe.on('end', () => resolve(Buffer.concat(chunks)));
			pipe.on('error', () => resolve(Buffer.concat(chunks)));
		});
		return collected;
	};

	const toWebReadable = (): ReadableStream<Uint8Array> => {
		// `node:stream`'s Readable has `.toWeb()` on Node 17+. Bun also
		// supports it. Fall back to a manual conversion if missing.
		if (!pipe) {
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			});
		}
		const r = pipe as NodeJS.ReadableStream & {
			toWeb?: () => ReadableStream<Uint8Array>;
		};
		if (typeof r.toWeb === 'function') {
			return r.toWeb();
		}
		return new ReadableStream<Uint8Array>({
			start(controller) {
				pipe.on('data', (chunk: Buffer | string) => {
					controller.enqueue(
						typeof chunk === 'string'
							? new TextEncoder().encode(chunk)
							: new Uint8Array(
									chunk.buffer,
									chunk.byteOffset,
									chunk.byteLength,
								),
					);
				});
				pipe.on('end', () => controller.close());
				pipe.on('error', (err) => controller.error(err));
			},
			cancel() {
				const destroyable = pipe as unknown as { destroy?: () => void };
				if (typeof destroyable.destroy === 'function') {
					try {
						destroyable.destroy();
					} catch {
						// best-effort
					}
				}
			},
		});
	};

	return {
		async text(): Promise<string> {
			return (await collect()).toString('utf-8');
		},
		async bytes(): Promise<Uint8Array> {
			const b = await collect();
			return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
		},
		getReader(): ReadableStreamDefaultReader<Uint8Array> {
			if (readerClaimed || collected) {
				throw new TypeError('Subprocess output is already consumed');
			}
			readerClaimed = true;
			return toWebReadable().getReader();
		},
	};
}

function mapStdio(
	v: 'inherit' | 'ignore' | 'pipe' | undefined,
): 'inherit' | 'ignore' | 'pipe' {
	return v ?? 'pipe';
}

function streamFromBun(stream: unknown): BunCompatStream {
	// Bun's subprocess `stdout`/`stderr` is a `ReadableStream` (Web Streams).
	// Wrap it to expose the `text()`/`bytes()`/`getReader()` shape the rest
	// of the codebase expects from the shim. We tee the stream when both
	// shapes are needed in the same call site, but in practice each caller
	// uses only one path.
	if (!stream || typeof stream !== 'object') {
		const empty: BunCompatStream = {
			async text() {
				return '';
			},
			async bytes() {
				return new Uint8Array(0);
			},
			getReader() {
				return new ReadableStream<Uint8Array>({
					start(controller) {
						controller.close();
					},
				}).getReader();
			},
		};
		return empty;
	}
	const candidate = stream as {
		text?: () => Promise<string>;
		bytes?: () => Promise<Uint8Array>;
		getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
	};
	const collect = async (): Promise<Uint8Array> => {
		if (typeof candidate.getReader !== 'function') {
			return new Uint8Array(0);
		}
		const reader = candidate.getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			out.set(c, off);
			off += c.byteLength;
		}
		return out;
	};
	const text =
		typeof candidate.text === 'function'
			? () => (candidate.text as () => Promise<string>)()
			: async () => new TextDecoder().decode(await collect());
	const bytes =
		typeof candidate.bytes === 'function'
			? () => (candidate.bytes as () => Promise<Uint8Array>)()
			: collect;
	const getReader =
		typeof candidate.getReader === 'function'
			? () =>
					(
						candidate.getReader as () => ReadableStreamDefaultReader<Uint8Array>
					)()
			: () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}).getReader();
	return { text, bytes, getReader };
}

/**
 * Merges `envOverrides` into the base env (or `process.env` if no base env
 * is given) and returns the resulting record.
 *
 * - `value === null`  → delete the key from the result
 * - `value !== null`  → set `key = value` in the result
 * - absent keys       → inherited from base env
 *
 * Always returns a copy of the env — never mutates the caller's env.
 *
 * The distinction between "no base env provided" and "explicitly provided
 * an empty base env" is preserved:
 *   - `baseEnv === undefined` (caller did NOT provide env):
 *       fallback to process.env, apply overrides, return `undefined` if the
 *       merged result is empty so the child inherits naturally from process.env.
 *   - `baseEnv !== undefined` (caller provided env, even if `{}`):
 *       start from a copy of baseEnv, apply overrides, return `{}` if the
 *       merged result is empty (explicit empty environment — do NOT collapse
 *       to `undefined` and re-expose the parent's env to the child).
 */
export function mergeEnvForChild(
	baseEnv: Record<string, string | undefined> | undefined,
	envOverrides: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	// Track whether the caller explicitly provided a base env (possibly `{}`).
	// This flag determines what to return when the merged result is empty:
	//   - true  → return `{}`  (caller asked for empty env, honor it)
	//   - false → return `undefined` (let the child inherit process.env)
	const hasExplicitBaseEnv = baseEnv !== undefined;

	// Start from a copy of the base so we never mutate the caller's env.
	const baseSource = baseEnv ?? process.env;
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseSource)) {
		if (typeof value === 'string') merged[key] = value;
	}

	if (envOverrides) {
		for (const [key, value] of Object.entries(envOverrides)) {
			if (value === null) {
				delete merged[key];
			} else {
				merged[key] = value;
			}
		}
	}

	if (Object.keys(merged).length === 0) {
		return hasExplicitBaseEnv ? {} : undefined;
	}
	return merged;
}

export function bunSpawn(
	cmd: string[],
	options?: BunCompatSpawnOptions,
): BunCompatSubprocess {
	const bun = getBun() as
		| { spawn?: (args: string[], opts?: unknown) => unknown }
		| undefined;
	if (bun?.spawn) {
		// Adapt Bun's subprocess to the `BunCompatSubprocess` shape so
		// callers do not have to know which runtime they're on. Bun exposes
		// `stdout`/`stderr` as `ReadableStream`; we wrap them.
		const mergedEnv = mergeEnvForChild(options?.env, options?.envOverrides);
		// Always build a fresh options object so we never mutate the caller's.
		const spawnOpts: Record<string, unknown> = { ...options };
		delete spawnOpts.killProcessTree;
		if (mergedEnv !== undefined) spawnOpts.env = mergedEnv;
		// Security (SC-003.4): a child that traps SIGTERM must still be killed
		// when the timeout fires. Bun's default kill signal on timeout is
		// SIGTERM, which the child can ignore — leaving `proc.exited` pending
		// forever (a timeout bypass). Force SIGKILL: the deadline has already
		// passed, so a graceful signal is no longer owed. This mirrors the Node
		// fallback path below, which already escalates to SIGKILL on timeout.
		if (
			options?.timeout &&
			options.timeout > 0 &&
			options.killProcessTree !== true
		) {
			spawnOpts.killSignal = 'SIGKILL';
		}
		if (options?.killProcessTree === true) {
			// Bun's native timeout can reap the parent before Windows taskkill can
			// discover its descendants, so tree-aware timeouts are wrapper-owned.
			delete spawnOpts.timeout;
			delete spawnOpts.killSignal;
			spawnOpts.detached = true;
		}
		const proc = bun.spawn(cmd, spawnOpts) as {
			stdout?: unknown;
			stderr?: unknown;
			exited: Promise<number>;
			exitCode: number | null;
			pid?: number;
			kill: (sig?: NodeJS.Signals | number) => void;
		};
		const killBunTree = createProcessTreeKiller(
			proc.pid,
			(sig) => proc.kill(sig),
			true,
		);
		const killBunProcess = (sig?: NodeJS.Signals | number): Promise<void> =>
			options?.killProcessTree
				? killBunTree(sig)
				: Promise.resolve(proc.kill(sig));
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (
			options?.killProcessTree === true &&
			options.timeout &&
			options.timeout > 0
		) {
			timeoutHandle = setTimeout(() => {
				try {
					void killBunProcess('SIGKILL').catch(() => undefined);
				} catch {
					// Process may already have exited.
				}
			}, options.timeout);
			if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
		}
		const exited = proc.exited.finally(() => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		});
		return {
			stdout: streamFromBun(proc.stdout),
			stderr: streamFromBun(proc.stderr),
			exited,
			get exitCode() {
				return proc.exitCode;
			},
			get signalCode() {
				return (proc as typeof proc & { signalCode?: NodeJS.Signals | null })
					.signalCode;
			},
			kill(sig) {
				void killBunProcess(sig).catch(() => undefined);
			},
			killTree: killBunProcess,
		};
	}
	const [file, ...args] = cmd;
	const detached = options?.killProcessTree === true;
	const mergedEnv = mergeEnvForChild(options?.env, options?.envOverrides);
	const proc = nodeSpawn(file, args, {
		cwd: options?.cwd,
		env: mergedEnv,
		detached,
		windowsHide: true,
		windowsVerbatimArguments: options?.windowsVerbatimArguments,
		stdio: [
			mapStdio(options?.stdin),
			mapStdio(options?.stdout),
			mapStdio(options?.stderr),
		],
	});

	const killChildTree = createProcessTreeKiller(
		proc.pid,
		(signal) => proc.kill(signal as NodeJS.Signals),
		true,
	);
	const killChild = (signal?: NodeJS.Signals | number): Promise<void> => {
		if (detached) return killChildTree(signal);
		proc.kill(signal as NodeJS.Signals);
		return Promise.resolve();
	};

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let observedSignal: NodeJS.Signals | null = null;
	let observedSpawnError: Error | null = null;
	const exited = new Promise<number>((resolve) => {
		proc.on('exit', (code, signal) => {
			observedSignal = signal;
			resolve(code ?? -1);
		});
		proc.on('error', (error) => {
			observedSpawnError = error;
			resolve(1);
		});
		if (options?.timeout && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				try {
					void killChild('SIGKILL').catch(() => undefined);
				} catch {
					// ignore — process may already be gone
				}
			}, options.timeout);
			if (
				typeof (timeoutHandle as { unref?: () => void }).unref === 'function'
			) {
				(timeoutHandle as { unref: () => void }).unref();
			}
		}
	}).finally(() => {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	});

	return {
		stdout: streamFromNode(proc.stdout),
		stderr: streamFromNode(proc.stderr),
		exited,
		get exitCode(): number | null {
			// Windows may expose the libuv spawn error (for example -4058 for
			// ENOENT) through ChildProcess.exitCode even though no child ran.
			// Keep the cross-runtime contract unambiguous: process-creation
			// failures have no exit code and are described by spawnError.
			return observedSpawnError ? null : proc.exitCode;
		},
		get signalCode(): NodeJS.Signals | null {
			return observedSignal ?? proc.signalCode;
		},
		get spawnError(): Error | null {
			return observedSpawnError;
		},
		kill(signal?: NodeJS.Signals | number) {
			void killChild(signal).catch(() => undefined);
		},
		killTree: killChild,
	};
}

export interface BunCompatSyncResult {
	stdout: Uint8Array;
	stderr: Uint8Array;
	exitCode: number;
	success: boolean;
}

export function bunSpawnSync(
	cmd:
		| string[]
		| {
				cmd: string[];
				cwd?: string;
				env?: Record<string, string | undefined>;
				stdin?: string | Uint8Array;
				timeout?: number;
		  },
	options?: BunCompatSpawnOptions,
): BunCompatSyncResult {
	const bun = getBun() as
		| {
				spawnSync?: (
					args: unknown,
					opts?: unknown,
				) => {
					stdout: Uint8Array;
					stderr: Uint8Array;
					exitCode: number;
					success: boolean;
				};
		  }
		| undefined;
	if (bun?.spawnSync) {
		const mergedEnv = mergeEnvForChild(options?.env, options?.envOverrides);
		const spawnOpts =
			mergedEnv !== undefined ? { ...options, env: mergedEnv } : options;
		const result = bun.spawnSync(cmd, spawnOpts);
		return result;
	}
	let argv: string[];
	let mergedOptions: BunCompatSpawnOptions & { stdin?: string | Uint8Array };
	if (Array.isArray(cmd)) {
		argv = cmd;
		mergedOptions = { ...(options ?? {}) };
	} else {
		argv = cmd.cmd;
		mergedOptions = {
			cwd: cmd.cwd,
			env: cmd.env,
			stdin: 'pipe',
			timeout: cmd.timeout,
			...(options ?? {}),
		};
		if (cmd.stdin !== undefined) {
			(mergedOptions as { stdin?: string | Uint8Array }).stdin = cmd.stdin;
		}
	}
	const [file, ...args] = argv;
	const mergedEnv = mergeEnvForChild(mergedOptions.env, options?.envOverrides);
	const result = nodeSpawnSync(file, args, {
		cwd: mergedOptions.cwd,
		env: mergedEnv,
		input:
			(mergedOptions as { stdin?: string | Uint8Array }).stdin instanceof
				Uint8Array ||
			typeof (mergedOptions as { stdin?: string | Uint8Array }).stdin ===
				'string'
				? ((mergedOptions as { stdin?: string | Uint8Array }).stdin as
						| string
						| Uint8Array)
				: undefined,
		timeout: mergedOptions.timeout,
		windowsHide: true,
	});
	const stdout =
		result.stdout instanceof Buffer
			? new Uint8Array(
					result.stdout.buffer,
					result.stdout.byteOffset,
					result.stdout.byteLength,
				)
			: typeof result.stdout === 'string'
				? new TextEncoder().encode(result.stdout)
				: new Uint8Array(0);
	const stderr =
		result.stderr instanceof Buffer
			? new Uint8Array(
					result.stderr.buffer,
					result.stderr.byteOffset,
					result.stderr.byteLength,
				)
			: typeof result.stderr === 'string'
				? new TextEncoder().encode(result.stderr)
				: new Uint8Array(0);
	const exitCode = result.status ?? (result.signal ? 128 : 1);
	return {
		stdout,
		stderr,
		exitCode,
		success: exitCode === 0 && !result.error,
	};
}
