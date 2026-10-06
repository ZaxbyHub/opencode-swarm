/**
 * Epic v2 lifecycle CONTRACT — FINAL (commit C8): the whole epic, end to
 * end, through the production entry points on a real git repository (the
 * default `epic-branch` policy), with a controlled frozen clock so the
 * scorecard's time metrics are exact:
 *
 *   save_plan (Epic shaping: acceptable, epic-sized) → declare_scope
 *   → `/swarm epic start` (epic branch, not forced)
 *   → the real delegation gate REJECTS a coder before any wave
 *     (EPIC_NO_ACTIVE_WAVE) → epic_next_wave issues wave 1 → the gate
 *     REJECTS a task outside it and ADMITS the wave's coders concurrently,
 *     each in a real linked worktree → the production settlement lands each
 *     as a commit on the epic branch
 *   → the test_engineer's main-tree test is committed as 1.1's residue
 *   → Stage B fails (evidence) → the rework coder (gate-admitted again,
 *     cut from HEAD) lands the fix → completions
 *   → epic_next_wave closes wave 1 (outcomes with the rework, task refs,
 *     learning posterior) and issues wave 2 = [1.3] (its predecessor proven
 *     by 1.1's ref) → phase review (stub dispatcher) → phase_complete
 *   → phase 2: 2.1's CROSS-PHASE predecessor 1.3 is proven by its ref
 *   → epic-complete → `/swarm epic report` (live scorecard)
 *   → `/swarm epic close`: squash landing, the scorecard in the report,
 *     the learning merged into the prior, refs removed, probe false
 *   → `/swarm epic report last` reads the scorecard back.
 *
 * Its config-off twin is epic-lifecycle-contract-final-off.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { PluginConfig } from '../../src/config';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { getOpenEpic, isEpicOpenForProject } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../src/gate-evidence';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import {
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../src/hooks/delegation-gate/worktree-isolation';
import { loadPlanJsonOnly, updateTaskStatus } from '../../src/plan/manager';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeEpicPhaseReview } from '../../src/tools/epic-phase-review';
import { executeSavePlan } from '../../src/tools/save-plan';
import { recordPlanCriticApproval } from '../helpers/approved-plan';
import {
	approvingReviewDispatcher,
	atMinute,
	createFinalContractRepo,
	FINAL_PHASES,
	type FinalContractRepo,
	finalContent,
	finalDescription,
	finalSavePlanArgs,
	finalTask,
	writeFinalPhaseEvidence,
} from '../helpers/epic-final-contract';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';

const { phase_complete } = await import('../../src/tools/phase-complete');

const SESSION = 'ses_contractFinal';
const realStart = { ...startInternals };

let repo: FinalContractRepo;
let dir: string;
let originalCwd: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let childCount = 0;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	repo = createFinalContractRepo('epic-contract-final-', {
		mode: { enabled: true },
	});
	dir = repo.dir;
	ensureAgentSession(SESSION, 'architect', dir);
	childCount = 0;
	swarmState.opencodeClient = {
		session: {
			create: async () => ({ data: { id: `ses_child_${++childCount}` } }),
		},
	} as unknown as typeof swarmState.opencodeClient;
	originalCwd = process.cwd();
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(originalCwd);
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	Object.assign(startInternals, realStart);
	swarmState.opencodeClient = null as never;
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	repo.cleanup();
});

async function declarePhase(phase: number): Promise<void> {
	for (const task of FINAL_PHASES[phase - 1]) {
		const declared = await executeDeclareScope(
			{ taskId: task.id, files: task.files, working_directory: dir },
			dir,
			{ sessionID: SESSION, messageID: `m-${task.id}` },
		);
		expect(declared.success).toBe(true);
	}
	recordPhaseAgentDispatch(SESSION, 'coder');
}

function gate() {
	const hook = createDelegationGateHook(
		{
			hooks: { delegation_gate: true },
			worktree: { policy: 'auto' },
		} as PluginConfig,
		dir,
	);
	return {
		hook,
		dispatch: (taskId: string, callID: string) =>
			hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID },
				{ args: coderArgs(taskId) },
			),
	};
}

function coderArgs(taskId: string) {
	return {
		subagent_type: 'coder',
		task_id: taskId,
		prompt: `TASK: ${taskId}\n${finalTask(taskId)
			.files.map((f) => `FILE: ${f}`)
			.join('\n')}\nACCEPTANCE: done`,
	};
}

/**
 * The admitted coder of `callID` writes `files` in its lane and returns:
 * the gate's Task after-hook settles it — the production landing (a commit
 * on the epic branch) and the coder's evidence settlement.
 */
async function landLane(
	hook: ReturnType<typeof gate>['hook'],
	callID: string,
	taskId: string,
	files: Record<string, string>,
): Promise<void> {
	const lane = standardWorktreeByCallID.get(callID);
	if (!lane) throw new Error(`no isolated worktree for ${callID}`);
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(lane.handle.worktreePath, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	await hook.toolAfter(
		{ tool: 'Task', sessionID: SESSION, callID, args: coderArgs(taskId) },
		{ output: `Implemented ${taskId}.` },
	);
	expect(standardWorktreeByCallID.has(callID)).toBe(false);
	expect(subject()).toBe(`swarm(task ${taskId}): ${finalDescription(taskId)}`);
	// Stage A (pre_check_batch) passes for the landed generation.
	const { generation } = getTaskWorkflowSnapshot(
		await readTaskEvidence(dir, taskId),
	);
	await transitionTaskWorkflowEvidence(dir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: `contract-final:stage-a:${taskId}:${generation}`,
	});
}

async function reviewAndComplete(phase: number, minute: number) {
	repo.setClock(minute);
	writeFinalPhaseEvidence(dir, phase, atMinute(minute));
	expect(
		await executeEpicPhaseReview({ phase }, dir, SESSION, {
			dispatcher: approvingReviewDispatcher,
		}),
	).toMatchObject({ success: true, ready: true });
	const completed = JSON.parse(
		await phase_complete.execute({ phase, sessionID: SESSION }),
	);
	expect(completed.success).toBe(true);
}

const subject = () => repo.git(['log', '-1', '--format=%s']).trim();
const head = () => repo.git(['rev-parse', 'HEAD']).trim();

describe('Epic lifecycle contract — final', () => {
	test('save_plan → start → gated waves with rework → phases → report → close', async () => {
		// ── save_plan: Epic shaping says the plan is epic-sized ───────────
		const saved = await executeSavePlan(finalSavePlanArgs(dir));
		expect(saved.success).toBe(true);
		expect(saved.epic_shaping).toMatchObject({
			status: 'acceptable',
			epic_sized: true,
		});
		const plan = await loadPlanJsonOnly(dir);
		if (!plan) throw new Error('plan not saved');
		await recordPlanCriticApproval(dir, plan);
		const originalTip = head();

		// ── start ─────────────────────────────────────────────────────────
		expect(await handleEpicCommand(dir, ['start'], SESSION)).toContain(
			'opened for plan `contract-swarm-Contract_Final`',
		);
		const epic = getOpenEpic(dir);
		if (!epic?.git.epicBranch) throw new Error('no epic branch');
		expect(epic.forced).toBe(false);
		const prefix = `refs/swarm/epics/${epic.epicKey}`;
		await declarePhase(1);

		// ── the gate: no wave yet, then only the wave's tasks ─────────────
		const { hook, dispatch } = gate();
		await expect(dispatch('1.1', 'early')).rejects.toThrow(
			'EPIC_NO_ACTIVE_WAVE',
		);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, kind: 'parallel', taskIds: ['1.1', '1.2', '1.4'] },
		});
		await expect(dispatch('1.3', 'not-in-wave')).rejects.toThrow(
			'EPIC_TASK_NOT_IN_ACTIVE_WAVE',
		);
		await Promise.all(
			['1.1', '1.2', '1.4'].map((id) => dispatch(id, `c-${id}`)),
		);

		// ── landings: commits on the epic branch ──────────────────────────
		repo.setClock(5);
		await landLane(hook, 'c-1.1', '1.1', {
			'src/sum.ts': 'export const sum = (a: number, b: number) => a - b;\n',
		});
		for (const id of ['1.2', '1.4']) {
			await landLane(hook, `c-${id}`, id, {
				[finalTask(id).files[0]]: finalContent(id),
			});
		}
		repo.setClock(10);
		await updateTaskStatus(dir, '1.2', 'completed');
		await updateTaskStatus(dir, '1.4', 'completed');

		// ── test_engineer residue, Stage B failure, rework ───────────────
		fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'tests', 'sum.test.ts'),
			'expect(sum(1, 2)).toBe(3); // fails against attempt 1\n',
		);
		await hook.toolAfter(
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
		// The Stage B test gate failed (evidence workflow) → rework.
		const generation = getTaskWorkflowSnapshot(
			await readTaskEvidence(dir, '1.1'),
		).generation;
		expect(generation).toBe(1);
		await transitionTaskWorkflowEvidence(dir, '1.1', {
			type: 'stage_b_failed',
			gate: 'test_engineer',
			expectedGeneration: generation,
			transitionId: 'contract-final:stage-b:1.1',
		});
		await dispatch('1.1', 'c-1.1-rework');
		// Cut from HEAD: the rework sees attempt 1 AND the residue test.
		const reworkLane = standardWorktreeByCallID.get('c-1.1-rework');
		const inLane = (file: string) =>
			fs.readFileSync(
				path.join(reworkLane?.handle.worktreePath ?? '', file),
				'utf-8',
			);
		expect(inLane('tests/sum.test.ts')).toContain('fails against attempt 1');
		expect(inLane('src/sum.ts')).toContain('a - b');
		repo.setClock(15);
		await landLane(hook, 'c-1.1-rework', '1.1', {
			'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n',
		});
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(dir, '1.1')).generation,
		).toBe(2);
		const reworkLanding = head();
		repo.setClock(20);
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(head()).toBe(reworkLanding);

		// ── wave close: outcomes, refs, learning; wave 2 via 1.1's ref ───
		repo.setClock(25);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, taskIds: ['1.3'] },
			closedWave: { seq: 1 },
		});
		const afterWave1 = getOpenEpic(dir);
		expect(afterWave1?.tasks['1.1']).toMatchObject({
			resolution: 'completed',
			resolvedAt: atMinute(20),
			stageBFailures: 1,
			marker: { sha: reworkLanding, provenance: 'landing-commit' },
		});
		expect(afterWave1?.tasks['1.1']?.generation).toBe(2);
		expect(repo.git(['rev-parse', `${prefix}/tasks/1.1`]).trim()).toBe(
			reworkLanding,
		);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'epic', 'posterior.json')),
		).toBe(true);
		await dispatch('1.3', 'c-1.3');
		await landLane(hook, 'c-1.3', '1.3', {
			'src/c.ts': finalContent('1.3'),
		});
		repo.setClock(35);
		await updateTaskStatus(dir, '1.3', 'completed');
		repo.setClock(40);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
			closedWave: { seq: 2 },
		});
		await reviewAndComplete(1, 45);

		// ── phase 2: 2.1's cross-phase predecessor proven by 1.3's ref ───
		await declarePhase(2);
		repo.setClock(50);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 3, phase: 2, taskIds: ['2.1', '2.2', '2.3'] },
		});
		expect(repo.git(['rev-parse', `${prefix}/tasks/1.3`]).trim()).toBe(
			getOpenEpic(dir)?.tasks['1.3']?.marker?.sha,
		);
		for (const id of ['2.1', '2.2', '2.3']) {
			expect(
				await landEpicTaskForTest(dir, id, {
					[finalTask(id).files[0]]: finalContent(id),
				}),
			).toMatchObject({ merged: true });
		}
		repo.setClock(60);
		for (const id of ['2.1', '2.2', '2.3']) {
			await updateTaskStatus(dir, id, 'completed');
		}
		repo.setClock(65);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 2,
		});
		await reviewAndComplete(2, 70);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'epic-complete',
			message: expect.stringContaining('`/swarm epic report`'),
		});

		// ── the live scorecard ────────────────────────────────────────────
		const live = JSON.parse(
			await handleEpicCommand(dir, ['report', '--format', 'json'], SESSION),
		);
		expect(live).toMatchObject({
			source: 'live',
			scorecard: {
				outcome: 'open',
				forced: false,
				tasks: { total: 7, completedInEpic: 7, adoptedAtStart: 0 },
				waves: { count: 3, parallel: 2, maxWidth: 3 },
				// Spans 25 + 15 + 15 = 55 min; work 20+10+10 + 10 + 3×10 = 80.
				time: {
					spanMs: 55 * 60_000,
					workMs: 80 * 60_000,
					concurrencyFactor: 1.455,
					interWaveIdleMs: 10 * 60_000,
				},
				conflicts: {
					mergeFailures: 0,
					undeclaredWriteTasks: 0,
					undeclaredFiles: [],
					undeclaredFilesTotal: 0,
				},
				rework: { tasksWithRework: 1, extraGenerations: 1, reopened: 0 },
				gates: {
					stageAFirstPass: { passed: 7, of: 7, rate: 1 },
					stageBFirstPass: { passed: 6, of: 7, rate: 0.857 },
					phaseReviewFirstPass: { passed: 2, of: 2, rate: 1 },
				},
			},
		});
		const epicDiff = repo.git(['diff', originalTip, epic.git.epicBranch]);

		// ── close: squash land, scorecard in the report, prior, refs ─────
		repo.setClock(80);
		const closed = await handleEpicCommand(dir, ['close'], SESSION);
		expect(closed).toContain('closed (**completed**).');
		expect(closed).toContain('concurrency factor ×1.455 (not a speedup)');
		expect(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
		expect(repo.git(['diff', '--cached'])).toBe(epicDiff);
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(repo.git(['for-each-ref', 'refs/swarm'])).toBe('');
		const reports = fs.readdirSync(
			path.join(dir, '.swarm', 'epic-prior', 'reports'),
		);
		expect(reports).toHaveLength(1);
		const report = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'epic-prior', 'reports', reports[0]),
				'utf-8',
			),
		);
		expect(report.schema).toBe('epic-report-v2');
		expect(report.scorecard).toEqual({
			...live.scorecard,
			outcome: 'completed',
			closedAt: atMinute(80),
		});
		expect(Object.keys(report.refs.entries)).toContain(`${prefix}/tasks/2.1`);
		expect(report.learning).toMatchObject({ status: 'merged' });
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'epic-prior', 'learning.json')),
		).toBe(true);

		// ── the past epic's report reads the same scorecard back ─────────
		const past = JSON.parse(
			await handleEpicCommand(
				dir,
				['report', 'last', '--format=json'],
				SESSION,
			),
		);
		expect(past).toMatchObject({
			source: 'report',
			reportKey: reports[0].replace(/\.json$/, ''),
		});
		expect(past.scorecard).toEqual(report.scorecard);
	});
});
