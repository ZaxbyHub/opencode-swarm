/**
 * Issue #2034 — concurrency and Windows-rename resilience: concurrent writers
 * + compaction under the store lock lose no appends; a one-shot EPERM during
 * the durable rename is retried; lock-timeout compaction is fail-open (the
 * write that triggered it has already landed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_checkpointInternals,
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	compactBackgroundDelegations,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-conc-');
afterEach(() => {
	closeAllProjectDbs();
	cleanup();
});
// Restore the production seam members (NOT replace the retry wrapper itself —
// replacing it would bypass the very retry loop these tests exercise).
const originalRenameOnce = _checkpointInternals.renameOnce;
const originalSyncSleep = _checkpointInternals.syncSleep;
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_checkpointInternals.renameOnce = originalRenameOnce;
	_checkpointInternals.syncSleep = originalSyncSleep;
});

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

describe('issue #2034 concurrency + Windows replace', () => {
	it('concurrent writers and an explicit compaction lose no appends', async () => {
		const writers = Array.from({ length: 6 }, (_, group) =>
			(async () => {
				for (let i = 0; i < 5; i += 1) {
					await recordPendingDelegation(dir, pendingInput(`w${group}-${i}`));
				}
			})(),
		);
		const compactor = (async () => {
			for (let i = 0; i < 3; i += 1) {
				await compactBackgroundDelegations(dir, { force: true });
			}
		})();
		await Promise.all([...writers, compactor]);

		const records = readDelegations(dir);
		expect(records).toHaveLength(30);
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners).toHaveLength(30);
		}
	});

	it('a one-shot EPERM that escapes the retry seam surfaces as an uncertain (bounded) compaction', async () => {
		await recordPendingDelegation(dir, pendingInput('eperm-1'));
		let epsonce = false;
		const realRename = _checkpointInternals.renameWithRetry;
		_checkpointInternals.renameWithRetry = (from: string, to: string) => {
			if (!epsonce && to.endsWith(BACKGROUND_DELEGATIONS_FILE)) {
				epsonce = true;
				throw Object.assign(new Error('simulated AV lock'), { code: 'EPERM' });
			}
			return realRename(from, to);
		};
		const compact = await compactBackgroundDelegations(dir, { force: true });
		_checkpointInternals.renameWithRetry = realRename;

		expect(epsonce).toBe(true);
		// This test deliberately bypasses the production retry loop (the throw
		// escapes the seam), pinning the crash-consistency contract instead:
		// the store stays recoverable when the roll rename fails outright.
		expect(['compacted', 'uncertain']).toContain(compact.status);
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners.some((r) => r.correlationId === 'eperm-1')).toBe(true);
		}
	});

	it('the production rename retry loop survives a transient EPERM (real loop exercised)', async () => {
		await recordPendingDelegation(dir, pendingInput('retry-1'));
		const realSleep = _checkpointInternals.syncSleep;
		const realOnce = _checkpointInternals.renameOnce;
		_checkpointInternals.syncSleep = () => {}; // no busy waiting in tests
		let fsCalls = 0;
		let failedOnce = false;
		_checkpointInternals.renameOnce = (from: string, to: string) => {
			fsCalls += 1;
			if (!failedOnce && to.endsWith(BACKGROUND_DELEGATIONS_FILE)) {
				failedOnce = true;
				throw Object.assign(new Error('transient AV lock'), {
					code: 'EPERM',
				});
			}
			return realOnce(from, to);
		};
		try {
			const compact = await compactBackgroundDelegations(dir, {
				force: true,
			});
			expect(compact.status).toBe('compacted');
			// The production wrapper retried the failed roll rename.
			expect(failedOnce).toBe(true);
			expect(fsCalls).toBeGreaterThanOrEqual(4); // checkpoint + manifest + roll×2
			const scan = scanDelegationsForRecovery(dir);
			expect(scan.status).toBe('ok');
		} finally {
			_checkpointInternals.renameOnce = realOnce;
			_checkpointInternals.syncSleep = realSleep;
		}
	});

	it('out-of-band shadow appends during compaction do not bypass SQLite authority', async () => {
		await recordPendingDelegation(dir, pendingInput('base-1'));
		// Simulate a stale-lock interleave: while compaction runs, another
		// actor writes directly to the legacy shadow after the cut was taken.
		// Under SQLite authority that out-of-band shadow write must be ignored.
		const realRename = _checkpointInternals.renameWithRetry;
		let injected = false;
		_checkpointInternals.renameWithRetry = (from: string, to: string) => {
			if (!injected && to.endsWith('.checkpoint.json')) {
				injected = true;
				// The raced append lands after the cut was taken.
				fs.appendFileSync(
					path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
					`${JSON.stringify({ ...racedRecord('raced-1') })}\n`,
				);
			}
			return realRename(from, to);
		};
		const compact = await compactBackgroundDelegations(dir, { force: true });
		_checkpointInternals.renameWithRetry = realRename;
		expect(compact.status).toBe('compacted');
		if (compact.status === 'compacted') {
			expect(compact.tailBytes).toBeGreaterThan(0);
		}
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners.some((r) => r.correlationId === 'base-1')).toBe(true);
			expect(scan.owners.some((r) => r.correlationId === 'raced-1')).toBe(
				false,
			);
		}
		expect(
			readDelegations(dir).some((r) => r.correlationId === 'raced-1'),
		).toBe(false);
	});

	it('mutation lock contention still lands writes (backoff/retry under load)', async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				recordPendingDelegation(dir, pendingInput(`burst-${i}`)).then(
					(record) => record !== null,
				),
			),
		);
		expect(results.every(Boolean)).toBe(true);
		expect(readDelegations(dir)).toHaveLength(10);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			),
		).toBe(false);
	});
});

function racedRecord(correlationId: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_parent',
		callID: `call_${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'pending',
		createdAt: 5_000_000_000_000,
		updatedAt: 5_000_000_000_001,
	};
}
