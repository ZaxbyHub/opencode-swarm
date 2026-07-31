/**
 * Issue #1676 — reservation reconciliation across pre-bind crash windows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	type RecordPendingInput,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	releaseBackgroundCoderReservation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function pendingInput(
	directory: string,
	overrides: Partial<RecordPendingInput> = {},
): RecordPendingInput {
	return {
		correlationId: 'child-1',
		jobId: 'job-1',
		subagentSessionId: 'child-1',
		parentSessionId: 'parent-1',
		callID: 'call-1',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		taskChangeContext: {
			declaredFiles: ['src/feature.ts'],
			baseline: {
				directory,
				gitHead: 'base',
				dirtyHash: 'clean',
				changedFiles: [],
				prHeadSha: null,
				scope: '1.1',
			},
		},
		...overrides,
	};
}

async function consumeCoder(
	directory: string,
	input: RecordPendingInput,
): Promise<void> {
	await recordPendingDelegation(directory, input);
	const eventId = buildBackgroundCompletionEventId({
		correlationId: input.correlationId,
		jobId: input.jobId,
		status: 'completed',
		resultDigest: 'digest',
	});
	await claimTerminalResult(directory, input.correlationId, {
		eventId,
		status: 'completed',
		recordedAt: 100,
		result: { chars: 0, truncated: false, digest: 'digest' },
	});
	await claimCoderSettlement(directory, input.correlationId, eventId);
	await updateCoderSettlement(directory, input.correlationId, {
		operationId: eventId,
		state: 'settled',
		observedFiles: ['src/feature.ts'],
		outcome: { kind: 'shared-root', result: 'ready' },
	});
	const claim = await claimDelegationIngestion(directory, input.correlationId, {
		claimantId: 'test-observer',
		now: 200,
		leaseMs: 1_000,
	});
	const claimToken = claim?.record.ingestion?.claimToken;
	if (!claimToken) throw new Error('test setup failed to claim ingestion');
	await recordDelegationIngestionResult(
		directory,
		input.correlationId,
		claimToken,
		true,
		{ now: 201 },
	);
}

describe('background coder reservation crash recovery', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-bg-crash-'));
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	it('reconciles a consumed primary owner when the reservation was never bound', async () => {
		const reserved = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 1,
		});
		if (!reserved.ok) throw new Error('test setup failed to reserve');

		await consumeCoder(
			directory,
			pendingInput(directory, {
				coderReservationId: reserved.reservation.reservationId,
			}),
		);
		expect(
			scanBackgroundCoderReservationsForAdmission(directory),
		).toMatchObject({
			status: 'ok',
			reservations: [{ state: 'reserved', correlationId: null }],
		});

		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-after-crash',
				maxConcurrent: 1,
			}),
		).toMatchObject({ ok: true, activeCount: 1 });
	});

	it('reconciles exact shared-root error and cancellation owners before bind', async () => {
		for (const [index, status] of (['error', 'cancelled'] as const).entries()) {
			const taskId = `1.${index + 1}`;
			const callID = `call-${status}`;
			const correlationId = `child-${status}`;
			const reserved = await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: taskId,
				callID,
				maxConcurrent: 1,
			});
			if (!reserved.ok) throw new Error('test setup failed to reserve');
			await recordPendingDelegation(
				directory,
				pendingInput(directory, {
					correlationId,
					subagentSessionId: correlationId,
					jobId: `job-${status}`,
					callID,
					planTaskId: taskId,
					evidenceTaskId: taskId,
					coderReservationId: reserved.reservation.reservationId,
				}),
			);
			const eventId = buildBackgroundCompletionEventId({
				correlationId,
				jobId: `job-${status}`,
				status,
				resultDigest: status,
			});
			await claimTerminalResult(directory, correlationId, {
				eventId,
				status,
				recordedAt: 100 + index,
				result: { chars: 0, truncated: false, digest: status },
			});

			const replacement = await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: taskId,
				callID: `replacement-${status}`,
				maxConcurrent: 1,
			});
			expect(replacement).toMatchObject({ ok: true, activeCount: 1 });
			if (!replacement.ok) throw new Error('replacement reservation failed');
			expect(
				await releaseBackgroundCoderReservation(directory, {
					...replacement.reservation,
					reason: 'recovered',
				}),
			).toBe(true);
		}
	});

	it('retains an unbound reservation when primary ownership is ambiguous', async () => {
		const reserved = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 1,
		});
		if (!reserved.ok) throw new Error('test setup failed to reserve');
		await recordPendingDelegation(
			directory,
			pendingInput(directory, {
				correlationId: 'child-b',
				subagentSessionId: 'child-b',
				coderReservationId: reserved.reservation.reservationId,
			}),
		);
		await consumeCoder(
			directory,
			pendingInput(directory, {
				correlationId: 'child-a',
				subagentSessionId: 'child-a',
				coderReservationId: reserved.reservation.reservationId,
			}),
		);

		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-after-ambiguity',
				maxConcurrent: 1,
			}),
		).toMatchObject({ ok: false, reason: 'duplicate_task' });
	});

	it('retains an unbound reservation for a mismatched consumed owner', async () => {
		const reserved = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 1,
		});
		if (!reserved.ok) throw new Error('test setup failed to reserve');
		await consumeCoder(
			directory,
			pendingInput(directory, {
				callID: 'forged-call',
				coderReservationId: reserved.reservation.reservationId,
			}),
		);

		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-after-forgery',
				maxConcurrent: 1,
			}),
		).toMatchObject({ ok: false, reason: 'duplicate_task' });
	});

	it('retains an exact terminal failure when its worktree must be recovered', async () => {
		const reserved = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 1,
		});
		if (!reserved.ok) throw new Error('test setup failed to reserve');
		await recordPendingDelegation(
			directory,
			pendingInput(directory, {
				coderReservationId: reserved.reservation.reservationId,
				worktree: {
					callID: 'call-1',
					parentSessionId: 'parent-1',
					taskId: '1.1',
					planTaskId: '1.1',
					worktreePath: path.join(directory, '.swarm-worktrees', 'lane-1'),
					branchName: 'swarm/background-lane',
					worktreeId: 'worktree-1',
					worktreeSessionId: 'parent-1',
					mergeStrategy: 'merge',
					laneIndex: 0,
					worktreeDir: '.swarm-worktrees',
				},
			}),
		);
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'child-1',
			jobId: 'job-1',
			status: 'error',
			resultDigest: 'failed',
		});
		await claimTerminalResult(directory, 'child-1', {
			eventId,
			status: 'error',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'failed' },
		});

		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-after-worktree-failure',
				maxConcurrent: 1,
			}),
		).toMatchObject({ ok: false, reason: 'duplicate_task' });
	});
});
