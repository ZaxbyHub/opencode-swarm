import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../background/pending-delegations.js';
import { changedFilesSinceSnapshot } from '../background/workspace-snapshot.js';
import {
	getTaskWorkflowSnapshot,
	type TaskEvidence,
	withTaskEvidenceTransaction,
} from '../gate-evidence.js';
import { isMarkdownOnlyTaskChange } from '../gate-evidence-classification.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { isPathWithinDeclaredScope } from '../scope/path-identity.js';
import type { MergeOperationProvenance } from '../worktree/merge.js';
import { reconcileLandedMerge } from '../worktree/merge.js';
import {
	readWorkflowWalFile,
	writeWorkflowWalFile,
} from './workflow-wal-file.js';
import type { CoderSettlementWal } from './workflow-wal-schema.js';

export interface CoderSettlementResult {
	evidence: TaskEvidence;
	accepted: boolean;
	alreadyApplied: boolean;
}

const LIVE_DISPATCHES_SYMBOL = Symbol.for(
	'opencode-swarm.workflow.coder-settlement.live-dispatches',
);
const globalRegistry = globalThis as typeof globalThis & {
	[LIVE_DISPATCHES_SYMBOL]?: Set<string>;
};
if (!globalRegistry[LIVE_DISPATCHES_SYMBOL]) {
	globalRegistry[LIVE_DISPATCHES_SYMBOL] = new Set<string>();
}
const liveDispatches = globalRegistry[LIVE_DISPATCHES_SYMBOL];
const runtimeId = randomUUID();
const MAX_LIVE_DISPATCHES = 512;

function dispatchKey(
	directory: string,
	taskId: string,
	transitionId: string,
): string {
	return `${directory}\u0000${taskId}\u0000${transitionId}`;
}

function walPath(directory: string, taskId: string): string {
	return validateSwarmPath(directory, `coder-settlements/${taskId}.json`);
}

async function readWal(
	filePath: string,
	taskId: string,
): Promise<CoderSettlementWal | null> {
	return readWorkflowWalFile('coder-settlement', filePath, taskId);
}

async function withSettlementLock<T>(
	directory: string,
	taskId: string,
	actor: string,
	operation: () => Promise<T>,
): Promise<T> {
	const target = `coder-settlements/${taskId}.json`;
	const lock = await tryAcquireLock(
		directory,
		target,
		actor,
		`coder-settlement-${taskId}-${Date.now()}`,
	);
	if (!lock.acquired) {
		throw new Error(`CODER_SETTLEMENT_LOCKED: task ${taskId}`);
	}
	try {
		return await operation();
	} finally {
		await lock.lock._release?.().catch(() => undefined);
	}
}

async function writeWal(
	filePath: string,
	wal: CoderSettlementWal,
): Promise<void> {
	await writeWorkflowWalFile('coder-settlement', filePath, wal);
}

function isProcessAlive(processId: number): boolean {
	if (processId === process.pid) return true;
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function scopedObservedFiles(
	directory: string,
	context: BackgroundTaskChangeContext,
): string[] | null {
	const baseline = { ...context.baseline, directory };
	const observed = changedFilesSinceSnapshot(directory, baseline);
	if (!observed || !context.declaredFiles) return null;
	return observed.filter((filePath) =>
		isPathWithinDeclaredScope(filePath, context.declaredFiles ?? [], directory),
	);
}

async function commitPrepared(
	directory: string,
	wal: CoderSettlementWal,
): Promise<CoderSettlementResult> {
	return withTaskEvidenceTransaction(
		directory,
		wal.taskId,
		wal.actor,
		async (transaction) => {
			let lockedWal = await readWal(walPath(directory, wal.taskId), wal.taskId);
			if (lockedWal === null) throw new Error('CODER_SETTLEMENT_WAL_MISSING');
			if (lockedWal.transitionId !== wal.transitionId) {
				throw new Error('CODER_SETTLEMENT_WAL_REPLACED');
			}
			const snapshot = getTaskWorkflowSnapshot(transaction.read());
			const evidenceAlreadySettled =
				lockedWal.accepted === true
					? snapshot.authoritative &&
						snapshot.state ===
							(lockedWal.settlementFailed === true
								? 'rework_required'
								: 'coder_delegated') &&
						snapshot.generation === lockedWal.expectedGeneration + 1 &&
						snapshot.lastOutcome ===
							(lockedWal.settlementFailed === true
								? 'accepted_mutation_failed'
								: 'accepted_mutation') &&
						snapshot.lastTransitionId === lockedWal.transitionId
					: snapshot.generation === lockedWal.expectedGeneration &&
						snapshot.lastOutcome === 'dispatch_no_mutation' &&
						snapshot.lastTransitionId === lockedWal.transitionId;
			if (evidenceAlreadySettled) {
				if (lockedWal.state !== 'COMMITTED') {
					lockedWal = {
						...lockedWal,
						state: 'COMMITTED',
						cleanupComplete: lockedWal.worktree === undefined,
					};
					await writeWal(walPath(directory, wal.taskId), lockedWal);
				}
				return {
					evidence: transaction.read() as TaskEvidence,
					accepted: lockedWal.accepted === true,
					alreadyApplied: true,
				};
			}
			if (lockedWal.state !== 'PREPARED') {
				throw new Error('CODER_SETTLEMENT_NOT_PREPARED');
			}
			const evidence = await transaction.transition(
				lockedWal.accepted
					? {
							type: 'accepted_mutation',
							agentType: 'coder',
							context: {
								testEngineerExempt: lockedWal.testEngineerExempt === true,
								settlementFailed: lockedWal.settlementFailed === true,
							},
							expectedGeneration: lockedWal.expectedGeneration,
							transitionId: lockedWal.transitionId,
						}
					: {
							type: 'dispatch_no_mutation',
							agentType: 'coder',
							expectedGeneration: lockedWal.expectedGeneration,
							transitionId: lockedWal.transitionId,
						},
			);
			lockedWal = {
				...lockedWal,
				state: 'COMMITTED',
				cleanupComplete: lockedWal.worktree === undefined,
			};
			await writeWal(walPath(directory, wal.taskId), lockedWal);
			return {
				evidence,
				accepted: lockedWal.accepted === true,
				alreadyApplied: false,
			};
		},
	);
}

export async function beginCoderSettlement(options: {
	directory: string;
	taskId: string;
	transitionId: string;
	actor: string;
	expectedGeneration: number;
	context: BackgroundTaskChangeContext;
	worktree?: BackgroundWorktreeDescriptor;
}): Promise<void> {
	const filePath = walPath(options.directory, options.taskId);
	let ownsActiveDispatch = false;
	await withSettlementLock(
		options.directory,
		options.taskId,
		options.actor,
		() =>
			withTaskEvidenceTransaction(
				options.directory,
				options.taskId,
				options.actor,
				async (transaction) => {
					const snapshot = getTaskWorkflowSnapshot(transaction.read());
					if (snapshot.generation !== options.expectedGeneration) {
						throw new Error(
							`TASK_WORKFLOW_GENERATION_MISMATCH: expected ${options.expectedGeneration}, found ${snapshot.generation}`,
						);
					}
					// readWal forwards options.taskId as expectedTaskId, so
					// parseCoderSettlementWal already raised
					// CODER_SETTLEMENT_WAL_TASK_MISMATCH (with path and remediation) for a
					// foreign WAL. A caller-side re-check here would be unreachable.
					const existing = await readWal(filePath, options.taskId);
					if (existing !== null) {
						if (
							(existing.state === 'DISPATCHED' ||
								existing.state === 'PREPARED') &&
							existing.transitionId !== options.transitionId
						) {
							throw new Error(
								`CODER_SETTLEMENT_IN_PROGRESS: transition ${existing.transitionId} owns task ${options.taskId}, so transition ${options.transitionId} cannot dispatch it (${filePath}, state ${existing.state}). Wait for the owning transition to settle or run coder-settlement recovery for this task, then retry; do not remove the WAL by hand.`,
							);
						}
						if (existing.transitionId === options.transitionId) {
							const immutableMatches =
								existing.actor === options.actor &&
								existing.expectedGeneration === options.expectedGeneration &&
								JSON.stringify(existing.context) ===
									JSON.stringify(options.context) &&
								JSON.stringify(existing.worktree) ===
									JSON.stringify(options.worktree);
							if (!immutableMatches) {
								throw new Error('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
							}
							if (existing.state === 'ABORTED') {
								throw new Error('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
							}
							ownsActiveDispatch =
								existing.state === 'DISPATCHED' &&
								existing.runtimeId === runtimeId;
							return;
						}
					}
					await transaction.transition({
						type: 'dispatch_attempted',
						agentType: 'coder',
						expectedGeneration: options.expectedGeneration,
						transitionId: options.transitionId,
					});
					await writeWal(filePath, {
						version: 1,
						state: 'DISPATCHED',
						taskId: options.taskId,
						transitionId: options.transitionId,
						actor: options.actor,
						processId: process.pid,
						runtimeId,
						expectedGeneration: options.expectedGeneration,
						context: options.context,
						...(options.worktree ? { worktree: options.worktree } : {}),
						recordedAt: new Date().toISOString(),
					});
					ownsActiveDispatch = true;
				},
			),
	);
	if (ownsActiveDispatch) {
		const key = dispatchKey(
			options.directory,
			options.taskId,
			options.transitionId,
		);
		if (
			!liveDispatches.has(key) &&
			liveDispatches.size >= MAX_LIVE_DISPATCHES
		) {
			throw new Error('CODER_SETTLEMENT_CAPACITY_EXCEEDED');
		}
		liveDispatches.add(key);
	}
}

export async function settleCoderDispatch(options: {
	directory: string;
	taskId: string;
	transitionId: string;
	accepted: boolean;
	testEngineerExempt: boolean;
	settlementFailed?: boolean;
}): Promise<CoderSettlementResult> {
	return withSettlementLock(
		options.directory,
		options.taskId,
		'coder-settlement',
		async () => {
			const filePath = walPath(options.directory, options.taskId);
			const wal = await readWal(filePath, options.taskId);
			if (wal === null) throw new Error('CODER_SETTLEMENT_WAL_MISSING');
			// Task-id mismatch is owned by parseCoderSettlementWal (see readWal above).
			if (wal.transitionId !== options.transitionId) {
				throw new Error('CODER_SETTLEMENT_WAL_REPLACED');
			}
			if (wal.state === 'COMMITTED') {
				if (
					wal.accepted !== options.accepted ||
					wal.testEngineerExempt !== options.testEngineerExempt ||
					wal.settlementFailed !== (options.settlementFailed === true)
				) {
					throw new Error('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
				}
				return commitPrepared(options.directory, wal);
			}
			if (wal.state === 'ABORTED') {
				throw new Error('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
			}
			if (
				wal.state === 'PREPARED' &&
				(wal.accepted !== options.accepted ||
					wal.testEngineerExempt !== options.testEngineerExempt ||
					wal.settlementFailed !== (options.settlementFailed === true))
			) {
				throw new Error('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
			}
			const prepared: CoderSettlementWal = {
				...wal,
				state: 'PREPARED',
				accepted: options.accepted,
				testEngineerExempt: options.testEngineerExempt,
				settlementFailed: options.settlementFailed === true,
			};
			if (wal.state !== 'PREPARED') await writeWal(filePath, prepared);
			liveDispatches.delete(
				dispatchKey(options.directory, options.taskId, options.transitionId),
			);
			try {
				return await commitPrepared(options.directory, prepared);
			} finally {
				const finalWal = await readWal(filePath, options.taskId);
				if (finalWal !== null && finalWal.state === 'COMMITTED') {
					liveDispatches.delete(
						dispatchKey(
							options.directory,
							options.taskId,
							options.transitionId,
						),
					);
				}
			}
		},
	);
}

export async function recordCoderMergeProvenance(options: {
	directory: string;
	taskId: string;
	transitionId: string;
	provenance: MergeOperationProvenance;
	observedFiles: string[];
}): Promise<void> {
	await withSettlementLock(
		options.directory,
		options.taskId,
		'coder-merge-provenance',
		async () => {
			const filePath = walPath(options.directory, options.taskId);
			const wal = await readWal(filePath, options.taskId);
			if (wal === null) throw new Error('CODER_SETTLEMENT_WAL_MISSING');
			if (
				wal.taskId !== options.taskId ||
				wal.transitionId !== options.transitionId
			) {
				throw new Error('CODER_SETTLEMENT_WAL_REPLACED');
			}
			if (wal.state !== 'DISPATCHED') {
				const sameProvenance =
					JSON.stringify(wal.mergeProvenance) ===
						JSON.stringify(options.provenance) &&
					JSON.stringify(wal.observedFiles) ===
						JSON.stringify(options.observedFiles);
				if (!sameProvenance)
					throw new Error('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
				return;
			}
			await writeWal(filePath, {
				...wal,
				mergeProvenance: options.provenance,
				observedFiles: [...options.observedFiles],
			});
		},
	);
}

async function cleanupRecoveredWorktree(
	directory: string,
	descriptor: BackgroundWorktreeDescriptor,
): Promise<void> {
	const branchExists = (): boolean => {
		const result = spawnSync(
			'git',
			[
				'-C',
				directory,
				'show-ref',
				'--verify',
				'--quiet',
				`refs/heads/${descriptor.branchName}`,
			],
			{
				cwd: directory,
				stdio: ['ignore', 'ignore', 'ignore'],
				timeout: 5_000,
				windowsHide: true,
			},
		);
		if (result.error) throw result.error;
		if (result.status === 0) return true;
		if (result.status === 1) return false;
		throw new Error(
			`CODER_SETTLEMENT_CLEANUP_UNCERTAIN: git show-ref exited with status ${String(result.status)}`,
		);
	};
	const hasResidue = existsSync(descriptor.worktreePath) || branchExists();
	const {
		awaitingMergeByCallID,
		cleanupStandardWorktreeForCallId,
		standardWorktreeByCallID,
	} = await import('../hooks/delegation-gate/worktree-isolation.js');
	standardWorktreeByCallID.delete(descriptor.callID);
	if (hasResidue)
		awaitingMergeByCallID.set(descriptor.callID, {
			callID: descriptor.callID,
			parentSessionID: descriptor.parentSessionId,
			taskId: descriptor.taskId,
			...(descriptor.planTaskId ? { planTaskId: descriptor.planTaskId } : {}),
			branch: descriptor.branchName,
			worktreePath: descriptor.worktreePath,
			mergeStrategy: descriptor.mergeStrategy,
			queuedAt: Date.now(),
		});
	if (hasResidue) {
		await cleanupStandardWorktreeForCallId(
			descriptor.callID,
			'success',
			directory,
			descriptor.worktreeDir ?? undefined,
		);
	}
	if (existsSync(descriptor.worktreePath) || branchExists()) {
		throw new Error('CODER_SETTLEMENT_WORKTREE_CLEANUP_UNVERIFIED');
	}
	const { removeWorktreeProvisioningOwner } = await import(
		'../hooks/delegation-gate/worktree-provisioning-owner.js'
	);
	if (!removeWorktreeProvisioningOwner(directory, descriptor.callID)) {
		throw new Error('CODER_SETTLEMENT_OWNER_CLEANUP_FAILED');
	}
}

export async function completeCoderSettlementCleanup(
	directory: string,
	taskId: string,
	transitionId: string,
): Promise<void> {
	await withSettlementLock(directory, taskId, 'coder-cleanup', async () => {
		const filePath = walPath(directory, taskId);
		const wal = await readWal(filePath, taskId);
		if (wal === null) throw new Error('CODER_SETTLEMENT_WAL_MISSING');
		if (wal.taskId !== taskId || wal.transitionId !== transitionId) {
			throw new Error('CODER_SETTLEMENT_WAL_REPLACED');
		}
		if (wal.state !== 'COMMITTED') {
			throw new Error('CODER_SETTLEMENT_NOT_COMMITTED');
		}
		if (!wal.worktree || wal.cleanupComplete === true) return;
		await cleanupRecoveredWorktree(directory, wal.worktree);
		await writeWal(filePath, { ...wal, cleanupComplete: true });
	});
}

export async function recoverCoderSettlement(
	directory: string,
	taskId: string,
): Promise<CoderSettlementResult | null> {
	return withSettlementLock(directory, taskId, 'coder-recovery', async () => {
		const filePath = walPath(directory, taskId);
		const existingWal = await readWal(filePath, taskId);
		if (existingWal === null) return null;
		let wal: CoderSettlementWal = existingWal;
		if (wal.state === 'ABORTED') return null;
		if (wal.state === 'COMMITTED') {
			if (wal.worktree && wal.cleanupComplete !== true) {
				await cleanupRecoveredWorktree(directory, wal.worktree);
				await writeWal(filePath, { ...wal, cleanupComplete: true });
			}
			return null;
		}
		const key = dispatchKey(directory, taskId, wal.transitionId);
		if (
			liveDispatches.has(key) ||
			(wal.processId !== process.pid && isProcessAlive(wal.processId))
		) {
			throw new Error(
				`CODER_DISPATCH_IN_PROGRESS: transition ${wal.transitionId} still owns task ${taskId} (${filePath}, state ${wal.state}, pid ${wal.processId}). Wait for that dispatch to settle or recover it before retrying; do not remove the WAL by hand.`,
			);
		}
		if (wal.state === 'DISPATCHED') {
			if (wal.worktree) {
				const worktree = wal.worktree;
				const observed =
					wal.observedFiles ??
					scopedObservedFiles(worktree.worktreePath, wal.context);
				if (observed === null) {
					throw new Error(
						`CODER_SETTLEMENT_RECOVERY_UNCERTAIN: isolated task ${taskId} changes could not be attributed safely`,
					);
				}
				if (wal.mergeProvenance) {
					const landed = await reconcileLandedMerge(
						directory,
						wal.mergeProvenance,
					);
					if (landed.landed) {
						wal = {
							...wal,
							state: 'PREPARED',
							observedFiles: observed,
							accepted: observed.length > 0,
							testEngineerExempt: isMarkdownOnlyTaskChange(
								wal.context.declaredFiles,
								observed,
							),
						};
						await writeWal(filePath, wal);
						const committed = await commitPrepared(directory, wal);
						await cleanupRecoveredWorktree(directory, worktree);
						await writeWal(filePath, {
							...wal,
							state: 'COMMITTED',
							cleanupComplete: true,
						});
						return committed;
					}
					if (landed.error) {
						throw new Error(
							`CODER_SETTLEMENT_RECOVERY_UNCERTAIN: ${landed.error}`,
						);
					}
				}

				const {
					awaitingMergeByCallID,
					finishStandardWorktreeDispatch,
					standardWorktreeByCallID,
				} = await import('../hooks/delegation-gate/worktree-isolation.js');
				const descriptor = wal.worktree;
				const reconstructedDispatch = {
					callID: descriptor.callID,
					parentSessionID: descriptor.parentSessionId,
					taskId: descriptor.taskId,
					...(descriptor.planTaskId
						? { planTaskId: descriptor.planTaskId }
						: {}),
					handle: {
						worktreePath: descriptor.worktreePath,
						branchName: descriptor.branchName,
						purpose: 'lane' as const,
						id: descriptor.worktreeId,
						sessionId: descriptor.worktreeSessionId,
					},
					mergeStrategy: descriptor.mergeStrategy,
					laneIndex: descriptor.laneIndex,
					...(descriptor.worktreeDir
						? { worktree_dir: descriptor.worktreeDir }
						: {}),
				};
				standardWorktreeByCallID.delete(descriptor.callID);
				awaitingMergeByCallID.set(descriptor.callID, {
					callID: descriptor.callID,
					parentSessionID: descriptor.parentSessionId,
					taskId: descriptor.taskId,
					...(descriptor.planTaskId
						? { planTaskId: descriptor.planTaskId }
						: {}),
					branch: descriptor.branchName,
					worktreePath: descriptor.worktreePath,
					mergeStrategy: descriptor.mergeStrategy,
					queuedAt: Date.now(),
				});
				let recovered: CoderSettlementResult | null = null;
				const mergeResult = await finishStandardWorktreeDispatch(
					directory,
					reconstructedDispatch,
					undefined,
					descriptor.callID,
					{
						operationId: wal.transitionId,
						...(wal.mergeProvenance ? { resume: wal.mergeProvenance } : {}),
						onBeforeMerge: async (provenance) => {
							wal = {
								...wal,
								mergeProvenance: provenance,
								observedFiles: observed,
							};
							await writeWal(filePath, wal);
						},
						onMerged: async () => {
							wal = {
								...wal,
								state: 'PREPARED',
								accepted: observed.length > 0,
								testEngineerExempt: isMarkdownOnlyTaskChange(
									wal.context.declaredFiles,
									observed,
								),
							};
							await writeWal(filePath, wal);
							recovered = await commitPrepared(directory, wal);
						},
					},
				);
				if (mergeResult.outcome !== 'merged' || recovered === null) {
					// #2202: still bare — unlike the seven enriched state-conflict errors
					// this one names neither the WAL path nor a recovery action. Reaching
					// it needs a failed-worktree-merge fixture, so it is tracked rather
					// than changed untested.
					throw new Error(
						`CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED: ${mergeResult.outcome === 'failed' ? mergeResult.message : mergeResult.outcome}`,
					);
				}
				await cleanupRecoveredWorktree(directory, descriptor);
				const committedWal = await readWal(filePath, taskId);
				if (committedWal === null) {
					throw new Error('CODER_SETTLEMENT_WAL_MISSING');
				}
				await writeWal(filePath, {
					...committedWal,
					cleanupComplete: true,
				});
				return recovered;
			}

			const observed = scopedObservedFiles(directory, wal.context);
			if (observed === null) {
				// #2202: still bare — names the task but not the WAL path or a recovery
				// action. Reaching it needs a baseline snapshot changedFilesSinceSnapshot
				// cannot resolve, so it is tracked rather than changed untested.
				throw new Error(
					`CODER_SETTLEMENT_RECOVERY_UNCERTAIN: task ${taskId} workspace changes could not be attributed safely`,
				);
			}
			wal = {
				...wal,
				state: 'PREPARED',
				accepted: observed.length > 0,
				testEngineerExempt: isMarkdownOnlyTaskChange(
					wal.context.declaredFiles,
					observed,
				),
			};
			await writeWal(filePath, wal);
		}
		const committed = await commitPrepared(directory, wal);
		if (wal.worktree) {
			await cleanupRecoveredWorktree(directory, wal.worktree);
			const committedWal = await readWal(filePath, taskId);
			if (committedWal === null) {
				throw new Error('CODER_SETTLEMENT_WAL_MISSING');
			}
			await writeWal(filePath, { ...committedWal, cleanupComplete: true });
		}
		return committed;
	});
}

export function releaseCoderDispatchOwnership(
	directory: string,
	taskId: string,
	transitionId: string,
): void {
	liveDispatches.delete(dispatchKey(directory, taskId, transitionId));
}

export async function assertNoUnsettledCoderDispatch(
	directory: string,
	taskId: string,
): Promise<void> {
	const filePath = walPath(directory, taskId);
	const wal = await readWal(filePath, taskId);
	if (wal === null) return;
	if (wal.state === 'DISPATCHED' || wal.state === 'PREPARED') {
		throw new Error(
			`CODER_SETTLEMENT_RECOVERY_REQUIRED: transition ${wal.transitionId} must settle before task ${taskId} can change plan status (${filePath}, state ${wal.state}). Run coder-settlement recovery for this task, then retry.`,
		);
	}
}

export const _internals = {
	liveDispatches,
};
