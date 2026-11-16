/**
 * Supplementary wiring test for issue #3317 (not frozen): the resolver's ASYNC
 * entry must actually probe through the async spawn seam and ACCEPT a healthy
 * on-disk candidate — closing the gap the frozen C8 leaves open (C8 asserts
 * only that `_internals.spawnSync` is never called, which a probe-nothing
 * no-op would also satisfy).
 *
 * The async spawn seam is stubbed to a REAL bounded child (bun printing a
 * plausible `git version` line), so acceptance requires the async cycle to
 * consume the seam, run the output pattern check, and cache the candidate.
 * GREEN only after the fix (at base, resolveGitExecutableAsync drives the
 * sync `_internals.spawnSync` probe and the asyncSpawn stub is never
 * consulted).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { bunSpawn } from '../../../src/utils/bun-compat';
import {
	__seedGitExecutableForTests,
	_internals,
	resetGitExecutableCache,
	resolveGitExecutableAsync,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';
import {
	SIM_PLATFORM,
	writeSimFixture,
} from '../../helpers/git-executable-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ORIGINAL_INTERNALS = { ..._internals };

function restoreInternals(): void {
	_internals.asyncSpawn = ORIGINAL_INTERNALS.asyncSpawn;
	_internals.spawnSync = ORIGINAL_INTERNALS.spawnSync;
	_internals.platform = ORIGINAL_INTERNALS.platform;
	_internals.env = ORIGINAL_INTERNALS.env;
	_internals.now = ORIGINAL_INTERNALS.now;
	_internals.yieldToEventLoop = ORIGINAL_INTERNALS.yieldToEventLoop;
}

let tmpDir: string;

beforeEach(() => {
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	tmpDir = canonicalMkdtemp('git-exec-async-wiring-');
	_internals.platform = () => SIM_PLATFORM;
});

afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	__seedGitExecutableForTests('git');
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('git-executable async probe wiring (#3317 supplement)', () => {
	test('resolveGitExecutableAsync accepts the on-disk candidate through the async spawn seam', async () => {
		const fixture = writeSimFixture(tmpDir, 'wiring-git');
		_internals.env = () => ({ PATH: fixture.dir });
		let asyncSpawnCalls = 0;
		// The seam stub answers the --version probe SYNTHETICALLY (a real
		// cold bun spawn can exceed the 250 ms per-probe budget, which would
		// test the budget, not the wiring). The async cycle must still consume
		// the seam, run the output pattern check, and cache the candidate.
		const syntheticHealthyProbe = () =>
			({
				stdout: {
					text: async () => 'git version 2.45.0\n',
				},
				stderr: { text: async () => '' },
				exited: Promise.resolve(0),
				spawnError: undefined,
				signalCode: null,
				kill() {},
			}) as unknown as ReturnType<typeof bunSpawn>;
		_internals.asyncSpawn = (() => {
			asyncSpawnCalls += 1;
			return syntheticHealthyProbe();
		}) as typeof _internals.asyncSpawn;
		// Keep the sync probe loud if it is wrongly consulted.
		let syncSpawnCalls = 0;
		_internals.spawnSync = (() => {
			syncSpawnCalls += 1;
			return {
				pid: -1,
				output: [null, Buffer.from(''), Buffer.from('')],
				stdout: Buffer.from(''),
				stderr: Buffer.from(''),
				status: 0,
				signal: null,
				error: undefined,
			};
		}) as typeof _internals.spawnSync;

		const resolved = await resolveGitExecutableAsync();

		expect(syncSpawnCalls).toBe(0);
		expect(asyncSpawnCalls).toBeGreaterThan(0);
		expect(resolved).toBe(fixture.candidate);
		// The accepted candidate is cached for later callers.
		expect(await resolveGitExecutableAsync()).toBe(fixture.candidate);
	}, 30_000);
});
