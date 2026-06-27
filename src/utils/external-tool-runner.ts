import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BunCompatSubprocess, bunSpawn } from './bun-compat';

export interface ExternalToolRunOptions {
	executable: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	env?: Record<string, string | undefined>;
}

export interface ExternalToolRunResult {
	status: 'completed' | 'timeout' | 'spawn-error';
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

const DEFAULT_WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'];

type ExitRaceResult = { kind: 'exit'; exitCode: number } | { kind: 'timeout' };

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

async function readBoundedStream(
	stream: BunCompatSubprocess['stdout'],
	maxBytes: number,
): Promise<BoundedStreamResult> {
	const reader = stream.getReader();
	let lockReleased = false;
	const releaseLock = () => {
		if (lockReleased) return;
		lockReleased = true;
		try {
			reader.releaseLock();
		} catch {
			// best effort
		}
	};
	const cancelAndRelease = async () => {
		try {
			await reader.cancel();
		} catch {
			// best effort
		} finally {
			releaseLock();
		}
	};

	if (maxBytes <= 0) {
		await cancelAndRelease();
		return { text: '', truncated: true };
	}

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
				await cancelAndRelease();
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
		text: new TextDecoder().decode(out),
		truncated,
	};
}

function timeoutKillSignal(platform: NodeJS.Platform): NodeJS.Signals {
	return platform === 'win32' ? 'SIGTERM' : 'SIGKILL';
}

function killProcess(proc: BunCompatSubprocess | undefined): void {
	try {
		proc?.kill(timeoutKillSignal(_internals.platform()));
	} catch {
		// best effort
	}
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

	let proc: BunCompatSubprocess | undefined;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let exitSettled = false;
	let settledExitCode: number | null = null;

	try {
		proc = _internals.bunSpawn([options.executable, ...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: options.timeoutMs,
		});

		const exitPromise: Promise<ExitRaceResult> = proc.exited.then(
			(exitCode) => {
				exitSettled = true;
				settledExitCode = exitCode;
				return { kind: 'exit', exitCode };
			},
		);
		const timeout = new Promise<ExitRaceResult>((resolve) => {
			timeoutHandle = setTimeout(() => {
				if (exitSettled) {
					resolve({
						kind: 'exit',
						exitCode: settledExitCode ?? proc?.exitCode ?? 0,
					});
					return;
				}
				killProcess(proc);
				resolve({ kind: 'timeout' });
			}, options.timeoutMs);
		});

		const stdoutPromise = readBoundedStream(
			proc.stdout,
			options.maxStdoutBytes,
		);
		const stderrPromise = readBoundedStream(
			proc.stderr,
			options.maxStderrBytes,
		);
		const exitResult = await Promise.race([exitPromise, timeout]);
		if (exitResult.kind === 'timeout') {
			return {
				status: 'timeout',
				exitCode: proc.exitCode,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

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
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		if (proc) {
			try {
				proc.kill();
			} catch {
				// best effort
			}
		}
	}
}

export const _internals: {
	bunSpawn: typeof bunSpawn;
	platform: () => NodeJS.Platform;
} = {
	bunSpawn,
	platform: () => process.platform,
};
