import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replayFromLedger } from '../../../src/plan/ledger';
import {
	_internals,
	reconcileSpecDrift,
} from '../../../src/services/spec-drift-recovery';
import {
	countSpecRecoverySnapshots,
	createSpecRecoveryWorkspace,
	readJson,
	seedSpecRecoveryPlan,
	specHash,
	writeSpecMarker,
} from './spec-drift-recovery-fixtures';

type Wal = {
	state: 'PREPARED' | 'COMMITTED';
	transitionId: string;
};

type Marker = {
	planTitle: string;
	phase: number;
	specHash_plan: string | null;
	specHash_current: string | null;
	reason: string;
	timestamp: string;
};

describe('spec drift recovery WAL v2 commit and locking', () => {
	let directory: string;
	const realAppendEvent = _internals.appendEvent;
	const realTryAcquireLock = _internals.tryAcquireLock;
	const realUnlinkIfExists = _internals.unlinkIfExists;

	beforeEach(async () => {
		directory = await createSpecRecoveryWorkspace('spec-wal-commit-');
	});

	afterEach(async () => {
		_internals.appendEvent = realAppendEvent;
		_internals.tryAcquireLock = realTryAcquireLock;
		_internals.unlinkIfExists = realUnlinkIfExists;
		await rm(directory, { recursive: true, force: true });
	});

	async function seedExistingToSpec(specContent: string): Promise<string> {
		const newHash = specHash(specContent);
		await seedSpecRecoveryPlan(directory, 'old-plan-hash');
		await writeFile(join(directory, '.swarm', 'spec.md'), specContent, 'utf8');
		await writeSpecMarker(directory, {
			planHash: 'old-plan-hash',
			currentHash: newHash,
		});
		return newHash;
	}

	test('COMMITTED cleanup retry does not append a duplicate recovery snapshot', async () => {
		await seedExistingToSpec('# Spec A\n\nCommit cleanup content.\n');
		// Only marker cleanup is failed. Snapshot verification uses a non-null spec
		// and therefore does not exercise unlinkIfExists in this test.
		_internals.unlinkIfExists = async (filePath) => {
			if (filePath.endsWith('spec-staleness.json')) {
				throw new Error('leave committed cleanup pending');
			}
			return realUnlinkIfExists(filePath);
		};

		const first = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(first.status).toBe('cleanup_pending');
		expect(first.transitionId).toEqual(expect.any(String));
		const wal = await readJson<Wal>(
			join(directory, '.swarm', 'spec-drift-recovery.json'),
		);
		expect(wal.state).toBe('COMMITTED');
		expect(await countSpecRecoverySnapshots(directory, wal.transitionId)).toBe(
			1,
		);

		_internals.unlinkIfExists = realUnlinkIfExists;
		const retry = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(retry.status).toBe('applied');
		expect(await countSpecRecoverySnapshots(directory, wal.transitionId)).toBe(
			1,
		);
		expect(existsSync(join(directory, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('missing spec capture followed by a concurrent new spec writes a valid blocking marker', async () => {
		await seedSpecRecoveryPlan(directory, 'old-plan-hash');
		await writeSpecMarker(directory, {
			planHash: 'old-plan-hash',
			currentHash: null,
		});
		const specB = '# Spec B\n\nCreated while null recovery commits.\n';
		// appendEvent stays real and fully verifies audit durability. The injected
		// write models the concurrent spec appearing after COMMITTED inputs were
		// captured but before the final latest-spec comparison.
		_internals.appendEvent = async (...args) => {
			await realAppendEvent(...args);
			await writeFile(join(directory, '.swarm', 'spec.md'), specB, 'utf8');
		};

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(result.status).toBe('cleanup_pending');
		const plan = await readJson<{ specHash?: string }>(
			join(directory, '.swarm', 'plan.json'),
		);
		expect(plan.specHash).toBeUndefined();
		const marker = await readJson<Marker>(
			join(directory, '.swarm', 'spec-staleness.json'),
		);
		expect(marker.planTitle).toBe('Spec WAL Plan');
		expect(marker.phase).toBe(1);
		expect(marker.specHash_plan).toBeNull();
		expect(marker.specHash_current).toBe(specHash(specB));
		expect(marker.reason).toContain('spec changed while drift recovery');
		expect(marker.timestamp).toEqual(expect.any(String));
		expect(existsSync(join(directory, '.swarm', 'spec-snapshot.md'))).toBe(
			false,
		);
	});

	test('plan-lock acquisition throw releases the already-acquired spec lock', async () => {
		await writeSpecMarker(directory, {
			planHash: null,
			currentHash: null,
		});
		let acquisition = 0;
		let releaseCount = 0;
		// Untested branches: unavailable spec lock and unavailable plan lock. They
		// are distinct retry_later paths; this test isolates the thrown plan-lock
		// acquisition after a successful spec-lock acquisition.
		_internals.tryAcquireLock = (async () => {
			acquisition++;
			if (acquisition === 1) {
				return {
					acquired: true,
					lock: {
						_release: async () => {
							releaseCount++;
						},
					},
				};
			}
			throw new Error('simulated plan-lock acquisition throw');
		}) as typeof realTryAcquireLock;

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(result.status).toBe('failed');
		expect(result.message).toContain('simulated plan-lock acquisition throw');
		expect(releaseCount).toBe(1);
	});

	test('ledger replay after repair returns the repaired specHash', async () => {
		const repairedHash = await seedExistingToSpec(
			'# Repaired Spec\n\nLedger replay must preserve this hash.\n',
		);

		const result = await reconcileSpecDrift(directory, {
			mode: 'repair',
			actor: 'user',
		});
		expect(result.status).toBe('applied');
		const replayed = await replayFromLedger(directory);
		expect(replayed?.specHash).toBe(repairedHash);
		expect(
			await readFile(join(directory, '.swarm', 'spec-snapshot.md'), 'utf8'),
		).toContain('Ledger replay must preserve this hash.');
	});
});
