/**
 * Platform-agnostic sandbox execution abstraction.
 *
 * Provides a unified interface for sandboxed shell command execution across
 * Linux (Bubblewrap), macOS (sandbox-exec), and Windows (restricted token/Low Integrity).
 */

import { warn } from '../utils/logger';
import {
	assessSandboxRequirements,
	SandboxCapabilityProbe,
	type SandboxCapabilityV1,
	type SandboxRequirements,
} from './capability-probe';

/**
 * Error thrown when sandbox operations fail.
 */
export class SandboxError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = 'SandboxError';
	}
}

/**
 * Validate that a string is a valid POSIX environment variable name.
 * POSIX env var names: [a-zA-Z_][a-zA-Z0-9_]*
 *
 * Used to prevent shell-injection when env var keys are interpolated into
 * sandbox command syntax on any platform.
 */
export function isValidEnvKey(key: string): boolean {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/**
 * Issue #2263: env-var families that must never be sourced from an
 * untrusted (repo-resident) env file, on top of the `isValidEnvKey` shape
 * check.
 *
 * `.swarm/lanes/<N>.env` lives inside the repository worktree, so a hostile
 * repository can simply commit it. If such a file were ever fed into a child
 * process environment, these families are code-execution primitives:
 *
 * - `GIT_*` configuration vars — `GIT_SSH_COMMAND`, `GIT_CONFIG_COUNT` /
 *   `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (can set `core.sshCommand` or
 *   `core.pager`), `GIT_EXTERNAL_DIFF`, `GIT_TEMPLATE_DIR`, …
 * - Loader-hijack vars — `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` on macOS.
 *
 * Prefix matching (not exact names) is deliberate: enumerating "the bad
 * ones" inside `GIT_*` is a losing race against git's growing config-env
 * surface, and the entire `GIT_*` namespace is a git *control* plane that a
 * lane profile (PORT / TMPDIR / cache redirects) has no legitimate reason to
 * touch. Matching is case-insensitive because Windows env resolution is
 * case-insensitive (`git_ssh_command` must not slip through).
 *
 * `GITHUB_*` is intentionally NOT blocked: those are data-plane tokens
 * (e.g. `GITHUB_TOKEN`) routinely passed to CLI children, not git controls.
 */
const UNTRUSTED_ENV_KEY_PREFIXES = ['GIT_', 'LD_', 'DYLD_'] as const;

/**
 * Returns true when `key` belongs to one of the env-var families that must
 * never be sourced from a repo-resident (untrusted) env file.
 * See `UNTRUSTED_ENV_KEY_PREFIXES` for the rationale.
 */
export function isUntrustedEnvKey(key: string): boolean {
	const upper = key.toUpperCase();
	for (const prefix of UNTRUSTED_ENV_KEY_PREFIXES) {
		if (upper.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Interface for platform-specific sandbox executors.
 */
export interface SandboxExecutor {
	/** Human-readable name of the sandbox mechanism */
	readonly mechanism: string;

	/** Whether this executor is available on the current platform */
	isAvailable(): boolean;

	/**
	 * Wrap a shell command with sandbox prefix.
	 * @param command - The raw shell command string to execute
	 * @param scopePaths - Absolute paths the coder is allowed to write to
	 * @param tempDir - Optional temporary directory path (platform default if omitted)
	 * @param envOverrides - Optional per-call env overrides: string value sets the var, null unsets it.
	 *                       When omitted (undefined), no per-call env override is applied (default: undefined).
	 * @returns The wrapped command string with sandbox prefix
	 * @throws SandboxError if sandbox cannot wrap the command
	 */
	wrapCommand(
		command: string,
		scopePaths: string[],
		tempDir?: string,
		envOverrides?: Record<string, string | null>,
		policy?: SandboxPolicyOptions,
	): string;

	/**
	 * Get the environment variable overrides for this sandbox.
	 * Returns a record of env vars to set/unset.
	 */
	getEnvOverrides(): Record<string, string | null>;
}

export interface SandboxPolicyOptions {
	network_mode?: 'off' | 'on';
	network_allowlist?: readonly string[];
	writable_roots?: readonly string[];
}

// Cached executor promise — set once at first getExecutor() call.
// This ensures the capability probe runs only once even if getExecutor()
// is called multiple times.
// undefined = not yet initialized, Promise<null> = initialized but no executor available
let _cachedExecutorPromise: Promise<SandboxExecutor | null> | undefined;
const MAX_SANDBOX_ASSESSMENT_CACHE = 8;
const _sandboxAssessmentCache = new Map<
	string,
	Promise<SandboxEnforcementAssessment>
>();

export interface SandboxEnforcementAssessment {
	capability: SandboxCapabilityV1;
	requirements: Required<SandboxRequirements>;
	policy: Required<SandboxPolicyOptions>;
	satisfied: boolean;
	missing: string[];
	supported: boolean;
	unsupported: string[];
	cacheKey: string;
}

function normalizeSandboxRequirements(
	requirements: SandboxRequirements | undefined,
): Required<SandboxRequirements> {
	return {
		mode: requirements?.mode ?? 'advisory',
		require_filesystem: requirements?.require_filesystem ?? false,
		require_network: requirements?.require_network ?? false,
		require_process: requirements?.require_process ?? false,
		network_mode: requirements?.network_mode ?? 'off',
		network_allowlist: [...(requirements?.network_allowlist ?? [])],
		writable_roots: [...(requirements?.writable_roots ?? [])],
	};
}

function normalizeSandboxPolicy(
	requirements: Required<SandboxRequirements>,
): Required<SandboxPolicyOptions> {
	return {
		network_mode: requirements.network_mode,
		network_allowlist: [...requirements.network_allowlist],
		writable_roots: [...requirements.writable_roots],
	};
}

function hashList(values: readonly string[]): string {
	return values
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.sort((a, b) => a.localeCompare(b))
		.join('\u001f');
}

function buildSandboxAssessmentCacheKey(
	capability: SandboxCapabilityV1,
	requirements: Required<SandboxRequirements>,
	policy: Required<SandboxPolicyOptions>,
): string {
	return [
		capability.identity,
		requirements.mode,
		`fs=${requirements.require_filesystem ? 1 : 0}`,
		`net=${requirements.require_network ? 1 : 0}`,
		`proc=${requirements.require_process ? 1 : 0}`,
		`netmode=${policy.network_mode}`,
		`allowlist=${hashList(policy.network_allowlist)}`,
		`roots=${hashList(policy.writable_roots)}`,
	].join('|');
}

function evaluatePolicySupport(
	capability: SandboxCapabilityV1,
	policy: Required<SandboxPolicyOptions>,
): { supported: boolean; unsupported: string[] } {
	const unsupported: string[] = [];
	if (policy.network_allowlist.length > 0) {
		unsupported.push('network_allowlist');
	}
	const mechanism = capability.mechanism.toLowerCase();
	if (
		policy.network_mode === 'off' &&
		(capability.platform === 'darwin' || mechanism === 'powershell-wrapper')
	) {
		unsupported.push('network_mode');
	}
	return { supported: unsupported.length === 0, unsupported };
}

function pruneSandboxAssessmentCache(): void {
	while (_sandboxAssessmentCache.size > MAX_SANDBOX_ASSESSMENT_CACHE) {
		const oldestKey = _sandboxAssessmentCache.keys().next().value;
		if (oldestKey === undefined) return;
		_sandboxAssessmentCache.delete(oldestKey);
	}
}

export async function assessSandboxEnforcement(
	requirements: SandboxRequirements | undefined,
): Promise<SandboxEnforcementAssessment> {
	const capability = await new SandboxCapabilityProbe().detect();
	const normalized = normalizeSandboxRequirements(requirements);
	const policy = normalizeSandboxPolicy(normalized);
	const cacheKey = buildSandboxAssessmentCacheKey(
		capability,
		normalized,
		policy,
	);
	const cached = _sandboxAssessmentCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const assessmentPromise = Promise.resolve().then(() => {
		const support = evaluatePolicySupport(capability, policy);
		const assessment = assessSandboxRequirements(capability, normalized);
		return {
			capability,
			requirements: normalized,
			policy,
			satisfied: support.supported && assessment.satisfied,
			missing: assessment.missing,
			supported: support.supported,
			unsupported: support.unsupported,
			cacheKey,
		};
	});
	_sandboxAssessmentCache.set(cacheKey, assessmentPromise);
	pruneSandboxAssessmentCache();
	return assessmentPromise;
}

/**
 * Get the platform-appropriate sandbox executor.
 *
 * Returns null if no sandbox mechanism is available for the current platform.
 * The result is cached after the first call for fast subsequent access.
 *
 * Lazily imports platform-specific executor modules to avoid import-time
 * failures on platforms where they don't exist.
 */
export async function getExecutor(): Promise<SandboxExecutor | null> {
	if (_cachedExecutorPromise !== undefined) {
		return _cachedExecutorPromise;
	}

	_cachedExecutorPromise = _createExecutor();
	return _cachedExecutorPromise;
}

/**
 * Create the appropriate executor for this platform.
 * Internal — called once and cached.
 */
async function _createExecutor(): Promise<SandboxExecutor | null> {
	const platform = process.platform;

	if (platform === 'linux') {
		return _createLinuxExecutor();
	}

	if (platform === 'darwin') {
		return _createMacOSExecutor();
	}

	if (platform === 'win32') {
		return _createWindowsExecutor();
	}

	// Unknown platform — no sandbox available
	return null;
}

async function _createLinuxExecutor(): Promise<SandboxExecutor | null> {
	// Import and run the async capability probe first to populate the sync cache
	const { SandboxCapabilityProbe, isBubblewrapAvailable } = await import(
		'./capability-probe'
	);
	await new SandboxCapabilityProbe().detect();

	if (!isBubblewrapAvailable()) {
		return null;
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { BubblewrapSandboxExecutor } = require('./executors/bubblewrap');
		// F-001 fix: Pass empty scope paths array as default - actual scope paths
		// are passed at wrapCommand() time and merged with constructor paths
		return new BubblewrapSandboxExecutor([]);
	} catch {
		return null;
	}
}

/**
 * F6a item 3 (issue #2236): the macOS sandbox stays opt-in until a real
 * macOS host has verified the production SBPL profile's last-match-wins
 * ordering (`sandbox-exec-executor.ts` flags that ordering as "reasoned
 * from documented SBPL semantics; not empirically re-verified"). Defaults
 * to false; set via `setMacOSSandboxPolicy()` from the resolved
 * `guardrails.sandbox_macos_enabled` config value at hook-registration
 * time, before any tool call can reach `getExecutor()`.
 */
let _macosSandboxEnabled = false;
let _hasWarnedMacOSSandboxDisabledByConfig = false;

/**
 * Set whether the macOS sandbox-exec mechanism may be activated. Called
 * once from `createToolBeforeHandler` (src/hooks/guardrails/tool-before.ts)
 * using the already-resolved `GuardrailsConfig`, at guardrails hook
 * registration — which runs at plugin init, before the first bash tool call
 * can trigger `getExecutor()`. When false (the default), `getExecutor()`
 * behaves exactly as it did before F6: it resolves to `null` and every
 * consumer (tool-before's `applySandboxExecution`, `diagnose-service`,
 * guardrails/index) observes the identical fail-open "executor not
 * available" state, so activation stays byte-identical to today until this
 * is explicitly turned on.
 */
export function setMacOSSandboxPolicy(enabled: boolean): void {
	_macosSandboxEnabled = enabled;
}

/** @internal test seam — read the current policy without going through config. */
export function _getMacOSSandboxPolicyForTest(): boolean {
	return _macosSandboxEnabled;
}

async function _createMacOSExecutor(): Promise<SandboxExecutor | null> {
	if (!_macosSandboxEnabled) {
		if (!_hasWarnedMacOSSandboxDisabledByConfig) {
			_hasWarnedMacOSSandboxDisabledByConfig = true;
			warn(
				'[sandbox] macOS sandbox-exec is disabled by config (guardrails.sandbox_macos_enabled=false). ' +
					'Enable it only after verifying the production SBPL profile on a real macOS host — see docs/configuration.md.',
			);
		}
		return null;
	}

	// Import and run the async capability probe first to populate the sync cache
	const { SandboxCapabilityProbe, isSandboxExecAvailable } = await import(
		'./capability-probe'
	);
	await new SandboxCapabilityProbe().detect();

	if (!isSandboxExecAvailable()) {
		return null;
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { MacOSSandboxExecutor } = require('./executors/macos');
		return new MacOSSandboxExecutor([]);
	} catch {
		return null;
	}
}

async function _createWindowsExecutor(): Promise<SandboxExecutor | null> {
	// Import and run the async capability probe first to populate the sync cache
	const { SandboxCapabilityProbe, isWindowsSandboxAvailable } = await import(
		'./capability-probe'
	);
	await new SandboxCapabilityProbe().detect();
	if (!isWindowsSandboxAvailable()) {
		return null;
	}

	try {
		// Primary: NativeWindowsSandboxExecutor (tries runner binary, falls back to PowerShell)
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { WindowsSandboxExecutor } = require('./executors/windows');
		return new WindowsSandboxExecutor([]);
	} catch {
		return null;
	}
}

/**
 * Reset the cached executor — useful for testing.
 * @internal
 */
export function _resetExecutorCache(): void {
	_cachedExecutorPromise = undefined;
}

/** @internal test seam */
export function _resetSandboxAssessmentCache(): void {
	_sandboxAssessmentCache.clear();
}
