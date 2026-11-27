import { expect } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	_internals,
	reconcileSpecDrift,
} from '../../../src/services/spec-drift-recovery';
import {
	createSpecRecoveryWorkspace,
	readJson,
	seedSpecRecoveryPlan,
	specHash,
} from './spec-drift-recovery-fixtures';

/** WAL record persisted at `.swarm/spec-drift-recovery.json`. */
export type Wal = {
	state: 'PREPARED' | 'COMMITTED';
	newHash: string | null;
	specContent: string | null;
	transitionId: string;
};

/** Drift marker persisted at `.swarm/spec-staleness.json`. */
export type Marker = {
	specHash_plan: string | null;
	specHash_current: string | null;
	reason: string;
};

export type MarkerlessRecoveryHarness = {
	/** Absolute path of the seeded spec-recovery workspace. */
	directory: string;
	leaveMarkerlessPrepared: (specA: string, clock: string) => Promise<Wal>;
	/** `_internals` values captured before the harness mutated any seam. */
	reals: {
		savePlan: typeof _internals.savePlan;
		now: typeof _internals.now;
		ensureSnapshotEvent: typeof _internals.ensureSnapshotEvent;
	};
	/** Restores the `_internals` seams and removes the workspace. */
	dispose: () => Promise<void>;
};

/**
 * Shared harness for the F-001 markerless-replay regression suites split out
 * of `spec-drift-recovery-prepared-v2.test.ts` (FR-006). The two split files
 * (`spec-drift-recovery-premarker-replay.test.ts` and
 * `spec-drift-recovery-premarker-failclosed.test.ts`) share the seeded
 * workspace scaffold and the spec_write-style markerless choreography below;
 * keeping it here preserves the original assertions verbatim in one place
 * instead of duplicating them across the split files.
 */
export async function createMarkerlessRecoveryHarness(
	prefix: string,
): Promise<MarkerlessRecoveryHarness> {
	const directory = await createSpecRecoveryWorkspace(prefix);
	await seedSpecRecoveryPlan(directory, 'old-plan-hash');
	const reals = {
		savePlan: _internals.savePlan,
		now: _internals.now,
		ensureSnapshotEvent: _internals.ensureSnapshotEvent,
	};

	/**
	 * Drives a canonical spec_write-style markerless reconciliation whose plan
	 * rebind is interrupted right after the PREPARED WAL write, leaving the
	 * crash-retry state: WAL PREPARED, plan.json still at the old hash, and
	 * NO marker on disk (the drift marker only materializes on the next
	 * loadPlan, which never ran).
	 */
	async function leaveMarkerlessPrepared(
		specA: string,
		clock: string,
	): Promise<Wal> {
		const hashA = specHash(specA);
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		_internals.now = () => clock;
		// This narrows only the plan-persistence branch. Snapshot/event/cleanup
		// paths remain untested in this first call and are exercised by the real
		// resumed call below.
		_internals.savePlan = async () => {
			throw new Error('leave WAL prepared');
		};
		const failed = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'spec_write',
			reconcilePlanHashWithoutMarker: true,
		});
		expect(failed.status).toBe('failed');
		_internals.savePlan = reals.savePlan;
		const wal = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('PREPARED');
		expect(wal.newHash).toBe(hashA);
		expect(wal.specContent).toBe(specA);
		return wal;
	}

	async function dispose(): Promise<void> {
		_internals.savePlan = reals.savePlan;
		_internals.now = reals.now;
		_internals.ensureSnapshotEvent = reals.ensureSnapshotEvent;
		await rm(directory, { recursive: true, force: true });
	}

	return { directory, leaveMarkerlessPrepared, reals, dispose };
}
