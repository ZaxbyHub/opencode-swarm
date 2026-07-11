import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	createCuratorBeforeEach,
	createCuratorMocks,
	defaultConfig,
	setupMockModules,
} from './curator-test-fixtures.js';

const mocks = createCuratorMocks();
setupMockModules(mocks);

const { mockReadSwarmFileAsync } = mocks;
const { createKnowledgeCuratorHook, _internals } = await import(
	'../../../src/hooks/knowledge-curator.js'
);
const { transactKnowledge: mockTransactKnowledge } = await import(
	'../../../src/hooks/knowledge-store.js'
);
const resetFixtures = createCuratorBeforeEach(mocks, mockTransactKnowledge);
const realCurate = _internals.curateAndStoreSwarm;
const realRealpath = _internals.realpath;

function trigger(sessionID = 'evidence-concurrency-session') {
	return {
		toolName: 'write',
		path: '/project/.swarm/evidence/task-1/evidence.json',
		sessionID,
	};
}

describe('knowledge curator evidence concurrency — regression: issue #1769', () => {
	beforeEach(() => {
		resetFixtures();
		_internals.seenRetroSections.clear();
		_internals.inFlightEvidenceEntries.clear();
		_internals.curateAndStoreSwarm = realCurate;
		_internals.realpath = realRealpath;
	});

	afterEach(() => {
		_internals.curateAndStoreSwarm = realCurate;
		_internals.realpath = realRealpath;
	});

	test('concurrent duplicate triggers claim one entry once', async () => {
		let release: (() => void) | undefined;
		let signalStarted: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const curate = mock(async () => {
			signalStarted?.();
			await blocked;
			return {
				stored: 1,
				reinforced: 0,
				skipped: 0,
				rejected: 0,
				quarantined: 0,
			};
		});
		_internals.curateAndStoreSwarm = curate;
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				entries: [
					{
						type: 'retrospective',
						task_id: 'one',
						timestamp: '2026-07-10T00:00:00.000Z',
						agent: 'one',
						phase_number: 1,
						lessons_learned: ['Claim concurrent evidence exactly once'],
					},
				],
			}),
		);
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		const calls = Promise.all([hook(trigger(), {}), hook(trigger(), {})]);
		await started;
		try {
			expect(curate).toHaveBeenCalledTimes(1);
		} finally {
			release?.();
			await calls;
		}
		expect(_internals.inFlightEvidenceEntries.size).toBe(0);
	});

	test('partial failure records earlier success and retries only the failed entry', async () => {
		const curate = mock(async (lessons: string[]) => {
			if (lessons[0].includes('fails') && curate.mock.calls.length === 2) {
				throw new Error('simulated second-entry failure');
			}
			return {
				stored: 1,
				reinforced: 0,
				skipped: 0,
				rejected: 0,
				quarantined: 0,
			};
		});
		_internals.curateAndStoreSwarm = curate;
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				entries: [
					{
						timestamp: '2026-07-10T00:00:00.000Z',
						lessons_learned: ['The first entry succeeds and stays seen'],
					},
					{
						timestamp: '2026-07-10T00:01:00.000Z',
						lessons_learned: ['The second entry fails then retries'],
					},
				],
			}),
		);
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		await expect(hook(trigger(), {})).rejects.toThrow(
			'simulated second-entry failure',
		);
		await hook(trigger(), {});

		expect(curate).toHaveBeenCalledTimes(3);
		expect(curate.mock.calls[2][0]).toEqual([
			'The second entry fails then retries',
		]);
		expect(_internals.inFlightEvidenceEntries.size).toBe(0);
	});

	test('in-flight overload does not evict active claims or mark skipped work seen', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		for (
			let index = 0;
			index < _internals.MAX_IN_FLIGHT_EVIDENCE_ENTRIES;
			index++
		) {
			_internals.inFlightEvidenceEntries.add(`occupied-${index}`);
		}
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				lessons_learned: ['Retry overload work on a later trigger'],
			}),
		);
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		await hook(trigger(), {});
		expect(curate).not.toHaveBeenCalled();
		expect(_internals.inFlightEvidenceEntries.size).toBe(
			_internals.MAX_IN_FLIGHT_EVIDENCE_ENTRIES,
		);

		_internals.inFlightEvidenceEntries.clear();
		await hook(trigger(), {});
		expect(curate).toHaveBeenCalledTimes(1);
	});
});
