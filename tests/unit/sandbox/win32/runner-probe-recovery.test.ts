/**
 * #3736 (AC2, class NEW-SURFACE): a win32 native runner probe that fails
 * TRANSIENTLY (e.g. EBUSY/EPERM/timeout on the spawn) and later succeeds
 * must be re-probed within a bounded interval, instead of pinning the weak
 * executor for the process lifetime.
 *
 * RED at base c12cd853d (2026-11-17): src/sandbox/win32/runner-client.ts
 * `probe()` caches ANY result in the module-level `_cachedProbe` forever
 * (set-once), so the "recovery after TTL" leg and the TTL-seam leg below
 * fail; the baseline legs (transient failure -> weak; within-TTL caching;
 * success-permanent) match current behavior and are the anchoring pins that
 * must STAY green after the fix. GREEN after the fix.
 *
 * Frozen seam contract the implementation MUST provide (this file is the
 * contract):
 *
 * 1. TTL resolver — `src/sandbox/win32/runner-client.ts` must export
 *    `runnerProbeFailureTtlMs(): number`, mirroring the #3716 pattern in
 *    src/sandbox/executor.ts (`executorFailureTtlMs`):
 *      - env override `SWARM_SANDBOX_RUNNER_PROBE_FAILURE_TTL_MS`
 *        (only FINITE POSITIVE values honored; unset/NaN/0/negative/
 *        Infinity fall back to the default),
 *      - default 60_000 ms (the executor sibling's default).
 *    A bare constant export was considered and rejected in favor of the
 *    function+env shape so tests and operators can shrink the TTL without
 *    recompiling — the same reasoning recorded on executor.ts.
 *
 * 2. Cache semantics — a FAILED probe result is cached only until
 *    `Date.now() + runnerProbeFailureTtlMs()` (the repo's frozen-clock
 *    helper controls Date.now here); the next `probe()` past that instant
 *    re-spawns the runner probe. A SUCCESSFUL probe result stays cached
 *    permanently (set-once for success — the macOS/Windows
 *    "success permanent, failure bounded retry" posture of #3716).
 *
 * 3. Existing seams reused (no new reset seam needed): `_internals.
 *    findRunnerBinary` / `_internals.spawnRunner` and the already-exported
 *    `_resetProbeCache()` in runner-client.ts; `_internals.
 *    probeWindowsSandbox` in restricted-environment-executor.ts (mocked
 *    true so the PowerShell fallback availability is deterministic);
 *    `_internals.createPlatformExecutor` / `_resetExecutorCache()` /
 *    `getExecutor()` in executor.ts (#3716 construction seam).
 *
 * Deliberate scope boundary: this suite pins PROBE-level recovery plus the
 * strength of a FRESHLY CONSTRUCTED executor (including one built through a
 * rebuilt getExecutor() cache entry). It does NOT pin how long executor.ts
 * keeps an already-constructed weak executor instance — the issue allows
 * either the probe-TTL bound or weak-executor re-probe on cache miss.
 *
 * Platform: `probe()` guards `process.platform !== 'win32'` BEFORE the
 * seams, so the probe/executor legs are `test.skipIf(!isWin)` like the
 * sibling runner-client tests (they run on the win32 CI shard and skip
 * cleanly elsewhere); the TTL resolver leg is a pure function and runs on
 * every platform.
 *
 * No raw Date.now()/new Date() here (check:test-clock gate) — the clock is
 * driven exclusively through tests/helpers/test-clock.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	_resetExecutorCache,
	_internals as executorInternals,
	getExecutor,
} from '../../../../src/sandbox/executor';
import { NativeWindowsSandboxExecutor } from '../../../../src/sandbox/win32/native-sandbox-executor';
import { _internals as fallbackInternals } from '../../../../src/sandbox/win32/restricted-environment-executor';
import * as runnerClientModule from '../../../../src/sandbox/win32/runner-client';
import {
	_internals,
	_resetProbeCache,
	probe,
	RUNNER_PROTOCOL_SCHEMA_VERSION,
} from '../../../../src/sandbox/win32/runner-client';
import {
	freezeClock,
	type Restore,
} from '../../../../tests/helpers/test-clock';

const isWin = process.platform === 'win32';

/** Fixed epoch instants the frozen clock reports (ms). */
const T0 = 1_000_000;
/** 24 h — past any sane failure TTL (the executor sibling default is 60 s). */
const ONE_DAY_MS = 86_400_000;

const TTL_ENV = 'SWARM_SANDBOX_RUNNER_PROBE_FAILURE_TTL_MS';
const RUNNER_PATH = 'C:\\fake\\swarm-sandbox-runner.exe';

// Save real implementations for restoration.
const realFindRunnerBinary = _internals.findRunnerBinary;
const realSpawnRunner = _internals.spawnRunner;
const realProbeWindowsSandbox = fallbackInternals.probeWindowsSandbox;
const realCreatePlatformExecutor = executorInternals.createPlatformExecutor;
const hadTtlEnv = process.env[TTL_ENV] !== undefined;
const originalTtlEnv = process.env[TTL_ENV];

afterEach(() => {
	_internals.findRunnerBinary = realFindRunnerBinary;
	_internals.spawnRunner = realSpawnRunner;
	fallbackInternals.probeWindowsSandbox = realProbeWindowsSandbox;
	executorInternals.createPlatformExecutor = realCreatePlatformExecutor;
	if (hadTtlEnv) {
		process.env[TTL_ENV] = originalTtlEnv;
	} else {
		delete process.env[TTL_ENV];
	}
	_resetProbeCache();
	_resetExecutorCache();
});

/** Capabilities stdout of a healthy runner speaking this client's protocol. */
const SUCCESS_CAPABILITIES = {
	app_container_available: true,
	lpac_available: true,
	restricted_token_available: false,
	private_desktop_creatable: true,
	integrity_level: 'medium',
	is_admin: false,
	os_version: '10.0.26100',
	arch: 'x64',
	runner_version: '0.1.0',
	protocol_schema_version: RUNNER_PROTOCOL_SCHEMA_VERSION,
};

/** A transient spawn failure (EBUSY-class) as spawnSync reports it. */
function transientSpawnFailure() {
	return {
		status: null,
		stdout: '',
		stderr: '',
		error: Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY' }),
	};
}

/** A healthy probe outcome (status 0 + protocol-matching capabilities). */
function successfulSpawn() {
	return {
		status: 0,
		stdout: JSON.stringify(SUCCESS_CAPABILITIES),
		stderr: '',
		error: null,
	};
}

/**
 * Inject a counted, outcome-switchable spawnRunner. Returns the call counter
 * so cadence legs can assert how many times the runner was actually probed.
 */
function injectSwitchableSpawn(outcome: { fail: boolean }) {
	let calls = 0;
	_internals.findRunnerBinary = () => RUNNER_PATH;
	_internals.spawnRunner = (() => {
		calls += 1;
		return outcome.fail ? transientSpawnFailure() : successfulSpawn();
	}) as typeof realSpawnRunner;
	return {
		calls: () => calls,
	};
}

/** freezeClock at `at` and run `fn`; always restore (test-clock contract). */
function at<T>(atMs: number, fn: () => T): T {
	const restore: Restore = freezeClock({ fixedNow: atMs });
	try {
		return fn();
	} finally {
		restore();
	}
}

describe('#3736 AC2: win32 runner-probe transient-failure recovery', () => {
	test.skipIf(!isWin)(
		'baseline: a transient spawn failure reports unavailable and a constructed executor is weak',
		() => {
			const spawn = injectSwitchableSpawn({ fail: true });
			fallbackInternals.probeWindowsSandbox = () => true;
			const result = at(T0, () => probe());
			expect(result.available).toBe(false);
			expect(result.mode).toBe('none');
			expect(result.error ?? '').toContain('spawn error');
			expect(spawn.calls()).toBe(1);
			const executor = at(T0, () => new NativeWindowsSandboxExecutor([]));
			expect(executor.strength).toBe('weak');
			expect(executor.mechanism).toBe('powershell-wrapper');
		},
	);

	test.skipIf(!isWin)(
		'recovery (RED at base): past the transient-failure TTL a re-probe succeeds and a freshly constructed executor is strong',
		() => {
			const outcome = { fail: true };
			const spawn = injectSwitchableSpawn(outcome);
			fallbackInternals.probeWindowsSandbox = () => true;

			// t0: transient failure observed and cached.
			const failed = at(T0, () => probe());
			expect(failed.available).toBe(false);
			expect(spawn.calls()).toBe(1);
			const weak = at(T0, () => new NativeWindowsSandboxExecutor([]));
			expect(weak.strength).toBe('weak');

			// The transient condition clears; the clock advances well past any
			// sane failure TTL. Base behavior: the set-once cache pins the
			// failure forever — probe() does NOT re-spawn and stays unavailable.
			outcome.fail = false;
			const recovered = at(T0 + ONE_DAY_MS, () => probe());
			expect(recovered.available).toBe(true);
			expect(recovered.mode).toBe('app-container');
			expect(spawn.calls()).toBe(2);
			const strong = at(
				T0 + ONE_DAY_MS,
				() => new NativeWindowsSandboxExecutor([]),
			);
			expect(strong.strength).toBe('strong');
			expect(strong.mechanism).toBe('native-runner/app-container');
		},
	);

	test.skipIf(!isWin)(
		'within the TTL the cached failure is returned without re-spawning (bounded re-probe cadence)',
		() => {
			const spawn = injectSwitchableSpawn({ fail: true });
			const first = at(T0, () => probe());
			expect(first.available).toBe(false);
			// Same frozen instant — strictly inside any positive TTL: the second
			// call must reuse the cached failure rather than spawn again.
			const second = at(T0, () => probe());
			expect(second.available).toBe(false);
			expect(spawn.calls()).toBe(1);
		},
	);

	test.skipIf(!isWin)(
		'success is permanent: a successful probe is never re-spawned across a long clock advance',
		() => {
			const spawn = injectSwitchableSpawn({ fail: false });
			const first = at(T0, () => probe());
			expect(first.available).toBe(true);
			const later = at(T0 + ONE_DAY_MS, () => probe());
			expect(later.available).toBe(true);
			expect(later.mode).toBe('app-container');
			expect(spawn.calls()).toBe(1);
		},
	);

	test.skipIf(!isWin)(
		'executor construction seam: a getExecutor() entry rebuilt after probe recovery reports strong',
		async () => {
			const outcome = { fail: true };
			const spawn = injectSwitchableSpawn(outcome);
			fallbackInternals.probeWindowsSandbox = () => true;
			executorInternals.createPlatformExecutor = async () =>
				new NativeWindowsSandboxExecutor([]);

			const before = at(T0, () => {
				_resetExecutorCache();
				return getExecutor();
			});
			const weakFromCache =
				(await before) as NativeWindowsSandboxExecutor | null;
			expect(weakFromCache).not.toBeNull();
			expect(weakFromCache?.strength).toBe('weak');

			outcome.fail = false;
			const after = at(T0 + ONE_DAY_MS, () => {
				probe(); // trigger the recovered re-probe first
				_resetExecutorCache(); // rebuild the executor cache entry
				return getExecutor();
			});
			const recoveredExecutor = (await after) as NativeWindowsSandboxExecutor;
			expect(recoveredExecutor).not.toBeNull();
			expect(recoveredExecutor.strength).toBe('strong');
			expect(spawn.calls()).toBe(2);
		},
	);
});

describe('#3736 AC2 TTL seam contract: runnerProbeFailureTtlMs (RED at base — export absent)', () => {
	test('runner-client exports runnerProbeFailureTtlMs(): env override finite-positive only, default 60_000', () => {
		// Namespace access (not a named import) so this leg fails as a clean
		// per-test assertion at base instead of a whole-file link error.
		const resolver = (
			runnerClientModule as { runnerProbeFailureTtlMs?: () => number }
		).runnerProbeFailureTtlMs;
		expect(typeof resolver).toBe('function');
		const ttl = resolver as () => number;

		delete process.env[TTL_ENV];
		expect(ttl()).toBe(60_000);
		for (const bad of ['0', '-5', 'not-a-number', 'Infinity', '']) {
			process.env[TTL_ENV] = bad;
			expect(ttl()).toBe(60_000);
		}
		process.env[TTL_ENV] = '10';
		expect(ttl()).toBe(10);
		delete process.env[TTL_ENV];
	});
});
