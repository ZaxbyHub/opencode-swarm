import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	awaitingMergeByCallID,
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import type { MergeOperationProvenance } from '../../../src/worktree/merge';
import { _internals as settlementSourceInternals } from '../../../src/worktree/settlement-source-recovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: 60_000,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function fixture(label: string): {
	root: string;
	worktree: string;
	dispatch: StandardWorktreeDispatch;
} {
	const root = canonicalMkdtemp(`merge-3409-${label}-`);
	roots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'tests@example.invalid');
	git(root, 'config', 'user.name', 'Tests');
	git(root, 'config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
	fs.writeFileSync(path.join(root, 'stable.txt'), 'base\n');
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	const worktree = path.join(root, '.swarm', 'worktrees', label);
	fs.mkdirSync(path.dirname(worktree), { recursive: true });
	const branchName = `swarm/lane/${label}`;
	git(root, 'worktree', 'add', '-b', branchName, worktree);
	fs.writeFileSync(path.join(worktree, 'shared.txt'), 'lane\n');
	const callID = `call-${label}`;
	const dispatch: StandardWorktreeDispatch = {
		callID,
		parentSessionID: `parent-${label}`,
		taskId: '1.1',
		handle: {
			worktreePath: worktree,
			branchName,
			purpose: 'lane',
			id: label,
			sessionId: label,
		},
		mergeStrategy: 'merge',
		laneIndex: 0,
	};
	awaitingMergeByCallID.set(callID, {
		callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: branchName,
		worktreePath: worktree,
		mergeStrategy: 'merge',
		queuedAt: 1,
	});
	return { root, worktree, dispatch };
}

function retrack(dispatch: StandardWorktreeDispatch): void {
	awaitingMergeByCallID.set(dispatch.callID, {
		callID: dispatch.callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: dispatch.handle.branchName,
		worktreePath: dispatch.handle.worktreePath,
		mergeStrategy: 'merge',
		queuedAt: 1,
	});
}

const originalSettlementBunSpawn = settlementSourceInternals.bunSpawn;

/**
 * Makes `releaseSettlementSource` fail without touching its module: the
 * file-local `_internals.bunSpawn` seam swaps exactly the git call that the
 * release depends on for a harmless `--version`.
 *  - `delete-ref`: the backup-ref deletion silently does nothing, so the
 *    post-delete re-read still finds the ref and release throws.
 *  - `ref-probe`: the symbolic-ref probe reports an unexpected status, so
 *    release throws before it can early-return on an absent ref.
 */
function sabotageSettlementRelease(mode: 'delete-ref' | 'ref-probe'): void {
	settlementSourceInternals.bunSpawn = ((
		cmd: Parameters<typeof originalSettlementBunSpawn>[0],
		opts: Parameters<typeof originalSettlementBunSpawn>[1],
	) => {
		const args = cmd.slice(1);
		const sabotage =
			mode === 'delete-ref'
				? args[0] === 'update-ref' && args.includes('-d')
				: args[0] === 'symbolic-ref' && args[1] === '-q';
		return originalSettlementBunSpawn(
			sabotage ? [cmd[0], '--version'] : cmd,
			opts,
		);
	}) as typeof originalSettlementBunSpawn;
}

function parentCount(root: string): number {
	return (
		git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length - 1
	);
}

function releaseWarnings(): string[] {
	return getDeferredWarnings().filter((warning) =>
		warning.includes('releasing preserved settlement source'),
	);
}

afterEach(() => {
	settlementSourceInternals.bunSpawn = originalSettlementBunSpawn;
	clearDeferredWarnings();
	resetStandardWorktreeIsolationState();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('issue #3409 stored merge settlement retarget and release recovery', () => {
	/**
	 * Crashes the first attempt after provenance persistence (before any Git
	 * landing) WITHOUT `commitLanding`, so a 'merge' dispatch maps to the
	 * squash-unstaged landing on the normal path.
	 */
	async function crashBeforeUncommittedLanding(
		root: string,
		dispatch: StandardWorktreeDispatch,
		operationId: string,
	): Promise<MergeOperationProvenance> {
		let provenance: MergeOperationProvenance | undefined;
		const first = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId,
				onBeforeMerge: async (record) => {
					provenance = record;
					throw new Error(
						'simulate crash after provenance persistence, before Git landing',
					);
				},
			},
		);
		expect(first.outcome).toBe('failed');
		if (!provenance) throw new Error('provenance was not persisted');
		return provenance;
	}

	function expectSquashUnstagedLanding(
		root: string,
		headBeforeResume: string,
		parentsBeforeResume: number,
	): void {
		// No merge commit and HEAD did not move; the lane change is present in the
		// working tree as an UNSTAGED modification.
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBeforeResume);
		expect(parentCount(root)).toBe(parentsBeforeResume);
		expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(
			'lane\n',
		);
		expect(git(root, 'diff', '--name-only')).toBe('shared.txt');
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
	}

	test('retarget recovery without commitLanding lands squash-unstaged like the normal path (F-02)', async () => {
		const { root, dispatch } = fixture('retarget-unstaged');
		const provenance = await crashBeforeUncommittedLanding(
			root,
			dispatch,
			'transition-retarget-unstaged',
		);

		fs.writeFileSync(path.join(root, 'stable.txt'), 'later target change\n');
		git(root, 'add', 'stable.txt');
		git(root, 'commit', '-m', 'advance target independently');
		const advancedHead = git(root, 'rev-parse', 'HEAD');
		const advancedParents = parentCount(root);
		retrack(dispatch);

		const recovered = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-retarget-unstaged',
				resume: provenance,
				onMerged: async () => {},
			},
		);

		expect(recovered).toMatchObject({
			outcome: 'merged',
			strategy: 'squash-unstaged',
			reconciled: false,
		});
		expectSquashUnstagedLanding(root, advancedHead, advancedParents);
		expect(fs.readFileSync(path.join(root, 'stable.txt'), 'utf8')).toBe(
			'later target change\n',
		);
		// The squash landing is not an ancestor of HEAD, so the lane branch and
		// the preserved source ref are retained exactly like the worktree-match
		// reconciliation retains them.
		expect(git(root, 'branch', '--list', dispatch.handle.branchName)).not.toBe(
			'',
		);
		expect(
			git(
				root,
				'rev-parse',
				'--verify',
				`refs/swarm/coder-settlements/${provenance.sourceHead}`,
			),
		).toBe(provenance.sourceHead);

		// Idempotent: a further resume reconciles through worktree-match and does
		// not land a second time.
		retrack(dispatch);
		const repeated = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-retarget-unstaged',
				resume: provenance,
				onMerged: async () => {},
			},
		);
		expect(repeated).toMatchObject({
			outcome: 'merged',
			strategy: 'squash-unstaged',
			reconciled: true,
		});
		expectSquashUnstagedLanding(root, advancedHead, advancedParents);
	});

	test('orphan-restored lane branch with an unadvanced target also lands squash-unstaged (F-02)', async () => {
		const { root, dispatch } = fixture('orphan-unstaged');
		const provenance = await crashBeforeUncommittedLanding(
			root,
			dispatch,
			'transition-orphan-unstaged',
		);
		const headBefore = git(root, 'rev-parse', 'HEAD');
		const parentsBefore = parentCount(root);
		expect(headBefore).toBe(provenance.targetHeadBefore);

		// Orphan the lane: the branch ref disappears while its commit survives
		// (the backup ref preserved by the resume path keeps it reachable).
		git(root, 'update-ref', '-d', `refs/heads/${dispatch.handle.branchName}`);
		expect(git(root, 'branch', '--list', dispatch.handle.branchName)).toBe('');
		retrack(dispatch);

		const recovered = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-orphan-unstaged',
				resume: provenance,
				onMerged: async () => {},
			},
		);

		expect(recovered).toMatchObject({
			outcome: 'merged',
			strategy: 'squash-unstaged',
		});
		expectSquashUnstagedLanding(root, headBefore, parentsBefore);
	});

	describe('release failure after a verified landing is advisory only (F-06)', () => {
		test('resume path: already-landed ancestry reconciliation still returns merged', async () => {
			const { root, worktree, dispatch } = fixture('release-resume');
			git(worktree, 'add', 'shared.txt');
			git(worktree, 'commit', '-m', 'record lane source');
			const provenance: MergeOperationProvenance = {
				operationId: 'transition-release-resume',
				sourceHead: git(worktree, 'rev-parse', 'HEAD'),
				targetHeadBefore: git(root, 'rev-parse', 'HEAD'),
				branchName: dispatch.handle.branchName,
				strategy: 'merge',
			};
			git(root, 'merge', '--no-ff', '--no-edit', dispatch.handle.branchName);
			const landedHead = git(root, 'rev-parse', 'HEAD');
			const landedParents = parentCount(root);
			retrack(dispatch);
			sabotageSettlementRelease('delete-ref');

			const result = await finishStandardWorktreeDispatch(
				root,
				dispatch,
				undefined,
				dispatch.callID,
				{
					operationId: provenance.operationId,
					commitLanding: true,
					resume: provenance,
					onMerged: async () => {},
				},
			);

			expect(result).toMatchObject({ outcome: 'merged', reconciled: true });
			expect(git(root, 'rev-parse', 'HEAD')).toBe(landedHead);
			expect(parentCount(root)).toBe(landedParents);
			const warnings = releaseWarnings();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(provenance.sourceHead);
			expect(warnings[0]).toContain('resume reconciliation');
			expect(warnings[0]).toContain('CODER_SETTLEMENT_REF_UNCERTAIN');
		});

		test('retarget path: committed recovery landing still returns merged', async () => {
			const { root, dispatch } = fixture('release-retarget');
			let provenance: MergeOperationProvenance | undefined;
			const first = await finishStandardWorktreeDispatch(
				root,
				dispatch,
				undefined,
				dispatch.callID,
				{
					operationId: 'transition-release-retarget',
					commitLanding: true,
					onBeforeMerge: async (record) => {
						provenance = record;
						throw new Error('simulate crash before Git landing');
					},
				},
			);
			expect(first.outcome).toBe('failed');
			fs.writeFileSync(path.join(root, 'stable.txt'), 'later target change\n');
			git(root, 'add', 'stable.txt');
			git(root, 'commit', '-m', 'advance target independently');
			const advancedHead = git(root, 'rev-parse', 'HEAD');
			retrack(dispatch);
			sabotageSettlementRelease('delete-ref');

			const result = await finishStandardWorktreeDispatch(
				root,
				dispatch,
				undefined,
				dispatch.callID,
				{
					operationId: 'transition-release-retarget',
					commitLanding: true,
					resume: provenance,
					onMerged: async () => {},
				},
			);

			expect(result).toMatchObject({
				outcome: 'merged',
				strategy: 'merge',
				reconciled: false,
			});
			// Exactly one landing: one new merge commit on top of the advanced head.
			expect(git(root, 'rev-parse', 'HEAD^1')).toBe(advancedHead);
			expect(parentCount(root)).toBe(2);
			expect(
				git(
					root,
					'merge-base',
					'--is-ancestor',
					provenance?.sourceHead ?? '',
					'HEAD',
				),
			).toBe('');
			const warnings = releaseWarnings();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('retarget recovery');
		});

		test('fresh path: verified committed landing still returns merged', async () => {
			const { root, dispatch } = fixture('release-fresh');
			const targetBefore = git(root, 'rev-parse', 'HEAD');
			sabotageSettlementRelease('ref-probe');

			const result = await finishStandardWorktreeDispatch(
				root,
				dispatch,
				undefined,
				dispatch.callID,
				{
					operationId: 'transition-release-fresh',
					commitLanding: true,
					onBeforeMerge: async () => {},
					onMerged: async () => {},
				},
			);

			expect(result).toMatchObject({ outcome: 'merged', strategy: 'merge' });
			// Exactly one landing: the target was unadvanced, so the single lane
			// commit fast-forwards onto it and nothing is merged a second time.
			expect(git(root, 'rev-list', '--count', `${targetBefore}..HEAD`)).toBe(
				'1',
			);
			expect(git(root, 'rev-parse', 'HEAD^1')).toBe(targetBefore);
			const warnings = releaseWarnings();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('fresh landing');
		});
	});
});
