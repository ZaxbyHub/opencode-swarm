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

import type { ExecException, SpawnSyncReturns } from 'node:child_process';
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../utils/logger';
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
export type SandboxDimensionStrength = 'real' | 'weak' | 'none';

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

export interface SandboxCapabilityV1 extends SandboxCapability {
	v: 1;
	filesystem: SandboxDimensionStrength;
	network: SandboxDimensionStrength;
	process: SandboxDimensionStrength;
	effective: SandboxDimensionStrength;
	reasons: string[];
	identity: string;
}

export interface SandboxRequirements {
	mode?: 'advisory' | 'required';
	require_filesystem?: boolean;
	require_network?: boolean;
	require_process?: boolean;
	network_mode?: 'off' | 'on';
	network_allowlist?: readonly string[];
	writable_roots?: readonly string[];
}

export function assessSandboxRequirements(
	capability: SandboxCapabilityV1,
	requirements: SandboxRequirements | undefined,
): { satisfied: boolean; missing: string[] } {
	if (!requirements || requirements.mode !== 'required') {
		return { satisfied: true, missing: [] };
	}
	const missing: string[] = [];
	if (requirements.require_filesystem && capability.filesystem !== 'real') {
		missing.push('filesystem');
	}
	if (requirements.require_network && capability.network !== 'real') {
		missing.push('network');
	}
	if (requirements.require_process && capability.process !== 'real') {
		missing.push('process');
	}
	return { satisfied: missing.length === 0, missing };
}

// Session-lifetime cache so repeated calls never re-probe.
let _cached: SandboxCapabilityV1 | undefined;
let _cachedProbeSourceIdentity: string | undefined;

interface BehavioralEvidence {
	filesystem: SandboxDimensionStrength;
	network: SandboxDimensionStrength;
	process: SandboxDimensionStrength;
	reasons: string[];
}

function fileIdentity(input: string | null | undefined): string {
	if (!input) return 'missing';
	const candidate = path.normalize(input);
	try {
		const link = fs.lstatSync(candidate, { bigint: true });
		const stat = fs.statSync(candidate, { bigint: true });
		return [
			candidate,
			`l=${link.dev}:${link.ino}:${link.size}:${link.mtimeNs}`,
			`s=${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`,
		].join(':');
	} catch {
		return `${candidate}:missing`;
	}
}

function currentProbeSourceIdentity(
	platform: 'linux' | 'darwin' | 'win32',
): string {
	if (platform === 'linux') {
		return `linux:${fileIdentity(bwrapInternals.resolveBwrapBinary())}`;
	}
	if (platform === 'darwin') {
		return `darwin:${fileIdentity(macosExecutorInternals.resolveSandboxExecBinary())}:${fileIdentity(macosExecutorInternals.resolveProbeTargetBinary())}`;
	}
	if (platform === 'win32') {
		const cmdBinary = resolveWindowsCommandProcessorBinary();
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const {
				_internals: runnerClientInternals,
			} = require('./win32/runner-client');
			return `win32:${fileIdentity(runnerClientInternals.findRunnerBinary?.())}:${fileIdentity(cmdBinary)}`;
		} catch {
			return `win32:${fileIdentity(cmdBinary)}`;
		}
	}
	return `unknown:${platform}`;
}

function resolveWindowsCommandProcessorBinary(): string {
	const candidates: string[] = [];
	const comSpec = process.env.ComSpec?.trim();
	if (comSpec) {
		candidates.push(comSpec);
	}
	const pathEnv = process.env.Path ?? process.env.PATH ?? '';
	for (const entry of pathEnv.split(path.delimiter)) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		candidates.push(path.join(trimmed, 'cmd.exe'));
	}
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// Ignore missing/non-file candidates and continue the bounded search.
		}
	}
	return comSpec || 'cmd';
}

function cleanupProbeTempRoot(
	tempRoot: string,
	mechanism: string,
	reasons: string[],
): void {
	try {
		_internals.removeProbeTempRoot(tempRoot);
	} catch (error) {
		const code =
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			typeof (error as { code?: unknown }).code === 'string'
				? ((error as { code: string }).code ?? 'unknown')
				: 'unknown';
		reasons.push(`${mechanism} probe temp cleanup failed (${code})`);
		warn(
			`[sandbox] ${mechanism} probe temp cleanup failed (${code}); continuing with bounded probe result`,
		);
	}
}

function weakest(
	...dimensions: SandboxDimensionStrength[]
): SandboxDimensionStrength {
	return dimensions.includes('none')
		? 'none'
		: dimensions.includes('weak')
			? 'weak'
			: 'real';
}

function upgradeCapability(
	capability: SandboxCapability,
	evidence: BehavioralEvidence,
): SandboxCapabilityV1 {
	let filesystem: SandboxDimensionStrength = 'none';
	let network: SandboxDimensionStrength = 'none';
	let process: SandboxDimensionStrength = 'none';
	const reasons: string[] = [...evidence.reasons];
	if (capability.status === 'enabled' && capability.platform === 'linux') {
		filesystem = evidence.filesystem;
		network = evidence.network;
		process = evidence.process;
		if (reasons.length === 0) {
			reasons.push(
				'bubblewrap availability is evidenced, but denial behavior is not independently exercised here',
				'seccomp unsupported: no filter is installed',
			);
		}
	} else if (
		capability.status === 'enabled' &&
		capability.platform === 'darwin'
	) {
		filesystem = evidence.filesystem;
		network = evidence.network;
		process = evidence.process;
		if (reasons.length === 0) {
			reasons.push(
				'Seatbelt availability is evidenced, but denial behavior is not independently exercised here',
				'(allow default) leaves network, IPC, and process-spawn behavior outside the boundary',
			);
		}
	} else if (
		capability.status === 'enabled' &&
		capability.platform === 'win32'
	) {
		const mechanism = capability.mechanism.toLowerCase();
		const appContainer = mechanism.includes('app-container');
		const restrictedToken = mechanism.includes('restricted-token');
		filesystem =
			evidence.filesystem ||
			(appContainer || restrictedToken ? 'weak' : 'none');
		network = evidence.network || (appContainer ? 'weak' : 'none');
		process =
			evidence.process || (appContainer || restrictedToken ? 'weak' : 'none');
		reasons.push(
			appContainer
				? 'native AppContainer runner probe succeeded, but end-to-end denial behavior is not independently verified from this host'
				: restrictedToken
					? 'restricted-token runner probe succeeded, but it remains a conservative weak boundary until independently verified'
					: 'PowerShell fallback is defense in depth, not containment',
		);
	} else {
		reasons.push(capability.error ?? 'sandbox mechanism unavailable');
	}
	return {
		...capability,
		v: 1,
		filesystem,
		network,
		process,
		effective: weakest(filesystem, network, process),
		reasons,
		identity: `${capability.platform}:${capability.mechanism.toLowerCase()}:${capability.status}:${capability.strength ?? 'none'}:fs=${filesystem}:net=${network}:proc=${process}`,
	};
}

function withProbeIdentity(
	capability: SandboxCapabilityV1,
	probeSourceIdentity: string,
): SandboxCapabilityV1 {
	return {
		...capability,
		identity: `${capability.identity}:probe=${probeSourceIdentity}`,
	};
}

function runBoundedSync(
	cmd: string,
	args: string[],
	input?: string,
): SpawnSyncReturns<string> {
	return _internals.spawnSync(cmd, args, {
		windowsHide: true,
		encoding: 'utf-8',
		timeout: 2000,
		stdio: ['pipe', 'pipe', 'pipe'],
		input,
		cwd: os.tmpdir(),
	});
}

function probeLinuxBehavior(): BehavioralEvidence {
	const binary = bwrapInternals.resolveBwrapBinary();
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bwrap-probe-'));
	const allowedRoot = path.join(tempRoot, 'allowed');
	const inScopeFile = path.join(allowedRoot, 'inside.txt');
	const outOfScopeFile = path.join(tempRoot, 'outside.txt');
	fs.mkdirSync(allowedRoot, { recursive: true });
	const reasons: string[] = [];
	let filesystem: SandboxDimensionStrength = 'weak';
	let network: SandboxDimensionStrength = 'weak';
	try {
		const baseArgs = [
			'--unshare-user',
			'--unshare-net',
			'--unshare-ipc',
			'--die-with-parent',
			'--new-session',
			'--cap-drop',
			'ALL',
			'--bind',
			allowedRoot,
			allowedRoot,
			'--dev',
			'/dev',
			'--ro-bind',
			'/etc',
			'/etc',
			'--ro-bind',
			'/usr',
			'/usr',
			'--ro-bind',
			'/lib',
			'/lib',
			'--ro-bind',
			'/lib64',
			'/lib64',
			'--proc',
			'/proc',
			'--unshare-pid',
		];
		const inScope = runBoundedSync(
			binary,
			[...baseArgs, '--', '/usr/bin/tee', inScopeFile],
			'ok',
		);
		const outOfScope = runBoundedSync(
			binary,
			[...baseArgs, '--', '/usr/bin/tee', outOfScopeFile],
			'blocked',
		);
		if (
			inScope.status === 0 &&
			fs.existsSync(inScopeFile) &&
			outOfScope.status !== 0 &&
			!fs.existsSync(outOfScopeFile)
		) {
			filesystem = 'real';
			reasons.push(
				'bubblewrap allowed in-scope writes and blocked out-of-scope writes in a bounded probe',
			);
		} else {
			reasons.push(
				'bubblewrap denial behavior was not independently verified in a bounded probe',
			);
		}
		try {
			const hostNetNs = fs.readlinkSync('/proc/self/ns/net');
			const childNetNs = runBoundedSync(binary, [
				...baseArgs,
				'--',
				'/usr/bin/readlink',
				'/proc/self/ns/net',
			]);
			if (
				childNetNs.status === 0 &&
				childNetNs.stdout.trim() !== '' &&
				childNetNs.stdout.trim() !== hostNetNs.trim()
			) {
				network = 'real';
				reasons.push(
					'bubblewrap produced a distinct network namespace in a bounded probe',
				);
			} else {
				reasons.push(
					'bubblewrap network namespace isolation was not independently verified',
				);
			}
		} catch {
			reasons.push(
				'bubblewrap network namespace isolation was not independently verified',
			);
		}
	} finally {
		cleanupProbeTempRoot(tempRoot, 'bubblewrap', reasons);
	}
	return {
		filesystem,
		network,
		process: 'none',
		reasons,
	};
}

function probeMacOSBehavior(): BehavioralEvidence {
	const binary = macosExecutorInternals.resolveSandboxExecBinary();
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), 'swarm-seatbelt-probe-'),
	);
	const allowedRoot = path.join(tempRoot, 'allowed');
	const sandboxTemp = path.join(tempRoot, 'sandbox-tmp');
	const inScopeFile = path.join(allowedRoot, 'inside.txt');
	const outOfScopeFile = path.join(tempRoot, 'outside.txt');
	fs.mkdirSync(allowedRoot, { recursive: true });
	fs.mkdirSync(sandboxTemp, { recursive: true });
	const profile = macosExecutorInternals.buildSandboxProfile(
		[allowedRoot],
		sandboxTemp,
	);
	const reasons: string[] = [];
	let filesystem: SandboxDimensionStrength = 'weak';
	try {
		const inScope = runBoundedSync(
			binary,
			['-p', profile, '/usr/bin/tee', inScopeFile],
			'ok',
		);
		const outOfScope = runBoundedSync(
			binary,
			['-p', profile, '/usr/bin/tee', outOfScopeFile],
			'blocked',
		);
		if (
			inScope.status === 0 &&
			fs.existsSync(inScopeFile) &&
			outOfScope.status !== 0 &&
			!fs.existsSync(outOfScopeFile)
		) {
			filesystem = 'real';
			reasons.push(
				'sandbox-exec allowed in-scope writes and blocked out-of-scope writes in a bounded probe',
			);
		} else {
			reasons.push(
				'sandbox-exec denial behavior was not independently verified in a bounded probe',
			);
		}
	} finally {
		cleanupProbeTempRoot(tempRoot, 'sandbox-exec', reasons);
	}
	reasons.push(
		'(allow default) leaves network, IPC, and process-spawn behavior outside the boundary',
	);
	return {
		filesystem,
		network: 'none',
		process: 'none',
		reasons,
	};
}

function detectBehavioralEvidence(
	capability: SandboxCapability,
): BehavioralEvidence {
	if (capability.status !== 'enabled') {
		return {
			filesystem: 'none',
			network: 'none',
			process: 'none',
			reasons: [capability.error ?? 'sandbox mechanism unavailable'],
		};
	}
	if (capability.platform === 'linux') {
		return probeLinuxBehavior();
	}
	if (capability.platform === 'darwin') {
		return probeMacOSBehavior();
	}
	if (capability.platform === 'win32') {
		const mechanism = capability.mechanism.toLowerCase();
		const appContainer = mechanism.includes('app-container');
		const restrictedToken = mechanism.includes('restricted-token');
		return {
			filesystem: appContainer || restrictedToken ? 'weak' : 'none',
			network: appContainer ? 'weak' : 'none',
			process: appContainer || restrictedToken ? 'weak' : 'none',
			reasons: [],
		};
	}
	return {
		filesystem: 'none',
		network: 'none',
		process: 'none',
		reasons: [capability.error ?? 'sandbox mechanism unavailable'],
	};
}

/** Reset the session-lifetime capability cache. Test-only. */
export function _resetCapabilityCache(): void {
	_cached = undefined;
	_cachedProbeSourceIdentity = undefined;
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
export const _internals: {
	withProbeTimeout: typeof withProbeTimeout;
	spawnSync: typeof spawnSync;
	detectBehavioralEvidence: typeof detectBehavioralEvidence;
	resolveWindowsCommandProcessorBinary: typeof resolveWindowsCommandProcessorBinary;
	currentProbeSourceIdentity: typeof currentProbeSourceIdentity;
	removeProbeTempRoot: typeof fs.rmSync;
} = {
	withProbeTimeout,
	spawnSync,
	detectBehavioralEvidence,
	resolveWindowsCommandProcessorBinary,
	currentProbeSourceIdentity,
	removeProbeTempRoot: fs.rmSync,
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
		const cmdBinary = resolveWindowsCommandProcessorBinary();
		const result = _internals.spawnSync(cmdBinary, ['/c', 'echo', 'ok'], {
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
	async detect(): Promise<SandboxCapabilityV1> {
		const platform = process.platform as 'linux' | 'darwin' | 'win32';
		const probeSourceIdentity = currentProbeSourceIdentity(platform);
		if (
			_cached !== undefined &&
			_cachedProbeSourceIdentity === probeSourceIdentity
		) {
			return _cached;
		}
		let detected: SandboxCapability;

		switch (platform) {
			case 'linux':
				detected = await probeLinux();
				break;
			case 'darwin':
				detected = await probeMacOS();
				break;
			case 'win32':
				detected = probeWindows();
				break;
			default: {
				// Unknown platform — treat as unsupported.
				detected = {
					status: 'unsupported',
					mechanism: 'unknown',
					platform,
					error: `unsupported platform: ${platform}`,
				};
			}
		}

		_cached = withProbeIdentity(
			upgradeCapability(
				detected,
				_internals.detectBehavioralEvidence(detected),
			),
			probeSourceIdentity,
		);
		_cachedProbeSourceIdentity = probeSourceIdentity;
		return _cached;
	}
}
