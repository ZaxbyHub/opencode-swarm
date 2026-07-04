import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendLedgerEvent,
	initLedger,
	type LedgerEvent,
	LedgerStaleWriterError,
	readLedgerEvents,
} from './ledger';

let testDir: string;

function eventInput(taskId: string, source: string) {
	return {
		plan_id: 'test-plan',
		event_type: 'task_added' as const,
		task_id: taskId,
		source,
	};
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-concurrency-'));
	fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(testDir, { recursive: true, force: true });
});

describe('appendLedgerEvent concurrency regression', () => {
	test('concurrent appends both persist with unique monotonic sequence numbers', async () => {
		await initLedger(testDir, 'test-plan');

		const results = await Promise.all([
			appendLedgerEvent(testDir, eventInput('1.1', 'race-1')),
			appendLedgerEvent(testDir, eventInput('1.2', 'race-2')),
		]);

		const events = await readLedgerEvents(testDir);
		const appended = events.filter((event) => event.source.startsWith('race-'));
		const persistedSeqs = appended
			.map((event) => event.seq)
			.sort((a, b) => a - b);
		const returnedSeqs = results
			.map((event) => event.seq)
			.sort((a, b) => a - b);

		expect(appended.map((event) => event.source).sort()).toEqual([
			'race-1',
			'race-2',
		]);
		expect(persistedSeqs).toEqual([2, 3]);
		expect(returnedSeqs).toEqual([2, 3]);
	});

	test('concurrent writers using the same expectedSeq produce one stale-writer error', async () => {
		await initLedger(testDir, 'test-plan');

		const results = await Promise.allSettled([
			appendLedgerEvent(testDir, eventInput('1.1', 'cas-1'), {
				expectedSeq: 1,
			}),
			appendLedgerEvent(testDir, eventInput('1.2', 'cas-2'), {
				expectedSeq: 1,
			}),
		]);

		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<LedgerEvent> =>
				result.status === 'fulfilled',
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);

		expect(fulfilled).toHaveLength(1);
		expect(fulfilled[0].value.seq).toBe(2);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toBeInstanceOf(LedgerStaleWriterError);

		const events = await readLedgerEvents(testDir);
		const casSources = events
			.filter((event) => event.source.startsWith('cas-'))
			.map((event) => event.source);
		expect(casSources).toHaveLength(1);
	});
});
