/**
 * Acceptance check C3 (issue #3260 section B / trace 3260-3252-teardown-hardening).
 *
 * A permanent-hold EPERM on a write-denied artifact must fail fast to the
 * caller without consuming the unlink retry schedule (issue #3260-B: a
 * write-denied artifact currently burns all 20 delays = 15,175 ms before
 * throwing). The discriminator is a write check (fs.access W_OK class): the
 * artifact below is a real temp file made write-denied via chmod 0o444 (on
 * Windows the read-only attribute makes W_OK report EACCES while unlink is
 * stubbed to the ACL/foreign-held EPERM class). RED at base (20 delays
 * consumed), GREEN after the fix (0 delays consumed — fail fast).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/commands/close.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realUnlink = _internals.unlink;
const realSleep = _internals.sleep;
const realCollectGarbageBestEffort = _internals.collectGarbageBestEffort;

afterEach(() => {
	// AGENTS.md invariant 7: restore every swapped _internals member.
	_internals.unlink = realUnlink;
	_internals.sleep = realSleep;
	_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
});

function errno(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

describe('permanent-hold EPERM fails fast (3260-B)', () => {
	it('write-denied artifact consumes zero retry delays (RED at base, GREEN after the fix)', async () => {
		const dir = canonicalMkdtemp('close-eperm-failfast-3260-');
		const artifact = path.join(dir, 'swarm.db');
		fs.writeFileSync(artifact, 'permanent-hold probe payload');
		// Write-denied discriminator: W_OK checks report denial for the
		// read-only attribute (Windows) / mode 0444 (POSIX) alike. Restored in
		// the finally below so cleanup can remove the file.
		fs.chmodSync(artifact, 0o444);

		const sleeps: number[] = [];
		_internals.unlink = mock(async () => {
			throw errno(
				'EPERM',
				"EPERM: operation not permitted, unlink 'probe permanent hold'",
			);
		});
		_internals.sleep = mock(async (ms: number) => {
			sleeps.push(ms);
		});
		_internals.collectGarbageBestEffort = mock(() => {});

		try {
			await expect(
				_internals.unlinkActiveStateFileWithRetry(artifact),
			).rejects.toMatchObject({ code: 'EPERM' });
			// Fail-fast contract: a permanent hold must not burn the schedule.
			expect(sleeps.length).toBe(0);
			expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(0);
		} finally {
			fs.chmodSync(artifact, 0o666);
			_internals.unlink = realUnlink;
			_internals.sleep = realSleep;
			_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
			safeRmRecursive(dir);
		}
	}, 30000);
});
