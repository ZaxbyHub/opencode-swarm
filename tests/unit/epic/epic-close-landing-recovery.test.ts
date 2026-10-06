/**
 * Epic v2 C1b — landing recovery (M-d, M-f, MINOR 3):
 *   - squash conflict ⇒ `git reset --merge` (a squash writes no MERGE_HEAD),
 *     clean original branch, epic branch untouched, row stays `closing`
 *     with the attempt recorded; a rerun resumes;
 *   - merge conflict ⇒ `git merge --abort`;
 *   - a close interrupted AFTER the squash was staged resumes idempotently
 *     (no refusal of its own staged changes, no double landing);
 *   - landing is non-interactive: a pre-merge-commit hook, a blocking
 *     `core.editor` and commit signing cannot stall `--land merge`, and a
 *     hook that rejects the merge is rolled back;
 *   - `/swarm close` finalization checks out the original branch, keeps and
 *     names the epic branch, and never lands.
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
	finalizeOpenEpicOnSwarmClose,
} from '../../../src/epic/close';
import { epicSentinelExists, inspectEpic } from '../../../src/epic/lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	commitFiles,
	completeAllTasks,
	dirtyLines,
	git,
	headBranch,
	headSha,
	mergeHeadExists,
	restoreStartInternals,
	type StartedEpic,
	stagedFiles,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';
import { EPIC_ON_CONFIG } from './start-fixture';

const realCloseInternals = { ...closeInternals };
let epic: StartedEpic;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-07-04T09:00:00.000Z' });
	stubStartGlobals();
	epic = await startedGitEpic('epic-landing-recovery-');
	commitFiles(epic.dir, { 'shared.txt': 'epic version\n' }, 'epic work');
	await completeAllTasks(epic.dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	Object.assign(closeInternals, realCloseInternals);
	closeAllProjectDbs();
	fs.rmSync(epic.dir, { recursive: true, force: true });
});

/** Commit a conflicting change on the original branch, return to the epic. */
function divergeOriginal(): void {
	git(epic.dir, ['checkout', '-q', epic.originalBranch]);
	commitFiles(epic.dir, { 'shared.txt': 'original version\n' }, 'upstream');
	git(epic.dir, ['checkout', '-q', epic.epicBranch]);
}

function expectCleanOriginal(originalTip: string): void {
	expect(headBranch(epic.dir)).toBe(epic.originalBranch);
	expect(headSha(epic.dir)).toBe(originalTip);
	expect(dirtyLines(epic.dir)).toEqual([]);
	expect(stagedFiles(epic.dir)).toEqual([]);
	expect(mergeHeadExists(epic.dir)).toBe(false);
}

describe('conflicts are rolled back and the close stays resumable', () => {
	test('squash conflict ⇒ reset --merge, record closing with the attempt; rerun with --land none finishes', async () => {
		divergeOriginal();
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const epicTip = headSha(epic.dir, epic.epicBranch);
		const failed = await closeEpic({ directory: epic.dir, abandon: false });
		expect(failed.status).toBe('landing-failed');
		if (failed.status !== 'landing-failed') return;
		expect(failed.landing).toMatchObject({
			mode: 'squash',
			status: 'conflict',
			conflictFiles: ['shared.txt'],
		});
		expectCleanOriginal(originalTip);
		expect(headSha(epic.dir, epic.epicBranch)).toBe(epicTip);
		const record = inspectEpic(epic.dir).record;
		expect(record?.status).toBe('closing');
		expect(record?.closing).toMatchObject({
			outcome: 'completed',
			land: 'squash',
			lastLandingAttempt: { status: 'conflict', conflictFiles: ['shared.txt'] },
		});
		expect(epicSentinelExists(epic.dir)).toBe(true);

		// A plain rerun resumes (still conflicting — same rollback).
		expect(
			(await closeEpic({ directory: epic.dir, abandon: false })).status,
		).toBe('landing-failed');
		expectCleanOriginal(originalTip);

		// The user lands manually, then finishes the close without landing.
		const finished = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'none',
		});
		expect(finished.status).toBe('closed');
		if (finished.status === 'closed') {
			expect(finished.report.outcome).toBe('completed');
			expect(finished.report.landing.status).toBe('already-landed');
		}
		expect(epicSentinelExists(epic.dir)).toBe(false);
	});

	test('merge conflict ⇒ merge --abort, clean original branch', async () => {
		divergeOriginal();
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const failed = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'merge',
		});
		expect(failed).toMatchObject({
			status: 'landing-failed',
			landing: { mode: 'merge', status: 'conflict' },
		});
		expectCleanOriginal(originalTip);
		expect(inspectEpic(epic.dir).record?.status).toBe('closing');
	});

	test('the conflict output gives manual landing instructions', async () => {
		divergeOriginal();
		const out = await handleEpicCommand(epic.dir, ['close'], 'ses_branch');
		expect(out).toContain('landing **conflict**');
		expect(out).toContain('shared.txt');
		expect(out).toContain(`git merge --squash ${epic.epicBranch}`);
		expect(out).toContain('/swarm epic close --land none');
		const status = await handleEpicCommand(epic.dir, ['status'], 'ses_branch');
		expect(status).toContain('closing (interrupted');
		expect(status).toContain('Last landing attempt (squash): **conflict**');
	});
});

describe('idempotent resume', () => {
	test('a close interrupted after the squash was staged resumes without refusing or re-landing', async () => {
		const originalTip = headSha(epic.dir, epic.originalBranch);
		closeInternals.deleteEpicState = () => {
			throw new Error('simulated crash before the row delete');
		};
		await expect(
			closeEpic({ directory: epic.dir, abandon: false }),
		).rejects.toThrow('simulated crash');
		expect(stagedFiles(epic.dir)).toEqual(['shared.txt']);
		expect(inspectEpic(epic.dir).record?.status).toBe('closing');

		Object.assign(closeInternals, realCloseInternals);
		const resumed = await closeEpic({ directory: epic.dir, abandon: false });
		expect(resumed.status).toBe('closed');
		if (resumed.status === 'closed') {
			expect(resumed.report.landing.status).toBe('already-landed');
		}
		expect(headSha(epic.dir)).toBe(originalTip);
		expect(stagedFiles(epic.dir)).toEqual(['shared.txt']);
		expect(git(epic.dir, ['diff', '--cached', '--', 'shared.txt'])).toContain(
			'+epic version',
		);
		expect(epicSentinelExists(epic.dir)).toBe(false);
	});

	test('an abandon of a stuck completed close upgrades the outcome and never lands', async () => {
		divergeOriginal();
		await closeEpic({ directory: epic.dir, abandon: false });
		const abandoned = await closeEpic({ directory: epic.dir, abandon: true });
		expect(abandoned.status).toBe('closed');
		if (abandoned.status === 'closed') {
			expect(abandoned.report.outcome).toBe('abandoned');
			expect(abandoned.report.landing.mode).toBeNull();
		}
		expect(stagedFiles(epic.dir)).toEqual([]);
	});
});

describe('non-interactive landing', () => {
	function writeHook(name: string, body: string): void {
		const hook = path.join(epic.dir, '.git', 'hooks', name);
		fs.mkdirSync(path.dirname(hook), { recursive: true });
		fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}

	test('pre-merge-commit hook (reading stdin), failing editor and gpg signing cannot stall --land merge', async () => {
		writeHook(
			'pre-merge-commit',
			'cat > /dev/null\necho ran > "$(git rev-parse --git-dir)/hook-ran"',
		);
		git(epic.dir, ['config', 'core.editor', 'false']);
		git(epic.dir, ['config', 'commit.gpgsign', 'true']);
		git(epic.dir, ['config', 'gpg.program', 'false']);
		const result = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'merge',
		});
		expect(result.status).toBe('closed');
		expect(fs.existsSync(path.join(epic.dir, '.git', 'hook-ran'))).toBe(true);
		expect(
			git(epic.dir, ['log', '-1', '--format=%P']).trim().split(' '),
		).toHaveLength(2);
		expect(dirtyLines(epic.dir)).toEqual([]);
	});

	test('a hook that rejects the merge ⇒ landing failed, merge state aborted', async () => {
		writeHook('pre-merge-commit', 'echo "policy says no" >&2\nexit 1');
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const result = await closeEpic({
			directory: epic.dir,
			abandon: false,
			land: 'merge',
		});
		expect(result).toMatchObject({
			status: 'landing-failed',
			landing: { status: 'failed' },
		});
		if (result.status === 'landing-failed') {
			expect(result.landing.detail).toContain('policy says no');
		}
		expectCleanOriginal(originalTip);
	});
});

describe('/swarm close finalization (MINOR 3)', () => {
	test('checks out the original branch, keeps and names the epic branch, never lands', async () => {
		const line = await finalizeOpenEpicOnSwarmClose(
			epic.dir,
			EPIC_ON_CONFIG as never,
		);
		expect(line).toContain('abandoned-by-swarm-close');
		expect(line).toContain(`\`${epic.epicBranch}\` was kept and NOT landed`);
		expect(line).toContain(`git branch -D ${epic.epicBranch}`);
		expect(headBranch(epic.dir)).toBe(epic.originalBranch);
		expect(stagedFiles(epic.dir)).toEqual([]);
		expect(
			git(epic.dir, ['branch', '--list', epic.epicBranch]).trim().length,
		).toBeGreaterThan(0);
		expect(epicSentinelExists(epic.dir)).toBe(false);
	});
});
