/**
 * Windows Restricted Environment sandbox executor (legacy fallback).
 *
 * Wraps shell commands with a PowerShell-based sandbox approach to restrict
 * process capabilities on Windows. This is the "weak" sandbox used when the
 * native swarm-sandbox-runner binary is not available.
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

import { Buffer } from 'node:buffer';
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../../utils/logger';
import type { SandboxExecutor } from '../executor';
import { isValidEnvKey, SandboxError } from '../executor';
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

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';
const UNSAFE_PATH_CHARACTERS = new Set([
	':',
	'"',
	"'",
	';',
	'&',
	'|',
	'<',
	'>',
	'^',
	'%',
	'!',
	'?',
	'*',
	'`',
	'$',
]);

function containsUnsafePathSyntax(value: string): boolean {
	return [...value].some(
		(character) =>
			character.charCodeAt(0) < 32 || UNSAFE_PATH_CHARACTERS.has(character),
	);
}

/**
 * Return a syntactically valid local SystemRoot without probing the filesystem.
 * The fallback preserves the historical behavior for missing or tampered values.
 */
function getSafeSystemRoot(): string {
	const raw = process.env.SystemRoot;
	if (
		typeof raw !== 'string' ||
		!/^[A-Za-z]:[\\/]/.test(raw) ||
		containsUnsafePathSyntax(raw.slice(2)) ||
		raw
			.slice(3)
			.split(/[\\/]+/)
			.some((segment) => segment === '.' || segment === '..')
	) {
		return DEFAULT_SYSTEM_ROOT;
	}

	const normalized = path.win32.normalize(raw);
	return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;
}

function getWindowsExecutablePaths(): {
	systemRoot: string;
	cmdExe: string;
	powerShellExe: string;
} {
	const systemRoot = getSafeSystemRoot();
	return {
		systemRoot,
		cmdExe: path.win32.join(systemRoot, 'System32', 'cmd.exe'),
		powerShellExe: path.win32.join(
			systemRoot,
			'System32',
			'WindowsPowerShell',
			'v1.0',
			'powershell.exe',
		),
	};
}

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
		const result = spawnSync(
			getWindowsExecutablePaths().cmdExe,
			['/d', '/s', '/c', 'echo ok'],
			{
				cwd: os.tmpdir(),
				windowsHide: true,
				encoding: 'utf-8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'ignore'] as SpawnSyncOptions['stdio'],
			},
		);

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
 * Escape a string for safe embedding inside a PowerShell single-quoted string.
 * PowerShell treats every character except a single quote literally in this context;
 * embedded single quotes are represented by two consecutive single quotes.
 */
function psSingleQuoteEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * Validate and normalize one inherited Windows PATH entry without filesystem I/O.
 * PATH filtering is functional sanitization rather than a trust boundary: retain
 * local drive-rooted tool directories, but reject entries whose syntax can change
 * command or PATH parsing.
 */
function normalizeInheritedPathEntry(rawEntry: string): string | null {
	const entry = rawEntry.trim();
	if (
		!/^[A-Za-z]:[\\/]/.test(entry) ||
		containsUnsafePathSyntax(entry.slice(2)) ||
		entry
			.slice(3)
			.split(/[\\/]+/)
			.some((segment) => segment === '.' || segment === '..')
	) {
		return null;
	}

	const normalized = path.win32.normalize(entry);
	return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;
}

/**
 * Build a usable, deterministic Windows PATH without blocking filesystem probes.
 * Validated SystemRoot directories are ordered first, followed by syntactically
 * local inherited entries with case-insensitive de-duplication.
 */
function getSafeWindowsPath(): string {
	const { systemRoot } = getWindowsExecutablePaths();
	const candidates = [
		path.win32.join(systemRoot, 'System32'),
		systemRoot,
		...(process.env.PATH ?? '').split(';'),
	];
	const seen = new Set<string>();
	const safeEntries: string[] = [];

	for (const candidate of candidates) {
		const normalized = normalizeInheritedPathEntry(candidate);
		if (!normalized) continue;
		const identity = normalized.toLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		safeEntries.push(normalized);
	}

	return safeEntries.join(';');
}

/**
 * Return true when the command begins with a filesystem-only PowerShell-native
 * cmdlet (or a common alias for one) that would fail when passed to `cmd /c`.
 *
 * The whitelist is intentionally restricted to read/write filesystem operations
 * to minimize the attack surface of the Invoke-Expression execution path.
 *
 * Commands in this category must be invoked directly inside the PowerShell
 * script rather than via `cmd /c`.
 */
function isPowerShellNativeCommand(command: string): boolean {
	return /^(?:Remove-Item|rm|del|erase|Copy-Item|cp|copy|Move-Item|mv|move|Rename-Item|ren|New-Item|ni|Get-Item|gi|Get-ChildItem|ls|dir|gci|Get-Content|cat|type|gc|Set-Content|sc|Add-Content|ac|Clear-Content|clc|Test-Path|Resolve-Path|Split-Path|Join-Path|Out-File|Get-Date)\b/i.test(
		command.trimStart(),
	);
}

/**
 * Validate that a PowerShell-native command body is free of characters that
 * enable injection when the command is executed via Invoke-Expression.
 *
 * Returns false if the command contains any of: semicolon (statement
 * separator), ampersand (call operator), pipeline, backtick (PS escape),
 * dollar sign (variable prefix), parentheses (subexpression), or newlines.
 */
function isSafePsCommandBody(command: string): boolean {
	return !/[;&|`$()\r\n]/.test(command);
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
	 *   - Preserves syntactically safe local PATH entries after system paths
	 *   - Removes dangerous environment variables that could be used to bypass restrictions
	 *   - Applies per-call envOverrides (set or unset)
	 *   - Executes PowerShell-native cmdlets (filesystem cmdlets only) via Invoke-Expression,
	 *     and all other commands via cmd /c inside a PowerShell script
	 *
	 * Safety checks applied before wrapping:
	 *   - PowerShell escape patterns are rejected via detectPowerShellEscape
	 *   - PowerShell-native commands are restricted to a filesystem-only cmdlet whitelist
	 *   - PowerShell-native command bodies must not contain statement separators (;),
	 *     call operator (&), pipelines (|), backtick escapes (`), variable references ($),
	 *     subexpressions/parentheses, or newlines
	 *
	 * @param command   - Raw shell command to execute inside the sandbox
	 * @param scopePaths - Additional scope paths to allow (merged with constructor scope)
	 * @param tempDir   - Optional temp directory override
	 * @param envOverrides - Optional per-call env overrides: string sets the var, null unsets it.
	 *                      When omitted, no per-call env override is applied.
	 * @returns A PowerShell-wrapped command string ready for shell execution,
	 *          or the raw command string when the sandbox is unavailable (passthrough mode)
	 * @throws {SandboxError} UNSAFE_PS_COMMAND when a PowerShell-native command body
	 *         contains characters that enable command injection via Invoke-Expression
	 */
	wrapCommand(
		command: string,
		scopePaths: string[],
		tempDir?: string,
		envOverrides?: Record<string, string | null>,
	): string {
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

		// Reject PowerShell-native commands whose body contains characters that
		// enable injection when executed via Invoke-Expression (statement
		// separators, call operator, pipeline, variable references, subexpressions).
		if (isPowerShellNativeCommand(command) && !isSafePsCommandBody(command)) {
			throw new SandboxError(
				'PowerShell-native command body contains unsafe characters',
				'UNSAFE_PS_COMMAND',
			);
		}

		// Keep validated inherited developer-tool directories after system paths.
		// This is syntax-only so wrapping cannot block on filesystem probes.
		const safePath = getSafeWindowsPath();
		const { cmdExe, powerShellExe } = getWindowsExecutablePaths();

		// Transport the original command as opaque UTF-8 Base64. It is never
		// interpolated into PowerShell syntax or the outer -Command string.
		const commandBase64 = Buffer.from(command, 'utf8').toString('base64');
		const escapedTemp = psSingleQuoteEscape(temp);
		const escapedPath = psSingleQuoteEscape(safePath);
		const escapedCmdExe = psSingleQuoteEscape(cmdExe);

		// Build per-call env override commands for the PowerShell script.
		// String values: $env:KEY = 'VALUE'; (single-quoted, embedded in PS string)
		// Null values: Remove-Item Env:KEY -Force -ErrorAction SilentlyContinue;
		// Single quotes in values are escaped by doubling them ('').
		// Keys are validated to prevent PowerShell variable-name injection.
		const envOverrideLines: string[] = [];
		if (envOverrides) {
			for (const [key, value] of Object.entries(envOverrides)) {
				// Reject invalid env var names silently — they cannot be safely
				// interpolated into PowerShell variable syntax.
				if (!isValidEnvKey(key)) {
					continue;
				}
				if (value === null) {
					envOverrideLines.push(
						`Remove-Item Env:${key} -Force -ErrorAction SilentlyContinue;`,
					);
				} else {
					const psEscaped = psSingleQuoteEscape(value);
					envOverrideLines.push(`$env:${key} = '${psEscaped}';`);
				}
			}
		}

		// PowerShell-native cmdlets run only after their existing strict validation.
		// Other commands use the absolute system command interpreter and propagate
		// its exact status through the nested PowerShell process.
		const commandExec = isPowerShellNativeCommand(command)
			? `Invoke-Expression $command;
  exit 0;`
			: `$batchPath = $null;
  $batchLocationPushed = $false;
  try {
    if ($command.Contains([char]13) -or $command.Contains([char]10)) {
      $batchName = 'opencode-swarm-' + [Guid]::NewGuid().ToString('N') + '.cmd';
      $batchPath = Join-Path $env:TEMP $batchName;
      [IO.File]::WriteAllText($batchPath, $command, [Text.UTF8Encoding]::new($false));
      Push-Location -LiteralPath $env:TEMP;
      $batchLocationPushed = $true;
      & '${escapedCmdExe}' /d /v:off /s /c ('call "' + $batchName + '"');
    } else {
      & '${escapedCmdExe}' /d /v:off /s /c $command;
    }
    $childExitCode = $LASTEXITCODE;
  } finally {
    if ($batchLocationPushed) {
      Pop-Location;
    }
    if ($null -ne $batchPath) {
      Remove-Item -LiteralPath $batchPath -Force -ErrorAction SilentlyContinue;
    }
  }
  if ($null -eq $childExitCode) {
    throw 'cmd.exe did not report an exit code';
  }
  exit [int]$childExitCode;`;

		// The intact script is encoded as UTF-16LE for Windows PowerShell's
		// -EncodedCommand contract. No line or quote normalization is performed.
		const envOverrideBlock =
			envOverrideLines.length > 0 ? `\n  ${envOverrideLines.join('\n  ')}` : '';
		const psScript = `
$ErrorActionPreference = 'Stop';
$ProgressPreference = 'SilentlyContinue';
try {
  $env:TEMP = '${escapedTemp}';
  $env:TMP = '${escapedTemp}';

  $env:PATH = '${escapedPath}';

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
  ${envOverrideBlock}

  # Execute the command — PS-native cmdlets via Invoke-Expression, others via the standard command interpreter
  $commandBytes = [Convert]::FromBase64String('${commandBase64}');
  $command = [Text.Encoding]::UTF8.GetString($commandBytes);
  ${commandExec};
} catch {
  [Console]::Error.WriteLine($_.Exception.Message);
  exit 1;
}`;

		const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');
		const escapedPowerShellExe = psSingleQuoteEscape(powerShellExe);
		return `& '${escapedPowerShellExe}' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodedScript}; exit $LASTEXITCODE`;
	}

	/**
	 * Return environment variable overrides required for the Windows sandbox.
	 *
	 * Security measures:
	 *   - PATH starts with essential Windows system directories, then retains
	 *     syntactically safe local inherited tool directories
	 *   - TEMP/TMP are set to null (will be set to scoped temp at runtime via wrapCommand)
	 *   - Dangerous variables that don't apply to Windows are cleared for completeness
	 */
	getEnvOverrides(): Record<string, string | null> {
		return {
			// Mirror the path embedded by wrapCommand for direct executor consumers.
			PATH: getSafeWindowsPath(),
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
