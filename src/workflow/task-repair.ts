import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
import { assertNoUnsettledCoderDispatch } from './coder-settlement.js';

type RepairWalState = 'ABORTED' | 'COMMITTED' | 'PREPARED';

interface TaskRepairWal {
	version: 1;
	state: RepairWalState;
	taskId: string;
	transitionId: string;
	reason: string;
	actor: string;
	oldPlanStatus: string;
	newPlanStatus: 'in_progress';
	oldWorkflowState: string;
	newWorkflowState: 'idle';
	oldGeneration: number;
	generation: number;
	recordedAt: string;
}

export interface TaskRepairResult<TPlan> {
	plan: TPlan;
	alreadyApplied: boolean;
	generation: number;
	transitionId: string;
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
	const raw = await readText(walPath);
	if (raw === null) return null;
	const observedWal = parseWal(raw);
	if (observedWal.taskId !== taskId)
		throw new Error('TASK_REPAIR_WAL_TASK_MISMATCH');
	if (observedWal.state === 'COMMITTED' || observedWal.state === 'ABORTED')
		return null;

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
		const lockedRaw = await readText(walPath);
		if (lockedRaw === null) return null;
		const wal = parseWal(lockedRaw);
		if (wal.taskId !== taskId) throw new Error('TASK_REPAIR_WAL_TASK_MISMATCH');
		if (wal.state !== 'PREPARED') return null;
		const replay = await replayFromLedgerWithStatus(directory);
		if (replay.truncated) throw new Error('TASK_REPAIR_LEDGER_TRUNCATED');
		const plan = replay.plan ?? (await loadPlanJsonOnly(directory));
		if (!plan) throw new Error('TASK_REPAIR_PLAN_MISSING');
		const task = plan.phases
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
		return await repairTaskWorkflowUnderPlanLock({
			directory,
			taskId,
			actor: wal.actor,
			reason: wal.reason,
			transitionId: wal.transitionId,
			expectedState: wal.oldWorkflowState,
			expectedGeneration: wal.oldGeneration,
			currentPlanStatus: task.status,
			currentPlan: plan,
			updatePlan: () =>
				updateTaskStatus(directory, taskId, 'in_progress', {
					force: true,
					planLockAlreadyHeld: true,
				}),
		});
	} finally {
		if (lock.lock._release) await lock.lock._release().catch(() => {});
	}
}

async function readText(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function parseWal(raw: string): TaskRepairWal {
	const parsed = JSON.parse(raw) as Partial<TaskRepairWal>;
	if (
		parsed.version !== 1 ||
		(parsed.state !== 'PREPARED' &&
			parsed.state !== 'COMMITTED' &&
			parsed.state !== 'ABORTED') ||
		typeof parsed.taskId !== 'string' ||
		typeof parsed.transitionId !== 'string' ||
		typeof parsed.reason !== 'string' ||
		typeof parsed.actor !== 'string' ||
		typeof parsed.oldPlanStatus !== 'string' ||
		parsed.newPlanStatus !== 'in_progress' ||
		typeof parsed.oldWorkflowState !== 'string' ||
		parsed.newWorkflowState !== 'idle' ||
		!Number.isInteger(parsed.generation) ||
		!Number.isInteger(parsed.oldGeneration) ||
		typeof parsed.recordedAt !== 'string'
	) {
		throw new Error('TASK_REPAIR_WAL_CORRUPT');
	}
	return parsed as TaskRepairWal;
}

async function writeWal(filePath: string, wal: TaskRepairWal): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await atomicWriteFile(filePath, `${JSON.stringify(wal, null, 2)}\n`);
}

async function ensureAuditEvent(
	eventsPath: string,
	wal: TaskRepairWal,
): Promise<void> {
	const existing = await readText(eventsPath);
	if (existing) {
		for (const line of existing.split('\n')) {
			if (!line.trim()) continue;
			const event = JSON.parse(line) as Record<string, unknown>;
			if (
				event.type === 'task_workflow_repaired' &&
				event.transitionId === wal.transitionId
			) {
				return;
			}
		}
	}

	await appendFile(
		eventsPath,
		`${JSON.stringify({
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
		})}\n`,
		'utf-8',
	);

	const verified = await readText(eventsPath);
	if (
		!verified?.split('\n').some((line) => {
			if (!line.trim()) return false;
			const event = JSON.parse(line) as Record<string, unknown>;
			return (
				event.type === 'task_workflow_repaired' &&
				event.transitionId === wal.transitionId
			);
		})
	) {
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
	const eventsPath = validateSwarmPath(options.directory, 'events.jsonl');

	return withTaskEvidenceTransaction(
		options.directory,
		options.taskId,
		options.actor,
		async (transaction) => {
			await assertNoUnsettledCoderDispatch(options.directory, options.taskId);
			let evidence = transaction.read();
			let snapshot = getTaskWorkflowSnapshot(evidence);
			const walRaw = await readText(walPath);
			let existingWal = walRaw === null ? null : parseWal(walRaw);
			if (existingWal?.state === 'ABORTED') existingWal = null;

			if (existingWal && existingWal.taskId !== options.taskId) {
				throw new Error('TASK_REPAIR_WAL_TASK_MISMATCH');
			}
			if (existingWal && existingWal.transitionId !== options.transitionId) {
				if (existingWal.state === 'PREPARED') {
					throw new Error(
						`TASK_REPAIR_IN_PROGRESS: transition ${existingWal.transitionId} owns this task repair`,
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
				await ensureAuditEvent(eventsPath, existingWal);
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
				options.currentPlanStatus !== 'blocked'
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

			await ensureAuditEvent(eventsPath, wal);
			await writeWal(walPath, { ...wal, state: 'COMMITTED' });

			return {
				plan,
				alreadyApplied: false,
				generation: wal.generation,
				transitionId: wal.transitionId,
			};
		},
	);
}
