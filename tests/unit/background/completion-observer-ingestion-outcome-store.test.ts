/**
 * r14 audit repair (P0-1) — durable ingestion outcome store semantics.
 *
 * Split from tests/unit/background/completion-observer-ingestion-outcome-replay.test.ts
 * (FR-006 file cap): readDurableIngestionOutcome is fail-closed for
 * non-consumed and legacy states, and the consumed commit stores the
 * semantic outcome ATOMICALLY — a re-commit with the same claim token is
 * idempotent and keeps the FIRST writer's outcome.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	claimDelegationIngestion,
	findByCorrelationId,
	readDurableIngestionOutcome,
	recordDelegationIngestionResult,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r14_parent';

function completionEvent(
	childSessionId: string,
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
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}
describe('durable ingestion outcome — store semantics (r14 P0-1)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-outcome-store-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('readDurableIngestionOutcome is fail-closed for non-consumed and legacy states', () => {
		const parent = ensureAgentSession(PARENT, 'architect', directory);
		parent.taskWorkflowStates.set('2.1', 'coder_delegated');
		// Static-shaped checks on record-like objects — readDurableIngestionOutcome
		// only reads status + ingestion.
		expect(
			readDurableIngestionOutcome({
				status: 'completed',
			} as never),
		).toEqual({ kind: 'unverifiable' });
		expect(
			readDurableIngestionOutcome({
				status: 'consumed',
				ingestion: undefined,
			} as never),
		).toEqual({ kind: 'unverifiable' });
		expect(
			readDurableIngestionOutcome({
				status: 'consumed',
				ingestion: {
					state: 'claimed',
					attempt: 1,
					updatedAt: 1,
					claimToken: 'tok',
					leaseExpiresAt: 2,
				},
			} as never),
		).toEqual({ kind: 'unverifiable' });
		expect(
			readDurableIngestionOutcome({
				status: 'consumed',
				ingestion: {
					state: 'consumed',
					attempt: 1,
					updatedAt: 1,
					claimToken: 'tok',
				},
			} as never),
		).toEqual({ kind: 'unverifiable' });
		for (const outcome of [
			'rejected',
			'skipped',
			'stale',
			'accepted',
		] as const) {
			expect(
				readDurableIngestionOutcome({
					status: 'consumed',
					ingestion: {
						state: 'consumed',
						attempt: 1,
						updatedAt: 1,
						claimToken: 'tok',
						outcome,
					},
				} as never),
			).toEqual({ kind: outcome });
		}
	});

	test('the consumed commit stores the semantic outcome atomically and keeps the first writer', async () => {
		const parent = ensureAgentSession(PARENT, 'architect', directory);
		parent.taskWorkflowStates.set('2.2', 'coder_delegated');
		const generation = await seedStageAPassed(directory, '2.2');
		await recordPendingDelegation(directory, {
			correlationId: 'ses_r14_store',
			jobId: 'job-store',
			subagentSessionId: 'ses_r14_store',
			parentSessionId: PARENT,
			callID: 'call-store',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '2.2',
			evidenceTaskId: '2.2',
			workflowGeneration: generation,
			workspace: captureWorkspaceSnapshot(directory),
		});
		// Without a terminal there is nothing to claim or commit — fail-closed.
		expect(
			await claimDelegationIngestion(directory, 'ses_r14_store', {
				claimantId: 'store-test',
			}),
		).toBeNull();
		expect(
			await recordDelegationIngestionResult(
				directory,
				'ses_r14_store',
				'no-such-token',
				true,
				{ outcome: 'accepted' },
			),
		).toBeNull();

		// A real positive completion commits consumed + outcome atomically.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_r14_store',
				'<task_result>[REVIEWED] | 2.2 | APPROVED | fine</task_result>',
			),
		);
		const consumed = findByCorrelationId(directory, 'ses_r14_store');
		expect(consumed?.status).toBe('consumed');
		expect(consumed?.ingestion?.state).toBe('consumed');
		expect(consumed?.ingestion?.outcome).toBe('accepted');
		expect(readDurableIngestionOutcome(consumed!)).toEqual({
			kind: 'accepted',
		});

		// A re-commit with the SAME claim token is idempotent and keeps the
		// FIRST writer's outcome — a late negative re-commit cannot rewrite
		// an accepted ingestion (and vice versa).
		const token = consumed!.ingestion!.claimToken;
		const again = await recordDelegationIngestionResult(
			directory,
			'ses_r14_store',
			token,
			true,
			{ outcome: 'rejected' },
		);
		expect(again?.ingestion?.outcome).toBe('accepted');
		expect(readDurableIngestionOutcome(again!)).toEqual({ kind: 'accepted' });
	});
});
