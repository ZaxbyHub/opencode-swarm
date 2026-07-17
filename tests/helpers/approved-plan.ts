import type { Plan, TaskStatus } from '../../src/config/plan-schema';
import {
	computePlanStructureHash,
	initLedger,
	ledgerExists,
	takeSnapshotEvent,
} from '../../src/plan/ledger';
import { savePlan } from '../../src/plan/manager';
import { derivePlanId } from '../../src/plan/utils';

export interface ScopedPlanTask {
	id: string;
	files: string[];
	status?: TaskStatus;
}

/**
 * Record the same plan-critic approval snapshot required before real coder
 * dispatch. The status-excluded structural hash and approval metadata mirror
 * the production recorder in delegation-gate.ts.
 */
export async function recordPlanCriticApproval(
	directory: string,
	plan: Plan,
): Promise<void> {
	if (!(await ledgerExists(directory))) {
		await initLedger(directory, derivePlanId(plan));
	}
	await takeSnapshotEvent(directory, plan, {
		source: 'critic_approved',
		approvalMetadata: { verdict: 'APPROVED', source: 'plan_critic_gate' },
		payloadHashOverride: computePlanStructureHash(plan),
	});
}

/** Write a valid, approved plan whose task file lists provide coder scope. */
export async function writeApprovedPlan(
	directory: string,
	tasks: ScopedPlanTask[],
): Promise<Plan> {
	if (tasks.length === 0)
		throw new Error('approved plan fixture requires tasks');
	const phaseIds = [
		...new Set(
			tasks.map((task) => Number.parseInt(task.id.split('.')[0]!, 10)),
		),
	].sort((a, b) => a - b);
	if (phaseIds.some((phaseId) => !Number.isInteger(phaseId) || phaseId < 1)) {
		throw new Error('approved plan fixture requires numeric phase task IDs');
	}
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Approved integration fixture',
		swarm: 'fixture-swarm',
		current_phase: phaseIds[0],
		phases: phaseIds.map((phaseId) => ({
			id: phaseId,
			name: `Phase ${phaseId}`,
			status: 'in_progress',
			tasks: tasks
				.filter((task) => task.id.startsWith(`${phaseId}.`))
				.map((task) => ({
					id: task.id,
					phase: phaseId,
					status: task.status ?? 'pending',
					size: 'small',
					description: `Exercise task ${task.id}`,
					depends: [],
					files_touched: [...task.files],
				})),
		})),
	};
	await savePlan(directory, plan, { preserveCompletedStatuses: false });
	await recordPlanCriticApproval(directory, plan);
	return plan;
}
