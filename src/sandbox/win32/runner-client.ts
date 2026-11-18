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

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeDiagnosticText } from '../../scope/path-identity';
import { criticalWarn } from '../../utils/logger';

// Runtime-portable equivalent of __dirname: works from both the TypeScript source
// tree and the compiled ESM bundle in dist/, where Bun hardcodes the build-machine
// __dirname as a string literal (making it wrong on any other machine).
const _runtimeDir = fileURLToPath(new URL('.', import.meta.url));

/** Policy/probe protocol version this client speaks. */
export const RUNNER_PROTOCOL_SCHEMA_VERSION = 1;

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
		runner_version?: string;
		protocol_schema_version?: number;
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
export const RUNNER_EXIT_CODES = {
	SUCCESS: 0,
	CHILD_NON_ZERO: 1,
	POLICY_VIOLATION: 64,
	QUOTA_EXCEEDED: 65,
	WALL_CLOCK_TIMEOUT: 66,
	LAUNCHER_MISCONFIG: 67,
	OS_API_FAILURE: 68,
	PROBE_FAILED: 69,
} as const;

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
	/** Keys the runner must remove from the child environment (null overrides). */
	env_unsets: string[];
	path_stubs: string[];
	private_desktop: boolean;
	deny_alternate_data_streams: boolean;
	deny_unc_paths: boolean;
	deny_device_paths: boolean;
	deny_symlink_egress: boolean;
}

// Probe result cache (#3736 D7-rev2). A SUCCESSFUL probe (available=true) is
// cached for the process lifetime — a healthy runner is stable. Every
// unavailable/failed result (spawn error, nonzero exit, throw, binary not
// found, protocol mismatch, mode:'none', the not-win32 guard) is cached with
// a TTL: the next probe() call after the TTL re-runs findRunnerBinary() and
// the probe, so installing or replacing the runner binary is recoverable and
// a transient failure (EBUSY/EPERM/timeout) cannot pin the weak executor for
// the process lifetime. While genuinely broken the re-probe cadence is one
// bounded attempt (2s spawn budget) per TTL window — that cadence IS the
// recovery mechanism, and the #2475 downgrade warnings below fire at most
// once per failed attempt rather than once per process.
let _cachedProbe: RunnerProbeResult | undefined;
let _cachedProbeExpiresAt = Number.POSITIVE_INFINITY;

const RUNNER_PROBE_FAILURE_TTL_DEFAULT_MS = 60_000;

/**
 * #3736 D7-rev2: how long an unavailable/failed probe result stays cached
 * before the next probe() re-runs, mirroring executorFailureTtlMs() in
 * src/sandbox/executor.ts (#3716 pattern). Only finite positive values of
 * SWARM_SANDBOX_RUNNER_PROBE_FAILURE_TTL_MS are honored.
 */
export function runnerProbeFailureTtlMs(): number {
	const raw = Number(process.env.SWARM_SANDBOX_RUNNER_PROBE_FAILURE_TTL_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: RUNNER_PROBE_FAILURE_TTL_DEFAULT_MS;
}

function setCachedProbe(result: RunnerProbeResult): RunnerProbeResult {
	_cachedProbe = result;
	// #3736 D7-rev2: only a successful probe is permanent; every
	// unavailable/failed result expires after the TTL (see the cache comment
	// above).
	_cachedProbeExpiresAt = result.available
		? Number.POSITIVE_INFINITY
		: Date.now() + runnerProbeFailureTtlMs();
	return result;
}

/**
 * DI seam for testability. Exposes internal functions so tests can simulate
 * runner binary behavior without requiring the actual binary.
 */
export const _internals: {
	findRunnerBinary: () => string | null;
	spawnRunner: typeof spawnSync;
	spawnAsync: typeof spawn;
	runtimeDir: string | null;
} = {
	findRunnerBinary,
	spawnRunner: spawnSync,
	spawnAsync: spawn,
	runtimeDir: null,
};

/**
 * Locate the swarm-sandbox-runner binary.
 *
 * Search order:
 * 1. binaries/win32-<arch>/ next to the compiled dist bundle (published layout)
 * 2. binaries/win32-<arch>/ relative to the source tree (dev/test layout)
 * 3. PATH
 *
 * Issue #2475: the published plugin is a flat dist/index.js, so the package
 * root — and the binaries shipped inside it — is exactly ONE directory above
 * the runtime dir. The historical 3-up/4-up candidates only resolved from the
 * TypeScript source tree (src/sandbox/win32/ -> repo root); from dist they
 * pointed above the installed package and could never find the shipped exe.
 * (dist/cli consumers would need a 2-up candidate; nothing imports this module
 * from the CLI bundle today.)
 */
function findRunnerBinary(): string | null {
	const arch = process.arch === 'x64' ? 'x64' : 'arm64';
	const platform = 'win32';
	const runtimeDir = _internals.runtimeDir ?? _runtimeDir;

	const packagePaths = [
		path.resolve(
			runtimeDir,
			'..',
			'binaries',
			`${platform}-${arch}`,
			'swarm-sandbox-runner.exe',
		),
		path.resolve(
			runtimeDir,
			'..',
			'..',
			'..',
			'binaries',
			`${platform}-${arch}`,
			'swarm-sandbox-runner.exe',
		),
		path.resolve(
			runtimeDir,
			'..',
			'..',
			'..',
			'..',
			'binaries',
			`${platform}-${arch}`,
			'swarm-sandbox-runner.exe',
		),
	];

	for (const p of packagePaths) {
		try {
			if (fs.existsSync(p)) {
				return p;
			}
		} catch {
			// ignore
		}
	}

	// Check if available on PATH
	try {
		const result = spawnSync('where', ['swarm-sandbox-runner.exe'], {
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		if (result.status === 0 && result.stdout?.trim()) {
			return result.stdout.trim().split('\n')[0]?.trim() ?? null;
		}
	} catch {
		// not on PATH
	}

	return null;
}

/**
 * Probe the runner binary for capabilities.
 *
 * Bounded to 2s timeout per Invariant 1 (fast, bounded, fail-open).
 * Results are cached: a SUCCESSFUL probe for the process lifetime; a failed
 * probe until the runner-probe failure TTL elapses (#3736 D7-rev2), after
 * which the next call re-probes.
 */
export function probe(): RunnerProbeResult {
	if (_cachedProbe !== undefined && Date.now() < _cachedProbeExpiresAt) {
		return _cachedProbe;
	}

	if (process.platform !== 'win32') {
		return setCachedProbe({
			available: false,
			mode: 'none',
			capabilities: null,
			error: 'not Windows',
		});
	}

	const binary = _internals.findRunnerBinary();
	if (!binary) {
		const notFound = setCachedProbe({
			available: false,
			mode: 'none',
			capabilities: null,
			error: 'runner binary not found',
		});
		// Issue #2475: a security-relevant isolation downgrade must be visible
		// without OPENCODE_SWARM_DEBUG. #3736 D7: the failure is TTL-bounded
		// (the probe re-runs once per TTL window so an installed or replaced
		// binary is recoverable), so this emits at most once per TTL window
		// while the binary stays missing — the bounded cadence IS the
		// recovery mechanism.
		criticalWarn(
			'[sandbox] swarm-sandbox-runner binary not found — native Windows sandbox unavailable; commands fall back to the weak PowerShell wrapper (or run unsandboxed in advisory mode). Run /swarm diagnose for details.',
		);
		return notFound;
	}

	try {
		const result = _internals.spawnRunner(binary, ['--probe'], {
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'pipe'],
			cwd: os.tmpdir(),
		});

		if (result.error) {
			const failed = setCachedProbe({
				available: false,
				mode: 'none',
				capabilities: null,
				error: `probe spawn error: ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`,
			});
			criticalWarn(
				`[sandbox] swarm-sandbox-runner probe failed (${failed.error}) — degrading to weak sandbox. This covers wrong-arch and corrupt binaries; run /swarm diagnose for details.`,
			);
			return failed;
		}

		if (result.status !== 0) {
			const failed = setCachedProbe({
				available: false,
				mode: 'none',
				capabilities: null,
				error: `probe exited with code ${result.status}`,
			});
			criticalWarn(
				`[sandbox] swarm-sandbox-runner probe failed (${failed.error}) — degrading to weak sandbox. Run /swarm diagnose for details.`,
			);
			return failed;
		}

		const capabilities = JSON.parse(result.stdout?.trim() ?? '{}');

		// Protocol handshake (issue #2475): refuse binaries that do not report
		// the protocol version this client speaks. The runner ships in lockstep
		// with the plugin inside the same npm package, so a missing/mismatched
		// version means a stale or PATH-shadowed foreign binary. Fail closed.
		const reportedProtocol =
			typeof capabilities.protocol_schema_version === 'number'
				? capabilities.protocol_schema_version
				: null;
		if (reportedProtocol !== RUNNER_PROTOCOL_SCHEMA_VERSION) {
			const failed = setCachedProbe({
				available: false,
				mode: 'none',
				capabilities,
				error: `runner protocol mismatch (got ${reportedProtocol ?? 'none'}, expected ${RUNNER_PROTOCOL_SCHEMA_VERSION})`,
			});
			criticalWarn(
				`[sandbox] ${failed.error} at ${path.basename(binary)} — stale or foreign runner binary refused; degrading to weak sandbox. Run /swarm diagnose for details.`,
			);
			return failed;
		}

		let mode: 'app-container' | 'restricted-token' | 'none' = 'none';
		if (capabilities.app_container_available) {
			mode = 'app-container';
		} else if (capabilities.restricted_token_available) {
			mode = 'restricted-token';
		}

		return setCachedProbe({
			available: mode !== 'none',
			mode,
			capabilities,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const failed = setCachedProbe({
			available: false,
			mode: 'none',
			capabilities: null,
			error: `probe threw: ${msg}`,
		});
		criticalWarn(
			`[sandbox] swarm-sandbox-runner probe threw (${sanitizeDiagnosticText(msg, 200)}) — degrading to weak sandbox. Run /swarm diagnose for details.`,
		);
		return failed;
	}
}

/**
 * Execute a command inside the native sandbox.
 *
 * @param command - The command and arguments to run
 * @param policy  - Sandbox policy configuration
 * @param mode    - Sandbox mode (auto, app-container, restricted-token)
 * @returns Execution result with exit code, output, and events
 */
export async function execute(
	command: string[],
	policy: SandboxPolicy,
	mode: 'auto' | 'app-container' | 'restricted-token' = 'auto',
): Promise<RunnerExecuteResult> {
	const binary = _internals.findRunnerBinary();
	if (!binary) {
		throw new Error('runner binary not found');
	}

	const policyJson = JSON.stringify(policy);
	const args = ['--policy-stdin', '--mode', mode, '--', ...command];

	return new Promise((resolve, reject) => {
		let proc: ChildProcess | undefined;
		const timeout = setTimeout(() => {
			proc?.kill();
			reject(new Error('runner execution timeout'));
		}, policy.wall_clock_timeout_ms + 5000);

		const unref = (timeout as { unref?: () => void }).unref;
		if (typeof unref === 'function') {
			unref.call(timeout);
		}

		try {
			proc = _internals.spawnAsync(binary, args, {
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				cwd: policy.workspace_roots[0] ?? os.tmpdir(),
			});
		} catch (err) {
			clearTimeout(timeout);
			reject(err);
			return;
		}

		// Write policy to stdin
		proc.stdin?.write(policyJson);
		proc.stdin?.end();

		let stdout = '';
		let stderr = '';
		const events: RunnerEvent[] = [];

		proc.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		proc.stderr?.on('data', (chunk: Buffer) => {
			const lines = chunk.toString().split('\n');
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				// Try parsing as NDJSON event
				try {
					const event = JSON.parse(trimmed) as RunnerEvent;
					if (event.type) {
						events.push(event);
						continue;
					}
				} catch {
					// Not JSON — treat as plain stderr
				}
				stderr += `${trimmed}\n`;
			}
		});

		proc.on('error', (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		proc.on('close', (code) => {
			clearTimeout(timeout);

			const startEvent = events.find((e) => e.type === 'start');
			const runnerMode = startEvent?.mode ?? mode;

			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				events,
				mode: runnerMode,
			});
		});
	});
}

/**
 * Reset the cached probe result — useful for testing.
 * @internal
 */
export function _resetProbeCache(): void {
	_cachedProbe = undefined;
	_cachedProbeExpiresAt = Number.POSITIVE_INFINITY;
}

/**
 * Build a default sandbox policy for a given workspace.
 */
export function buildDefaultPolicy(
	workspaceRoot: string,
	runId?: string,
): SandboxPolicy {
	const id = runId ?? `swarm-${crypto.randomUUID?.() ?? Date.now()}`;
	const appData =
		process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
	const tempRoot = path.join(appData, 'opencode-swarm', 'sandbox', id, 'temp');

	return {
		schema_version: 1,
		run_id: id,
		workspace_roots: [workspaceRoot],
		writable_roots: [workspaceRoot],
		read_only_subpaths: ['.git', '.codex', '.agents', '.swarm'],
		temp_root: tempRoot,
		temp_cap_bytes: 524_288_000,
		memory_cap_bytes: 2_147_483_648,
		child_process_cap: 16,
		wall_clock_timeout_ms: 600_000,
		network_mode: 'off',
		env_allowlist: ['PATH', 'TEMP', 'TMP', 'USERPROFILE', 'SYSTEMROOT'],
		env_overrides: {
			HTTP_PROXY: 'http://127.0.0.1:1',
			HTTPS_PROXY: 'http://127.0.0.1:1',
		},
		env_unsets: [],
		path_stubs: ['ssh.exe', 'curl.exe', 'wget.exe', 'scp.exe', 'sftp.exe'],
		private_desktop: true,
		deny_alternate_data_streams: true,
		deny_unc_paths: true,
		deny_device_paths: true,
		deny_symlink_egress: true,
	};
}
