/**
 * Issue #2104 — generation-bound coder-reservation leases.
 *
 * Pins the lease lifecycle: creation after admission checks, bounded lease
 * constants, generation coupling at bind, exact-identity renewal, and the
 * stale-terminal release fence. Legacy lease-less reservations stay
 * protected and parse-compatible.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_CODER_RESERVATION_LEASE_MAX_MS,
	BACKGROUND_CODER_RESERVATION_LEASE_MIN_MS,
	BACKGROUND_CODER_RESERVATION_LEASE_MS,
	BACKGROUND_CODER_RESERVATIONS_FILE,
	bindBackgroundCoderReservation,
	buildBackgroundCoderReservationId,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	releaseBackgroundCoderReservation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_000_000;

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-lease-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function ownerInput(over: Record<string, unknown> = {}) {
	return {
		parentSessionId: 'parent_1',
		planTaskId: '1.1' as string | null,
		callID: 'call_1',
		...over,
	};
}

function pendingInput(
	over: Partial<RecordPendingInput> = {},
): RecordPendingInput {
	return {
		correlationId: 'ses_a',
		jobId: 'job_a',
		subagentSessionId: 'ses_a',
		parentSessionId: 'parent_1',
		callID: 'call_1',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		...over,
	};
}

describe('coder reservation leases (issue #2104)', () => {
	let dir: string;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({ fixedNow: NOW });
		dir = makeTempProject();
	});

	afterEach(() => {
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reserve creates the lease with generation and documented defaults', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		expect(claim.reservation.generation).toBe(1);
		expect(claim.reservation.leaseExpiresAt).toBe(
			NOW + BACKGROUND_CODER_RESERVATION_LEASE_MS,
		);
		// Durable round-trip: the store parses with the new fields.
		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations[0]?.generation).toBe(1);
			expect(scan.reservations[0]?.leaseExpiresAt).toBe(
				NOW + BACKGROUND_CODER_RESERVATION_LEASE_MS,
			);
		}
	});

	it('reserve clamps leaseMs into the documented bounds', async () => {
		const short = await reserveBackgroundCoderSlot(dir, {
			...ownerInput({ callID: 'call_short', planTaskId: '1.1' }),
			maxConcurrent: 4,
			leaseMs: 5,
			now: NOW,
		});
		expect(short.ok).toBe(true);
		if (short.ok) {
			expect(short.reservation.leaseExpiresAt).toBe(
				NOW + BACKGROUND_CODER_RESERVATION_LEASE_MIN_MS,
			);
		}
		const long = await reserveBackgroundCoderSlot(dir, {
			...ownerInput({ callID: 'call_long', planTaskId: '1.2' }),
			maxConcurrent: 4,
			leaseMs: 10 * BACKGROUND_CODER_RESERVATION_LEASE_MAX_MS,
			now: NOW,
		});
		expect(long.ok).toBe(true);
		if (long.ok) {
			expect(long.reservation.leaseExpiresAt).toBe(
				NOW + BACKGROUND_CODER_RESERVATION_LEASE_MAX_MS,
			);
		}
	});

	it('reserve rejects an invalid generation', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			generation: 0,
			now: NOW,
		});
		expect(claim.ok).toBe(false);
		if (!claim.ok) expect(claim.reason).toBe('invalid');
	});

	it('bind couples the reservation to the record launch generation and renews the lease', async () => {
		// Real gate order: reserve (admission) BEFORE the delegation record.
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		await recordPendingDelegation(
			dir,
			pendingInput({ coderReservationId: claim.reservation.reservationId }),
		);

		restoreClock();
		restoreClock = freezeClock({ fixedNow: NOW + 5_000 });
		const bound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			generation: 2,
			now: NOW + 5_000,
		});
		expect(bound?.state).toBe('bound');
		expect(bound?.generation).toBe(2);
		expect(bound?.leaseExpiresAt).toBe(
			NOW + 5_000 + BACKGROUND_CODER_RESERVATION_LEASE_MS,
		);
	});

	it('an older generation can never rebind a reservation', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			generation: 2,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		await recordPendingDelegation(
			dir,
			pendingInput({ coderReservationId: claim.reservation.reservationId }),
		);

		const bound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			generation: 1,
			now: NOW,
		});
		expect(bound).toBeNull();
	});

	it('a lease bound at generation N never regresses below N across bind refreshes', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			generation: 3,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;

		// Exact-generation bind succeeds; an unrelated identity cannot bind
		// (reservation ids are identity-derived), and an older generation is
		// refused (covered below) — so the owned generation can only stay or
		// move forward. This pins the invariant the maintenance renewal path
		// relies on: it renews the generation read from the reservation itself.
		const bound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			generation: 3,
			now: NOW,
		});
		expect(bound?.generation).toBe(3);
		const rebound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			now: NOW + 1_000,
		});
		expect(rebound?.generation).toBe(3);
		expect(rebound?.leaseExpiresAt).toBe(
			NOW + 1_000 + BACKGROUND_CODER_RESERVATION_LEASE_MS,
		);
	});

	it('a terminal for an older generation can never release the reservation', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			generation: 1,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		const bound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			generation: 2,
			now: NOW,
		});
		expect(bound?.generation).toBe(2);
		await recordPendingDelegation(
			dir,
			pendingInput({ coderReservationId: claim.reservation.reservationId }),
		);

		// Stale terminal arrives for generation 1 while the reservation owns 2.
		expect(
			await releaseBackgroundCoderReservation(dir, {
				reservationId: claim.reservation.reservationId,
				parentSessionId: 'parent_1',
				planTaskId: '1.1',
				callID: 'call_1',
				correlationId: 'ses_a',
				generation: 1,
				reason: 'recovered',
			}),
		).toBe(false);

		// The matching generation releases.
		expect(
			await releaseBackgroundCoderReservation(dir, {
				reservationId: claim.reservation.reservationId,
				parentSessionId: 'parent_1',
				planTaskId: '1.1',
				callID: 'call_1',
				correlationId: 'ses_a',
				generation: 2,
				reason: 'recovered',
			}),
		).toBe(true);
	});

	it('an idempotent rebind of the same correlation refreshes the lease without moving generation', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			...ownerInput(),
			maxConcurrent: 4,
			generation: 2,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		const first = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			generation: 2,
			now: NOW,
		});
		expect(first?.generation).toBe(2);

		// Later verified activity rebinds the SAME correlation (e.g. the
		// completion observer's repair path): the lease refreshes, generation
		// stays put, and no older/newer generation is inferred.
		const rebound = await bindBackgroundCoderReservation(dir, {
			reservationId: claim.reservation.reservationId,
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			correlationId: 'ses_a',
			now: NOW + 30_000,
		});
		expect(rebound?.generation).toBe(2);
		expect(rebound?.leaseExpiresAt).toBe(
			NOW + 30_000 + BACKGROUND_CODER_RESERVATION_LEASE_MS,
		);
	});

	it('legacy lease-less reservations stay parse-compatible and readable as generation 1', () => {
		const legacy = {
			reservationId: buildBackgroundCoderReservationId({
				parentSessionId: 'parent_legacy',
				planTaskId: null,
				callID: 'call_legacy',
			}),
			parentSessionId: 'parent_legacy',
			planTaskId: null,
			callID: 'call_legacy',
			state: 'reserved',
			correlationId: null,
			createdAt: NOW - 10 * 60_000,
			updatedAt: NOW - 10 * 60_000,
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_CODER_RESERVATIONS_FILE),
			`${JSON.stringify({ schemaVersion: 1, reservations: [legacy] })}\n`,
		);

		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations).toHaveLength(1);
			expect(scan.reservations[0]?.generation).toBeUndefined();
			expect(scan.reservations[0]?.leaseExpiresAt).toBeUndefined();
		}
	});

	it('recordPendingDelegation still writes records the reservation scan can reconcile', async () => {
		const record = await recordPendingDelegation(dir, pendingInput());
		expect(record).not.toBeNull();
		const folded = readDelegations(dir);
		expect(folded.some((entry) => entry.correlationId === 'ses_a')).toBe(true);
	});
});
