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
import type { SandboxExecutor } from '../executor';
/**
 * Check whether the Windows sandbox mechanism is present and functional.
 * Uses spawnSync to probe synchronously without throwing.
 *
 * On Windows, this verifies that basic command execution works.
 * A failure here indicates the sandbox cannot be initialized and should
 * degrade gracefully to passthrough mode.
 */
declare function probeWindowsSandbox(): boolean;
/**
 * DI seam for testability. Exposes the probe function so tests can simulate
 * unavailable sandbox conditions without requiring a real Windows environment.
 */
export declare const _internals: {
    probeWindowsSandbox: typeof probeWindowsSandbox;
};
/**
 * Windows Restricted Token sandbox executor.
 *
 * Provides best-effort process sandboxing via PowerShell environment restrictions.
 * True OS-level sandboxing requires native Windows API bindings.
 */
export declare class WindowsSandboxExecutor implements SandboxExecutor {
    /** Human-readable mechanism identifier */
    readonly mechanism = "powershell-wrapper";
    private readonly _scopePaths;
    private readonly _tempDir;
    private _available;
    private _disabled;
    private _disabledReason;
    /**
     * @param scopePaths - Absolute paths the sandboxed process may write to
     * @param tempDir   - Optional temp directory path (defaults to system temp)
     */
    constructor(scopePaths?: string[], tempDir?: string);
    /**
     * Returns true when the Windows sandbox is available and has not been disabled.
     */
    isAvailable(): boolean;
    /**
     * Disable the sandbox with a reason. Allows external code to force
     * fallback to unwrapped execution (e.g., for testing, explicit opt-out,
     * or when initialization fails).
     *
     * After calling disable():
     * - isAvailable() returns false
     * - wrapCommand() returns the raw command unchanged (passthrough)
     */
    disable(reason: string): void;
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
    wrapCommand(command: string, scopePaths: string[], tempDir?: string): string;
    /**
     * Return environment variable overrides required for the Windows sandbox.
     *
     * Security measures:
     *   - PATH is restricted to essential Windows system directories only
     *   - TEMP/TMP are set to null (will be set to scoped temp at runtime via wrapCommand)
     *   - Dangerous variables that don't apply to Windows are cleared for completeness
     */
    getEnvOverrides(): Record<string, string | null>;
}
export {};
