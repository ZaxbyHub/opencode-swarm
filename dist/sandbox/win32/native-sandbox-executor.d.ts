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
import type { SandboxExecutor } from '../executor';
import { type RunnerExecuteResult, type RunnerProbeResult } from './runner-client';
export type SandboxStrength = 'strong' | 'weak' | 'none';
/**
 * Native Windows sandbox executor with runner-first, PowerShell-fallback strategy.
 */
export declare class NativeWindowsSandboxExecutor implements SandboxExecutor {
    readonly mechanism: string;
    private readonly _probeResult;
    private readonly _fallbackExecutor;
    private readonly _strength;
    private _disabled;
    private _disabledReason;
    constructor(scopePaths?: string[], tempDir?: string);
    /** Sandbox strength: 'strong' (native runner), 'weak' (PowerShell), 'none'. */
    get strength(): SandboxStrength;
    isAvailable(): boolean;
    disable(reason: string): void;
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
    wrapCommand(command: string, scopePaths: string[], tempDir?: string): string;
    private _wrapWithRunner;
    getEnvOverrides(): Record<string, string | null>;
    /**
     * Execute a command in the native sandbox.
     *
     * Only available when strength is 'strong'. Falls back to wrapCommand
     * for weak sandbox mode.
     */
    executeNative(command: string[], workspaceRoot: string, runId?: string): Promise<RunnerExecuteResult>;
    /** Whether the native runner is available for direct execution. */
    get hasNativeRunner(): boolean;
    /** The reason the sandbox was disabled, or null if not disabled. */
    get disabledReason(): string | null;
    /** Probe result from the native runner. */
    get probeResult(): RunnerProbeResult;
}
