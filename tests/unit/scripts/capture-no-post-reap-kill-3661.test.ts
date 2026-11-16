/**
 * #3661 AC4 — ghApiViaCli's finally block must never signal an ALREADY-REAPED
 * pid.
 *
 * `spawnSync` is synchronous: when it returns, the child has already been
 * reaped (on timeout, Node kills and waits for it before returning). A
 * `process.kill(proc.pid)` in the finally block therefore targets a pid that
 * no longer names that child — at best a swallowed ESRCH, at worst a KILL
 * delivered to an UNRELATED process that reused the pid. The current code
 * carries exactly that `process.kill(proc.pid)` leg (guarded only by
 * `proc.error`), which is unsignalable-by-construction and unsafe.
 *
 * Two legs:
 *  - Source-pin (reliable RED at the current code): the literal
 *    `process.kill(proc.pid)` string must be absent from the script.
 *  - Behavioral (NEW-SURFACE): driven through the `_internals.spawnSync` seam
 *    the fix must add (routing ghApiViaCli's spawnSync through the module so
 *    tests can observe what it does with an errored result). RED at the
 *    current code on seam-absence — acceptable for a new surface; green once
 *    the seam exists and no kill is signalled post-reap.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../scripts/capture-required-check-evidence';

const SCRIPT_PATH = path.resolve(
	import.meta.dir,
	'../../../scripts/capture-required-check-evidence.ts',
);

describe('capture-required-check-evidence post-reap kill (#3661 AC4)', () => {
	test('source pin: the finally path never signals a reaped pid', () => {
		const source = fs.readFileSync(SCRIPT_PATH, 'utf-8');
		// spawnSync is synchronous — the child is already reaped by the time
		// the finally block runs, so this literal must not exist in the file.
		expect(source).not.toContain('process.kill(proc.pid)');
	}, 10_000);

	test('behavioral: an errored spawnSync result carries no post-reap kill signal (via the _internals.spawnSync seam)', () => {
		const seam = (_internals as { spawnSync?: unknown }).spawnSync;
		// NEW-SURFACE RED: the fix must route ghApiViaCli's spawnSync through
		// the module's _internals so this behavioral contract is testable.
		expect(typeof seam).toBe('function');

		const originalGhApi = _internals.ghApi;
		const originalKill = process.kill;
		const killed: Array<number | undefined> = [];
		(_internals as { spawnSync?: unknown }).spawnSync = () => ({
			error: new Error('spawn timed out'),
			status: null,
			stdout: '',
			stderr: '',
			pid: 471_108,
		});
		process.kill = ((pid: number | undefined) => {
			killed.push(pid);
			return true;
		}) as typeof process.kill;
		try {
			const result = _internals.ghApi('/repos/x/y', process.cwd());
			// The errored probe still reports failure — the leg is about WHAT
			// the finally block does, not the return shape.
			expect(result.ok).toBe(false);
			// The child was already reaped when spawnSync returned; signalling
			// it afterwards must not happen AT ALL (F-008 tightening, PR #3718
			// review: the previous PID-specific assertion let a
			// `process.kill(-pid)` group-kill mutant survive — an empty list
			// is the contract).
			expect(killed).toEqual([]);
		} finally {
			(_internals as { spawnSync?: unknown }).spawnSync = seam;
			_internals.ghApi = originalGhApi;
			process.kill = originalKill;
		}
	}, 10_000);
});
