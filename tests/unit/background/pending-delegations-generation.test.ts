import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
	appendDelegationTransition,
	findByCorrelationId,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	recordPendingDelegationDetailed,
} from '../../../src/background/pending-delegations';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const directories: string[] = [];

function project(): string {
	const directory = canonicalMkdtemp('pending-generation-');
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
	directories.push(directory);
	return directory;
}

function pending(generation?: number): RecordPendingInput {
	return {
		correlationId: 'session-1',
		jobId: null,
		subagentSessionId: 'session-1',
		parentSessionId: 'parent',
		callID: 'batch',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch',
		laneId: 'lane',
		...(generation === undefined ? {} : { generation }),
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('pending delegation generation integrity', () => {
	for (const generation of [Number.NaN, 1.5, 0, -1, 1_000_001]) {
		test(`rejects invalid generation ${String(generation)}`, async () => {
			expect(
				await recordPendingDelegation(project(), pending(generation)),
			).toBeNull();
		});
	}

	test('accepts positive bounded integer generations', async () => {
		const directory = project();
		expect(
			(await recordPendingDelegation(directory, pending(2)))?.generation,
		).toBe(2);
		expect(
			(await recordPendingDelegation(project(), pending(1_000_000)))
				?.generation,
		).toBe(1_000_000);
	});

	test('classifies conflicting correlation identity without reopening a terminal row', async () => {
		const directory = project();
		expect(await recordPendingDelegation(directory, pending(1))).not.toBeNull();
		await appendDelegationTransition(directory, 'session-1', {
			status: 'error',
			result: {
				error: 'terminal',
				chars: 8,
				truncated: false,
				digest: 'digest',
			},
		});

		const duplicate = await recordPendingDelegationDetailed(directory, {
			...pending(2),
			laneId: 'replacement',
		});
		expect(duplicate).toMatchObject({
			status: 'conflict',
			record: { status: 'error', laneId: 'lane', generation: 1 },
		});
		expect(findByCorrelationId(directory, 'session-1')).toMatchObject({
			status: 'error',
			laneId: 'lane',
			generation: 1,
			result: { error: 'terminal' },
		});
	});

	test('returns the authoritative record for an exact immutable-identity duplicate', async () => {
		const directory = project();
		const first = await recordPendingDelegation(directory, pending(2));
		await appendDelegationTransition(directory, 'session-1', {
			status: 'running',
		});
		const duplicate = await recordPendingDelegationDetailed(
			directory,
			pending(2),
		);
		expect(first).not.toBeNull();
		expect(duplicate).toMatchObject({
			status: 'duplicate',
			record: { status: 'running', generation: 2 },
		});
		expect(await recordPendingDelegation(directory, pending(2))).toMatchObject({
			status: 'running',
			generation: 2,
		});
	});

	test('normalizes a legacy missing generation to explicit generation 1', async () => {
		const directory = project();
		await recordPendingDelegation(directory, pending());
		const duplicate = await recordPendingDelegationDetailed(
			directory,
			pending(1),
		);
		expect(duplicate).toMatchObject({
			status: 'duplicate',
			record: { correlationId: 'session-1' },
		});
	});

	test('admits only one of two concurrent writers for the same correlation', async () => {
		const directory = project();
		const outcomes = await Promise.all([
			recordPendingDelegationDetailed(directory, pending(1)),
			recordPendingDelegationDetailed(directory, {
				...pending(2),
				laneId: 'other',
			}),
		]);
		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
			'conflict',
			'recorded',
		]);
		expect(readDelegations(directory)).toHaveLength(1);
	});
});
