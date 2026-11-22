/**
 * r14 audit repair (P1-4): concurrent closeout workers are fenced by a
 * durable per-step execution lease.
 *
 * runCloseoutStep used to check a possibly stale in-memory record, run the
 * effect, and only then take the evidence lock for the ack — two observers
 * could execute the same effect before either acked, and the in-memory
 * inFlightCloseoutCorrelationIds set protected nothing across processes.
 *
 * The lease is a durable CAS claim on the individual closeout step: a live
 * foreign worker is busy-skipped, a stale worker (superseded terminal) is
 * refused, an expired lease is stolen for crash recovery, and the ack is
 * fenced on the lease token so a stale worker can never complete a step a
 * live worker owns. Documented guarantee class: at-least-once EXECUTION with
 * exactly-once ACK — every journal-gated effect is idempotent (advisories
 * dedupe by eventId, the context map upserts by task id), because
 * exactly-once execution against non-transactional sinks is impossible.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	claimTerminalCloseoutStep,
	findByCorrelationId,
	maintainBackgroundDelegations,
	markTerminalCloseoutStepCompleted,
	recordPendingDelegation,
	releaseTerminalCloseoutStepLease,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { telemetry } from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r14p4_parent';

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

/**
 * Seed a record whose parent_advisory step is pending WITHOUT a lease: a
 * healthy completion whose advisory store is temporarily unavailable (the
 * retryable path releases the lease, so recovery can retry immediately).
 */
async function seedPendingAdvisoryStep(
	directory: string,
	taskId: string,
	childSessionId: string,
): Promise<string> {
	await seedReviewer(directory, taskId, childSessionId);
	const body = `<task_result>[REVIEWED] | ${taskId} | APPROVED | fine</task_result>`;
	const observer = createBackgroundCompletionObserver({
		config: { enabled: true },
		directory,
		contextMap: { enabled: true },
		putPendingBackgroundAdvisoryImpl: async () => null,
	});
	await observer.event(completionEvent(childSessionId, body));
	const record = findByCorrelationId(directory, childSessionId);
	if (!record?.terminalResult) throw new Error('seed failed: no terminal');
	expect(record.closeout?.steps.parent_advisory?.state).toBe('pending');
	expect(record.closeout?.steps.parent_advisory?.leaseToken).toBeUndefined();
	return record.terminalResult.eventId;
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

describe('background completion observer — durable closeout step leases (r14 P1-4)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-closeout-lease-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('two concurrent observers on the same record: exactly one effect execution and one ack per step', async () => {
		await seedReviewer(directory, '1.1', 'ses_p4_race');
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>';
		const capture = captureDelegationEnds();
		try {
			const observerA = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			const observerB = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			const results = await Promise.allSettled([
				observerA.event(completionEvent('ses_p4_race', body)),
				observerB.event(completionEvent('ses_p4_race', body)),
			]);
			for (const result of results) {
				expect(result.status).toBe('fulfilled');
			}

			const record = findByCorrelationId(directory, 'ses_p4_race');
			expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
			expect(record?.closeout?.steps.pipeline_advisory?.state).toBe(
				'completed',
			);
			expect(record?.closeout?.steps.context_map?.state).toBe('completed');
			expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
			// Exactly one business effect each: one telemetry pairing end, one
			// advisory slot, one context-map task entry.
			expect(capture.count()).toBe(1);
			expect(record?.advisoryInbox?.state).toBe('pending');
			expect(
				Object.keys(loadContextMap(directory)?.task_history ?? {}),
			).toEqual(['1.1']);
		} finally {
			capture.restore();
		}
	});

	test('a live foreign lease is busy; the same claimant re-claims idempotently', async () => {
		const eventId = await seedPendingAdvisoryStep(
			directory,
			'1.2',
			'ses_p4_busy',
		);
		const first = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_busy',
			eventId,
			'parent_advisory',
			{ claimantId: 'worker-a' },
		);
		expect(first?.disposition).toBe('claimed');
		const second = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_busy',
			eventId,
			'parent_advisory',
			{ claimantId: 'worker-b' },
		);
		expect(second?.disposition).toBe('busy');
		// The same live worker re-claims its own lease with the same token.
		const reClaim = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_busy',
			eventId,
			'parent_advisory',
			{ claimantId: 'worker-a' },
		);
		expect(reClaim?.disposition).toBe('claimed');
		expect(reClaim?.leaseToken).toBe(first?.leaseToken);
		// A stale worker (superseded terminal event) is refused outright.
		const stale = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_busy',
			'evt-foreign-terminal',
			'parent_advisory',
			{ claimantId: 'worker-a' },
		);
		expect(stale?.disposition).toBe('stale');
	});

	test('an expired lease is stolen; the stale holder can neither ack nor release', async () => {
		const eventId = await seedPendingAdvisoryStep(
			directory,
			'1.3',
			'ses_p4_expired',
		);
		// A worker claimed the step two minutes ago with a 30s lease, then the
		// process died before running the effect (crash after lease claim).
		const dead = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_expired',
			eventId,
			'parent_advisory',
			{
				claimantId: 'dead-worker',
				now: Date.now() - 120_000,
				leaseMs: 30_000,
			},
		);
		expect(dead?.disposition).toBe('claimed');

		// A recovering worker steals the expired lease.
		const thief = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_expired',
			eventId,
			'parent_advisory',
			{ claimantId: 'recovery-worker' },
		);
		expect(thief?.disposition).toBe('claimed');
		expect(thief?.leaseToken).not.toBe(dead?.leaseToken);

		// The stale holder's ack is refused by the token CAS.
		expect(
			await markTerminalCloseoutStepCompleted(
				directory,
				'ses_p4_expired',
				eventId,
				'parent_advisory',
				{ leaseToken: dead?.leaseToken ?? 'wrong' },
			),
		).toBe(false);
		// The stale holder's release is refused too.
		expect(
			await releaseTerminalCloseoutStepLease(
				directory,
				'ses_p4_expired',
				eventId,
				'parent_advisory',
				dead?.leaseToken ?? 'wrong',
			),
		).toBe(false);
		// The current holder's ack succeeds and clears the lease.
		expect(
			await markTerminalCloseoutStepCompleted(
				directory,
				'ses_p4_expired',
				eventId,
				'parent_advisory',
				{ leaseToken: thief?.leaseToken ?? 'none' },
			),
		).toBe(true);
		const record = findByCorrelationId(directory, 'ses_p4_expired');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.leaseToken).toBeUndefined();
	});

	test('observer recovery steals an expired crashed lease and completes the step', async () => {
		const eventId = await seedPendingAdvisoryStep(
			directory,
			'1.4',
			'ses_p4_recovery',
		);
		// Simulate the durable state a hard process crash leaves behind: a
		// pending step leased by a worker whose lease has expired.
		const dead = await claimTerminalCloseoutStep(
			directory,
			'ses_p4_recovery',
			eventId,
			'parent_advisory',
			{
				claimantId: 'dead-worker',
				now: Date.now() - 120_000,
				leaseMs: 30_000,
			},
		);
		expect(dead?.disposition).toBe('claimed');

		// "Restart": a fresh observer replays the terminal and completes the
		// step by stealing the expired lease.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_p4_recovery',
				'<task_result>[REVIEWED] | 1.4 | APPROVED | fine</task_result>',
			),
		);
		const record = findByCorrelationId(directory, 'ses_p4_recovery');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.advisoryInbox?.state).toBe('pending');
		expect(record?.advisoryInbox?.message).toContain('completed');
	});

	test('recovery rotates through pending records instead of starving the tail', async () => {
		// Three records with pending parent_advisory steps (advisory store
		// unavailable during their completions).
		await seedPendingAdvisoryStep(directory, '1.5', 'ses_p4_a');
		await seedPendingAdvisoryStep(directory, '1.6', 'ses_p4_b');
		await seedPendingAdvisoryStep(directory, '1.7', 'ses_p4_c');

		const examined: string[] = [];
		const examine = async (record: { correlationId: string }) => {
			examined.push(record.correlationId);
		};
		// With a batch of 1, a naive head-first selection would examine
		// ses_p4_a forever; the rotation cursor must advance through the list.
		await maintainBackgroundDelegations(directory, {
			maxRecords: 1,
			reason: 'fairness-pass-1',
			onTerminalCloseoutPending: examine,
		});
		await maintainBackgroundDelegations(directory, {
			maxRecords: 1,
			reason: 'fairness-pass-2',
			onTerminalCloseoutPending: examine,
		});
		await maintainBackgroundDelegations(directory, {
			maxRecords: 1,
			reason: 'fairness-pass-3',
			onTerminalCloseoutPending: examine,
		});
		await maintainBackgroundDelegations(directory, {
			maxRecords: 1,
			reason: 'fairness-pass-4',
			onTerminalCloseoutPending: examine,
		});

		expect(examined.length).toBe(4);
		// Every record was examined at least once across the passes — no
		// head-of-line starvation.
		expect(new Set(examined)).toEqual(
			new Set(['ses_p4_a', 'ses_p4_b', 'ses_p4_c']),
		);
		// Consecutive passes never re-examine the same head record.
		expect(examined[0]).not.toBe(examined[1]);
		expect(examined[1]).not.toBe(examined[2]);
	});
});
