/**
 * Retryable ingestion commits persist their failure reason — the
 * observability fix for the undiagnosable redrive burn.
 *
 * Field incident (task 3.11, 2026-11-28): a coder completion's Stage-B
 * ingestion failed deterministically five times; the durable record carried
 * only the attempt counter, so the failure cause ("scope handoff could not
 * be reconstructed exactly") existed solely in process-local return values.
 * The retryable commit now stores the bounded reason atomically with the
 * retryable flip, the next claim preserves it (a lease that expires before
 * any commit keeps the last verdict visible), and the consumed flip drops
 * it (a success has no failure reason).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	findByCorrelationId,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const PARENT = 'ses-reason-parent';
const CORR = 'ses-reason-child';

describe('retryable ingestion commits persist the failure reason', () => {
	let directory = '';
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-ingest-reason-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	async function seedClaimableCoderRecord(): Promise<void> {
		ensureAgentSession(PARENT, 'architect', directory);
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: CORR,
			jobId: null,
			subagentSessionId: CORR,
			parentSessionId: PARENT,
			callID: 'call-reason',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['a.ts'],
				baseline,
			},
		});
		const resultDigest = createHash('sha256')
			.update('coder finished')
			.digest('hex');
		const eventId = buildBackgroundCompletionEventId({
			correlationId: CORR,
			jobId: null,
			status: 'completed',
			resultDigest,
		});
		await claimTerminalResult(directory, CORR, {
			eventId,
			status: 'completed',
			recordedAt: Date.now(),
			result: {
				text: 'coder finished',
				chars: 14,
				truncated: false,
				digest: resultDigest,
			},
		});
		await claimCoderSettlement(directory, CORR, eventId);
		await updateCoderSettlement(directory, CORR, {
			operationId: eventId,
			state: 'settled',
			observedFiles: [],
			outcome: { kind: 'shared-root', result: 'ready' },
		});
	}

	test('stores the bounded reason on the retryable flip, preserves it across claims, drops it on consume', async () => {
		await seedClaimableCoderRecord();

		// Attempt 1: the retryable commit persists the (oversized) reason,
		// bounded to the durable schema's 256-char ceiling.
		const claim1 = await claimDelegationIngestion(directory, CORR, {
			claimantId: 'observer-1',
		});
		expect(claim1?.disposition).toBe('claimed');
		const token1 = claim1?.record.ingestion?.claimToken;
		expect(token1).toBeTruthy();
		const oversized = `x`.repeat(300);
		const committed1 = await recordDelegationIngestionResult(
			directory,
			CORR,
			token1!,
			false,
			{ reason: oversized },
		);
		expect(committed1).not.toBeNull();
		let record = findByCorrelationId(directory, CORR);
		expect(record?.status).toBe('ingestion_error');
		expect(record?.ingestion?.state).toBe('retryable');
		const storedReason = record?.ingestion?.lastReason;
		expect(storedReason).toBeTruthy();
		expect(storedReason!.length).toBeLessThanOrEqual(256);
		expect(storedReason!.endsWith('...')).toBe(true);

		// Attempt 2: the claim itself preserves the last reason (an expired
		// lease without a commit keeps the previous verdict visible).
		const claim2 = await claimDelegationIngestion(directory, CORR, {
			claimantId: 'observer-2',
		});
		expect(claim2?.disposition).toBe('retry');
		expect(claim2?.record.ingestion?.attempt).toBe(2);
		expect(claim2?.record.ingestion?.lastReason).toBe(storedReason);
		const token2 = claim2?.record.ingestion?.claimToken;

		// A retryable commit without a new reason retains the previous one.
		await recordDelegationIngestionResult(directory, CORR, token2!, false, {});
		record = findByCorrelationId(directory, CORR);
		expect(record?.ingestion?.lastReason).toBe(storedReason);

		// Attempt 3: the consumed flip never carries a failure reason.
		const claim3 = await claimDelegationIngestion(directory, CORR, {
			claimantId: 'observer-3',
		});
		const token3 = claim3?.record.ingestion?.claimToken;
		await recordDelegationIngestionResult(directory, CORR, token3!, true, {
			outcome: 'accepted',
		});
		record = findByCorrelationId(directory, CORR);
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.state).toBe('consumed');
		expect(record?.ingestion?.outcome).toBe('accepted');
		expect(record?.ingestion?.lastReason).toBeUndefined();
	});

	test('an empty-string reason is not persisted (treated as no reason)', async () => {
		await seedClaimableCoderRecord();
		const claim = await claimDelegationIngestion(directory, CORR, {
			claimantId: 'observer-blank',
		});
		const token = claim?.record.ingestion?.claimToken;
		await recordDelegationIngestionResult(directory, CORR, token!, false, {
			reason: '   ',
		});
		const record = findByCorrelationId(directory, CORR);
		expect(record?.status).toBe('ingestion_error');
		// Whitespace-only reasons carry no information: nothing is stored,
		// and there was no previous reason to retain.
		expect(record?.ingestion?.lastReason).toBeUndefined();
	});
});
