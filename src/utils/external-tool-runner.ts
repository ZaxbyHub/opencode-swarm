import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BunCompatSubprocess, bunSpawn } from './bun-compat';
import { warn } from './logger';

export interface ExternalToolRunOptions {
	executable: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	env?: Record<string, string | undefined>;
	abortSignal?: AbortSignal;
	/** Preserve an already-quoted Windows command line, such as constrained cmd.exe /c. */
	windowsVerbatimArguments?: boolean;
}

export interface ExternalToolRunResult {
	status: 'completed' | 'timeout' | 'cancelled' | 'spawn-error';
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	message?: string;
}

interface BoundedStreamResult {
	text: string;
	truncated: boolean;
}

interface BoundedStreamReadHandle {
	promise: Promise<BoundedStreamResult>;
	cancel: () => Promise<void>;
}

function decodeCompleteUtf8Prefix(bytes: Uint8Array): string {
	const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
	try {
		return fatalDecoder.decode(bytes);
	} catch {
		// A bounded read can end in the middle of a UTF-8 sequence. UTF-8
		// code points are at most four bytes, so trim only the incomplete
		// suffix until the remaining prefix decodes without replacement.
		for (let trim = 1; trim <= 3 && trim <= bytes.byteLength; trim += 1) {
			try {
				return fatalDecoder.decode(bytes.subarray(0, bytes.byteLength - trim));
			} catch {
				// Continue trimming the incomplete suffix.
			}
		}
		// Preserve the historical best-effort behavior for malformed bytes in
		// the middle of a stream, but never expose a decoder replacement that
		// represents the truncated tail itself.
		return new TextDecoder().decode(bytes).replace(/\uFFFD+$/u, '');
	}
}

const DEFAULT_WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'];
const TERMINATION_GRACE_MS = 20;
const TERMINATION_FORCE_MS = 20;
const TERMINATION_CONFIRM_MS = 20;
// Windows taskkill is independently bounded at five seconds in bun-compat.
// Leave a small scheduling margin so the runner can observe its settlement
// before the lower-level spawn fallback becomes eligible to fire.
const TREE_TERMINATION_CONFIRM_MS = 5_100;
const TERMINATION_FALLBACK_BUFFER_MS = 1;
const STREAM_DRAIN_MS = 50;
const STREAM_CANCEL_MS = 50;
const MAX_TIMEOUT_MS = 2_147_483_647;
const TERMINATION_WINDOWS_MS =
	TERMINATION_GRACE_MS +
	TERMINATION_FORCE_MS +
	TERMINATION_CONFIRM_MS +
	TREE_TERMINATION_CONFIRM_MS +
	TERMINATION_FALLBACK_BUFFER_MS;
const MAX_RUNNER_TIMEOUT_MS = MAX_TIMEOUT_MS - TERMINATION_WINDOWS_MS;
const UNCONFIRMED_TERMINATION_MESSAGE =
	'external tool process termination could not be confirmed';

type ExitRaceResult =
	| { kind: 'exit'; exitCode: number }
	| { kind: 'timeout' }
	| { kind: 'cancelled' };

function isExecutableFile(candidate: string): boolean {
	try {
		const stats = fs.statSync(candidate);
		return stats.isFile();
	} catch {
		return false;
	}
}

export function resolveExecutableFromPath(
	names: string[],
	envPath = process.env.PATH ?? '',
	platform = process.platform,
): string | null {
	const pathEntries = envPath.split(path.delimiter).filter(Boolean);
	const isWindows = platform === 'win32';

	for (const rawName of names) {
		if (!rawName) continue;
		if (path.isAbsolute(rawName) && isExecutableFile(rawName)) {
			return rawName;
		}

		const extensions =
			isWindows && path.extname(rawName) === ''
				? DEFAULT_WINDOWS_EXTENSIONS
				: [''];

		for (const dir of pathEntries) {
			for (const ext of extensions) {
				const candidate = path.join(dir, `${rawName}${ext}`);
				if (isExecutableFile(candidate)) {
					return candidate;
				}
			}
		}
	}

	return null;
}

function clampTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs)) {
		return MAX_RUNNER_TIMEOUT_MS;
	}
	return Math.min(Math.max(1, Math.floor(timeoutMs)), MAX_RUNNER_TIMEOUT_MS);
}

function addTimeoutMs(baseMs: number, deltaMs: number): number {
	if (baseMs >= MAX_TIMEOUT_MS) {
		return MAX_TIMEOUT_MS;
	}
	return Math.min(MAX_TIMEOUT_MS, baseMs + deltaMs);
}

function computeSpawnTimeoutMs(timeoutMs: number): number {
	let total = clampTimeoutMs(timeoutMs);
	for (const windowMs of [
		TERMINATION_GRACE_MS,
		TERMINATION_FORCE_MS,
		TERMINATION_CONFIRM_MS,
		TREE_TERMINATION_CONFIRM_MS,
		TERMINATION_FALLBACK_BUFFER_MS,
	]) {
		total = addTimeoutMs(total, windowMs);
	}
	return total;
}

function startBoundedStreamRead(
	stream: BunCompatSubprocess['stdout'],
	maxBytes: number,
	onLimitExceeded?: () => void,
): BoundedStreamReadHandle {
	const reader = stream.getReader();
	let lockReleased = false;
	let cancelPromise: Promise<void> | undefined;
	const releaseLock = () => {
		if (lockReleased) return;
		lockReleased = true;
		try {
			reader.releaseLock();
		} catch {
			// best effort
		}
	};
	const cancel = async () => {
		cancelPromise ??= (async () => {
			try {
				await reader.cancel();
			} catch {
				// best effort
			} finally {
				releaseLock();
			}
		})();
		return cancelPromise;
	};

	if (maxBytes <= 0) {
		onLimitExceeded?.();
		return {
			cancel,
			promise: (async () => {
				await cancel();
				return { text: '', truncated: true };
			})(),
		};
	}

	const promise = (async (): Promise<BoundedStreamResult> => {
		const chunks: Uint8Array[] = [];
		let total = 0;
		let truncated = false;

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;

				const remaining = maxBytes - total;
				if (value.byteLength > remaining) {
					if (remaining > 0) {
						chunks.push(value.slice(0, remaining));
						total += remaining;
					}
					truncated = true;
					onLimitExceeded?.();
					void cancel();
					break;
				}

				chunks.push(value);
				total += value.byteLength;
			}
		} finally {
			releaseLock();
		}

		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}

		return {
			text: decodeCompleteUtf8Prefix(out),
			truncated,
		};
	})();

	return { promise, cancel };
}

function timeoutKillSignal(platform: NodeJS.Platform): NodeJS.Signals {
	return platform === 'win32' ? 'SIGTERM' : 'SIGKILL';
}

function reportKillFailure(error: unknown, signal: NodeJS.Signals): void {
	if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return;
	_internals.warn(`external tool process kill failed for ${signal}`, error);
}

function killProcess(proc: BunCompatSubprocess | undefined): void {
	const signal = timeoutKillSignal(_internals.platform());
	try {
		proc?.kill(signal);
	} catch (error) {
		reportKillFailure(error, signal);
	}
}

function requestTermination(
	proc: BunCompatSubprocess | undefined,
	signal: NodeJS.Signals,
): Promise<boolean> {
	try {
		if (proc?.killTree) {
			return proc.killTree(signal).then(
				() => true,
				(error) => {
					reportKillFailure(error, signal);
					return false;
				},
			);
		} else {
			proc?.kill(signal);
			return Promise.resolve(proc !== undefined);
		}
	} catch (error) {
		reportKillFailure(error, signal);
		return Promise.resolve(false);
	}
}

async function waitForExitWithin(
	exitPromise: Promise<number>,
	waitMs: number,
): Promise<number | null> {
	if (waitMs <= 0) {
		return Promise.resolve(null);
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race<number | null>([
			exitPromise,
			new Promise<null>((resolve) => {
				timeoutHandle = _internals.setTimeout(() => resolve(null), waitMs);
			}),
		]);
	} finally {
		if (timeoutHandle !== undefined) {
			_internals.clearTimeout(timeoutHandle);
		}
	}
}

async function waitForValueWithin<T>(
	promise: Promise<T>,
	waitMs: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then((value) => ({ completed: true as const, value })),
			new Promise<{ completed: false }>((resolve) => {
				timeoutHandle = _internals.setTimeout(
					() => resolve({ completed: false }),
					waitMs,
				);
			}),
		]);
	} finally {
		if (timeoutHandle !== undefined) {
			_internals.clearTimeout(timeoutHandle);
		}
	}
}

async function collectBoundedStreams(
	stdoutRead: BoundedStreamReadHandle,
	stderrRead: BoundedStreamReadHandle,
	proc: BunCompatSubprocess,
	treeAlreadyConfirmed = false,
): Promise<
	| {
			kind: 'collected';
			stdout: BoundedStreamResult;
			stderr: BoundedStreamResult;
	  }
	| { kind: 'cleanup-failed' }
	| { kind: 'unconfirmed-termination' }
> {
	const reads = Promise.all([stdoutRead.promise, stderrRead.promise]);
	let collected = await waitForValueWithin(reads, STREAM_DRAIN_MS);
	if (!collected.completed) {
		// A descendant may have inherited the parent's pipes after the parent
		// exited. Treat this as abnormal output cleanup, attempt tree termination,
		// and bound reader cancellation as well.
		const treeTermination = waitForValueWithin(
			requestTermination(proc, 'SIGKILL'),
			TREE_TERMINATION_CONFIRM_MS,
		);
		void Promise.allSettled([stdoutRead.cancel(), stderrRead.cancel()]);
		collected = await waitForValueWithin(reads, STREAM_CANCEL_MS);
		const terminationResult = await treeTermination;
		if (
			!treeAlreadyConfirmed &&
			(!terminationResult.completed || !terminationResult.value)
		) {
			return { kind: 'unconfirmed-termination' };
		}
	}
	if (!collected.completed) return { kind: 'cleanup-failed' };
	return {
		kind: 'collected',
		stdout: collected.value[0],
		stderr: collected.value[1],
	};
}

export async function runExternalTool(
	options: ExternalToolRunOptions,
): Promise<ExternalToolRunResult> {
	if (!path.isAbsolute(options.cwd)) {
		return {
			status: 'spawn-error',
			exitCode: null,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			message: 'external tool cwd must be absolute',
		};
	}
	if (options.abortSignal?.aborted) {
		return {
			status: 'cancelled',
			exitCode: null,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			message: 'external tool execution cancelled before spawn',
		};
	}

	let proc: BunCompatSubprocess | undefined;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	let overflowTreeTermination: Promise<boolean> | undefined;
	let exitSettled = false;
	let settledExitCode: number | null = null;
	const runnerTimeoutMs = clampTimeoutMs(options.timeoutMs);
	const spawnTimeoutMs = computeSpawnTimeoutMs(runnerTimeoutMs);

	try {
		proc = _internals.bunSpawn([options.executable, ...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: spawnTimeoutMs,
			killProcessTree: true,
			windowsVerbatimArguments: options.windowsVerbatimArguments,
		});

		const exitPromise = proc.exited.then((exitCode) => {
			exitSettled = true;
			settledExitCode = exitCode;
			return exitCode;
		});
		const exitRacePromise: Promise<ExitRaceResult> = exitPromise.then(
			(exitCode) => ({ kind: 'exit', exitCode }),
		);
		const timeout = new Promise<ExitRaceResult>((resolve) => {
			timeoutHandle = _internals.setTimeout(() => {
				if (exitSettled) {
					resolve({
						kind: 'exit',
						exitCode: settledExitCode ?? proc?.exitCode ?? 0,
					});
					return;
				}
				resolve({ kind: 'timeout' });
			}, runnerTimeoutMs);
		});
		const cancelled = new Promise<ExitRaceResult>((resolve) => {
			if (!options.abortSignal) return;
			let handled = false;
			abortListener = () => {
				if (handled) return;
				handled = true;
				resolve({ kind: 'cancelled' });
			};
			options.abortSignal.addEventListener('abort', abortListener, {
				once: true,
			});
			// Close the race where the signal aborts inside bunSpawn, after the
			// pre-spawn check but before the listener is registered.
			if (options.abortSignal.aborted) abortListener();
		});

		const terminateOnOverflow = () => {
			overflowTreeTermination ??= requestTermination(proc, 'SIGKILL');
		};
		const stdoutRead = startBoundedStreamRead(
			proc.stdout,
			options.maxStdoutBytes,
			terminateOnOverflow,
		);
		const stderrRead = startBoundedStreamRead(
			proc.stderr,
			options.maxStderrBytes,
			terminateOnOverflow,
		);
		const exitResult = await Promise.race([
			exitRacePromise,
			timeout,
			cancelled,
		]);
		if (exitResult.kind === 'timeout' || exitResult.kind === 'cancelled') {
			const gracefulTreeTermination = requestTermination(proc, 'SIGTERM');
			let confirmedExitCode = await waitForExitWithin(
				exitPromise,
				TERMINATION_GRACE_MS,
			);
			// Parent exit is not process-group exit: a descendant may ignore
			// SIGTERM and close inherited pipes. Always force the group after grace.
			if (!overflowTreeTermination) {
				overflowTreeTermination = requestTermination(proc, 'SIGKILL');
			}
			const forcedTreeTermination = overflowTreeTermination;
			const treeTerminationResult = waitForValueWithin(
				Promise.all([gracefulTreeTermination, forcedTreeTermination]),
				TREE_TERMINATION_CONFIRM_MS,
			);
			if (confirmedExitCode === null) {
				confirmedExitCode = await waitForExitWithin(
					exitPromise,
					TERMINATION_FORCE_MS,
				);
			}
			if (confirmedExitCode === null) {
				confirmedExitCode = await waitForExitWithin(
					exitPromise,
					TERMINATION_CONFIRM_MS,
				);
			}
			const treeTermination = await treeTerminationResult;
			const treeTerminationConfirmed =
				treeTermination.completed && treeTermination.value.some(Boolean);
			void Promise.allSettled([stdoutRead.cancel(), stderrRead.cancel()]);
			const streams = await collectBoundedStreams(
				stdoutRead,
				stderrRead,
				proc,
				treeTerminationConfirmed,
			);
			if (streams.kind !== 'collected') {
				return {
					status: 'spawn-error',
					exitCode: confirmedExitCode ?? proc.exitCode,
					stdout: '',
					stderr: '',
					stdoutTruncated: true,
					stderrTruncated: true,
					message:
						streams.kind === 'unconfirmed-termination'
							? UNCONFIRMED_TERMINATION_MESSAGE
							: 'external tool output cleanup did not complete',
				};
			}
			const { stdout, stderr } = streams;
			if (confirmedExitCode === null || !treeTerminationConfirmed) {
				return {
					status: 'spawn-error',
					exitCode: proc.exitCode,
					stdout: stdout.text,
					stderr: stderr.text,
					stdoutTruncated: stdout.truncated,
					stderrTruncated: stderr.truncated,
					message: UNCONFIRMED_TERMINATION_MESSAGE,
				};
			}
			if (exitResult.kind === 'timeout') {
				return {
					status: 'timeout',
					exitCode: confirmedExitCode,
					stdout: stdout.text,
					stderr: stderr.text,
					stdoutTruncated: stdout.truncated,
					stderrTruncated: stderr.truncated,
				};
			}
			return {
				status: 'cancelled',
				exitCode: confirmedExitCode,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				message: 'external tool execution cancelled',
			};
		}
		const streams = await collectBoundedStreams(stdoutRead, stderrRead, proc);
		if (streams.kind !== 'collected') {
			return {
				status: 'spawn-error',
				exitCode: exitResult.exitCode,
				stdout: '',
				stderr: '',
				stdoutTruncated: true,
				stderrTruncated: true,
				message:
					streams.kind === 'unconfirmed-termination'
						? UNCONFIRMED_TERMINATION_MESSAGE
						: 'external tool output cleanup did not complete',
			};
		}
		const { stdout, stderr } = streams;
		if (overflowTreeTermination) {
			const overflowTermination = await waitForValueWithin(
				overflowTreeTermination,
				TREE_TERMINATION_CONFIRM_MS,
			);
			if (!overflowTermination.completed || !overflowTermination.value) {
				return {
					status: 'spawn-error',
					exitCode: exitResult.exitCode,
					stdout: stdout.text,
					stderr: stderr.text,
					stdoutTruncated: stdout.truncated,
					stderrTruncated: stderr.truncated,
					message: UNCONFIRMED_TERMINATION_MESSAGE,
				};
			}
		}
		if (proc.spawnError) {
			return {
				status: 'spawn-error',
				exitCode: proc.exitCode,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				message: proc.spawnError.message,
			};
		}
		if (proc.signalCode) {
			return {
				status: 'spawn-error',
				exitCode: exitResult.exitCode,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				message: `external tool terminated by signal ${proc.signalCode}`,
			};
		}

		return {
			status: 'completed',
			exitCode: exitResult.exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			stdoutTruncated: stdout.truncated,
			stderrTruncated: stderr.truncated,
		};
	} catch (err) {
		return {
			status: 'spawn-error',
			exitCode: proc?.exitCode ?? null,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			message: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (timeoutHandle !== undefined) _internals.clearTimeout(timeoutHandle);
		if (abortListener && options.abortSignal) {
			options.abortSignal.removeEventListener('abort', abortListener);
		}
		if (!exitSettled) killProcess(proc);
	}
}

export const _internals: {
	bunSpawn: typeof bunSpawn;
	platform: () => NodeJS.Platform;
	now: () => number;
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	clampTimeoutMs: typeof clampTimeoutMs;
	computeSpawnTimeoutMs: typeof computeSpawnTimeoutMs;
	warn: typeof warn;
} = {
	bunSpawn,
	platform: () => process.platform,
	now: () => Date.now(),
	setTimeout,
	clearTimeout,
	clampTimeoutMs,
	computeSpawnTimeoutMs,
	warn,
};
