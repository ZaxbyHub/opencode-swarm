/**
 * End-to-end integration test for the Epic predecessor-evidence handoff
 * (Epic v2 C3), on a real git repository — no git mocks:
 *
 *   coder landing   (`mergeLaneBranch` with the Epic task message)
 *   non-coder write (`commitEpicResidueAfterDelegation`)
 *        ↓ `swarm(task <id>): …` + `Swarm-Plan: <planKey>` commits
 *   update_task_status(completed)          — no git write at all
 *        ↓
 *   epic_next_wave closes the wave         — records the task's commit,
 *        ↓                                   mirrors refs/swarm/epics/…
 *   epic_next_wave (next phase)            — dependency satisfied by the
 *                                            task ref being an ancestor
 *                                            of HEAD
 *
 * If a contract between those modules drifts (commit-message shape, subject
 * regex, trailer, ref naming, ancestry check), the unit tests still pass but
 * the real protocol regresses; this file is the round-trip backstop. It also
 * pins the repair path (`/swarm epic status --repair-refs`) after a history
 * rewrite and the non-Epic no-side-effect contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { getOpenEpic, markEpicPhaseComplete } from '../../src/epic/lifecycle';
import { epicTaskRef } from '../../src/epic/markers';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { formatEpicTaskCommitMessage } from '../../src/epic/plan-key';
import { commitEpicResidueAfterDelegation } from '../../src/epic/residue-commit';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { mergeLaneBranch } from '../../src/worktree/merge';
import { openEpicForTest } from '../helpers/epic-lifecycle';

const SESSION = 'epic-handoff-architect';

function git(args: string[], cwd: string): { status: number; stdout: string } {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

function initGitRepo(dir: string, epicEnabled: boolean): void {
	expect(git(['init', '-b', 'main'], dir).status).toBe(0);
	expect(git(['config', 'user.email', 'test@example.com'], dir).status).toBe(0);
	expect(git(['config', 'user.name', 'Test User'], dir).status).toBe(0);
	// Prevent GPG signing from blocking tests in environments where the
	// user's global ~/.gitconfig sets commit.gpgsign = true.
	expect(git(['config', 'commit.gpgsign', 'false'], dir).status).toBe(0);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(epicEnabled ? { epic: { mode: { enabled: true } } } : {}),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
	expect(git(['add', '.'], dir).status).toBe(0);
	expect(git(['commit', '-m', 'initial'], dir).status).toBe(0);
}

function makePlan(): Plan {
	const task = (id: string, phase: number, depends: string[]) => ({
		id,
		phase,
		status: 'pending' as const,
		size: 'small' as const,
		description: id === '1.1' ? 'set up package structure' : `implement ${id}`,
		depends,
		files_touched: [],
	});
	return {
		schema_version: '1.0.0',
		title: 'Phase Handoff Integration',
		swarm: 'integration',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [task('1.1', 1, [])],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [task('2.1', 2, ['1.1'])],
			},
		],
		migration_status: 'native',
	};
}

async function declareScope(
	dir: string,
	taskId: string,
	files: string[],
): Promise<void> {
	const declared = await executeDeclareScope(
		{ taskId, files, working_directory: dir },
		dir,
		{ sessionID: SESSION, messageID: `m-${taskId}` },
	);
	if (!declared.success) {
		throw new Error(`declare_scope failed for ${taskId}: ${declared.message}`);
	}
}

const head = (dir: string) => git(['rev-parse', 'HEAD'], dir).stdout.trim();

describe('Epic handoff — landing + residue commits → wave close refs → predecessor evidence', () => {
	let dir: string;
	let planKey: string;
	let epicKey: string;

	/** Coder lands 1.1 (merge commit) and the test_engineer's residue is committed. */
	async function runTask11(): Promise<void> {
		await declareScope(dir, '1.1', ['src/foo.ts', 'src/foo.test.ts']);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, taskIds: ['1.1'] },
		});
		// The coder's lane (what a worktree holds) lands as a merge commit.
		expect(git(['checkout', '-q', '-b', 'lane-1.1'], dir).status).toBe(0);
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'src', 'foo.ts'),
			'export const FOO = 1;\n',
		);
		expect(git(['add', 'src/foo.ts'], dir).status).toBe(0);
		expect(git(['commit', '-q', '-m', 'lane work'], dir).status).toBe(0);
		expect(git(['checkout', '-q', 'main'], dir).status).toBe(0);
		const landed = await mergeLaneBranch(
			dir,
			'lane-1.1',
			'merge',
			formatEpicTaskCommitMessage('1.1', planKey, 'set up package structure'),
		);
		expect(landed).toMatchObject({ merged: true });
		// The test_engineer writes the test in the main tree; its Task
		// after-hook commits it as the task's residue (never .swarm/).
		fs.writeFileSync(path.join(dir, 'src', 'foo.test.ts'), 'test("x");\n');
		fs.writeFileSync(path.join(dir, '.swarm', 'prompt.md'), 'do not commit');
		await commitEpicResidueAfterDelegation({
			directory: dir,
			agent: 'test_engineer',
			sessionID: SESSION,
			resolveTaskIds: async () => ['1.1'],
			childSessionIds: async () => [],
		});
		const before = head(dir);
		await updateTaskStatus(dir, '1.1', 'completed');
		// update_task_status performs no git write.
		expect(head(dir)).toBe(before);
	}

	beforeEach(async () => {
		// Do NOT use `realpathSync` here: on macOS it resolves `/tmp/...` to
		// `/private/tmp/...`, and the substring `private` triggers the lean
		// planner's protected-path detection.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-handoff-'));
		initGitRepo(dir, true);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await savePlan(dir, makePlan());
		const record = openEpicForTest(dir, {
			git: {
				isRepo: true,
				baseCommit: head(dir),
				originalBranch: 'main',
				epicBranch: null,
			},
		});
		planKey = record.planKey;
		epicKey = record.epicKey;
	});

	afterEach(() => {
		closeAllProjectDbs();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});

	test('round trip: the wave close records the task commit and ref; phase 2 sees 1.1 as committed', async () => {
		await runTask11();
		const subjects = git(['log', '--pretty=%s'], dir).stdout.split('\n');
		// Re-implemented inline so a drift between the message formatter and
		// the subject regex is caught without one importing the other.
		const SUBJECT_RE = /^swarm\(task ([^)]+)\):/;
		const marked = subjects.filter((s) => SUBJECT_RE.test(s));
		expect(marked).toEqual([
			// Scope-swept (the simulated test_engineer records no session write).
			'swarm(task 1.1): residue',
			'swarm(task 1.1): set up package structure',
		]);
		expect(git(['log', '-1', '--format=%B'], dir).stdout).toContain(
			`Swarm-Plan: ${planKey}`,
		);
		// AGENTS.md #4: nothing under .swarm/ ever enters history.
		const allFiles = git(
			['log', '--pretty=', '--name-only', '--all'],
			dir,
		).stdout;
		expect(allFiles).not.toMatch(/^\.swarm\b/m);
		expect(allFiles).toContain('src/foo.test.ts');

		expect((await runEpicNextWave(dir, SESSION)).status).toBe(
			'phase-ready-for-review',
		);
		const outcome = getOpenEpic(dir)?.tasks['1.1'];
		expect(outcome?.marker).toEqual({
			ref: epicTaskRef(epicKey, '1.1'),
			sha: head(dir),
			provenance: 'landing-commit',
		});
		expect(
			git(
				['rev-parse', `refs/swarm/epics/${epicKey}/tasks/1.1`],
				dir,
			).stdout.trim(),
		).toBe(head(dir));
		expect(
			git(
				['rev-parse', `refs/swarm/epics/${epicKey}/waves/1`],
				dir,
			).stdout.trim(),
		).toBe(head(dir));

		markEpicPhaseComplete(dir, 1);
		await declareScope(dir, '2.1', ['src/bar.ts']);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { phase: 2, taskIds: ['2.1'] },
		});
	});

	test('a deleted task ref is re-created from the record (refs mirror the record)', async () => {
		await runTask11();
		await runEpicNextWave(dir, SESSION);
		const ref = `refs/swarm/epics/${epicKey}/tasks/1.1`;
		expect(git(['update-ref', '-d', ref], dir).status).toBe(0);
		markEpicPhaseComplete(dir, 1);
		await declareScope(dir, '2.1', ['src/bar.ts']);
		expect((await runEpicNextWave(dir, SESSION)).status).toBe('dispatch');
		expect(git(['rev-parse', ref], dir).stdout.trim()).toBe(head(dir));
	});

	test('a history rewrite blocks predecessor-missing until --repair-refs re-adopts the commit', async () => {
		await runTask11();
		await runEpicNextWave(dir, SESSION);
		markEpicPhaseComplete(dir, 1);
		await declareScope(dir, '2.1', ['src/bar.ts']);
		// Rewrite: squash the epic's commits into one with a new sha that
		// still carries the task marker for this plan.
		const base = getOpenEpic(dir)?.git.baseCommit ?? '';
		expect(git(['reset', '-q', '--soft', base], dir).status).toBe(0);
		expect(
			git(
				[
					'commit',
					'-q',
					'-m',
					formatEpicTaskCommitMessage('1.1', planKey, 'squashed'),
				],
				dir,
			).status,
		).toBe(0);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'predecessor-missing',
			details: {
				problems: [{ taskId: '2.1', dependency: '1.1', why: 'not-committed' }],
			},
		});
		const repaired = await handleEpicCommand(
			dir,
			['status', '--repair-refs'],
			SESSION,
		);
		expect(repaired).toContain('1.1: **repaired**');
		expect(getOpenEpic(dir)?.tasks['1.1']?.marker).toMatchObject({
			sha: head(dir),
			provenance: 'repaired',
		});
		expect((await runEpicNextWave(dir, SESSION)).status).toBe('dispatch');
	});

	test('the work dropped entirely ⇒ --repair-refs reports needs-attention', async () => {
		await runTask11();
		await runEpicNextWave(dir, SESSION);
		const base = getOpenEpic(dir)?.git.baseCommit ?? '';
		expect(git(['reset', '-q', '--hard', base], dir).status).toBe(0);
		const repaired = await handleEpicCommand(
			dir,
			['status', '--repair-refs'],
			SESSION,
		);
		expect(repaired).toContain('1.1: **needs-attention**');
	});
});

describe('non-Epic projects', () => {
	test('update_task_status commits nothing and seeds no Epic state', async () => {
		const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-no-seed-'));
		try {
			initGitRepo(freshDir, false);
			fs.mkdirSync(path.join(freshDir, '.swarm'), { recursive: true });
			await savePlan(freshDir, makePlan());
			const before = head(freshDir);
			await updateTaskStatus(freshDir, '1.1', 'completed');
			expect(head(freshDir)).toBe(before);
			expect(
				fs.existsSync(path.join(freshDir, '.swarm', 'epic-state.json')),
			).toBe(false);
			expect(fs.existsSync(path.join(freshDir, '.swarm', 'epic'))).toBe(false);
			expect(git(['for-each-ref', 'refs/swarm'], freshDir).stdout.trim()).toBe(
				'',
			);
		} finally {
			closeAllProjectDbs();
			fs.rmSync(freshDir, { recursive: true, force: true });
		}
	});
});
