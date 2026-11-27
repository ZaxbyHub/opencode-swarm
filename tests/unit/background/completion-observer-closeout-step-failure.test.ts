/**
 * r14 audit repair (P0-2) — terminal closeout journal store semantics.
 *
 * Split from tests/unit/background/completion-observer-closeout-effect-contract.test.ts
 * (FR-006 file cap): markTerminalCloseoutStepFailed makes a permanent failure
 * durably visible — the step closes with a reason, refuses stale/foreign
 * writers, survives a re-initialization without being reset, and no longer
 * keeps the record in the recovery set.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	hasPendingTerminalCloseout,
	initializeTerminalCloseout,
	isTerminalCloseoutStepPending,
	markTerminalCloseoutStepFailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
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
		// Layer 23: this fixture's reviewer ingestion apply failed (no
		// reviewer receipts), so the record sits in the exact 3.8 evening
		// wedge shape — a recoverable (non-consumed) ingestion KEEPS it in
		// the recovery set even though every other journaled step is
		// completed or failed. Pre-Layer-23 this returned false and the
		// wedge was unrecoverable in-band.
		expect(failed?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		expect(hasPendingTerminalCloseout(failed!)).toBe(true);
		// r14 failed-step semantics still hold: once the ingestion step is
		// ALSO terminally closed with a visible reason, no progressable
		// pending step remains and the record leaves the recovery set.
		expect(
			await markTerminalCloseoutStepFailed(
				directory,
				'ses_p2_store',
				eventId,
				'ingestion_commit',
				'fixture: reviewer ingestion permanently refused',
			),
		).toBe(true);
		const closedIngestion = findByCorrelationId(directory, 'ses_p2_store');
		expect(closedIngestion?.closeout?.steps.ingestion_commit?.state).toBe(
			'failed',
		);
		expect(hasPendingTerminalCloseout(closedIngestion!)).toBe(false);
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
			await initializeTerminalCloseout(directory, 'ses_p2_store', eventId, [
				'parent_advisory',
				'sounding_board',
			]),
		).toBe(true);
		const afterInit = findByCorrelationId(directory, 'ses_p2_store');
		expect(afterInit?.closeout?.steps.sounding_board?.state).toBe('failed');
	});
});
