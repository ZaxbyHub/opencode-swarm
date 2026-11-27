/**
 * Layer 23 — sweep immunity, the bounded re-drive (F-002) and the recovery-set
 * predicate for the durable `ingestion_commit` closeout step.
 *
 * The automatic stale sweep must never overwrite the trusted terminal of a
 * record whose ingestion is still recoverable — but that immunity is BOUNDED:
 * a deterministic ingestion failure cannot re-drive forever. After
 * MAX_INGESTION_REDRIVE_ATTEMPTS failed claims the observer gives up visibly
 * (ingestion_commit marked failed, record out of the recovery set) and the
 * sweep regains authority. Observer ack/recovery paths live in
 * background-delegation-ingestion-commit-closeout.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundDelegationRecord,
	findByCorrelationId,
	hasPendingTerminalCloseout,
	isIngestionRedriveExhausted,
	MAX_INGESTION_REDRIVE_ATTEMPTS,
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { ensureAgentSession } from '../../../src/state';
import {
	completedEvent,
	FULL_JOURNAL,
	seedCoderRecord,
	seedFailedIngestionState,
	setupIngestionRepo,
} from '../../helpers/ingestion-commit-fixtures';

const AGED_MS = 15;

async function age(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, AGED_MS));
}

describe('ingestion_commit sweep immunity and bounded re-drive (Layer 23)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		const repo = setupIngestionRepo('swarm-bg-ingestion-sweep-');
		directory = repo.directory;
		cleanup = repo.cleanup;
	});

	afterEach(() => {
		cleanup();
	});

	test('failed ingestion keeps the step pending, keeps the record recoverable, and the stale sweep cannot flip it', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-wedge', '1.1');
		await seedFailedIngestionState(
			directory,
			seeded.correlationId,
			FULL_JOURNAL,
		);

		const wedged = findByCorrelationId(directory, seeded.correlationId);
		expect(wedged?.status).toBe('ingestion_error');
		expect(wedged?.ingestion?.state).toBe('retryable');
		expect(wedged?.terminalResult?.status).toBe('completed');
		expect(wedged?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		// The pending step is exactly what keeps the r13 re-drive machinery
		// armed (previously: every step completed, no candidate, no recovery).
		expect(
			hasPendingTerminalCloseout(wedged as BackgroundDelegationRecord),
		).toBe(true);

		// The liveness sweep must not overwrite the trusted terminal of a
		// record whose ingestion is still recoverable.
		await age();
		expect(await sweepStaleDelegations(directory, 1)).toBe(0);
		const afterSweep = findByCorrelationId(directory, seeded.correlationId);
		expect(afterSweep?.status).toBe('ingestion_error');
		expect(afterSweep?.terminalResult?.status).toBe('completed');
	});

	test('the stale sweep still flips records without a live/recoverable ingestion (guard is scoped)', async () => {
		// A pending record with no terminal and no ingestion claim is the
		// sweep's original purpose — it must still be swept.
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '1.1';
		await recordPendingDelegation(directory, {
			correlationId: 'plain-pending',
			jobId: null,
			subagentSessionId: 'plain-pending',
			parentSessionId: 'parent',
			callID: 'call-plain',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workspace: captureWorkspaceSnapshot(directory),
		});
		await age();
		expect(await sweepStaleDelegations(directory, 1)).toBe(1);
		expect(findByCorrelationId(directory, 'plain-pending')?.status).toBe(
			'stale',
		);
	});

	test('an authorized operator override sweep still terminalizes a recoverable ingestion (#2971 scoping)', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-force', '1.1');
		await seedFailedIngestionState(
			directory,
			seeded.correlationId,
			FULL_JOURNAL,
		);
		await age();
		// The Layer 23 immunity belongs to the AUTOMATIC liveness sweep; an
		// authorized operator finalization (failureClass override, e.g.
		// /swarm abort-pr-workflow) may deliberately terminalize the record.
		const swept = await sweepStaleDelegations(directory, 1, {
			failureClass: 'operator_cancelled',
		});
		expect(swept).toBe(1);
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('stale');
		expect(record?.result?.workflowLaneFailureClass).toBe('operator_cancelled');
	});

	test('below the attempt budget the sweep stays immune and the observer still re-drives', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-below', '1.1');
		await seedFailedIngestionState(
			directory,
			seeded.correlationId,
			FULL_JOURNAL,
			MAX_INGESTION_REDRIVE_ATTEMPTS - 1,
		);
		const before = findByCorrelationId(directory, seeded.correlationId);
		expect(before?.ingestion?.attempt).toBe(MAX_INGESTION_REDRIVE_ATTEMPTS - 1);
		expect(
			isIngestionRedriveExhausted(before as BackgroundDelegationRecord),
		).toBe(false);
		await age();
		expect(await sweepStaleDelegations(directory, 1)).toBe(0);
		// Re-drive succeeds (the real apply works) -> consumed + acked.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
	});

	test('an exhausted ingestion is given up visibly, leaves recovery, and the sweep flips it as before Layer 23', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-exhausted', '1.1');
		await seedFailedIngestionState(
			directory,
			seeded.correlationId,
			FULL_JOURNAL,
			MAX_INGESTION_REDRIVE_ATTEMPTS,
			// parent_advisory still pending: the give-up must close it (the
			// failed-apply arm's sibling closes), or the record would stay in
			// the recovery set and keep churning.
			['parent_advisory'],
		);
		const exhausted = findByCorrelationId(directory, seeded.correlationId);
		expect(exhausted?.closeout?.steps.parent_advisory?.state).toBe('pending');
		expect(exhausted?.ingestion?.attempt).toBe(MAX_INGESTION_REDRIVE_ATTEMPTS);
		expect(exhausted?.ingestion?.state).toBe('retryable');
		expect(
			isIngestionRedriveExhausted(exhausted as BackgroundDelegationRecord),
		).toBe(true);
		// Still a recovery candidate until the observer records the give-up.
		expect(
			hasPendingTerminalCloseout(exhausted as BackgroundDelegationRecord),
		).toBe(true);

		let commitCalls = 0;
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			recordIngestionResult: async () => {
				commitCalls++;
				return null;
			},
		});
		await observer.event(completedEvent(seeded.correlationId));

		const given = findByCorrelationId(directory, seeded.correlationId);
		// No new claim and no ingestion apply/commit: the loop is over.
		expect(commitCalls).toBe(0);
		expect(given?.ingestion?.attempt).toBe(MAX_INGESTION_REDRIVE_ATTEMPTS);
		expect(given?.closeout?.steps.ingestion_commit?.state).toBe('failed');
		expect(given?.closeout?.steps.ingestion_commit?.reason).toContain(
			'abandoned',
		);
		expect(given?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(given as BackgroundDelegationRecord),
		).toBe(false);

		// The immunity ended with the budget: once the record ages, the sweep
		// flips it exactly as it did before Layer 23 (bounded, not a zombie).
		await age();
		expect(await sweepStaleDelegations(directory, 1)).toBe(1);
		expect(findByCorrelationId(directory, seeded.correlationId)?.status).toBe(
			'stale',
		);
	});

	test('isIngestionRedriveExhausted — pure boundary cases', () => {
		const rec = (ingestion: unknown) =>
			({ ingestion }) as unknown as BackgroundDelegationRecord;
		const max = MAX_INGESTION_REDRIVE_ATTEMPTS;
		expect(isIngestionRedriveExhausted(rec(undefined))).toBe(false);
		expect(
			isIngestionRedriveExhausted(rec({ state: 'consumed', attempt: max + 3 })),
		).toBe(false);
		expect(
			isIngestionRedriveExhausted(
				rec({ state: 'retryable', attempt: max - 1 }),
			),
		).toBe(false);
		expect(
			isIngestionRedriveExhausted(rec({ state: 'retryable', attempt: max })),
		).toBe(true);
		// A live claim on the last attempt may still commit — not exhausted.
		expect(
			isIngestionRedriveExhausted(
				rec({ state: 'claimed', attempt: max, leaseExpiresAt: 2_000 }),
				1_000,
			),
		).toBe(false);
		expect(
			isIngestionRedriveExhausted(
				rec({ state: 'claimed', attempt: max, leaseExpiresAt: 1_000 }),
				1_000,
			),
		).toBe(true);
	});

	test('hasPendingTerminalCloseout — pure predicate pinning (Layer 23 boundary cases)', () => {
		const base = {
			batchId: undefined,
			terminalResult: {
				eventId: 'evt-1',
				status: 'completed',
			},
			closeout: {
				terminalEventId: 'evt-1',
				steps: {
					delegation_end: { state: 'completed' },
					parent_advisory: { state: 'completed' },
				},
			},
		} as unknown as BackgroundDelegationRecord;
		const withStep = (state: string, ingestionState = 'retryable') =>
			({
				...base,
				ingestion: { state: ingestionState },
				closeout: {
					terminalEventId: 'evt-1',
					steps: {
						delegation_end: { state: 'completed' },
						parent_advisory: { state: 'completed' },
						ingestion_commit: { state },
					},
				},
			}) as unknown as BackgroundDelegationRecord;
		// Legacy wedge shape: non-consumed ingestion, no step → candidate.
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'retryable' },
			} as BackgroundDelegationRecord),
		).toBe(true);
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'claimed' },
			} as BackgroundDelegationRecord),
		).toBe(true);
		// Consumed ingestion without the step → not a candidate.
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'consumed' },
			} as BackgroundDelegationRecord),
		).toBe(false);
		// No ingestion field at all (outside the claim set) → not a candidate
		// via the Layer 23 arm.
		expect(hasPendingTerminalCloseout(base)).toBe(false);
		// Pending step → candidate.
		expect(hasPendingTerminalCloseout(withStep('pending'))).toBe(true);
		// A step durably marked failed is terminally closed — drops out even
		// though the ingestion never consumed.
		expect(hasPendingTerminalCloseout(withStep('failed'))).toBe(false);
		// A completed step with a consumed ingestion drops out.
		expect(hasPendingTerminalCloseout(withStep('completed', 'consumed'))).toBe(
			false,
		);
		// Lane records settle elsewhere — never candidates.
		expect(
			hasPendingTerminalCloseout({
				...base,
				batchId: 'batch-1',
				ingestion: { state: 'retryable' },
			} as BackgroundDelegationRecord),
		).toBe(false);
	});
});
