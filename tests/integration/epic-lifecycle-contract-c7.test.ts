/**
 * Epic v2 lifecycle CONTRACT v7 (commit C7 — plan shaping).
 *
 * One real git repository (`epic-branch` policy), Epic on, through the
 * production entry points:
 *
 *   save_plan of a hub-file plan (6 tasks share src/registry.ts, 2 are
 *   independent) → its result carries `epic_shaping` (improvable) whose top
 *   suggestion is extract-prerequisite with a concrete patch
 *   → `/swarm epic start` refuses not-epic-sized and shows the same patch
 *   → the architect applies the patch through save_plan (new task 1.9 owns
 *     the registry; 1.1–1.6 depend on it and no longer touch it) → the
 *     result now says the plan is acceptable (epic-sized), iteration 2
 *   → `/swarm epic start` succeeds → after declare_scope, the first wave
 *     issued by epic_next_wave is parallel: the prerequisite and both
 *     independent tasks together.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { getOpenEpic } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import { loadPlanJsonOnly } from '../../src/plan/manager';
import { resetSwarmState } from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeSavePlan } from '../../src/tools/save-plan';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'ses_contractV7';
const FROZEN_ISO = '2026-10-03T12:00:00.000Z';
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

interface TaskArg {
	id: string;
	description: string;
	files_touched: string[];
	depends?: string[];
}

function saveArgs(tasks: TaskArg[]): Parameters<typeof executeSavePlan>[0] {
	return {
		title: 'Contract V7',
		swarm_id: 'contract-swarm',
		working_directory: dir,
		phases: [{ id: 1, name: 'Phase 1', tasks }],
	};
}

const HUB_TASKS: TaskArg[] = [
	...Array.from({ length: 6 }, (_, i) => ({
		id: `1.${i + 1}`,
		description: `Register feature ${i + 1}`,
		files_touched: ['src/registry.ts', `src/feature-${i + 1}.ts`],
	})),
	{ id: '1.7', description: 'Solo work A', files_touched: ['src/solo-a.ts'] },
	{ id: '1.8', description: 'Solo work B', files_touched: ['src/solo-b.ts'] },
];

beforeEach(() => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c7-');
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
});

afterEach(() => {
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	resetSwarmState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v7 — shape the plan, then start', () => {
	test('extract-prerequisite from save_plan → apply via save_plan → start → parallel first wave', async () => {
		// ── 1. save_plan of the hub plan: shaping says how to fix it ───────
		const first = await executeSavePlan(saveArgs(HUB_TASKS));
		expect(first.success).toBe(true);
		const shaping = first.epic_shaping;
		if (shaping?.status !== 'improvable') {
			throw new Error(`expected improvable, got ${JSON.stringify(shaping)}`);
		}
		expect(shaping).toMatchObject({ epic_sized: false, iteration: 1 });
		const top = shaping.suggestions[0];
		if (top.type !== 'extract-prerequisite' || !top.patch) {
			throw new Error(`expected extract-prerequisite, got ${top.type}`);
		}
		expect(top).toMatchObject({
			file: 'src/registry.ts',
			what_if: { epic_sized: true },
		});
		// The advisory payload is snake_case (as save_plan's own fields).
		const patch = top.patch as {
			new_task: TaskArg & { phase: number };
			edits: Array<{
				task_id: string;
				files_touched: string[];
				depends: string[];
			}>;
		};
		expect(patch.new_task.id).toBe('1.9');

		// ── 2. The start refuses and shows the same patch ───────────────────
		const refused = await handleEpicCommand(dir, ['start'], SESSION);
		expect(refused).toContain('Epic not started — **not-epic-sized**');
		expect(refused).toContain('Patch: add task 1.9 to phase 1');
		expect(getOpenEpic(dir)).toBeNull();

		// ── 3. Apply the patch through save_plan ────────────────────────────
		const edits = new Map(patch.edits.map((edit) => [edit.task_id, edit]));
		const patched: TaskArg[] = HUB_TASKS.map((task) => {
			const edit = edits.get(task.id);
			return edit
				? { ...task, files_touched: edit.files_touched, depends: edit.depends }
				: task;
		});
		patched.push({
			id: patch.new_task.id,
			description: patch.new_task.description,
			files_touched: patch.new_task.files_touched,
			depends: patch.new_task.depends,
		});
		const second = await executeSavePlan(saveArgs(patched));
		expect(second.success).toBe(true);
		expect(second.epic_shaping).toMatchObject({
			status: 'acceptable',
			epic_sized: true,
			iteration: 2,
		});
		const saved = await loadPlanJsonOnly(dir);
		expect(saved?.phases[0].tasks.find((t) => t.id === '1.1')).toMatchObject({
			files_touched: ['src/feature-1.ts'],
			depends: ['1.9'],
		});

		// ── 4. The start succeeds ───────────────────────────────────────────
		const started = await handleEpicCommand(dir, ['start'], SESSION);
		expect(started).toContain('opened for plan');
		expect(getOpenEpic(dir)?.forced).toBe(false);

		// ── 5. First wave: parallel (prerequisite + independent tasks) ──────
		for (const task of patched) {
			const declared = await executeDeclareScope(
				{ taskId: task.id, files: task.files_touched, working_directory: dir },
				dir,
				{ sessionID: SESSION, messageID: `m-${task.id}` },
			);
			expect(declared).toMatchObject({ success: true });
		}
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, kind: 'parallel', taskIds: ['1.7', '1.8', '1.9'] },
		});
	});
});
