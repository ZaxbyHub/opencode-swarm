import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { epicMergeFailureSkipsCheckpoint } from '../../src/epic/merge-epoch';
import type { StandardWorktreeDispatch } from '../../src/hooks/delegation-gate/worktree-isolation';
import {
	finishStandardWorktreeDispatch,
	_internals as wtiInternals,
} from '../../src/hooks/delegation-gate/worktree-isolation';
import {
	initDurableStatusPath,
	_internals as mergeStatus,
} from '../../src/hooks/delegation-gate/worktree-merge-status';
import { savePlan } from '../../src/plan/manager';
import type { DirtyMergeOptions } from '../../src/worktree/merge';
import { openEpicForTest } from '../helpers/epic-lifecycle';

/**
 * End-to-end coverage for the Epic Mode × worktree-isolation interaction
 * (Epic v2 C3). It joins both halves of the landing contract:
 *
 *   SEAM:   `finishStandardWorktreeDispatch` asks the Epic module how an
 *           epic task's lane lands — a committed merge with the Epic task
 *           message — and leaves every other dispatch's options untouched.
 *   GUARD:  the merge-back outcome it records (failed/partial → record;
 *           merged → clear) is what Epic reads to skip the #2582
 *           auto-checkpoint (and to hold the epic wave) for work that never
 *           landed.
 */
function git(args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: tempDir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
		},
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

let tempDir: string;

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Epic × Worktree Guard',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Worktree-isolated task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

function makeDispatch(planTaskId: string): StandardWorktreeDispatch {
	return {
		callID: `call-${planTaskId}`,
		parentSessionID: `architect-session-${planTaskId}`,
		taskId: planTaskId,
		planTaskId,
		handle: {
			worktreePath: `/tmp/wt-${planTaskId}`,
			branchName: `swarm-lane/${planTaskId}`,
			purpose: 'lane' as never,
			id: `wt-${planTaskId}`,
			sessionId: `coder-${planTaskId}`,
		},
		mergeStrategy: 'merge',
	};
}

describe('Epic Mode × worktree isolation — landing seam and merge-back guard (e2e)', () => {
	const origWti = {
		attemptMergeBackFromDirty: wtiInternals.attemptMergeBackFromDirty,
		removeWorktree: wtiInternals.removeWorktree,
		postMergeCleanup: wtiInternals.postMergeCleanup,
		epicCommitLandingFor: wtiInternals.epicCommitLandingFor,
	};
	let seenOptions: DirtyMergeOptions[];
	let outcome: Awaited<
		ReturnType<typeof wtiInternals.attemptMergeBackFromDirty>
	>;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-wt-guard-'));
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				epic: { mode: { enabled: true } },
			}),
		);
		// A real repository: the epic landing seam reads the primary index.
		for (const args of [
			['init', '-q'],
			['config', 'user.email', 't@example.com'],
			['config', 'user.name', 'T'],
			['config', 'commit.gpgsign', 'false'],
		]) {
			git(args);
		}
		fs.writeFileSync(path.join(tempDir, '.gitignore'), '.swarm/\n');
		git(['add', '.']);
		git(['commit', '-q', '-m', 'seed']);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		await savePlan(tempDir, makePlan());
		initDurableStatusPath(tempDir);
		seenOptions = [];
		outcome = {
			merged: true as const,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		};
		// No real git/worktree side effects.
		wtiInternals.removeWorktree = async () => {};
		wtiInternals.postMergeCleanup = async () => {};
		wtiInternals.attemptMergeBackFromDirty = async (
			_wt,
			_branch,
			_dir,
			_strategy,
			options,
		) => {
			seenOptions.push(options ?? {});
			return outcome;
		};
		mergeStatus.failuresByTask.clear();
	});

	afterEach(() => {
		Object.assign(wtiInternals, origWti);
		mergeStatus.failuresByTask.clear();
		closeAllProjectDbs();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('no open epic ⇒ the merge-back options are exactly the caller’s (Epic seam inert)', async () => {
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('1.1'));
		expect(seenOptions).toHaveLength(1);
		expect(Object.keys(seenOptions[0])).toEqual([
			'operationId',
			'resume',
			'onBeforeMerge',
			'commitLanding',
		]);
		expect(Object.values(seenOptions[0])).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it('open epic ⇒ the task lands as a commit carrying the Epic task message', async () => {
		const epic = openEpicForTest(tempDir);
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('1.1'));
		expect(seenOptions[0]).toMatchObject({
			commitLanding: true,
			landingCommitMessage: `swarm(task 1.1): Worktree-isolated task\n\nSwarm-Plan: ${epic.planKey}`,
		});
		// A dispatch for a task outside the epic's plan keeps the default.
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('9.9'));
		expect(seenOptions[1].commitLanding).toBeUndefined();
		expect('landingCommitMessage' in seenOptions[1]).toBe(false);
	});

	it('staged entries in the primary index ⇒ not landed: EPIC_LANDING_INDEX_DIRTY recorded, lane preserved', async () => {
		openEpicForTest(tempDir);
		fs.writeFileSync(path.join(tempDir, 'README.md'), 'user staged\n');
		git(['add', 'README.md']);
		const settled = await finishStandardWorktreeDispatch(
			tempDir,
			makeDispatch('1.1'),
		);
		expect(settled).toMatchObject({
			outcome: 'failed',
			stage: 'epic-landing-index',
		});
		expect(seenOptions).toEqual([]);
		const failure = mergeStatus.failuresByTask.get('1.1');
		expect(failure?.stage).toBe('epic-landing-index');
		expect(failure?.message).toContain('git restore --staged -- README.md');
		// The user's staged entry is untouched.
		expect(git(['diff', '--cached', '--name-only']).trim()).toBe('README.md');
	});

	it('a caller-chosen landing is never overridden (the seam is not consulted)', async () => {
		openEpicForTest(tempDir);
		let consulted = 0;
		wtiInternals.epicCommitLandingFor = (...args) => {
			consulted += 1;
			return origWti.epicCommitLandingFor(...args);
		};
		await finishStandardWorktreeDispatch(
			tempDir,
			makeDispatch('1.1'),
			undefined,
			undefined,
			{ commitLanding: false },
		);
		expect(consulted).toBe(0);
		expect(seenOptions[0].commitLanding).toBe(false);
		expect('landingCommitMessage' in seenOptions[0]).toBe(false);
	});

	it('FAILED / PARTIAL merge-back of an epic task ⇒ the auto-checkpoint is skipped; a clean re-dispatch clears it', async () => {
		openEpicForTest(tempDir);
		outcome = {
			failed: true as const,
			stage: 'merge',
			message: 'merge conflict in src/a.ts',
		};
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('1.1'));
		expect(mergeStatus.failuresByTask.get('1.1')?.outcome).toBe('failed');
		expect(epicMergeFailureSkipsCheckpoint(tempDir, '1.1')).toBe(true);

		outcome = {
			partial: true as const,
			stage: 'rebase',
			autoCommitted: true,
			cleaned: false,
			message: 'some hunks did not apply',
		};
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('1.1'));
		expect(mergeStatus.failuresByTask.get('1.1')?.outcome).toBe('partial');
		expect(epicMergeFailureSkipsCheckpoint(tempDir, '1.1')).toBe(true);
		// Another task's failure never blocks this one.
		expect(epicMergeFailureSkipsCheckpoint(tempDir, '1.2')).toBe(false);

		outcome = {
			merged: true as const,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		};
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('1.1'));
		expect(mergeStatus.failuresByTask.has('1.1')).toBe(false);
		expect(epicMergeFailureSkipsCheckpoint(tempDir, '1.1')).toBe(false);
	});

	it('without an open epic a recorded failure never skips the checkpoint', async () => {
		outcome = { failed: true as const, stage: 'merge', message: 'conflict' };
		await finishStandardWorktreeDispatch(tempDir, makeDispatch('1.1'));
		expect(mergeStatus.failuresByTask.has('1.1')).toBe(true);
		expect(epicMergeFailureSkipsCheckpoint(tempDir, '1.1')).toBe(false);
	});
});
