/**
 * Epic v2 lifecycle CONTRACT v3 (commit C3 — commit at landing, residue
 * commits, required isolation, refs; the critic's B2 regression).
 *
 * One epic on a real git repository with the default `epic-branch` policy,
 * through the production entry points:
 *
 *   `/swarm epic start --force` (base ref written)
 *   → epic_next_wave dispatches wave 1 = [1.1]
 *   → 1.1's coder runs in a REAL linked worktree; its settlement
 *     (`finishStandardWorktreeDispatch`) lands it as a merge commit on the
 *     epic branch — the work is committed before completion
 *   → the test_engineer writes a FAILING test in the main tree; its Task
 *     after-hook (the real delegation gate) commits it as 1.1's residue
 *   → Stage B fails → the rework coder's worktree is cut from HEAD, so it
 *     SEES both the first attempt and the test; it lands again without an
 *     overlap failure (B2: before C3 the first attempt landed unstaged and
 *     the rework's landing overlapped it forever)
 *   → update_task_status(completed) writes nothing to git
 *   → epic_next_wave closes the wave (task commit = the rework landing;
 *     refs tasks/1.1 + waves/1) and issues wave 2 = [1.2], whose dependency
 *     on 1.1 is proven by the ref
 *   → a coder for 1.2 that cannot be isolated is refused
 *     EPIC_ISOLATION_DEGRADED (never run in the main tree)
 *   → 1.2 lands → phase-ready-for-review → phase complete → epic-complete
 *   → `/swarm epic close` (squash): refs captured in the report, deleted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { PluginConfig } from '../../src/config';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import {
	getOpenEpic,
	isEpicOpenForProject,
	markEpicPhaseComplete,
} from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import {
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
} from '../../src/hooks/delegation-gate/worktree-isolation';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { recordPlanCriticApproval } from '../helpers/approved-plan';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'ses_contractV3';
const FROZEN_ISO = '2026-09-20T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const realStart = { ...startInternals };

let dir: string;
let lanes: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let restoreClock: Restore | null = null;

function git(args: string[], cwd = dir): string {
	const r = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

const head = () => git(['rev-parse', 'HEAD']).trim();
const subject = () => git(['log', '-1', '--format=%s']).trim();

function plan(): Plan {
	const task = (id: string, files: string[], depends: string[] = []) => ({
		id,
		phase: 1,
		status: 'pending' as const,
		size: 'small' as const,
		description: `implement ${id}`,
		depends,
		files_touched: files,
	});
	return {
		schema_version: '1.0.0',
		title: 'Contract V3',
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					task('1.1', ['src/sum.ts', 'tests/sum.test.ts']),
					task('1.2', ['src/use.ts'], ['1.1']),
				],
			},
		],
	};
}

/**
 * A coder of `taskId` in a real linked worktree cut from HEAD; `work`
 * edits the lane. The settlement is the production one.
 */
async function coderInWorktree(
	taskId: string,
	attempt: number,
	work: (lane: string) => void,
): Promise<Awaited<ReturnType<typeof finishStandardWorktreeDispatch>>> {
	const lane = path.join(lanes, `${taskId}-${attempt}`);
	const branch = `swarm-lane/${SESSION}/${taskId}-${attempt}`;
	git(['worktree', 'add', '-q', '-b', branch, lane, 'HEAD']);
	try {
		work(lane);
		const dispatch: StandardWorktreeDispatch = {
			callID: `coder-${taskId}-${attempt}`,
			parentSessionID: SESSION,
			taskId,
			planTaskId: taskId,
			handle: {
				worktreePath: lane,
				branchName: branch,
				purpose: 'lane' as never,
				id: `wt-${taskId}-${attempt}`,
				sessionId: `coder-${taskId}-${attempt}`,
			},
			mergeStrategy: 'merge',
			laneIndex: attempt,
		};
		return await finishStandardWorktreeDispatch(dir, dispatch);
	} finally {
		git(['worktree', 'remove', '--force', lane]);
	}
}

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c3-');
	lanes = canonicalMkdtemp('epic-contract-c3-lanes-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			epic: { mode: { enabled: true } },
		}),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	ensureAgentSession(SESSION, 'architect', dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(lanes, { recursive: true, force: true });
});

describe('Epic lifecycle contract v3 — landing commits, residue, rework, refs', () => {
	test('Stage B fail → rework sees the test → lands → wave closes; refs created then removed', async () => {
		expect(
			await handleEpicCommand(dir, ['start', '--force'], SESSION),
		).toContain('opened for plan');
		const epic = getOpenEpic(dir);
		const epicBranch = epic?.git.epicBranch ?? '';
		const prefix = `refs/swarm/epics/${epic?.epicKey}`;
		expect(git(['rev-parse', `${prefix}/base`]).trim()).toBe(head());

		for (const task of plan().phases[0].tasks) {
			const declared = await executeDeclareScope(
				{
					taskId: task.id,
					files: task.files_touched ?? [],
					working_directory: dir,
				},
				dir,
				{ sessionID: SESSION, messageID: `m-${task.id}` },
			);
			expect(declared.success).toBe(true);
		}
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, taskIds: ['1.1'] },
		});

		// Attempt 1 (buggy) lands as a COMMIT on the epic branch.
		const first = await coderInWorktree('1.1', 1, (lane) => {
			fs.mkdirSync(path.join(lane, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(lane, 'src', 'sum.ts'),
				'export const sum = (a: number, b: number) => a - b;\n',
			);
		});
		expect(first).toMatchObject({ outcome: 'merged', strategy: 'merge' });
		expect(subject()).toBe('swarm(task 1.1): implement 1.1');
		expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(epicBranch);
		expect(git(['status', '--porcelain']).trim()).toBe('');

		// The test_engineer writes a failing test in the main tree; the real
		// delegation gate's Task after-hook commits it as residue.
		fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'tests', 'sum.test.ts'),
			'expect(sum(1, 2)).toBe(3); // fails against attempt 1\n',
		);
		const gate = createDelegationGateHook(
			{ hooks: { delegation_gate: true } } as PluginConfig,
			dir,
		);
		await gate.toolAfter(
			{
				tool: 'Task',
				sessionID: SESSION,
				callID: 'te-1.1',
				args: {
					subagent_type: 'test_engineer',
					task_id: '1.1',
					prompt: 'TASK: 1.1\nWrite the tests',
				},
			},
			{ output: '[TESTED] 1.1 FAIL sum subtracts' },
		);
		// The simulated test_engineer writes straight to disk (no session-recorded
		// write), so its files are swept from the task's frozen scope under the
		// neutral label; a recorded write would read `test_engineer residue`.
		expect(subject()).toBe('swarm(task 1.1): residue');
		expect(git(['status', '--porcelain']).trim()).toBe('');

		// Stage B failed → rework. Its worktree is cut from HEAD: it sees the
		// first attempt AND the failing test, and lands without overlap.
		const rework = await coderInWorktree('1.1', 2, (lane) => {
			expect(
				fs.readFileSync(path.join(lane, 'tests', 'sum.test.ts'), 'utf-8'),
			).toContain('fails against attempt 1');
			expect(
				fs.readFileSync(path.join(lane, 'src', 'sum.ts'), 'utf-8'),
			).toContain('a - b');
			fs.writeFileSync(
				path.join(lane, 'src', 'sum.ts'),
				'export const sum = (a: number, b: number) => a + b;\n',
			);
		});
		expect(rework).toMatchObject({ outcome: 'merged', strategy: 'merge' });
		const reworkLanding = head();
		expect(fs.readFileSync(path.join(dir, 'src', 'sum.ts'), 'utf-8')).toContain(
			'a + b',
		);

		// Completion writes nothing to git.
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(head()).toBe(reworkLanding);

		// The wave closes; wave 2's dependency on 1.1 is proven by its ref.
		const wave2 = await runEpicNextWave(dir, SESSION);
		expect(wave2).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, taskIds: ['1.2'] },
			closedWave: { seq: 1 },
		});
		const record = getOpenEpic(dir);
		expect(record?.tasks['1.1']?.marker).toMatchObject({
			sha: reworkLanding,
			provenance: 'landing-commit',
		});
		expect(git(['rev-parse', `${prefix}/tasks/1.1`]).trim()).toBe(
			reworkLanding,
		);
		expect(git(['rev-parse', `${prefix}/waves/1`]).trim()).toBe(reworkLanding);

		// A 1.2 coder that cannot be isolated (no SDK client here) is refused.
		await recordPlanCriticApproval(dir, plan());
		const gateBefore = createDelegationGateHook(
			{
				hooks: { delegation_gate: true },
				worktree: { policy: 'auto' },
			} as PluginConfig,
			dir,
		);
		ensureAgentSession(SESSION).currentTaskId = '1.2';
		await expect(
			gateBefore.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'coder-1.2-x' },
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.2',
						prompt: 'TASK: 1.2\nFILE: src/use.ts\nACCEPTANCE: done',
					},
				},
			),
		).rejects.toThrow('EPIC_ISOLATION_DEGRADED');
		expect(git(['status', '--porcelain']).trim()).toBe('');

		// 1.2 lands (isolated) and completes; the phase and epic finish.
		expect(
			await landEpicTaskForTest(dir, '1.2', {
				'src/use.ts':
					"import { sum } from './sum';\nexport const three = sum(1, 2);\n",
			}),
		).toMatchObject({ merged: true });
		await updateTaskStatus(dir, '1.2', 'completed');
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
		});
		expect(markEpicPhaseComplete(dir, 1).outcome).toBe('recorded');
		expect((await runEpicNextWave(dir, SESSION)).status).toBe('epic-complete');
		const refsBefore = git(['for-each-ref', '--format=%(refname)', prefix])
			.trim()
			.split('\n')
			.sort();
		expect(refsBefore).toEqual(
			['base', 'tasks/1.1', 'tasks/1.2', 'waves/1', 'waves/2'].map(
				(name) => `${prefix}/${name}`,
			),
		);

		const closed = await handleEpicCommand(dir, ['close'], SESSION);
		expect(closed).toContain('closed (**completed**).');
		expect(closed).toContain('Epic refs: 5 deleted');
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(git(['for-each-ref', 'refs/swarm']).trim()).toBe('');
		expect(
			git(['diff', '--cached', '--name-only']).trim().split('\n').sort(),
		).toEqual(['src/sum.ts', 'src/use.ts', 'tests/sum.test.ts']);
	});
});
