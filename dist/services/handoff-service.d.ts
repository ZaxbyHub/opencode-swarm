/**
 * Handoff Service
 *
 * Provides structured handoff data for agent transitions between swarm sessions.
 * Reads from .swarm files to gather current state for context-efficient handoffs.
 */
import { loadPlanJsonOnly } from '../plan/manager';
/**
 * Escape HTML special characters to prevent XSS attacks
 */
declare function escapeHtml(str: string): string;
/**
 * Sanitize string by removing RTL override characters and truncating to max length
 */
declare function sanitizeString(str: string | null | undefined, maxLength: number): string;
/**
 * Validated plan type
 */
interface ValidPlan {
    phases: Array<{
        id: number;
        name: string;
        tasks: Array<{
            id: string;
            status: string;
        }>;
    }>;
    current_phase: number | null;
}
/**
 * Validate that plan.phases is a proper array with valid phase objects
 */
declare function validatePlanPhases(plan: unknown): plan is ValidPlan;
/**
 * Pending QA state from agent sessions
 */
export interface PendingQA {
    taskId: string;
    lastFailure: string | null;
}
/**
 * Delegation chain entry
 */
export interface DelegationEntry {
    from: string;
    to: string;
    taskId: string;
    timestamp: number;
}
/**
 * Delegation state from session snapshot
 */
export interface DelegationState {
    activeChains: string[];
    delegationDepth: number;
    pendingHandoffs: string[];
}
/**
 * Structured handoff data for agent transitions
 */
export interface HandoffData {
    /** ISO timestamp when data was generated */
    generated: string;
    /** Current phase number or name */
    currentPhase: string | null;
    /** Current task ID being worked on */
    currentTask: string | null;
    /** List of incomplete task IDs */
    incompleteTasks: string[];
    /** Pending QA state */
    pendingQA: PendingQA | null;
    /** Active agent name */
    activeAgent: string | null;
    /** Recent decisions from context.md */
    recentDecisions: string[];
    /** Delegation state */
    delegationState: DelegationState | null;
    /** Locked execution_profile for this plan, if set. Resuming sessions must honour it. */
    execution_profile?: {
        parallelization_enabled: boolean;
        max_concurrent_tasks: number;
        council_parallel: boolean;
        locked: boolean;
    } | null;
}
/**
 * Extract current phase and task from plan
 */
declare function extractCurrentPhaseFromPlan(plan: Awaited<ReturnType<typeof loadPlanJsonOnly>>): {
    currentPhase: string | null;
    currentTask: string | null;
    incompleteTasks: string[];
};
/**
 * Parse session state JSON
 */
declare function parseSessionState(content: string | null): {
    activeAgent: string | null;
    delegationState: DelegationState | null;
    pendingQA: PendingQA | null;
} | null;
/**
 * Extract decisions from context.md content
 */
declare function extractDecisions(content: string | null): string[];
/**
 * Extract last 5 lines of Phase Metrics section from context.md
 */
declare function extractPhaseMetrics(content: string | null): string;
/**
 * Get handoff data from the swarm directory.
 * Reads session state, plan, and context to build comprehensive handoff info.
 */
export declare function getHandoffData(directory: string): Promise<HandoffData>;
/**
 * Format handoff data as terse markdown for LLM consumption.
 * Targets under 2K tokens for efficient context injection.
 */
export declare function formatHandoffMarkdown(data: HandoffData): string;
/**
 * Format handoff data as a continuation prompt for new agent sessions.
 * Returns a terse markdown code block with essential context and explicit
 * resumption instructions. Designed to be copy-pasted into a new session.
 */
export declare function formatContinuationPrompt(data: HandoffData): string;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    getHandoffData: typeof getHandoffData;
    formatHandoffMarkdown: typeof formatHandoffMarkdown;
    formatContinuationPrompt: typeof formatContinuationPrompt;
    escapeHtml: typeof escapeHtml;
    sanitizeString: typeof sanitizeString;
    validatePlanPhases: typeof validatePlanPhases;
    extractCurrentPhaseFromPlan: typeof extractCurrentPhaseFromPlan;
    parseSessionState: typeof parseSessionState;
    extractDecisions: typeof extractDecisions;
    extractPhaseMetrics: typeof extractPhaseMetrics;
};
export {};
