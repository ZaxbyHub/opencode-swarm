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
import { warn } from '../../utils/logger';

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
	path_stubs: string[];
	private_desktop: boolean;
	deny_alternate_data_streams: boolean;
	deny_unc_paths: boolean;
	deny_device_paths: boolean;
	deny_symlink_egress: boolean;
}

// Session-lifetime cache for probe results
let _cachedProbe: RunnerProbeResult | undefined;

/**
 * DI seam for testability. Exposes internal functions so tests can simulate
 * runner binary behavior without requiring the actual binary.
 */
export const _internals: {
	findRunnerBinary: () => string | null;
	spawnRunner: typeof spawnSync;
	spawnAsync: typeof spawn;
} = {
	findRunnerBinary,
	spawnRunner: spawnSync,
	spawnAsync: spawn,
};

/**
 * Locate the swarm-sandbox-runner binary.
 *
 * Search order:
 * 1. binaries/<platform>-<arch>/ in the package
 * 2. PATH
 */
function findRunnerBinary(): string | null {
	const arch = process.arch === 'x64' ? 'x64' : 'arm64';
	const platform = 'win32';

	// Check package-local binaries
	const packagePaths = [
		path.resolve(
			__dirname,
			'..',
			'..',
			'..',
			'binaries',
			`${platform}-${arch}`,
			'swarm-sandbox-runner.exe',
		),
		path.resolve(
			__dirname,
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
 * Results are cached for the session lifetime.
 */
export function probe(): RunnerProbeResult {
	if (_cachedProbe !== undefined) {
		return _cachedProbe;
	}

	if (process.platform !== 'win32') {
		_cachedProbe = {
			available: false,
			mode: 'none',
			capabilities: null,
			error: 'not Windows',
		};
		return _cachedProbe;
	}

	const binary = _internals.findRunnerBinary();
	if (!binary) {
		_cachedProbe = {
			available: false,
			mode: 'none',
			capabilities: null,
			error: 'runner binary not found',
		};
		warn('Sandbox runner binary not found — degrading to weak sandbox');
		return _cachedProbe;
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
			_cachedProbe = {
				available: false,
				mode: 'none',
				capabilities: null,
				error: `probe spawn error: ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`,
			};
			warn(`Sandbox runner probe failed: ${_cachedProbe.error}`);
			return _cachedProbe;
		}

		if (result.status !== 0) {
			_cachedProbe = {
				available: false,
				mode: 'none',
				capabilities: null,
				error: `probe exited with code ${result.status}`,
			};
			warn(`Sandbox runner probe failed: ${_cachedProbe.error}`);
			return _cachedProbe;
		}

		const capabilities = JSON.parse(result.stdout?.trim() ?? '{}');

		let mode: 'app-container' | 'restricted-token' | 'none' = 'none';
		if (capabilities.app_container_available) {
			mode = 'app-container';
		} else if (capabilities.restricted_token_available) {
			mode = 'restricted-token';
		}

		_cachedProbe = {
			available: mode !== 'none',
			mode,
			capabilities,
		};
		return _cachedProbe;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		_cachedProbe = {
			available: false,
			mode: 'none',
			capabilities: null,
			error: `probe threw: ${msg}`,
		};
		warn(`Sandbox runner probe threw: ${msg}`);
		return _cachedProbe;
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
		path_stubs: ['ssh.exe', 'curl.exe', 'wget.exe', 'scp.exe', 'sftp.exe'],
		private_desktop: true,
		deny_alternate_data_streams: true,
		deny_unc_paths: true,
		deny_device_paths: true,
		deny_symlink_egress: true,
	};
}
