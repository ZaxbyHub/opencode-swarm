/**
 * Issue #2034 — delegation-health artifact: round-trip, merge semantics,
 * uncertainty persistence (#1659: visible after the incident), and fold-free
 * collection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_healthInternals,
	BACKGROUND_DELEGATIONS_HEALTH_FILE,
	collectDelegationLedgerHealth,
	readDelegationHealthArtifact,
	recordDelegationRecoveryObservation,
	writeDelegationHealthArtifact,
} from '../../../src/background/delegation-health';
import {
	compactBackgroundDelegations,
	DELEGATION_COMPACTION_HIGH_WATER_BYTES,
	DELEGATION_COMPACTION_LOW_WATER_BYTES,
	MAX_RECOVERY_LEDGER_BYTES,
	type RecordPendingInput,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-health-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

const COLLECT_OPTIONS = {
	ledgerLimitBytes: MAX_RECOVERY_LEDGER_BYTES,
	lowWaterBytes: DELEGATION_COMPACTION_LOW_WATER_BYTES,
	highWaterBytes: DELEGATION_COMPACTION_HIGH_WATER_BYTES,
};

function pendingInput(correlationId: string): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_parent',
		callID: `call_${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
	};
}

describe('issue #2034 delegation-health artifact', () => {
	it('returns null for a clean repo (no ledger, no artifact)', () => {
		expect(collectDelegationLedgerHealth(dir, COLLECT_OPTIONS)).toBeNull();
	});

	it('round-trips sections; undefined merges preserve, null clears', () => {
		writeDelegationHealthArtifact(dir, {
			counts: {
				activeOwners: 1,
				pendingAdvisories: 2,
				lateTerminals: 3,
				orphanWorktreeOwners: 4,
			},
		});
		let artifact = readDelegationHealthArtifact(dir);
		expect(artifact?.counts.lateTerminals).toBe(3);

		// A counts-free merge preserves the existing counts.
		writeDelegationHealthArtifact(dir, {
			recovery: { source: 'legacy-ledger', at: 1, ok: true },
		});
		artifact = readDelegationHealthArtifact(dir);
		expect(artifact?.counts.lateTerminals).toBe(3);
		expect(artifact?.recovery?.ok).toBe(true);

		// An explicit null clears the section.
		writeDelegationHealthArtifact(dir, { recovery: null });
		artifact = readDelegationHealthArtifact(dir);
		expect(artifact?.recovery).toBeNull();
		expect(artifact?.counts.lateTerminals).toBe(3);
	});

	it('a failing recovery observation becomes the durable lastUncertainty', () => {
		recordDelegationRecoveryObservation(dir, {
			source: 'legacy-ledger',
			ok: false,
			reason:
				'background delegation ledger exceeds the 4194304-byte recovery bound',
			repairHint: 'the documented hint',
		});
		const artifact = readDelegationHealthArtifact(dir);
		expect(artifact?.recovery?.ok).toBe(false);
		expect(artifact?.recovery?.reason).toContain('4194304');
		expect(artifact?.lastUncertainty?.reason).toContain('4194304');
		expect(artifact?.lastUncertainty?.repairHint).toBe('the documented hint');

		// A later successful observation updates recovery but must NOT erase the
		// durable uncertainty (#1659: visible after the incident).
		recordDelegationRecoveryObservation(dir, {
			source: 'checkpoint+tail',
			ok: true,
		});
		const after = readDelegationHealthArtifact(dir);
		expect(after?.recovery?.ok).toBe(true);
		expect(after?.lastUncertainty).not.toBeNull();
	});

	it('collect is fold-free and reflects checkpoint + live ledger stats', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');

		const health = collectDelegationLedgerHealth(dir, COLLECT_OPTIONS);
		expect(health).not.toBeNull();
		expect(health!.checkpoint?.sequence).toBe(1);
		expect(health!.checkpoint?.liveRecords).toBe(1);
		expect(health!.ledger.band).toBe('ok');
		expect(health!.ledger.limitBytes).toBe(MAX_RECOVERY_LEDGER_BYTES);

		// Live byte honesty: write bytes into the tail and recollect.
		fs.appendFileSync(
			path.join(dir, '.swarm', 'background-delegations.jsonl'),
			`${'x'.repeat(DELEGATION_COMPACTION_LOW_WATER_BYTES + 1)}\n`,
		);
		const refreshed = collectDelegationLedgerHealth(dir, COLLECT_OPTIONS);
		expect(refreshed!.ledger.bytes).toBeGreaterThan(
			DELEGATION_COMPACTION_LOW_WATER_BYTES,
		);
		expect(refreshed!.ledger.band).not.toBe('ok');
	});

	it('malformed artifact reads as null (readers fail open)', () => {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'background-delegations.jsonl'),
			'',
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_HEALTH_FILE),
			'{not json',
		);
		expect(readDelegationHealthArtifact(dir)).toBeNull();
		// A present ledger still yields stat-based health despite the bad artifact.
		const collected = collectDelegationLedgerHealth(dir, COLLECT_OPTIONS);
		expect(collected).not.toBeNull();
		expect(collected!.checkpoint).toBeNull();
	});

	it('artifact writes survive a transient EPERM on the rename (retry loop)', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const realOnce = _healthInternals.renameOnce;
		let fsCalls = 0;
		_healthInternals.renameOnce = (from: string, to: string) => {
			fsCalls += 1;
			if (fsCalls === 1) {
				throw Object.assign(new Error('transient AV lock'), {
					code: 'EPERM',
				});
			}
			return realOnce(from, to);
		};
		try {
			const written = writeDelegationHealthArtifact(dir, {
				counts: {
					activeOwners: 0,
					pendingAdvisories: 0,
					lateTerminals: 7,
					orphanWorktreeOwners: 0,
				},
			});
			expect(written).not.toBeNull();
			expect(fsCalls).toBeGreaterThanOrEqual(2);
			expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals).toBe(7);
		} finally {
			_healthInternals.renameOnce = realOnce;
		}
	});
});
