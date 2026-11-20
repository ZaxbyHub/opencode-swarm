/**
 * r14 audit repair (P0-2): journal-gated closeout steps are only acked after
 * their business obligation was PROVABLY established.
 *
 * The effect contract (CloseoutEffectResult) replaces the old "void means
 * success" assumption: a null advisory store, a silently-swallowed
 * context-map write failure, a failed journal initialization, or a failed
 * journal ACK all leave the step PENDING — recovery re-drives the idempotent
 * effect instead of permanently acking a lost message. Pure best-effort
 * telemetry (delegation_end) is documented as attempt-acked, never
 * delivery-guaranteed. Permanent failures are durably visible via
 * markTerminalCloseoutStepFailed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	hasPendingTerminalCloseout,
	initializeTerminalCloseout,
	isTerminalCloseoutStepPending,
	markTerminalCloseoutStepCompleted,
	markTerminalCloseoutStepFailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { _internals as postAgentUpdateInternals } from '../../../src/context-map/post-agent-update';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { telemetry } from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r14p2_parent';

function completionEvent(
	childSessionId: string,
	body: string,
	state: 'completed' | 'error' = 'completed',
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
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

describe('background completion observer — closeout effect contract (r14 P0-2)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-effect-contract-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('a null advisory store leaves parent_advisory pending — restart re-drives and completes', async () => {
		await seedReviewer(directory, '1.1', 'ses_p2_advisory_null');
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>';

		// Example A from the audit: putPendingBackgroundAdvisory returns null
		// (lock/IO failure). The OLD contract acked the step anyway.
		const failingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			putPendingBackgroundAdvisoryImpl: async () => null,
		});
		await failingObserver.event(
			completionEvent('ses_p2_advisory_null', body),
		);

		const afterFailure = findByCorrelationId(directory, 'ses_p2_advisory_null');
		expect(afterFailure?.status).toBe('consumed');
		expect(afterFailure?.closeout?.steps.parent_advisory?.state).toBe(
			'pending',
		);
		expect(afterFailure?.advisoryInbox).toBeUndefined();

		// Restart: the step is re-driven, the advisory is established, and only
		// THEN acked.
		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await restartObserver.event(
			completionEvent('ses_p2_advisory_null', body),
		);
		const record = findByCorrelationId(directory, 'ses_p2_advisory_null');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.advisoryInbox?.state).toBe('pending');
		expect(record?.advisoryInbox?.message).toContain('completed');
	});

	test('a silently-swallowed context-map write failure leaves context_map pending — restart re-drives', async () => {
		await seedReviewer(directory, '1.2', 'ses_p2_ctxmap_fail');
		const body =
			'<task_result>[REVIEWED] | 1.2 | APPROVED | fine</task_result>';

		// Example B: updateContextMapAfterAgent swallows internal errors and
		// returns a fallback map — void is not proof. The store silently
		// fails to persist.
		const realSave = postAgentUpdateInternals.saveContextMap;
		postAgentUpdateInternals.saveContextMap = () => {
			// swallow: nothing is written
		};
		try {
			const failingObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await failingObserver.event(
				completionEvent('ses_p2_ctxmap_fail', body),
			);
		} finally {
			postAgentUpdateInternals.saveContextMap = realSave;
		}

		const afterFailure = findByCorrelationId(directory, 'ses_p2_ctxmap_fail');
		expect(afterFailure?.closeout?.steps.context_map?.state).toBe('pending');
		expect(
			loadContextMap(directory)?.task_history['1.2'],
		).toBeUndefined();

		// Restart with a healthy store: the step is re-driven and the
		// read-back verification proves persistence before the ack.
		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await restartObserver.event(
			completionEvent('ses_p2_ctxmap_fail', body),
		);
		const record = findByCorrelationId(directory, 'ses_p2_ctxmap_fail');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(
			loadContextMap(directory)?.task_history['1.2']?.final_status,
		).toBe('approved');
	});

	test('a failed journal initialization defers every journal-gated effect — no unjournaled side effects', async () => {
		await seedReviewer(directory, '1.3', 'ses_p2_journal_init_fail');
		const body =
			'<task_result>[REVIEWED] | 1.3 | APPROVED | fine</task_result>';

		// The journal cannot be written (lock/IO failure): running effects
		// anyway would be UNSECURED (a crash could never re-drive them, and a
		// stale writer's acks would be refused forever).
		const failingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			initializeTerminalCloseoutImpl: async () => false,
		});
		await failingObserver.event(
			completionEvent('ses_p2_journal_init_fail', body),
		);

		const afterFailure = findByCorrelationId(
			directory,
			'ses_p2_journal_init_fail',
		);
		// No journal-gated effect ran: no advisory, no context-map summary.
		expect(afterFailure?.advisoryInbox).toBeUndefined();
		expect(
			loadContextMap(directory)?.task_history['1.3'],
		).toBeUndefined();
		// The record stays in the recovery set (no journal at all).
		expect(hasPendingTerminalCloseout(afterFailure!)).toBe(true);

		// Restart with a healthy journal: everything is re-driven and acked.
		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await restartObserver.event(
			completionEvent('ses_p2_journal_init_fail', body),
		);
		const record = findByCorrelationId(
			directory,
			'ses_p2_journal_init_fail',
		);
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(
			loadContextMap(directory)?.task_history['1.3']?.final_status,
		).toBe('approved');
		expect(record?.advisoryInbox?.state).toBe('pending');
	});

	test('a failed journal ACK leaves the step pending — restart re-drives without duplicate business effects', async () => {
		await seedReviewer(directory, '1.4', 'ses_p2_ack_fail');
		const body =
			'<task_result>[REVIEWED] | 1.4 | APPROVED | fine</task_result>';

		// markTerminalCloseoutStepCompleted returns false (journal write
		// failure / evidence lock unavailable). The effects RUN and their
		// durable obligations land, but every step stays pending.
		const failingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			markTerminalCloseoutStepCompletedImpl: async () => false,
		});
		await failingObserver.event(completionEvent('ses_p2_ack_fail', body));

		const afterFailure = findByCorrelationId(directory, 'ses_p2_ack_fail');
		expect(afterFailure?.closeout?.steps.context_map?.state).toBe('pending');
		expect(afterFailure?.closeout?.steps.parent_advisory?.state).toBe(
			'pending',
		);
		// The business obligations DID land (idempotent effects).
		expect(afterFailure?.advisoryInbox?.state).toBe('pending');
		expect(
			loadContextMap(directory)?.task_history['1.4']?.final_status,
		).toBe('approved');

		// Restart: steps are re-driven idempotently — one advisory slot, one
		// task-history entry — and now acked.
		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await restartObserver.event(completionEvent('ses_p2_ack_fail', body));
		const record = findByCorrelationId(directory, 'ses_p2_ack_fail');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.advisoryInbox?.eventId).toBe(
			afterFailure?.advisoryInbox?.eventId,
		);
		const history = loadContextMap(directory)?.task_history ?? {};
		expect(Object.keys(history).filter((key) => key === '1.4')).toEqual([
			'1.4',
		]);
	});

	test('a crash between the effect and the journal ACK: restart re-drives idempotently', async () => {
		await seedReviewer(directory, '1.5', 'ses_p2_crash_pre_ack');
		const body =
			'<task_result>[REVIEWED] | 1.5 | APPROVED | fine</task_result>';

		// The effect lands (advisory stored), then the process dies BEFORE the
		// parent_advisory journal ack.
		let crashed = false;
		const crashingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			markTerminalCloseoutStepCompletedImpl: async (
				dir,
				correlationId,
				eventId,
				step,
			) => {
				if (step === 'parent_advisory' && !crashed) {
					crashed = true;
					throw new Error('injected crash before journal ack');
				}
				return markTerminalCloseoutStepCompleted(
					dir,
					correlationId,
					eventId,
					step,
				);
			},
		});
		await crashingObserver.event(
			completionEvent('ses_p2_crash_pre_ack', body),
		);

		const afterCrash = findByCorrelationIdRequired(
			directory,
			'ses_p2_crash_pre_ack',
		);
		// At least one step is un-acked (the crash hit its ack).
		expect(
			hasPendingTerminalCloseout(afterCrash),
		).toBe(true);
		expect(afterCrash?.advisoryInbox?.state).toBe('pending');

		// Restart: re-drive is idempotent — same advisory eventId, same single
		// task-history entry — and every step is acked.
		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await restartObserver.event(
			completionEvent('ses_p2_crash_pre_ack', body),
		);
		const record = findByCorrelationId(directory, 'ses_p2_crash_pre_ack');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.advisoryInbox?.eventId).toBe(
			afterCrash?.advisoryInbox?.eventId,
		);
		expect(
			loadContextMap(directory)?.task_history['1.5']?.final_status,
		).toBe('approved');
	});

	test('a rejected telemetry sink does not wedge the observer — delegation_end is documented best-effort', async () => {
		await seedReviewer(directory, '1.6', 'ses_p2_telemetry');
		// A FAILED terminal drives the delegation_end closeout step.
		const errorBody = '<task_error>provider exploded</task_error>';

		let sinkRejections = 0;
		const origEmit = telemetry.delegationEnd;
		(telemetry as { delegationEnd: unknown }).delegationEnd = () => {
			sinkRejections += 1;
			throw new Error('telemetry sink rejected the write');
		};
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			// Must not throw: the weaker (best-effort) contract acks the
			// emission ATTEMPT; no delivery guarantee is claimed.
			await observer.event(
				completionEvent('ses_p2_telemetry', errorBody, 'error'),
			);
		} finally {
			(telemetry as { delegationEnd: unknown }).delegationEnd = origEmit;
		}
		expect(sinkRejections).toBe(1);
		const record = findByCorrelationId(directory, 'ses_p2_telemetry');
		expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
		// The failure advisory is independent of telemetry and still lands.
		expect(record?.advisoryInbox?.message).toContain('failed');
	});

	test('a null closeout-advisory store leaves sounding_board and pipeline_advisory pending — restart completes them', async () => {
		const parent = ensureAgentSession(PARENT, 'architect', directory);
		parent.taskWorkflowStates.set('1.7', 'coder_delegated');
		await seedStageAPassed(directory, '1.7');
		await recordPendingDelegation(directory, {
			correlationId: 'ses_p2_sounding_board',
			jobId: 'job-sb',
			subagentSessionId: 'ses_p2_sounding_board',
			parentSessionId: PARENT,
			callID: 'call-sb',
			normalizedAgent: 'critic_sounding_board',
			swarmPrefixedAgent: 'critic_sounding_board',
			planTaskId: '1.7',
			evidenceTaskId: '1.7',
			workspace: captureWorkspaceSnapshot(directory),
		});
		const body =
			'Verdict: APPROVED\nCategory: architecture\nReasoning: sound';

		const failingObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			putTerminalCloseoutAdvisoryImpl: async () => null,
		});
		await failingObserver.event(
			completionEvent('ses_p2_sounding_board', body),
		);

		const afterFailure = findByCorrelationId(
			directory,
			'ses_p2_sounding_board',
		);
		expect(afterFailure?.closeout?.steps.sounding_board?.state).toBe(
			'pending',
		);
		expect(afterFailure?.closeout?.steps.pipeline_advisory?.state).toBe(
			'pending',
		);
		expect(afterFailure?.closeoutAdvisories ?? []).toHaveLength(0);

		const restartObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await restartObserver.event(
			completionEvent('ses_p2_sounding_board', body),
		);
		const record = findByCorrelationId(directory, 'ses_p2_sounding_board');
		expect(record?.closeout?.steps.sounding_board?.state).toBe('completed');
		expect(record?.closeout?.steps.pipeline_advisory?.state).toBe(
			'completed',
		);
		expect((record?.closeoutAdvisories ?? []).length).toBe(2);
	});
});

describe('terminal closeout journal — permanent failure state (r14 P0-2 store semantics)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-closeout-failed-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('markTerminalCloseoutStepFailed durably closes the step with a visible reason', async () => {
		const parent = ensureAgentSession(PARENT, 'architect', directory);
		parent.taskWorkflowStates.set('2.1', 'coder_delegated');
		await seedStageAPassed(directory, '2.1');
		await recordPendingDelegation(directory, {
			correlationId: 'ses_p2_store',
			jobId: 'job-store',
			subagentSessionId: 'ses_p2_store',
			parentSessionId: PARENT,
			callID: 'call-store',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '2.1',
			evidenceTaskId: '2.1',
			workspace: captureWorkspaceSnapshot(directory),
		});
		// No terminal yet: a failure mark must refuse (nothing to fence).
		expect(
			await markTerminalCloseoutStepFailed(
				directory,
				'ses_p2_store',
				'evt-none',
				'context_map',
				'deterministic refusal',
			),
		).toBe(false);

		// Claim a real terminal through a live observer delivery.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_p2_store',
				'<task_result>[REVIEWED] | 2.1 | APPROVED | fine</task_result>',
			),
		);
		const record = findByCorrelationId(directory, 'ses_p2_store');
		const eventId = record!.terminalResult!.eventId;
		// A completed step cannot be retroactively failed.
		expect(
			await markTerminalCloseoutStepFailed(
				directory,
				'ses_p2_store',
				eventId,
				'parent_advisory',
				'too late',
			),
		).toBe(false);
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');

		// Mark a still-pending-eligible step failed: durably visible, closed
		// for re-drive, and idempotent.
		expect(
			await markTerminalCloseoutStepFailed(
				directory,
				'ses_p2_store',
				eventId,
				'sounding_board',
				'provably invalid verdict payload',
			),
		).toBe(true);
		const failed = findByCorrelationId(directory, 'ses_p2_store');
		expect(failed?.closeout?.steps.sounding_board?.state).toBe('failed');
		expect(failed?.closeout?.steps.sounding_board?.reason).toBe(
			'provably invalid verdict payload',
		);
		expect(
			isTerminalCloseoutStepPending(failed!, eventId, 'sounding_board'),
		).toBe(false);
		// A failed step no longer keeps the record in the recovery set (the
		// other steps are all completed here).
		expect(hasPendingTerminalCloseout(failed!)).toBe(false);
		// Idempotent re-mark.
		expect(
			await markTerminalCloseoutStepFailed(
				directory,
				'ses_p2_store',
				eventId,
				'sounding_board',
				'provably invalid verdict payload',
			),
		).toBe(true);

		// A foreign terminal event is fenced out.
		expect(
			await markTerminalCloseoutStepFailed(
				directory,
				'ses_p2_store',
				'evt-foreign',
				'pipeline_advisory',
				'stale writer',
			),
		).toBe(false);
		// initializeTerminalCloseout for the SAME terminal keeps the failed
		// step states (a re-drive must not reset them).
		expect(
			await initializeTerminalCloseout(
				directory,
				'ses_p2_store',
				eventId,
				['parent_advisory', 'sounding_board'],
			),
		).toBe(true);
		const afterInit = findByCorrelationId(directory, 'ses_p2_store');
		expect(afterInit?.closeout?.steps.sounding_board?.state).toBe('failed');
	});
});

/** Small helper with a clear failure message. */
function findByCorrelationIdRequired(
	directory: string,
	correlationId: string,
) {
	const record = findByCorrelationId(directory, correlationId);
	if (!record) throw new Error(`record ${correlationId} not found`);
	return record;
}
