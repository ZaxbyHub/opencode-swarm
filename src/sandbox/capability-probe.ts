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
import { _internals as bwrapInternals } from './linux/bubblewrap-executor';
import { _internals as macosExecutorInternals } from './macos/sandbox-exec-executor';

/** Possible sandbox status values. */
export type SandboxStatus = 'enabled' | 'disabled' | 'unsupported';

/**
 * Enforcement strength of an available sandbox mechanism.
 * - `strong`: real kernel-level enforcement (bubblewrap, sandbox-exec, the
 *   Windows native runner).
 * - `advisory`: best-effort, non-kernel restriction (the Windows PowerShell
 *   environment-scrub fallback). Must NEVER be reported as real containment
 *   (issue #1778 H2).
 */
export type SandboxStrength = 'strong' | 'advisory';

/** Result of a sandbox capability probe. */
export interface SandboxCapability {
	/** Whether the sandbox mechanism is available. */
	status: SandboxStatus;
	/**
	 * Enforcement strength when `status === 'enabled'`. Absent for
	 * disabled/unsupported results.
	 */
	strength?: SandboxStrength;
	/** Human-readable mechanism name, e.g. "Bubblewrap". */
	mechanism: string;
	/** Current process.platform value. */
	platform: 'linux' | 'darwin' | 'win32';
	/** Error message from the probe, if any. */
	error?: string;
}

// Session-lifetime cache so repeated calls never re-probe.
let _cached: SandboxCapability | undefined;

/** Reset the session-lifetime capability cache. Test-only. */
export function _resetCapabilityCache(): void {
	_cached = undefined;
}

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

/**
 * DI seam for testability. Exposes withProbeTimeout so tests can simulate
 * exit-0/exit-nonzero/ENOENT probe outcomes for every platform's probe
 * (including darwin) without requiring the real binary on the host running
 * the tests. See src/sandbox/macos/sandbox-exec-executor.ts's _internals for
 * the sibling sync-probe seam.
 */
export const _internals: { withProbeTimeout: typeof withProbeTimeout } = {
	withProbeTimeout,
} as const;

/** Probe for Linux Bubblewrap (bwrap). */
async function probeLinux(): Promise<SandboxCapability> {
	try {
		// F6 (#2236): resolve to the base-OS absolute path when present (same
		// class of fix as the macOS probe below), falling back to the bare
		// name. bwrap's --version flag IS valid, so the invocation and
		// success criterion (non-empty stdout) are unchanged.
		const binary = bwrapInternals.resolveBwrapBinary();
		const output = await _internals.withProbeTimeout(
			binary,
			['--version'],
			2000,
		);
		if (output.length > 0) {
			return {
				status: 'enabled',
				strength: 'strong',
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
		// F6 (issue #2236 RC2): sandbox-exec(8) has NO `--version` flag — its
		// synopsis is `sandbox-exec [-f file | -n name | -p string] [-D k=v]
		// command [args...]` (BSD getopt, short options only). The previous
		// probe here invoked `sandbox-exec --version` and required non-empty
		// STDOUT, which is wrong on two independent counts: `--version` is
		// consumed as an invalid option and fails on EVERY macOS host
		// regardless of whether Seatbelt works, AND even a correct
		// invocation of a real command (e.g. `/usr/bin/true`) legitimately
		// produces empty stdout on success — the sibling sync probe in
		// sandbox-exec-executor.ts previously used the opposite (exit-code)
		// criterion, so the two probes disagreed. Both are now reconciled
		// onto exit code ONLY: execFile's callback receives a non-null
		// `error` for any non-zero exit or spawn failure, so a RESOLVED
		// withProbeTimeout promise already IS the exit-0 signal — stdout
		// content is irrelevant here and stderr (macOS prints a deprecation
		// notice on every invocation) is never consulted.
		//
		// The probe profile is built by the SAME buildProbeProfile the sync
		// probe uses (F6a item 2) — sharing one builder is what keeps the
		// two probes from drifting into contradictory criteria again, which
		// is exactly how this defect happened the first time.
		const binary = macosExecutorInternals.resolveSandboxExecBinary();
		const target = macosExecutorInternals.resolveProbeTargetBinary();
		const profile = macosExecutorInternals.buildProbeProfile(os.tmpdir());
		await _internals.withProbeTimeout(binary, ['-p', profile, target], 2000);
		return {
			status: 'enabled',
			strength: 'strong',
			mechanism: 'sandbox-exec',
			platform: 'darwin',
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
	// First, try the native runner binary for true OS-level sandboxing.
	// If unavailable, fall back to the PowerShell-based wrapper.
	try {
		const { probe: runnerProbe } = require('./win32/runner-client');
		const result = runnerProbe();
		if (result.available) {
			return {
				status: 'enabled',
				strength: 'strong',
				platform: 'win32',
				mechanism: `native-runner/${result.mode}`,
			};
		}
	} catch {
		// Runner client not available — fall through to PowerShell check
	}

	// Fallback: check that cmd.exe and PowerShell are available for the
	// environment-restriction executor (weak sandbox).
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
					// The native runner was absent (we fell through to here), so this
					// is the env-scrub PowerShell wrapper — advisory, NOT kernel
					// enforcement. Never surface it as real containment (#1778 H2).
					strength: 'advisory',
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
