/**
 * Epic v2 lifecycle CONTRACT v4 (commit C4 — the delegation gate enforces
 * the active wave from its frozen scopes).
 *
 * One epic on a real git repository (`epic-branch` policy) whose plan runs
 * with `parallelization_enabled: false`, through the production entry
 * points:
 *
 *   `/swarm epic start --force`
 *   → a coder before any wave is refused EPIC_NO_ACTIVE_WAVE
 *   → epic_next_wave dispatches wave 1 = [1.1, 1.2] (disjoint frozen scopes)
 *   → a coder for 1.3 (not in the wave) is refused
 *     EPIC_TASK_NOT_IN_ACTIVE_WAVE
 *   → the 1.1 and 1.2 coders are dispatched CONCURRENTLY through the real
 *     gate: both admitted (no PARALLEL_SLOTS_EXHAUSTED although the profile
 *     says serial), each in its own REAL linked git worktree
 *   → both lanes settle through the production `finishStandardWorktreeDispatch`
 *     (landing commits on the epic branch) → completed
 *   → epic_next_wave closes wave 1 and issues wave 2 = [1.3]; 1.4 (wave 3)
 *     is refused, a 1.3 scope re-declared past the frozen one is refused
 *     EPIC_WAVE_SCOPE_DRIFT, and 1.3 back inside it is admitted (isolated).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { PluginConfig } from '../../src/config';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { getOpenEpic } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import {
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../src/hooks/delegation-gate/worktree-isolation';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../src/plan/manager';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { recordPlanCriticApproval } from '../helpers/approved-plan';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'ses_contractV4';
const FROZEN_ISO = '2026-09-25T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const realStart = { ...startInternals };

let dir: string;
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

const FILES: Record<string, string> = {
	'1.1': 'src/a.ts',
	'1.2': 'src/b.ts',
	'1.3': 'src/c.ts',
	'1.4': 'src/e.ts',
};

function plan(): Plan {
	const task = (id: string, depends: string[] = []) => ({
		id,
		phase: 1,
		status: 'pending' as const,
		size: 'small' as const,
		description: `implement ${id}`,
		depends,
		files_touched: [FILES[id]],
	});
	return {
		schema_version: '1.0.0',
		title: 'Contract V4',
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		execution_profile: {
			parallelization_enabled: false,
			max_concurrent_tasks: 1,
			council_parallel: false,
			locked: true,
		},
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					task('1.1'),
					task('1.2'),
					task('1.3', ['1.1']),
					task('1.4', ['1.3']),
				],
			},
		],
	};
}

function coder(taskId: string, files = [FILES[taskId]]) {
	return {
		subagent_type: 'coder',
		task_id: taskId,
		prompt: `TASK: ${taskId}\n${files.map((f) => `FILE: ${f}`).join('\n')}\nACCEPTANCE: done`,
	};
}

async function declare(
	taskId: string,
	files: string[],
	replace = false,
): Promise<void> {
	const declared = await executeDeclareScope(
		{
			taskId,
			files,
			working_directory: dir,
			...(replace ? { replace_existing: true } : {}),
		},
		dir,
		{ sessionID: SESSION, messageID: `m-${taskId}-${files.length}` },
	);
	expect(declared.success).toBe(true);
}

let childCount = 0;

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c4-');
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
	fs.writeFileSync(
		path.join(dir, '.gitignore'),
		'.swarm/\n.swarm-worktrees/\n',
	);
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	ensureAgentSession(SESSION, 'architect', dir);
	childCount = 0;
	// The SDK client: each isolated coder gets its own child session.
	swarmState.opencodeClient = {
		session: {
			create: async () => ({ data: { id: `ses_child_${++childCount}` } }),
		},
	} as unknown as typeof swarmState.opencodeClient;
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	swarmState.opencodeClient = null as never;
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	try {
		for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
			const lane = line.startsWith('worktree ') ? line.slice(9) : '';
			if (lane && path.resolve(lane) !== path.resolve(dir)) {
				git(['worktree', 'remove', '--force', lane]);
			}
		}
	} catch {
		// best-effort
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v4 — the gate enforces the active wave', () => {
	test('wave-only admission; a 2-task wave runs concurrently in isolated worktrees; next wave after close', async () => {
		expect(
			await handleEpicCommand(dir, ['start', '--force'], SESSION),
		).toContain('opened for plan');
		const epicBranch = getOpenEpic(dir)?.git.epicBranch ?? '';
		for (const [taskId, file] of Object.entries(FILES)) {
			await declare(taskId, [file]);
		}
		const saved = await loadPlanJsonOnly(dir);
		if (!saved) throw new Error('plan not saved');
		await recordPlanCriticApproval(dir, saved);
		const gate = createDelegationGateHook(
			{
				hooks: { delegation_gate: true },
				worktree: { policy: 'auto' },
			} as PluginConfig,
			dir,
		);
		const dispatch = (taskId: string, callID: string, files?: string[]) =>
			gate.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID },
				{ args: coder(taskId, files) },
			);

		// No wave yet.
		await expect(dispatch('1.1', 'early')).rejects.toThrow(
			'EPIC_NO_ACTIVE_WAVE',
		);

		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, taskIds: ['1.1', '1.2'] },
		});
		await expect(dispatch('1.3', 'not-in-wave')).rejects.toThrow(
			'EPIC_TASK_NOT_IN_ACTIVE_WAVE',
		);

		// Both wave coders in ONE message: admitted concurrently, isolated.
		await Promise.all([dispatch('1.1', 'c-1.1'), dispatch('1.2', 'c-1.2')]);
		const lanes = ['c-1.1', 'c-1.2'].map((callID) => {
			const lane = standardWorktreeByCallID.get(callID);
			if (!lane) throw new Error(`no isolated worktree for ${callID}`);
			return lane;
		});
		expect(lanes.map((l) => l.planTaskId)).toEqual(['1.1', '1.2']);
		expect(lanes[0].handle.worktreePath).not.toBe(lanes[1].handle.worktreePath);
		const worktrees = git(['worktree', 'list', '--porcelain']);
		for (const lane of lanes) {
			expect(fs.existsSync(lane.handle.worktreePath)).toBe(true);
			expect(worktrees).toContain(lane.handle.branchName);
		}
		// The main tree is untouched by the dispatch.
		expect(git(['status', '--porcelain']).trim()).toBe('');

		// Each coder writes in its lane; the production settlement lands it.
		for (const lane of lanes) {
			const taskId = lane.planTaskId ?? '';
			const target = path.join(lane.handle.worktreePath, FILES[taskId]);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, `export const t = '${taskId}';\n`);
			expect(await finishStandardWorktreeDispatch(dir, lane)).toMatchObject({
				outcome: 'merged',
			});
			await updateTaskStatus(dir, taskId, 'completed');
		}
		expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(epicBranch);
		// Each landing is a --no-ff merge commit on the epic branch whose
		// SECOND parent is the lane's own commit (`swarm-lane: auto-commit
		// before cleanup`). The epic branch's history is its first-parent
		// line: a plain `git log -2` orders by commit date, so whenever the
		// second lane's commit falls in a later second than the first merge,
		// that lane commit would sort between the two merges (the old flake).
		const landings = git(['log', '--first-parent', '--format=%P%x09%s', '-2'])
			.trim()
			.split('\n')
			.map((line) => {
				const [parents, subject] = line.split('\t');
				return { parents: parents.split(' ').length, subject };
			});
		expect(landings.map((l) => l.subject).sort()).toEqual([
			'swarm(task 1.1): implement 1.1',
			'swarm(task 1.2): implement 1.2',
		]);
		expect(landings.map((l) => l.parents)).toEqual([2, 2]);

		// Wave 1 closes; wave 2 = [1.3] (its dependency 1.1 is committed).
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, taskIds: ['1.3'] },
			closedWave: { seq: 1 },
		});
		await expect(dispatch('1.4', 'later-wave')).rejects.toThrow(
			'EPIC_TASK_NOT_IN_ACTIVE_WAVE',
		);
		// A scope re-declared past the frozen one is drift; back inside, the
		// coder is admitted (isolated).
		const grown = ['src/c.ts', 'src/d.ts'];
		await declare('1.3', grown, true);
		await expect(dispatch('1.3', 'drift', grown)).rejects.toThrow(
			'EPIC_WAVE_SCOPE_DRIFT',
		);
		await declare('1.3', ['src/c.ts'], true);
		await dispatch('1.3', 'c-1.3');
		expect(standardWorktreeByCallID.get('c-1.3')?.planTaskId).toBe('1.3');
	});
});
