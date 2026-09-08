import { describe, expect, test } from 'bun:test';
import {
	type ActionArtifact,
	loadPublishRunner,
	type PublishDependencies,
	readDemoFixture,
} from './github-action-contract';

describe('issue #2498 — idempotent publication', () => {
	test('concurrent duplicate deliveries converge on one PR', async () => {
		const publish = await loadPublishRunner();
		const fixture = readDemoFixture();
		let claimed = false;
		let publications = 0;
		const artifact: ActionArtifact = {
			repository: fixture.repository,
			issueNumber: fixture.issueNumber,
			deliveryId: fixture.deliveryId,
			baseSha: 'base',
			evidence: 'green',
		};
		const dependencies: PublishDependencies = {
			verifyArtifact: async () => true,
			claimBranch: async () => {
				if (claimed)
					return {
						branch: 'swarm/17',
						state: 'existing',
						prUrl: 'https://example.test/pr/17',
					};
				claimed = true;
				return { branch: 'swarm/17', state: 'claimed' };
			},
			publish: async ({ claim }) => {
				publications += 1;
				return {
					branch: claim.branch,
					prUrl: 'https://example.test/pr/17',
					evidence: 'green',
					summary: 'created',
				};
			},
		};
		const input = {
			artifact,
			publicationToken: 'write-token',
			expectedBaseSha: 'base',
		};
		const results = await Promise.all([
			publish(input, dependencies),
			publish(input, dependencies),
		]);
		expect(publications).toBe(1);
		expect(results.map((result) => result.status).sort()).toEqual([
			'published',
			'reused',
		]);
		expect(
			new Set(results.map((result) => result.publication?.prUrl)),
		).toHaveLength(1);
	});
});
