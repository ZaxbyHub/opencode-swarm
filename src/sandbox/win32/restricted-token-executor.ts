/**
 * Windows Restricted Token sandbox executor.
 *
 * Wraps shell commands with a PowerShell-based sandbox approach to restrict
 * process capabilities on Windows.
 *
 * Windows does not have a native sandbox mechanism equivalent to Linux bwrap
 * or macOS sandbox-exec that is accessible from Node.js without native bindings.
 * This executor provides best-effort sandboxing via:
 *   - Environment variable scrubbing (removing dangerous vars)
 *   - PATH restriction to safe system paths only
 *   - Scoped temp directory
 *   - PowerShell wrapper for command execution
 *
 * For true OS-level sandboxing (AppContainer, Restricted Token, Low Integrity),
 * native Windows APIs (CreateAppContainerToken, CreateRestrictedToken) are required.
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../../utils/logger';
import type { SandboxExecutor } from '../executor';
import { SandboxError } from '../executor';
import { detectPowerShellEscape } from './edge-cases';

/**
 * Error codes from spawnSync that indicate the Windows sandbox is unavailable.
 */
const SANDBOX_UNAVAILABLE_CODES = new Set([
	'ENOENT',
	'EACCES',
	'EPERM',
	'ENOSPC',
]);

/**
 * Check whether the Windows sandbox mechanism is present and functional.
 * Uses spawnSync to probe synchronously without throwing.
 *
 * On Windows, this verifies that basic command execution works.
 * A failure here indicates the sandbox cannot be initialized and should
 * degrade gracefully to passthrough mode.
 */
function probeWindowsSandbox(): boolean {
	try {
		// Probe by checking if we can spawn a basic cmd command.
		// If this fails, the Windows sandbox is unavailable.
		const result = spawnSync('cmd', ['/c', 'echo', 'ok'], {
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'ignore'] as SpawnSyncOptions['stdio'],
		});

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code as
				| string
				| undefined;
			if (code && SANDBOX_UNAVAILABLE_CODES.has(code)) {
				warn(
					`Sandbox disabled: spawn error (${code}). Falling through to tool-layer enforcement.`,
				);
				return false;
			}
			warn(
				`Sandbox disabled: spawn error (${result.error.message}). Falling through to tool-layer enforcement.`,
			);
			return false;
		}

		return result.status === 0;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		warn(
			`Sandbox disabled: probe threw (${message}). Falling through to tool-layer enforcement.`,
		);
		return false;
	}
}

/**
 * DI seam for testability. Exposes the probe function so tests can simulate
 * unavailable sandbox conditions without requiring a real Windows environment.
 */
export const _internals: { probeWindowsSandbox: typeof probeWindowsSandbox } = {
	probeWindowsSandbox,
} as const;

/**
 * Escape a string for safe embedding inside a PowerShell double-quoted string.
 * PowerShell string escaping: escape backtick, dollar sign, and double quote.
 */
function psStringEscape(s: string): string {
	return s.replace(/[`"$]/g, '`$&');
}

/**
 * Check if all paths in a command are within the authorized scopes.
 *
 * @param command - The command string to analyze
 * @param scopes - Array of authorized scope directory paths
 * @returns true if all paths in the command are within at least one scope, or no paths detected
 */
function isPathInScopes(command: string, scopes: string[]): boolean {
	if (scopes.length === 0) return true;

	// Extract Windows absolute paths from command
	const pathPattern =
		/[A-Za-z]:(?:[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)*)/g;
	const paths = command.match(pathPattern) || [];
	if (paths.length === 0) return true; // No paths detected, allow

	// Normalize extracted paths with resolve to eliminate ..\ traversal before comparison
	const normalizedPaths = paths.map((p) => path.win32.resolve(p));

	// Normalize scopes for comparison (lowercase, trailing slashes removed)
	const normalizedScopes = scopes.map((s) =>
		s.toLowerCase().replace(/\\+$/, ''),
	);

	return normalizedPaths.every((p) => {
		const lower = p.toLowerCase();
		return normalizedScopes.some((scope) => lower.startsWith(scope));
	});
}

/**
 * Windows Restricted Token sandbox executor.
 *
 * Provides best-effort process sandboxing via PowerShell environment restrictions.
 * True OS-level sandboxing requires native Windows API bindings.
 */
export class WindowsSandboxExecutor implements SandboxExecutor {
	/** Human-readable mechanism identifier */
	public readonly mechanism = 'powershell-wrapper';

	private readonly _scopePaths: string[];
	private readonly _tempDir: string | undefined;
	private _available: boolean;
	private _disabled: boolean;
	private _disabledReason: string | null;

	/**
	 * @param scopePaths - Absolute paths the sandboxed process may write to
	 * @param tempDir   - Optional temp directory path (defaults to system temp)
	 */
	constructor(scopePaths: string[] = [], tempDir?: string) {
		this._scopePaths = scopePaths;
		this._tempDir = tempDir;
		this._available = false;
		this._disabled = false;
		this._disabledReason = null;

		// Probe for Windows sandbox availability in constructor
		try {
			if (!_internals.probeWindowsSandbox()) {
				this._available = false;
				this._disabledReason =
					'Windows sandbox not available or not functional';
				warn(
					`Sandbox unavailable: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
				);
			} else {
				this._available = true;
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this._available = false;
			this._disabledReason = `constructor probe threw: ${message}`;
			warn(
				`Sandbox unavailable: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
			);
		}
	}

	/**
	 * Returns true when the Windows sandbox is available and has not been disabled.
	 */
	isAvailable(): boolean {
		return this._available && !this._disabled;
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
		this._disabled = true;
		this._disabledReason = reason;
		warn(
			`Sandbox disabled: ${reason}. Falling through to tool-layer enforcement.`,
		);
	}

	/**
	 * Wrap a shell command string with PowerShell-based sandbox restrictions.
	 *
	 * The wrapper:
	 *   - Sets scoped temp directory (%TEMP%, %TMP%)
	 *   - Restricts PATH to safe system paths only
	 *   - Removes dangerous environment variables that could be used to bypass restrictions
	 *   - Executes the command via cmd /c inside a PowerShell script
	 *
	 * @param command   - Raw shell command to execute inside the sandbox
	 * @param scopePaths - Additional scope paths to allow (merged with constructor scope)
	 * @param tempDir   - Optional temp directory override
	 * @returns A PowerShell-wrapped command string ready for shell execution,
	 *          or the raw command string when the sandbox is unavailable (passthrough mode)
	 */
	wrapCommand(command: string, scopePaths: string[], tempDir?: string): string {
		// Throw when disabled or unavailable
		if (!this.isAvailable()) {
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		// Re-check availability before each wrap — sandbox may become unavailable mid-session
		if (!_internals.probeWindowsSandbox()) {
			this._available = false;
			this._disabledReason = 'Windows sandbox became unavailable between calls';
			warn(
				`Sandbox disabled: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
			);
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		const temp = tempDir ?? this._tempDir ?? os.tmpdir();
		const _allScopes = [...this._scopePaths, ...scopePaths];

		// Validate inner command before wrapping — detect on original command,
		// not on the wrapped output (which contains -ExecutionPolicy Bypass etc.)
		if (detectPowerShellEscape(command)) {
			throw new SandboxError(
				'Command contains PowerShell escape patterns',
				'DETECT_POWERSHELL_ESCAPE',
			);
		}

		// Validate paths are within authorized scopes
		if (!isPathInScopes(command, _allScopes)) {
			throw new SandboxError(
				'Command targets paths outside authorized scopes',
				'PATH_ESCAPE_SCOPE',
			);
		}

		// Safe PATH for Windows: only essential system directories
		const safePath = 'C:\\Windows\\System32;C:\\Windows';

		// Escape values for PowerShell embedding
		const escapedTemp = psStringEscape(temp);
		const escapedCommand = psStringEscape(command);

		// PowerShell script that sets up the restricted environment and runs the command
		// Uses -NoProfile to skip loading PowerShell profile scripts for faster startup
		// Uses -WindowStyle Hidden to suppress the PowerShell window
		const psScript = `
$ErrorActionPreference = 'Stop';
try {
  # Set scoped temp directory
  $env:TEMP = '${escapedTemp}';
  $env:TMP = '${escapedTemp}';

  # Restrict PATH to safe system paths only
  $env:PATH = '${safePath}';

  # Remove dangerous environment variables that could be used to bypass restrictions
  # Note: LD_PRELOAD, DYLD_* don't apply on Windows but we clear them for completeness
  $dangerousVars = @(
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'DYLD_ROOT_PATH',
    'DYLD_FORCE_FLAT_NAMESPACE'
  );
  foreach ($v in $dangerousVars) {
    if (Test-Path Env:$v) {
      Remove-Item Env:$v -Force -ErrorAction SilentlyContinue;
    }
  }

  # Execute the command via cmd /c
  cmd /c "${escapedCommand}";
} catch {
  Write-Error $_.Exception.Message;
  exit 1;
}`;

		// Execute via PowerShell with bypass execution policy
		return `powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -Command "${psScript
			.replace(/\n/g, ' ')
			.trim()}"`;
	}

	/**
	 * Return environment variable overrides required for the Windows sandbox.
	 *
	 * Security measures:
	 *   - PATH is restricted to essential Windows system directories only
	 *   - TEMP/TMP are set to null (will be set to scoped temp at runtime via wrapCommand)
	 *   - Dangerous variables that don't apply to Windows are cleared for completeness
	 */
	getEnvOverrides(): Record<string, string | null> {
		return {
			// Restrict PATH to essential system directories only
			PATH: 'C:\\Windows\\System32;C:\\Windows',
			// Scoped temp directory is set at runtime via wrapCommand
			TEMP: null,
			TMP: null,
			// Remove potentially dangerous environment variables
			// These don't apply to Windows but are cleared for defense-in-depth
			LD_PRELOAD: null,
			DYLD_INSERT_LIBRARIES: null,
			DYLD_LIBRARY_PATH: null,
			DYLD_FRAMEWORK_PATH: null,
			DYLD_ROOT_PATH: null,
			DYLD_FORCE_FLAT_NAMESPACE: null,
		};
	}
}
