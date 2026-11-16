/**
 * #3260-B/R1 classification matrix for the write-denied fail-fast (companion
 * to the frozen C3, which pins the denied case). These legs pin the
 * discriminator's NEGATIVE space so a catch-all can never regress the
 * transient retry:
 *  - EPERM on a path whose W_OK probe throws ENOENT (missing file — the
 *    existing transient-retry suite's relative-path shape) → NOT denied →
 *    the full retry schedule continues.
 *  - EPERM with W_OK allowed (locked-but-writable) → NOT denied → schedule.
 *  - EBUSY never consults the probe at all.
 *  - EBUSY then denied-EPERM fails fast at the transition.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/commands/close.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realUnlink = _internals.unlink;
const realSleep = _internals.sleep;
const realCollectGarbage = _internals.collectGarbageBestEffort;
const realIsWriteDenied = _internals.isWriteDenied;

afterEach(() => {
	_internals.unlink = realUnlink;
	_internals.sleep = realSleep;
	_internals.collectGarbageBestEffort = realCollectGarbage;
	_internals.isWriteDenied = realIsWriteDenied;
	delete process.env.SWARM_CLEAN_STAGE_DEADLINE_MS;
});

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: probe`), { code });
}

function stubRetryWorld(failures: Array<'EBUSY' | 'EPERM'>): {
	sleeps: number[];
	unlinkCalls: () => number;
} {
	let calls = 0;
	const sleeps: number[] = [];
	const script = [...failures];
	_internals.unlink = (async () => {
		calls += 1;
		const next = script.shift();
		if (next !== undefined) throw errno(next);
	}) as typeof _internals.unlink;
	_internals.sleep = (async (ms: number) => {
		sleeps.push(ms);
	}) as typeof _internals.sleep;
	_internals.collectGarbageBestEffort = () => {};
	return { sleeps, unlinkCalls: () => calls };
}

describe('write-denied classification matrix (3260-B / R1)', () => {
	test('EPERM on a missing path (ENOENT probe) is NOT denied — schedule continues', async () => {
		// Real probe on a nonexistent relative path throws ENOENT — must
		// classify as not-denied (the pre-#3260 transient-retry contract).
		const { sleeps, unlinkCalls } = stubRetryWorld(['EPERM', 'EPERM']);
		await _internals.unlinkActiveStateFileWithRetry(
			'definitely-missing-3260.db',
		);
		expect(unlinkCalls()).toBe(3);
		expect(sleeps).toEqual([25, 50]);
	});

	test('EPERM with W_OK allowed (locked-but-writable) is NOT denied — schedule continues', async () => {
		_internals.isWriteDenied = () => false;
		const { sleeps, unlinkCalls } = stubRetryWorld(['EPERM', 'EPERM']);
		await _internals.unlinkActiveStateFileWithRetry(
			'locked-but-writable-3260.db',
		);
		expect(unlinkCalls()).toBe(3);
		expect(sleeps).toEqual([25, 50]);
	});

	test('EBUSY never consults the write-denied probe', async () => {
		let probeCalls = 0;
		_internals.isWriteDenied = () => {
			probeCalls += 1;
			return true; // would fail fast IF consulted — it must not be
		};
		const { sleeps } = stubRetryWorld(['EBUSY', 'EBUSY']);
		await _internals.unlinkActiveStateFileWithRetry('ebusy-transient-3260.db');
		expect(probeCalls).toBe(0);
		expect(sleeps).toEqual([25, 50]);
	});

	test('EBUSY then denied-EPERM fails fast at the transition', async () => {
		const dir = canonicalMkdtemp('close-eperm-matrix-3260-');
		const artifact = path.join(dir, 'swarm.db');
		fs.writeFileSync(artifact, 'matrix');
		fs.chmodSync(artifact, 0o444); // real W_OK-denied file
		// call 1: EBUSY (transient — sleeps once); call 2: EPERM on the
		// write-denied file (real probe classifies denied) → immediate throw.
		const { sleeps, unlinkCalls } = stubRetryWorld(['EBUSY', 'EPERM']);
		try {
			await expect(
				_internals.unlinkActiveStateFileWithRetry(artifact),
			).rejects.toMatchObject({ code: 'EPERM' });
			expect(unlinkCalls()).toBe(2);
			expect(sleeps).toEqual([25]);
		} finally {
			fs.chmodSync(artifact, 0o666);
			_internals.unlink = realUnlink;
			_internals.sleep = realSleep;
			safeRmRecursive(dir);
		}
	});
});
