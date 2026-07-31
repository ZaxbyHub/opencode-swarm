import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_FILE,
	claimDelegationIngestion,
	findByCorrelationId,
	recordPendingDelegation,
	settleDelegationIngestion,
} from '../../../src/background/pending-delegations';

let directory = '';

const result = {
	text: 'done',
	chars: 4,
	truncated: false,
	digest: 'completion-digest',
};

async function completedRecord(): Promise<void> {
	const pending = await recordPendingDelegation(directory, {
		correlationId: 'child',
		jobId: 'job',
		subagentSessionId: 'child',
		parentSessionId: 'parent',
		callID: 'coder-call',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
	});
	expect(pending).not.toBeNull();
	expect(
		await appendDelegationTransition(directory, 'child', {
			status: 'completed',
			result,
		}),
	).toMatchObject({ status: 'completed' });
}

beforeEach(() => {
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'pending-ingestion-cas-')),
	);
});

afterEach(() => {
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('pending delegation ingestion CAS — regression: duplicate completion ownership (F-B2)', () => {
	test('grants exactly one owner to concurrent identical completion claims', async () => {
		// Previous code let both observers ingest after independently reading the
		// same completed snapshot, duplicating evidence and lifecycle side effects.
		await completedRecord();

		const claims = await Promise.all([
			claimDelegationIngestion(directory, 'child', result.digest, { now: 100 }),
			claimDelegationIngestion(directory, 'child', result.digest, { now: 100 }),
		]);
		expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(
			1,
		);
		expect(claims.filter((claim) => claim.outcome === 'busy')).toHaveLength(1);

		const owner = claims.find((claim) => claim.outcome === 'claimed');
		if (!owner || owner.outcome !== 'claimed') throw new Error('missing owner');
		expect(
			await settleDelegationIngestion(directory, 'child', owner.ingestionId, {
				status: 'consumed',
			}),
		).toMatchObject({ status: 'consumed' });
		expect(findByCorrelationId(directory, 'child')?.status).toBe('consumed');

		const raw = fs.readFileSync(
			path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			'utf-8',
		);
		const ingestingLines = raw
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { status: string })
			.filter((record) => record.status === 'ingesting');
		expect(ingestingLines).toHaveLength(1);
	});

	test('reclaims an abandoned lease and rejects the crashed owner settlement', async () => {
		// A process can crash after the durable claim but before settlement; the
		// bounded lease makes replay possible without concurrent ownership.
		await completedRecord();
		const crashed = await claimDelegationIngestion(
			directory,
			'child',
			result.digest,
			{ now: 100, leaseMs: 30 },
		);
		expect(crashed.outcome).toBe('claimed');
		const replay = await claimDelegationIngestion(
			directory,
			'child',
			result.digest,
			{ now: 131, leaseMs: 30 },
		);
		expect(replay.outcome).toBe('claimed');
		if (crashed.outcome !== 'claimed' || replay.outcome !== 'claimed') {
			throw new Error('expected two serial lease owners');
		}

		expect(
			await settleDelegationIngestion(directory, 'child', crashed.ingestionId, {
				status: 'ingestion_error',
				result,
			}),
		).toBeNull();
		expect(
			await settleDelegationIngestion(directory, 'child', replay.ingestionId, {
				status: 'consumed',
			}),
		).toMatchObject({ status: 'consumed' });
	});

	test('retries ingestion_error and never regresses consumed', async () => {
		// Error replay is forward: retry may claim ingestion_error, but no late
		// error transition can overwrite a successfully consumed record.
		await completedRecord();
		const first = await claimDelegationIngestion(
			directory,
			'child',
			result.digest,
		);
		if (first.outcome !== 'claimed') throw new Error('missing first owner');
		expect(
			await settleDelegationIngestion(directory, 'child', first.ingestionId, {
				status: 'ingestion_error',
				result,
			}),
		).toMatchObject({ status: 'ingestion_error' });

		const replay = await claimDelegationIngestion(
			directory,
			'child',
			result.digest,
		);
		if (replay.outcome !== 'claimed') throw new Error('missing replay owner');
		await settleDelegationIngestion(directory, 'child', replay.ingestionId, {
			status: 'consumed',
		});
		await appendDelegationTransition(directory, 'child', {
			status: 'ingestion_error',
			result,
		});

		expect(findByCorrelationId(directory, 'child')?.status).toBe('consumed');
		expect(
			await claimDelegationIngestion(directory, 'child', result.digest),
		).toMatchObject({ outcome: 'settled', record: { status: 'consumed' } });
	});

	test('rejects replay with a different terminal digest', async () => {
		await completedRecord();
		expect(
			await claimDelegationIngestion(directory, 'child', 'other-digest'),
		).toMatchObject({ outcome: 'rejected', record: { status: 'completed' } });
	});
});
