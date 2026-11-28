/**
 * Regression: terminal-child coder owners must not hold admission capacity.
 *
 * Wild failure (consumer-project session, 2026-11-22): a background
 * coder finished its work — trusted terminal `completed`, settlement
 * `settled` — but the single ingestion attempt into the parent session
 * failed, leaving its delegation record in `ingestion_error` forever. The
 * old admission/renewal predicate counted that dead child as an ACTIVE
 * coder owner: the reservation lease renewed at every maintenance pass
 * ("exact owner record still active") and, with maxConcurrent = 1, every
 * later coder dispatch of the parent was denied with
 * PARALLEL_SLOTS_EXHAUSTED — a full work stoppage that only the 30-minute
 * stale sweep could eventually lift (and only if nothing touched the record
 * again).
 *
 * These tests pin the fix: a coder child that produced its trusted terminal
 * event proves its reservation idle (proof-based release, no age involved)
 * and no longer consumes admission capacity — while its result stays
 * durably claimable in the delegations store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type BackgroundWorktreeDescriptor,
	bindBackgroundCoderReservation,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	maintainBackgroundDelegations,
	type RecordPendingInput,
	readDelegations,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_000_000;

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-bg-terminal-owner-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function pendingInput(
	over: Partial<RecordPendingInput> = {},
): RecordPendingInput {
	return {
		correlationId: 'child-1',
		jobId: 'job-1',
		subagentSessionId: 'child-1',
		parentSessionId: 'parent-1',
		callID: 'call-1',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.9',
		evidenceTaskId: '1.9',
		// The settlement provenance requires this baseline; without it the
		// settlement claim silently stays unsettled.
		taskChangeContext: {
			declaredFiles: ['doc/report.md'],
			baseline: {
				directory: '/repo',
				gitHead: 'base',
				dirtyHash: 'clean',
				changedFiles: [],
				prHeadSha: null,
				scope: '1.9',
			},
		},
		...over,
	};
}

interface WedgedOwnerOptions {
	/** Fail the ingestion commit so the record lands in `ingestion_error`. */
	failIngestion: boolean;
	/** Skip the ingestion claim entirely so the record stays `completed`. */
	skipIngestionClaim?: boolean;
}

/**
 * Build the wild-failure shape: a bound reservation whose exact owner record
 * is a coder child with a trusted `completed` terminal, a `settled`
 * settlement, no worktree — and an ingestion that either failed once
 * (`ingestion_error`) or has not run yet (`completed`).
 */
async function seedTerminalChildOwner(
	dir: string,
	options: WedgedOwnerOptions,
): Promise<string> {
	const claim = await reserveBackgroundCoderSlot(dir, {
		parentSessionId: 'parent-1',
		planTaskId: '1.9',
		callID: 'call-1',
		maxConcurrent: 1,
		now: NOW,
	});
	if (!claim.ok) throw new Error('test setup failed to reserve');
	const bound = await bindBackgroundCoderReservation(dir, {
		reservationId: claim.reservation.reservationId,
		parentSessionId: 'parent-1',
		planTaskId: '1.9',
		callID: 'call-1',
		correlationId: 'child-1',
		now: NOW,
	});
	if (!bound) throw new Error('test setup failed to bind');

	await recordPendingDelegation(
		dir,
		pendingInput({ coderReservationId: claim.reservation.reservationId }),
	);
	const eventId = buildBackgroundCompletionEventId({
		correlationId: 'child-1',
		jobId: 'job-1',
		status: 'completed',
		resultDigest: 'digest',
	});
	await claimTerminalResult(dir, 'child-1', {
		eventId,
		status: 'completed',
		recordedAt: NOW,
		result: { chars: 0, truncated: false, digest: 'digest' },
	});
	await claimCoderSettlement(dir, 'child-1', eventId);
	await updateCoderSettlement(dir, 'child-1', {
		operationId: eventId,
		state: 'settled',
		observedFiles: ['doc/report.md'],
		outcome: { kind: 'shared-root', result: 'ready' },
	});

	if (!options.skipIngestionClaim) {
		const ingestion = await claimDelegationIngestion(dir, 'child-1', {
			claimantId: 'test-observer',
			now: NOW + 1,
			leaseMs: 60_000,
		});
		const claimToken = ingestion?.record.ingestion?.claimToken;
		if (!claimToken) throw new Error('test setup failed to claim ingestion');
		const committed = await recordDelegationIngestionResult(
			dir,
			'child-1',
			claimToken,
			!options.failIngestion,
			{ now: NOW + 2 },
		);
		if (!committed) throw new Error('test setup failed to commit ingestion');
	}
	return claim.reservation.reservationId;
}

/**
 * Minimal valid standard-worktree lane descriptor. The path never needs to
 * exist on disk: the admission/release guards only inspect record shape.
 */
function worktreeDescriptor(dir: string): BackgroundWorktreeDescriptor {
	const lanePath = path.join(dir, '.swarm', 'worktrees', 'lane-1');
	return {
		callID: 'call-1',
		parentSessionId: 'parent-1',
		taskId: '1.9',
		planTaskId: '1.9',
		worktreePath: lanePath,
		branchName: 'swarm/lane-1',
		worktreeId: 'wt-1',
		worktreeSessionId: 'child-1',
		mergeStrategy: 'merge',
		laneIndex: 0,
		worktreeDir: lanePath,
	};
}

interface CompletedOwnerOptions {
	/** Attach a standard-worktree lane to the pending record. */
	worktree?: BackgroundWorktreeDescriptor;
}

/**
 * Seed a coder owner that reached its trusted `completed` terminal event and
 * stop there: the record is terminal, but its follow-up fate (settlement,
 * ingestion) is whatever the caller layers on top. No ingestion is claimed.
 */
async function seedCompletedCoderOwner(
	dir: string,
	options: CompletedOwnerOptions = {},
): Promise<string> {
	const claim = await reserveBackgroundCoderSlot(dir, {
		parentSessionId: 'parent-1',
		planTaskId: '1.9',
		callID: 'call-1',
		maxConcurrent: 1,
		now: NOW,
	});
	if (!claim.ok) throw new Error('test setup failed to reserve');
	const bound = await bindBackgroundCoderReservation(dir, {
		reservationId: claim.reservation.reservationId,
		parentSessionId: 'parent-1',
		planTaskId: '1.9',
		callID: 'call-1',
		correlationId: 'child-1',
		now: NOW,
	});
	if (!bound) throw new Error('test setup failed to bind');
	await recordPendingDelegation(
		dir,
		pendingInput({
			coderReservationId: claim.reservation.reservationId,
			worktree: options.worktree,
		}),
	);
	const eventId = buildBackgroundCompletionEventId({
		correlationId: 'child-1',
		jobId: 'job-1',
		status: 'completed',
		resultDigest: 'digest',
	});
	const terminal = await claimTerminalResult(dir, 'child-1', {
		eventId,
		status: 'completed',
		recordedAt: NOW,
		result: { chars: 0, truncated: false, digest: 'digest' },
	});
	if (!terminal) throw new Error('test setup failed to claim terminal');
	return claim.reservation.reservationId;
}

/**
 * Seed a coder owner whose settlement was PRESERVED (partial shared-root
 * outcome): trusted terminal `completed`, settlement `preserved`, no
 * worktree. This is the exact shape the preserved guards must retain.
 */
async function seedPreservedSettlementOwner(dir: string): Promise<string> {
	const reservationId = await seedCompletedCoderOwner(dir);
	const eventId = buildBackgroundCompletionEventId({
		correlationId: 'child-1',
		jobId: 'job-1',
		status: 'completed',
		resultDigest: 'digest',
	});
	const settling = await claimCoderSettlement(dir, 'child-1', eventId);
	if (!settling) throw new Error('test setup failed to claim settlement');
	// `preserved` requires a partial/failed outcome on the update path.
	const preserved = await updateCoderSettlement(dir, 'child-1', {
		operationId: eventId,
		state: 'preserved',
		observedFiles: ['doc/report.md'],
		outcome: { kind: 'shared-root', result: 'partial' },
	});
	if (!preserved) throw new Error('test setup failed to preserve settlement');
	return reservationId;
}

function reservationIds(dir: string): string[] {
	const scan = scanBackgroundCoderReservationsForAdmission(dir);
	return scan.status === 'ok'
		? scan.reservations.map((reservation) => reservation.reservationId)
		: [];
}

describe('terminal-child coder owners vs admission capacity (regression)', () => {
	let dir: string;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({ fixedNow: NOW });
		dir = makeTempProject();
	});

	afterEach(() => {
		restoreClock();
		closeAllProjectDbs();
		safeRmRecursive(dir);
	});

	it('an ingestion_error owner does not block a different task at maxConcurrent=1', async () => {
		// Previous code counted the ingestion_error record as an active coder
		// owner AND retained its bound reservation: with maxConcurrent = 1,
		// every later dispatch of the parent died with PARALLEL_SLOTS_EXHAUSTED.
		await seedTerminalChildOwner(dir, { failIngestion: true });

		const result = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: '1.10',
			callID: 'call-next',
			maxConcurrent: 1,
			now: NOW + 60_000,
		});
		expect(result).toMatchObject({ ok: true, activeCount: 1 });

		// The wedged reservation was reconciled away at admission; the single
		// surviving reservation is the NEW task's, not the old one's.
		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations).toHaveLength(1);
			expect(scan.reservations[0]?.planTaskId).toBe('1.10');
		}
	});

	it('maintenance releases an ingestion_error owner reservation on proof, not age', async () => {
		const reservationId = await seedTerminalChildOwner(dir, {
			failIngestion: true,
		});

		// Lease is still valid (15 min default, only 1 min elapsed): the old
		// code renewed it here ("exact owner record still active") forever.
		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 60_000,
		});
		expect(result.status).toBe('ok');
		expect(result.renewed).toEqual([]);
		expect(result.released).toEqual([
			{ reservationId, generation: 1, reason: 'proven-terminal-owner' },
		]);
		expect(reservationIds(dir)).toEqual([]);

		// The release never drops the durable result: the record stays
		// claimable for a later ingestion retry.
		const record = readDelegations(dir).find(
			(entry) => entry.correlationId === 'child-1',
		);
		expect(record?.status).toBe('ingestion_error');
		expect(record?.terminalResult?.status).toBe('completed');
		expect(record?.ingestion?.state).toBe('retryable');
	});

	it('a completed-but-unconsumed owner frees admission for a different task', async () => {
		await seedTerminalChildOwner(dir, {
			failIngestion: false,
			skipIngestionClaim: true,
		});

		const result = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: '1.10',
			callID: 'call-next',
			maxConcurrent: 1,
			now: NOW + 60_000,
		});
		expect(result).toMatchObject({ ok: true, activeCount: 1 });
	});

	it('the same task can be re-dispatched after its launch ended in ingestion_error', async () => {
		await seedTerminalChildOwner(dir, { failIngestion: true });

		// The workflow retry path: a fresh dispatch for the SAME task must be
		// admitted once the previous launch is durably terminal — the old
		// reservation cannot pin the task forever.
		const result = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: '1.9',
			callID: 'call-retry',
			maxConcurrent: 1,
			now: NOW + 60_000,
		});
		expect(result).toMatchObject({ ok: true, activeCount: 1 });
	});

	it('a pending owner still holds the slot and renews (liveness unchanged)', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: '1.9',
			callID: 'call-1',
			maxConcurrent: 1,
			now: NOW,
		});
		if (!claim.ok) throw new Error('test setup failed to reserve');
		await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent-1',
			planTaskId: '1.9',
			callID: 'call-1',
			correlationId: 'child-1',
			now: NOW,
		});
		await recordPendingDelegation(
			dir,
			pendingInput({ coderReservationId: claim.reservation.reservationId }),
		);

		// A running child still blocks a second dispatch at maxConcurrent = 1…
		const blocked = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: '1.10',
			callID: 'call-next',
			maxConcurrent: 1,
			now: NOW + 60_000,
		});
		expect(blocked).toMatchObject({ ok: false, reason: 'capacity' });

		// …and its lease still renews on fresh owner activity.
		const maintenance = await maintainBackgroundDelegations(dir, {
			now: NOW + 16 * 60_000,
		});
		expect(maintenance.renewed).toEqual([
			{ reservationId: claim.reservation.reservationId, generation: 1 },
		]);
		expect(maintenance.released).toEqual([]);
	});

	describe('fail-closed owners: preserved settlement / worktree holder (F-001)', () => {
		it('a preserved-settlement owner still occupies admission capacity', async () => {
			// A guard regression that treated a preserved settlement like a
			// finished launch would reconcile its reservation away at
			// admission and stop counting the record as active, letting a
			// second dispatch in while recoverable settlement work is open.
			const reservationId = await seedPreservedSettlementOwner(dir);

			// Discriminating record shape: terminal completed, settlement
			// preserved, NO worktree.
			const record = readDelegations(dir).find(
				(entry) => entry.correlationId === 'child-1',
			);
			expect(record?.coderSettlement?.state).toBe('preserved');
			expect(record?.worktree).toBeUndefined();

			const blocked = await reserveBackgroundCoderSlot(dir, {
				parentSessionId: 'parent-1',
				planTaskId: '1.10',
				callID: 'call-next',
				maxConcurrent: 1,
				now: NOW + 60_000,
			});
			expect(blocked).toMatchObject({ ok: false, reason: 'capacity' });

			// Not proven released: the durable reservation survives the
			// admission attempt's reconciliation pass.
			expect(reservationIds(dir)).toEqual([reservationId]);
		});

		it('maintenance renews — never proof-releases — a preserved-settlement owner', async () => {
			const reservationId = await seedPreservedSettlementOwner(dir);

			// Lease expired (15 min default, 16 min elapsed): a proof-release
			// regression here would emit reason 'proven-terminal-owner'.
			const maintenance = await maintainBackgroundDelegations(dir, {
				now: NOW + 16 * 60_000,
			});
			expect(maintenance.status).toBe('ok');
			expect(maintenance.renewed).toEqual([{ reservationId, generation: 1 }]);
			expect(maintenance.released).toEqual([]);
			expect(reservationIds(dir)).toEqual([reservationId]);
		});

		it('a worktree-holding owner still occupies admission capacity', async () => {
			// Same negative case for the worktree guard: a terminal
			// `completed` owner that still holds its standard-worktree lane
			// owns a recoverable resource and must keep the slot.
			const reservationId = await seedCompletedCoderOwner(dir, {
				worktree: worktreeDescriptor(dir),
			});

			// Discriminating record shape: terminal completed, settlement
			// still `pending` (not preserved), worktree present.
			const record = readDelegations(dir).find(
				(entry) => entry.correlationId === 'child-1',
			);
			expect(record?.status).toBe('completed');
			expect(record?.terminalResult?.status).toBe('completed');
			expect(record?.coderSettlement?.state).toBe('pending');
			expect(record?.worktree).toBeDefined();

			const blocked = await reserveBackgroundCoderSlot(dir, {
				parentSessionId: 'parent-1',
				planTaskId: '1.10',
				callID: 'call-next',
				maxConcurrent: 1,
				now: NOW + 60_000,
			});
			expect(blocked).toMatchObject({ ok: false, reason: 'capacity' });
			expect(reservationIds(dir)).toEqual([reservationId]);
		});

		it('maintenance renews — never proof-releases — a worktree-holding owner', async () => {
			const reservationId = await seedCompletedCoderOwner(dir, {
				worktree: worktreeDescriptor(dir),
			});

			const maintenance = await maintainBackgroundDelegations(dir, {
				now: NOW + 16 * 60_000,
			});
			expect(maintenance.status).toBe('ok');
			expect(maintenance.renewed).toEqual([{ reservationId, generation: 1 }]);
			expect(maintenance.released).toEqual([]);
			expect(reservationIds(dir)).toEqual([reservationId]);
		});
	});
});
