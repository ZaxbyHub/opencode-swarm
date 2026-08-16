import type { Plan } from '../config/plan-schema.js';
import {
	getTaskWorkflowSnapshot,
	type TaskEvidence,
	withTaskEvidenceTransaction,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import {
	readPlanEpochIdentity,
	replayFromLedgerWithStatus,
} from '../plan/ledger.js';
import { loadPlanJsonOnly, updateTaskStatus } from '../plan/manager.js';
import { assertNoUnsettledCoderDispatch } from './coder-settlement.js';
import {
	readWorkflowWalFile,
	writeWorkflowWalFile,
} from './workflow-wal-file.js';
import type {
	TaskTerminalWal,
	TerminalPlanStatus,
} from './workflow-wal-schema.js';

export interface TaskTerminalResult<TPlan> {
	plan: TPlan;
	evidence: TaskEvidence;
	alreadyApplied: boolean;
	transitionId: string;
	targetStatus: TerminalPlanStatus;
}

const writeWal = (filePath: string, wal: TaskTerminalWal): Promise<void> =>
	writeWorkflowWalFile('task-terminal', filePath, wal);

function evidenceMatchesTerminal(
	evidence: TaskEvidence | null,
	wal: TaskTerminalWal,
): boolean {
	const workflow = getTaskWorkflowSnapshot(evidence);
	return (
		workflow.authoritative &&
		workflow.state === wal.newWorkflowState &&
		workflow.generation === wal.generation &&
		workflow.lastTransitionId === wal.transitionId
	);
}

async function applyTerminalEvidence(
	transaction: Parameters<Parameters<typeof withTaskEvidenceTransaction>[3]>[0],
	wal: TaskTerminalWal,
): Promise<TaskEvidence> {
	return transaction.transition(
		wal.newPlanStatus === 'completed'
			? {
					type: 'task_completed',
					qaExempt: wal.qaExempt,
					expectedGeneration: wal.generation,
					transitionId: wal.transitionId,
				}
			: wal.newPlanStatus === 'blocked'
				? {
						type: 'task_blocked',
						expectedGeneration: wal.generation,
						transitionId: wal.transitionId,
					}
				: {
						type: 'task_closed',
						expectedGeneration: wal.generation,
						transitionId: wal.transitionId,
					},
	);
}

/** Narrow dependency-injection seam for crash-window failure tests. */
export const _internals = { applyTerminalEvidence };

async function recoverPreparedTaskTerminalWithPlanLock(
	directory: string,
	taskId: string,
	actor: string,
	currentPlan: Plan,
): Promise<TaskTerminalResult<Plan> | null> {
	const walPath = validateSwarmPath(directory, `task-terminals/${taskId}.json`);
	const observedWal = await readWorkflowWalFile(
		'task-terminal',
		walPath,
		taskId,
	);
	if (observedWal === null) return null;
	if (observedWal.state !== 'PREPARED') return null;
	let plan: Plan = currentPlan;

	return withTaskEvidenceTransaction(
		directory,
		taskId,
		actor,
		async (transaction) => {
			// The first read is only an inexpensive exact-path fast path. The WAL
			// is authoritative only after both plan and evidence locks are held.
			const wal = await readWorkflowWalFile('task-terminal', walPath, taskId);
			if (wal === null) return null;
			if (wal.state !== 'PREPARED') return null;
			if (wal.version === 2) {
				const identity = await readPlanEpochIdentity(directory, plan);
				if (
					!identity ||
					identity.planIdentityHash !== wal.planIdentityHash ||
					identity.planEpoch !== wal.planEpoch
				) {
					throw new Error(
						`TASK_TERMINAL_PLAN_IDENTITY_MISMATCH: ${walPath} belongs to a different plan epoch`,
					);
				}
			}
			const task = plan.phases
				.flatMap((phase) => phase.tasks)
				.find((candidate) => candidate.id === taskId);
			if (!task) throw new Error(`TASK_TERMINAL_TASK_MISSING: ${taskId}`);
			const evidence = transaction.read();
			const workflow = getTaskWorkflowSnapshot(evidence);
			const evidenceAlreadyTerminal = evidenceMatchesTerminal(evidence, wal);
			if (
				wal.version === 1 &&
				task.status === wal.oldPlanStatus &&
				workflow.state === wal.oldWorkflowState &&
				workflow.generation === wal.generation
			) {
				await writeWal(walPath, { ...wal, state: 'ABORTED' });
				return null;
			}
			if (task.status === wal.oldPlanStatus && evidenceAlreadyTerminal) {
				plan = await updateTaskStatus(directory, taskId, wal.newPlanStatus, {
					planLockAlreadyHeld: true,
					terminalReconciliation: wal.version === 2,
				});
			} else if (wal.version === 2 && task.status === wal.oldPlanStatus) {
				plan = await updateTaskStatus(directory, taskId, wal.newPlanStatus, {
					planLockAlreadyHeld: true,
					terminalReconciliation: true,
				});
			} else if (task.status !== wal.newPlanStatus) {
				throw new Error(
					`TASK_TERMINAL_PLAN_CAS_MISMATCH: expected ${wal.oldPlanStatus} or ${wal.newPlanStatus}, found ${task.status}`,
				);
			}
			const nextEvidence = evidenceAlreadyTerminal
				? (evidence as TaskEvidence)
				: await _internals.applyTerminalEvidence(transaction, wal);
			await writeWal(walPath, { ...wal, state: 'COMMITTED' });
			return {
				plan,
				evidence: nextEvidence,
				alreadyApplied: evidenceAlreadyTerminal,
				transitionId: wal.transitionId,
				targetStatus: wal.newPlanStatus,
			};
		},
	);
}

/**
 * Lazily close the only recoverable terminal crash window: the plan was
 * persisted to completed/blocked after PREPARED, but exact-task evidence was
 * not. A PREPARED record whose plan and evidence are both still old is safely
 * aborted rather than executing an abandoned status request.
 */
export async function recoverPreparedTaskTerminal(
	directory: string,
	taskId: string,
	actor: string,
): Promise<TaskTerminalResult<Plan> | null> {
	const walPath = validateSwarmPath(directory, `task-terminals/${taskId}.json`);
	const observedWal = await readWorkflowWalFile(
		'task-terminal',
		walPath,
		taskId,
	);
	if (observedWal === null || observedWal.state !== 'PREPARED') return null;
	const lock = await tryAcquireLock(
		directory,
		'plan.json',
		actor,
		`recover-task-terminal-${taskId}-${Date.now()}`,
	);
	if (!lock.acquired) {
		throw new Error(
			`TASK_TERMINAL_RECOVERY_LOCKED: ${lock.existing?.agent ?? 'another agent'} owns plan.json`,
		);
	}
	try {
		const replay = await replayFromLedgerWithStatus(directory);
		if (replay.truncated) throw new Error('TASK_TERMINAL_LEDGER_TRUNCATED');
		const loadedPlan = replay.plan ?? (await loadPlanJsonOnly(directory));
		if (!loadedPlan) throw new Error('TASK_TERMINAL_PLAN_MISSING');
		return await recoverPreparedTaskTerminalWithPlanLock(
			directory,
			taskId,
			actor,
			loadedPlan,
		);
	} finally {
		if (lock.lock._release) await lock.lock._release().catch(() => {});
	}
}

export async function recoverPreparedTaskTerminalUnderPlanLock(
	directory: string,
	taskId: string,
	actor: string,
	currentPlan: Plan,
): Promise<TaskTerminalResult<Plan> | null> {
	return recoverPreparedTaskTerminalWithPlanLock(
		directory,
		taskId,
		actor,
		currentPlan,
	);
}

/** Commit a terminal plan/evidence transition while the caller holds plan.json. */
export async function commitTaskTerminalUnderPlanLock<TPlan>(options: {
	directory: string;
	taskId: string;
	actor: string;
	transitionId: string;
	currentPlanStatus: string;
	targetStatus: TerminalPlanStatus;
	qaExempt: boolean;
	resolveTerminal?: (evidence: TaskEvidence | null) => {
		targetStatus: TerminalPlanStatus;
		qaExempt: boolean;
		preserveEvidence?: boolean;
	};
	planIdentityHash?: string;
	planEpoch?: string;
	currentPlan: TPlan;
	validateEvidence?: (evidence: TaskEvidence | null) => Promise<void> | void;
	updatePlan: (targetStatus: TerminalPlanStatus) => Promise<TPlan>;
}): Promise<TaskTerminalResult<TPlan>> {
	const walPath = validateSwarmPath(
		options.directory,
		`task-terminals/${options.taskId}.json`,
	);
	return withTaskEvidenceTransaction(
		options.directory,
		options.taskId,
		options.actor,
		async (transaction) => {
			await assertNoUnsettledCoderDispatch(options.directory, options.taskId);
			const evidence = transaction.read();
			const workflow = getTaskWorkflowSnapshot(evidence);
			await options.validateEvidence?.(evidence);
			const terminal = options.resolveTerminal?.(evidence) ?? {
				targetStatus: options.targetStatus,
				qaExempt: options.qaExempt,
			};
			let existingWal = await readWorkflowWalFile(
				'task-terminal',
				walPath,
				options.taskId,
			);
			if (existingWal?.state === 'ABORTED') existingWal = null;
			if (existingWal && existingWal.taskId !== options.taskId) {
				throw new Error('TASK_TERMINAL_WAL_TASK_MISMATCH');
			}
			if (existingWal?.state === 'PREPARED') {
				throw new Error(
					`TASK_TERMINAL_RECOVERY_REQUIRED: transition ${existingWal.transitionId} is PREPARED`,
				);
			}
			if (
				existingWal?.version === 2 &&
				(existingWal.planIdentityHash !== options.planIdentityHash ||
					existingWal.planEpoch !== options.planEpoch)
			) {
				throw new Error(
					`TASK_TERMINAL_PLAN_IDENTITY_MISMATCH: ${walPath} belongs to a different plan epoch`,
				);
			}
			if (
				existingWal?.state === 'COMMITTED' &&
				existingWal.transitionId === options.transitionId &&
				existingWal.newPlanStatus === terminal.targetStatus &&
				evidenceMatchesTerminal(evidence, existingWal)
			) {
				return {
					plan: options.currentPlan,
					evidence: evidence as TaskEvidence,
					alreadyApplied: true,
					transitionId: options.transitionId,
					targetStatus: existingWal.newPlanStatus,
				};
			}
			if (terminal.preserveEvidence) {
				if (!evidence || !workflow.authoritative) {
					throw new Error('TASK_TERMINAL_AUTHORITATIVE_EVIDENCE_REQUIRED');
				}
				const expectedState =
					terminal.targetStatus === 'completed'
						? 'complete'
						: terminal.targetStatus === 'closed'
							? 'closed'
							: 'blocked';
				if (workflow.state !== expectedState) {
					throw new Error(
						`TASK_TERMINAL_EVIDENCE_STATE_MISMATCH: expected ${expectedState}, found ${workflow.state}`,
					);
				}
				const plan =
					options.currentPlanStatus === terminal.targetStatus
						? options.currentPlan
						: await options.updatePlan(terminal.targetStatus);
				return {
					plan,
					evidence,
					alreadyApplied: true,
					transitionId: workflow.lastTransitionId ?? options.transitionId,
					targetStatus: terminal.targetStatus,
				};
			}

			if (
				terminal.targetStatus === 'closed' &&
				(!options.planIdentityHash || !options.planEpoch)
			) {
				throw new Error('TASK_TERMINAL_PLAN_IDENTITY_REQUIRED');
			}
			const newWorkflowState =
				terminal.targetStatus === 'completed'
					? 'complete'
					: terminal.targetStatus === 'blocked'
						? 'blocked'
						: 'closed';
			const baseWal = {
				state: 'PREPARED' as const,
				taskId: options.taskId,
				transitionId: options.transitionId,
				actor: options.actor,
				oldPlanStatus: options.currentPlanStatus,
				newPlanStatus: terminal.targetStatus,
				oldWorkflowState: workflow.state,
				newWorkflowState,
				generation: workflow.generation,
				qaExempt: terminal.qaExempt,
				recordedAt: new Date().toISOString(),
			};
			const wal: TaskTerminalWal =
				options.planIdentityHash && options.planEpoch
					? {
							...baseWal,
							version: 2,
							newPlanStatus: terminal.targetStatus as 'closed' | 'completed',
							newWorkflowState: newWorkflowState as 'closed' | 'complete',
							planIdentityHash: options.planIdentityHash,
							planEpoch: options.planEpoch,
						}
					: {
							...baseWal,
							version: 1,
							newPlanStatus: terminal.targetStatus as 'blocked' | 'completed',
							newWorkflowState: newWorkflowState as 'blocked' | 'complete',
						};
			await writeWal(walPath, wal);
			const plan = await options.updatePlan(terminal.targetStatus);
			const nextEvidence = await _internals.applyTerminalEvidence(
				transaction,
				wal,
			);
			await writeWal(walPath, { ...wal, state: 'COMMITTED' });
			return {
				plan,
				evidence: nextEvidence,
				alreadyApplied: false,
				transitionId: options.transitionId,
				targetStatus: terminal.targetStatus,
			};
		},
	);
}
