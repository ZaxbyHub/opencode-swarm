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
import {
	BWRAP_NAMESPACE_SMOKE_ARGS,
	_internals as bwrapInternals,
} from './linux/bubblewrap-executor';
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
	/**
	 * #3893 AC12: probe-stage failure markers carried alongside `error` so a
	 * transient spawn/setup failure stays classifiable after the capability is
	 * upgraded to V1 (the marker strings feed hasProbeSetupFailureReason).
	 */
	reasons?: string[];
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

// Session-lifetime cache so repeated calls never re-probe — EXCEPT a degraded
// win32 PowerShell-fallback memo (#3743): a transient runner-probe failure
// (EBUSY/EPERM) degrades the capability to the advisory wrapper while the
// binary identity is unchanged, and without a time axis that memo would pin
// the weak answer for the process lifetime — leaving policy assessment and
// /swarm diagnose stale, and tripping the executor-mechanism-drift hard block
// in tool-before.ts after the executor's own TTL recovery. Such memos expire
// after CAPABILITY_FAILURE_TTL_MS and force a fresh probe; every other result
// (including strong native-runner answers and disabled results) keeps the
// permanent, identity-keyed memoization.
let _cached: SandboxCapabilityV1 | undefined;
let _cachedProbeSourceIdentity: string | undefined;
// 0 = the current memo does not expire (undefined semantics are impossible to
// distinguish from "never written" for the reset path, so a sentinel it is).
let _cachedExpiresAt = 0;

/**
 * #3743: default TTL for the degraded win32 PowerShell-fallback capability
 * memo (mirrors the executor/runner-probe failure TTLs at 60 s). Test-only
 * knob; production leaves it unset.
 */
const CAPABILITY_FAILURE_TTL_DEFAULT_MS = 60_000;

function capabilityFailureTtlMs(): number {
	const raw = Number(process.env.SWARM_SANDBOX_CAPABILITY_FAILURE_TTL_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: CAPABILITY_FAILURE_TTL_DEFAULT_MS;
}

/**
 * #3743: a result is the degraded win32 fallback iff it is an enabled win32
 * capability whose mechanism is the PowerShell wrapper (not the native
 * app-container/restricted-token runner). Only this class is TTL-bounded: a
 * strong result cannot come from a transient failure, and a disabled result
 * is governed by binary-identity invalidation, not transient recovery.
 */
function isDegradedWin32Fallback(result: SandboxCapabilityV1): boolean {
	if (result.platform !== 'win32' || result.status !== 'enabled') return false;
	const mechanism = result.mechanism.toLowerCase();
	return (
		!mechanism.includes('app-container') &&
		!mechanism.includes('restricted-token')
	);
}

// F-001 (PR #3718 review): a transient setup-failure observation is never
// memoized as the authoritative result (see detect()), but it must remain
// visible to the synchronous accessors — an ENABLED binary-stage capability
// has to keep executor availability intact while the behavioral evidence
// re-probes. Storing it in `_cached` instead would reintroduce #3661 item 5
// (a transient failure masking healthy probes); not storing it at all let
// getExecutor() resolve and cache a NULL executor from an enabled capability
// (advisory-mode shell commands then ran unsandboxed for the process
// lifetime — the regression this closes). Accessor precedence (pinned by the
// PR #3718 Stage-B battery legs L4/L5): each slot is consulted only when it
// was recorded for the CURRENT probe-source identity, memoized result first,
// transient second — a plain `_cached ?? _cachedTransient` was rejected by
// the reviewer's counterexample (a healthy DISABLED memo from a previous
// binary identity would mask a fresh enabled transient re-probe and
// re-introduce the null-executor class). Reads made outside the documented
// post-detect() pattern therefore fail closed on a stale identity; the
// executor creators always detect() first, so their visibility is always
// the current probe's answer.
let _cachedTransient: SandboxCapabilityV1 | undefined;
let _cachedTransientProbeSourceIdentity: string | undefined;

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

/** Bounded errno-style code of a thrown value ('unknown' when absent). */
function errorCode(error: unknown): string {
	return typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof (error as { code?: unknown }).code === 'string'
		? ((error as { code: string }).code ?? 'unknown')
		: 'unknown';
}

function cleanupProbeTempRoot(
	tempRoot: string,
	mechanism: string,
	reasons: string[],
): void {
	try {
		_internals.removeProbeTempRoot(tempRoot, { recursive: true, force: true });
	} catch (error) {
		const code = errorCode(error);
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
	const reasons: string[] = [];
	let filesystem: SandboxDimensionStrength = 'weak';
	let network: SandboxDimensionStrength = 'weak';
	// #3332: the whole setup phase (temp root creation through the bounded
	// spawns) lives inside the guarded region — a setup failure (mkdtemp
	// ENOSPC/EACCES, mkdir EACCES, …) returns a bounded weak probe result and
	// cleans up whatever it created instead of escaping unhandled and leaking
	// the temp root. tempRoot stays undefined when mkdtempSync itself fails,
	// so no cleanup is attempted for a root that was never created.
	let tempRoot: string | undefined;
	try {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bwrap-probe-'));
		const allowedRoot = path.join(tempRoot, 'allowed');
		const inScopeFile = path.join(allowedRoot, 'inside.txt');
		const outOfScopeFile = path.join(tempRoot, 'outside.txt');
		fs.mkdirSync(allowedRoot, { recursive: true });
		// #3332: /lib64 exists on multilib hosts only (usr-merged and
		// non-multilib images lack it); bwrap aborts the invocation when a
		// bind source is missing, so consult the host per probe run.
		const lib64BindArgs = fs.existsSync('/lib64')
			? ['--ro-bind', '/lib64', '/lib64']
			: [];
		const baseArgs = [
			'--unshare-user',
			'--unshare-net',
			'--unshare-ipc',
			'--die-with-parent',
			'--new-session',
			'--cap-drop',
			'ALL',
			'--ro-bind',
			tempRoot,
			tempRoot,
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
			...lib64BindArgs,
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
	} catch (error) {
		// Bounded probe result on a setup failure (#3332): never propagate.
		const code = errorCode(error);
		reasons.push(`bubblewrap probe temp setup failed (${code})`);
	} finally {
		if (tempRoot !== undefined) {
			cleanupProbeTempRoot(tempRoot, 'bubblewrap', reasons);
		}
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
	const reasons: string[] = [];
	let filesystem: SandboxDimensionStrength = 'weak';
	// #3332: setup failures return a bounded probe result (never an unhandled
	// throw), and the temp root is cleaned only when it was created.
	let tempRoot: string | undefined;
	try {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-seatbelt-probe-'));
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
		reasons.push(
			'(allow default) leaves network, IPC, and process-spawn behavior outside the boundary',
		);
	} catch (error) {
		// Bounded probe result on a setup failure (#3332): never propagate.
		const code = errorCode(error);
		reasons.push(`sandbox-exec probe temp setup failed (${code})`);
	} finally {
		if (tempRoot !== undefined) {
			cleanupProbeTempRoot(tempRoot, 'sandbox-exec', reasons);
		}
	}
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
			// #3893 AC12: probe-stage failure markers (e.g. the win32
			// 'probe spawn failed: …' reason) ride ahead of the plain error so
			// they survive the V1 upgrade and stay classifiable as transient.
			reasons: [
				...(capability.reasons ?? []),
				capability.error ?? 'sandbox mechanism unavailable',
			],
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
	_cachedTransient = undefined;
	_cachedTransientProbeSourceIdentity = undefined;
	_cachedExpiresAt = 0;
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
/**
 * Platform binary-stage probe seam (F-001, PR #3718 review feedback round):
 * detect() obtains the binary-stage capability through this indirection so
 * tests can pin the enabled-capability-with-transient-behavioral-failure
 * shape deterministically on any host. The default is the original switch —
 * identical dispatch, no behavior change in production.
 */
async function probePlatform(
	platform: 'linux' | 'darwin' | 'win32',
): Promise<SandboxCapability> {
	switch (platform) {
		case 'linux':
			return probeLinux();
		case 'darwin':
			return probeMacOS();
		case 'win32':
			return probeWindows();
		default: {
			// Unknown platform — treat as unsupported.
			return {
				status: 'unsupported',
				mechanism: 'unknown',
				platform,
				error: `unsupported platform: ${platform}`,
			};
		}
	}
}

export const _internals: {
	withProbeTimeout: typeof withProbeTimeout;
	spawnSync: typeof spawnSync;
	detectBehavioralEvidence: typeof detectBehavioralEvidence;
	resolveWindowsCommandProcessorBinary: typeof resolveWindowsCommandProcessorBinary;
	currentProbeSourceIdentity: typeof currentProbeSourceIdentity;
	probePlatform: typeof probePlatform;
	removeProbeTempRoot: (target: fs.PathLike, options?: fs.RmOptions) => void;
} = {
	withProbeTimeout,
	spawnSync,
	detectBehavioralEvidence,
	resolveWindowsCommandProcessorBinary,
	currentProbeSourceIdentity,
	probePlatform,
	removeProbeTempRoot: (target: fs.PathLike, options?: fs.RmOptions) =>
		fs.rmSync(target, { recursive: true, force: true, ...options }),
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
			// `--version` alone does not prove a sandbox can be created (e.g.
			// Ubuntu 24.04+ restricts unprivileged user namespaces): run the
			// smallest real one before reporting a strong sandbox.
			try {
				await _internals.withProbeTimeout(
					binary,
					[...BWRAP_NAMESPACE_SMOKE_ARGS],
					2000,
				);
			} catch (smokeError) {
				const detail =
					smokeError instanceof Error ? smokeError.message : String(smokeError);
				return {
					status: 'disabled',
					mechanism: 'Bubblewrap',
					platform: 'linux',
					error: `bwrap cannot create a sandbox on this host (unprivileged user namespaces may be restricted): ${detail}`,
				};
			}
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
			const spawnErrorCode = (result.error as NodeJS.ErrnoException).code;
			return {
				status: 'disabled',
				platform: 'win32',
				mechanism: 'PowerShell wrapper',
				error: `cmd.exe probe failed: ${spawnErrorCode}`,
				// #3893 AC12: a spawn error (EPERM/EACCES/EBUSY, …) is a
				// TRANSIENT environment condition, not a permanent verdict —
				// carry the marker so the upgraded capability is classified as
				// a setup failure and detect() re-probes instead of memoizing
				// the disabled answer for the process lifetime.
				reasons: [`probe spawn failed: ${spawnErrorCode}`],
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
 * The capability the synchronous accessors answer from (F-001, PR #3718
 * review): each slot is consulted only when it was recorded for the CURRENT
 * probe-source identity — the memoized authoritative result first, the
 * transient setup-failure observation second. A plain memoized-outranks-
 * transient preference (no identity gate) was rejected by the Stage-B
 * reviewer's counterexample: a healthy DISABLED memo from a previous
 * probe-source identity would mask a fresh ENABLED transient re-probe after
 * a binary change, restoring the null-executor class this closes. The
 * identity gates are pinned by battery legs L4/L5
 * (tests/unit/sandbox/capability-probe-transient-executor-3661.test.ts);
 * reads made outside the documented post-detect() pattern fail closed on a
 * stale identity, and the executor creators always detect() first, so their
 * visibility is always the current probe's answer. This is deliberately NOT
 * what detect() returns from cache: only `_cached` short-circuits detect(),
 * so a transient observation is always re-probed by the next detect() call
 * (#3661 item 5).
 */
function syncVisibleCapability(
	platform: 'linux' | 'darwin' | 'win32',
): SandboxCapabilityV1 | undefined {
	const probeSourceIdentity = _internals.currentProbeSourceIdentity(platform);
	if (
		_cached !== undefined &&
		_cachedProbeSourceIdentity === probeSourceIdentity &&
		// SP-001: honour the degraded-fallback TTL so an expired enabled memo
		// is not served as the authoritative answer between detect() calls.
		(_cachedExpiresAt === 0 || Date.now() < _cachedExpiresAt)
	) {
		return _cached;
	}
	if (
		_cachedTransient !== undefined &&
		_cachedTransientProbeSourceIdentity === probeSourceIdentity
	) {
		return _cachedTransient;
	}
	return undefined;
}

/**
 * Synchronous check whether Bubblewrap was detected as available.
 * Must be called after detect() has resolved — returns false if detect()
 * has not yet been called or if the visible result is not Linux/enabled.
 */
export function isBubblewrapAvailable(): boolean {
	const capability = syncVisibleCapability('linux');
	return capability?.status === 'enabled' && capability?.platform === 'linux';
}

/**
 * Synchronous check whether sandbox-exec was detected as available.
 * Must be called after detect() has resolved — returns false if detect()
 * has not yet been called or if the visible result is not macOS/enabled.
 */
export function isSandboxExecAvailable(): boolean {
	const capability = syncVisibleCapability('darwin');
	return capability?.status === 'enabled' && capability?.platform === 'darwin';
}

/**
 * Synchronous check whether Windows Restricted Token support is available.
 * Must be called after detect() has resolved — returns false if detect()
 * has not yet been called or if the visible result is not win32/enabled.
 */
export function isWindowsSandboxAvailable(): boolean {
	const capability = syncVisibleCapability('win32');
	return capability?.status === 'enabled' && capability?.platform === 'win32';
}

export class SandboxCapabilityProbe {
	/**
	 * Detect sandbox capability for the current platform.
	 *
	 * @returns A promise that resolves to the sandbox capability result.
	 */
	async detect(): Promise<SandboxCapabilityV1> {
		const platform = process.platform as 'linux' | 'darwin' | 'win32';
		const probeSourceIdentity = _internals.currentProbeSourceIdentity(platform);
		if (
			_cached !== undefined &&
			_cachedProbeSourceIdentity === probeSourceIdentity &&
			// #3743: an expired degraded-fallback memo must not be served — fall
			// through to a fresh probe so a recovered environment is re-derived
			// within a bounded interval (the identity is NOT stamped with an
			// epoch: a genuine recovery changes mechanism/strength, which the
			// identity already embeds, and an unchanged degraded re-derivation
			// keeps a stable identity for strict Full-Auto correlation).
			(_cachedExpiresAt === 0 || Date.now() < _cachedExpiresAt)
		) {
			return _cached;
		}
		const detected = await _internals.probePlatform(platform);

		const result = withProbeIdentity(
			upgradeCapability(
				detected,
				_internals.detectBehavioralEvidence(detected),
			),
			probeSourceIdentity,
		);
		// A setup-failure result is transient evidence (temp-dir creation or
		// probe-environment failure, #3661 item 5): never memoize it as the
		// authoritative result, or a later healthy probe is masked for the
		// process lifetime. The binary-identity guard above stays the only
		// healthy-result cache invalidation axis; the local result is always
		// returned. F-001 (PR #3718 review): the transient observation is
		// parked in the accessor-visible slot so an enabled binary-stage
		// capability keeps executor availability — dropping it entirely
		// memoized a null executor from an ENABLED capability, silently
		// un-sandboxing advisory-mode shell commands.
		if (!hasProbeSetupFailureReason(result)) {
			_cached = result;
			_cachedProbeSourceIdentity = probeSourceIdentity;
			// #3743: only the degraded win32 fallback expires; every other
			// memoized result clears the expiry slot so a recovered strong
			// answer (or a disabled answer) memoizes permanently — an inherited
			// expired timestamp would force endless re-probing.
			_cachedExpiresAt = isDegradedWin32Fallback(result)
				? Date.now() + capabilityFailureTtlMs()
				: 0;
			// Hygiene, not a separately pinned behavior: the identity-gated
			// accessor precedence (syncVisibleCapability) already prefers the
			// current-identity memo; dropping the transient here keeps the
			// invariant that at most one accessor-visible slot carries state.
			_cachedTransient = undefined;
			_cachedTransientProbeSourceIdentity = undefined;
		} else {
			_cachedTransient = result;
			_cachedTransientProbeSourceIdentity = probeSourceIdentity;
		}
		return result;
	}
}

/**
 * True when a capability carries a transient probe-failure reason. The linux
 * bwrap arm (`bubblewrap probe temp setup failed (…)`) and the darwin
 * sandbox-exec arm (`sandbox-exec probe temp setup failed (…)`) share the
 * temp-setup marker core; the win32 cmd.exe arm carries
 * `probe spawn failed: <code>` (#3893 AC12 — a spawn EPERM/EACCES/EBUSY is a
 * transient environment condition, so the disabled answer must take the
 * transient slot and let detect() re-probe instead of pinning a permanent
 * memo). Behavioral evidence passes reasons through upgradeCapability, so the
 * check runs on the final capability.
 */
function hasProbeSetupFailureReason(capability: SandboxCapabilityV1): boolean {
	const reasons: unknown = (capability as { reasons?: unknown }).reasons;
	if (!Array.isArray(reasons)) return false;
	return reasons.some(
		(reason) =>
			typeof reason === 'string' &&
			(reason.includes('probe temp setup failed') ||
				reason.includes('probe spawn failed')),
	);
}
