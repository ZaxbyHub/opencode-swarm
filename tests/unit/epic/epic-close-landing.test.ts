/**
 * Epic v2 C1b — `/swarm epic close` landing of the epic branch:
 * `--land squash` (default: staged, UNCOMMITTED changes on the original
 * branch, epic branch kept), `--land merge` (a --no-ff merge commit),
 * `--land none` (switch back only), the dirty-tree refusal BEFORE anything
 * changes (M-f), a missing epic branch, `--abandon` (never lands), and the
 * `/swarm epic close` option parsing + rendering.
 * Real git repositories, epics opened by the production `startEpic`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	handleEpicCommand,
	parseCloseOptions,
} from '../../../src/commands/epic';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { closeEpic } from '../../../src/epic/close';
import { epicSentinelExists, inspectEpic } from '../../../src/epic/lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	commitFiles,
	completeAllTasks,
	dirtyLines,
	git,
	headBranch,
	headSha,
	restoreStartInternals,
	type StartedEpic,
	stagedFiles,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';

let epic: StartedEpic;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-07-03T09:00:00.000Z' });
	stubStartGlobals();
	epic = await startedGitEpic('epic-close-landing-');
	commitFiles(
		epic.dir,
		{
			'src/a.ts': 'export const a = 1;\n',
			'src/b.ts': 'export const b = 2;\n',
		},
		'epic work',
	);
	await completeAllTasks(epic.dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	closeAllProjectDbs();
	fs.rmSync(epic.dir, { recursive: true, force: true });
});

function branchExists(name: string): boolean {
	return git(epic.dir, ['branch', '--list', name]).trim().length > 0;
}

function expectClosed(): void {
	expect(epicSentinelExists(epic.dir)).toBe(false);
	expect(inspectEpic(epic.dir).rowKeys).toEqual([]);
}

describe('landing modes', () => {
	test('default squash: original branch has the epic diff staged, uncommitted; epic branch kept', async () => {
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result.status).toBe('closed');
		if (result.status !== 'closed') return;
		expect(result.report.landing).toMatchObject({
			mode: 'squash',
			status: 'landed',
			epicBranch: epic.epicBranch,
			originalBranch: epic.originalBranch,
		});
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		expect(headSha(epic.dir)).toBe(originalTip); // nothing committed
		expect(stagedFiles(epic.dir)).toEqual(['src/a.ts', 'src/b.ts']);
		// worktree == index (git diff --quiet throws on a difference)
		expect(git(epic.dir, ['diff', '--quiet'])).toBe('');
		expect(branchExists(epic.epicBranch)).toBe(true);
		// The persisted report carries the landing outcome.
		const saved = JSON.parse(fs.readFileSync(result.reportPaths[0], 'utf-8'));
		expect(saved.landing.status).toBe('landed');
		expectClosed();
	});

	test('merge: a --no-ff merge commit on the original branch, clean tree', async () => {
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const result = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'merge',
		});
		expect(result.status).toBe('closed');
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		const parents = git(epic.dir, ['log', '-1', '--format=%P'])
			.trim()
			.split(' ');
		expect(parents).toEqual([originalTip, headSha(epic.dir, epic.epicBranch)]);
		expect(dirtyLines(epic.dir)).toEqual([]);
		expect(fs.existsSync(path.join(epic.dir, 'src', 'a.ts'))).toBe(true);
		expectClosed();
	});

	test('none: back on the original branch, nothing landed, branch untouched', async () => {
		const epicTip = headSha(epic.dir, epic.epicBranch);
		const result = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'none',
		});
		expect(result.status).toBe('closed');
		if (result.status === 'closed') {
			expect(result.report.landing).toMatchObject({
				mode: 'none',
				status: 'landed',
			});
		}
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		expect(fs.existsSync(path.join(epic.dir, 'src', 'a.ts'))).toBe(false);
		expect(headSha(epic.dir, epic.epicBranch)).toBe(epicTip);
		expectClosed();
	});
});

describe('refusals before anything changes', () => {
	test('dirty tree ⇒ dirty-worktree; row still open, still on the epic branch', async () => {
		fs.writeFileSync(path.join(epic.dir, 'scratch.txt'), 'uncommitted\n');
		const result = await closeEpic({ directory: epic.dir, abandon: false });
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'dirty-worktree',
		});
		if (result.status === 'refused') {
			expect(result.details[0]).toContain('scratch.txt');
		}
		expect(inspectEpic(epic.dir).record?.status).toBe('open');
		expect(headBranch(epic.dir)).toBe(epic.epicBranch);
	});

	test('epic branch deleted ⇒ epic-branch-missing; --land none still closes', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		git(epic.dir, ['branch', '-D', epic.epicBranch]);
		const refused = await closeEpic({ directory: epic.dir, abandon: false });
		expect(refused).toMatchObject({ reason: 'epic-branch-missing' });
		expect(inspectEpic(epic.dir).record?.status).toBe('open');
		const closed = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'none',
		});
		expect(closed.status).toBe('closed');
		if (closed.status === 'closed') {
			expect(closed.report.landing.status).toBe('already-landed');
		}
		expectClosed();
	});
});

describe('--abandon never lands', () => {
	test('clean tree ⇒ checks out the original branch, keeps the epic branch', async () => {
		const result = await closeEpic({ directory: epic.dir, abandon: true });
		expect(result.status).toBe('closed');
		if (result.status === 'closed') {
			expect(result.report.outcome).toBe('abandoned');
			expect(result.report.landing).toMatchObject({
				mode: null,
				status: 'checked-out-original',
			});
		}
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		expect(stagedFiles(epic.dir)).toEqual([]);
		expect(branchExists(epic.epicBranch)).toBe(true);
		expectClosed();
	});

	test('dirty tree ⇒ stays on the epic branch (left-in-place) and still closes', async () => {
		fs.writeFileSync(path.join(epic.dir, 'scratch.txt'), 'uncommitted\n');
		const result = await closeEpic({ directory: epic.dir, abandon: true });
		expect(result.status).toBe('closed');
		if (result.status === 'closed') {
			expect(result.report.landing.status).toBe('left-in-place');
			expect(result.report.landing.detail).toContain(
				'uncommitted change(s) outside .swarm/',
			);
		}
		expect(headBranch(epic.dir)).toBe(epic.epicBranch);
		expectClosed();
	});
});

describe('/swarm epic close options and output', () => {
	test('parseCloseOptions', () => {
		expect(parseCloseOptions([])).toEqual({ abandon: false, land: undefined });
		expect(parseCloseOptions(['--land', 'merge'])).toEqual({
			abandon: false,
			land: 'merge',
		});
		expect(parseCloseOptions(['--land=NONE'])).toEqual({
			abandon: false,
			land: 'none',
		});
		expect(parseCloseOptions(['--land', 'rebase'])).toHaveProperty('error');
		expect(parseCloseOptions(['--land'])).toHaveProperty('error');
		expect(parseCloseOptions(['--abandon', '--land', 'squash'])).toHaveProperty(
			'error',
		);
	});

	test('squash close output tells the user to review, commit, then delete the branch', async () => {
		const out = await handleEpicCommand(epic.dir, ['close'], 'ses_branch');
		expect(out).toContain('closed (**completed**).');
		expect(out).toContain('**staged, uncommitted** changes');
		expect(out).toContain(`git branch -D ${epic.epicBranch}`);
	});

	test('a bad --land value is rejected before any lifecycle call', async () => {
		const out = await handleEpicCommand(
			epic.dir,
			['close', '--land', 'rebase'],
			'ses_branch',
		);
		expect(out).toContain('`--land` takes one of squash, merge, none');
		expect(inspectEpic(epic.dir).record?.status).toBe('open');
	});
});
