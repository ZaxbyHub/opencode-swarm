/**
 * Issue #1151 PR 2 (Stage A) — durable pending-delegation store tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_FILE,
	findByBatchId,
	findByCorrelationId,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bg-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function input(over: Partial<RecordPendingInput> = {}): RecordPendingInput {
	return {
		correlationId: 'ses_1',
		jobId: 'job_1',
		subagentSessionId: 'ses_1',
		parentSessionId: 'parent_1',
		callID: 'call_1',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		...over,
	};
}

describe('pending-delegations store', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('records a pending delegation and reads it back', async () => {
		const rec = await recordPendingDelegation(dir, input());
		expect(rec).not.toBeNull();
		expect(rec?.status).toBe('pending');

		const all = readDelegations(dir);
		expect(all).toHaveLength(1);
		expect(all[0].correlationId).toBe('ses_1');
		expect(all[0].normalizedAgent).toBe('reviewer');

		// File is under .swarm/ with the expected name.
		expect(
			fs.existsSync(path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE)),
		).toBe(true);
	});

	it('returns empty for a missing store (no throw)', () => {
		expect(readDelegations(dir)).toEqual([]);
		expect(findByCorrelationId(dir, 'nope')).toBeNull();
	});

	it('folds to the latest snapshot per correlationId', async () => {
		await recordPendingDelegation(
			dir,
			input({
				correlationId: 'ses_a',
				evidenceTaskId: '1.1',
				planTaskId: '1.1',
			}),
		);
		// Second snapshot for the same correlationId with a different task id.
		await recordPendingDelegation(
			dir,
			input({
				correlationId: 'ses_a',
				evidenceTaskId: '9.9',
				planTaskId: '9.9',
			}),
		);
		await recordPendingDelegation(dir, input({ correlationId: 'ses_b' }));

		const folded = readDelegations(dir);
		// Two distinct correlationIds; ses_a folded to the LATEST snapshot.
		expect(folded).toHaveLength(2);
		expect(findByCorrelationId(dir, 'ses_a')?.evidenceTaskId).toBe('9.9');
	});

	it('sweeps overdue pendings to stale (deterministic via backdated record)', async () => {
		// Seed a backdated pending record directly so staleness does not depend on real
		// elapsed time (avoids flakiness on slow/loaded CI runners). updatedAt is 10 min
		// in the past; sweeping with a 1 min timeout makes it reliably overdue.
		const tenMinAgo = Date.now() - 10 * 60_000;
		const backdated = {
			schemaVersion: 1,
			correlationId: 'ses_stale',
			jobId: 'job_stale',
			subagentSessionId: 'ses_stale',
			parentSessionId: 'parent_1',
			callID: 'call_1',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			status: 'pending',
			createdAt: tenMinAgo,
			updatedAt: tenMinAgo,
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${JSON.stringify(backdated)}\n`,
		);

		const swept = await sweepStaleDelegations(dir, 60_000);
		expect(swept).toBe(1);
		expect(findByCorrelationId(dir, 'ses_stale')?.status).toBe('stale');
	});

	it('findByCorrelationId returns the folded record', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_find' }));
		const found = findByCorrelationId(dir, 'ses_find');
		expect(found?.correlationId).toBe('ses_find');
		expect(found?.status).toBe('pending');
	});

	it('skips malformed/partial lines without throwing', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_ok' }));
		const file = path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE);
		fs.appendFileSync(file, 'not json\n');
		fs.appendFileSync(file, '{"partial": \n');
		fs.appendFileSync(file, `${JSON.stringify({ bogus: true })}\n`);
		const all = readDelegations(dir);
		expect(all).toHaveLength(1);
		expect(all[0].correlationId).toBe('ses_ok');
	});

	it('sweep marks only overdue pendings stale (fresh ones survive)', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_old' }));
		// Large timeout → nothing overdue.
		const swept = await sweepStaleDelegations(dir, 10 * 60_000);
		expect(swept).toBe(0);
		expect(findByCorrelationId(dir, 'ses_old')?.status).toBe('pending');
	});

	it('handles concurrent pending appends under lock', async () => {
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				recordPendingDelegation(dir, input({ correlationId: `ses_${i}` })),
			),
		);
		const all = readDelegations(dir);
		expect(all).toHaveLength(8);
		const ids = new Set(all.map((r) => r.correlationId));
		expect(ids.size).toBe(8);
	});

	it('records async lane metadata and finds records by batch id', async () => {
		await recordPendingDelegation(
			dir,
			input({
				correlationId: 'ses_async',
				batchId: 'batch-1',
				laneId: 'security',
				mode: 'deep-dive',
				promptHash: 'hash-1',
				workspace: {
					directory: dir,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: 'abc123',
					scope: 'src/security.ts',
				},
				generation: 1,
			}),
		);

		const records = findByBatchId(dir, 'batch-1');
		expect(records).toHaveLength(1);
		expect(records[0].schemaVersion).toBe(2);
		expect(records[0].laneId).toBe('security');
		expect(records[0].workspace?.prHeadSha).toBe('abc123');
	});

	it('appends terminal completion exactly once', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_done' }));
		const first = await appendDelegationTransition(dir, 'ses_done', {
			status: 'completed',
			result: {
				text: 'done',
				chars: 4,
				truncated: false,
				digest: 'digest-1',
			},
		});
		const second = await appendDelegationTransition(dir, 'ses_done', {
			status: 'error',
			result: {
				error: 'late',
				chars: 4,
				truncated: false,
				digest: 'digest-2',
			},
		});

		expect(first?.status).toBe('completed');
		expect(second?.status).toBe('completed');
		expect(findByCorrelationId(dir, 'ses_done')?.result?.text).toBe('done');
	});
});
