import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfirmedGitAlignment } from '../../../src/git/branch.js';
import {
	_internals,
	confirmedGitAlignmentDigestProjection,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../../../src/git/branch.js';

const cwd = '/confirmed-alignment-test';
const originalSpawnSync = _internals.spawnSync;
const originalResolveGitExecutable = _internals.resolveGitExecutable;

function plan(): ConfirmedGitAlignment {
	return Object.freeze({
		defaultBranch: 'main',
		targetRef: 'origin/main',
		targetSha: 'target-old',
		targetAvailable: true,
		currentBranch: 'feature',
		currentHeadSha: 'feature-head',
		branchCandidates: Object.freeze([
			Object.freeze({
				name: 'feature',
				tipSha: 'feature-tip',
				reason: 'automatic prior branch',
			}),
		]),
	});
}

function unavailablePlan(): ConfirmedGitAlignment {
	return Object.freeze({
		...plan(),
		targetSha: '',
		targetAvailable: false,
		branchCandidates: Object.freeze([]),
	});
}

function installGitDouble(
	options: {
		advanceTargetAfterFetch?: boolean;
		movedCandidateAfterFetch?: boolean;
		landedArtifact?: boolean;
	} = {},
): string[][] {
	const calls: string[][] = [];
	let fetched = false;
	_internals.resolveGitExecutable = () => 'git';
	_internals.spawnSync = ((_command, args) => {
		const argv = [...args];
		calls.push(argv);
		const [subcommand, firstArg] = argv;
		if (subcommand === 'fetch') {
			fetched = true;
			return { status: 0, stdout: '', stderr: '' } as never;
		}
		if (subcommand === 'rev-parse' && firstArg === 'origin/main') {
			return {
				status: 0,
				stdout:
					options.advanceTargetAfterFetch && fetched
						? 'target-new\n'
						: 'target-old\n',
				stderr: '',
			} as never;
		}
		if (subcommand === 'rev-parse' && firstArg === 'HEAD') {
			return { status: 0, stdout: 'feature-head\n', stderr: '' } as never;
		}
		if (subcommand === 'rev-parse' && firstArg === '--abbrev-ref') {
			return { status: 0, stdout: 'feature\n', stderr: '' } as never;
		}
		if (subcommand === 'rev-parse' && firstArg === 'refs/heads/feature') {
			return {
				status: 0,
				stdout: `${options.movedCandidateAfterFetch && fetched ? 'feature-moved' : 'feature-tip'}\n`,
				stderr: '',
			} as never;
		}
		if (subcommand === 'rev-parse' && firstArg === 'refs/heads/lane/review') {
			return { status: 0, stdout: 'lane-tip\n', stderr: '' } as never;
		}
		if (subcommand === 'status' || subcommand === 'log') {
			return { status: 0, stdout: '', stderr: '' } as never;
		}
		if (subcommand === 'merge-base') {
			return { status: 0, stdout: '', stderr: '' } as never;
		}
		if (subcommand === 'diff') {
			return {
				status: options.landedArtifact === false ? 1 : 0,
				stdout: '',
				stderr: '',
			} as never;
		}
		return { status: 0, stdout: '', stderr: '' } as never;
	}) as typeof _internals.spawnSync;
	return calls;
}

function mutatingCalls(calls: string[][]): string[][] {
	return calls.filter(
		(args) =>
			['checkout', 'reset', 'clean'].includes(args[0]) ||
			(args[0] === 'branch' && args[1] === '-d'),
	);
}

afterEach(() => {
	_internals.spawnSync = originalSpawnSync;
	_internals.resolveGitExecutable = originalResolveGitExecutable;
});

describe('confirmed Git alignment', () => {
	test('aggressive alignment aborts before mutation when fetch advances target', async () => {
		const calls = installGitDouble({ advanceTargetAfterFetch: true });
		const result = await resetToMainAfterMerge(cwd, {
			confirmedPlan: plan(),
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('confirmed Git alignment plan changed');
		expect(mutatingCalls(calls)).toEqual([]);
	});

	test('cautious alignment aborts before mutation when fetch advances target', async () => {
		const calls = installGitDouble({ advanceTargetAfterFetch: true });
		const result = await resetToRemoteBranch(cwd, {
			confirmedPlan: plan(),
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('confirmed Git alignment plan changed');
		expect(mutatingCalls(calls)).toEqual([]);
	});

	test('confirmed unavailable target skips both paths before fetch', async () => {
		const aggressiveCalls = installGitDouble();
		const aggressive = await resetToMainAfterMerge(cwd, {
			confirmedPlan: unavailablePlan(),
		});
		expect(aggressive.success).toBe(false);
		expect(aggressive.message).toContain('no remote target');
		expect(aggressiveCalls).toEqual([]);

		const cautiousCalls = installGitDouble();
		const cautious = await resetToRemoteBranch(cwd, {
			confirmedPlan: unavailablePlan(),
		});
		expect(cautious.success).toBe(false);
		expect(cautious.message).toContain('no remote target');
		expect(cautiousCalls).toEqual([]);
	});

	test('aggressive alignment deletes an unchanged frozen candidate', async () => {
		const calls = installGitDouble();
		const result = await resetToMainAfterMerge(cwd, {
			confirmedPlan: plan(),
			pruneBranches: true,
		});

		expect(result.success).toBe(true);
		expect(result.branchDeleted).toBe(true);
		expect(calls).toContainEqual(['reset', '--hard', 'target-old']);
		expect(calls).toContainEqual(['branch', '-d', '--', 'feature']);
	});

	test('confirmed alignment does not prune without explicit opt-in', async () => {
		const calls = installGitDouble();
		const result = await resetToMainAfterMerge(cwd, {
			confirmedPlan: plan(),
		});

		expect(result.success).toBe(true);
		expect(result.branchDeleted).toBe(false);
		expect(calls.some((args) => args[0] === 'branch' && args[1] === '-d')).toBe(
			false,
		);
	});

	test('moved frozen candidates and newly discovered branches are not deleted', async () => {
		const calls = installGitDouble({ movedCandidateAfterFetch: true });
		const result = await resetToMainAfterMerge(cwd, {
			confirmedPlan: plan(),
			pruneBranches: true,
		});

		expect(result.success).toBe(true);
		expect(result.branchDeleted).toBe(false);
		expect(calls.some((args) => args[0] === 'branch' && args[1] === '-d')).toBe(
			false,
		);
	});

	test('retained divergent candidates use exact compare-and-delete', async () => {
		const calls = installGitDouble();
		const retainedPlan: ConfirmedGitAlignment = Object.freeze({
			...plan(),
			branchCandidates: Object.freeze([
				Object.freeze({
					name: 'lane/review',
					tipSha: 'lane-tip',
					reason: 'retained squash recovery branch',
				}),
			]),
			retainedRecoveryAuthorities: Object.freeze([
				Object.freeze({
					authorityDigest: 'authority-digest',
					branchName: 'lane/review',
					branchTipSha: 'lane-tip',
					resultTree: 'result-tree',
					changedPaths: Object.freeze(['artifact.txt']),
				}),
			]),
		});

		const result = await resetToMainAfterMerge('/confirmed-alignment-test', {
			confirmedPlan: retainedPlan,
			pruneBranches: true,
		});

		expect(result.success).toBe(true);
		expect(calls).toContainEqual([
			'update-ref',
			'-d',
			'refs/heads/lane/review',
			'lane-tip',
		]);
		expect(calls.some((args) => args[0] === 'branch' && args[1] === '-d')).toBe(
			false,
		);
	});

	test('retained divergent candidates stay when the landed-artifact fence fails', async () => {
		const calls = installGitDouble({ landedArtifact: false });
		const retainedPlan: ConfirmedGitAlignment = Object.freeze({
			...plan(),
			branchCandidates: Object.freeze([
				Object.freeze({
					name: 'lane/review',
					tipSha: 'lane-tip',
					reason: 'retained squash recovery branch',
				}),
			]),
			retainedRecoveryAuthorities: Object.freeze([
				Object.freeze({
					authorityDigest: 'authority-digest',
					branchName: 'lane/review',
					branchTipSha: 'lane-tip',
					resultTree: 'result-tree',
					changedPaths: Object.freeze(['artifact.txt']),
				}),
			]),
		});

		const result = await resetToMainAfterMerge(cwd, {
			confirmedPlan: retainedPlan,
			pruneBranches: true,
		});

		expect(result.success).toBe(true);
		expect(result.prunedBranches).toEqual([]);
		expect(result.warnings).toContain(
			'Could not verify landed squash artifact: lane/review',
		);
		expect(calls.some((args) => args[0] === 'update-ref')).toBe(false);
	});

	test('alignment digest projection follows the confirmed plan shape', () => {
		const confirmed = plan();
		expect(confirmedGitAlignmentDigestProjection(confirmed)).toEqual({
			defaultBranch: 'main',
			targetRef: 'origin/main',
			targetSha: 'target-old',
			targetAvailable: true,
			currentBranch: 'feature',
			currentHeadSha: 'feature-head',
			branchCandidates: confirmed.branchCandidates,
		});
		expect(confirmedGitAlignmentDigestProjection()).toBeNull();
	});
});
