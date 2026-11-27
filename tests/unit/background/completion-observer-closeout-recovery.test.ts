/**
 * r13 audit repair (P0-3/P1-2/P1-5/P2-2): crash-safe terminal closeout.
 *
 * The immutable terminal claim and the business closeout effects are now
 * SEPARATE durable concerns: a versioned closeout journal on the delegation
 * record acks each effect only after it was durably established. These tests
 * inject controlled crashes at exact points (by constructing the durable
 * intermediate state through the public store APIs, or by injecting the
 * observer's recordIngestionResult seam) and prove that a NEW observer
 * instance — a process restart — re-drives exactly the missing steps.
 *
 * The P2-2 durable-advisory semantics live in
 * completion-observer-closeout-recovery-advisories.test.ts; shared fixtures
 * live in tests/helpers/closeout-recovery-fixtures.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	claimTerminalResult,
	findByCorrelationId,
	initializeTerminalCloseout,
	isTerminalCloseoutStepPending,
	markTerminalCloseoutStepCompleted,
	recordDelegationIngestionResult,
} from '../../../src/background/pending-delegations';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	captureDelegationEnds,
	completionEvent,
	manualTerminal,
	recordPending,
	writePlan,
} from '../../helpers/closeout-recovery-fixtures';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

describe('background completion observer — durable closeout recovery (r13 P0-3)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-closeout-recovery-'));
		writePlan(directory);
		ensureAgentSession('ses_recovery_parent', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});
	test('P0-3 special case: crash between terminal claim and the failure advisory — recovery delivers the message', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		// Simulate the crash: the observer claimed the error terminal and
		// emitted delegation_end, then died BEFORE publishing the parent
		// advisory (the r12 duplicate early-return lost it forever).
		const errorBody = `<task id="ses_recovery_child" state="error">\n<task_error>provider blew up</task_error>\n</task>`;
		const terminal = manualTerminal(errorBody);
		expect(terminal).not.toBeNull();
		if (!terminal) return;
		const claim = await claimTerminalResult(
			directory,
			'ses_recovery_child',
			terminal,
		);
		expect(claim?.disposition).toBe('claimed');
		await initializeTerminalCloseout(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			['delegation_end', 'parent_advisory'],
		);
		await markTerminalCloseoutStepCompleted(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			'delegation_end',
		);
		// The crash point: parent_advisory still pending.

		// "Restart": a fresh observer receives the duplicate terminal.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		const deliveredEvent = completionEvent(
			'ses_recovery_child',
			'error',
			'<task_error>provider blew up</task_error>',
		);
		await observer.event(deliveredEvent);

		const record = findByCorrelationId(directory, 'ses_recovery_child');
		expect(record?.advisoryInbox?.state).toBe('pending');
		expect(record?.advisoryInbox?.message).toContain('failed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');

		// A further replay changes nothing: no duplicate advisory.
		await observer.event(deliveredEvent);
		const after = findByCorrelationId(directory, 'ses_recovery_child');
		expect(after?.advisoryInbox?.eventId).toBe(record?.advisoryInbox?.eventId);
		expect(after?.closeout?.steps.parent_advisory?.state).toBe('completed');
	});

	test('P1-5: crash between the terminal claim and delegation_end — recovery emits the pairing end exactly once', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | no issues</task_result>';
		const completedBody = `<task id="ses_recovery_child" state="completed">\n${body}\n</task>`;
		const terminal = manualTerminal(completedBody);
		expect(terminal).not.toBeNull();
		if (!terminal) return;
		const claim = await claimTerminalResult(
			directory,
			'ses_recovery_child',
			terminal,
		);
		expect(claim?.disposition).toBe('claimed');
		// Journal initialized, NOTHING acked yet (crash right after init).
		await initializeTerminalCloseout(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			['delegation_end', 'parent_advisory', 'pipeline_advisory'],
		);

		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			await observer.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);
			expect(capture.count()).toBe(1);
			// Replays (host duplicate + maintenance reconcile) never re-emit.
			await observer.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);
			const record = findByCorrelationId(directory, 'ses_recovery_child');
			if (record) await observer.reconcilePending(record);
			expect(capture.count()).toBe(1);
			const after = findByCorrelationId(directory, 'ses_recovery_child');
			expect(after?.closeout?.steps.delegation_end?.state).toBe('completed');
		} finally {
			capture.restore();
		}
	});

	test('P1-2 recovery: crash after the ingestion commit but before the context-map write — recovery adds the missing summary', async () => {
		const parent = ensureAgentSession(
			'ses_recovery_parent',
			'architect',
			directory,
		);
		parent.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(directory, '1.1');
		await recordPending(directory, {
			agent: 'reviewer',
			workflowGeneration: generation,
		});
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | no issues</task_result>';

		const capture = captureDelegationEnds();
		try {
			// Crash injection: the observer's recordIngestionResult seam
			// performs the REAL durable commit and then throws — the process
			// died after the commit but before the context-map write.
			let crashed = false;
			const firstObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
				recordIngestionResult: (async (
					dir: string,
					correlationId: string,
					claimToken: string,
					consumed: boolean,
				) => {
					const committed = await recordDelegationIngestionResult(
						dir,
						correlationId,
						claimToken,
						consumed,
					);
					if (committed && !crashed) {
						crashed = true;
						throw new Error('injected crash after ingestion commit');
					}
					return committed;
				}) as typeof recordDelegationIngestionResult,
			});
			const outcome = await firstObserver.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);
			expect(outcome).toBeUndefined(); // the wrapper discards the inner result
			// The crash point is observable from its effects: the durable
			// ingestion commit succeeded, but the context-map summary was
			// never written.
			expect(loadContextMap(directory)?.task_history['1.1']).toBeUndefined();
			expect(capture.count()).toBe(1); // delegation_end already emitted

			// "Restart": a fresh observer with no injection replays the terminal.
			const secondObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await secondObserver.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);

			const map = loadContextMap(directory);
			const summary = map?.task_history['1.1'];
			expect(summary).toBeDefined();
			// r14 (P1-5): the recovered summary is the child-level success —
			// NON-FINAL ('pending') until the authoritative task release; the
			// old 'approved' expectation was exactly the conflation this repair
			// removes (a reviewer approval alone is not a task release).
			expect(summary?.final_status).toBe('pending');
			// No double telemetry across the restart.
			expect(capture.count()).toBe(1);
			// The terminal advisory exists exactly once (single eventId slot).
			const record = findByCorrelationId(directory, 'ses_recovery_child');
			expect(record?.advisoryInbox?.state).toBe('pending');
			expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		} finally {
			capture.restore();
		}
	});
	test('recovery does not re-run a completed closeout step (journal fence)', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const terminal = manualTerminal(
			'<task id="ses_recovery_child" state="completed">\n<task_result>done</task_result>\n</task>',
		);
		expect(terminal).not.toBeNull();
		if (!terminal) return;
		await claimTerminalResult(directory, 'ses_recovery_child', terminal);
		await initializeTerminalCloseout(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			['delegation_end', 'parent_advisory'],
		);
		await markTerminalCloseoutStepCompleted(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			'delegation_end',
		);
		const record = findByCorrelationId(directory, 'ses_recovery_child');
		expect(record).not.toBeNull();
		if (record) {
			// The completed step is not pending; the unacked one is.
			expect(
				isTerminalCloseoutStepPending(
					record,
					terminal.eventId,
					'delegation_end',
				),
			).toBe(false);
			expect(
				isTerminalCloseoutStepPending(
					record,
					terminal.eventId,
					'parent_advisory',
				),
			).toBe(true);
			// A FOREIGN terminal event id never satisfies the fence.
			expect(
				isTerminalCloseoutStepPending(record, 'evt-foreign', 'delegation_end'),
			).toBe(true);
		}
	});
});
