/**
 * Issue #2104 — shared background maintenance service.
 *
 * Pins: bounded sweeps, lease-expiry reclaim ONLY with corroborated owner
 * evidence, renewal on fresh owner activity, fail-closed retention on
 * ambiguity and uncertain stores, legacy-lease protection, bounded batches,
 * prompt lock-contention return, and the durable operator-facts ring.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDelegationHealthArtifact } from '../../../src/background/delegation-health';
import {
	BACKGROUND_CODER_RESERVATIONS_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	bindBackgroundCoderReservation,
	buildBackgroundCoderReservationId,
	maintainBackgroundDelegations,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import { withEvidenceLock } from '../../../src/evidence/lock';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_000_000;

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-maint-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
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

async function seedBoundReservation(
	dir: string,
	options: {
		correlationId?: string;
		planTaskId?: string | null;
		generation?: number;
	} = {},
): Promise<string | null> {
	const correlationId = options.correlationId ?? 'ses_a';
	const planTaskId =
		options.planTaskId === undefined ? '1.1' : options.planTaskId;
	const claim = await reserveBackgroundCoderSlot(dir, {
		parentSessionId: 'parent_1',
		planTaskId,
		callID: 'call_1',
		maxConcurrent: 4,
		generation: options.generation ?? 1,
		now: NOW,
	});
	if (!claim.ok) return null;
	const bound = await bindBackgroundCoderReservation(dir, {
		reservationId: claim.reservation.reservationId,
		parentSessionId: 'parent_1',
		planTaskId,
		callID: 'call_1',
		correlationId,
		generation: options.generation ?? 1,
		now: NOW,
	});
	return bound?.reservationId ?? null;
}

function reservationIds(dir: string): string[] {
	const scan = scanBackgroundCoderReservationsForAdmission(dir);
	return scan.status === 'ok'
		? scan.reservations.map((reservation) => reservation.reservationId)
		: [];
}

describe('maintainBackgroundDelegations (issue #2104)', () => {
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

	it('returns ok on an empty store and records the run in the health artifact', async () => {
		const result = await maintainBackgroundDelegations(dir, { now: NOW });
		expect(result.status).toBe('ok');
		expect(result.sweptStale).toBe(0);
		expect(result.released).toEqual([]);
		const health = readDelegationHealthArtifact(dir);
		expect(health?.maintenance?.lastRunAt).toBe(NOW);
		expect(health?.maintenance?.lastOkAt).toBe(NOW);
		expect(health?.maintenance?.lastSummary).toEqual({
			sweptStale: 0,
			released: 0,
			renewed: 0,
			retained: 0,
		});
	});

	it('releases a bound reservation whose exact owner record was swept stale', async () => {
		const reservationId = await seedBoundReservation(dir);
		expect(reservationId).not.toBeNull();
		// Owner record with the exact reservation coordinates, aged past the
		// stale timeout so the sweep (corroboration) finalizes it.
		const record = await recordPendingDelegation(
			dir,
			pendingInput({ coderReservationId: reservationId ?? undefined }),
		);
		expect(record).not.toBeNull();

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 45 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.status).toBe('ok');
		expect(result.sweptStale).toBe(1);
		expect(result.released).toEqual([
			{ reservationId, generation: 1, reason: 'owner-swept-stale' },
		]);
		expect(reservationIds(dir)).toEqual([]);
		const health = readDelegationHealthArtifact(dir);
		expect(
			health?.maintenance?.facts.some(
				(fact) =>
					fact.kind === 'release' &&
					fact.reason === 'owner record durably stale',
			),
		).toBe(true);
	});

	it('releases an unbound orphan only after the stale window with no owner anywhere', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent_dead',
			planTaskId: null,
			callID: 'call_dead',
			maxConcurrent: 4,
			now: NOW,
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;

		// Inside the pre-launch stale window (lease expired, record window not):
		// retained fail-closed.
		const early = await maintainBackgroundDelegations(dir, {
			now: NOW + 20 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(early.retained).toHaveLength(1);
		expect(early.retained[0]?.reason).toBe('unbound-within-stale-window');
		expect(reservationIds(dir)).toHaveLength(1);

		// Beyond it, with no durable owner in primary or fallback: reclaimed.
		const late = await maintainBackgroundDelegations(dir, {
			now: NOW + 35 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(late.released).toEqual([
			{
				reservationId: claim.reservation.reservationId,
				generation: 1,
				reason: 'unbound-orphan',
			},
		]);
		expect(reservationIds(dir)).toEqual([]);
	});

	it('renews the lease when the exact owner record is still active', async () => {
		const reservationId = await seedBoundReservation(dir);
		expect(reservationId).not.toBeNull();
		await recordPendingDelegation(
			dir,
			pendingInput({ coderReservationId: reservationId ?? undefined }),
		);
		// Refresh the record so it reads as fresh activity at maintenance time.
		const records = readDelegations(dir);
		const fresh = records.find((entry) => entry.correlationId === 'ses_a');
		expect(fresh).toBeDefined();

		const maintenanceNow = NOW + 20 * 60_000; // lease (15 min) expired, record < 30 min stale
		const result = await maintainBackgroundDelegations(dir, {
			now: maintenanceNow,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.status).toBe('ok');
		expect(result.released).toEqual([]);
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);
		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations[0]?.leaseExpiresAt).toBeGreaterThan(
				maintenanceNow,
			);
		}
	});

	it('retains a reservation whose correlation lives under a different owner identity', async () => {
		const reservationId = await seedBoundReservation(dir);
		expect(reservationId).not.toBeNull();
		// Same correlation, different parent session: an ownership ambiguity.
		await recordPendingDelegation(
			dir,
			pendingInput({
				parentSessionId: 'parent_other',
				subagentSessionId: 'ses_a',
				coderReservationId: undefined,
			}),
		);

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 45 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.released).toEqual([]);
		expect(
			result.retained.some(
				(entry) => entry.reason === 'owner-identity-mismatch',
			),
		).toBe(true);
		expect(reservationIds(dir)).toHaveLength(1);
	});

	it('never releases a legacy lease-less reservation by age', async () => {
		const legacy = {
			parentSessionId: 'parent_legacy',
			planTaskId: null,
			callID: 'call_legacy',
			state: 'reserved',
			correlationId: null,
			createdAt: NOW - 5_000,
			updatedAt: NOW - 5_000,
		};
		const legacyId = buildBackgroundCoderReservationId({
			parentSessionId: legacy.parentSessionId,
			planTaskId: null,
			callID: legacy.callID,
		});
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_CODER_RESERVATIONS_FILE),
			`${JSON.stringify({
				schemaVersion: 1,
				reservations: [{ ...legacy, reservationId: legacyId }],
			})}\n`,
		);

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 10 * 24 * 60 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.released).toEqual([]);
		expect(result.retained).toEqual([
			{ reservationId: legacyId, reason: 'protected-legacy-no-lease' },
		]);
		expect(reservationIds(dir)).toEqual([legacyId]);
	});

	it('bounds one invocation to maxRecords swept records', async () => {
		const tenMinAgo = NOW - 45 * 60_000;
		for (const correlation of ['ses_a', 'ses_b']) {
			fs.appendFileSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
				`${JSON.stringify({
					...pendingInput({
						correlationId: correlation,
						subagentSessionId: correlation,
					}),
					schemaVersion: 1,
					status: 'pending',
					createdAt: tenMinAgo,
					updatedAt: tenMinAgo,
				})}\n`,
			);
		}

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW,
			staleTimeoutMs: 30 * 60_000,
			maxRecords: 1,
		});
		expect(result.sweptStale).toBe(1);
		// The remaining candidate stays for the next run.
		const statuses = readDelegations(dir).map((entry) => entry.status);
		expect(statuses.filter((status) => status === 'stale')).toHaveLength(1);
		expect(statuses.filter((status) => status === 'pending')).toHaveLength(1);
	});

	it('returns promptly with contention when the delegations store lock is held', async () => {
		restoreClock();
		let releaseLock: (() => void) | null = null;
		const held = withEvidenceLock(
			dir,
			BACKGROUND_DELEGATIONS_FILE,
			'background',
			'background-delegations',
			() =>
				new Promise<void>((resolve) => {
					releaseLock = resolve;
				}),
		);
		try {
			const startedAt = Date.now();
			const result = await maintainBackgroundDelegations(dir, {
				now: NOW,
				lockTimeoutMs: 300,
			});
			const elapsed = Date.now() - startedAt;
			expect(result.status).toBe('contention');
			expect(elapsed).toBeLessThan(5_000);
			const health = readDelegationHealthArtifact(dir);
			expect(health?.maintenance?.lastContentionAt).toBe(NOW);
		} finally {
			releaseLock?.();
			await held;
		}
	});

	it('two contending maintainers cannot both release: the second reports contention', async () => {
		restoreClock();
		const reservationId = await seedBoundReservation(dir);
		expect(reservationId).not.toBeNull();
		let releaseLock: (() => void) | null = null;
		// Hold the RESERVATION lock: phase A (sweep) succeeds, phase B contends.
		const held = withEvidenceLock(
			dir,
			BACKGROUND_CODER_RESERVATIONS_FILE,
			'background',
			'background-coder-reservations',
			() =>
				new Promise<void>((resolve) => {
					releaseLock = resolve;
				}),
		);
		try {
			const result = await maintainBackgroundDelegations(dir, {
				now: NOW + 45 * 60_000,
				staleTimeoutMs: 30 * 60_000,
				lockTimeoutMs: 300,
			});
			expect(result.status).toBe('contention');
			expect(result.released).toEqual([]);
		} finally {
			releaseLock?.();
			await held;
		}
		// The reservation was never touched by the contended run.
		expect(reservationIds(dir)).toHaveLength(1);
	});

	it('fails closed and retains everything when the owner evidence is uncertain', async () => {
		const reservationId = await seedBoundReservation(dir);
		expect(reservationId).not.toBeNull();
		// Corrupt the primary ledger: the strict recovery scan goes uncertain
		// and maintenance must retain every reservation fail-closed.
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			'not-json\n',
		);

		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 45 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.status).toBe('failure');
		expect(result.released).toEqual([]);
		expect(reservationIds(dir)).toHaveLength(1);
		const health = readDelegationHealthArtifact(dir);
		expect(
			health?.maintenance?.facts.some(
				(fact) => fact.kind === 'maintenance-failure',
			),
		).toBe(true);
		expect(health?.maintenance?.lastFailure).not.toBeNull();
	});

	it('the durable store round-trips the active generation for a later reader', async () => {
		const reservationId = await seedBoundReservation(dir, { generation: 7 });
		expect(reservationId).not.toBeNull();
		// A later maintenance/status reader re-scans the same plain-JSON store
		// this process wrote — functionally the same read path a fresh process
		// after restart would take (the file is process-independent state).
		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.reservations[0]?.generation).toBe(7);
			expect(scan.reservations[0]?.reservationId).toBe(reservationId);
		}
	});
});
