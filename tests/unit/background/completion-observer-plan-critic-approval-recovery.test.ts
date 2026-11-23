/**
 * r14 audit repair (P0-3): the plan-critic approval snapshot is its own
 * recoverable closeout step (plan_critic_approval).
 *
 * A transient ledger/plan read failure used to log-and-lose a legitimate
 * APPROVED verdict, restoring the original PLAN_CRITIC_GATE_VIOLATION wedge.
 * The step is journaled (only for a host-verified critic record with a
 * dispatch-time plan binding) and re-driven by recovery; every replay
 * re-applies the recorder's full authorization checks. Terminal outcomes:
 * recorded / already_recorded / not_approved close the step; a plan-hash
 * conflict is a durable, visible final rejection; transient failures stay
 * pending. The manual approve_plan_critic escape hatch is never automatic.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	hasPendingTerminalCloseout,
	initializeTerminalCloseout,
	markTerminalCloseoutStepCompleted,
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

const PARENT = 'ses_r14p3_parent';
const CHILD = 'ses_p3_critic';

function makePlan(title = 'P3 Recovery Plan'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'p3-critic-recovery',
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

function planPath(directory: string): string {
	return join(directory, '.swarm', 'plan.json');
}

function writePlan(directory: string, plan: Plan): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(planPath(directory), JSON.stringify(plan, null, 2));
}

function completionEvent(body: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${CHILD}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

const APPROVED_BODY =
	'<task_result>Plan review complete.\n\nVERDICT: APPROVED\nSolid plan.</task_result>';
const REJECTED_BODY =
	'<task_result>Plan review complete.\n\nVERDICT: REJECTED\nWeak plan.</task_result>';

async function seedCritic(
	directory: string,
	plan: Plan,
	options: { withBinding?: boolean } = {},
): Promise<void> {
	await initLedger(directory, derivePlanId(plan));
	await recordPendingDelegation(directory, {
		correlationId: CHILD,
		jobId: `job-${CHILD}`,
		subagentSessionId: CHILD,
		parentSessionId: PARENT,
		callID: 'call-p3-critic-1',
		normalizedAgent: 'critic',
		swarmPrefixedAgent: 'critic',
		planTaskId: null,
		evidenceTaskId: null,
		workspace: captureWorkspaceSnapshot(directory),
		...(options.withBinding === false
			? {}
			: {
					planCriticDispatch: {
						planStructureHash: computePlanStructureHash(plan),
						recordedAt: Date.now(),
					},
				}),
	});
}

async function countSnapshots(directory: string): Promise<number> {
	const integrity = await readLedgerEventsWithIntegrity(directory);
	return integrity.events.filter(
		(event) =>
			event.event_type === 'snapshot' &&
			(event.payload as { approval?: { source?: string } })?.approval
				?.source === 'plan_critic_gate',
	).length;
}

describe('background completion observer — recoverable plan critic approval closeout (r14 P0-3)', () => {
	let directory: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-critic-p3-'));
		plan = makePlan();
		writePlan(directory, plan);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('a transient unreadable plan keeps the step pending — restart re-drives and records the approval', async () => {
		await seedCritic(directory, plan);

		// First attempt: plan.json is unreadable (transient I/O failure) —
		// the recorder fails closed and the step MUST stay pending.
		renameSync(planPath(directory), `${planPath(directory)}.bak`);
		try {
			const failingObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			await failingObserver.event(completionEvent(APPROVED_BODY));
		} finally {
			renameSync(`${planPath(directory)}.bak`, planPath(directory));
		}

		const afterFailure = findByCorrelationId(directory, CHILD);
		expect(afterFailure?.closeout?.steps.plan_critic_approval?.state).toBe(
			'pending',
		);
		expect(await countSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);

		// Second attempt (new observer instance = process restart): the plan
		// is readable again, the approval is recorded and acked.
		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await restartObserver.event(completionEvent(APPROVED_BODY));
		const record = findByCorrelationId(directory, CHILD);
		expect(record?.closeout?.steps.plan_critic_approval?.state).toBe(
			'completed',
		);
		expect(await countSnapshots(directory)).toBe(1);
		expect(await isPlanCriticApproved(directory)).toBe(true);
	});

	test('crash between the terminal claim and the approval snapshot — restart records it', async () => {
		await seedCritic(directory, plan);

		// The journal is initialized (real) and then the process dies BEFORE
		// any closeout effect — in particular before the approval snapshot.
		let crashed = false;
		const crashingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			initializeTerminalCloseoutImpl: (async (
				...args: Parameters<typeof initializeTerminalCloseout>
			) => {
				const ok = await initializeTerminalCloseout(...args);
				if (!crashed) {
					crashed = true;
					throw new Error('injected crash after journal init');
				}
				return ok;
			}) as typeof initializeTerminalCloseout,
		});
		await crashingObserver.event(completionEvent(APPROVED_BODY));

		const afterCrash = findByCorrelationId(directory, CHILD);
		expect(afterCrash?.terminalResult).toBeDefined();
		expect(afterCrash?.closeout?.steps.plan_critic_approval?.state).toBe(
			'pending',
		);
		expect(await countSnapshots(directory)).toBe(0);

		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await restartObserver.event(completionEvent(APPROVED_BODY));
		const record = findByCorrelationId(directory, CHILD);
		expect(record?.closeout?.steps.plan_critic_approval?.state).toBe(
			'completed',
		);
		expect(await countSnapshots(directory)).toBe(1);
		expect(await isPlanCriticApproved(directory)).toBe(true);
	});

	test('crash directly after the approval snapshot — restart acks without a second snapshot', async () => {
		await seedCritic(directory, plan);

		// The approval snapshot lands, then the process dies BEFORE the
		// journal ack of the plan_critic_approval step.
		let crashed = false;
		const crashingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			markTerminalCloseoutStepCompletedImpl: async (
				dir,
				correlationId,
				eventId,
				step,
				options,
			) => {
				if (step === 'plan_critic_approval' && !crashed) {
					crashed = true;
					throw new Error('injected crash before approval ack');
				}
				return markTerminalCloseoutStepCompleted(
					dir,
					correlationId,
					eventId,
					step,
					options,
				);
			},
		});
		await crashingObserver.event(completionEvent(APPROVED_BODY));

		const afterCrash = findByCorrelationId(directory, CHILD);
		expect(await countSnapshots(directory)).toBe(1); // the effect landed
		expect(afterCrash?.closeout?.steps.plan_critic_approval?.state).toBe(
			'pending',
		); // the ack did not

		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await restartObserver.event(completionEvent(APPROVED_BODY));
		const record = findByCorrelationId(directory, CHILD);
		expect(record?.closeout?.steps.plan_critic_approval?.state).toBe(
			'completed',
		);
		// Re-drive is idempotent: the recorder's ledger dedup sees the prior
		// snapshot and the step closes as already_persisted — exactly ONE
		// snapshot exists.
		expect(await countSnapshots(directory)).toBe(1);
		expect(await isPlanCriticApproved(directory)).toBe(true);
	});

	test('duplicate completion delivery records exactly one approval', async () => {
		await seedCritic(directory, plan);
		const first = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await first.event(completionEvent(APPROVED_BODY));
		const second = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await second.event(completionEvent(APPROVED_BODY));

		expect(await countSnapshots(directory)).toBe(1);
		const record = findByCorrelationId(directory, CHILD);
		expect(record?.closeout?.steps.plan_critic_approval?.state).toBe(
			'completed',
		);
		expect(await isPlanCriticApproved(directory)).toBe(true);
	});

	test('a plan change during recovery is a durable final rejection — no approval, step failed visibly', async () => {
		await seedCritic(directory, plan);

		// Crash before the approval snapshot.
		let crashed = false;
		const crashingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			initializeTerminalCloseoutImpl: (async (
				...args: Parameters<typeof initializeTerminalCloseout>
			) => {
				const ok = await initializeTerminalCloseout(...args);
				if (!crashed) {
					crashed = true;
					throw new Error('injected crash after journal init');
				}
				return ok;
			}) as typeof initializeTerminalCloseout,
		});
		await crashingObserver.event(completionEvent(APPROVED_BODY));

		// While the process is down, the plan changes.
		const changedPlan = makePlan('P3 Changed Plan');
		writePlan(directory, changedPlan);

		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await restartObserver.event(completionEvent(APPROVED_BODY));

		const record = findByCorrelationId(directory, CHILD);
		expect(await countSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
		// Durable, visible final rejection — not pending (no retry loop), not
		// completed (no phantom success).
		const step = record?.closeout?.steps.plan_critic_approval;
		expect(step?.state).toBe('failed');
		expect(step?.reason).toContain('changed');
	});

	test('a negative critic verdict closes the step without approval — not_approved is not a retry error', async () => {
		await seedCritic(directory, plan);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completionEvent(REJECTED_BODY));

		const record = findByCorrelationId(directory, CHILD);
		expect(await countSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
		// The step is terminally closed as completed: no approval is required
		// — it must NOT remain pending (that would be a retry loop for a
		// final verdict) and must not be failed.
		expect(record?.closeout?.steps.plan_critic_approval?.state).toBe(
			'completed',
		);
		expect(hasPendingTerminalCloseout(record!)).toBe(false);
	});

	test('a legacy critic record without a provable plan binding never gains the step and never approves', async () => {
		await seedCritic(directory, plan, { withBinding: false });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completionEvent(APPROVED_BODY));
		await observer.event(completionEvent(APPROVED_BODY)); // replay too

		const record = findByCorrelationId(directory, CHILD);
		expect(await countSnapshots(directory)).toBe(0);
		expect(await isPlanCriticApproved(directory)).toBe(false);
		// No step was ever journaled for the unbound record, and the rest of
		// its closeout completed — no pending wedge.
		expect(record?.closeout?.steps.plan_critic_approval).toBeUndefined();
		expect(hasPendingTerminalCloseout(record!)).toBe(false);
	});
});
