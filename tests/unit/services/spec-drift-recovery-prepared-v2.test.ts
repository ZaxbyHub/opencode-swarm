import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
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
	writeSpecMarker,
} from './spec-drift-recovery-fixtures';

type Wal = {
	state: 'PREPARED' | 'COMMITTED';
	newHash: string | null;
	specContent: string | null;
	transitionId: string;
};

type Marker = {
	specHash_plan: string | null;
	specHash_current: string | null;
	reason: string;
};

describe('spec drift recovery WAL v2 PREPARED resume', () => {
	let directory: string;
	const realSavePlan = _internals.savePlan;

	beforeEach(async () => {
		directory = await createSpecRecoveryWorkspace('spec-wal-prepared-');
		await seedSpecRecoveryPlan(directory, 'old-plan-hash');
	});

	afterEach(async () => {
		_internals.savePlan = realSavePlan;
		await rm(directory, { recursive: true, force: true });
	});

	async function leavePrepared(specA: string): Promise<Wal> {
		const hashA = specHash(specA);
		await writeFile(join(directory, '.swarm', 'spec.md'), specA, 'utf8');
		await writeSpecMarker(directory, {
			planHash: 'old-plan-hash',
			currentHash: hashA,
			reason: 'marker A',
		});
		// This narrows only the plan-persistence branch. Snapshot/event/cleanup
		// paths remain untested in this first call and are exercised by the real
		// resumed call below.
		_internals.savePlan = async () => {
			throw new Error('leave WAL prepared');
		};
		const failed = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(failed.status).toBe('failed');
		_internals.savePlan = realSavePlan;
		const wal = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('PREPARED');
		expect(wal.newHash).toBe(hashA);
		expect(wal.specContent).toBe(specA);
		return wal;
	}

	test('resumes captured spec A even when the current spec has become B', async () => {
		const specA = '# Spec A\n\nOriginal captured requirements.\n';
		const specB = '# Spec B\n\nConcurrent newer requirements.\n';
		const walA = await leavePrepared(specA);
		await writeFile(join(directory, '.swarm', 'spec.md'), specB, 'utf8');

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(result.status).toBe('cleanup_pending');
		expect(result.transitionId).toBe(walA.transitionId);

		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBe(specHash(specA));
		expect(
			await readFile(join(directory, '.swarm', 'spec-snapshot.md'), 'utf8'),
		).toBe(specA);
		const marker = await readJson<Marker>(
			join(directory, '.swarm', 'spec-staleness.json'),
		);
		expect(marker.specHash_plan).toBe(specHash(specA));
		expect(marker.specHash_current).toBe(specHash(specB));
		expect(marker.reason).toContain('spec changed while drift recovery');
	});

	test('completes marker A then preserves a concurrently replaced marker B', async () => {
		const specA = '# Spec A\n\nCaptured transaction content.\n';
		const specB = '# Spec B\n\nReplacement marker content.\n';
		const walA = await leavePrepared(specA);
		await writeFile(join(directory, '.swarm', 'spec.md'), specB, 'utf8');
		await writeSpecMarker(directory, {
			planHash: 'old-plan-hash',
			currentHash: specHash(specB),
			reason: 'marker B must survive',
		});

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(result.status).toBe('cleanup_pending');
		expect(result.transitionId).toBe(walA.transitionId);

		const marker = await readJson<Marker>(
			join(directory, '.swarm', 'spec-staleness.json'),
		);
		expect(marker.specHash_plan).toBe(specHash(specA));
		expect(marker.specHash_current).toBe(specHash(specB));
		expect(marker.reason).toContain('marker B must survive');
		expect(
			await readFile(join(directory, '.swarm', 'spec-snapshot.md'), 'utf8'),
		).toBe(specA);
	});
});
