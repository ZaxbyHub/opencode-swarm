/**
 * Epic v2 C1b — branch-drift guard (M-e). Under the epic-branch policy HEAD
 * must be the recorded epic branch:
 *   - `checkEpicBranch` (one `git rev-parse --abbrev-ref HEAD`) returns a
 *     structured EPIC_BRANCH_MISMATCH with the `git checkout` remedy, and
 *     fails closed on an unrecorded branch or a git failure;
 *   - `epic_next_wave` blocks with `epic-branch-mismatch` (and issues no
 *     wave);
 *   - an epic task's worktree landing is committed only while HEAD is the
 *     epic branch (`epicCommitLandingFor`; never onto a foreign branch), and
 *     `update_task_status` commits nothing on either branch (Epic v2 C3).
 * Real git repositories, epics opened by the production `startEpic`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleEpicCommand } from '../../../src/commands/epic';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals as branchInternals,
	checkEpicBranch,
} from '../../../src/epic/epic-branch';
import { getOpenEpic } from '../../../src/epic/lifecycle';
import { runEpicNextWave } from '../../../src/epic/next-wave';
import {
	epicCommitLandingFor,
	_internals as landingInternals,
} from '../../../src/epic/task-landing';
import { updateTaskStatus } from '../../../src/plan/manager';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	git,
	headSha,
	restoreStartInternals,
	type StartedEpic,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';

const realBranchInternals = { ...branchInternals };
const realLandingInternals = { ...landingInternals };
let epic: StartedEpic;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-07-02T09:00:00.000Z' });
	stubStartGlobals();
	epic = await startedGitEpic('epic-branch-guard-');
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	Object.assign(branchInternals, realBranchInternals);
	Object.assign(landingInternals, realLandingInternals);
	closeAllProjectDbs();
	fs.rmSync(epic.dir, { recursive: true, force: true });
});

describe('checkEpicBranch', () => {
	test('on the epic branch ⇒ ok', () => {
		expect(checkEpicBranch(epic.dir, epic.record)).toEqual({ ok: true });
	});

	test('another branch ⇒ EPIC_BRANCH_MISMATCH with the checkout remedy', () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const check = checkEpicBranch(epic.dir, epic.record);
		expect(check).toMatchObject({
			ok: false,
			code: 'EPIC_BRANCH_MISMATCH',
			expected: epic.epicBranch,
			actual: epic.originalBranch,
		});
		if (!check.ok) {
			expect(check.message).toContain(`git checkout ${epic.epicBranch}`);
		}
	});

	test('/swarm epic status shows the branch and the drift', async () => {
		const onBranch = await handleEpicCommand(epic.dir, ['status'], 'ses_b');
		expect(onBranch).toContain(`epic branch \`${epic.epicBranch}\``);
		expect(onBranch).not.toContain('EPIC_BRANCH_MISMATCH');
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const drifted = await handleEpicCommand(epic.dir, ['status'], 'ses_b');
		expect(drifted).toContain('EPIC_BRANCH_MISMATCH');
		expect(drifted).toContain(`git checkout ${epic.epicBranch}`);
	});

	test('detached HEAD ⇒ mismatch (actual null)', () => {
		git(epic.dir, ['checkout', '-q', '--detach']);
		const check = checkEpicBranch(epic.dir, epic.record);
		expect(check).toMatchObject({ ok: false, actual: null });
		if (!check.ok) expect(check.message).toContain('HEAD is detached');
	});

	test('git failure / unrecorded branch fail closed; current-branch and non-git pass', () => {
		branchInternals.gitExec = () => {
			throw new Error('simulated git timeout');
		};
		const failed = checkEpicBranch(epic.dir, epic.record);
		expect(failed).toMatchObject({ ok: false, code: 'EPIC_BRANCH_MISMATCH' });
		if (!failed.ok) expect(failed.message).toContain('simulated git timeout');
		const unrecorded = checkEpicBranch(epic.dir, {
			...epic.record,
			git: { ...epic.record.git, epicBranch: null },
		});
		expect(unrecorded).toMatchObject({ ok: false, expected: null });
		// No git call at all for these:
		expect(checkEpicBranch(epic.dir, stubEpicRecord())).toEqual({ ok: true });
		expect(
			checkEpicBranch(
				epic.dir,
				stubEpicRecord({
					config: {
						commitPolicy: 'epic-branch',
						isolation: 'main-tree-nogit',
						maxParallel: 1,
					},
					git: {
						isRepo: false,
						baseCommit: null,
						originalBranch: null,
						epicBranch: null,
					},
				}),
			),
		).toEqual({ ok: true });
	});

	test('unreadable epic ⇒ the landing seam keeps the default landing', () => {
		landingInternals.getOpenEpic = () => {
			throw new Error('multiple Epic lifecycle rows present');
		};
		expect(epicCommitLandingFor(epic.dir, '1.1')).toBeUndefined();
	});
});

describe('epic_next_wave refuses on branch drift', () => {
	test('off the epic branch ⇒ blocked epic-branch-mismatch, no wave; back on it ⇒ proceeds', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const refused = await runEpicNextWave(epic.dir, 'ses_branch');
		expect(refused).toMatchObject({
			status: 'blocked',
			reason: 'epic-branch-mismatch',
		});
		if (refused.status === 'blocked') {
			expect(refused.message).toContain(`git checkout ${epic.epicBranch}`);
		}
		expect(getOpenEpic(epic.dir)?.waves).toEqual([]);
		git(epic.dir, ['checkout', '-q', epic.epicBranch]);
		const next = await runEpicNextWave(epic.dir, 'ses_branch');
		expect(next.status).not.toBe('blocked');
		expect(next.status).not.toBe('refused');
	});
});

describe('commit-at-landing and the epic branch (Epic v2 C3)', () => {
	test('on the epic branch an epic task lands as a commit with the task message', () => {
		expect(epicCommitLandingFor(epic.dir, '1.1')).toEqual({
			commitLanding: true,
			landingCommitMessage: `swarm(task 1.1): task 1\n\nSwarm-Plan: ${epic.record.planKey}`,
		});
		// A task that is not in the epic's plan keeps the default landing.
		expect(epicCommitLandingFor(epic.dir, '9.9')).toBeUndefined();
		expect(epicCommitLandingFor(epic.dir, undefined)).toBeUndefined();
	});

	test('HEAD on another branch ⇒ no committed landing (never onto a foreign branch)', () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		expect(epicCommitLandingFor(epic.dir, '1.1')).toBeUndefined();
	});

	test('update_task_status commits nothing, on the epic branch or off it', async () => {
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const epicTip = headSha(epic.dir, epic.epicBranch);
		await updateTaskStatus(epic.dir, '1.1', 'completed');
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const updated = await updateTaskStatus(epic.dir, '1.2', 'completed');
		expect(
			updated.phases[0].tasks.find((task) => task.id === '1.2')?.status,
		).toBe('completed');
		expect(headSha(epic.dir, epic.originalBranch)).toBe(originalTip);
		expect(headSha(epic.dir, epic.epicBranch)).toBe(epicTip);
	});
});
