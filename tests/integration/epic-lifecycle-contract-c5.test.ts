/**
 * Epic v2 lifecycle CONTRACT v5 (commit C5 — per-component parallelism).
 *
 * One epic on a real git repository (`epic-branch` policy) whose phase has a
 * HUB-FILE cluster — 1.1, 1.2, 1.3 all edit `src/hub.ts` (one dense,
 * `serial-component` component) — and independent tasks 1.4, 1.5 with
 * dependents 1.6 → 1.4 and 1.7 → 1.5. Through the production entry points:
 *
 *   `/swarm epic start` — epic-sized by the component-planner dry-run
 *     (3 serial steps for 7 tasks)
 *   → epic_next_wave: wave 1 = [1.1, 1.4, 1.5] — ONE hub task beside the
 *     independents; the wave records the components (hub cluster serial,
 *     density 1); the gate's dispatch policy admits 1.1 as PARALLEL and
 *     refuses 1.2 (not in the wave)
 *   → landing commits + completion → wave 2 = [1.6, 1.7, 1.2]: the waiting
 *     independents run beside the NEXT hub task (the hub serializes only
 *     within itself; the older components go first)
 *   → wave 3 = [1.3] → phase-ready-for-review; `/swarm epic status` shows
 *     the components.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { resolveEpicDispatchPolicy } from '../../src/epic/gate-policy';
import { getOpenEpic } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'ses_contractV5';
const FROZEN_ISO = '2026-10-01T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const realStart = { ...startInternals };

let dir: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let restoreClock: Restore | null = null;

function git(args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

const HUB = ['1.1', '1.2', '1.3'];
const DEPENDS: Record<string, string[]> = { '1.6': ['1.4'], '1.7': ['1.5'] };
const IDS = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'];

function filesOf(id: string): string[] {
	const own = `src/t${id.replace('.', '_')}.ts`;
	return HUB.includes(id) ? ['src/hub.ts', own] : [own];
}

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Contract V5',
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: IDS.map((id) => ({
					id,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `implement ${id}`,
					depends: DEPENDS[id] ?? [],
					files_touched: filesOf(id),
				})),
			},
		],
	};
}

async function completeTask(id: string): Promise<void> {
	const files: Record<string, string> = {};
	for (const file of filesOf(id)) files[file] = `// written by ${id}\n`;
	expect(await landEpicTaskForTest(dir, id, files)).toMatchObject({
		merged: true,
	});
	await updateTaskStatus(dir, id, 'completed');
}

async function policyFor(taskId: string) {
	const current = await loadPlanJsonOnly(dir);
	if (!current) throw new Error('plan not saved');
	return resolveEpicDispatchPolicy(dir, current, taskId, filesOf(taskId));
}

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c5-');
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
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v5 — a hub cluster serializes only within itself', () => {
	test('independent tasks fill parallel waves beside one hub task per wave', async () => {
		expect(await handleEpicCommand(dir, ['start'], SESSION)).toContain(
			'opened for plan',
		);
		expect(getOpenEpic(dir)?.sizing).toMatchObject({
			epicSized: true,
			pendingTasks: 7,
			serialSteps: 3,
		});
		for (const id of IDS) {
			const declared = await executeDeclareScope(
				{ taskId: id, files: filesOf(id), working_directory: dir },
				dir,
				{ sessionID: SESSION, messageID: `m-${id}` },
			);
			expect(declared.success).toBe(true);
		}

		// Wave 1: one hub task beside the ready independents.
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, kind: 'parallel', taskIds: ['1.1', '1.4', '1.5'] },
		});
		expect(getOpenEpic(dir)?.waves[0].components).toEqual({
			byTask: {
				'1.1': '1.1',
				'1.2': '1.1',
				'1.3': '1.1',
				'1.4': '1.4',
				'1.5': '1.5',
				'1.6': '1.6',
				'1.7': '1.7',
			},
			modes: {
				'1.1': 'serial-component',
				'1.4': 'parallel',
				'1.5': 'parallel',
				'1.6': 'parallel',
				'1.7': 'parallel',
			},
			density: { '1.1': 1, '1.4': 0, '1.5': 0, '1.6': 0, '1.7': 0 },
			exclusive: {},
			threshold: 0.3,
			truncated: false,
		});
		// The gate's SSOT admits the hub task as a parallel coder of the wave
		// and refuses the next hub task.
		expect(await policyFor('1.1')).toMatchObject({
			kind: 'allow',
			parallel: true,
			isolate: true,
		});
		expect(await policyFor('1.2')).toMatchObject({
			kind: 'reject',
			code: 'EPIC_TASK_NOT_IN_ACTIVE_WAVE',
		});
		for (const id of ['1.1', '1.4', '1.5']) await completeTask(id);

		// Wave 2: the waiting independents (older components first) beside
		// the next hub task.
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, kind: 'parallel', taskIds: ['1.6', '1.7', '1.2'] },
			closedWave: { seq: 1 },
		});
		expect(await policyFor('1.2')).toMatchObject({
			kind: 'allow',
			parallel: true,
		});
		for (const id of ['1.6', '1.7', '1.2']) await completeTask(id);

		// Wave 3: the last hub task.
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 3, taskIds: ['1.3'] },
		});
		const status = await handleEpicCommand(dir, ['status'], SESSION);
		expect(status).toContain('- Components when wave 3 was issued');
		await completeTask('1.3');
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
			closedWave: { seq: 3 },
		});
		expect(
			git(['log', '--first-parent', '--format=%s', '-7'])
				.trim()
				.split('\n')
				.sort(),
		).toEqual(IDS.map((id) => `swarm(task ${id}): implement ${id}`));
	});
});
