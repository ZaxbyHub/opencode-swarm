/**
 * Update task status tool for changing the status of individual tasks in a plan.
 * Allows agents to mark tasks as pending, in_progress, completed, or blocked.
 */
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the update_task_status tool
 */
export interface UpdateTaskStatusArgs {
    task_id: string;
    status: string;
    working_directory?: string;
}
/**
 * Result from executing update_task_status
 */
export interface UpdateTaskStatusResult {
    success: boolean;
    message: string;
    task_id?: string;
    new_status?: string;
    current_phase?: number;
    errors?: string[];
    /** Present when the call failed due to lock contention. Instructs the caller to retry. */
    recovery_guidance?: string;
}
/**
 * Validate that the status is one of the allowed values.
 * @param status - The status to validate
 * @returns Error message if invalid, undefined if valid
 */
export declare function validateStatus(status: string): string | undefined;
/**
 * Validate that task_id matches the required format (N.M or N.M.P).
 * @param taskId - The task ID to validate
 * @returns Error message if invalid, undefined if valid
 */
export declare function validateTaskId(taskId: string): string | undefined;
/**
 * Result from checking reviewer gate presence
 */
export interface ReviewerGateResult {
    blocked: boolean;
    reason: string;
}
/**
 * Check if a task has passed required QA gates using the state machine.
 * Requires the task to be in 'tests_run' or 'complete' state, which means
 * both reviewer delegation and test_engineer runs have been recorded.
 * @param taskId - The task ID to check gate state for
 * @param workingDirectory - Optional working directory for plan.json fallback
 * @param stageBParallelEnabled - When true, also accept both-markers-present as passing (PR 2 barrier)
 * @param sessionID - Optional session ID to scope Lean Turbo bypass to the current tool-execution context
 * @returns ReviewerGateResult indicating whether the gate is blocked
 */
export declare function checkReviewerGate(taskId: string, workingDirectory?: string, stageBParallelEnabled?: boolean, sessionID?: string): ReviewerGateResult;
/**
 * Wrapper around checkReviewerGate that appends a diff-scope advisory warning.
 * Keeps checkReviewerGate synchronous for backward compatibility.
 * Stage B parallel is hardcoded (not config-driven).
 * @param taskId - The task ID to check gate state for
 * @param workingDirectory - Optional working directory for plan.json fallback
 * @param sessionID - Optional session ID to scope Lean Turbo bypass to the current tool-execution context
 * @returns ReviewerGateResult with optional scope warning appended to reason
 */
export declare function checkReviewerGateWithScope(taskId: string, workingDirectory?: string, sessionID?: string): Promise<ReviewerGateResult>;
/**
 * Recovery mechanism: reconcile task state with delegation history.
 * When task-scoped reviewer/test_engineer delegations occurred but the state
 * machine was not advanced (e.g., toolAfter didn't fire or subagent_type was
 * missing), this function advances the task state so that checkReviewerGate can
 * make an accurate decision without attributing unrelated delegation activity.
 *
 * @param taskId - The task ID to recover state for
 */
export declare function recoverTaskStateFromDelegations(taskId: string): void;
/**
 * Result of the council-gate check used when transitioning to 'completed'.
 *
 * - When council.enabled is false, {blocked:false} is always returned (no regression).
 * - When council.enabled is true, requires evidence.gates.council to exist and
 *   its verdict to be APPROVE or CONCERNS. A missing gate or REJECT verdict blocks.
 */
export interface CouncilGateResult {
    blocked: boolean;
    reason: string;
}
/**
 * Check the council gate for a completion transition. Pure — reads config and
 * evidence only, no state mutation. Exported for focused unit testing.
 *
 * AND semantics (mirrors isCouncilGateActive in state.ts): the gate only
 * activates when BOTH pluginConfig.council.enabled === true AND the QA gate
 * profile for this plan has council_mode === true.  When council.enabled is
 * true but council_mode is false (or the profile is absent), the gate is
 * treated as inactive — the operator has disabled it at the profile level.
 *
 * @param workingDirectory - Validated project root (contains .swarm/evidence/)
 * @param taskId - Task ID in N.M or N.M.P format
 */
export declare function checkCouncilGate(workingDirectory: string, taskId: string): CouncilGateResult;
/**
 * Execute the update_task_status tool.
 * Validates the task_id and status, then updates the task status in the plan.
 * Uses file locking on plan.json to prevent concurrent writes from corrupting the plan.
 * Only one concurrent call wins the lock; others return success: false with recovery_guidance: "retry".
 * @param args - The update task status arguments
 * @param fallbackDir - Fallback working directory if args.working_directory is not provided
 * @param ctx - Optional ToolContext providing sessionID for Lean Turbo cross-session bypass prevention
 * @returns UpdateTaskStatusResult with success status and details
 */
export declare function executeUpdateTaskStatus(args: UpdateTaskStatusArgs, fallbackDir?: string, ctx?: ToolContext): Promise<UpdateTaskStatusResult>;
/**
 * Tool definition for update_task_status
 */
export declare const update_task_status: ToolDefinition;
