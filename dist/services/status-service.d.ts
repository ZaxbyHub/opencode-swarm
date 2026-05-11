import type { AgentDefinition } from '../agents';
import { hasActiveFullAuto, hasActiveLeanTurbo } from '../state';
import { loadLeanTurboRunState } from '../turbo/lean/state';
/**
 * Dependency-injection seam for status-service.
 * Allows tests to intercept Lean Turbo state queries without mock.module leakage.
 */
export declare const _internals: {
    loadLeanTurboRunState: typeof loadLeanTurboRunState;
    hasActiveLeanTurbo: typeof hasActiveLeanTurbo;
    hasActiveFullAuto: typeof hasActiveFullAuto;
};
/**
 * Structured status data returned by the status service.
 * This can be used by GUI, background flows, or command adapters.
 */
export interface StatusData {
    hasPlan: boolean;
    currentPhase: string;
    completedTasks: number;
    totalTasks: number;
    agentCount: number;
    isLegacy: boolean;
    turboMode: boolean;
    /** Lean Turbo strategy: 'lean', 'standard', or 'off' */
    turboStrategy?: 'standard' | 'lean' | 'off';
    /** Lean Turbo phase number, if Lean Turbo is active */
    leanTurboPhase?: number;
    /** Number of lanes currently in 'running' status */
    leanActiveLaneCount?: number;
    /** Max parallel coders configured for Lean Turbo */
    leanMaxParallelCoders?: number;
    /** Number of lanes completed */
    leanCompletedLanes?: number;
    /** Number of tasks marked as degraded */
    leanDegradedTasks?: number;
    /** Human-readable degradation summary */
    leanDegradationSummary?: string;
    /** Whether Full-Auto mode is currently active */
    fullAutoActive?: boolean;
    /** Reason for pause if Lean Turbo is paused */
    leanPauseReason?: string;
    /** Last known context budget percentage (0-100), or null if not yet measured */
    contextBudgetPct: number | null;
    /** Number of context compaction events triggered this session */
    compactionCount: number;
    /** ISO timestamp of last compaction snapshot, or null if none */
    lastSnapshotAt: string | null;
}
/**
 * Get status data from the swarm directory.
 * Returns structured data that can be used by GUI, background flows, or commands.
 */
export declare function getStatusData(directory: string, agents: Record<string, AgentDefinition>): Promise<StatusData>;
/**
 * Format status data as markdown for command output.
 * This is the thin adapter that delegates to the service.
 */
export declare function formatStatusMarkdown(status: StatusData): string;
/**
 * Handle status command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export declare function handleStatusCommand(directory: string, agents: Record<string, AgentDefinition>): Promise<string>;
