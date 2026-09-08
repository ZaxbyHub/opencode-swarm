import { describe, expect, test } from 'bun:test';
import {
	inputFromFixture,
	loadPrepareRunner,
	loadPublishRunner,
	PIPELINE_STAGES,
	type PrepareDependencies,
	type PublishDependencies,
	readDemoFixture,
} from './github-action-contract';

describe('issue #2498 — separated prepare and verified publish', () => {
	test('runs all ordered stages before binding an artifact without a write token', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		const stages: string[] = [];
		const dependencies: PrepareDependencies = {
			authorize: async (input) => {
				expect('publicationToken' in input).toBe(false);
				return true;
			},
			createRuntime: () => ({
				run: async () => {},
				kill: async () => {},
				cleanup: async () => {},
			}),
			executeStage: async (stage, context) => {
				stages.push(stage);
				expect(context.publicationToken).toBeUndefined();
			},
			evaluateGate: async () => 'approved',
			bindArtifact: async (input) => ({
				repository: input.repository,
				issueNumber: input.issueNumber,
				deliveryId: input.deliveryId,
				baseSha: 'base',
				evidence: 'green',
			}),
			isTransient: () => false,
			sleep: async () => {},
		};
		const artifact = await prepare(inputFromFixture(fixture), dependencies);
		expect(stages).toEqual(PIPELINE_STAGES);
		expect('status' in artifact).toBe(false);
	});

	test('rejects a tampered artifact before branch claim or publication', async () => {
		const publish = await loadPublishRunner();
		let claimed = 0;
		let published = 0;
		const result = await publish(
			{
				artifact: {
					repository: 'wrong',
					issueNumber: 17,
					deliveryId: 'delivery',
					baseSha: 'old',
					evidence: 'tampered',
				},
				publicationToken: 'write-token',
				expectedBaseSha: 'base',
			},
			{
				verifyArtifact: async () => false,
				claimBranch: async () => {
					claimed += 1;
					return { branch: 'bad', state: 'claimed' };
				},
				publish: async () => {
					published += 1;
					return {
						branch: 'bad',
						prUrl: 'bad',
						evidence: 'bad',
						summary: 'bad',
					};
				},
			},
		);
		expect(result.status).toBe('failed');
		expect(claimed).toBe(0);
		expect(published).toBe(0);
	});
});
