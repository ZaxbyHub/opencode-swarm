/**
 * #3736 D8 sibling suite (plan v3, critic round 1): a WEAK executor outcome no
 * longer pins for the process lifetime. The frozen runner-probe suite drives
 * probe()/_resetProbeCache() manually, so it cannot detect the deletion of the
 * weak-executor expiry in getExecutor() — this suite drives getExecutor()
 * END-TO-END through the _internals.createPlatformExecutor seam with NO manual
 * probe() or cache-reset calls in the recovery legs: within-TTL reuse,
 * automatic post-TTL strong recovery, one-creation-per-window cadence, and
 * concurrent in-flight sharing.
 *
 * RED at base c12cd853d (weak executors were Infinity-pinned; the suite file
 * does not exist there), GREEN after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	_getMacOSSandboxPolicyForTest,
	_internals,
	_resetExecutorCache,
	getExecutor,
	type SandboxExecutor,
	setMacOSSandboxPolicy,
} from '../../../src/sandbox/executor';

interface StubExecutor extends SandboxExecutor {
	stub: true;
}

function stubExecutor(strength: 'strong' | 'weak'): StubExecutor {
	return {
		stub: true,
		strength,
		isAvailable: () => strength !== 'none',
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

describe('executor weak-expiry (#3736 D8)', () => {
	test('a weak executor is reused within the TTL window', async () => {
		delete process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS;
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return stubExecutor('weak');
		};
		const first = await getExecutor();
		const second = await getExecutor();
		expect(first?.strength).toBe('weak');
		expect(second).toBe(first);
		expect(creations).toBe(1);
	}, 30_000);

	test('a weak executor AUTOMATICALLY reconstructs strong after the TTL — no manual reset', async () => {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			// creation 1: the probe failed transiently -> weak;
			// creation 2+: the probe recovered -> strong
			return stubExecutor(creations === 1 ? 'weak' : 'strong');
		};
		const weak = await getExecutor();
		expect(weak?.strength).toBe('weak');
		await new Promise((resolve) => setTimeout(resolve, 25));
		const recovered = await getExecutor();
		expect(recovered?.strength).toBe('strong');
		expect(recovered).not.toBe(weak);
		expect(creations).toBe(2);
	}, 30_000);

	test('a strong executor stays permanent across clock time (contrast leg)', async () => {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return stubExecutor('strong');
		};
		const first = await getExecutor();
		await new Promise((resolve) => setTimeout(resolve, 25));
		const second = await getExecutor();
		expect(second).toBe(first);
		expect(creations).toBe(1);
	}, 30_000);

	test('cadence: exactly one creation per TTL window while the executor stays weak', async () => {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		_resetExecutorCache();
		let creations = 0;
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return stubExecutor('weak');
		};
		await getExecutor(); // window 1 opens
		await getExecutor(); // within window 1: cached
		expect(creations).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 25)); // window 1 expires
		await getExecutor(); // window 2 opens
		await getExecutor(); // within window 2: cached
		expect(creations).toBe(2);
	}, 30_000);

	test('concurrent callers during a weak reconstruction share ONE in-flight creation', async () => {
		process.env.SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS = '10';
		_resetExecutorCache();
		let creations = 0;
		let release: (executor: StubExecutor) => void = () => {};
		const gate = new Promise<StubExecutor>((resolve) => {
			release = resolve;
		});
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			// first (gated) creation is weak; later ones strong
			if (creations === 1) return gate;
			return stubExecutor('strong');
		};
		const pendingWeak = getExecutor();
		await new Promise((resolve) => setTimeout(resolve, 5));
		release(stubExecutor('weak'));
		expect((await pendingWeak)?.strength).toBe('weak');
		// expire the weak entry, then race two callers through one reconstruction
		await new Promise((resolve) => setTimeout(resolve, 25));
		let reconRelease: (executor: StubExecutor) => void = () => {};
		const reconGate = new Promise<StubExecutor>((resolve) => {
			reconRelease = resolve;
		});
		_internals.createPlatformExecutor = async () => {
			creations += 1;
			return reconGate;
		};
		const pendingA = getExecutor();
		const pendingB = getExecutor();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(creations).toBe(2); // one weak creation + one shared reconstruction
		reconRelease(stubExecutor('strong'));
		const [a, b] = await Promise.all([pendingA, pendingB]);
		expect(a).toBe(b);
		expect(a?.strength).toBe('strong');
	}, 30_000);
});
