import { createHash } from 'node:crypto';
import type { Plan, TaskStatus } from '../config/plan-schema.js';
import { getTaskWorkflowSnapshot } from '../gate-evidence.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import {
	getOrAdoptPlanEpochUnderLock,
	replayFromLedgerWithStatus,
} from '../plan/ledger.js';
import {
	closePlanTerminalState,
	loadPlanJsonOnly,
	updateTaskStatus,
} from '../plan/manager.js';
import { recoverCoderSettlement } from './coder-settlement.js';
import { recoverPreparedTaskRepairUnderPlanLock } from './task-repair.js';
import {
	commitTaskTerminalUnderPlanLock,
	recoverPreparedTaskTerminalUnderPlanLock,
	type TaskTerminalResult,
} from './task-terminal.js';

export interface CloseTerminalResult {
	plan: Plan;
	closedTaskIds: string[];
	preservedCompletedTaskIds: string[];
	closedPhaseIds: number[];
	/**
	 * Tasks whose terminal state was settled as a QA-exempt forced completion — either
	 * recorded as such by this reconciliation, or already carrying `forcedCompletion`
	 * in durable evidence from an earlier one. Surfaced so `/swarm close` can report
	 * that these tasks did not pass the normal gates; without it a forced completion is
	 * indistinguishable from a genuinely reviewed and tested one.
	 */
	forcedCompletionTaskIds: string[];
}

function createCloseTransitionId(
	planEpoch: string,
	taskId: string,
	target: 'closed' | 'completed',
): string {
	const digest = createHash('sha256')
		.update(JSON.stringify([planEpoch, taskId, target]), 'utf8')
		.digest('hex');
	return `close-terminal:${digest}`;
}

function findTask(plan: Plan, taskId: string) {
	return plan.phases
		.flatMap((phase) => phase.tasks)
		.find((task) => task.id === taskId);
}

interface CloseTaskIntent {
	taskId: string;
	desired: 'closed' | 'completed';
}

function topologyMismatch(detail: string): never {
	throw new Error(`CLOSE_TERMINAL_PLAN_TOPOLOGY_MISMATCH: ${detail}`);
}

function buildAuthoritativeCloseIntent(
	authoritativePlan: Plan,
	targetPlan: Plan,
	requestedClosedTaskIds: readonly string[],
	closedPhaseIds: readonly number[],
): { taskIntents: CloseTaskIntent[]; closedPhaseIds: number[] } {
	if (authoritativePlan.swarm !== targetPlan.swarm) {
		throw new Error(
			`CLOSE_TERMINAL_PLAN_IDENTITY_MISMATCH: swarm changed from ${targetPlan.swarm} to ${authoritativePlan.swarm}`,
		);
	}
	if (authoritativePlan.title !== targetPlan.title) {
		throw new Error(
			`CLOSE_TERMINAL_PLAN_IDENTITY_MISMATCH: title changed from ${targetPlan.title} to ${authoritativePlan.title}`,
		);
	}

	const targetPhaseIds = new Set(targetPlan.phases.map((phase) => phase.id));
	const authoritativePhaseIds = new Set(
		authoritativePlan.phases.map((phase) => phase.id),
	);
	for (const phase of authoritativePlan.phases) {
		if (!targetPhaseIds.has(phase.id)) {
			topologyMismatch(
				`authoritative phase ${phase.id} is missing from close target`,
			);
		}
	}
	for (const phase of targetPlan.phases) {
		if (!authoritativePhaseIds.has(phase.id)) {
			topologyMismatch(`close target includes unknown phase ${phase.id}`);
		}
	}

	const targetPhaseById = new Map(
		targetPlan.phases.map((phase) => [phase.id, phase]),
	);
	const taskIntents: CloseTaskIntent[] = [];
	const authoritativeTaskIds = new Set<string>();

	for (const authoritativePhase of authoritativePlan.phases) {
		const targetPhase = targetPhaseById.get(authoritativePhase.id);
		if (!targetPhase) {
			topologyMismatch(
				`authoritative phase ${authoritativePhase.id} is missing from close target`,
			);
		}
		const targetTaskById = new Map(
			targetPhase.tasks.map((task) => [task.id, task]),
		);
		for (const authoritativeTask of authoritativePhase.tasks) {
			authoritativeTaskIds.add(authoritativeTask.id);
			const targetTask = targetTaskById.get(authoritativeTask.id);
			if (!targetTask) {
				topologyMismatch(
					`authoritative task ${authoritativeTask.id} is missing from close target`,
				);
			}
			if (targetTask.phase !== authoritativePhase.id) {
				topologyMismatch(
					`task ${targetTask.id} moved from authoritative phase ${authoritativePhase.id} to ${targetTask.phase}`,
				);
			}
			if (targetTask.status !== 'closed' && targetTask.status !== 'completed') {
				throw new Error(
					`CLOSE_TERMINAL_TARGET_INVALID: task ${targetTask.id} targets ${targetTask.status}`,
				);
			}
			taskIntents.push({ taskId: targetTask.id, desired: targetTask.status });
		}
		for (const targetTask of targetPhase.tasks) {
			if (!authoritativeTaskIds.has(targetTask.id)) {
				topologyMismatch(`close target includes unknown task ${targetTask.id}`);
			}
		}
	}

	for (const taskId of requestedClosedTaskIds) {
		if (!authoritativeTaskIds.has(taskId)) {
			topologyMismatch(
				`requested close task ${taskId} is not present in the authoritative plan`,
			);
		}
	}
	for (const phaseId of closedPhaseIds) {
		if (!authoritativePhaseIds.has(phaseId)) {
			topologyMismatch(
				`requested closed phase ${phaseId} is not present in the authoritative plan`,
			);
		}
	}

	return { taskIntents, closedPhaseIds: [...closedPhaseIds] };
}

function buildFinalClosePlan(
	authoritativePlan: Plan,
	closedPhaseIds: readonly number[],
): Plan {
	const closedPhaseSet = new Set(closedPhaseIds);
	return {
		...authoritativePlan,
		phases: authoritativePlan.phases.map((phase) =>
			closedPhaseSet.has(phase.id) ? { ...phase, status: 'closed' } : phase,
		),
	};
}

async function loadAuthoritativePlan(directory: string): Promise<Plan> {
	const replay = await replayFromLedgerWithStatus(directory);
	if (replay.truncated) throw new Error('CLOSE_TERMINAL_LEDGER_TRUNCATED');
	const loadedPlan = replay.plan ?? (await loadPlanJsonOnly(directory));
	if (!loadedPlan) throw new Error('CLOSE_TERMINAL_PLAN_MISSING');
	return loadedPlan;
}

/** Reconcile `/swarm close` intent with exact-task workflow authority. */
export async function reconcileCloseTerminalState(
	directory: string,
	targetPlan: Plan,
	options: {
		actor: string;
		requestedClosedTaskIds: string[];
		closedPhaseIds: number[];
		originalStatuses?: Map<string, string>;
	},
): Promise<CloseTerminalResult> {
	const preflightLock = await tryAcquireLock(
		directory,
		'plan.json',
		options.actor,
		`close-terminal-preflight-${Date.now()}`,
	);
	if (!preflightLock.acquired) {
		throw new Error(
			`CLOSE_TERMINAL_PLAN_LOCKED: ${preflightLock.existing?.agent ?? 'another agent'} owns plan.json`,
		);
	}
	let preflightTaskIds: string[];
	try {
		const authoritativePlan = await loadAuthoritativePlan(directory);
		preflightTaskIds = buildAuthoritativeCloseIntent(
			authoritativePlan,
			targetPlan,
			options.requestedClosedTaskIds,
			options.closedPhaseIds,
		).taskIntents.map((task) => task.taskId);
	} finally {
		if (preflightLock.lock._release)
			await preflightLock.lock._release().catch(() => {});
	}

	for (const taskId of preflightTaskIds) {
		await recoverCoderSettlement(directory, taskId);
	}

	const lock = await tryAcquireLock(
		directory,
		'plan.json',
		options.actor,
		`close-terminal-${Date.now()}`,
	);
	if (!lock.acquired) {
		throw new Error(
			`CLOSE_TERMINAL_PLAN_LOCKED: ${lock.existing?.agent ?? 'another agent'} owns plan.json`,
		);
	}

	try {
		let plan = await loadAuthoritativePlan(directory);
		const intent = buildAuthoritativeCloseIntent(
			plan,
			targetPlan,
			options.requestedClosedTaskIds,
			options.closedPhaseIds,
		);
		for (const task of intent.taskIntents) {
			const repaired = await recoverPreparedTaskRepairUnderPlanLock(
				directory,
				task.taskId,
				options.actor,
				plan,
			);
			if (repaired) {
				plan = repaired.plan;
			}
		}
		for (const task of intent.taskIntents) {
			const recovered = await recoverPreparedTaskTerminalUnderPlanLock(
				directory,
				task.taskId,
				options.actor,
				plan,
			);
			if (recovered) {
				plan = recovered.plan;
			}
		}
		const identity = await getOrAdoptPlanEpochUnderLock(directory, plan);
		const requestedClosed = new Set(options.requestedClosedTaskIds);
		const actualClosed = new Set<string>();
		const preservedCompleted = new Set<string>();
		const forcedCompletion = new Set<string>();

		for (const targetTask of intent.taskIntents) {
			// Deliberately re-scanned per iteration rather than hoisted into a
			// Map<taskId, task> before the loop: `plan` is reassigned below from
			// commitTaskTerminalUnderPlanLock's result (and by the recovery helpers
			// above), and currentTask.status is passed as the optimistic-concurrency
			// (CAS) precondition. A pre-built index would feed stale statuses into that
			// check on every iteration after the first.
			const currentTask = findTask(plan, targetTask.taskId);
			if (!currentTask) {
				throw new Error(`CLOSE_TERMINAL_TASK_MISSING: ${targetTask.taskId}`);
			}
			const desired = targetTask.desired;
			const result: TaskTerminalResult<Plan> =
				await commitTaskTerminalUnderPlanLock({
					directory,
					taskId: targetTask.taskId,
					actor: options.actor,
					transitionId: createCloseTransitionId(
						identity.planEpoch,
						targetTask.taskId,
						desired,
					),
					currentPlanStatus: currentTask.status,
					targetStatus: desired,
					qaExempt: desired === 'completed',
					planIdentityHash: identity.planIdentityHash,
					planEpoch: identity.planEpoch,
					currentPlan: plan,
					resolveTerminal: (evidence) => {
						const workflow = getTaskWorkflowSnapshot(evidence);
						if (desired === 'closed') {
							if (workflow.authoritative && workflow.state === 'complete') {
								if (workflow.forcedCompletion === true) {
									forcedCompletion.add(targetTask.taskId);
								}
								return {
									targetStatus: 'completed',
									qaExempt: false,
									preserveEvidence: true,
								};
							}
							if (workflow.authoritative && workflow.state === 'closed') {
								return {
									targetStatus: 'closed',
									qaExempt: false,
									preserveEvidence: true,
								};
							}
							return { targetStatus: 'closed', qaExempt: false };
						}
						if (workflow.authoritative && workflow.state === 'complete') {
							// Evidence already records this as a forced completion from an
							// earlier reconciliation; preserve it but keep reporting it as
							// forced rather than silently treating it as gate-passed.
							if (workflow.forcedCompletion === true) {
								forcedCompletion.add(targetTask.taskId);
							}
							return {
								targetStatus: 'completed',
								qaExempt: false,
								preserveEvidence: true,
							};
						}
						if (workflow.authoritative) {
							throw new Error(
								`CLOSE_TERMINAL_EVIDENCE_CONTRADICTION: task ${targetTask.taskId} is completed in plan intent but exact workflow is ${workflow.state}`,
							);
						}
						forcedCompletion.add(targetTask.taskId);
						return { targetStatus: 'completed', qaExempt: true };
					},
					updatePlan: async (status) =>
						updateTaskStatus(
							directory,
							targetTask.taskId,
							status as TaskStatus,
							{
								planLockAlreadyHeld: true,
								terminalReconciliation: true,
							},
						),
				});
			plan = result.plan;
			if (requestedClosed.has(targetTask.taskId)) {
				if (result.targetStatus === 'closed')
					actualClosed.add(targetTask.taskId);
				if (result.targetStatus === 'completed') {
					preservedCompleted.add(targetTask.taskId);
				}
			}
		}

		const finalPlan = buildFinalClosePlan(plan, intent.closedPhaseIds);
		await closePlanTerminalState(directory, finalPlan, {
			closedPhaseIds: intent.closedPhaseIds,
			closedTaskIds: [],
			originalStatuses: options.originalStatuses,
		});
		return {
			plan: finalPlan,
			closedTaskIds: [...actualClosed],
			preservedCompletedTaskIds: [...preservedCompleted],
			closedPhaseIds: [...intent.closedPhaseIds],
			forcedCompletionTaskIds: [...forcedCompletion],
		};
	} finally {
		if (lock.lock._release) await lock.lock._release().catch(() => {});
	}
}
