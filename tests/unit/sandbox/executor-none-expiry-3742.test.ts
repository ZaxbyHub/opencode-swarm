/**
 * #3743 (AC6, CI-tracked): the none-strength executor must be TTL-bounded in
 * getExecutor like null/weak (#3736 D8), and /swarm diagnose must never
 * report a none-strength executor as green. Drives getExecutor end-to-end
 * through the _internals.createPlatformExecutor seam (no manual cache reset
 * in the recovery legs), mirroring executor-weak-expiry-3736.test.ts. The
 * post-construction disable() transition (strong -> none by explicit runtime
 * decision) is OUT_OF_CLASS by design — see the trace's 08a disposition.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	_resetExecutorCache,
	_internals as executorInternals,
	getExecutor,
	type SandboxExecutor,
} from '../../../src/sandbox/executor';
import {
	_internals as diagnoseInternals,
	getDiagnoseData,
} from '../../../src/services/diagnose-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

interface StubExecutor extends SandboxExecutor {
	strength: 'strong' | 'weak' | 'none';
}

function stubExecutor(strength: 'strong' | 'weak' | 'none'): StubExecutor {
	return {
		mechanism: strength === 'none' ? 'none' : `stub-${strength}`,
		strength,
		isAvailable: () => strength !== 'none',
	};
}

const TTL_ENV = 'SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS';

describe('#3743 none-strength executor expiry (AC6)', () => {
	const originalCreate = executorInternals.createPlatformExecutor;
	const originalTtl = process.env[TTL_ENV];

	afterEach(() => {
		executorInternals.createPlatformExecutor = originalCreate;
		if (originalTtl === undefined) delete process.env[TTL_ENV];
		else process.env[TTL_ENV] = originalTtl;
		_resetExecutorCache();
	});

	test('initially-none executor is reused within the TTL', async () => {
		process.env[TTL_ENV] = '10000';
		let creations = 0;
		executorInternals.createPlatformExecutor = (() => {
			creations += 1;
			return Promise.resolve(stubExecutor('none'));
		}) as typeof executorInternals.createPlatformExecutor;
		const first = (await getExecutor()) as StubExecutor;
		const second = (await getExecutor()) as StubExecutor;
		expect(first.strength).toBe('none');
		expect(second).toBe(first); // same memoized entry within TTL
		expect(creations).toBe(1);
	}, 20_000);

	test('initially-none executor expires past the TTL and recovers strong (no manual reset)', async () => {
		process.env[TTL_ENV] = '20';
		let creations = 0;
		let next: 'none' | 'strong' = 'none';
		executorInternals.createPlatformExecutor = (() => {
			creations += 1;
			const s = stubExecutor(next);
			next = 'strong';
			return Promise.resolve(s);
		}) as typeof executorInternals.createPlatformExecutor;
		const first = (await getExecutor()) as StubExecutor;
		expect(first.strength).toBe('none');
		await new Promise((r) => setTimeout(r, 80));
		const second = (await getExecutor()) as StubExecutor;
		expect(second.strength).toBe('strong');
		expect(creations).toBe(2);
	}, 20_000);

	test('strong executor stays permanent (contrast leg, unchanged from #3736)', async () => {
		process.env[TTL_ENV] = '20';
		let creations = 0;
		executorInternals.createPlatformExecutor = (() => {
			creations += 1;
			return Promise.resolve(stubExecutor('strong'));
		}) as typeof executorInternals.createPlatformExecutor;
		await getExecutor();
		await new Promise((r) => setTimeout(r, 60));
		await getExecutor();
		expect(creations).toBe(1);
	}, 20_000);

	test('diagnose maps a none-strength executor to a non-green status (#3743)', async () => {
		const realDetect = diagnoseInternals.detectSandboxCapability;
		const realGetExecutor = diagnoseInternals.getSandboxExecutor;
		const dir = canonicalMkdtemp('ac6-none-diagnose-');
		try {
			// Capability reports strong; the executor reports none — the
			// diagnose mapping must downgrade instead of reporting green.
			diagnoseInternals.detectSandboxCapability = (() =>
				Promise.resolve({
					status: 'enabled',
					strength: 'strong',
					mechanism: 'native-runner/app-container',
					platform: process.platform,
					v: 1,
					filesystem: 'real',
					network: 'real',
					process: 'real',
					effective: 'real',
					reasons: [],
					identity: 'synthetic:strong:native-runner',
				} as never)) as typeof realDetect;
			diagnoseInternals.getSandboxExecutor = (() =>
				Promise.resolve(
					stubExecutor('none') as never,
				)) as typeof realGetExecutor;
			const data = await getDiagnoseData(dir);
			const sandbox = data.checks.find((check) => check.name === 'Sandbox');
			expect(sandbox).toBeDefined();
			expect(sandbox?.status).not.toBe('✅');
		} finally {
			diagnoseInternals.detectSandboxCapability = realDetect;
			diagnoseInternals.getSandboxExecutor = realGetExecutor;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
