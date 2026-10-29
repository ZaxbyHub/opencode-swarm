import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	awaitingMergeByCallID,
	finishStandardWorktreeDispatch,
	_internals as isolation,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	type MergeOperationProvenance,
	_internals as merge,
	recoverMergeBackFromImmutableCoordinates,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const MESSAGE =
	'Epic-C3 exact task landing marker\n\nSwarm-Plan: 0123456789abcdef';
const originalLanding = isolation.epicCommitLandingFor;
const originalSpawn = merge.bunSpawn;
const roots: string[] = [];

function git(directory: string, ...args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

function fixture(label: string) {
	const root = canonicalMkdtemp(`settlement-epic-${label}-`);
	roots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'tests@example.invalid');
	git(root, 'config', 'user.name', 'Tests');
	git(root, 'config', 'core.autocrlf', 'false');
	git(root, 'config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	const base = git(root, 'rev-parse', 'HEAD');
	const lane = path.join(root, '.swarm', 'worktrees', label);
	const branch = `swarm/lane/${label}`;
	git(root, 'worktree', 'add', '-b', branch, lane);
	fs.writeFileSync(path.join(lane, 'source.txt'), 'lane work\n');
	git(lane, 'add', 'source.txt');
	git(lane, 'commit', '-m', 'source');
	const source = git(lane, 'rev-parse', 'HEAD');
	const dispatch: StandardWorktreeDispatch = {
		callID: `call-${label}`,
		parentSessionID: `session-${label}`,
		taskId: '1.1',
		planTaskId: '1.1',
		handle: {
			worktreePath: lane,
			branchName: branch,
			purpose: 'lane',
			id: label,
			sessionId: label,
		},
		mergeStrategy: 'merge',
		laneIndex: 0,
	};
	const provenance: MergeOperationProvenance = {
		operationId: `operation-${label}`,
		sourceHead: source,
		targetHeadBefore: base,
		branchName: branch,
		strategy: 'merge',
	};
	return { root, lane, branch, base, source, dispatch, provenance };
}

function rejectingHooksAndSigning(root: string): void {
	for (const name of ['commit-msg', 'pre-merge-commit']) {
		const hook = path.join(root, '.git', 'hooks', name);
		fs.writeFileSync(hook, '#!/bin/sh\nprintf rejected > hook-ran\nexit 1\n');
		fs.chmodSync(hook, 0o755);
	}
	git(root, 'config', 'commit.gpgsign', 'true');
	git(
		root,
		'config',
		'gpg.program',
		path.join(root, 'missing-signing-program'),
	);
}

afterEach(() => {
	isolation.epicCommitLandingFor = originalLanding;
	merge.bunSpawn = originalSpawn;
	resetStandardWorktreeIsolationState();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('#3409 committed recovery preserves Epic landing policy', () => {
	for (const mode of ['advanced-target', 'orphan', 'same-target'] as const) {
		test(`${mode} dispatch preserves marker, merge topology and non-interactive flags`, async () => {
			const f = fixture(mode);
			if (mode === 'advanced-target') {
				fs.writeFileSync(path.join(f.root, 'target.txt'), 'target work\n');
				git(f.root, 'add', 'target.txt');
				git(f.root, 'commit', '-m', 'advanced target');
			}
			if (mode === 'orphan') {
				git(f.root, 'worktree', 'remove', '--force', f.lane);
				git(f.root, 'branch', '-D', f.branch);
			}
			const target = git(f.root, 'rev-parse', 'HEAD');
			rejectingHooksAndSigning(f.root);
			const seen: string[][] = [];
			merge.bunSpawn = (argv, options) => {
				seen.push(argv.slice(1));
				return originalSpawn(argv, options);
			};
			isolation.epicCommitLandingFor = (_directory, taskId) => {
				expect(taskId).toBe('1.1');
				return { commitLanding: true, landingCommitMessage: MESSAGE };
			};
			awaitingMergeByCallID.set(f.dispatch.callID, {
				callID: f.dispatch.callID,
				parentSessionID: f.dispatch.parentSessionID,
				taskId: f.dispatch.taskId,
				branch: f.branch,
				worktreePath: f.lane,
				mergeStrategy: 'merge',
				queuedAt: 1,
			});
			const result = await finishStandardWorktreeDispatch(
				f.root,
				f.dispatch,
				undefined,
				f.dispatch.callID,
				{ operationId: f.provenance.operationId, resume: f.provenance },
			);
			expect(result.outcome).toBe('merged');
			expect(git(f.root, 'log', '-1', '--format=%B')).toBe(MESSAGE);
			expect(git(f.root, 'rev-parse', 'HEAD^1')).toBe(target);
			expect(git(f.root, 'rev-parse', 'HEAD^2')).toBe(f.source);
			expect(git(f.root, 'log', '-1', '--format=%G?')).toBe('N');
			expect(fs.existsSync(path.join(f.root, 'hook-ran'))).toBe(false);
			const landing = seen.find(
				(args) => args[0] === 'merge' || args[2] === 'merge',
			);
			expect(landing).toEqual([
				'-c',
				'commit.gpgsign=false',
				'merge',
				'--no-ff',
				'--no-edit',
				'--no-verify',
				'-m',
				MESSAGE,
				mode === 'same-target' ? f.branch : f.source,
			]);
		});
	}

	test('immutable recovery without an explicit message keeps the existing plain argv', async () => {
		const f = fixture('plain-immutable');
		const seen: string[][] = [];
		merge.bunSpawn = (argv, options) => {
			seen.push(argv.slice(1));
			return originalSpawn(argv, options);
		};
		const result = await recoverMergeBackFromImmutableCoordinates(f.root, {
			sourceBaseOid: f.base,
			sourceHeadOid: f.source,
			targetHeadOid: f.base,
			strategy: 'merge',
		});
		expect(result).toMatchObject({ merged: true });
		expect(
			seen.filter((args) => args[0] === 'merge' || args[2] === 'merge'),
		).toEqual([['merge', '--no-edit', f.source]]);
	});
});
