/**
 * Update task status tool for changing the status of individual tasks in a plan.
 * Allows agents to mark tasks as pending, in_progress, completed, or blocked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import type { TaskStatus } from '../config/plan-schema';
import { stripKnownSwarmPrefix } from '../config/schema';
import { getProfile } from '../db/qa-gate-profile.js';
import { readTaskEvidenceRaw } from '../gate-evidence.js';
import { validateDiffScope } from '../hooks/diff-scope';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { updateTaskStatus } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import {
	advanceTaskState,
	getTaskState,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	startAgentSession,
	swarmState,
} from '../state';
import { telemetry } from '../telemetry.js';
import { verifyLeanTurboTaskCompletion } from '../turbo/lean/task-completion';
import { validateTaskIdFormat as _validateTaskIdFormat } from '../validation/task-id';
import { createSwarmTool } from './create-tool';

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
 * Valid task status values
 */
const VALID_STATUSES: TaskStatus[] = [
	'pending',
	'in_progress',
	'completed',
	'blocked',
];

/**
 * Validate that the status is one of the allowed values.
 * @param status - The status to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validateStatus(status: string): string | undefined {
	if (!VALID_STATUSES.includes(status as TaskStatus)) {
		return `Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`;
	}
	return undefined;
}

/**
 * Validate that task_id matches the required format (N.M or N.M.P).
 * @param taskId - The task ID to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validateTaskId(taskId: string): string | undefined {
	const result = _validateTaskIdFormat(taskId);
	if (result) {
		// Preserve original error message format expected by callers
		return `Invalid task_id "${taskId}". Must match pattern N.M or N.M.P (e.g., "1.1", "1.2.3")`;
	}
	return undefined;
}

/**
 * Result from checking reviewer gate presence
 */
export interface ReviewerGateResult {
	blocked: boolean;
	reason: string;
}

/**
 * Tier 3 patterns that require full gate review even in Turbo Mode.
 * These are critical security-sensitive files that must always pass Stage B.
 */
const TIER_3_PATTERNS = [
	/^architect.*\.ts$/i,
	/^delegation.*\.ts$/i,
	/^guardrails.*\.ts$/i,
	/^adversarial.*\.ts$/i,
	/^sanitiz.*\.ts$/i,
	/^auth.*$/i,
	/^permission.*$/i,
	/^crypto.*$/i,
	/^secret.*$/i,
	/^security.*\.ts$/i,
];

/**
 * Check if any file in the list matches a Tier 3 pattern.
 * @param files - Array of file paths/names to check
 * @returns true if any file matches a Tier 3 pattern
 */
function matchesTier3Pattern(files: string[]): boolean {
	for (const file of files) {
		const fileName = path.basename(file);
		for (const pattern of TIER_3_PATTERNS) {
			if (pattern.test(fileName)) {
				return true;
			}
		}
	}
	return false;
}

function hasPassedDurableGateEvidence(
	workingDirectory: string,
	taskId: string,
): boolean {
	const evidence = readTaskEvidenceRaw(workingDirectory, taskId);
	if (
		!evidence ||
		!Array.isArray(evidence.required_gates) ||
		evidence.required_gates.length === 0
	) {
		return false;
	}
	return evidence.required_gates.every(
		(gate) => evidence.gates?.[gate] != null,
	);
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
export function checkReviewerGate(
	taskId: string,
	workingDirectory?: string,
	stageBParallelEnabled = false,
	sessionID?: string,
): ReviewerGateResult {
	try {
		// === Lean Turbo bypass check ===
		// If Lean Turbo is active and task is in a completed lane, bypass Stage B
		let skipStandardTurboBypass = false;
		if (hasActiveLeanTurbo()) {
			const resolvedDir = workingDirectory!;
			try {
				const leanCheck = verifyLeanTurboTaskCompletion(
					resolvedDir,
					taskId,
					sessionID,
				);
				if (leanCheck.ok) {
					return {
						blocked: false,
						reason: `Lean Turbo bypass: ${leanCheck.reason}`,
					};
				}
				// Only allow standard Turbo bypass if we CONFIRMED the task is NOT in any lane
				if (leanCheck.laneFound !== false) {
					// laneFound is true (in lane but not eligible) or undefined (state missing/unreadable)
					// Be conservative: skip standard Turbo bypass
					skipStandardTurboBypass = true;
				}
			} catch {
				// Lean Turbo check failed — be conservative and skip standard bypass
				skipStandardTurboBypass = true;
			}
		}
		if (!skipStandardTurboBypass && hasActiveTurboMode()) {
			// === Standard Turbo Mode bypass check ===
			// If Turbo Mode is active AND task does not touch Tier 3 patterns, bypass Stage B
			const resolvedDir = workingDirectory!;
			try {
				const planPath = path.join(resolvedDir, '.swarm', 'plan.json');
				const planRaw = fs.readFileSync(planPath, 'utf-8');
				const plan = JSON.parse(planRaw) as {
					phases: Array<{
						tasks: Array<{
							id: string;
							files_touched?: string[];
						}>;
					}>;
				};

				// Find the task and check its files_touched
				for (const planPhase of plan.phases ?? []) {
					for (const task of planPhase.tasks ?? []) {
						if (task.id === taskId && task.files_touched) {
							// If no Tier 3 patterns matched, bypass Stage B
							if (!matchesTier3Pattern(task.files_touched)) {
								return {
									blocked: false,
									reason: 'Turbo Mode bypass',
								};
							}
							// Task touches Tier 3 patterns - fall through to normal gate check
							break;
						}
					}
				}
			} catch {
				// plan.json missing or unreadable — fall through to normal gate check
			}
		}

		// === evidence-first check (durable, survives restarts) ===
		const resolvedDir = workingDirectory ?? process.cwd();
		// When the evidence file exists but gates are incomplete, save the reason and fall
		// through to session state instead of blocking immediately. Evidence recording can
		// fail silently (lock timeout, permission error, etc.) while the in-memory session
		// state is correctly advanced by the delegation hook. The session state and
		// delegation chain checks below then serve as the authoritative source.
		// Only when BOTH the evidence and the session state agree that gates are missing do
		// we return blocked — using the evidence reason for its more-specific message.
		let evidenceIncompleteReason: string | null = null;
		try {
			const evidence = readTaskEvidenceRaw(resolvedDir, taskId);

			if (evidence === null) {
				// No evidence file (ENOENT) — fall through to session state
			} else if (
				evidence.required_gates &&
				Array.isArray(evidence.required_gates) &&
				evidence.gates
			) {
				if (
					evidence.required_gates.length > 0 &&
					evidence.required_gates.every(
						(gate: string) => evidence.gates![gate] != null,
					)
				) {
					return { blocked: false, reason: '' };
				}
				// Evidence file shows incomplete gates — save the reason and fall through to
				// session state. The session state check below may still allow completion if
				// the delegation hook advanced state correctly (even if evidence recording
				// failed silently). Only block after all fallbacks are exhausted.
				const missingGates = evidence.required_gates.filter(
					(gate: string) => evidence.gates![gate] == null,
				);
				evidenceIncompleteReason =
					evidence.required_gates.length === 0
						? `Task ${taskId} has an evidence file with no required gates. Delegate reviewer and test_engineer before marking task as completed.`
						: `Task ${taskId} is missing required gates: [${missingGates.join(', ')}]. ` +
							`Required: [${evidence.required_gates.join(', ')}]. ` +
							`Completed: [${Object.keys(evidence.gates).join(', ')}]. ` +
							`Delegate the missing gate agents before marking task as completed.`;
			}
		} catch (error) {
			// Malformed JSON, permission error, or other non-ENOENT issue — BLOCK
			console.warn(
				`[gate-evidence] Evidence file for task ${taskId} is corrupt or unreadable:`,
				error instanceof Error ? error.message : String(error),
			);
			telemetry.gateFailed(
				'',
				'qa_gate',
				taskId,
				`Evidence file corrupt or unreadable`,
			);
			return {
				blocked: true,
				reason:
					`Evidence file for task ${taskId} is corrupt or unreadable. ` +
					`Fix the file at .swarm/evidence/${taskId}.json or delete it to fall through to session state.`,
			};
		}

		// === session state check (fallback for pre-evidence tasks) ===

		// If no active sessions, allow through only when no evidence file asserted
		// incomplete/invalid gate state. This preserves test-context behavior for
		// missing evidence while preventing empty evidence from vacuously passing.
		if (swarmState.agentSessions.size === 0 && !evidenceIncompleteReason) {
			return { blocked: false, reason: '' };
		}

		// Check each session for state machine state.
		// Skip sessions with corrupt/missing taskWorkflowStates — they cannot
		// make authoritative assertions about whether a task passed QA gates.
		let validSessionCount = 0;
		for (const [_sessionId, session] of swarmState.agentSessions) {
			if (!(session.taskWorkflowStates instanceof Map)) {
				continue; // Skip corrupt sessions
			}
			validSessionCount++;
			const state = getTaskState(session, taskId);

			// If task has reached tests_run or complete state, allow through
			if (state === 'tests_run' || state === 'complete') {
				return { blocked: false, reason: '' };
			}

			// PR 2 Stage B parallel barrier: both completion markers present is sufficient
			// even if state machine advancement was delayed (e.g., non-fatal exception
			// in toolAfter). Only active when flag is on.
			if (stageBParallelEnabled && hasBothStageBCompletions(session, taskId)) {
				return { blocked: false, reason: '' };
			}
		}

		// If all sessions had corrupt workflow state, allow through —
		// we cannot make a reliable gate assertion without valid state.
		if (validSessionCount === 0 && !evidenceIncompleteReason) {
			return { blocked: false, reason: '' };
		}

		// No session has this task in tests_run or complete state
		// Build a debug summary of current task state across all sessions
		const stateEntries: string[] = [];
		for (const [sessionId, session] of swarmState.agentSessions) {
			if (!(session.taskWorkflowStates instanceof Map)) continue;
			const state = getTaskState(session, taskId);
			stateEntries.push(`${sessionId}: ${state}`);
		}

		// Bug 3 fix: no session has this task in tests_run or complete state.
		// Trust plan.json restart recovery only when durable gate evidence proves
		// the required reviewer/test_engineer gates passed before completion.
		try {
			const resolvedDir = workingDirectory!;
			const planPath = path.join(resolvedDir, '.swarm', 'plan.json');
			const planRaw = fs.readFileSync(planPath, 'utf-8');
			const plan = JSON.parse(planRaw) as {
				phases: Array<{ tasks: Array<{ id: string; status: string }> }>;
			};
			for (const planPhase of plan.phases ?? []) {
				for (const task of planPhase.tasks ?? []) {
					if (
						task.id === taskId &&
						task.status === 'completed' &&
						hasPassedDurableGateEvidence(resolvedDir, taskId)
					) {
						return { blocked: false, reason: '' };
					}
				}
			}
		} catch {
			// plan.json missing or unreadable — fall through to blocked:true
		}

		// Final fallback: scan task-scoped delegation chains directly for reviewer+test_engineer.
		// This covers cases where:
		// - Session was restarted (in-memory state lost)
		// - toolAfter hook didn't fire (subagent_type not captured)
		{
			let hasReviewer = false;
			let hasTestEngineer = false;

			// Pass 1: task-scoped scan
			for (const [sessionId, chain] of swarmState.delegationChains) {
				const session = swarmState.agentSessions.get(sessionId);
				if (
					session &&
					(session.currentTaskId === taskId ||
						session.lastCoderDelegationTaskId === taskId)
				) {
					for (const delegation of chain) {
						const target = stripKnownSwarmPrefix(delegation.to);
						if (target === 'reviewer') hasReviewer = true;
						if (target === 'test_engineer') hasTestEngineer = true;
					}
				}
			}

			// If both reviewer and test_engineer are confirmed in delegation chains, allow through
			if (hasReviewer && hasTestEngineer) {
				return { blocked: false, reason: '' };
			}
		}

		const currentStateStr =
			stateEntries.length > 0 ? stateEntries.join(', ') : 'no active sessions';

		// Build delegation chain summary for this task
		const chainEntries: string[] = [];
		for (const [sessionId, chain] of swarmState.delegationChains) {
			const session = swarmState.agentSessions.get(sessionId);
			if (
				session &&
				(session.currentTaskId === taskId ||
					session.lastCoderDelegationTaskId === taskId)
			) {
				const targets = chain.map((d) => stripKnownSwarmPrefix(d.to));
				chainEntries.push(`${sessionId}: [${targets.join(', ')}]`);
			}
		}
		const chainSummary =
			chainEntries.length > 0
				? chainEntries.join('; ')
				: 'no chains for this task';

		// Count sessions that were rehydrated from snapshot
		const rehydratedSessionCount = [
			...swarmState.agentSessions.values(),
		].filter((s) => s.sessionRehydratedAt > 0).length;

		// Always include structured diagnostics with evidence detail embedded.
		const finalReason = [
			`Task ${taskId} has not passed QA gates.`,
			`  Session states: [${currentStateStr}].`,
			`  Delegation chains: [${chainSummary}].`,
			`  Evidence: [${evidenceIncompleteReason ?? 'no evidence file found'}].`,
			`  Rehydrated sessions: ${rehydratedSessionCount}.`,
			`  Missing required state: tests_run or complete.`,
		].join('\n');
		telemetry.gateFailed(
			'',
			'qa_gate',
			taskId,
			evidenceIncompleteReason
				? `Missing gates: evidence incomplete`
				: `Missing state: tests_run or complete`,
		);
		return {
			blocked: true,
			reason: finalReason,
		};
	} catch {
		// If state inspection throws, allow through
		return { blocked: false, reason: '' };
	}
}

/**
 * Wrapper around checkReviewerGate that appends a diff-scope advisory warning.
 * Keeps checkReviewerGate synchronous for backward compatibility.
 * Stage B parallel is hardcoded (not config-driven).
 * @param taskId - The task ID to check gate state for
 * @param workingDirectory - Optional working directory for plan.json fallback
 * @param sessionID - Optional session ID to scope Lean Turbo bypass to the current tool-execution context
 * @returns ReviewerGateResult with optional scope warning appended to reason
 */
export async function checkReviewerGateWithScope(
	taskId: string,
	workingDirectory?: string,
	sessionID?: string,
): Promise<ReviewerGateResult> {
	// Stage B is always parallel — hardcoded, not config-driven.
	const stageBParallelEnabled = true;
	const result = checkReviewerGate(
		taskId,
		workingDirectory,
		stageBParallelEnabled,
		sessionID,
	);
	const scopeWarning = await validateDiffScope(taskId, workingDirectory!).catch(
		() => null,
	);
	if (!scopeWarning) return result;
	return {
		...result,
		reason: result.reason ? `${result.reason}\n${scopeWarning}` : scopeWarning,
	};
}

/**
 * Recovery mechanism: reconcile task state with delegation history.
 * When task-scoped reviewer/test_engineer delegations occurred but the state
 * machine was not advanced (e.g., toolAfter didn't fire or subagent_type was
 * missing), this function advances the task state so that checkReviewerGate can
 * make an accurate decision without attributing unrelated delegation activity.
 *
 * Falls back to reading durable evidence files when delegation chains are empty
 * (e.g., after a crash or session restart without snapshot). This ensures
 * recovery works even when no in-memory delegation history exists.
 *
 * @param taskId - The task ID to recover state for
 * @param directory - Optional project directory for evidence file fallback
 */
export function recoverTaskStateFromDelegations(
	taskId: string,
	directory?: string,
): void {
	let hasReviewer = false;
	let hasTestEngineer = false;

	// Pass 1 (task-scoped): scan only sessions explicitly associated with this task.
	// This is the authoritative path — covers normal coder→reviewer→test_engineer flows.
	for (const [sessionId, chain] of swarmState.delegationChains) {
		const session = swarmState.agentSessions.get(sessionId);
		if (
			session &&
			(session.currentTaskId === taskId ||
				session.lastCoderDelegationTaskId === taskId)
		) {
			for (const delegation of chain) {
				const target = stripKnownSwarmPrefix(delegation.to);
				if (target === 'reviewer') hasReviewer = true;
				if (target === 'test_engineer') hasTestEngineer = true;
			}
		}
	}

	// Fallback 2: Check durable evidence files when delegation chains yield nothing.
	// This covers crash recovery where in-memory delegation history is lost but
	// evidence files on disk prove the QA cycle completed.
	if ((!hasReviewer || !hasTestEngineer) && directory) {
		try {
			const evidence = readTaskEvidenceRaw(directory, taskId);
			if (
				evidence &&
				evidence.gates &&
				Array.isArray(evidence.required_gates)
			) {
				if (evidence.gates.reviewer != null) hasReviewer = true;
				if (evidence.gates.test_engineer != null) hasTestEngineer = true;
			}
		} catch {
			// Evidence file corrupt or unreadable — non-fatal, delegation chain
			// result (or lack thereof) stands
		}
	}

	if (!hasReviewer && !hasTestEngineer) return;

	// Session seeding: ensure at least one session exists before advancing state.
	// After a crash or fresh start, agentSessions may be empty, making the
	// advancement loop below a no-op. Create a minimal recovery session so that
	// evidence-backed recovery actually takes effect.
	if (swarmState.agentSessions.size === 0) {
		try {
			startAgentSession('recovery-session', 'architect');
		} catch {
			// Non-fatal: session seeding failed, state advancement will be a no-op
		}
	}

	// Advance the specific task state in all sessions
	for (const [, session] of swarmState.agentSessions) {
		if (!(session.taskWorkflowStates instanceof Map)) continue;

		const currentState = getTaskState(session, taskId);

		// Already at or past tests_run — nothing to recover
		if (currentState === 'tests_run' || currentState === 'complete') continue;

		// Seed from idle if the task was never explicitly set to in_progress
		if (hasReviewer && currentState === 'idle') {
			try {
				advanceTaskState(session, taskId, 'coder_delegated');
			} catch {
				/* non-fatal */
			}
		}

		// Advance coder_delegated/pre_check_passed → reviewer_run
		if (hasReviewer) {
			const stateNow = getTaskState(session, taskId);
			if (stateNow === 'coder_delegated' || stateNow === 'pre_check_passed') {
				try {
					advanceTaskState(session, taskId, 'reviewer_run');
				} catch {
					/* non-fatal */
				}
			}
		}

		// Advance reviewer_run → tests_run
		if (hasTestEngineer) {
			const stateNow = getTaskState(session, taskId);
			if (stateNow === 'reviewer_run') {
				try {
					advanceTaskState(session, taskId, 'tests_run');
				} catch {
					/* non-fatal */
				}
			}
		}
	}
}

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
export function checkCouncilGate(
	workingDirectory: string,
	taskId: string,
): CouncilGateResult {
	let councilEnabled = false;
	let effectiveMinimum = 3;
	try {
		const config = loadPluginConfig(workingDirectory);
		councilEnabled = config.council?.enabled === true;
		// Mirror the runtime fast-path quorum policy. Pre-fix evidence files
		// without quorumSize default to 1 (rehydrated as 1 elsewhere) and must
		// fail the same quorum gate when read from disk here.
		effectiveMinimum = config.council?.requireAllMembers
			? 5
			: (config.council?.minimumMembers ?? 3);
	} catch {
		// Config load failure — treat council as disabled (no regression)
		return { blocked: false, reason: '' };
	}

	if (!councilEnabled) {
		return { blocked: false, reason: '' };
	}

	// AND gate: also require council_mode === true in the QA gate profile.
	// This matches the isCouncilGateActive semantics in state.ts.  When
	// council.enabled is true but council_mode is false (the default), the
	// feature is intentionally off at the plan level — do not block.
	try {
		const planPath = path.join(workingDirectory, '.swarm', 'plan.json');
		const planRaw = fs.readFileSync(planPath, 'utf-8');
		const planObj = JSON.parse(planRaw) as { swarm?: string; title?: string };
		if (planObj.swarm && planObj.title) {
			const planId = derivePlanId(planObj as { swarm: string; title: string });
			const profile = getProfile(workingDirectory, planId);
			if (!profile || !profile.gates.council_mode) {
				return { blocked: false, reason: '' };
			}
		}
	} catch {
		// plan.json missing, unreadable, or profile DB absent — fall back to
		// treating the gate as inactive (no regression; same as isCouncilGateActive).
		return { blocked: false, reason: '' };
	}

	let evidence: ReturnType<typeof readTaskEvidenceRaw>;
	try {
		evidence = readTaskEvidenceRaw(workingDirectory, taskId);
	} catch {
		// Corrupt evidence — let the existing gate loop / downstream checks handle
		return {
			blocked: true,
			reason:
				'council gate required but not yet run — architect must call submit_council_verdicts before advancing this task',
		};
	}

	const councilGate = evidence?.gates?.council as
		| { verdict?: string; quorumSize?: number }
		| undefined;
	if (!councilGate) {
		return {
			blocked: true,
			reason:
				'council gate required but not yet run — architect must call submit_council_verdicts before advancing this task',
		};
	}

	if (councilGate.verdict === 'REJECT') {
		return {
			blocked: true,
			reason:
				'council gate blocked advancement — resolve requiredFixes and re-run submit_council_verdicts',
		};
	}

	// Quorum guard for the disk-evidence path. Mirrors the in-memory
	// fast-path check at state.ts (advanceTaskState). Legacy evidence without
	// quorumSize is treated as 1 — conservative default that forces a fresh
	// council run rather than trusting an unverified single-member APPROVE.
	const rawQuorumSize = councilGate.quorumSize;
	const quorumSize =
		typeof rawQuorumSize === 'number' &&
		Number.isFinite(rawQuorumSize) &&
		rawQuorumSize >= 1
			? rawQuorumSize
			: 1;
	if (quorumSize < effectiveMinimum) {
		return {
			blocked: true,
			reason: `council gate blocked advancement — recorded verdict has insufficient quorum (${quorumSize} of ${effectiveMinimum} required members). Re-run submit_council_verdicts with the missing council members.`,
		};
	}

	// APPROVE or CONCERNS with sufficient quorum → allow
	return { blocked: false, reason: '' };
}

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
export async function executeUpdateTaskStatus(
	args: UpdateTaskStatusArgs,
	fallbackDir?: string,
	ctx?: ToolContext,
): Promise<UpdateTaskStatusResult> {
	// Step 1: Validate status
	const statusError = validateStatus(args.status);
	if (statusError) {
		return {
			success: false,
			message: 'Validation failed',
			errors: [statusError],
		};
	}

	// Step 2: Validate task_id format
	const taskIdError = validateTaskId(args.task_id);
	if (taskIdError) {
		return {
			success: false,
			message: 'Validation failed',
			errors: [taskIdError],
		};
	}

	// Seed the task state machine: when transitioning to in_progress, advance idle → coder_delegated
	// Also synchronize session task identity fields so later gate recording uses the correct task
	if (args.status === 'in_progress') {
		for (const [_sessionId, session] of swarmState.agentSessions) {
			const currentState = getTaskState(session, args.task_id);
			if (currentState === 'idle') {
				try {
					advanceTaskState(session, args.task_id, 'coder_delegated');
				} catch {
					// Non-fatal: session may not support state advancement
				}
			}
			// Synchronize active task identity for durable gate recording
			session.currentTaskId = args.task_id;
		}
	}

	// Step 3: Validate working_directory if provided (must be before reviewer gate check)
	let normalizedDir: string | undefined;
	let directory: string;

	if (args.working_directory != null) {
		// Check for null-byte injection before any processing
		if (args.working_directory.includes('\0')) {
			return {
				success: false,
				message: 'Invalid working_directory: null bytes are not allowed',
			};
		}

		// Check for Windows device paths (e.g., \\.\C:\, \\?\GLOBALROOT\, UNC paths)
		// Applied on all platforms for defense-in-depth (paths may originate from Windows clients)
		{
			const devicePathPattern =
				/^\\\\|^(NUL|CON|AUX|COM[1-9]|LPT[1-9])(\..*)?$/i;
			if (devicePathPattern.test(args.working_directory)) {
				return {
					success: false,
					message:
						'Invalid working_directory: Windows device paths are not allowed',
				};
			}
		}

		// Normalize path first
		normalizedDir = path.normalize(args.working_directory);

		// Check for path traversal sequences
		const pathParts = normalizedDir.split(path.sep);
		if (pathParts.includes('..')) {
			return {
				success: false,
				message:
					'Invalid working_directory: path traversal sequences (..) are not allowed',
				errors: [
					'Invalid working_directory: path traversal sequences (..) are not allowed',
				],
			};
		}

		// Check if directory exists on disk and contains a valid .swarm/plan.json
		// Use path.resolve to properly resolve the path before checking existence
		// Use a carefully crafted path to avoid Windows path quirks
		const resolvedDir = path.resolve(normalizedDir);

		// Additional check: verify the resolved path is within the expected workspace
		// This prevents Windows from interpreting certain paths as valid
		try {
			const realPath = fs.realpathSync(resolvedDir);
			const planPath = path.join(realPath, '.swarm', 'plan.json');
			if (!fs.existsSync(planPath)) {
				return {
					success: false,
					message: `Invalid working_directory: plan not found in "${realPath}"`,
					errors: [
						`Invalid working_directory: plan not found in "${realPath}"`,
					],
				};
			}
			// Use realPath as the validated directory
			directory = realPath;
		} catch {
			return {
				success: false,
				message: `Invalid working_directory: path "${resolvedDir}" does not exist or is inaccessible`,
				errors: [
					`Invalid working_directory: path "${resolvedDir}" does not exist or is inaccessible`,
				],
			};
		}
	} else {
		// No working_directory provided, use fallbackDir from createSwarmTool
		if (!fallbackDir) {
			return {
				success: false,
				message: 'No working_directory provided and fallbackDir is undefined',
				errors: ['Cannot resolve directory for task status update'],
			};
		}
		directory = fallbackDir;
	}

	// Write minimal gate-tracking evidence to persist across session restarts.
	// Placed AFTER directory validation so we only write under the validated workspace.
	if (args.status === 'in_progress') {
		try {
			const evidencePath = path.join(
				directory,
				'.swarm',
				'evidence',
				`${args.task_id}.json`,
			);
			fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
			// Atomic create: use wx flag to fail if file already exists (no TOCTOU race)
			const fd = fs.openSync(evidencePath, 'wx');
			let writeOk = false;
			try {
				fs.writeSync(
					fd,
					JSON.stringify(
						{
							taskId: args.task_id,
							required_gates: ['reviewer', 'test_engineer'],
							gates: {},
						},
						null,
						2,
					),
				);
				writeOk = true;
			} finally {
				fs.closeSync(fd);
				// Remove partial/empty file on write failure to avoid a permanently broken gate file
				if (!writeOk) {
					try {
						fs.unlinkSync(evidencePath);
					} catch {
						/* best-effort cleanup */
					}
				}
			}
		} catch {
			/* Advisory only — EEXIST (file already exists) or other errors never block status update */
		}
	}

	// State machine check: task must have reached tests_run or complete state
	// Uses the validated directory for plan.json fallback resolution
	if (args.status === 'completed') {
		// Recovery: reconcile task state with delegation history before gate check.
		// This handles cases where the delegation-gate toolAfter hook did not
		// advance the state (missing subagent_type, cross-session gaps, pure
		// verification tasks without coder delegation, etc.).
		recoverTaskStateFromDelegations(args.task_id, directory);

		// Check if the phase requires reviewer — non-code phases (acceptance, docs) may not
		let phaseRequiresReviewer = true;
		try {
			const planPath = path.join(directory, '.swarm', 'plan.json');
			const planRaw = fs.readFileSync(planPath, 'utf-8');
			const plan: {
				phases: Array<{
					id: number;
					tasks: Array<{ id: string }>;
					required_agents?: string[];
				}>;
			} = JSON.parse(planRaw);
			const taskPhase = plan.phases.find((p) =>
				p.tasks.some((t) => t.id === args.task_id),
			);
			if (
				taskPhase?.required_agents &&
				!taskPhase.required_agents.includes('reviewer')
			) {
				phaseRequiresReviewer = false;
			}
		} catch {
			// plan.json missing or unreadable — default to requiring reviewer
		}

		if (phaseRequiresReviewer) {
			const reviewerCheck = await checkReviewerGateWithScope(
				args.task_id,
				directory,
				ctx?.sessionID,
			);
			if (reviewerCheck.blocked) {
				return {
					success: false,
					message:
						'Gate check failed: reviewer delegation required before marking task as completed',
					errors: [reviewerCheck.reason],
				};
			}
		}
	}

	// Step 4: Update the task status with file lock to prevent concurrent writes
	const lockTaskId = `update-task-status-${args.task_id}-${Date.now()}`;
	const planFilePath = 'plan.json';
	// Derive agent from swarmState session context, fallback to 'update-task-status' sentinel
	let agentName = 'update-task-status';
	for (const [, agent] of swarmState.activeAgent) {
		agentName = agent;
		break; // Use first active agent found
	}
	let lockResult: Awaited<ReturnType<typeof tryAcquireLock>> | undefined;
	try {
		lockResult = await tryAcquireLock(
			directory,
			planFilePath,
			agentName,
			lockTaskId,
		);
	} catch (error) {
		return {
			success: false,
			message: 'Failed to acquire lock for task status update',
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
	if (!lockResult.acquired) {
		return {
			success: false,
			message: `Task status write blocked: plan.json is locked by ${lockResult.existing?.agent ?? 'another agent'} (task: ${lockResult.existing?.taskId ?? 'unknown'})`,
			errors: [
				'Concurrent plan write detected — retry after the current write completes',
			],
			recovery_guidance:
				'Wait a moment and retry update_task_status. The lock will expire automatically if the holding agent fails.',
		};
	}
	try {
		const updatedPlan = await updateTaskStatus(
			directory,
			args.task_id,
			args.status as TaskStatus,
		);

		if (args.status === 'completed') {
			for (const [_sessionId, session] of swarmState.agentSessions) {
				if (!(session.taskWorkflowStates instanceof Map)) {
					continue;
				}

				const currentState = getTaskState(session, args.task_id);
				if (currentState === 'tests_run') {
					try {
						advanceTaskState(session, args.task_id, 'complete');
					} catch {
						// Non-fatal: do not fail task status update on state sync issues
					}
				}
			}
		}

		return {
			success: true,
			message: 'Task status updated successfully',
			task_id: args.task_id,
			new_status: args.status,
			current_phase: updatedPlan.current_phase,
		};
	} catch (error) {
		// Lock will be released in finally block
		return {
			success: false,
			message: 'Failed to update task status',
			errors: [error instanceof Error ? error.message : String(error)],
		} as UpdateTaskStatusResult;
	} finally {
		if (lockResult?.acquired && lockResult.lock._release) {
			try {
				await lockResult.lock._release();
			} catch (releaseError) {
				// Log but don't propagate - original error/context takes precedence
				console.error(
					'[update-task-status] Lock release failed:',
					releaseError,
				);
			}
		}
	}
}

/**
 * Tool definition for update_task_status
 */
export const update_task_status: ToolDefinition = createSwarmTool({
	description:
		'Update the status of a specific task in the implementation plan. ' +
		'Task status can be one of: pending, in_progress, completed, blocked.',
	args: {
		task_id: z
			.string()
			.min(1)
			.regex(/^\d+\.\d+(\.\d+)*$/, 'Task ID must be in N.M or N.M.P format')
			.describe('Task ID in N.M format, e.g. "1.1", "1.2.3"'),
		status: z
			.enum(['pending', 'in_progress', 'completed', 'blocked'])
			.describe(
				'New status for the task: pending, in_progress, completed, or blocked',
			),
		working_directory: z
			.string()
			.optional()
			.describe('Working directory where the plan is located'),
	},
	execute: async (args: unknown, _directory: string, _ctx?: ToolContext) => {
		return JSON.stringify(
			await executeUpdateTaskStatus(
				args as UpdateTaskStatusArgs,
				_directory,
				_ctx,
			),
			null,
			2,
		);
	},
});
