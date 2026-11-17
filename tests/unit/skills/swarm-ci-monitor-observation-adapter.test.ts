import { describe, expect, test } from 'bun:test';
import {
	collectCheckRuns,
	observeCi,
	resolveMergeObservation,
} from '../../../.opencode/skills/swarm-ci-monitor/scripts/observe-ci';

const headSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const baseTip = 'd'.repeat(40);
const request = {
	repository: 'example/swarm',
	number: 42,
	headSha,
	candidateRunId: 123,
};
const pr = {
	...request,
	baseRefName: 'release/stable',
	state: 'MERGED' as const,
	mergeCommitSha: mergeSha,
};

describe('swarm CI monitor observation adapter', () => {
	test('rejects 1,001 suites before fetching any check-run pages', async () => {
		const pulls = 'repos/example/swarm/pulls/42';
		const suites = `repos/example/swarm/commits/${headSha}/check-suites?per_page=1`;
		const calls: Array<[string, string]> = [];
		const result = await observeCi(
			{ repository: request.repository, number: request.number, headSha },
			(program, argv) => {
				const endpoint = argv[3];
				calls.push([program, endpoint]);
				if (endpoint === pulls) {
					return JSON.stringify({ ...pr, state: 'OPEN', mergeCommitSha: null });
				}
				if (endpoint === suites) return '1001';
				throw new Error(`Unexpected observation request: ${endpoint}`);
			},
		);

		expect(result.census).toEqual({
			state: 'incomplete',
			checks: [],
			totalCount: null,
			reason: 'suite-limit',
		});
		expect(calls).toEqual([
			['gh', pulls],
			['gh', suites],
			['gh', pulls],
		]);
	});

	test('caps a transport that never reaches its last page', async () => {
		const result = await collectCheckRuns(headSha, async (page) => ({
			totalCount: 100,
			hasNext: true,
			checks: [
				{ id: page, headSha, name: 'unit', status: 'queued', conclusion: null },
			],
		}));
		expect(result).toMatchObject({
			state: 'incomplete',
			reason: 'page-limit',
			totalCount: 100,
		});
		expect(result.checks).toHaveLength(20);
	});

	test('requires a merge commit and treats independent proof errors as unconfirmed', async () => {
		let proofs = 0;
		const verify = async () => {
			proofs++;
			throw new Error('git object unavailable');
		};
		const results = await Promise.all([
			resolveMergeObservation(
				pr,
				{ ...pr, mergeCommitSha: null },
				null,
				verify,
			),
			resolveMergeObservation(pr, { ...pr, state: 'CLOSED' }, null, verify),
			resolveMergeObservation(pr, pr, null, verify),
		]);
		expect(proofs).toBe(1);
		expect(
			results.map(({ state, reason, mergeCommitSha }) => [
				state,
				reason,
				mergeCommitSha,
			]),
		).toEqual([
			['unconfirmed', 'invalid-merge-commit', null],
			['unconfirmed', 'pull-not-merged', null],
			['unconfirmed', 'base-proof-unavailable', null],
		]);
	});

	test('queries both exact-head pages and checks ancestry against the advertised target ref', async () => {
		const calls: string[][] = [];
		const checks = Array.from({ length: 51 }, (_, i) => ({
			id: i + 1,
			headSha,
			name: 'unit',
			status: 'completed',
			conclusion: i === 50 ? 'failure' : 'success',
		}));
		const result = await observeCi(request, (program, argv) => {
			calls.push([program, ...argv]);
			const path = argv[3];
			if (path === 'repos/example/swarm/pulls/42') return JSON.stringify(pr);
			if (
				path ===
				`repos/example/swarm/commits/${headSha}/check-suites?per_page=1`
			)
				return '1';
			if (
				path ===
				`repos/example/swarm/commits/${headSha}/check-runs?per_page=50&page=1`
			) {
				return JSON.stringify({ totalCount: 51, checks: checks.slice(0, 50) });
			}
			if (
				path ===
				`repos/example/swarm/commits/${headSha}/check-runs?per_page=50&page=2`
			) {
				return JSON.stringify({ totalCount: 51, checks: checks.slice(50) });
			}
			if (path === 'repos/example/swarm/actions/runs/123') {
				return JSON.stringify({
					...request,
					id: 123,
					event: 'merge_group',
					branch: `gh-readonly-queue/release/stable/pr-42-${baseTip}`,
					headSha: candidateSha,
					status: 'UNKNOWN',
					conclusion: null,
				});
			}
			if (program === 'git' && argv[0] === 'ls-remote')
				return `${baseTip}\trefs/heads/release/stable\n`;
			if (program === 'git' && argv[1] === 'merge-base') return '';
			throw new Error('unexpected command in fixture');
		});
		expect(result.census).toMatchObject({ state: 'complete', checks });
		expect(result.merge).toMatchObject({
			state: 'merged',
			headSha,
			mergeCommitSha: mergeSha,
			candidate: { headSha: candidateSha, status: 'UNKNOWN' },
		});
		expect(calls.filter(([program]) => program === 'git')).toEqual([
			[
				'git',
				'ls-remote',
				'--exit-code',
				'https://github.com/example/swarm.git',
				'refs/heads/release/stable',
			],
			[
				'git',
				'--no-replace-objects',
				'merge-base',
				'--is-ancestor',
				mergeSha,
				baseTip,
			],
		]);
	});

	test('invalidates an otherwise complete census when the PR changes during the read', async () => {
		let pulls = 0;
		const result = await observeCi(
			{ ...request, candidateRunId: undefined },
			(program, argv) => {
				if (program === 'git') throw new Error('unexpected Git proof');
				if (argv[3].includes('/pulls/'))
					return JSON.stringify({
						...pr,
						headSha: pulls++ ? baseTip : headSha,
					});
				if (argv[3].includes('/check-suites?')) return '1';
				return JSON.stringify({ totalCount: 0, checks: [] });
			},
		);
		expect(pulls).toBe(2);
		expect(result.census).toMatchObject({
			state: 'incomplete',
			reason: 'pull-identity-changed',
		});
		expect(result.merge).toMatchObject({
			state: 'unconfirmed',
			reason: 'pull-identity-changed',
		});
	});
});
