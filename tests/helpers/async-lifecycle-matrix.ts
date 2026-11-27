/**
 * Shared fixtures for the async-lifecycle integration matrix suites (r11-r13).
 *
 * Split out of tests/unit/background/async-lifecycle-integration-matrix.test.ts
 * for the FR-006 file cap; both matrix files drive the same trusted
 * completion-observer lifecycle through these helpers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordPendingDelegation } from '../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../src/background/workspace-snapshot';
import type { Plan } from '../../src/config/plan-schema';
import { computePlanStructureHash } from '../../src/plan/ledger';
import { telemetry } from '../../src/telemetry';

export const PARENT = 'ses_matrix_parent';

export function writePlan(directory: string, title = 'Matrix Plan'): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title,
		swarm: 'matrix',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	return plan;
}

export function completionEvent(
	childSessionId: string,
	state: 'completed' | 'error' | 'cancelled',
	body: string,
	parentSessionId = PARENT,
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
				},
			},
		},
	};
}

export async function recordChild(
	directory: string,
	options: {
		child: string;
		callId: string;
		agent?: string;
		taskId?: string | null;
		planCritic?: boolean;
		plan?: Plan;
		workflowGeneration?: number;
	},
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: options.child,
		jobId: `job-${options.child}`,
		subagentSessionId: options.child,
		parentSessionId: PARENT,
		callID: options.callId,
		normalizedAgent: options.agent ?? 'explorer',
		swarmPrefixedAgent: options.agent ?? 'explorer',
		planTaskId: options.taskId === undefined ? null : options.taskId,
		evidenceTaskId: options.taskId === undefined ? null : options.taskId,
		// Gate-bearing roles require a dispatch-time workflow generation for
		// Stage-B ingestion (same fixture shape as the docs-participation
		// observer tests).
		...(options.taskId
			? {
					workflowGeneration:
						options.workflowGeneration !== undefined
							? options.workflowGeneration
							: 0,
				}
			: {}),
		workspace: captureWorkspaceSnapshot(directory),
		...(options.planCritic && options.plan
			? {
					planCriticDispatch: {
						planStructureHash: computePlanStructureHash(options.plan),
						recordedAt: Date.now(),
					},
				}
			: {}),
	});
}

export function captureEnds(): { count: () => number; restore: () => void } {
	let n = 0;
	const orig = telemetry.delegationEnd;
	(telemetry as { delegationEnd: unknown }).delegationEnd = () => {
		n += 1;
	};
	return {
		count: () => n,
		restore: () => {
			(telemetry as { delegationEnd: unknown }).delegationEnd = orig;
		},
	};
}
