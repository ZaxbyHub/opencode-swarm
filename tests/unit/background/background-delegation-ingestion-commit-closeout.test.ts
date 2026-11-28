/**
 * Layer 23 — the durable terminal-result INGESTION as its own recoverable
 * closeout step (`ingestion_commit`): observer ack and recovery paths.
 *
 * Motivating incident (consumer project, 2026-11-27 evening, task 3.8): a
 * coder round whose trusted terminal was claimed and settled, but whose
 * ingestion apply/commit failed once, sat in `ingestion_error` with every
 * journaled closeout step completed — no pending step, so the r13 re-drive
 * machinery never fired — until the stale sweep flipped the record and
 * OVERWROTE the trusted terminal (claimDelegationIngestion then refuses
 * `not_ready` forever). The round's result was stranded with a pending
 * advisory and no in-band completion; the settlement WAL window blocked
 * re-dispatches; the only exit was out-of-band salvage plus a human
 * /swarm recover.
 *
 * This suite pins the observer-side repair surface: the ingestion-claim set
 * gets `ingestion_commit` as a required closeout step, acked ONLY on the
 * durable consumed commit (success or a terminal-negative outcome); every
 * failure arm leaves it pending; legacy journals (initialized before the step
 * existed) are upserted on replay. The sweep, predicate and bounded-give-up
 * surfaces live in background-delegation-ingestion-commit-sweep.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundDelegationRecord,
	claimDelegationIngestion,
	findByCorrelationId,
	hasPendingTerminalCloseout,
	initializeTerminalCloseout,
	markTerminalCloseoutStepCompleted,
	recordDelegationIngestionResult,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import {
	claimAndSettleCoder,
	completedEvent,
	completedTerminal,
	FULL_JOURNAL,
	seedCoderRecord,
	seedFailedIngestionState,
	setupIngestionRepo,
} from '../../helpers/ingestion-commit-fixtures';

describe('background delegation ingestion_commit closeout step (Layer 23)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		const repo = setupIngestionRepo('swarm-bg-ingestion-commit-');
		directory = repo.directory;
		cleanup = repo.cleanup;
	});

	afterEach(() => {
		cleanup();
	});

	test('fresh coder completion acks ingestion_commit exactly on the durable consumed commit', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-fresh', '1.1');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));

		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.state).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
		expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(false);
	});

	test('observer commit failure arm (null commit) leaves ingestion_commit pending and the record recoverable', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-null-commit', '1.1');
		let commitAttempts = 0;
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			// The ingestion apply runs for real; only the durable commit is
			// refused (fenced/expired claim), which is one of the failure arms
			// that must NEVER ack the step.
			recordIngestionResult: async () => {
				commitAttempts++;
				return null;
			},
		});
		await observer.event(completedEvent(seeded.correlationId));

		expect(commitAttempts).toBe(1);
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.ingestion?.state).not.toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(true);
		// And the live ingestion keeps the automatic sweep away from it.
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(await sweepStaleDelegations(directory, 1)).toBe(0);
		expect(
			findByCorrelationId(directory, seeded.correlationId)?.terminalResult
				?.status,
		).toBe('completed');
	});

	test('duplicate terminal delivery re-drives the failed ingestion to consumed and acks the step', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-recover', '1.1');
		await seedFailedIngestionState(
			directory,
			seeded.correlationId,
			FULL_JOURNAL,
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));

		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.state).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(false);
	});

	test('legacy pre-Layer-23 journal is upserted and the record stays a recovery candidate until consumed', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-legacy', '1.1');
		await seedFailedIngestionState(directory, seeded.correlationId, [
			'delegation_end',
			'parent_advisory',
		]);

		// Legacy shape: every journaled step completed, ingestion retryable,
		// no ingestion_commit step — previously NOT a recovery candidate.
		const legacy = findByCorrelationId(directory, seeded.correlationId);
		expect(legacy?.closeout?.steps.ingestion_commit).toBeUndefined();
		expect(
			hasPendingTerminalCloseout(legacy as BackgroundDelegationRecord),
		).toBe(true);

		// The same-terminal journal upsert adds the missing required step as
		// pending while preserving the completed steps.
		const terminal = completedTerminal(seeded.correlationId);
		await initializeTerminalCloseout(
			directory,
			seeded.correlationId,
			terminal.eventId,
			FULL_JOURNAL,
		);
		const upserted = findByCorrelationId(directory, seeded.correlationId);
		expect(upserted?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		expect(upserted?.closeout?.steps.delegation_end?.state).toBe('completed');
		expect(upserted?.closeout?.steps.parent_advisory?.state).toBe('completed');

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
	});

	/**
	 * The crash point: the ingestion committed durably (consumed) but the
	 * `ingestion_commit` ack never ran.
	 */
	async function seedCommittedButUnacked(correlationId: string) {
		const seeded = await seedCoderRecord(directory, correlationId, '1.1');
		const terminal = await claimAndSettleCoder(directory, seeded.correlationId);
		await initializeTerminalCloseout(
			directory,
			seeded.correlationId,
			terminal.eventId,
			FULL_JOURNAL,
		);
		for (const step of ['delegation_end', 'parent_advisory'] as const) {
			await markTerminalCloseoutStepCompleted(
				directory,
				seeded.correlationId,
				terminal.eventId,
				step,
			);
		}
		const ingestion = await claimDelegationIngestion(
			directory,
			seeded.correlationId,
			{ claimantId: terminal.eventId },
		);
		const claimToken = ingestion?.record.ingestion?.claimToken;
		await recordDelegationIngestionResult(
			directory,
			seeded.correlationId,
			claimToken as string,
			true,
		);
		const crashed = findByCorrelationId(directory, seeded.correlationId);
		expect(crashed?.status).toBe('consumed');
		expect(crashed?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		expect(
			hasPendingTerminalCloseout(crashed as BackgroundDelegationRecord),
		).toBe(true);
		return { seeded, crashed };
	}

	test('crash between commit and ack — consumed-disposition replay acks the step without re-applying', async () => {
		const { seeded, crashed } =
			await seedCommittedButUnacked('coder-crash-ack');

		// "Without re-applying": the replay must take the consumed disposition —
		// no new claim (attempt unchanged) and no ingestion commit call at all.
		let commitCalls = 0;
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			recordIngestionResult: async (...args) => {
				commitCalls++;
				return recordDelegationIngestionResult(...args);
			},
		});
		await observer.event(completedEvent(seeded.correlationId));
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(commitCalls).toBe(0);
		expect(record?.ingestion?.attempt).toBe(crashed?.ingestion?.attempt);
		expect(record?.status).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(false);
	});

	test('the consumed-replay ack is journal-gated: with no journal this pass the step is not acked (r14 P0-2)', async () => {
		const { seeded } = await seedCommittedButUnacked('coder-crash-no-journal');
		const terminal = completedTerminal(seeded.correlationId);
		let ingestionAcks = 0;
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			// The journal cannot be established this pass: acking
			// ingestion_commit would forge a stand-in journal and drop the
			// record from recovery with its other steps never run.
			initializeTerminalCloseoutImpl: async () => false,
			markTerminalCloseoutStepCompletedImpl: async (...args) => {
				if (args[3] === 'ingestion_commit') ingestionAcks++;
				return markTerminalCloseoutStepCompleted(...args);
			},
		});
		await observer.event(completedEvent(seeded.correlationId));

		expect(ingestionAcks).toBe(0);
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.closeout?.terminalEventId).toBe(terminal.eventId);
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('pending');
	});

	test('a non-coder, non-gate record never gets an ingestion_commit step', async () => {
		const seeded = await seedCoderRecord(
			directory,
			'general-no-ingestion',
			'1.1',
			'general',
		);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));

		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
		expect(record?.closeout?.steps.ingestion_commit).toBeUndefined();
		expect(record?.ingestion).toBeUndefined();
	});
});
