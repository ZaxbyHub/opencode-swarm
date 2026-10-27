/**
 * Supplementary test for issue #3317 (post-push automation review): the async
 * probe cycle's TOTAL_BUDGET_MS (1000 ms) must be a real bound. The
 * pre-candidate budget check alone let a probe started just inside the
 * boundary run its full PER_PROBE_TIMEOUT_MS (250 ms) past the budget; the
 * cycle now caps each probe at min(PER_PROBE_TIMEOUT_MS, remaining budget).
 *
 * Discriminator: a scripted `_internals.now` advances 950 ms per call. The
 * cycle reads `start` and then the first candidate check one synchronous call
 * later, so the first probe observes 950 of 1000 ms consumed and receives a
 * 50 ms cap (pre-fix: hardcoded 250 ms). The override candidate's spawn hangs
 * (`exited` never settles), so only the deadline can end it; the next check
 * sees the budget exhausted and the cycle stops after that single probe.
 * GREEN only with the cap: pre-fix the same path waits the full 250 ms and
 * the elapsed assertion fails.
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
	tmpDir = canonicalMkdtemp('git-exec-budget-');
	_internals.platform = () => SIM_PLATFORM;
	// Only the override candidate matters here; a PATH stub pointing at an
	// empty dir keeps path-derived candidates stat-dead on every host.
	_internals.env = () => ({ PATH: tmpDir });
});

afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	// Restore the preload's resolver pin for co-running test files.
	__seedGitExecutableForTests('git');
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('async probe cycle honors its total budget (#3317 supplement)', () => {
	test('a probe near the budget boundary is capped by the remaining budget, not a full per-probe timeout', async () => {
		const fixture = writeSimFixture(tmpDir, 'budget-git');
		setGitBinaryOverride(fixture.candidate);

		let virtualNow = 0;
		_internals.now = () => {
			virtualNow += 950;
			return virtualNow;
		};

		let asyncSpawnCalls = 0;
		_internals.asyncSpawn = (() => {
			asyncSpawnCalls += 1;
			return {
				stdout: { text: async () => '' },
				stderr: { text: async () => '' },
				exited: new Promise<number>(() => {}),
				spawnError: undefined,
				signalCode: null,
				kill() {},
			} as unknown as ReturnType<typeof bunSpawn>;
		}) as typeof _internals.asyncSpawn;
		// Loud if the async entry is ever wrongly routed to the sync probe.
		_internals.spawnSync = (() => {
			throw new Error('sync probe must not run in the async cycle');
		}) as typeof _internals.spawnSync;

		const startedAt = performance.now();
		const resolved = await resolveGitExecutableAsync();
		const elapsedMs = performance.now() - startedAt;

		// The hanging override probe timed out under the CAPPED budget, the
		// next boundary check exhausted the cycle, and a timed-out cycle
		// degrades to bare 'git' rather than caching a rejection.
		expect(resolved).toBe('git');
		expect(asyncSpawnCalls).toBe(1);
		// Post-cap ≈ 50 ms + enumeration/stat/yield overhead; pre-cap the
		// same path waited the hardcoded 250 ms probe timeout. 200 ms
		// separates both shapes with wide margins on loaded CI runners.
		expect(elapsedMs).toBeLessThan(200);
	}, 30_000);

	test('an all-timeout async cycle is not negative-cached: a second resolve re-probes', async () => {
		const fixture = writeSimFixture(tmpDir, 'timeout-git');
		setGitBinaryOverride(fixture.candidate);

		let asyncSpawnCalls = 0;
		// Real clock (no budget script): the override probe hangs and times
		// out at the ordinary PER_PROBE_TIMEOUT_MS; later candidates stat-
		// fail without spawning.
		_internals.asyncSpawn = (() => {
			asyncSpawnCalls += 1;
			return {
				stdout: { text: async () => '' },
				stderr: { text: async () => '' },
				exited: new Promise<number>(() => {}),
				spawnError: undefined,
				signalCode: null,
				kill() {},
			} as unknown as ReturnType<typeof bunSpawn>;
		}) as typeof _internals.asyncSpawn;
		_internals.spawnSync = (() => {
			throw new Error('sync probe must not run in the async cycle');
		}) as typeof _internals.spawnSync;

		// First resolve: the timed-out cycle answers bare 'git' (the
		// unknown-not-rejection shape) WITHOUT caching it (sawTimeout rule).
		const first = await resolveGitExecutableAsync();
		expect(first).toBe('git');
		expect(asyncSpawnCalls).toBeGreaterThanOrEqual(1);

		// Second resolve must re-probe — a negative cache here would pin the
		// bare fallback for the whole TTL (the async half of AC7, which the
		// sync-only C7 test never drives).
		const second = await resolveGitExecutableAsync();
		expect(second).toBe('git');
		expect(asyncSpawnCalls).toBeGreaterThanOrEqual(2);
	}, 30_000);
});
