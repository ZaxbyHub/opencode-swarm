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

	const stats = await fsPromises.stat(filePath);
	return stats.size;
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

function streamFromNode(
	pipe: NodeJS.ReadableStream | null | undefined,
): BunCompatStream {
	// Build two consumers off the same pipe: one that resolves to the full
	// buffered output (for `text()`/`bytes()`) and one that exposes a Web
	// ReadableStream reader (for callers like `readBoundedStream` that need
	// incremental, bounded consumption). The first reader to attach drains
	// the pipe — they are mutually exclusive in practice but both are wired
	// so callers can pick the shape they need without surprises.
	const collected: Promise<Buffer> = new Promise((resolve) => {
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
			return (await collected).toString('utf-8');
		},
		async bytes(): Promise<Uint8Array> {
			const b = await collected;
			return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
		},
		getReader(): ReadableStreamDefaultReader<Uint8Array> {
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
		const proc = bun.spawn(cmd, options) as {
			stdout?: unknown;
			stderr?: unknown;
			exited: Promise<number>;
			exitCode: number | null;
			kill: (sig?: NodeJS.Signals | number) => void;
		};
		return {
			stdout: streamFromBun(proc.stdout),
			stderr: streamFromBun(proc.stderr),
			exited: proc.exited,
			get exitCode() {
				return proc.exitCode;
			},
			kill(sig) {
				proc.kill(sig);
			},
		};
	}
	const [file, ...args] = cmd;
	const proc = nodeSpawn(file, args, {
		cwd: options?.cwd,
		env: options?.env as NodeJS.ProcessEnv | undefined,
		stdio: [
			mapStdio(options?.stdin),
			mapStdio(options?.stdout),
			mapStdio(options?.stderr),
		],
	});

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const exited = new Promise<number>((resolve) => {
		proc.on('exit', (code) => resolve(code ?? 0));
		proc.on('error', () => resolve(1));
		if (options?.timeout && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				try {
					proc.kill('SIGKILL');
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
			return proc.exitCode;
		},
		kill(signal?: NodeJS.Signals | number) {
			try {
				proc.kill(signal as NodeJS.Signals);
			} catch {
				// ignore
			}
		},
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
		const result = bun.spawnSync(cmd, options);
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
	const result = nodeSpawnSync(file, args, {
		cwd: mergedOptions.cwd,
		env: mergedOptions.env as NodeJS.ProcessEnv | undefined,
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
