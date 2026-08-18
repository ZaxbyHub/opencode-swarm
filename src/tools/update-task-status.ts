/**
 * Update task status tool for changing the status of individual tasks in a plan.
 * Allows agents to mark tasks as pending, in_progress, completed, or blocked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import type { RuntimePlan, TaskStatus } from '../config/plan-schema';
import { stripKnownSwarmPrefix } from '../config/schema';
import { getProfileLookupForIdentity } from '../db/qa-gate-profile.js';
import type { transitionTaskWorkflowEvidence } from '../gate-evidence.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidenceRaw,
} from '../gate-evidence.js';
import { validateDiffScope } from '../hooks/diff-scope';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { matchesTier3 } from '../parallel/tier3-classifier.js';
import { loadPlan, updateTaskStatus } from '../plan/manager';
import { formatLegacyQaBindingRecovery } from '../qa-gate/recovery.js';
import {
	recordTaskAttempt,
	type TaskAttemptInput,
} from '../services/run-memory.js';
import {
	advanceTaskState,
	ensureAgentSession,
	getTaskState,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	recordStageBCompletion,
	startAgentSession,
	swarmState,
	updateTaskWorkflowCache,
} from '../state';
import {
	type ReviewerGateEvidenceKind,
	type ReviewerGateReasonCode,
	telemetry,
} from '../telemetry.js';
import { verifyLeanTurboTaskCompletion } from '../turbo/lean/task-completion';
import * as logger from '../utils/logger.js';
import {
	assertProjectRoot,
	hasExplicitProjectBoundary,
	isStrictPathDescendant,
} from '../utils/project-boundary';
import { validateTaskIdFormat as _validateTaskIdFormat } from '../validation/task-id';
import { recoverCoderSettlement } from '../workflow/coder-settlement.js';
import {
	recoverPreparedTaskRepair,
	recoverPreparedTaskRepairUnderPlanLock,
	repairTaskWorkflowUnderPlanLock,
} from '../workflow/task-repair.js';
import {
	commitTaskTerminalUnderPlanLock,
	recoverPreparedTaskTerminal,
	recoverPreparedTaskTerminalUnderPlanLock,
} from '../workflow/task-terminal.js';
import { readWorkflowWalFile } from '../workflow/workflow-wal-file.js';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

/**
 * Internal seams for test injection.
 * Tests should save/restore these in beforeEach/afterEach rather than using
 * module-scope vi.mock, which leaks across files in Bun's shared test runner.
 */
export const _internals = {
	tryAcquireLock,
	updateTaskStatus,
	resolveWorkingDirectory,
	loadPlan,
	readTaskEvidenceRaw,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	verifyLeanTurboTaskCompletion,
	hasPassedDurableGateEvidence,
	emitReviewerGateDecision: telemetry.reviewerGateDecision,
	recordTaskAttempt,
};

/**
 * Record a task outcome to run memory without ever changing the tool's result.
 *
 * `recordTaskAttempt` is fail-open by contract, but this wrapper must not
 * depend on that: it is reached through the `_internals` DI seam, which a test
 * (or future caller) can replace with something that throws. Both remaining
 * call sites are the gate-block paths below, and both sit outside any try
 * block, so without this catch a throw would turn a clean "gate blocked"
 * result into a rejected tool call. Terminal outcomes are not recorded here —
 * see `plan/manager.updateTaskStatus`.
 */
async function recordRunMemoryOutcome(
	directory: string,
	input: TaskAttemptInput,
): Promise<void> {
	try {
		await _internals.recordTaskAttempt(directory, input);
	} catch (_error) {
		// Advisory-only — run-memory bookkeeping never alters the tool result.
	}
}

function syncCallerWorkflowFromEvidence(
	sessionId: string | undefined,
	taskId: string,
	evidence: ReturnType<typeof readTaskEvidenceRaw>,
): void {
	if (!sessionId) return;
	const callerSession = ensureAgentSession(sessionId);
	const workflow = getTaskWorkflowSnapshot(evidence);
	callerSession.taskWorkflowStates.set(taskId, workflow.state);
	callerSession.stageBCompletion?.delete(taskId);
	callerSession.taskCouncilApproved?.delete(taskId);
	callerSession.taskCouncilWorkflowGeneration?.delete(taskId);
	updateTaskWorkflowCache(callerSession, taskId, workflow);
}

async function hasPreparedWorkflowWal(
	directory: string,
	taskId: string,
	kind: 'task-repair' | 'task-terminal',
): Promise<boolean> {
	return (await readPreparedWorkflowWal(directory, taskId, kind)) !== null;
}

async function readPreparedWorkflowWal(
	directory: string,
	taskId: string,
	kind: 'task-repair' | 'task-terminal',
) {
	const walPath = validateSwarmPath(
		directory,
		kind === 'task-repair'
			? `task-repairs/${taskId}.json`
			: `task-terminals/${taskId}.json`,
	);
	const wal = await readWorkflowWalFile(kind, walPath, taskId);
	return wal?.state === 'PREPARED' ? wal : null;
}

/**
 * Resolve the task's `files_touched` from a loaded plan, for the run-memory
 * fingerprint (so the same task ID against a different file set is
 * distinguishable across plans). Used only by the gate-block paths below;
 * terminal outcomes are recorded in `plan/manager.updateTaskStatus`.
 */
function resolveRunMemoryFileTargets(
	plan: RuntimePlan | null,
	taskId: string,
): string[] {
	return (
		plan?.phases
			.flatMap((phase) => phase.tasks)
			.find((candidate) => candidate.id === taskId)?.files_touched ?? []
	);
}

/**
 * Arguments for the update_task_status tool
 */
export interface UpdateTaskStatusArgs {
	task_id: string;
	status: string;
	working_directory?: string;
	force?: boolean;
	expected_state?: string;
	expected_generation?: number;
	target_state?: 'idle';
	reason?: string;
	transition_id?: string;
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

function getSettledTransitionRejection(
	taskId: string,
	currentStatus: TaskStatus,
	nextStatus: string,
	force: boolean | undefined,
): UpdateTaskStatusResult | null {
	if (
		currentStatus !== 'pending' &&
		currentStatus !== 'in_progress' &&
		nextStatus !== currentStatus
	) {
		if (nextStatus !== 'in_progress' || force !== true) {
			return {
				success: false,
				message: `Task ${taskId} is settled (${currentStatus}); backward transitions require the audited in_progress repair path.`,
				errors: [
					`Task ${taskId} is settled (${currentStatus}); use force:true with exact CAS and audit fields to repair it to in_progress.`,
				],
			};
		}
	}
	return null;
}

function isRepairRetryShape(args: UpdateTaskStatusArgs): boolean {
	return (
		args.status === 'in_progress' &&
		args.force === true &&
		typeof args.transition_id === 'string'
	);
}

/**
 * Result from checking reviewer gate presence
 */
export interface ReviewerGateResult {
	blocked: boolean;
	reason: string;
	requiredGates?: string[];
	satisfiedGates?: string[];
	missingGates?: string[];
	source?: 'durable_exact_task' | 'legacy_compat' | 'turbo_policy';
	corrupt?: boolean;
	contradictorySignals?: string[];
	generation?: number;
	nextAction?: string;
}

/**
 * Emit one reason-coded terminal reviewer-gate decision without allowing
 * telemetry failures to change the pre-existing gate result.
 */
function reviewerGateDecision(
	taskId: string,
	sessionID: string | undefined,
	result: ReviewerGateResult,
	reasonCode: ReviewerGateReasonCode,
	evidenceKind: ReviewerGateEvidenceKind,
): ReviewerGateResult {
	try {
		_internals.emitReviewerGateDecision(
			sessionID ?? '',
			taskId,
			result.blocked,
			reasonCode,
			evidenceKind,
		);
	} catch (_error) {
		// Reviewer-gate telemetry is observational and must remain fail-open.
	}
	return result;
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
	fallbackDir?: string,
): ReviewerGateResult {
	try {
		// === Lean Turbo bypass check ===
		// If Lean Turbo is active and task is in a completed lane, bypass Stage B
		let skipStandardTurboBypass = false;
		if (
			!fallbackDir &&
			!sessionID &&
			_internals.hasActiveLeanTurbo(sessionID)
		) {
			const resolvedDir = workingDirectory!;
			try {
				const leanCheck = _internals.verifyLeanTurboTaskCompletion(
					resolvedDir,
					taskId,
					sessionID,
				);
				if (leanCheck.ok) {
					return reviewerGateDecision(
						taskId,
						sessionID,
						{
							blocked: false,
							reason: `Lean Turbo bypass: ${leanCheck.reason}`,
						},
						'lean_turbo_completed_lane',
						'fallback',
					);
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
		if (
			!fallbackDir &&
			!sessionID &&
			!skipStandardTurboBypass &&
			_internals.hasActiveTurboMode(sessionID)
		) {
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
							if (!matchesTier3(task.files_touched)) {
								return reviewerGateDecision(
									taskId,
									sessionID,
									{
										blocked: false,
										reason: 'Turbo Mode bypass',
									},
									'standard_turbo_non_tier3',
									'fallback',
								);
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

		// Runtime decisions are exact-task and durable. Session maps and delegation
		// chains remain diagnostics only and may not satisfy or poison this gate.
		// The compatibility fallbacks below are reachable only for legacy direct
		// callers that provide no resolvable workspace at all.
		let authoritativeDir: string | undefined;
		if (fallbackDir) {
			const resolved = _internals.resolveWorkingDirectory(
				workingDirectory,
				fallbackDir,
			);
			authoritativeDir = resolved.success ? resolved.directory : fallbackDir;
		} else if (workingDirectory) {
			authoritativeDir = workingDirectory;
		}
		if (authoritativeDir) {
			const legacyDirectCaller = Symbol('legacy-direct-reviewer-gate');
			try {
				const evidence = _internals.readTaskEvidenceRaw(
					authoritativeDir,
					taskId,
				);
				// Runtime completion always supplies fallbackDir and therefore always
				// uses exact-task evidence. Preserve the historical direct helper API
				// only for legacy tests/extensions until they write the workflow marker.
				if (!fallbackDir && !sessionID && !evidence?.workflow)
					throw legacyDirectCaller;
				if (!evidence) {
					return reviewerGateDecision(
						taskId,
						sessionID,
						{
							blocked: true,
							reason: `Task ${taskId} has no exact-task QA evidence. Delegate the required Stage B agents, then retry completion.`,
							requiredGates: [],
							satisfiedGates: [],
							missingGates: ['reviewer', 'test_engineer'],
							source: 'durable_exact_task',
							generation: 0,
							nextAction:
								'Delegate reviewer and test_engineer for this exact task generation.',
						},
						'required_gates_missing',
						'block',
					);
				}
				if (!evidence.workflow) {
					return reviewerGateDecision(
						taskId,
						sessionID,
						{
							blocked: true,
							reason: `Task ${taskId} has legacy QA evidence without an authoritative workflow generation. Run a fresh exact-task workflow transition before completion.`,
							requiredGates: [...evidence.required_gates],
							satisfiedGates: Object.keys(evidence.gates),
							missingGates: [...evidence.required_gates],
							source: 'durable_exact_task',
							generation: 0,
							nextAction:
								'Re-run the exact-task coder/Stage A/Stage B workflow to migrate evidence.',
						},
						'required_gates_missing',
						'block',
					);
				}
				const workflow = getTaskWorkflowSnapshot(evidence);
				const requiredGates = [...evidence.required_gates];
				const satisfiedGates = requiredGates.filter(
					(gate) => evidence.gates[gate] != null,
				);
				const missingGates = requiredGates.filter(
					(gate) => evidence.gates[gate] == null,
				);
				if (evidence.gates.pre_check == null) missingGates.unshift('pre_check');
				const contradictorySignals: string[] = [];
				if (
					(workflow.state === 'tests_run' || workflow.state === 'complete') &&
					missingGates.length > 0
				) {
					contradictorySignals.push(
						`workflow state ${workflow.state} claims completion readiness while required proof is missing`,
					);
				}
				if (
					workflow.state !== 'tests_run' &&
					workflow.state !== 'complete' &&
					evidence.gates.pre_check != null &&
					requiredGates.length > 0 &&
					missingGates.length === 0
				) {
					contradictorySignals.push(
						`all required proof exists but workflow state is ${workflow.state}`,
					);
				}
				const workflowComplete =
					workflow.state === 'tests_run' || workflow.state === 'complete';
				if (
					requiredGates.length > 0 &&
					missingGates.length === 0 &&
					contradictorySignals.length === 0 &&
					workflowComplete
				) {
					return reviewerGateDecision(
						taskId,
						sessionID,
						{
							blocked: false,
							reason: '',
							requiredGates,
							satisfiedGates,
							missingGates,
							contradictorySignals,
							source: 'durable_exact_task',
							generation: workflow.generation,
						},
						'durable_evidence_complete',
						'genuine',
					);
				}
				return reviewerGateDecision(
					taskId,
					sessionID,
					{
						blocked: true,
						reason: `Task ${taskId} generation ${workflow.generation} has not passed exact-task QA. State: ${workflow.state}. Missing gates: [${missingGates.join(', ')}]. Contradictions: [${contradictorySignals.join('; ')}].`,
						requiredGates,
						satisfiedGates,
						missingGates,
						contradictorySignals,
						source: 'durable_exact_task',
						generation: workflow.generation,
						nextAction:
							workflow.state === 'rework_required'
								? 'Delegate the same task to coder for repair, then rerun Stage A and Stage B.'
								: 'Complete the missing exact-task Stage A/Stage B transitions.',
					},
					'required_gates_missing',
					'block',
				);
			} catch (error) {
				if (error === legacyDirectCaller) {
					// Continue into the bounded legacy compatibility path below.
				} else {
					return reviewerGateDecision(
						taskId,
						sessionID,
						{
							blocked: true,
							reason: `Evidence file for task ${taskId} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
							requiredGates: [],
							satisfiedGates: [],
							missingGates: ['reviewer', 'test_engineer'],
							source: 'durable_exact_task',
							corrupt: true,
							nextAction: `Repair .swarm/evidence/${taskId}.json; corrupt evidence fails closed.`,
						},
						'corrupt_evidence',
						'data_quality',
					);
				}
			}
		}

		// === evidence-first check (durable, survives restarts) ===
		let resolvedDir: string | undefined;
		if (fallbackDir) {
			const resolveResult = _internals.resolveWorkingDirectory(
				workingDirectory,
				fallbackDir,
			);
			if (resolveResult.success) {
				resolvedDir = resolveResult.directory;
			} else {
				// resolveWorkingDirectory failed — use only the trusted fallbackDir
				resolvedDir = fallbackDir;
			}
		} else if (workingDirectory) {
			// No injected fallbackDir — use workingDirectory directly for backward compat
			// (test callers that pass tmpDir as workingDirectory)
			resolvedDir = workingDirectory;
		}
		// When the evidence file exists but gates are incomplete, save the reason and fall
		// through to session state instead of blocking immediately. Evidence recording can
		// fail silently (lock timeout, permission error, etc.) while the in-memory session
		// state is correctly advanced by the delegation hook. The session state and
		// delegation chain checks below then serve as the authoritative source.
		// Only when BOTH the evidence and the session state agree that gates are missing do
		// we return blocked — using the evidence reason for its more-specific message.
		let evidenceIncompleteReason: string | null = null;
		try {
			if (!resolvedDir) {
				// No safe directory for evidence lookup — skip to session state
			} else {
				const evidence = _internals.readTaskEvidenceRaw(resolvedDir, taskId);

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
						return reviewerGateDecision(
							taskId,
							sessionID,
							{ blocked: false, reason: '' },
							'durable_evidence_complete',
							'genuine',
						);
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
			}
		} catch (error) {
			// Malformed JSON, permission error, or other non-ENOENT issue — BLOCK
			logger.log(
				`[gate-evidence] Evidence file for task ${taskId} is corrupt or unreadable:`,
				error instanceof Error ? error.message : String(error),
			);
			telemetry.gateFailed(
				'',
				'qa_gate',
				taskId,
				`Evidence file corrupt or unreadable`,
			);
			return reviewerGateDecision(
				taskId,
				sessionID,
				{
					blocked: true,
					reason:
						`Evidence file for task ${taskId} is corrupt or unreadable. ` +
						`Fix the file at .swarm/evidence/${taskId}.json or delete it to fall through to session state.`,
				},
				'corrupt_evidence',
				'data_quality',
			);
		}

		// === session state check (fallback for pre-evidence tasks) ===

		// If no active sessions, allow through only when no evidence file asserted
		// incomplete/invalid gate state. This preserves test-context behavior for
		// missing evidence while preventing empty evidence from vacuously passing.
		if (swarmState.agentSessions.size === 0 && !evidenceIncompleteReason) {
			return reviewerGateDecision(
				taskId,
				sessionID,
				{ blocked: false, reason: '' },
				'no_active_sessions',
				'fallback',
			);
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
				return reviewerGateDecision(
					taskId,
					sessionID,
					{ blocked: false, reason: '' },
					'workflow_state_complete',
					'genuine',
				);
			}

			// PR 2 Stage B parallel barrier: both completion markers present is sufficient
			// even if state machine advancement was delayed (e.g., non-fatal exception
			// in toolAfter). Only active when flag is on.
			if (stageBParallelEnabled && hasBothStageBCompletions(session, taskId)) {
				return reviewerGateDecision(
					taskId,
					sessionID,
					{ blocked: false, reason: '' },
					'stage_b_parallel_complete',
					'genuine',
				);
			}
		}

		// If all sessions had corrupt workflow state, allow through —
		// we cannot make a reliable gate assertion without valid state.
		if (validSessionCount === 0 && !evidenceIncompleteReason) {
			return reviewerGateDecision(
				taskId,
				sessionID,
				{ blocked: false, reason: '' },
				'zero_valid_sessions',
				'data_quality',
			);
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
		// Use the safe resolved directory from resolveWorkingDirectory above
		// — never raw workingDirectory which may be a subdirectory
		if (resolvedDir) {
			try {
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
							_internals.hasPassedDurableGateEvidence(resolvedDir, taskId)
						) {
							return reviewerGateDecision(
								taskId,
								sessionID,
								{ blocked: false, reason: '' },
								'restart_recovery_complete',
								'genuine',
							);
						}
					}
				}
			} catch {
				// plan.json missing or unreadable — fall through to blocked:true
			}
		} // end if (resolvedDir)

		// Final fallback: scan delegation chains directly for reviewer+test_engineer.
		// This covers cases where:
		// - Session was restarted (in-memory state lost)
		// - toolAfter hook didn't fire (subagent_type not captured)
		{
			let hasReviewer = false;
			let hasTestEngineer = false;

			// Pass 1: task-scoped scan — authoritative for code tasks.
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
				return reviewerGateDecision(
					taskId,
					sessionID,
					{ blocked: false, reason: '' },
					'scoped_delegation_complete',
					'genuine',
				);
			}

			// Pass 2: unscoped scan — covers pure-verification / docs tasks where the
			// architect dispatched reviewer+test_engineer without a prior coder delegation
			// so currentTaskId / lastCoderDelegationTaskId was never set for this task.
			// Only counts entries from chains that contain NO coder delegation to avoid
			// false positives where coder→reviewer→test_engineer from a previous task
			// cycle would incorrectly satisfy the gate for an unrelated new task.
			//
			// Guard: skip if durable evidence names explicit missing gates for this task.
			// When evidenceIncompleteReason is set the evidence file has already told us
			// which gates are required and which are absent — a coder-free chain from a
			// concurrent task must not override that durable assertion.
			if (!evidenceIncompleteReason && (!hasReviewer || !hasTestEngineer)) {
				for (const [sessionId, chain] of swarmState.delegationChains) {
					const hasCoder = chain.some(
						(d) => stripKnownSwarmPrefix(d.to) === 'coder',
					);
					if (hasCoder) continue; // task-scoped pass only for chains with coders

					// Cross-task isolation: only count coder-free chains from sessions
					// that are associated with this specific task. Without this guard,
					// a concurrent pure-verification task's chain could satisfy this
					// task's gate when no evidence file exists.
					const chainSession = swarmState.agentSessions.get(sessionId);
					if (chainSession) {
						const chainTaskId =
							chainSession.currentTaskId ||
							chainSession.lastCoderDelegationTaskId;
						if (chainTaskId && chainTaskId !== taskId) continue;
					}
					for (const delegation of chain) {
						const target = stripKnownSwarmPrefix(delegation.to);
						if (target === 'reviewer') hasReviewer = true;
						if (target === 'test_engineer') hasTestEngineer = true;
					}
				}
				if (hasReviewer && hasTestEngineer) {
					return reviewerGateDecision(
						taskId,
						sessionID,
						{ blocked: false, reason: '' },
						'unscoped_delegation_complete',
						'genuine',
					);
				}
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
		return reviewerGateDecision(
			taskId,
			sessionID,
			{
				blocked: true,
				reason: finalReason,
			},
			'required_gates_missing',
			'block',
		);
	} catch {
		// If state inspection throws, allow through
		return reviewerGateDecision(
			taskId,
			sessionID,
			{ blocked: false, reason: '' },
			'inspection_error',
			'fallback',
		);
	}
}

/**
 * Wrapper around checkReviewerGate that appends a diff-scope advisory warning.
 * Keeps checkReviewerGate synchronous for backward compatibility.
 * Stage B parallel is hardcoded (not config-driven).
 * @param taskId - The task ID to check gate state for
 * @param workingDirectory - Optional working directory for plan.json fallback
 * @param sessionID - Optional session ID to scope Lean Turbo bypass to the current tool-execution context
 * @param fallbackDir - Optional fallback directory for resolveWorkingDirectory when workingDirectory is absent
 * @returns ReviewerGateResult with optional scope warning appended to reason
 */
export async function checkReviewerGateWithScope(
	taskId: string,
	workingDirectory?: string,
	sessionID?: string,
	fallbackDir?: string,
): Promise<ReviewerGateResult> {
	// Stage B is always parallel — hardcoded, not config-driven.
	const stageBParallelEnabled = true;
	const result = checkReviewerGate(
		taskId,
		workingDirectory,
		stageBParallelEnabled,
		sessionID,
		fallbackDir,
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

	// Pass 2 (unscoped): covers pure-verification / docs tasks where the architect
	// dispatched reviewer+test_engineer without a prior coder delegation so
	// currentTaskId / lastCoderDelegationTaskId was never associated with this task.
	// Only applies to chains with NO coder delegation to prevent false positives
	// (a prior coder→reviewer→test_engineer cycle satisfying the gate for a new task).
	//
	// Guard: skip when durable evidence names explicit unmet gates for this task.
	// If the evidence file already records required_gates for taskId and some are
	// missing, a coder-free chain from a concurrent task must not advance this
	// task's state — the evidence proves those gates have not been satisfied.
	let hasDurableIncompleteGates = false;
	if (directory) {
		try {
			const taskEvidence = readTaskEvidenceRaw(directory, taskId);
			if (
				taskEvidence?.gates &&
				Array.isArray(taskEvidence.required_gates) &&
				taskEvidence.required_gates.length > 0
			) {
				const gates = taskEvidence.gates;
				hasDurableIncompleteGates = taskEvidence.required_gates.some(
					(g) => gates[g] == null,
				);
			}
		} catch {
			// Evidence unreadable — be conservative and skip Pass 2
			hasDurableIncompleteGates = true;
		}
	}

	if (!hasDurableIncompleteGates && (!hasReviewer || !hasTestEngineer)) {
		for (const [sessionId, chain] of swarmState.delegationChains) {
			const hasCoder = chain.some(
				(d) => stripKnownSwarmPrefix(d.to) === 'coder',
			);
			if (hasCoder) continue;

			// Cross-task isolation: only count coder-free chains from sessions
			// that are associated with this specific task. Without this guard,
			// a concurrent pure-verification task's chain could advance this
			// task's state when no evidence file exists.
			const chainSession = swarmState.agentSessions.get(sessionId);
			if (chainSession) {
				const chainTaskId =
					chainSession.currentTaskId || chainSession.lastCoderDelegationTaskId;
				if (chainTaskId && chainTaskId !== taskId) continue;
			}

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
			if (evidence?.gates && Array.isArray(evidence.required_gates)) {
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

		// Record Stage B completions in the parallel barrier so delegation-gate
		// and recovery share consistent barrier state. This mirrors the recording
		// done in delegation-gate.ts and prevents duplicate advancement attempts.
		if (hasReviewer) {
			recordStageBCompletion(session, taskId, 'reviewer');
		}
		if (hasTestEngineer) {
			recordStageBCompletion(session, taskId, 'test_engineer');
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
	/** True when council is active for this plan (i.e. council.enabled and council_mode on). */
	active: boolean;
}

/**
 * Check the council gate for a completion transition. Pure — reads config and
 * evidence only, no state mutation. Exported for focused unit testing.
 *
 * AND semantics: the gate only activates when BOTH pluginConfig.council.enabled
 * === true AND the QA gate profile has council_mode === true. When active, the
 * per-task full 5-member council verdict (via submit_council_verdicts) is
 * required before task advancement. When council.enabled is true but
 * council_mode is false (or the profile is absent), the gate is treated as
 * inactive — the operator has disabled it at the profile level.
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
		return { blocked: false, reason: '', active: false };
	}

	if (!councilEnabled) {
		return { blocked: false, reason: '', active: false };
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
			const lookup = getProfileLookupForIdentity(
				workingDirectory,
				planObj as { swarm: string; title: string },
			);
			if (lookup.kind === 'bound') {
				if (!lookup.profile.gates.council_mode) {
					return { blocked: false, reason: '', active: false };
				}
			} else if (lookup.kind === 'unbound_legacy') {
				if (lookup.profile.gates.council_mode) {
					return {
						blocked: true,
						reason: `council gate required but the QA gate profile is not exact-bound to the current raw swarm_id/plan_title. ${formatLegacyQaBindingRecovery(
							{ swarm: planObj.swarm, title: planObj.title },
							'retry advancing this task',
						)}`,
						active: true,
					};
				}
				return { blocked: false, reason: '', active: false };
			} else {
				return { blocked: false, reason: '', active: false };
			}
		}
	} catch {
		// plan.json missing, unreadable, or profile DB absent — fall back to
		// treating the gate as inactive (no regression; same as isCouncilGateActive).
		return { blocked: false, reason: '', active: false };
	}

	// Both conditions confirmed — council gate is active for this plan.
	let evidence: ReturnType<typeof readTaskEvidenceRaw>;
	try {
		evidence = readTaskEvidenceRaw(workingDirectory, taskId);
	} catch {
		// Corrupt evidence — let the existing gate loop / downstream checks handle
		return {
			blocked: true,
			reason:
				'council gate required but not yet run — architect must call submit_council_verdicts before advancing this task',
			active: true,
		};
	}

	const councilGate = evidence?.gates?.council as
		| { verdict?: string; quorumSize?: number; workflowGeneration?: number }
		| undefined;
	if (!councilGate) {
		return {
			blocked: true,
			reason:
				'council gate required but not yet run — architect must call submit_council_verdicts before advancing this task',
			active: true,
		};
	}
	const councilWorkflow = getTaskWorkflowSnapshot(evidence);
	if (
		!councilWorkflow.authoritative ||
		councilWorkflow.state !== 'pre_check_passed' ||
		councilGate.workflowGeneration !== councilWorkflow.generation
	) {
		return {
			blocked: true,
			reason: `council gate evidence is stale or unbound: expected pre_check_passed@${councilWorkflow.generation}, recorded generation ${String(councilGate.workflowGeneration)}`,
			active: true,
		};
	}

	if (councilGate.verdict === 'REJECT') {
		return {
			blocked: true,
			reason:
				'council gate blocked advancement — resolve requiredFixes and re-run submit_council_verdicts',
			active: true,
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
			active: true,
		};
	}

	// APPROVE or CONCERNS with sufficient quorum → allow
	return { blocked: false, reason: '', active: true };
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

	// Step 3: Validate working_directory if provided (must be before reviewer gate check)
	// Uses resolveWorkingDirectory to consolidate: null-byte, device-path, traversal,
	// existence, and subdirectory checks. (FR-006, DD-012)
	let directory: string;

	const resolveResult = _internals.resolveWorkingDirectory(
		args.working_directory,
		fallbackDir,
	);
	if (!resolveResult.success) {
		return {
			success: false,
			message: resolveResult.message,
			errors: [resolveResult.message],
		};
	}
	directory = resolveResult.directory;

	// Enforce the authoritative boundary before reading plan state, mutating
	// sessions, or creating gate evidence. A fallback comparison cannot identify
	// descendants of an unrelated root.
	try {
		assertProjectRoot(directory);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message,
			errors: [message],
		};
	}

	// Verify .swarm/plan.json exists (resolveWorkingDirectory checks directory
	// existence but not plan file presence)
	const planPath = path.join(directory, '.swarm', 'plan.json');
	if (!fs.existsSync(planPath)) {
		return {
			success: false,
			message: `Invalid working_directory: plan not found in "${directory}"`,
			errors: [`Invalid working_directory: plan not found in "${directory}"`],
		};
	}

	// Defense-in-depth: reject if resolved directory is a subdirectory of the
	// injected project root. This prevents .swarm artifacts from being created
	// or read from subdirectories. (FR-005)
	// Canonicalize both paths via realpathSync to handle symlinks and case differences.
	if (fallbackDir && directory !== fallbackDir) {
		const canonicalDir = fs.realpathSync(path.resolve(directory));
		const canonicalRoot = fs.realpathSync(path.resolve(fallbackDir));
		if (
			isStrictPathDescendant(canonicalDir, canonicalRoot) &&
			!hasExplicitProjectBoundary(canonicalDir)
		) {
			return {
				success: false,
				message:
					`Invalid working_directory: "${directory}" is a subdirectory of ` +
					`the project root "${fallbackDir}". Pass the project root path or ` +
					`omit working_directory entirely.`,
				errors: [
					`Subdirectory rejected: use project root "${fallbackDir}" instead`,
				],
			};
		}
	}

	let exactRepairRetry = false;
	if (isRepairRetryShape(args)) {
		try {
			const repairWal = await readWorkflowWalFile(
				'task-repair',
				validateSwarmPath(directory, `task-repairs/${args.task_id}.json`),
				args.task_id,
			);
			exactRepairRetry =
				repairWal?.state === 'PREPARED' &&
				repairWal.transitionId === args.transition_id;
		} catch (error) {
			return {
				success: false,
				message:
					'Task operation paused while recovering an interrupted task repair',
				errors: [error instanceof Error ? error.message : String(error)],
			};
		}
	}
	try {
		const recoveredCoder = await recoverCoderSettlement(
			directory,
			args.task_id,
		);
		if (recoveredCoder && ctx?.sessionID) {
			const callerSession = ensureAgentSession(ctx.sessionID);
			const workflow = getTaskWorkflowSnapshot(recoveredCoder.evidence);
			callerSession.taskWorkflowStates.set(args.task_id, workflow.state);
			callerSession.stageBCompletion?.delete(args.task_id);
			updateTaskWorkflowCache(callerSession, args.task_id, workflow);
		}
	} catch (error) {
		return {
			success: false,
			message:
				'Task operation paused while recovering an interrupted coder settlement',
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
	try {
		const recoveredTerminal = await recoverPreparedTaskTerminal(
			directory,
			args.task_id,
			ctx?.sessionID ?? 'update-task-status',
		);
		if (recoveredTerminal) {
			syncCallerWorkflowFromEvidence(
				ctx?.sessionID,
				args.task_id,
				recoveredTerminal.evidence,
			);
		}
	} catch (error) {
		return {
			success: false,
			message:
				'Task operation paused while recovering an interrupted terminal status transition',
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
	if (!exactRepairRetry) {
		try {
			const recoveredRepair = await recoverPreparedTaskRepair(
				directory,
				args.task_id,
				ctx?.sessionID ?? 'update-task-status',
			);
			if (recoveredRepair) {
				syncCallerWorkflowFromEvidence(
					ctx?.sessionID,
					args.task_id,
					readTaskEvidenceRaw(directory, args.task_id),
				);
			}
		} catch (error) {
			// A COMMITTED-but-unaudited repair WAL (the WAL is never deleted) makes
			// this lazy recovery retry its audit-event write on every call for the
			// task. Transient events.jsonl lock contention must not hard-block an
			// unrelated update_task_status call — the audit write itself has
			// already durably committed the workflow/plan transition and will be
			// retried opportunistically on a later call.
			if (
				error instanceof Error &&
				error.message.startsWith('TASK_REPAIR_AUDIT_LOCKED')
			) {
				logger.criticalWarn(
					`[update-task-status] task-repair audit recovery deferred for ${args.task_id}: ${error.message}`,
				);
			} else {
				return {
					success: false,
					message:
						'Task operation paused while recovering an interrupted task repair',
					errors: [error instanceof Error ? error.message : String(error)],
				};
			}
		}
	}

	// #1269 finding 2: consult the ledger-replay staleness signal BEFORE any mutation.
	// loadPlan attaches `_ledgerReplayStale` when it fell back to a stale plan.json
	// (plan.json hash mismatched the ledger, ledger replay threw, AND no critic-approved
	// snapshot was available). Mutating on top of that stale projection would silently
	// overwrite the authoritative ledger view, so refuse with structured recovery guidance
	// (mirroring the lock-blocked return shape) instead of relying on a logged warning.
	// Placed before the evidence write and lock acquisition so no mutation occurs on stale state.
	let loadedPlan: RuntimePlan | null = null;
	try {
		loadedPlan = await _internals.loadPlan(directory);
	} catch (error) {
		// loadPlan failure is non-fatal here — the mutation path (updateTaskStatus) performs
		// its own load and will surface a hard error; we only gate on a positive stale signal.
		return {
			success: false,
			message: 'Failed to load plan for task validation',
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
	if (!loadedPlan) {
		return {
			success: false,
			message: 'Failed to load plan for task validation',
			errors: ['Plan could not be loaded'],
		};
	}
	if (loadedPlan._ledgerReplayStale === true) {
		const staleReason =
			loadedPlan._ledgerReplayStaleReason ??
			'plan.json is stale relative to the authoritative ledger (.swarm/plan-ledger.jsonl)';
		return {
			success: false,
			message: `Task status update refused: plan.json is stale relative to the ledger (ledger replay failed). ${staleReason}`,
			errors: [staleReason],
			recovery_guidance:
				'Plan state could not be reconciled with the authoritative ledger (.swarm/plan-ledger.jsonl). ' +
				'Retry save_plan with the unchanged loaded plan so it can reconverge the projection/hash with the authoritative ledger, then retry update_task_status.',
		};
	}

	const currentTask = loadedPlan.phases
		.flatMap((phase) => phase.tasks)
		.find((task) => task.id === args.task_id);
	if (!currentTask) {
		return {
			success: false,
			message: 'Failed to update task status',
			errors: [`Task not found: ${args.task_id}`],
		};
	}

	// Settled tasks may only move backward through the audited exact-CAS repair.
	// A task is "settled" iff its status is neither 'pending' nor 'in_progress'.
	// Reuse the already-loaded plan; do not add a second plan load.
	{
		const settledRejection = getSettledTransitionRejection(
			args.task_id,
			currentTask.status,
			args.status,
			args.force,
		);
		if (settledRejection) {
			return settledRejection;
		}
	}

	if (args.status === 'in_progress' && args.force === true) {
		const repairFieldsValid =
			typeof args.expected_state === 'string' &&
			args.expected_state.length > 0 &&
			Number.isInteger(args.expected_generation) &&
			(args.expected_generation ?? -1) >= 0 &&
			args.target_state === 'idle' &&
			typeof args.reason === 'string' &&
			args.reason.trim().length > 0 &&
			args.reason.length <= 2000 &&
			typeof args.transition_id === 'string' &&
			args.transition_id.trim().length > 0 &&
			args.transition_id.length <= 200;
		if (!repairFieldsValid) {
			return {
				success: false,
				message:
					'TASK_REPAIR_INVALID: force repair requires an exact CAS and audit identity',
				errors: [
					'Provide expected_state, expected_generation, target_state="idle", a non-empty reason (max 2000 chars), and a non-empty transition_id (max 200 chars).',
				],
			};
		}
		logger.log(
			`[update-task-status] Force-override: re-opening settled task ${args.task_id} to in_progress`,
		);
	}

	// Status alone is not coder mutation proof. Exact caller correlation is
	// applied only after the authoritative plan write succeeds below.

	// Derive agent from swarmState session context, fallback to 'update-task-status'
	// sentinel. Derived here (rather than at the lock step below) because the
	// gate-block paths that record run-memory outcomes return before the lock.
	const agentName =
		(ctx?.sessionID ? swarmState.activeAgent.get(ctx.sessionID) : undefined) ??
		'update-task-status';

	// State machine check: task must have reached tests_run or complete state
	// Uses the validated directory for plan.json fallback resolution
	if (args.status === 'completed') {
		// Legacy direct-helper callers retain diagnostic recovery. Real tool
		// execution is exact-evidence authoritative and must stay side-effect-free
		// until the durable completion transaction succeeds.
		if (!fallbackDir && !ctx?.sessionID) {
			recoverTaskStateFromDelegations(args.task_id, directory);
		}

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

		// Council gate: when council_mode is active, council evidence replaces
		// Stage B (reviewer/test_engineer). Check council first so the right error
		// is surfaced; when council is active, skip the reviewer gate entirely.
		const councilCheck = checkCouncilGate(directory, args.task_id);
		if (councilCheck.blocked) {
			// A blocked completion attempt is a real task failure with an in-band
			// reason — the exact signal run memory exists to replay next session.
			await recordRunMemoryOutcome(directory, {
				taskId: args.task_id,
				agent: agentName,
				outcome: 'fail',
				failureReason: `council gate: ${councilCheck.reason}`,
				fileTargets: resolveRunMemoryFileTargets(loadedPlan, args.task_id),
			});
			return {
				success: false,
				message:
					'Gate check failed: council gate not yet satisfied for task ' +
					args.task_id,
				errors: [councilCheck.reason],
			};
		}

		if (phaseRequiresReviewer && !councilCheck.active) {
			const reviewerCheck = await checkReviewerGateWithScope(
				args.task_id,
				directory,
				ctx?.sessionID,
				ctx?.sessionID ? fallbackDir : undefined,
			);
			if (reviewerCheck.blocked) {
				await recordRunMemoryOutcome(directory, {
					taskId: args.task_id,
					agent: agentName,
					outcome: 'fail',
					failureReason: `QA gate: ${reviewerCheck.reason}`,
					fileTargets: resolveRunMemoryFileTargets(loadedPlan, args.task_id),
				});
				return {
					success: false,
					message:
						'Gate check failed: required QA gates not yet satisfied for task ' +
						args.task_id,
					errors: [reviewerCheck.reason],
				};
			}
		}
	}

	// Step 4: Update the task status with file lock to prevent concurrent writes
	const lockTaskId = `update-task-status-${args.task_id}-${Date.now()}`;
	const planFilePath = 'plan.json';
	let lockResult: Awaited<ReturnType<typeof tryAcquireLock>> | undefined;
	try {
		lockResult = await _internals.tryAcquireLock(
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
		const lockedPlan = await _internals.loadPlan(directory);
		if (lockedPlan?._ledgerReplayStale === true) {
			return {
				success: false,
				message:
					'Task status update refused: plan became ledger-stale while waiting for the lock',
				errors: [
					lockedPlan._ledgerReplayStaleReason ??
						'plan.json is stale relative to the authoritative ledger',
				],
				recovery_guidance:
					'Retry save_plan with the unchanged loaded plan to reconverge the projection/hash, then retry update_task_status.',
			};
		}
		if (!lockedPlan) {
			return {
				success: false,
				message: 'Failed to update task status',
				errors: ['No approved plan is available under the plan lock'],
			};
		}
		let authoritativePlan = lockedPlan;
		const lockedPreparedRepairWal = await readPreparedWorkflowWal(
			directory,
			args.task_id,
			'task-repair',
		);
		const lockedExactRepairRetry =
			isRepairRetryShape(args) &&
			lockedPreparedRepairWal?.transitionId === args.transition_id;
		if (lockedPreparedRepairWal && !lockedExactRepairRetry) {
			try {
				const recoveredRepair = await recoverPreparedTaskRepairUnderPlanLock(
					directory,
					args.task_id,
					ctx?.sessionID ?? 'update-task-status',
					authoritativePlan,
				);
				if (recoveredRepair) {
					authoritativePlan = recoveredRepair.plan;
					syncCallerWorkflowFromEvidence(
						ctx?.sessionID,
						args.task_id,
						readTaskEvidenceRaw(directory, args.task_id),
					);
				}
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.startsWith('TASK_REPAIR_AUDIT_LOCKED')
				) {
					logger.criticalWarn(
						`[update-task-status] task-repair audit recovery deferred for ${args.task_id}: ${error.message}`,
					);
				} else {
					return {
						success: false,
						message:
							'Task operation paused while recovering an interrupted task repair',
						errors: [error instanceof Error ? error.message : String(error)],
					};
				}
			}
		}
		if (
			await hasPreparedWorkflowWal(directory, args.task_id, 'task-terminal')
		) {
			try {
				const recoveredTerminal =
					await recoverPreparedTaskTerminalUnderPlanLock(
						directory,
						args.task_id,
						ctx?.sessionID ?? 'update-task-status',
						authoritativePlan,
					);
				if (recoveredTerminal) {
					authoritativePlan = recoveredTerminal.plan;
					syncCallerWorkflowFromEvidence(
						ctx?.sessionID,
						args.task_id,
						recoveredTerminal.evidence,
					);
				}
			} catch (error) {
				return {
					success: false,
					message:
						'Task operation paused while recovering an interrupted terminal status transition',
					errors: [error instanceof Error ? error.message : String(error)],
				};
			}
		}
		const lockedTask = authoritativePlan.phases
			.flatMap((phase) => phase.tasks)
			.find((task) => task.id === args.task_id);
		if (!lockedTask) {
			return {
				success: false,
				message: 'Failed to update task status',
				errors: [`Task not found: ${args.task_id}`],
			};
		}
		const lockedSettledRejection = getSettledTransitionRejection(
			args.task_id,
			lockedTask.status,
			args.status,
			args.force,
		);
		if (lockedSettledRejection) {
			return lockedSettledRejection;
		}
		const forceRepair = args.status === 'in_progress' && args.force === true;
		const repairResult = forceRepair
			? await repairTaskWorkflowUnderPlanLock({
					directory,
					taskId: args.task_id,
					actor: agentName,
					reason: args.reason as string,
					transitionId: args.transition_id as string,
					expectedState: args.expected_state as string,
					expectedGeneration: args.expected_generation as number,
					currentPlanStatus: lockedTask.status,
					currentPlan: authoritativePlan,
					updatePlan: () =>
						_internals.updateTaskStatus(
							directory,
							args.task_id,
							'in_progress',
							{ force: true, planLockAlreadyHeld: true },
						),
				})
			: null;
		let updatedPlan: RuntimePlan;
		let terminalEvidence: Awaited<
			ReturnType<typeof transitionTaskWorkflowEvidence>
		> | null = null;
		if (args.status === 'completed') {
			const lockedTaskPhase = authoritativePlan.phases.find((phase) =>
				phase.tasks.some((task) => task.id === args.task_id),
			);
			const lockedPhaseRequiresReviewer =
				!lockedTaskPhase?.required_agents ||
				lockedTaskPhase.required_agents.includes('reviewer');
			const terminalResult = await commitTaskTerminalUnderPlanLock({
				directory,
				taskId: args.task_id,
				actor: agentName,
				transitionId: `plan-status:${args.task_id}:completed:${Date.now()}`,
				currentPlanStatus: lockedTask.status,
				targetStatus: 'completed',
				qaExempt: !lockedPhaseRequiresReviewer,
				currentPlan: authoritativePlan,
				validateEvidence: async () => {
					const lockedGate = checkReviewerGate(
						args.task_id,
						directory,
						false,
						ctx?.sessionID,
						fallbackDir ?? directory,
					);
					const lockedCouncil = checkCouncilGate(directory, args.task_id);
					if (
						lockedCouncil.blocked ||
						(lockedPhaseRequiresReviewer &&
							!lockedCouncil.active &&
							lockedGate.blocked)
					) {
						throw new Error(
							`TASK_COMPLETION_CAS_MISMATCH: ${lockedCouncil.blocked ? lockedCouncil.reason : lockedGate.reason}`,
						);
					}
				},
				updatePlan: async () => {
					const next = await _internals.updateTaskStatus(
						directory,
						args.task_id,
						'completed',
						{ force: false, planLockAlreadyHeld: true },
					);
					const persisted = next.phases
						.flatMap((phase) => phase.tasks)
						.find((task) => task.id === args.task_id);
					if (persisted?.status !== 'completed') {
						throw new Error('TASK_STATUS_WRITE_NOT_APPLIED');
					}
					return next;
				},
			});
			updatedPlan = terminalResult.plan;
			terminalEvidence = terminalResult.evidence;
		} else if (args.status === 'blocked') {
			const terminalResult = await commitTaskTerminalUnderPlanLock({
				directory,
				taskId: args.task_id,
				actor: agentName,
				transitionId: `plan-status:${args.task_id}:blocked:${Date.now()}`,
				currentPlanStatus: lockedTask.status,
				targetStatus: 'blocked',
				qaExempt: false,
				currentPlan: authoritativePlan,
				updatePlan: async () => {
					const next = await _internals.updateTaskStatus(
						directory,
						args.task_id,
						'blocked',
						{ force: false, planLockAlreadyHeld: true },
					);
					const persisted = next.phases
						.flatMap((phase) => phase.tasks)
						.find((task) => task.id === args.task_id);
					if (persisted?.status !== 'blocked') {
						throw new Error('TASK_STATUS_WRITE_NOT_APPLIED');
					}
					return next;
				},
			});
			updatedPlan = terminalResult.plan;
			terminalEvidence = terminalResult.evidence;
		} else {
			updatedPlan =
				repairResult?.plan ??
				(await _internals.updateTaskStatus(
					directory,
					args.task_id,
					args.status as TaskStatus,
					{ force: false, planLockAlreadyHeld: true },
				));
			const persisted = updatedPlan.phases
				.flatMap((phase) => phase.tasks)
				.find((task) => task.id === args.task_id);
			if (persisted?.status !== args.status) {
				throw new Error('TASK_STATUS_WRITE_NOT_APPLIED');
			}
		}

		if (terminalEvidence) {
			const terminal = getTaskWorkflowSnapshot(terminalEvidence);
			const callerSession = ctx?.sessionID
				? swarmState.agentSessions.get(ctx.sessionID)
				: undefined;
			if (callerSession) {
				const session = callerSession;
				session.taskWorkflowStates.set(args.task_id, terminal.state);
				session.stageBCompletion?.delete(args.task_id);
				updateTaskWorkflowCache(session, args.task_id, terminal);
			}
		}

		if (args.status === 'in_progress') {
			if (ctx?.sessionID)
				ensureAgentSession(ctx.sessionID).currentTaskId = args.task_id;
			if (repairResult) {
				const callerSession = ctx?.sessionID
					? swarmState.agentSessions.get(ctx.sessionID)
					: undefined;
				if (callerSession) {
					const session = callerSession;
					session.taskWorkflowStates.set(args.task_id, 'idle');
					session.stageBCompletion?.delete(args.task_id);
					session.taskCouncilApproved?.delete(args.task_id);
					session.taskCouncilWorkflowGeneration?.delete(args.task_id);
					updateTaskWorkflowCache(session, args.task_id, {
						generation: repairResult.generation,
					});
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
				logger.log('[update-task-status] Lock release failed:', releaseError);
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
		force: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Enable the audited backward-only repair contract. Requires expected_state, expected_generation, target_state="idle", reason, and transition_id.',
			),
		expected_state: z
			.string()
			.optional()
			.describe('CAS workflow state expected by a force repair.'),
		expected_generation: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe('ABA-safe workflow generation expected by a force repair.'),
		target_state: z
			.literal('idle')
			.optional()
			.describe('Backward-only repair target. The only valid target is idle.'),
		reason: z
			.string()
			.min(1)
			.max(2000)
			.optional()
			.describe('Required human-readable audit reason for a force repair.'),
		transition_id: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe(
				'Caller-generated idempotency key for an audited force repair.',
			),
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
