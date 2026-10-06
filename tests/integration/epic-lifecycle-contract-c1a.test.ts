/**
 * Epic v2 lifecycle CONTRACT v1a (commit C1a — plan-scoped lifecycle;
 * migrated to the C2 `epic_next_wave` flow), `current-branch` policy.
 *
 * One epic, end to end, through the production entry points on a real git
 * repository:
 *   `/swarm epic start` → epic_next_wave (dispatch) → each coder's real
 *   worktree landing (Epic v2 C3: a merge commit carrying the
 *   `Swarm-Plan:` trailer) → per-task completion (no git write) →
 *   epic_next_wave (closes the wave, dispatches the next) → … →
 *   phase-ready-for-review → epic_phase_review (fake review dispatcher
 *   injected through the tool's dispatcher option — no model call) →
 *   phase_complete (the Epic readiness gate passes) → epic_next_wave
 *   (epic-complete) → `/swarm epic close` (report written, probe off).
 * The epic-branch policy + squash landing are pinned by contract v2
 * (epic-lifecycle-contract-c2.test.ts). No in-wave rework (C2 MINOR 6).
 *
 * The epic is opened by `/swarm epic start` itself (config opt-in, sizing
 * verdict epic-sized, not forced). Later v2 commits extend this contract in
 * sibling `epic-lifecycle-contract*.test.ts` files.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { getOpenEpic, isEpicOpenForProject } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import type { ReviewModelDispatcher } from '../../src/review/contracts';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeEpicPhaseReview } from '../../src/tools/epic-phase-review';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const { phase_complete } = await import('../../src/tools/phase-complete');

const SESSION = 'ses_contractV1a';
const FROZEN_ISO = '2026-06-01T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const TASK_IDS = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'];
const realStart = { ...startInternals };

let dir: string;
let originalCwd: string;
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
		title: 'Contract V1a',
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

function writePhaseEvidence(): void {
	const evidence = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(path.join(evidence, 'retro-1'), { recursive: true });
	fs.writeFileSync(
		path.join(evidence, 'retro-1', 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: FROZEN_ISO,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: TASK_IDS.length,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: FROZEN_ISO,
			updated_at: FROZEN_ISO,
		}),
	);
	fs.mkdirSync(path.join(evidence, '1'), { recursive: true });
	fs.writeFileSync(
		path.join(evidence, '1', 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict: 'approved',
					summary: 'Drift check',
					timestamp: FROZEN_ISO,
				},
			],
		}),
	);
}

const approvingDispatcher: ReviewModelDispatcher = {
	dispatch: async (request) => ({
		status: 'completed',
		agentName: request.agentName,
		text: 'VERDICT: APPROVED\nREASON: waves integrate cleanly',
		durationMs: 1,
		promptBytes: 0,
		responseBytes: 0,
	}),
};

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c1a-');
	originalCwd = process.cwd();
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
			// C1a contract pins the `current-branch` policy; the epic-branch
			// default (C1b) is pinned by epic-lifecycle-contract-c1b.
			epic: { mode: { enabled: true }, commit_policy: 'current-branch' },
		}),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	ensureAgentSession(SESSION, 'architect', dir);
	recordPhaseAgentDispatch(SESSION, 'coder');
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(originalCwd);
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	resetSwarmState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v1a — start → next_wave → tasks → review → phase_complete → close', () => {
	test('one plan-scoped epic end to end', async () => {
		// start (not forced: the plan is epic-sized).
		const started = await handleEpicCommand(dir, ['start'], SESSION);
		expect(started).toContain('opened for plan `contract-swarm-Contract_V1a`');
		const epic = getOpenEpic(dir);
		expect(epic?.forced).toBe(false);
		expect(epic?.config.commitPolicy).toBe('current-branch');

		// scopes declared up front (the planner needs live bindings).
		for (const id of TASK_IDS) {
			const declared = await executeDeclareScope(
				{ taskId: id, files: [`src/task-${id}.ts`], working_directory: dir },
				dir,
				{ sessionID: SESSION, messageID: `m-${id}` },
			);
			expect(declared.success).toBe(true);
		}

		// epic_next_wave issues waves (width = the record's cap, 4); each
		// coder's worktree lands as a commit bound to this plan.
		const issued: string[][] = [];
		for (let step = 0; step < 2; step += 1) {
			const next = await runEpicNextWave(dir, SESSION);
			expect(next.status).toBe('dispatch');
			if (next.status !== 'dispatch') return;
			issued.push(next.wave.taskIds);
			for (const id of next.wave.taskIds) {
				expect(
					await landEpicTaskForTest(dir, id, {
						[`src/task-${id}.ts`]: `export const ${ident(id)} = '${id}';\n`,
					}),
				).toMatchObject({ merged: true, strategy: 'merge' });
				const head = git(['rev-parse', 'HEAD']);
				await updateTaskStatus(dir, id, 'completed');
				expect(git(['rev-parse', 'HEAD'])).toBe(head);
				const message = git(['log', '-1', '--format=%B']);
				expect(
					message.startsWith(`swarm(task ${id}): Create src/task-${id}.ts`),
				).toBe(true);
				expect(message).toContain(`Swarm-Plan: ${epic?.planKey}`);
				expect(git(['diff', '--name-only', 'HEAD^1', 'HEAD'])).toContain(
					`src/task-${id}.ts`,
				);
			}
		}
		expect(issued).toEqual([
			['1.1', '1.2', '1.3', '1.4'],
			['1.5', '1.6'],
		]);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
			closedWave: { seq: 2 },
		});

		// epic_phase_review → phase_complete.
		writePhaseEvidence();
		const review = await executeEpicPhaseReview({ phase: 1 }, dir, SESSION, {
			dispatcher: approvingDispatcher,
		});
		expect(review.success).toBe(true);
		const completed = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: SESSION }),
		);
		expect(completed.success).toBe(true);
		expect(
			completed.gate_report.entries.find(
				(entry: { id: string }) => entry.id === 'epic_phase_readiness',
			)?.outcome,
		).toBe('pass');

		expect((await runEpicNextWave(dir, SESSION)).status).toBe('epic-complete');

		// close.
		const closed = await handleEpicCommand(dir, ['close'], SESSION);
		expect(closed).toContain('closed (**completed**).');
		expect(closed).toContain('Tasks: 6 completed, 0 closed, 0 pending (of 6).');
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(
			fs.readdirSync(path.join(dir, '.swarm', 'epic-prior', 'reports')),
		).toHaveLength(1);
	});
});
