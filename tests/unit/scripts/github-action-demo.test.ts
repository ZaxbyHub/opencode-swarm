import { describe, expect, test } from 'bun:test';
import {
	type ActionArtifact,
	inputFromFixture,
	loadPrepareRunner,
	loadPublishRunner,
	type PrepareDependencies,
	type PublishDependencies,
	readDemoFixture,
} from './github-action-contract';

describe('issue #2498 — hermetic two-phase demo', () => {
	test('redacts a secret sentinel and reuses the first publication', async () => {
		const fixture = readDemoFixture();
		const prepare = await loadPrepareRunner();
		const publish = await loadPublishRunner();
		let claimed = false;
		let publishCalls = 0;
		const dependencies: PrepareDependencies = {
			authorize: async () => true,
			createRuntime: () => ({
				run: async () => {},
				kill: async () => {},
				cleanup: async () => {},
			}),
			executeStage: async () => {},
			evaluateGate: async () => 'approved',
			bindArtifact: async (input) => ({
				repository: input.repository,
				issueNumber: input.issueNumber,
				deliveryId: input.deliveryId,
				baseSha: 'base',
				evidence: `candidate:${input.providerSecret}`,
			}),
			isTransient: () => false,
			sleep: async () => {},
		};
		const candidate = await prepare(
			inputFromFixture(fixture, { providerSecret: fixture.secretSentinel }),
			dependencies,
		);
		expect(JSON.stringify(candidate)).not.toContain(fixture.secretSentinel);
		const artifact = candidate as ActionArtifact;
		const publicationDeps: PublishDependencies = {
			verifyArtifact: async () => true,
			claimBranch: async () => {
				if (claimed)
					return {
						branch: 'swarm/demo-17',
						state: 'existing',
						prUrl: 'https://example.test/pr/17',
					};
				claimed = true;
				return { branch: 'swarm/demo-17', state: 'claimed' };
			},
			publish: async ({ claim }) => {
				publishCalls += 1;
				return {
					branch: claim.branch,
					prUrl: 'https://example.test/pr/17',
					evidence: 'green',
					summary: 'one PR',
				};
			},
		};
		const input = {
			artifact,
			publicationToken: 'write-token',
			expectedBaseSha: 'base',
		};
		const first = await publish(input, publicationDeps);
		const second = await publish(input, publicationDeps);
		expect([first.status, second.status]).toEqual(['published', 'reused']);
		expect(publishCalls).toBe(1);
		expect(JSON.stringify({ first, second })).not.toContain(
			fixture.secretSentinel,
		);
	});
});
