/**
 * Issue #1676 — durable pre-launch background coder capacity reservations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_CODER_RESERVATIONS_FILE,
	bindBackgroundCoderReservation,
	buildBackgroundCoderReservationId,
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
	writeDelegationFallback,
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

async function consumeReservedCoder(
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

describe('background coder durable reservations', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-bg-reserve-'));
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	it('deduplicates parent tasks while taskless coders use call identity', async () => {
		const first = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 4,
		});
		const duplicate = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-2',
			maxConcurrent: 4,
		});
		const otherParent = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-2',
			planTaskId: '1.1',
			callID: 'call-3',
			maxConcurrent: 4,
		});
		const tasklessA = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: null,
			callID: 'taskless-a',
			maxConcurrent: 4,
		});
		const tasklessB = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: null,
			callID: 'taskless-b',
			maxConcurrent: 4,
		});
		const repeatedCall = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: null,
			callID: 'taskless-a',
			maxConcurrent: 4,
		});

		expect(first.ok).toBe(true);
		expect(duplicate).toMatchObject({ ok: false, reason: 'duplicate_task' });
		expect(otherParent.ok).toBe(true);
		expect(tasklessA.ok).toBe(true);
		expect(tasklessB.ok).toBe(true);
		expect(repeatedCall).toMatchObject({
			ok: false,
			reason: 'duplicate_call',
		});
	});

	it('atomically enforces the parent capacity under concurrent claims', async () => {
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				reserveBackgroundCoderSlot(directory, {
					parentSessionId: 'parent-1',
					planTaskId: `1.${index + 1}`,
					callID: `call-${index + 1}`,
					maxConcurrent: 2,
				}),
			),
		);

		expect(results.filter((result) => result.ok)).toHaveLength(2);
		expect(
			results.filter((result) => !result.ok && result.reason === 'capacity'),
		).toHaveLength(4);
		expect(
			scanBackgroundCoderReservationsForAdmission(directory),
		).toMatchObject({ status: 'ok', reservations: [{}, {}] });
	});

	it('counts strict primary, fallback, and in-memory occupied task owners', async () => {
		await recordPendingDelegation(
			directory,
			pendingInput(directory, {
				correlationId: 'primary-child',
				subagentSessionId: 'primary-child',
				planTaskId: '1.1',
				evidenceTaskId: '1.1',
			}),
		);
		await writeDelegationFallback(
			directory,
			pendingInput(directory, {
				correlationId: 'fallback-child',
				subagentSessionId: 'fallback-child',
				callID: 'fallback-call',
				planTaskId: '1.2',
				evidenceTaskId: '1.2',
			}),
		);

		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'duplicate-primary',
				maxConcurrent: 4,
			}),
		).toMatchObject({ ok: false, reason: 'duplicate_task' });
		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.4',
				callID: 'at-capacity',
				maxConcurrent: 3,
				occupiedTaskIds: ['1.3'],
			}),
		).toMatchObject({ ok: false, reason: 'capacity', activeCount: 3 });
	});

	it('retains preserved and terminal-unsettled worktree owners', async () => {
		await recordPendingDelegation(
			directory,
			pendingInput(directory, {
				correlationId: 'preserved-child',
				subagentSessionId: 'preserved-child',
			}),
		);
		const preservedEvent = buildBackgroundCompletionEventId({
			correlationId: 'preserved-child',
			jobId: 'job-1',
			status: 'completed',
			resultDigest: 'preserved',
		});
		await claimTerminalResult(directory, 'preserved-child', {
			eventId: preservedEvent,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'preserved' },
		});
		await claimCoderSettlement(directory, 'preserved-child', preservedEvent);
		await updateCoderSettlement(directory, 'preserved-child', {
			operationId: preservedEvent,
			state: 'preserved',
			observedFiles: null,
			outcome: {
				kind: 'shared-root',
				result: 'failed',
				reason: 'attribution failed',
			},
		});

		await recordPendingDelegation(
			directory,
			pendingInput(directory, {
				correlationId: 'worktree-child',
				subagentSessionId: 'worktree-child',
				parentSessionId: 'parent-2',
				callID: 'worktree-call',
				planTaskId: '2.1',
				evidenceTaskId: '2.1',
				worktree: {
					callID: 'worktree-call',
					parentSessionId: 'parent-2',
					taskId: '2.1',
					planTaskId: '2.1',
					worktreePath: path.join(directory, '.swarm-worktrees', 'lane-1'),
					branchName: 'swarm/background-lane',
					worktreeId: 'worktree-1',
					worktreeSessionId: 'parent-2',
					mergeStrategy: 'merge',
					laneIndex: 0,
					worktreeDir: '.swarm-worktrees',
				},
			}),
		);
		const worktreeEvent = buildBackgroundCompletionEventId({
			correlationId: 'worktree-child',
			jobId: 'job-1',
			status: 'completed',
			resultDigest: 'worktree',
		});
		await claimTerminalResult(directory, 'worktree-child', {
			eventId: worktreeEvent,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'worktree' },
		});

		for (const [parentSessionId, planTaskId] of [
			['parent-1', '1.2'],
			['parent-2', '2.2'],
		] as const) {
			expect(
				await reserveBackgroundCoderSlot(directory, {
					parentSessionId,
					planTaskId,
					callID: `next-${planTaskId}`,
					maxConcurrent: 1,
				}),
			).toMatchObject({ ok: false, reason: 'capacity' });
		}
	});

	it('binds exactly and reconciles only an exact consumed primary owner', async () => {
		const reserved = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 1,
		});
		if (!reserved.ok) throw new Error('test setup failed to reserve');
		const reservation = reserved.reservation;

		expect(
			await bindBackgroundCoderReservation(directory, {
				...reservation,
				correlationId: 'wrong-child',
				parentSessionId: 'wrong-parent',
			}),
		).toBeNull();
		const bound = await bindBackgroundCoderReservation(directory, {
			reservationId: reservation.reservationId,
			parentSessionId: reservation.parentSessionId,
			planTaskId: reservation.planTaskId,
			callID: reservation.callID,
			correlationId: 'child-1',
		});
		expect(bound).toMatchObject({ state: 'bound', correlationId: 'child-1' });

		const input = pendingInput(directory, {
			coderReservationId: reservation.reservationId,
		});
		expect(
			await releaseBackgroundCoderReservation(directory, {
				...reservation,
				correlationId: 'child-1',
				reason: 'consumed',
			}),
		).toBe(false);
		await consumeReservedCoder(directory, input);

		// No explicit release: the next atomic admission reconciles the exact
		// consumed primary row and permits the same task again after restart.
		expect(
			await reserveBackgroundCoderSlot(directory, {
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-after-consume',
				maxConcurrent: 1,
			}),
		).toMatchObject({ ok: true, activeCount: 1 });
	});

	it('requires exact coordinates for explicit recovery release', async () => {
		const reserved = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: null,
			callID: 'taskless-call',
			maxConcurrent: 1,
		});
		if (!reserved.ok) throw new Error('test setup failed to reserve');

		expect(
			await releaseBackgroundCoderReservation(directory, {
				...reserved.reservation,
				callID: 'forged-call',
				reason: 'recovered',
			}),
		).toBe(false);
		expect(
			await releaseBackgroundCoderReservation(directory, {
				...reserved.reservation,
				reason: 'recovered',
			}),
		).toBe(true);
	});

	it('fails admission closed on a malformed reservation store', async () => {
		const store = path.join(
			directory,
			'.swarm',
			BACKGROUND_CODER_RESERVATIONS_FILE,
		);
		fs.writeFileSync(store, '{"schemaVersion":1,"reservations":[', 'utf-8');

		const result = await reserveBackgroundCoderSlot(directory, {
			parentSessionId: 'parent-1',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 2,
		});
		expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
		expect(fs.readFileSync(store, 'utf-8')).toBe(
			'{"schemaVersion":1,"reservations":[',
		);
	});

	it('builds stable task IDs independent of call, but taskless IDs per call', () => {
		expect(
			buildBackgroundCoderReservationId({
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-a',
			}),
		).toBe(
			buildBackgroundCoderReservationId({
				parentSessionId: 'parent-1',
				planTaskId: '1.1',
				callID: 'call-b',
			}),
		);
		expect(
			buildBackgroundCoderReservationId({
				parentSessionId: 'parent-1',
				planTaskId: null,
				callID: 'call-a',
			}),
		).not.toBe(
			buildBackgroundCoderReservationId({
				parentSessionId: 'parent-1',
				planTaskId: null,
				callID: 'call-b',
			}),
		);
	});
});
