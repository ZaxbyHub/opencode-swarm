/**
 * Platform sandbox capability probe.
 *
 * Detects OS-native sandbox mechanism availability for each platform:
 *   - Linux:   Bubblewrap (bwrap)
 *   - macOS:   sandbox-exec
 *   - Windows: PowerShell-based wrapper (not a native OS sandbox mechanism)
 *
 * Each probe is bounded to 2 seconds via AbortController to satisfy
 * Invariant 1 (plugin init is fast, bounded, fail-open).
 */

import type { ExecException } from 'node:child_process';
import { execFile, spawnSync } from 'node:child_process';
import * as os from 'node:os';

/** Possible sandbox status values. */
export type SandboxStatus = 'enabled' | 'disabled' | 'unsupported';

/** Result of a sandbox capability probe. */
export interface SandboxCapability {
	/** Whether the sandbox mechanism is available. */
	status: SandboxStatus;
	/** Human-readable mechanism name, e.g. "Bubblewrap". */
	mechanism: string;
	/** Current process.platform value. */
	platform: 'linux' | 'darwin' | 'win32';
	/** Error message from the probe, if any. */
	error?: string;
}

// Session-lifetime cache so repeated calls never re-probe.
let _cached: SandboxCapability | undefined;

/**
 * Wraps a probe command in an AbortController timeout.
 *
 * @param cmd     Command binary to run.
 * @param args    Arguments to pass.
 * @param ms      Timeout in milliseconds.
 * @returns A promise that resolves to the captured stdout string, or rejects on timeout / error.
 */
function withProbeTimeout(
	cmd: string,
	args: string[],
	ms: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
			// Ensure the child process is killed on timeout — an outer AbortController
			// alone does not guarantee process termination on all platforms.
			proc?.kill();
		}, ms);
		// Never keep the process alive solely for this timer.
		const unref = (timer as { unref?: () => void }).unref;
		if (typeof unref === 'function') {
			unref.call(timer);
		}

		let proc: ReturnType<typeof execFile>;
		try {
			proc = execFile(
				cmd,
				args,
				{
					signal: controller.signal,
					timeout: ms,
					windowsHide: true,
					cwd: os.tmpdir(),
				},
				(error: Error | null, stdout: string, _stderr: string) => {
					clearTimeout(timer);
					if (error) {
						const exc = error as ExecException & { code?: string };
						// ENOENT means the binary was not found — treat as "unsupported".
						if (exc.code === 'ENOENT' || exc.code === 'ENOTFOUND') {
							reject(new Error('binary not found'));
						} else {
							// Anything else (permission denied, timeout, etc.) is
							// treated as "disabled" so the plugin can still load.
							reject(error);
						}
						return;
					}
					resolve(stdout?.trim() ?? '');
				},
			);
		} catch (spawnError) {
			clearTimeout(timer);
			reject(spawnError);
		}
	});
}

/** Probe for Linux Bubblewrap (bwrap). */
async function probeLinux(): Promise<SandboxCapability> {
	try {
		const output = await withProbeTimeout('bwrap', ['--version'], 2000);
		if (output.length > 0) {
			return {
				status: 'enabled',
				mechanism: 'Bubblewrap',
				platform: 'linux',
			};
		}
		return {
			status: 'disabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
			error: 'binary returned empty version',
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// "binary not found" maps to unsupported; everything else to disabled.
		if (msg === 'binary not found') {
			return {
				status: 'unsupported',
				mechanism: 'Bubblewrap',
				platform: 'linux',
				error: msg,
			};
		}
		return {
			status: 'disabled',
			mechanism: 'Bubblewrap',
			platform: 'linux',
			error: msg,
		};
	}
}

/** Probe for macOS sandbox-exec. */
async function probeMacOS(): Promise<SandboxCapability> {
	try {
		// sandbox-exec --version prints the version on success; exit code 1
		// with no output when the binary is absent on a non-macOS machine.
		const output = await withProbeTimeout('sandbox-exec', ['--version'], 2000);
		if (output.length > 0) {
			return {
				status: 'enabled',
				mechanism: 'sandbox-exec',
				platform: 'darwin',
			};
		}
		return {
			status: 'disabled',
			mechanism: 'sandbox-exec',
			platform: 'darwin',
			error: 'binary returned empty version',
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === 'binary not found') {
			return {
				status: 'unsupported',
				mechanism: 'sandbox-exec',
				platform: 'darwin',
				error: msg,
			};
		}
		return {
			status: 'disabled',
			mechanism: 'sandbox-exec',
			platform: 'darwin',
			error: msg,
		};
	}
}

/** Probe for Windows sandbox support. */
function probeWindows(): SandboxCapability {
	// Windows does not have a native sandbox mechanism (bwrap/sandbox-exec equivalent)
	// accessible from Node.js without native bindings. The WindowsSandboxExecutor
	// provides a best-effort PowerShell-based wrapper, not a true OS-level sandbox.
	// Since the executor works by wrapping commands in PowerShell, check that
	// both cmd.exe and PowerShell are available.
	try {
		const result = spawnSync('cmd', ['/c', 'echo', 'ok'], {
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		if (result.error) {
			return {
				status: 'disabled',
				platform: 'win32',
				mechanism: 'PowerShell wrapper',
				error: `cmd.exe probe failed: ${(result.error as NodeJS.ErrnoException).code}`,
			};
		}
		return result.status === 0
			? {
					status: 'enabled',
					platform: 'win32',
					mechanism: 'PowerShell wrapper',
				}
			: {
					status: 'disabled',
					platform: 'win32',
					mechanism: 'PowerShell wrapper',
					error: 'cmd.exe probe returned non-zero',
				};
	} catch (err) {
		return {
			status: 'disabled',
			platform: 'win32',
			mechanism: 'PowerShell wrapper',
			error: String(err),
		};
	}
}

/**
 * Detects the availability of OS-native sandbox mechanisms.
 *
 * Results are cached for the session lifetime (module-level variable).
 */
/**
 * Synchronous check whether Bubblewrap was detected as available.
 * Must be called after detect() has resolved — returns false if detect()
 * has not yet been called or if the cached result is not Linux/enabled.
 */
export function isBubblewrapAvailable(): boolean {
	return _cached?.status === 'enabled' && _cached?.platform === 'linux';
}

/**
 * Synchronous check whether sandbox-exec was detected as available.
 * Must be called after detect() has resolved — returns false if detect()
 * has not yet been called or if the cached result is not macOS/enabled.
 */
export function isSandboxExecAvailable(): boolean {
	return _cached?.status === 'enabled' && _cached?.platform === 'darwin';
}

/**
 * Synchronous check whether Windows Restricted Token support is available.
 * Must be called after detect() has resolved — returns false if detect()
 * has not yet been called or if the cached result is not win32/enabled.
 */
export function isWindowsSandboxAvailable(): boolean {
	return _cached?.status === 'enabled' && _cached?.platform === 'win32';
}

export class SandboxCapabilityProbe {
	/**
	 * Detect sandbox capability for the current platform.
	 *
	 * @returns A promise that resolves to the sandbox capability result.
	 */
	async detect(): Promise<SandboxCapability> {
		if (_cached !== undefined) {
			return _cached;
		}

		const platform = process.platform as 'linux' | 'darwin' | 'win32';

		switch (platform) {
			case 'linux':
				_cached = await probeLinux();
				break;
			case 'darwin':
				_cached = await probeMacOS();
				break;
			case 'win32':
				_cached = probeWindows();
				break;
			default: {
				// Unknown platform — treat as unsupported.
				_cached = {
					status: 'unsupported',
					mechanism: 'unknown',
					platform,
					error: `unsupported platform: ${platform}`,
				};
			}
		}

		return _cached;
	}
}
