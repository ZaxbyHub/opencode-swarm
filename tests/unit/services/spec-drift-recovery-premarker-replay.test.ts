import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasSpecDriftAuditEvent } from '../../../src/events/core-events';
import { enforceSpecDriftGate } from '../../../src/hooks/guardrails';
import { loadPlan } from '../../../src/plan/manager';
import {
	_internals,
	reconcileSpecDrift,
} from '../../../src/services/spec-drift-recovery';
import {
	buildSpecRecoveryPlan,
	countSpecRecoverySnapshots,
	readJson,
	specHash,
	writeSpecMarker,
} from './spec-drift-recovery-fixtures';
import {
	createMarkerlessRecoveryHarness,
	type Marker,
	type Wal,
} from './spec-drift-recovery-premarker-shared';

describe('spec drift recovery — regression: markerless WAL replay is idempotent (F-001)', () => {
	// F-001 (PR 3920 review C1): the pre-marker path synthesized its drift
	// marker with timestamp=now() folded into markerHash, so a crash-retry
	// with a later clock produced a DIFFERENT synthetic identity for the SAME
	// drift state. The PREPARED WAL replay then treated that changed identity
	// as an on-disk marker replacement (markerReplacedDuringPrepared) and
	// fabricated a blocking .swarm/spec-staleness.json that never existed —
	// returning cleanup_pending and re-wedging the flow the transaction had
	// just repaired. The fix hashes only the stable drift fields and never
	// counts a synthesized identity as an on-disk marker replacement.
	let directory: string;
	let leaveMarkerlessPrepared: (specA: string, clock: string) => Promise<Wal>;
	let realEnsureSnapshotEvent: typeof _internals.ensureSnapshotEvent;
	let dispose: () => Promise<void>;

	beforeEach(async () => {
		const harness = await createMarkerlessRecoveryHarness(
			'spec-wal-premarker-',
		);
		directory = harness.directory;
		leaveMarkerlessPrepared = harness.leaveMarkerlessPrepared;
		realEnsureSnapshotEvent = harness.reals.ensureSnapshotEvent;
		dispose = harness.dispose;
	});

	afterEach(async () => {
		await dispose();
	});

	test('same-content later-clock retry commits without creating a marker', async () => {
		const specA = '# Spec A\n\nCanonical rebound requirements.\n';
		const walA = await leaveMarkerlessPrepared(
			specA,
			'2026-11-24T10:00:00.000Z',
		);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);

		// Crash-retry with a later clock and identical drift state: pre-fix the
		// re-synthesized markerHash changed with the clock and the retry
		// fabricated a blocking marker (cleanup_pending). Post-fix the identity
		// is clock-stable, so the PREPARED WAL replays to the same transition
		// and finishes clean.
		_internals.now = () => '2026-11-24T11:30:00.000Z';
		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('applied');
		expect(result.transitionId).toBe(walA.transitionId);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		// One audited snapshot for the one logical transition — the retry
		// replayed it, it did not create a second one.
		expect(await countSpecRecoverySnapshots(directory, walA.transitionId)).toBe(
			1,
		);
	});

	test('F-001 closeout: late materialization of the same drift is replayed and cleared', async () => {
		const specA = '# Spec A\n\nLate marker for the same captured drift.\n';
		const walA = await leaveMarkerlessPrepared(
			specA,
			'2026-11-24T10:00:00.000Z',
		);
		// A normal plan read materializes the marker for the SAME A→B drift
		// while the WAL is still PREPARED. Its timestamp changes the marker file
		// hash, but the captured plan/spec identities remain the same.
		await loadPlan(directory);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			true,
		);
		_internals.now = () => '2026-11-24T11:30:00.000Z';

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('applied');
		expect(result.transitionId).toBe(walA.transitionId);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
	});

	test('F-001 closeout: a repeated markerless transition rebinds after a committed plan is reverted', async () => {
		const specA =
			'# Spec A\n\nCanonical requirements repeated after a plan rollback.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		_internals.now = () => '2026-11-24T10:00:00.000Z';
		const first = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(first.status).toBe('applied');
		const committed = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(committed.state).toBe('COMMITTED');

		// The plan returns to the same old hash while the committed WAL remains
		// and no marker exists. The synthetic marker identity therefore repeats.
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(buildSpecRecoveryPlan('old-plan-hash')),
			'utf8',
		);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		_internals.now = () => '2026-11-24T11:30:00.000Z';

		const repeated = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(repeated.status).toBe('applied');
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		const replayed = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(replayed.state).toBe('COMMITTED');
		expect(repeated.transitionId).toBe(replayed.transitionId);
		expect(replayed.transitionId).not.toBe(committed.transitionId);
		expect(
			await countSpecRecoverySnapshots(directory, committed.transitionId),
		).toBe(1);
		expect(
			await countSpecRecoverySnapshots(directory, replayed.transitionId),
		).toBe(1);
		expect(
			hasSpecDriftAuditEvent(
				directory,
				'spec_drift_repaired',
				committed.transitionId,
			),
		).toBe(true);
		expect(
			hasSpecDriftAuditEvent(
				directory,
				'spec_drift_repaired',
				replayed.transitionId,
			),
		).toBe(true);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('F-001 closeout: A to B, intervening repair, then A again gets a fresh audit identity', async () => {
		const specA = '# Spec A\n\nFirst canonical requirements.\n';
		const specB = '# Spec B\n\nIntervening canonical requirements.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		_internals.now = () => '2026-11-24T10:00:00.000Z';
		const first = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(first.status).toBe('applied');

		await writeFile(join(directory, '.swarm', 'spec.md'), specB, 'utf8');
		_internals.now = () => '2026-11-24T11:00:00.000Z';
		const intervening = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(intervening.status).toBe('applied');
		expect(intervening.transitionId).not.toBe(first.transitionId);

		// Return to the original drift state after another transaction committed.
		// The deterministic base ID now collides with the first repair's snapshot
		// and audit event, so the new transaction must advance to a fresh ID.
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(buildSpecRecoveryPlan('old-plan-hash')),
			'utf8',
		);
		_internals.now = () => '2026-11-24T12:00:00.000Z';
		const repeated = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(repeated.status).toBe('applied');
		expect(repeated.transitionId).not.toBe(first.transitionId);
		expect(repeated.transitionId).not.toBe(intervening.transitionId);
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		for (const transitionId of [
			first.transitionId,
			intervening.transitionId,
			repeated.transitionId,
		]) {
			expect(transitionId).toBeDefined();
			expect(await countSpecRecoverySnapshots(directory, transitionId!)).toBe(
				1,
			);
			expect(
				hasSpecDriftAuditEvent(directory, 'spec_drift_repaired', transitionId!),
			).toBe(true);
		}
	});

	test('F-001 closeout: crash after plan persistence but before WAL commit replays to completion', async () => {
		// Second crash window (closeout review): the plan rebind (savePlan)
		// persists BEFORE the ledger snapshot, the audit event, and the WAL
		// COMMITTED write. A crash in between leaves plan.json already at the
		// captured hash with the WAL still PREPARED — the matching-hash
		// shortcut then reported no_marker and the incomplete transaction
		// (missing snapshot + audit event, WAL never committed) was stranded
		// forever. The retry must replay the PREPARED recovery instead of
		// shortcutting, while a consistent plan with NO pending WAL stays a
		// genuine no-op.
		const specA = '# Spec A\n\nRebound before the WAL committed.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		_internals.now = () => '2026-11-24T10:00:00.000Z';
		// Crash the transaction right after the plan rebind persisted:
		// savePlan succeeds, then the next leg (ledger snapshot) throws, so
		// snapshot, audit event, and WAL COMMITTED are all still pending.
		_internals.ensureSnapshotEvent = async () => {
			throw new Error('crash after plan persistence');
		};
		const failed = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(failed.status).toBe('failed');
		const wal = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('PREPARED');
		expect(() => enforceSpecDriftGate(directory, 'save_plan')).toThrow(
			/PREPARED spec-drift recovery transaction is incomplete/,
		);
		const crashedPlan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(crashedPlan.specHash).toBe(specHash(specA));
		// Sanity: the crash really left the audit legs incomplete.
		expect(await countSpecRecoverySnapshots(directory, wal.transitionId)).toBe(
			0,
		);
		expect(
			hasSpecDriftAuditEvent(
				directory,
				'spec_drift_repaired',
				wal.transitionId,
			),
		).toBe(false);
		_internals.ensureSnapshotEvent = realEnsureSnapshotEvent;

		// Retry with a later clock and an already-consistent plan: pre-fix
		// (closeout) the matching-hash shortcut returned no_marker here.
		_internals.now = () => '2026-11-24T11:30:00.000Z';
		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('applied');
		expect(result.transitionId).toBe(wal.transitionId);
		const committed = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(committed.state).toBe('COMMITTED');
		expect(committed.transitionId).toBe(wal.transitionId);
		// The stranded audit legs materialized exactly once, and no blocking
		// marker was fabricated.
		expect(await countSpecRecoverySnapshots(directory, wal.transitionId)).toBe(
			1,
		);
		const audit = await readFile(
			join(directory, '.swarm', 'events.jsonl'),
			'utf8',
		);
		expect(audit).toContain('spec_drift_repaired');
		expect(audit).toContain(wal.transitionId);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
	});

	test('actual newer drift stays protected: completed replay writes the refreshed blocking marker', async () => {
		const specA = '# Spec A\n\nCaptured canonical requirements.\n';
		const walA = await leaveMarkerlessPrepared(
			specA,
			'2026-11-24T10:00:00.000Z',
		);
		const specB = '# Spec B\n\nNewer concurrent requirements.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specB, 'utf8');
		_internals.now = () => '2026-11-24T11:30:00.000Z';

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		// The changed synthetic identity must NOT route into the
		// preserved-marker path (no marker exists to preserve); instead the
		// prepared transaction completes and the latest-spec check writes the
		// designed refreshed blocking marker for the newer drift.
		expect(result.status).toBe('cleanup_pending');
		expect(result.transitionId).toBe(walA.transitionId);
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		const marker = await readJson<Marker>(
			join(directory, '.swarm', 'spec-staleness.json'),
		);
		expect(marker.specHash_plan).toBe(specHash(specA));
		expect(marker.specHash_current).toBe(specHash(specB));
		expect(marker.reason).toContain('spec changed while drift recovery');
	});

	test('genuine on-disk replacement markers stay protected after a markerless prepared WAL (control)', async () => {
		// Control for the !markerSynthesized gate: once a REAL marker has
		// materialized on disk, the replacement protection must still fire even
		// though the prepared WAL came from the synthetic (markerless) path.
		const specA = '# Spec A\n\nSynthetic-window requirements.\n';
		const walA = await leaveMarkerlessPrepared(
			specA,
			'2026-11-24T10:00:00.000Z',
		);
		const specB = '# Spec B\n\nReplacement marker requirements.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specB, 'utf8');
		await writeSpecMarker(directory, {
			planHash: 'old-plan-hash',
			currentHash: specHash(specB),
			reason: 'replacement marker must survive',
		});
		_internals.now = () => '2026-11-24T11:30:00.000Z';

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('cleanup_pending');
		expect(result.transitionId).toBe(walA.transitionId);
		const marker = await readJson<Marker>(
			join(directory, '.swarm', 'spec-staleness.json'),
		);
		expect(marker.specHash_plan).toBe(specHash(specA));
		expect(marker.specHash_current).toBe(specHash(specB));
		expect(marker.reason).toContain('replacement marker must survive');
		expect(
			await readFile(join(directory, '.swarm', 'spec-snapshot.md'), 'utf8'),
		).toBe(specA);
	});

	test('fresh identity allocation reads the ledger once and has no fixed lifetime cap', async () => {
		const originalRead = _internals.readLedgerEvents;
		const originalVerify = _internals.verifyEventPresence;
		let reads = 0;
		let auditChecks = 0;
		try {
			_internals.readLedgerEvents = (async () => {
				reads++;
				return Array.from({ length: 300 }, (_, index) => ({
					event_type: 'snapshot',
					payload: { approval: { specDriftTransitionId: `old-${index}` } },
				})) as unknown as Awaited<
					ReturnType<typeof _internals.readLedgerEvents>
				>;
			}) as typeof _internals.readLedgerEvents;
			_internals.verifyEventPresence = async () => auditChecks++ < 300;
			const id = await _internals.buildUnusedTransitionId(
				directory,
				'repair',
				'base-transition',
			);
			expect(id).toEqual(expect.any(String));
			expect(id).not.toBe('base-transition');
			expect(reads).toBe(1);
			expect(auditChecks).toBe(301);
		} finally {
			_internals.readLedgerEvents = originalRead;
			_internals.verifyEventPresence = originalVerify;
		}
	});

	test('a snapshot-only collision skips the colliding candidate without an audit event', async () => {
		const epochBase = createHash('sha256')
			.update('base-transition:ledger:1')
			.digest('hex');
		const originalRead = _internals.readLedgerEvents;
		try {
			_internals.readLedgerEvents = (async () => [
				{
					event_type: 'snapshot',
					payload: { approval: { specDriftTransitionId: epochBase } },
				},
			]) as unknown as typeof _internals.readLedgerEvents;
			const id = await _internals.buildUnusedTransitionId(
				directory,
				'repair',
				'base-transition',
			);
			expect(id).toBe(
				createHash('sha256').update(`${epochBase}:recovery:1`).digest('hex'),
			);
		} finally {
			_internals.readLedgerEvents = originalRead;
		}
	});
});
