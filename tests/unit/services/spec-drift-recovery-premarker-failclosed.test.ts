import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	_internals,
	reconcileSpecDrift,
} from '../../../src/services/spec-drift-recovery';
import {
	buildSpecRecoveryPlan,
	readJson,
	seedSpecRecoveryPlan,
	specHash,
} from './spec-drift-recovery-fixtures';
import {
	createMarkerlessRecoveryHarness,
	type Wal,
} from './spec-drift-recovery-premarker-shared';

describe('spec drift recovery — regression: fail-closed WAL validation around markerless replay (F-001)', () => {
	// Fail-closed companions of the F-001 markerless-replay regression
	// (PR 3920 review C1; stage B rounds 2-4): the matching-plan and
	// missing-plan shortcuts around the PREPARED WAL replay must never report
	// no_marker while a transaction is pending or its captured state is
	// unreadable, tampered, or unanchorable. Each failure mode ships with a
	// genuine no_marker control so the fail-closed behavior stays scoped to
	// real pending or corrupt state.
	let directory: string;
	let leaveMarkerlessPrepared: (specA: string, clock: string) => Promise<Wal>;
	let dispose: () => Promise<void>;

	beforeEach(async () => {
		const harness = await createMarkerlessRecoveryHarness(
			'spec-wal-premarker-',
		);
		directory = harness.directory;
		leaveMarkerlessPrepared = harness.leaveMarkerlessPrepared;
		dispose = harness.dispose;
	});

	afterEach(async () => {
		await dispose();
	});

	test('F-001 stage B round 2: matching plan + corrupt WAL fails closed instead of no_marker', async () => {
		// parseWal maps a corrupt WAL to null, so the matching-hash shortcut's
		// `existingWal?.state !== 'PREPARED'` gate treated corruption as "no
		// pending transaction" and returned no_marker — hiding an unreadable
		// recovery WAL behind a report of no work. The WAL is now validated
		// BEFORE the shortcut: a present corrupt WAL fails closed, while
		// no-WAL and COMMITTED-WAL consistent plans stay genuine no-ops.
		const specA = '# Spec A\n\nAlready consistent with the plan.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		await seedSpecRecoveryPlan(directory, specHash(specA));
		await writeFile(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
			'{ bad json',
			'utf8',
		);

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('failed');
		expect(result.message).toContain('WAL is corrupt');
		// Fail-closed hygiene: the corrupt WAL and the consistent plan are
		// left untouched and no blocking marker is fabricated.
		expect(
			await readFile(
				join(directory, '.swarm', 'spec-drift-recovery.json'),
				'utf8',
			),
		).toBe('{ bad json');
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('F-001 stage B round 3: matching plan + COMMITTED WAL with tampered specContent fails closed', async () => {
		// parseWal accepts a structurally valid WAL whose captured specContent
		// no longer hashes to its newHash. The round-2 corrupt check only
		// rejected UNPARSEABLE WALs, so a tampered COMMITTED WAL slipped past
		// the matching-hash shortcut's `state !== 'PREPARED'` gate and returned
		// no_marker before the transaction integrity check
		// (sha256(wal.specContent) !== wal.newHash) ever ran — hiding captured
		// state corruption behind a report of no work. Captured-content
		// integrity is now validated before any markerless shortcut, for
		// PREPARED and COMMITTED WALs alike.
		const specA = '# Spec A\n\nConsistent plan content.\n';
		const tamperedWal = `${JSON.stringify(
			{
				version: 2,
				mode: 'repair',
				state: 'COMMITTED',
				transitionId: 'stage-b-round3-tampered',
				markerHash: 'deadbeef',
				planTitle: 'Spec WAL Plan',
				phase: 1,
				previousHash: 'old-plan-hash',
				newHash: specHash(specA), // matches the real spec hash...
				specContent: '# Spec A\n\nTAMPERED captured content.\n', // ...but the captured content does not hash to it
				actor: 'spec_write',
				recordedAt: '2026-11-24T10:00:00.000Z',
			},
			null,
			2,
		)}\n`;
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		await seedSpecRecoveryPlan(directory, specHash(specA));
		await writeFile(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
			tamperedWal,
			'utf8',
		);

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('failed');
		expect(result.message).toContain('inconsistent captured spec content');
		// Fail-closed hygiene: the tampered WAL and the consistent plan are
		// left untouched and no blocking marker is fabricated.
		const wal = await readJson<{ state?: string; specContent?: string }>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('COMMITTED');
		expect(wal.specContent).toBe('# Spec A\n\nTAMPERED captured content.\n');
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('matching plan + COMMITTED WAL stays a genuine no_marker no-op (stage B round 2 control)', async () => {
		// Control for the corrupt-WAL validation: a parseable COMMITTED WAL
		// next to an already-consistent plan must NOT be promoted to a failure
		// — the shortcut keeps treating completed transactions as no work.
		const specA = '# Spec A\n\nConsistent with a finished transaction.\n';
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		await seedSpecRecoveryPlan(directory, specHash(specA));
		const committedWal = `${JSON.stringify(
			{
				version: 2,
				mode: 'repair',
				state: 'COMMITTED',
				transitionId: 'stage-b-committed-control',
				markerHash: 'deadbeef',
				planTitle: 'Spec WAL Plan',
				phase: 1,
				previousHash: 'old-plan-hash',
				newHash: specHash(specA),
				specContent: specA,
				actor: 'spec_write',
				recordedAt: '2026-11-24T10:00:00.000Z',
			},
			null,
			2,
		)}\n`;
		await writeFile(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
			committedWal,
			'utf8',
		);

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('no_marker');
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		expect(
			await readFile(
				join(directory, '.swarm', 'spec-drift-recovery.json'),
				'utf8',
			),
		).toBe(committedWal);
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
	});

	test('F-001 stage B round 4: PREPARED WAL + missing plan fails closed instead of no_marker', async () => {
		// The !planNow shortcut returned no_marker even when a PREPARED
		// recovery WAL was pending, bypassing the unfinished transaction and
		// the replay's fail-closed plan checks — a lost plan.json after the
		// transaction was prepared was reported as "No spec drift detected."
		// A pending PREPARED WAL now fails closed with the pending transition
		// context; only a run with NO prepared WAL stays a genuine no-op.
		const specA = '# Spec A\n\nPrepared before the plan was lost.\n';
		const walA = await leaveMarkerlessPrepared(
			specA,
			'2026-11-24T10:00:00.000Z',
		);
		await rm(join(directory, '.swarm', 'plan.json'));

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('failed');
		expect(result.message).toContain('prepared recovery WAL is pending');
		expect(result.message).toContain('missing or unreadable');
		expect(result.transitionId).toBe(walA.transitionId);
		// Fail-closed hygiene: the pending WAL is preserved for recovery and
		// no blocking marker is fabricated.
		const wal = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('PREPARED');
		expect(existsSync(join(directory, '.swarm', 'plan.json'))).toBe(false);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('F-001 stage B round 4: PREPARED WAL + plan without specHash fails closed instead of no_marker', async () => {
		// A plan downgraded to no stored specHash after the transaction was
		// prepared must not read as "no work" either — the replay can neither
		// rebind nor validate it, so the pending PREPARED WAL fails closed.
		const specA = '# Spec A\n\nPrepared before the plan was downgraded.\n';
		const walA = await leaveMarkerlessPrepared(
			specA,
			'2026-11-24T10:00:00.000Z',
		);
		const plan = await readJson<Record<string, unknown>>(
			join(directory, '.swarm', 'plan.json'),
		);
		delete plan.specHash;
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf8',
		);

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});

		expect(result.status).toBe('failed');
		expect(result.message).toContain('prepared recovery WAL is pending');
		expect(result.message).toContain('no stored specHash');
		expect(result.transitionId).toBe(walA.transitionId);
		const wal = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('PREPARED');
		const downgradedPlan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(downgradedPlan.specHash).toBeUndefined();
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('canonical unreadable spec fails closed before missing-plan and hashless-plan shortcuts', async () => {
		const original = _internals.readEffectiveSpecSync;
		try {
			_internals.readEffectiveSpecSync = () => null;
			await rm(join(directory, '.swarm', 'plan.json'));
			const missingPlan = await reconcileSpecDrift(directory, {
				mode: 'repair',
				actor: 'spec_write',
				reconcilePlanHashWithoutMarker: true,
			});
			expect(missingPlan.status).toBe('failed');
			expect(missingPlan.message).toContain('canonical spec is missing');

			await writeFile(
				join(directory, '.swarm', 'plan.json'),
				JSON.stringify(buildSpecRecoveryPlan(null), null, 2),
				'utf8',
			);
			const hashless = await reconcileSpecDrift(directory, {
				mode: 'repair',
				actor: 'spec_write',
				reconcilePlanHashWithoutMarker: true,
			});
			expect(hashless.status).toBe('failed');
			expect(hashless.message).toContain('canonical spec is missing');
		} finally {
			_internals.readEffectiveSpecSync = original;
		}
	});

	test('valid no-WAL controls stay no_marker: missing plan and hashless plan (stage B round 4 control)', async () => {
		// The round-4 fail-closed change must only bite when a PREPARED WAL is
		// actually pending. With no recovery WAL, a missing plan and a
		// pre-feature plan without a stored specHash keep the genuine no_marker
		// behavior (the hashless case is also pinned in the tools suite).
		await writeFile(join(directory, '.swarm', 'spec.md'), '# Readable Spec\n');
		await rm(join(directory, '.swarm', 'plan.json'));
		const missingPlan = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(missingPlan.status).toBe('no_marker');

		const hashless = buildSpecRecoveryPlan(null);
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(hashless, null, 2),
			'utf8',
		);
		const hashlessResult = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(hashlessResult.status).toBe('no_marker');
		expect(
			existsSync(join(directory, '.swarm', 'spec-drift-recovery.json')),
		).toBe(false);
	});
});
