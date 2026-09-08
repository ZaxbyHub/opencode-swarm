import { describe, expect, test } from 'bun:test';
import {
	type GateDecision,
	inputFromFixture,
	loadPrepareRunner,
	type PrepareDependencies,
	readDemoFixture,
} from './github-action-contract';

describe('issue #2498 — gate denial is non-publishable', () => {
	for (const decision of ['oversight-denied', 'gate-failed'] as const) {
		test(`${decision} creates no artifact`, async () => {
			const prepare = await loadPrepareRunner();
			const fixture = readDemoFixture();
			let artifacts = 0;
			const dependencies: PrepareDependencies = {
				authorize: async () => true,
				createRuntime: () => ({
					run: async () => {},
					kill: async () => {},
					cleanup: async () => {},
				}),
				executeStage: async () => {},
				evaluateGate: async (): Promise<GateDecision> => decision,
				bindArtifact: async () => {
					artifacts += 1;
					throw new Error('unreachable');
				},
				isTransient: () => false,
				sleep: async () => {},
			};
			const result = await prepare(inputFromFixture(fixture), dependencies);
			expect(result).toEqual({
				status: decision === 'oversight-denied' ? 'denied' : 'failed',
			});
			expect(artifacts).toBe(0);
		});
	}
});
