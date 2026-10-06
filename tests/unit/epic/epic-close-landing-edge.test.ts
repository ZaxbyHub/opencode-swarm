/**
 * Epic v2 C1b review F2–F5 — landing edge cases, all refused or resolved
 * BEFORE the row is marked `closing` unless noted:
 *   F2 detached HEAD on a commit that is on neither branch ⇒ `detached-head`
 *      (switching would orphan it); detached on the epic tip ⇒ lands;
 *   F3 original branch deleted ⇒ `original-branch-missing`; a landing
 *      failure that could not restore the original branch is reported as
 *      such (no false "clean original branch" claim);
 *   F4 squash-already-staged detection without `merge-tree --write-tree`
 *      (git < 2.38) falls back to comparing diffs; the dirty-tree remedy on
 *      the original branch points at `--land none`;
 *   F5 an epic branch without changes ⇒ `nothing-to-land`, close finishes.
 * Real git repositories, epics opened by the production `startEpic`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../../src/commands/epic';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	closeEpic,
	_internals as closeInternals,
} from '../../../src/epic/close';
import { _internals as branchInternals } from '../../../src/epic/epic-branch';
import { epicSentinelExists, inspectEpic } from '../../../src/epic/lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	commitFiles,
	completeAllTasks,
	git,
	headBranch,
	restoreStartInternals,
	type StartedEpic,
	stagedFiles,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';

const realCloseInternals = { ...closeInternals };
const realBranchInternals = { ...branchInternals };
let epic: StartedEpic;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-07-07T09:00:00.000Z' });
	stubStartGlobals();
	epic = await startedGitEpic('epic-landing-edge-');
	await completeAllTasks(epic.dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	Object.assign(closeInternals, realCloseInternals);
	Object.assign(branchInternals, realBranchInternals);
	closeAllProjectDbs();
	fs.rmSync(epic.dir, { recursive: true, force: true });
});

function work(): void {
	commitFiles(epic.dir, { 'src/w.ts': 'export const w = 1;\n' }, 'epic work');
}

describe('F2 detached HEAD at close', () => {
	test('a detached commit on neither branch ⇒ detached-head, nothing changes', async () => {
		work();
		git(epic.dir, ['checkout', '-q', '--detach']);
		commitFiles(epic.dir, { 'loose.txt': 'detached work\n' }, 'detached');
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'detached-head',
		});
		expect(inspectEpic(epic.dir).record?.status).toBe('open');
		// --abandon never orphans it either: HEAD stays detached.
		const abandoned = await closeEpic({ directory: epic.dir, abandon: true });
		expect(abandoned.status).toBe('closed');
		if (abandoned.status === 'closed') {
			expect(abandoned.report.landing.status).toBe('left-in-place');
		}
		expect(headBranch(epic.dir)).toBe('HEAD');
	});

	test('detached on the epic tip ⇒ lands normally', async () => {
		work();
		git(epic.dir, ['checkout', '-q', '--detach']);
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result.status).toBe('closed');
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		expect(stagedFiles(epic.dir)).toEqual(['src/w.ts']);
	});
});

describe('F3 original branch', () => {
	test('deleted original branch ⇒ original-branch-missing before closing', async () => {
		work();
		git(epic.dir, ['branch', '-D', epic.originalBranch]);
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result).toMatchObject({ reason: 'original-branch-missing' });
		if (result.status === 'refused') {
			expect(result.details.join(' ')).toContain(
				`git branch ${epic.originalBranch} ${epic.record.git.baseCommit}`,
			);
		}
		expect(inspectEpic(epic.dir).record?.status).toBe('open');
		expect(headBranch(epic.dir)).toBe(epic.epicBranch);
	});

	test('a failure that left HEAD elsewhere is reported as not restored', async () => {
		work();
		closeInternals.performEpicLanding = () => ({
			status: 'failed',
			conflictFiles: [],
			detail: `git checkout ${epic.originalBranch} failed: simulated`,
			after: { branch: epic.epicBranch, clean: true },
		});
		const out = await handleEpicCommand(epic.dir, ['close'], 'ses_edge');
		expect(out).toContain('landing **failed**');
		expect(out).toContain('was NOT fully restored');
		expect(out).toContain(`HEAD is on \`${epic.epicBranch}\``);
		expect(out).not.toContain('with a clean tree');
		expect(inspectEpic(epic.dir).record?.status).toBe('closing');
	});
});

describe('F4 squash detection without merge-tree --write-tree', () => {
	test('interrupted squash close resumes via the diff fallback', async () => {
		work();
		branchInternals.gitExec = (args, cwd, env) => {
			if (args[0] === 'merge-tree') {
				throw new Error("error: unknown option `write-tree'");
			}
			return realBranchInternals.gitExec(args, cwd, env);
		};
		closeInternals.deleteEpicState = () => {
			throw new Error('simulated crash before the row delete');
		};
		await expect(
			closeEpic({ directory: epic.dir, abandon: false }),
		).rejects.toThrow('simulated crash');
		expect(stagedFiles(epic.dir)).toEqual(['src/w.ts']);
		closeInternals.deleteEpicState = realCloseInternals.deleteEpicState;
		const resumed = await closeEpic({ directory: epic.dir, abandon: false });
		expect(resumed.status).toBe('closed');
		if (resumed.status === 'closed') {
			expect(resumed.report.landing.status).toBe('already-landed');
		}
	});

	test('unrelated staged change on the original branch ⇒ dirty-worktree pointing at --land none', async () => {
		work();
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		fs.writeFileSync(path.join(epic.dir, 'other.txt'), 'unrelated\n');
		git(epic.dir, ['add', 'other.txt']);
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result).toMatchObject({ reason: 'dirty-worktree' });
		if (result.status === 'refused') {
			expect(result.details[1]).toContain(
				`commit them on \`${epic.originalBranch}\``,
			);
			expect(result.details[1]).toContain('/swarm epic close --land none');
		}
	});
});

describe('F5 nothing to land', () => {
	test('epic branch without changes ⇒ nothing-to-land, back on the original, closed', async () => {
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result.status).toBe('closed');
		if (result.status === 'closed') {
			expect(result.report.landing.status).toBe('nothing-to-land');
		}
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		expect(epicSentinelExists(epic.dir)).toBe(false);
	});

	test('already on the original branch ⇒ nothing-to-land without git work; output says so', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const out = await handleEpicCommand(
			epic.dir,
			['close', '--land', 'merge'],
			'ses_edge',
		);
		expect(out).toContain('has no changes to land');
		expect(epicSentinelExists(epic.dir)).toBe(false);
	});
});
