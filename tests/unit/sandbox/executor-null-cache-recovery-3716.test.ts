/**
 * #3716 item 3 (AC9 durable pin, amended frozen spec): a NULL executor
 * outcome no longer pins for the process lifetime — the cache re-probes a
 * failed creation after a bounded TTL while healthy executors stay permanent.
 *
 * Root cause: `getExecutor()` cached `_cachedExecutorPromise` once — a first
 * call that observed a degraded outcome (disabled probe / construction
 * failure) returned null forever. Fix: entry-local cache record; healthy =
 * Infinity, null/rejected = now + TTL (the macOS PROBE_FAILURE_TTL_MS
 * pattern). Per the CHECK_WRONG-amended spec, the fixture drives the
 * `_internals.createPlatformExecutor` construction seam (the issue's
 * "documented equivalent"): the capability-side natural states stay pinned by
 * tests/unit/sandbox/capability-probe-transient-executor-3661.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	_getMacOSSandboxPolicyForTest,
	_internals,
	_resetExecutorCache,
	executorFailureTtlMs,
	getExecutor,
	type SandboxExecutor,
	setMacOSSandboxPolicy,
} from '../../../src/sandbox/executor';

interface StubExecutor extends SandboxExecutor {
	stub: true;
}

function stubExecutor(): StubExecutor {
	return {
		stub: true,
		isAvailable: () => true,
		wrapCommand: (command: string) => command,
	} as unknown as StubExecutor;
}

const originalCreate = _internals.createPlatformExecutor;
const hadTtlEnv =
	process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS !== undefined;
const originalTtlEnv = process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS;
const originalMacOsPolicy = _getMacOSSandboxPolicyForTest();

afterEach(() => {
	_internals.createPlatformExecutor = originalCreate;
	if (hadTtlEnv) {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = originalTtlEnv;
	} else {
		delete process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS;
	}
	setMacOSSandboxPolicy(originalMacOsPolicy);
	_resetExecutorCache();
});

describe('executor null-cache recovery (#3716 item 3)', () => {
	test('a null first creation recovers after the TTL once the seam returns a healthy executor', async () => {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return creations === 1 ? null : stubExecutor();
		};
		const first = await getExecutor();
		expect(first).toBeNull();
		// Within the TTL: the null outcome is still cached.
		const immediate = await getExecutor();
		expect(immediate).toBeNull();
		expect(creations).toBe(1);
		// Past the TTL: a healthy re-probe is reflected.
		await new Promise((resolve) => setTimeout(resolve, 25));
		const recovered = await getExecutor();
		expect(recovered).not.toBeNull();
		expect(creations).toBe(2);
	}, 30_000);

	test('a healthy executor is permanent — the creator runs exactly once across sequential and parallel calls', async () => {
		delete process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS;
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return stubExecutor();
		};
		const a = await getExecutor();
		const [b, c] = await Promise.all([getExecutor(), getExecutor()]);
		expect(creations).toBe(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	}, 30_000);

	test('concurrent callers share ONE in-flight creation (both resolve the same executor, creator invoked once)', async () => {
		delete process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS;
		_resetExecutorCache();
		let creations = 0;
		// Deferred creator: the promise stays pending until the test releases
		// it, so both getExecutor() calls overlap the in-flight creation.
		let release: (executor: StubExecutor) => void = () => {};
		const gate = new Promise<StubExecutor>((resolve) => {
			release = resolve;
		});
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return gate;
		};
		const pendingA = getExecutor();
		const pendingB = getExecutor();
		// Let both callers observe the pending entry before releasing.
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(creations).toBe(1);
		release(stubExecutor());
		const [a, b] = await Promise.all([pendingA, pendingB]);
		expect(creations).toBe(1);
		expect(a).toBe(b);
	}, 30_000);

	test('a rejected creation is a bounded failure — the rejection propagates and a later call recovers', async () => {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			if (creations === 1) {
				throw new Error('construction failed');
			}
			return stubExecutor();
		};
		await expect(getExecutor()).rejects.toThrow('construction failed');
		await new Promise((resolve) => setTimeout(resolve, 25));
		const recovered = await getExecutor();
		expect(recovered).not.toBeNull();
		expect(creations).toBe(2);
	}, 30_000);

	test('invalid TTL overrides fall back to the FINITE default — no permanent null pin, no hot loop', async () => {
		for (const bad of ['0', '-5', 'not-a-number', 'Infinity', '']) {
			process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = bad;
			// The TTL resolver itself proves the fallback is the finite
			// default (a bounded expiry), not Infinity/zero.
			expect(executorFailureTtlMs()).toBe(60_000);
			_resetExecutorCache();
			let creations = 0;
			_internals.createPlatformExecutor = async () => {
				creations += 1;
				return null;
			};
			const first = await getExecutor();
			const second = await getExecutor();
			expect(first).toBeNull();
			expect(second).toBeNull();
			// The default 60s window holds: no immediate re-creation.
			expect(creations).toBe(1);
		}
		// A VALID override is honored (contrast leg: the same shape recreates).
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		expect(executorFailureTtlMs()).toBe(10);
	}, 30_000);
});
