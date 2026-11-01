/**
 * Acceptance check C4 (issue #3260 section C / trace 3260-3252-teardown-hardening).
 *
 * A shared multi-dir teardown helper safeRmAllRecursive(dirs) must attempt
 * EVERY directory and throw AFTER collecting per-dir failures, so one stuck
 * dir no longer strands the remaining temp dirs (RC-C: the
 * `for (const root of testRoots) safeRmRecursive(root);` pattern rethrows on
 * the first exhausted dir). NEW-SURFACE: the export does not exist at the
 * base tree, so this file fails at module resolution (ERROR at base); it
 * turns GREEN when the fix adds the helper.
 *
 * Frozen contract for the fix: `safeRmAllRecursive(dirs: string[]): void`
 * exported from tests/helpers/safe-test-dir.ts; it attempts every dir (the
 * deletable second dir is removed even when the first is permanently held)
 * and then throws an aggregate Error whose message names each failed dir's
 * path.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	safeRmAllRecursive,
	safeRmRecursive,
} from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realRmSync = _internals.rmSync;
const realCollectGarbageBestEffort = _internals.collectGarbageBestEffort;
const realWait = _internals.wait;

afterEach(() => {
	// AGENTS.md invariant 7: restore every swapped _internals member.
	_internals.rmSync = realRmSync;
	_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
	_internals.wait = realWait;
});

describe('safeRmAllRecursive multi-dir teardown (3260-C)', () => {
	it('attempts every dir and throws after collecting per-dir failures (ERROR at base, GREEN after the fix)', () => {
		const dirA = canonicalMkdtemp('safe-rm-all-a-3260-');
		const dirB = canonicalMkdtemp('safe-rm-all-b-3260-');
		fs.writeFileSync(path.join(dirB, 'payload.txt'), 'must be removed');

		// dirA is permanently held (EBUSY on every attempt); dirB is deletable.
		// Match by basename: mkdtemp suffixes are unique, and this stays robust
		// to path normalization differences between the helper and the stub.
		const stuckName = path.basename(dirA);
		_internals.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
			if (String(target).includes(stuckName)) {
				const error = new Error(
					`EBUSY: resource busy or locked, rm '${target}'`,
				) as NodeJS.ErrnoException;
				error.code = 'EBUSY';
				throw error;
			}
			return realRmSync(target, options);
		}) as typeof fs.rmSync;
		_internals.collectGarbageBestEffort = () => {};
		_internals.wait = () => {};

		try {
			let aggregate: unknown = null;
			try {
				safeRmAllRecursive([dirA, dirB]);
			} catch (error) {
				aggregate = error;
			}

			// Throws AFTER attempting everything...
			expect(aggregate).toBeInstanceOf(Error);
			expect((aggregate as Error).message).toContain(dirA);
			// ...and the second dir was still attempted and removed.
			expect(fs.existsSync(dirB)).toBe(false);
			// The permanently-held dir is left in place (still held).
			expect(fs.existsSync(dirA)).toBe(true);
		} finally {
			_internals.rmSync = realRmSync;
			_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
			_internals.wait = realWait;
			safeRmRecursive(dirA);
			safeRmRecursive(dirB);
		}
	}, 30000);
});
