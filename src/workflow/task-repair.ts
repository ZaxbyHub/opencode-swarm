import {
	appendCoreEventSync,
	CORE_EVENT_LOCKED,
	hasTaskRepairAuditEvent,
} from '../events/core-events.js';
import {
	getTaskWorkflowSnapshot,
	type TaskEvidence,
	withTaskEvidenceTransaction,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { replayFromLedgerWithStatus } from '../plan/ledger.js';
import { loadPlanJsonOnly, updateTaskStatus } from '../plan/manager.js';
import { assertNoUnsettledCoderDispatch } from './coder-settlement.js';
import {
	readWorkflowWalFile,
	writeWorkflowWalFile,
} from './workflow-wal-file.js';
import type { TaskRepairWal } from './workflow-wal-schema.js';

export interface TaskRepairResult<TPlan> {
	plan: TPlan;
	alreadyApplied: boolean;
	generation: number;
	transitionId: string;
}

async function recoverPreparedTaskRepairWithPlanLock(
	directory: string,
	taskId: string,
	actor: string,
	currentPlan: NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>,
): Promise<TaskRepairResult<
	NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>
> | null> {
	const walPath = validateSwarmPath(directory, `task-repairs/${taskId}.json`);
	// Single read: this helper always runs with plan.json already locked by the
	// caller, so the pre-lock observe half of the observe-then-reread idiom
	// (see recoverPreparedTaskRepair) has no meaning here.
	const wal = await readWal(walPath, taskId);
	if (wal === null) return null;
	if (wal.state === 'ABORTED') return null;
	if (wal.state === 'COMMITTED') {
		await ensureAuditEvent(directory, wal);
		return null;
	}
	const task = currentPlan.phases
		.flatMap((phase) => phase.tasks)
		.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`TASK_REPAIR_TASK_MISSING: ${taskId}`);
	if (task.status === wal.oldPlanStatus) {
		const aborted = await withTaskEvidenceTransaction(
			directory,
			taskId,
			actor,
			async (transaction) => {
				const workflow = getTaskWorkflowSnapshot(transaction.read());
				if (
					workflow.state !== wal.oldWorkflowState ||
					workflow.generation !== wal.oldGeneration
				) {
					return false;
				}
				await writeWal(walPath, { ...wal, state: 'ABORTED' });
				return true;
			},
		);
		if (aborted) return null;
	}
	return repairTaskWorkflowUnderPlanLock({
		directory,
		taskId,
		actor: wal.actor,
		reason: wal.reason,
		transitionId: wal.transitionId,
		expectedState: wal.oldWorkflowState,
		expectedGeneration: wal.oldGeneration,
		currentPlanStatus: task.status,
		currentPlan,
		updatePlan: () =>
			updateTaskStatus(directory, taskId, 'in_progress', {
				force: true,
				planLockAlreadyHeld: true,
			}),
	});
}

/**
 * Lazily finish an exact PREPARED repair before another operation reasons about
 * the task. This reads only the exact per-task WAL path; it never scans.
 */
export async function recoverPreparedTaskRepair(
	directory: string,
	taskId: string,
	actor: string,
): Promise<TaskRepairResult<
	NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>
> | null> {
	const walPath = validateSwarmPath(directory, `task-repairs/${taskId}.json`);
	const observedWal = await readWal(walPath, taskId);
	if (observedWal === null || observedWal.state === 'ABORTED') return null;
	if (observedWal.state === 'COMMITTED') {
		await ensureAuditEvent(directory, observedWal);
		return null;
	}
	const lock = await tryAcquireLock(
		directory,
		'plan.json',
		actor,
		`recover-task-repair-${taskId}-${Date.now()}`,
	);
	if (!lock.acquired) {
		throw new Error(
			`TASK_REPAIR_RECOVERY_LOCKED: ${lock.existing?.agent ?? 'another agent'} owns plan.json`,
		);
	}
	try {
		const replay = await replayFromLedgerWithStatus(directory);
		if (replay.truncated) throw new Error('TASK_REPAIR_LEDGER_TRUNCATED');
		const plan = replay.plan ?? (await loadPlanJsonOnly(directory));
		if (!plan) throw new Error('TASK_REPAIR_PLAN_MISSING');
		return await recoverPreparedTaskRepairWithPlanLock(
			directory,
			taskId,
			actor,
			plan,
		);
	} finally {
		if (lock.lock._release) await lock.lock._release().catch(() => {});
	}
}

export async function recoverPreparedTaskRepairUnderPlanLock(
	directory: string,
	taskId: string,
	actor: string,
	currentPlan: NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>,
): Promise<TaskRepairResult<
	NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>
> | null> {
	return recoverPreparedTaskRepairWithPlanLock(
		directory,
		taskId,
		actor,
		currentPlan,
	);
}

async function readWal(
	filePath: string,
	taskId: string,
): Promise<TaskRepairWal | null> {
	return readWorkflowWalFile('task-repair', filePath, taskId);
}

async function writeWal(filePath: string, wal: TaskRepairWal): Promise<void> {
	await writeWorkflowWalFile('task-repair', filePath, wal);
}

async function ensureAuditEvent(
	directory: string,
	wal: TaskRepairWal,
): Promise<void> {
	// Steady-state check (issue #2039): once the audit event is durably
	// present, every later lazy-recovery call for this task (the COMMITTED
	// WAL is never deleted) confirms it from the authoritative core event
	// index instead of scanning the file.
	if (hasTaskRepairAuditEvent(directory, wal.taskId, wal.transitionId)) {
		return;
	}

	// Issue #2039: the store's exclusive lock replaces the former
	// tryAcquireLock/proper-lockfile sentinel, and dedupeOnAuthorityKey
	// restores the lock-scoped re-check. The hard-fail contract is preserved.
	try {
		appendCoreEventSync(
			directory,
			{
				type: 'task_workflow_repaired',
				timestamp: new Date().toISOString(),
				taskId: wal.taskId,
				transitionId: wal.transitionId,
				reason: wal.reason,
				actor: wal.actor,
				oldPlanStatus: wal.oldPlanStatus,
				newPlanStatus: wal.newPlanStatus,
				oldWorkflowState: wal.oldWorkflowState,
				newWorkflowState: wal.newWorkflowState,
				generation: wal.generation,
			},
			{ dedupeOnAuthorityKey: true },
		);
	} catch (error) {
		if (error instanceof Error && error.message === CORE_EVENT_LOCKED) {
			throw new Error('TASK_REPAIR_AUDIT_LOCKED');
		}
		throw error;
	}

	if (!hasTaskRepairAuditEvent(directory, wal.taskId, wal.transitionId)) {
		throw new Error('TASK_REPAIR_AUDIT_UNVERIFIED');
	}
}

function workflowMatchesCommittedRepair(
	evidence: TaskEvidence | null,
	wal: TaskRepairWal,
): boolean {
	const snapshot = getTaskWorkflowSnapshot(evidence);
	return (
		snapshot.state === 'idle' &&
		snapshot.generation === wal.generation &&
		snapshot.lastTransitionId === wal.transitionId
	);
}

/**
 * Execute or lazily finish one exact-task repair while the caller holds the
 * plan lock. Lock ordering is therefore always plan -> exact task evidence.
 * The PREPARED marker is written before the plan projection changes, making a
 * retry able to finish a new-plan/old-evidence partial commit without scanning.
 */
export async function repairTaskWorkflowUnderPlanLock<TPlan>(options: {
	directory: string;
	taskId: string;
	actor: string;
	reason: string;
	transitionId: string;
	expectedState: string;
	expectedGeneration: number;
	currentPlanStatus: string;
	currentPlan: TPlan;
	updatePlan: () => Promise<TPlan>;
}): Promise<TaskRepairResult<TPlan>> {
	const walPath = validateSwarmPath(
		options.directory,
		`task-repairs/${options.taskId}.json`,
	);

	return withTaskEvidenceTransaction(
		options.directory,
		options.taskId,
		options.actor,
		async (transaction) => {
			await assertNoUnsettledCoderDispatch(options.directory, options.taskId);
			let evidence = transaction.read();
			let snapshot = getTaskWorkflowSnapshot(evidence);
			let existingWal = await readWal(walPath, options.taskId);
			if (existingWal?.state === 'ABORTED') existingWal = null;
			if (existingWal && existingWal.transitionId !== options.transitionId) {
				if (existingWal.state === 'PREPARED') {
					throw new Error(
						`TASK_REPAIR_IN_PROGRESS: transition ${existingWal.transitionId} owns the repair for task ${options.taskId} (${walPath}, state PREPARED); requested transition ${options.transitionId}. Recover or abort the owning repair transition before retrying.`,
					);
				}
				// A committed repair is immutable history, not a permanent per-task
				// lease. A later, independently CAS-validated repair replaces the WAL.
				existingWal = null;
			}
			if (
				existingWal &&
				(existingWal.reason !== options.reason ||
					existingWal.oldWorkflowState !== options.expectedState ||
					existingWal.oldGeneration !== options.expectedGeneration)
			) {
				throw new Error(
					`TASK_REPAIR_IDEMPOTENCY_CONFLICT: transition ${options.transitionId} was prepared with different reason or workflow CAS fields`,
				);
			}

			if (
				existingWal?.state === 'COMMITTED' &&
				options.currentPlanStatus === 'in_progress' &&
				workflowMatchesCommittedRepair(evidence, existingWal)
			) {
				await ensureAuditEvent(options.directory, existingWal);
				return {
					plan: options.currentPlan,
					alreadyApplied: true,
					generation: existingWal.generation,
					transitionId: existingWal.transitionId,
				};
			}
			if (
				existingWal === null &&
				options.currentPlanStatus !== 'completed' &&
				options.currentPlanStatus !== 'blocked' &&
				options.currentPlanStatus !== 'closed'
			) {
				throw new Error(
					`TASK_REPAIR_NOT_BACKWARD: cannot create a repair from plan status ${options.currentPlanStatus}`,
				);
			}

			const wal =
				existingWal ??
				({
					version: 1,
					state: 'PREPARED',
					taskId: options.taskId,
					transitionId: options.transitionId,
					reason: options.reason,
					actor: options.actor,
					oldPlanStatus: options.currentPlanStatus,
					newPlanStatus: 'in_progress',
					oldWorkflowState: options.expectedState,
					newWorkflowState: 'idle',
					oldGeneration: options.expectedGeneration,
					generation: options.expectedGeneration + 1,
					recordedAt: new Date().toISOString(),
				} satisfies TaskRepairWal);

			const evidenceAlreadyRepaired = workflowMatchesCommittedRepair(
				evidence,
				wal,
			);
			if (!evidenceAlreadyRepaired) {
				if (
					snapshot.state !== wal.oldWorkflowState ||
					snapshot.generation !== wal.oldGeneration
				) {
					throw new Error(
						`TASK_REPAIR_CAS_MISMATCH: expected ${wal.oldWorkflowState}@${wal.oldGeneration}, found ${snapshot.state}@${snapshot.generation}`,
					);
				}
			}

			if (existingWal === null) await writeWal(walPath, wal);

			let plan = options.currentPlan;
			if (options.currentPlanStatus !== wal.newPlanStatus) {
				if (options.currentPlanStatus !== wal.oldPlanStatus) {
					throw new Error(
						`TASK_REPAIR_PLAN_CAS_MISMATCH: expected ${wal.oldPlanStatus}, found ${options.currentPlanStatus}`,
					);
				}
				plan = await options.updatePlan();
			}

			if (!evidenceAlreadyRepaired) {
				evidence = await transaction.transition({
					type: 'repair_idle',
					expectedGeneration: wal.oldGeneration,
					transitionId: wal.transitionId,
				});
				snapshot = getTaskWorkflowSnapshot(evidence);
				if (
					snapshot.state !== 'idle' ||
					snapshot.generation !== wal.generation
				) {
					throw new Error('TASK_REPAIR_EVIDENCE_UNVERIFIED');
				}
			}

			// Commit the WAL before the audit event so a transient events.jsonl
			// lock contention in ensureAuditEvent cannot leave this task fenced
			// behind a permanently PREPARED WAL (see assertTaskEvidenceWriteAllowed).
			// A retry after a lock-contention throw here lands on the
			// alreadyApplied fast path above and only needs to re-attempt the
			// audit event, which is itself idempotent per exact task and transition ID.
			await writeWal(walPath, { ...wal, state: 'COMMITTED' });
			await ensureAuditEvent(options.directory, wal);

			return {
				plan,
				alreadyApplied: false,
				generation: wal.generation,
				transitionId: wal.transitionId,
			};
		},
	);
}
