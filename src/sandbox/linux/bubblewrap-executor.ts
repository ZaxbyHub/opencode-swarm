/**
 * Linux Bubblewrap sandbox executor.
 *
 * Wraps shell commands with bwrap (Bubblewrap) to restrict process capabilities.
 * Uses --bind to mount scope paths read-write, --tmpfs for /tmp, and --ro-bind
 * for essential read-only system paths.
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { warn } from '../../utils/logger';
import { SandboxError, type SandboxExecutor } from '../executor';

/** Magic exit code bwrap returns when --version is passed */
const BWRAP_VERSION_EXIT = 0;

/**
 * Error codes from spawnSync that indicate bwrap is unavailable.
 */
const BWRAP_UNAVAILABLE_CODES = new Set(['ENOENT', 'EACCES', 'ENOSPC']);

/**
 * Check whether the bwrap binary is present on PATH.
 * Uses spawnSync to probe synchronously without throwing.
 * Logs specific error codes when bwrap is found but unusable.
 */
function probeBwrap(): boolean {
	try {
		const result = spawnSync('bwrap', ['--version'], {
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

		return (
			result.status === BWRAP_VERSION_EXIT && result.stdout.trim().length > 0
		);
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
export const _internals: { probeBwrap: typeof probeBwrap } = {
	probeBwrap,
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
 *   - bind-mounts each scope path read-write
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
	 * @returns A bwrap-wrapped command string ready for shell execution,
	 *          or the raw command string when the sandbox is unavailable (passthrough mode)
	 */
	wrapCommand(command: string, scopePaths: string[], tempDir?: string): string {
		// Re-check availability before each wrap — bwrap may become unavailable mid-session
		if (!this._available) {
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		const temp = tempDir ?? this._tempDir ?? '/tmp';
		const allScopes = [...this._scopePaths, ...scopePaths];

		// Build --bind arguments for each scope path (SRC DEST pair for bwrap)
		// Shell-escape and single-quote wrap each path to handle spaces and special chars
		const bindArgs = allScopes.flatMap((p) => [
			'--bind',
			`'${shellEscape(p)}'`,
			`'${shellEscape(p)}'`,
		]);

		// Core sandbox arguments
		const args = [
			'--unshare-user',
			'--unshare-net',
			'--unshare-ipc',
			'--die-with-parent',
			'--new-session',
			...bindArgs,
			'--dev',
			'/dev',
			'--size',
			'500M',
			'--tmpfs',
			`'${shellEscape(temp)}'`,
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
			'--',
			'bash',
			'-c',
			`'${shellEscape(command)}'`,
		];

		return `bwrap ${args.join(' ')}`;
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
