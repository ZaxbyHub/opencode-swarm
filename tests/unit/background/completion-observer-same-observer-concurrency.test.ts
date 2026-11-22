/**
 * r15 audit follow-up (P1): parallel completion events within the SAME
 * observer instance must not double-execute a closeout step.
 *
 * The r14 (P1-4) lease machinery fences workers by claimant id, but the
 * observer derived ONE claimant id per observer instance
 * (`bg-closeout-<random>`), so two parallel `event()` calls for the same
 * child inside one instance both hit the idempotent same-claimant re-claim
 * branch of `claimTerminalCloseoutStep` and receive the SAME lease token —
 * both run the effect and both ack. The existing r14 race test used two
 * observer INSTANCES (distinct claimant ids → 'busy') and could not catch
 * this.
 *
 * Required guarantees (r15):
 * 1. the effect function never runs twice for one step in one observer,
 * 2. the durable closeout ack happens at most once,
 * 3. no duplicate `delegation_end` observations within an undisturbed run,
 * 4. the second call never blocks forever,
 * 5. a failed attempt stays re-drivable (retry/restart),
 * 6. different child sessions still process in parallel.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	claimTerminalCloseoutStep,
	findByCorrelationId,
	putPendingBackgroundAdvisory,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { telemetry } from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r15p1_parent';

function completionEvent(childSessionId: string, body: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function seedReviewer(
	directory: string,
	taskId: string,
	childSessionId: string,
): Promise<void> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	const generation = await seedStageAPassed(directory, taskId);
	await recordPendingDelegation(directory, {
		correlationId: childSessionId,
		jobId: `job-${childSessionId}`,
		subagentSessionId: childSessionId,
		parentSessionId: PARENT,
		callID: `call-${childSessionId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workflowGeneration: generation,
		workspace: captureWorkspaceSnapshot(directory),
	});
}

function captureDelegationEnds(): { count: () => number; restore: () => void } {
	let emissions = 0;
	const orig = telemetry.delegationEnd;
	(telemetry as { delegationEnd: unknown }).delegationEnd = () => {
		emissions += 1;
	};
	return {
		count: () => emissions,
		restore: () => {
			(telemetry as { delegationEnd: unknown }).delegationEnd = orig;
		},
	};
}

describe('background completion observer — same-observer closeout concurrency (r15 P1)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-same-observer-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('two parallel events in ONE observer instance: exactly one delegation_end effect execution', async () => {
		await seedReviewer(directory, '1.1', 'ses_r15_race');
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>';
		const capture = captureDelegationEnds();
		try {
			/**
			 * Controlled barrier: the first `delegation_end` claim attempt
			 * performs its REAL durable claim, then holds (the worker owns the
			 * lease but has not run its effect) until the second claim attempt
			 * arrives. This is the exact audit scenario — two in-flight events
			 * in one observer instance overlapping on the same step.
			 */
			let delegationEndClaims = 0;
			let openBarrier: (() => void) | undefined;
			const barrierOpened = new Promise<void>((resolve) => {
				openBarrier = resolve;
			});
			const claimImpl: typeof claimTerminalCloseoutStep = async (
				dir,
				correlationId,
				terminalEventId,
				step,
				options,
			) => {
				if (step !== 'delegation_end') {
					return claimTerminalCloseoutStep(
						dir,
						correlationId,
						terminalEventId,
						step,
						options,
					);
				}
				delegationEndClaims += 1;
				if (delegationEndClaims === 1) {
					const claim = await claimTerminalCloseoutStep(
						dir,
						correlationId,
						terminalEventId,
						step,
						options,
					);
					await barrierOpened;
					return claim;
				}
				openBarrier?.();
				return claimTerminalCloseoutStep(
					dir,
					correlationId,
					terminalEventId,
					step,
					options,
				);
			};

			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
				claimTerminalCloseoutStepImpl: claimImpl,
			});
			// The second call must never block forever — Promise.all settles.
			const settled = await Promise.allSettled([
				observer.event(completionEvent('ses_r15_race', body)),
				observer.event(completionEvent('ses_r15_race', body)),
			]);
			for (const result of settled) {
				expect(result.status).toBe('fulfilled');
			}
			// Both parallel attempts reached the claim for the same step.
			expect(delegationEndClaims).toBe(2);

			const record = findByCorrelationId(directory, 'ses_r15_race');
			// Exactly-once durable state: every step completed exactly once.
			expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
			expect(record?.closeout?.steps.pipeline_advisory?.state).toBe(
				'completed',
			);
			expect(record?.closeout?.steps.context_map?.state).toBe('completed');
			expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
			// Exactly one business effect: ONE telemetry pairing end, ONE
			// advisory slot, ONE context-map task entry.
			expect(capture.count()).toBe(1);
			expect(record?.advisoryInbox?.state).toBe('pending');
			expect(
				Object.keys(loadContextMap(directory)?.task_history ?? {}),
			).toEqual(['1.1']);
		} finally {
			capture.restore();
		}
	});

	test('a failed attempt stays re-drivable by the same observer (retry after retryable error)', async () => {
		await seedReviewer(directory, '1.2', 'ses_r15_retry');
		const body =
			'<task_result>[REVIEWED] | 1.2 | APPROVED | fine</task_result>';
		// The advisory store fails on the first attempt (retryable_error →
		// lease released, step stays pending) and recovers afterwards.
		let advisoryCalls = 0;
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			putPendingBackgroundAdvisoryImpl: async (
				...args: Parameters<typeof putPendingBackgroundAdvisory>
			) => {
				advisoryCalls += 1;
				if (advisoryCalls === 1) return null;
				return putPendingBackgroundAdvisory(...args);
			},
		});
		await observer.event(completionEvent('ses_r15_retry', body));
		let record = findByCorrelationId(directory, 'ses_r15_retry');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('pending');
		expect(record?.closeout?.steps.parent_advisory?.leaseToken).toBeUndefined();

		// A later replay (same observer, NEW attempt) must be able to claim a
		// fresh lease and complete the step.
		await observer.event(completionEvent('ses_r15_retry', body));
		record = findByCorrelationId(directory, 'ses_r15_retry');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.advisoryInbox?.state).toBe('pending');
		expect(record?.advisoryInbox?.message).toContain('completed');
	});

	test('different child sessions still close out in parallel within one observer', async () => {
		await seedReviewer(directory, '1.3', 'ses_r15_childA');
		await seedReviewer(directory, '1.4', 'ses_r15_childB');
		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			const settled = await Promise.allSettled([
				observer.event(
					completionEvent(
						'ses_r15_childA',
						'<task_result>[REVIEWED] | 1.3 | APPROVED | fine</task_result>',
					),
				),
				observer.event(
					completionEvent(
						'ses_r15_childB',
						'<task_result>[REVIEWED] | 1.4 | APPROVED | fine</task_result>',
					),
				),
			]);
			for (const result of settled) {
				expect(result.status).toBe('fulfilled');
			}
			for (const child of ['ses_r15_childA', 'ses_r15_childB']) {
				const record = findByCorrelationId(directory, child);
				expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
				expect(record?.closeout?.steps.parent_advisory?.state).toBe(
					'completed',
				);
			}
			expect(capture.count()).toBe(2);
			expect(
				Object.keys(loadContextMap(directory)?.task_history ?? {}).sort(),
			).toEqual(['1.3', '1.4']);
		} finally {
			capture.restore();
		}
	});
});
