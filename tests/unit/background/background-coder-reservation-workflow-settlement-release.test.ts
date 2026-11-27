/**
 * Regression: a workflow-settled coder launch must not hold its background
 * reservation forever (2026-11-27 task 2.18 stale-reservation wedge).
 *
 * Wild failure (Wirtschaftssimulation session): a background repair coder
 * finished its work and the architect durably settled its coder settlement —
 * `.swarm/coder-settlements/2.18.json` at `state: 'COMMITTED'`,
 * `accepted: true`, `transitionId: 'coder:<callID>'` — but the delegation
 * record never observed the child terminal (stayed `pending`, store
 * `lastTerminalAt` predated the dispatch). The reservation logic consulted
 * only that record: the maintenance sweep renewed the lease every 15 minutes
 * ("exact owner record still active"), and because task-keyed reservation
 * ids are minted per parent+task, every redispatch of the task was refused
 * as `duplicate_task` — a self-extending wedge with no lease-based escape.
 *
 * These tests pin the fix: a COMMITTED accepted settlement for exactly the
 * reservation's launch (`coder:<callID>`) is a durable release proof — in
 * the maintenance sweep AND in the admission reconciliation — while every
 * weaker shape (non-terminal WAL, unaccepted settlement, foreign
 * transitionId, call-keyed reservation, missing/corrupt WAL) stays
 * fail-closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	bindBackgroundCoderReservation,
	maintainBackgroundDelegations,
	type RecordPendingInput,
	recordPendingDelegation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { isCommittedAcceptedSettlementForLaunch } from '../../../src/workflow/coder-settlement-launch-proof';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_000_000;
const TASK = '2.18';
const CALL = 'call-wedge';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-bg-wal-release-');
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
		callID: CALL,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: TASK,
		evidenceTaskId: TASK,
		taskChangeContext: {
			declaredFiles: ['doc/report.md'],
			baseline: {
				directory: '/repo',
				gitHead: 'base',
				dirtyHash: 'clean',
				changedFiles: [],
				prHeadSha: null,
				scope: TASK,
			},
		},
		...over,
	};
}

interface WalSeedOptions {
	state?: 'ABORTED' | 'COMMITTED' | 'DISPATCHED' | 'PREPARED';
	accepted?: boolean;
	transitionId?: string;
}

/**
 * Write a valid v1 coder-settlement WAL for TASK (the shape
 * parseCoderSettlementWal accepts), defaulting to the wild-wedge proof:
 * COMMITTED + accepted + `coder:<CALL>`.
 */
function seedSettlementWal(dir: string, options: WalSeedOptions = {}): void {
	const wal = {
		version: 1,
		state: options.state ?? 'COMMITTED',
		taskId: TASK,
		transitionId: options.transitionId ?? `coder:${CALL}`,
		actor: 'parent-1',
		processId: 42,
		runtimeId: 'runtime-1',
		expectedGeneration: 3,
		context: {
			declaredFiles: ['doc/report.md'],
			baseline: {
				directory: '/repo',
				gitHead: 'base',
				dirtyHash: 'clean',
				changedFiles: [],
				prHeadSha: null,
				scope: TASK,
			},
		},
		recordedAt: new Date(NOW).toISOString(),
		accepted: options.accepted ?? true,
	};
	fs.mkdirSync(path.join(dir, '.swarm', 'coder-settlements'), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(dir, '.swarm', 'coder-settlements', `${TASK}.json`),
		JSON.stringify(wal),
	);
}

/**
 * Build the wild-wedge shape: a bound task-keyed reservation whose exact
 * owner record is a coder child that NEVER terminalized (status `pending`,
 * no terminalResult, no settlement) — the delegation-store view the sweep
 * and admission reconciliation see.
 */
async function seedWedgedPendingLaunch(dir: string): Promise<string> {
	const claim = await reserveBackgroundCoderSlot(dir, {
		parentSessionId: 'parent-1',
		planTaskId: TASK,
		callID: CALL,
		maxConcurrent: 1,
		now: NOW,
	});
	if (!claim.ok) throw new Error('test setup failed to reserve');
	const bound = await bindBackgroundCoderReservation(dir, {
		reservationId: claim.reservation.reservationId,
		parentSessionId: 'parent-1',
		planTaskId: TASK,
		callID: CALL,
		correlationId: 'child-1',
		now: NOW,
	});
	if (!bound) throw new Error('test setup failed to bind');
	await recordPendingDelegation(
		dir,
		pendingInput({ coderReservationId: claim.reservation.reservationId }),
	);
	return claim.reservation.reservationId;
}

function reservationIds(dir: string): string[] {
	const scan = scanBackgroundCoderReservationsForAdmission(dir);
	return scan.status === 'ok'
		? scan.reservations.map((reservation) => reservation.reservationId)
		: [];
}

describe('workflow-settlement release proof for background coder reservations', () => {
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

	it('maintenance releases a wedged pending launch on workflow proof, not age', async () => {
		const reservationId = await seedWedgedPendingLaunch(dir);
		seedSettlementWal(dir);

		// Lease is still live (15 min default, 1 min elapsed): the pre-fix
		// sweep would have renewed here ("exact owner record still active").
		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 60_000,
		});
		expect(result.status).toBe('ok');
		expect(result.renewed).toEqual([]);
		expect(result.released).toEqual([
			{ reservationId, generation: 1, reason: 'workflow-settlement-committed' },
		]);
		expect(reservationIds(dir)).toEqual([]);
	});

	it('the same task can be re-dispatched once its launch is workflow-settled', async () => {
		await seedWedgedPendingLaunch(dir);
		seedSettlementWal(dir);

		// The wild wedge: this exact redispatch was refused as duplicate_task
		// because the task-keyed reservation id matched the stale reservation.
		const result = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: TASK,
			callID: 'call-retry',
			maxConcurrent: 1,
			now: NOW + 60_000,
		});
		expect(result).toMatchObject({ ok: true, activeCount: 1 });
		// The wedged reservation was reconciled away at admission; only the
		// new dispatch's reservation survives.
		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations).toHaveLength(1);
			expect(scan.reservations[0]?.callID).toBe('call-retry');
		}
	});

	it('a non-terminal WAL proves nothing: the pending owner still renews', async () => {
		const reservationId = await seedWedgedPendingLaunch(dir);
		seedSettlementWal(dir, { state: 'DISPATCHED' });

		// Lease expired (16 min > 15 min) but the child looks alive to the
		// store: the old behavior — renewal, never release — is unchanged.
		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 16 * 60_000,
		});
		expect(result.status).toBe('ok');
		expect(result.released).toEqual([]);
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);
		expect(reservationIds(dir)).toEqual([reservationId]);
	});

	it('a COMMITTED but unaccepted settlement does not release', async () => {
		const reservationId = await seedWedgedPendingLaunch(dir);
		seedSettlementWal(dir, { accepted: false });

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 16 * 60_000,
		});
		expect(result.released).toEqual([]);
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);
	});

	it('a settlement for a different dispatch of the task does not release', async () => {
		const reservationId = await seedWedgedPendingLaunch(dir);
		// A NEWER launch's WAL (fresh call id) overwrote the task file: the
		// wedged reservation's own launch has no proof — fail-closed.
		seedSettlementWal(dir, { transitionId: 'coder:call-newer' });

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 16 * 60_000,
		});
		expect(result.released).toEqual([]);
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);
	});

	it('a call-keyed reservation (no task) is never proven by a settlement WAL', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: null,
			callID: CALL,
			maxConcurrent: 1,
			now: NOW,
		});
		if (!claim.ok) throw new Error('test setup failed to reserve');
		const bound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent-1',
			planTaskId: null,
			callID: CALL,
			correlationId: 'child-1',
			now: NOW,
		});
		if (!bound) throw new Error('test setup failed to bind');
		await recordPendingDelegation(
			dir,
			pendingInput({
				planTaskId: null,
				evidenceTaskId: null,
				coderReservationId: claim.reservation.reservationId,
			}),
		);
		seedSettlementWal(dir);

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 16 * 60_000,
		});
		expect(result.released).toEqual([]);
		// The pending owner still looks alive to the store (observer gap):
		// renewal, never a WAL-based release — the reservation has no task
		// identity, so no settlement WAL can ever prove it idle.
		expect(result.renewed).toEqual([
			{ reservationId: claim.reservation.reservationId, generation: 1 },
		]);
	});

	it('admission still refuses duplicate_task when the WAL does not prove release', async () => {
		await seedWedgedPendingLaunch(dir);
		seedSettlementWal(dir, { state: 'DISPATCHED' });

		const result = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent-1',
			planTaskId: TASK,
			callID: 'call-retry',
			maxConcurrent: 1,
			now: NOW + 60_000,
		});
		expect(result).toMatchObject({ ok: false, reason: 'duplicate_task' });
	});
});

describe('isCommittedAcceptedSettlementForLaunch (WAL predicate)', () => {
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

	it('is true for a COMMITTED accepted WAL with the exact transition id', async () => {
		seedSettlementWal(dir);
		expect(
			await isCommittedAcceptedSettlementForLaunch(dir, TASK, `coder:${CALL}`),
		).toBe(true);
	});

	it('is false for a missing WAL', async () => {
		expect(
			await isCommittedAcceptedSettlementForLaunch(dir, TASK, `coder:${CALL}`),
		).toBe(false);
	});

	it('is false for a corrupt WAL', async () => {
		fs.mkdirSync(path.join(dir, '.swarm', 'coder-settlements'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, '.swarm', 'coder-settlements', `${TASK}.json`),
			'{not json',
		);
		expect(
			await isCommittedAcceptedSettlementForLaunch(dir, TASK, `coder:${CALL}`),
		).toBe(false);
	});

	it('is false for a transition-id mismatch', async () => {
		seedSettlementWal(dir);
		expect(
			await isCommittedAcceptedSettlementForLaunch(dir, TASK, 'coder:other'),
		).toBe(false);
		expect(
			await isCommittedAcceptedSettlementForLaunch(dir, '9.9', `coder:${CALL}`),
		).toBe(false);
	});

	it('is false for empty identity inputs', async () => {
		seedSettlementWal(dir);
		expect(await isCommittedAcceptedSettlementForLaunch(dir, '', 'x')).toBe(
			false,
		);
		expect(await isCommittedAcceptedSettlementForLaunch(dir, TASK, '')).toBe(
			false,
		);
	});
});
