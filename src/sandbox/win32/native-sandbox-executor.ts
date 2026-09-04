/**
 * Windows native sandbox executor.
 *
 * Prefers the native swarm-sandbox-runner binary for true OS-level isolation
 * (AppContainer or restricted token). Falls back to the PowerShell-based
 * environment executor when the runner binary is unavailable.
 *
 * The public API matches SandboxExecutor, but wrapCommand is not the primary
 * execution path when the native runner is available — execute() provides
 * the full sandbox lifecycle with NDJSON events.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeDiagnosticText } from '../../scope/path-identity';
import { criticalWarn } from '../../utils/logger';
import type { SandboxExecutor } from '../executor';
import { isValidEnvKey, SandboxError } from '../executor';
import { WindowsSandboxExecutor as EnvironmentExecutor } from './restricted-environment-executor';
import {
	buildDefaultPolicy,
	type RunnerExecuteResult,
	type RunnerProbeResult,
	execute as runnerExecute,
	_internals as runnerInternals,
	probe as runnerProbe,
} from './runner-client';

export type SandboxStrength = 'strong' | 'weak' | 'none';

/**
 * Native Windows sandbox executor with runner-first, PowerShell-fallback strategy.
 */
export class NativeWindowsSandboxExecutor implements SandboxExecutor {
	public readonly mechanism: string;

	private readonly _probeResult: RunnerProbeResult;
	private readonly _fallbackExecutor: EnvironmentExecutor;
	private readonly _strength: SandboxStrength;
	private _disabled: boolean;
	private _disabledReason: string | null;

	constructor(scopePaths: string[] = [], tempDir?: string) {
		this._disabled = false;
		this._disabledReason = null;
		this._fallbackExecutor = new EnvironmentExecutor(scopePaths, tempDir);

		this._probeResult = runnerProbe();

		if (this._probeResult.available) {
			this._strength = 'strong';
			this.mechanism = `native-runner/${this._probeResult.mode}`;
		} else if (this._fallbackExecutor.isAvailable()) {
			this._strength = 'weak';
			this.mechanism = 'powershell-wrapper';
			// Issue #2475: a strong -> weak isolation downgrade must be visible
			// without OPENCODE_SWARM_DEBUG (the executor is constructed once per
			// session, so this emits at most once).
			criticalWarn(
				`[sandbox] native Windows sandbox runner unavailable (${this._probeResult.error ?? 'unknown'}); falling back to PowerShell environment restrictions (weak sandbox). Run /swarm diagnose for details.`,
			);
		} else {
			this._strength = 'none';
			this.mechanism = 'none';
		}
	}

	/** Sandbox strength: 'strong' (native runner), 'weak' (PowerShell), 'none'. */
	get strength(): SandboxStrength {
		if (this._disabled) return 'none';
		return this._strength;
	}

	isAvailable(): boolean {
		return !this._disabled && this._strength !== 'none';
	}

	disable(reason: string): void {
		this._disabled = true;
		this._disabledReason = reason;
		criticalWarn(
			`[sandbox] Sandbox disabled: ${sanitizeDiagnosticText(reason, 200)}. Falling through to tool-layer enforcement. Run /swarm diagnose for details.`,
		);
	}

	/**
	 * Wrap a command for execution.
	 *
	 * When the native runner is available, generates a command that pipes
	 * the policy JSON to the runner binary via a temp file. This keeps the
	 * existing guardrails flow (modify args.command → shell executes) while
	 * providing real OS-level sandboxing.
	 *
	 * When the runner is unavailable, falls back to the PowerShell wrapper.
	 */
	wrapCommand(
		command: string,
		scopePaths: string[],
		tempDir?: string,
		envOverrides?: Record<string, string | null>,
		policy?: {
			network_mode?: 'off' | 'on';
			network_allowlist?: readonly string[];
			writable_roots?: readonly string[];
		},
	): string {
		if (!this.isAvailable()) {
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		if (this._strength === 'strong') {
			// Fail closed for cmd metacharacters (PR review PRR-003): the native
			// path transports the command as a raw cmd /c string, so &, |, <,
			// > or " in the command could split the wrapper line and execute a
			// suffix OUTSIDE the runner's AppContainer/restricted-token while
			// the audit records wrapped: true. Route metacharacter-bearing
			// commands through the PowerShell wrapper, which transports the
			// command as opaque Base64 — still fully wrapped (env-restricted),
			// never unsandboxed. Simple single commands keep full strong
			// confinement; carrying the command inside the policy JSON is the
			// follow-up transport change that restores it for compounds.
			if (/["&|<>]/.test(command)) {
				return this._fallbackExecutor.wrapCommand(
					command,
					scopePaths,
					tempDir,
					envOverrides,
				);
			}
			return this._wrapWithRunner(
				command,
				scopePaths,
				tempDir,
				envOverrides,
				policy,
			);
		}

		return this._fallbackExecutor.wrapCommand(
			command,
			scopePaths,
			tempDir,
			envOverrides,
		);
	}

	private _wrapWithRunner(
		command: string,
		scopePaths: string[],
		tempDir?: string,
		_envOverrides?: Record<string, string | null>,
		policyOverride?: {
			network_mode?: 'off' | 'on';
			network_allowlist?: readonly string[];
			writable_roots?: readonly string[];
		},
	): string {
		const binary = runnerInternals.findRunnerBinary();
		if (!binary) {
			throw new SandboxError('Runner binary not found', 'RUNNER_NOT_FOUND');
		}

		const workspaceRoot = scopePaths[0] ?? process.cwd();
		const runId = `swarm-${crypto.randomUUID?.() ?? Date.now()}`;
		const policy = buildDefaultPolicy(workspaceRoot, runId);

		if (tempDir) {
			policy.temp_root = tempDir;
		}

		policy.workspace_roots =
			scopePaths.length > 0 ? scopePaths : [workspaceRoot];
		policy.writable_roots =
			policyOverride?.writable_roots && policyOverride.writable_roots.length > 0
				? [...policyOverride.writable_roots]
				: policy.workspace_roots;
		policy.network_mode = policyOverride?.network_mode ?? policy.network_mode;

		// Apply per-call env overrides to the runner policy.
		// String values are set via env_overrides; null values go to env_unsets
		// and are removed from the allowlist (issue #2475/#2259) — the runner
		// applies unsets after the allowlist copy and before its forced
		// PATH/TEMP/TMP rewrites, so a nulled runner-managed key means "never
		// inherited verbatim" (the managed sandboxed value stands) while every
		// other key is genuinely absent from the child environment.
		if (_envOverrides) {
			for (const [key, value] of Object.entries(_envOverrides)) {
				if (!isValidEnvKey(key)) continue;
				if (typeof value === 'string') {
					policy.env_overrides[key] = value;
				} else {
					policy.env_unsets.push(key);
					policy.env_allowlist = policy.env_allowlist.filter(
						(allowed) => allowed.toUpperCase() !== key.toUpperCase(),
					);
				}
			}
		}

		const policyJson = JSON.stringify(policy);

		// Write policy to a temp file for reliable stdin piping
		const policyDir = path.join(os.tmpdir(), 'swarm-sandbox-policies');
		try {
			fs.mkdirSync(policyDir, { recursive: true });
		} catch {
			// ignore — may already exist
		}
		const policyFile = path.join(policyDir, `${runId}.json`);
		fs.writeFileSync(policyFile, policyJson, 'utf-8');

		const mode =
			this._probeResult.mode === 'none' ? 'auto' : this._probeResult.mode;

		// Escape the binary path and policy file for cmd.exe
		const escapedBinary = binary.includes(' ') ? `"${binary}"` : binary;
		const escapedPolicyFile = policyFile.includes(' ')
			? `"${policyFile}"`
			: policyFile;

		// Generate a command that pipes the policy to the runner and cleans up
		// cmd /c: type reads the policy file, pipes to runner, then delete the policy file
		const escapedCommand = command.replace(/"/g, '\\"');
		return `cmd /c "type ${escapedPolicyFile} | ${escapedBinary} --policy-stdin --mode ${mode} -- ${escapedCommand} & del ${escapedPolicyFile} 2>nul"`;
	}

	getEnvOverrides(): Record<string, string | null> {
		if (this._strength === 'strong') {
			// Native runner handles env isolation internally
			return {
				PATH: null,
				TEMP: null,
				TMP: null,
				LD_PRELOAD: null,
				DYLD_INSERT_LIBRARIES: null,
				DYLD_LIBRARY_PATH: null,
				DYLD_FRAMEWORK_PATH: null,
				DYLD_ROOT_PATH: null,
				DYLD_FORCE_FLAT_NAMESPACE: null,
			};
		}

		return this._fallbackExecutor.getEnvOverrides();
	}

	/**
	 * Execute a command in the native sandbox.
	 *
	 * Only available when strength is 'strong'. Falls back to wrapCommand
	 * for weak sandbox mode.
	 */
	async executeNative(
		command: string[],
		workspaceRoot: string,
		runId?: string,
	): Promise<RunnerExecuteResult> {
		if (this._strength !== 'strong') {
			throw new SandboxError(
				'Native execution requires strong sandbox (runner binary)',
				'NATIVE_UNAVAILABLE',
			);
		}

		const policy = buildDefaultPolicy(workspaceRoot, runId);
		return runnerExecute(command, policy);
	}

	/** Whether the native runner is available for direct execution. */
	get hasNativeRunner(): boolean {
		return this._strength === 'strong';
	}

	/** The reason the sandbox was disabled, or null if not disabled. */
	get disabledReason(): string | null {
		return this._disabledReason;
	}

	/** Probe result from the native runner. */
	get probeResult(): RunnerProbeResult {
		return this._probeResult;
	}
}
