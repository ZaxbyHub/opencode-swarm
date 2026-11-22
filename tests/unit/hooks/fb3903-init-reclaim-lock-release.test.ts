/**
 * #3903 FB-018 falsifier: a timed-out dead-lane reclaim is NOT cancelled by
 * withTimeout. The lifecycle exclusion must stay held until that in-flight
 * pass settles, otherwise a re-dispatch can publish an owner between the
 * reclaim's classification and its removal.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as recoveryInternals,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('#3903 FB-018 init reclaim lock exclusion', () => {
	it('keeps the lifecycle lock until a timed-out reclaim settles', async () => {
		const directory = canonicalMkdtemp('fb3903-init-lock-');
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });

		let releaseCalls = 0;
		let reclaimStarted = false;
		let resolveReclaim: (() => void) | undefined;
		const reclaimPromise = new Promise<{
			reclaimed: string[];
			retained: Array<{ lanePath: string; reason: string }>;
			error?: string;
		}>((resolve) => {
			resolveReclaim = () =>
				resolve({ reclaimed: [], retained: [], error: undefined });
		});

		const originalTryAcquire = recoveryInternals.tryAcquireLock;
		const originalReclaim = recoveryInternals.reclaimDeadLanes;
		const originalBudget = recoveryInternals.initOrphanRecoveryTimeoutMs;
		try {
			recoveryInternals.tryAcquireLock = mock(async () => ({
				acquired: true,
				lock: {
					_release: mock(async () => {
						releaseCalls++;
					}),
				},
			})) as never;
			recoveryInternals.reclaimDeadLanes = mock(async () => {
				reclaimStarted = true;
				return reclaimPromise;
			}) as never;
			recoveryInternals.initOrphanRecoveryTimeoutMs = 10;

			const run = runInitOrphanRecovery(directory);
			for (let i = 0; i < 100 && !reclaimStarted; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(reclaimStarted).toBe(true);
			// Budget expired, but reclaim is still in flight: exclusion must hold.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(releaseCalls).toBe(0);

			resolveReclaim?.();
			await run;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(releaseCalls).toBe(1);
		} finally {
			recoveryInternals.tryAcquireLock = originalTryAcquire;
			recoveryInternals.reclaimDeadLanes = originalReclaim;
			recoveryInternals.initOrphanRecoveryTimeoutMs = originalBudget;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
