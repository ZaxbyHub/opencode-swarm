import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { isPlanCriticApproved } from '../../../src/hooks/delegation-gate';
import {
	computePlanStructureHash,
	initLedger,
	readLedgerEventsWithIntegrity,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function makePlan(title = 'Async Plan Critic Plan'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'async-critic-observer',
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
}

function writePlan(directory: string, plan: Plan): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function completionEvent(
	childSessionId: string,
	state: 'completed' | 'error' | 'cancelled',
	body: string,
	parentSessionId = 'ses_parent_1',
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

const APPROVED_BODY =
	'<task_result>Plan review complete.\n\nVERDICT: APPROVED\nSolid plan.</task_result>';

async function recordCriticPendingDelegation(
	directory: string,
	options: {
		childSessionId?: string;
		parentSessionId?: string;
		callId?: string;
		planStructureHash?: string;
		planTaskId?: string | null;
	} = {},
): Promise<void> {
	const child = options.childSessionId ?? 'ses_child_critic_1';
	const parent = options.parentSessionId ?? 'ses_parent_1';
	await recordPendingDelegation(directory, {
		correlationId: child,
		jobId: `job-${child}`,
		subagentSessionId: child,
		parentSessionId: parent,
		callID: options.callId ?? 'call-critic-async-1',
		normalizedAgent: 'critic',
		swarmPrefixedAgent: 'critic',
		planTaskId: options.planTaskId === undefined ? null : options.planTaskId,
		evidenceTaskId:
			options.planTaskId === undefined ? null : options.planTaskId,
		workspace: captureWorkspaceSnapshot(directory),
		...(options.planStructureHash
			? {
					planCriticDispatch: {
						planStructureHash: options.planStructureHash,
						recordedAt: Date.now(),
					},
				}
			: {}),
	});
}

async function countPlanCriticGateSnapshots(
	directory: string,
): Promise<number> {
	const integrity = await readLedgerEventsWithIntegrity(directory);
	return integrity.events.filter(
		(event) =>
			event.event_type === 'snapshot' &&
			(event.payload as { approval?: { source?: string } })?.approval
				?.source === 'plan_critic_gate',
	).length;
}

describe('background completion observer — async plan critic approval (F1/r11)', () => {
	let directory: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-critic-approval-'));
		plan = makePlan();
		writePlan(directory, plan);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('verified async critic completion records the approval snapshot and unblocks the gate', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_child_critic_1', 'completed', APPROVED_BODY),
		);

		expect(await countPlanCriticGateSnapshots(directory)).toBe(1);
		expect(findByCorrelationId(directory, 'ses_child_critic_1')?.status).toBe(
			'completed',
		);
		// The gate the live failure hit: a subsequent coder dispatch must no
		// longer be blocked by PLAN_CRITIC_GATE_VIOLATION.
		expect(await isPlanCriticApproved(directory)).toBe(true);
	});

	test('wrong parent session identity is rejected — no approval, no snapshot', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		// The notice claims a DIFFERENT parent than the durable record owns.
		await observer.event(
			completionEvent(
				'ses_child_critic_1',
				'completed',
				APPROVED_BODY,
				'ses_other_parent',
			),
		);

		expect(await countPlanCriticGateSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('failed child session never records an approval', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_child_critic_1',
				'error',
				'<task_error>provider blew up</task_error>',
			),
		);
		expect(await countPlanCriticGateSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('cancelled child session never records an approval', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_child_critic_1',
				'cancelled',
				'<task_error>cancelled by user</task_error>',
			),
		);
		expect(await countPlanCriticGateSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('missing APPROVED verdict in a completed result never records an approval', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_child_critic_1',
				'completed',
				'<task_result>The plan has gaps. VERDICT: NEEDS_REVISION</task_result>',
			),
		);
		expect(await countPlanCriticGateSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('a plan edited after the critic dispatch is not approved by the old verdict', async () => {
		await initLedger(directory, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		await recordCriticPendingDelegation(directory, {
			planStructureHash: dispatchHash,
		});
		// The architect edits the plan while the async critic is still running.
		const edited = makePlan('Edited While Critic Running');
		writePlan(directory, edited);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_child_critic_1', 'completed', APPROVED_BODY),
		);
		expect(await countPlanCriticGateSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('duplicate completion delivery (replay) records exactly one approval snapshot', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		const event = completionEvent(
			'ses_child_critic_1',
			'completed',
			APPROVED_BODY,
		);
		await observer.event(event);
		// The same trusted terminal delivered again (host replay / crash recovery).
		await observer.event(event);
		// And the durable maintenance replay path.
		const record = findByCorrelationId(directory, 'ses_child_critic_1');
		if (record) {
			await observer.reconcilePending(record);
		}

		expect(await countPlanCriticGateSnapshots(directory)).toBe(1);
	});

	test('a critic dispatch without the dispatch-time plan binding never auto-approves', async () => {
		await initLedger(directory, derivePlanId(plan));
		// Legacy/non-plan-critic critic dispatch: no planCriticDispatch field.
		await recordCriticPendingDelegation(directory, {});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_child_critic_1', 'completed', APPROVED_BODY),
		);
		expect(await countPlanCriticGateSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('out-of-order: a completed approval is not undone by a later stale event for the same child', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordCriticPendingDelegation(directory, {
			planStructureHash: computePlanStructureHash(plan),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_child_critic_1', 'completed', APPROVED_BODY),
		);
		// A late, conflicting terminal for the same child (different result
		// digest) is a distinct terminal event — it must NOT remove or duplicate
		// the recorded approval.
		await observer.event(
			completionEvent(
				'ses_child_critic_1',
				'cancelled',
				'<task_error>late cancellation</task_error>',
			),
		);
		expect(await countPlanCriticGateSnapshots(directory)).toBe(1);
		expect(await isPlanCriticApproved(directory)).toBe(true);
	});
});
