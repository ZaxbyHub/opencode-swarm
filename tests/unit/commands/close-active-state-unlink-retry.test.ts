import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { _internals } from '../../../src/commands/close.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realUnlink = _internals.unlink;
const realSleep = _internals.sleep;
const realCollectGarbageBestEffort = _internals.collectGarbageBestEffort;

afterEach(() => {
	_internals.unlink = realUnlink;
	_internals.sleep = realSleep;
	_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
});

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe('active-state unlink retry', () => {
	test.each([
		'EBUSY',
		'EPERM',
	])('retries transient Windows %s locks', async (code) => {
		const unlink = mock(async () => {
			if (unlink.mock.calls.length < 3) throw errno(code);
		});
		const sleep = mock(async () => {});
		const collectGarbage = mock(() => {});
		_internals.unlink = unlink;
		_internals.sleep = sleep;
		_internals.collectGarbageBestEffort = collectGarbage;

		await _internals.unlinkActiveStateFileWithRetry('swarm.db');

		expect(unlink).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(collectGarbage).toHaveBeenCalledTimes(1);
		expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([25, 50]);
	});

	test('does not retry non-transient failures', async () => {
		const failure = errno('EACCES');
		const unlink = mock(async () => {
			throw failure;
		});
		const sleep = mock(async () => {});
		_internals.unlink = unlink;
		_internals.sleep = sleep;

		await expect(
			_internals.unlinkActiveStateFileWithRetry('swarm.db'),
		).rejects.toBe(failure);
		expect(unlink).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	test('stops after the bounded transient retry budget', async () => {
		const failure = errno('EBUSY');
		const unlink = mock(async () => {
			throw failure;
		});
		const sleep = mock(async () => {});
		_internals.unlink = unlink;
		_internals.sleep = sleep;

		await expect(
			_internals.unlinkActiveStateFileWithRetry('swarm.db'),
		).rejects.toBe(failure);
		expect(unlink).toHaveBeenCalledTimes(5);
		expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
			25, 50, 100, 200,
		]);
	});

	test('releases Bun query-cache handles before deleting a closed project database', async () => {
		const directory = canonicalMkdtemp('close-query-cache-');
		const databasePath = path.join(directory, '.swarm', 'swarm.db');
		try {
			const db = getProjectDb(directory);
			for (let index = 0; index < 100; index += 1) {
				db.query(`SELECT ${index} AS value`).get();
			}
			closeProjectDb(directory);

			await _internals.unlinkActiveStateFileWithRetry(databasePath);

			expect(existsSync(databasePath)).toBe(false);
		} finally {
			closeProjectDb(directory);
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
