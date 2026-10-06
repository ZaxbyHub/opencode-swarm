/**
 * Epic v2 lifecycle CONTRACT v1b (commit C1b — epic branch + landing).
 *
 * One epic, end to end, through the production entry points on a real git
 * repository with the DEFAULT commit policy (`epic-branch`):
 *   `/swarm epic start` (checks out `swarm/epic/<epicKey>`) → declare_scope
 *   → each coder's real worktree landing (Epic v2 C3: a merge commit on the
 *   EPIC branch; the original branch never moves) → per-task completion → `/swarm epic close` (default
 *   `--land squash`) → back on the original branch with the epic's whole
 *   diff staged and uncommitted, the epic branch kept, probe off.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { getOpenEpic, isEpicOpenForProject } from '../../src/epic/lifecycle';
import { _internals as startInternals } from '../../src/epic/start';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'ses_contractV1b';
const FROZEN_ISO = '2026-07-05T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const TASK_IDS = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'];
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

function ident(id: string): string {
	return `task_${id.replace('.', '_')}`;
}

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Contract V1b',
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: TASK_IDS.map((id) => ({
					id,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `Create src/task-${id}.ts exporting ${ident(id)}`,
					depends: [],
					files_touched: [`src/task-${id}.ts`],
				})),
			},
		],
	};
}

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c1b-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			curator: { enabled: false },
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

describe('Epic lifecycle contract v1b — epic branch → landings on the branch → close squash', () => {
	test('the original branch receives the epic diff as staged, uncommitted changes', async () => {
		const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
		const originalTip = git(['rev-parse', 'HEAD']).trim();

		// start: epic-branch is the default policy.
		const started = await handleEpicCommand(dir, ['start'], SESSION);
		expect(started).toContain('opened for plan `contract-swarm-Contract_V1b`');
		const epic = getOpenEpic(dir);
		expect(epic?.config.commitPolicy).toBe('epic-branch');
		const epicBranch = epic?.git.epicBranch ?? '';
		expect(epicBranch).toBe(`swarm/epic/${epic?.epicKey}`);
		expect(started).toContain(
			`commits go to the epic branch \`${epicBranch}\``,
		);
		expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(epicBranch);

		// each task lands as a commit on the epic branch.
		for (const id of TASK_IDS) {
			const declared = await executeDeclareScope(
				{ taskId: id, files: [`src/task-${id}.ts`], working_directory: dir },
				dir,
				{ sessionID: SESSION, messageID: `m-${id}` },
			);
			expect(declared.success).toBe(true);
		}
		for (const id of TASK_IDS) {
			expect(
				await landEpicTaskForTest(dir, id, {
					[`src/task-${id}.ts`]: `export const ${ident(id)} = '${id}';\n`,
				}),
			).toMatchObject({ merged: true, strategy: 'merge' });
			await updateTaskStatus(dir, id, 'completed');
			const message = git(['log', '-1', '--format=%B', epicBranch]);
			expect(message.startsWith(`swarm(task ${id}):`)).toBe(true);
			expect(message).toContain(`Swarm-Plan: ${epic?.planKey}`);
		}
		expect(git(['rev-parse', originalBranch]).trim()).toBe(originalTip);
		const epicDiff = git(['diff', originalTip, epicBranch]);
		expect(epicDiff).toContain('+export const task_1_6');

		// close (default squash).
		const closed = await handleEpicCommand(dir, ['close'], SESSION);
		expect(closed).toContain('closed (**completed**).');
		expect(closed).toContain('Landing (squash)');
		expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
			originalBranch,
		);
		expect(git(['rev-parse', 'HEAD']).trim()).toBe(originalTip);
		expect(git(['diff', '--cached'])).toBe(epicDiff);
		expect(git(['diff'])).toBe('');
		expect(git(['branch', '--list', epicBranch]).trim()).not.toBe('');
		expect(isEpicOpenForProject(dir)).toBe(false);
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
		expect(report.landing).toMatchObject({
			mode: 'squash',
			status: 'landed',
			epicBranch,
			originalBranch,
		});
	});
});
