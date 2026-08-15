import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Plan } from '../config/plan-schema.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	getTaskWorkflowSnapshot,
	type TaskEvidence,
	withTaskEvidenceTransaction,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { replayFromLedgerWithStatus } from '../plan/ledger.js';
import { loadPlanJsonOnly, updateTaskStatus } from '../plan/manager.js';
import type { TaskWorkflowState } from '../state.js';
import { assertNoUnsettledCoderDispatch } from './coder-settlement.js';

type TerminalPlanStatus = 'blocked' | 'completed';
type TerminalWorkflowState = 'blocked' | 'complete';
type TerminalWalState = 'ABORTED' | 'COMMITTED' | 'PREPARED';

interface TaskTerminalWal {
	version: 1;
	state: TerminalWalState;
	taskId: string;
	transitionId: string;
	actor: string;
	oldPlanStatus: string;
	newPlanStatus: TerminalPlanStatus;
	oldWorkflowState: TaskWorkflowState;
	newWorkflowState: TerminalWorkflowState;
	generation: number;
	qaExempt: boolean;
	recordedAt: string;
}

export interface TaskTerminalResult<TPlan> {
	plan: TPlan;
	evidence: TaskEvidence;
	alreadyApplied: boolean;
	transitionId: string;
}

async function readText(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function parseWal(raw: string): TaskTerminalWal {
	const parsed = JSON.parse(raw) as Partial<TaskTerminalWal>;
	if (
		parsed.version !== 1 ||
		(parsed.state !== 'PREPARED' &&
			parsed.state !== 'COMMITTED' &&
			parsed.state !== 'ABORTED') ||
		typeof parsed.taskId !== 'string' ||
		typeof parsed.transitionId !== 'string' ||
		typeof parsed.actor !== 'string' ||
		typeof parsed.oldPlanStatus !== 'string' ||
		(parsed.newPlanStatus !== 'completed' &&
			parsed.newPlanStatus !== 'blocked') ||
		typeof parsed.oldWorkflowState !== 'string' ||
		(parsed.newWorkflowState !== 'complete' &&
			parsed.newWorkflowState !== 'blocked') ||
		!Number.isInteger(parsed.generation) ||
		typeof parsed.qaExempt !== 'boolean' ||
		typeof parsed.recordedAt !== 'string'
	) {
		throw new Error('TASK_TERMINAL_WAL_CORRUPT');
	}
	if (
		(parsed.newPlanStatus === 'completed') !==
		(parsed.newWorkflowState === 'complete')
	) {
		throw new Error('TASK_TERMINAL_WAL_STATE_MISMATCH');
	}
	return parsed as TaskTerminalWal;
}

async function writeWal(filePath: string, wal: TaskTerminalWal): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await atomicWriteFile(filePath, `${JSON.stringify(wal, null, 2)}\n`);
}

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
			: {
					type: 'task_blocked',
					expectedGeneration: wal.generation,
					transitionId: wal.transitionId,
				},
	);
}

/** Narrow dependency-injection seam for crash-window failure tests. */
export const _internals = { applyTerminalEvidence };

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
	const raw = await readText(walPath);
	if (raw === null) return null;
	const observedWal = parseWal(raw);
	if (observedWal.taskId !== taskId)
		throw new Error('TASK_TERMINAL_WAL_TASK_MISMATCH');
	if (observedWal.state !== 'PREPARED') return null;

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
		let plan: Plan = loadedPlan;

		return withTaskEvidenceTransaction(
			directory,
			taskId,
			actor,
			async (transaction) => {
				// The first read is only an inexpensive exact-path fast path. The WAL
				// is authoritative only after both plan and evidence locks are held.
				const lockedRaw = await readText(walPath);
				if (lockedRaw === null) return null;
				const wal = parseWal(lockedRaw);
				if (wal.taskId !== taskId)
					throw new Error('TASK_TERMINAL_WAL_TASK_MISMATCH');
				if (wal.state !== 'PREPARED') return null;
				const task = plan.phases
					.flatMap((phase) => phase.tasks)
					.find((candidate) => candidate.id === taskId);
				if (!task) throw new Error(`TASK_TERMINAL_TASK_MISSING: ${taskId}`);
				const evidence = transaction.read();
				const workflow = getTaskWorkflowSnapshot(evidence);
				const evidenceAlreadyTerminal = evidenceMatchesTerminal(evidence, wal);
				if (
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
				};
			},
		);
	} finally {
		if (lock.lock._release) await lock.lock._release().catch(() => {});
	}
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
	currentPlan: TPlan;
	validateEvidence?: (evidence: TaskEvidence | null) => Promise<void> | void;
	updatePlan: () => Promise<TPlan>;
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
			const raw = await readText(walPath);
			let existingWal = raw === null ? null : parseWal(raw);
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
				existingWal?.state === 'COMMITTED' &&
				existingWal.transitionId === options.transitionId &&
				existingWal.newPlanStatus === options.targetStatus &&
				evidenceMatchesTerminal(evidence, existingWal)
			) {
				return {
					plan: options.currentPlan,
					evidence: evidence as TaskEvidence,
					alreadyApplied: true,
					transitionId: options.transitionId,
				};
			}

			const newWorkflowState =
				options.targetStatus === 'completed' ? 'complete' : 'blocked';
			const wal: TaskTerminalWal = {
				version: 1,
				state: 'PREPARED',
				taskId: options.taskId,
				transitionId: options.transitionId,
				actor: options.actor,
				oldPlanStatus: options.currentPlanStatus,
				newPlanStatus: options.targetStatus,
				oldWorkflowState: workflow.state,
				newWorkflowState,
				generation: workflow.generation,
				qaExempt: options.qaExempt,
				recordedAt: new Date().toISOString(),
			};
			await writeWal(walPath, wal);
			const plan = await options.updatePlan();
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
			};
		},
	);
}
