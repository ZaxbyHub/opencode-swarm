/**
 * Acceptance check C8 for issue #3317 (class: DISCRIMINATING).
 *
 * `resolveGitExecutableAsync()` must not drive the synchronous
 * `_internals.spawnSync` probe: the async entry point exists precisely so a
 * probe cycle never blocks the event loop (AGENTS.md invariant 1). With an
 * on-disk candidate reachable through the simulated PATH and a counting
 * spawnSync stub installed, one async resolution must observe ZERO spawnSync
 * calls. (The stub may return success — the point is only the COUNT. One call
 * is enough; the entry point shares a single in-flight resolution.)
 *
 * RED at base (the async entry drives the same sync probeCandidate, so the
 * count is >= 1), GREEN after the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
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
	_internals.spawnSync = ORIGINAL_INTERNALS.spawnSync;
	_internals.platform = ORIGINAL_INTERNALS.platform;
	_internals.env = ORIGINAL_INTERNALS.env;
	_internals.now = ORIGINAL_INTERNALS.now;
	_internals.yieldToEventLoop = ORIGINAL_INTERNALS.yieldToEventLoop;
}

function okSpawnResult(): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from('git version 2.45.0\n'), Buffer.from('')],
		stdout: Buffer.from('git version 2.45.0\n'),
		stderr: Buffer.from(''),
		status: 0,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<Buffer>;
}

let tmpDir: string;

beforeEach(() => {
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	tmpDir = canonicalMkdtemp('git-exec-async-');
	_internals.platform = () => SIM_PLATFORM;
});

afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	// Restore the preload's resolver pin for co-running test files.
	__seedGitExecutableForTests('git');
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('git-executable async resolution leaves the sync probe alone (#3317 C8)', () => {
	test('resolveGitExecutableAsync never calls the synchronous spawnSync probe', async () => {
		const fixture = writeSimFixture(tmpDir, 'async-git');
		_internals.env = () => ({ PATH: fixture.dir });
		let spawnCalls = 0;
		_internals.spawnSync = () => {
			spawnCalls += 1;
			return okSpawnResult();
		};

		resetGitExecutableCache();
		await resolveGitExecutableAsync();

		expect(spawnCalls).toBe(0);
	}, 30_000);
});
