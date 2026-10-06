/**
 * Epic v2 C4 — fixing phase-review findings while an epic is open (review
 * F1). The gate admits coders only for the active wave, so "dispatch coders
 * for the affected tasks" is impossible after `phase-ready-for-review`.
 * The official path, end to end on a real git epic:
 *
 *   wave 1 lands + completes → phase-ready-for-review
 *   → epic_phase_review: reviewer NEEDS_REVISION (the message names the
 *     fix-task path); a coder for a completed task is refused
 *     EPIC_NO_ACTIVE_WAVE, whose message also names it
 *   → save_plan adds fix task 1.3 (pending, files_touched) to phase 1
 *   → epic_next_wave → declare-scopes [1.3] → declare → dispatch fix wave
 *     [1.3]; the gate admits its coder
 *   → 1.3 lands (commit on the epic branch) + completes
 *   → epic_next_wave closes the fix wave → phase-ready-for-review again
 *   → epic_phase_review APPROVED → phase_complete → epic-complete.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { PluginConfig } from '../../src/config';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { resolveEpicDispatchPolicy } from '../../src/epic/gate-policy';
import { getOpenEpic } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../src/plan/manager';
import type { ReviewModelDispatcher } from '../../src/review/contracts';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeEpicPhaseReview } from '../../src/tools/epic-phase-review';
import { recordPlanCriticApproval } from '../helpers/approved-plan';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const { phase_complete } = await import('../../src/tools/phase-complete');

const SESSION = 'ses_phaseFixWave';
const FROZEN_ISO = '2026-09-28T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
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

const fileOf = (id: string) => `src/task-${id}.ts`;
const ident = (id: string) => `task_${id.replace('.', '_')}`;

function task(id: string) {
	return {
		id,
		phase: 1,
		status: 'pending' as const,
		size: 'small' as const,
		description: `Create ${fileOf(id)} exporting ${ident(id)}`,
		depends: [],
		files_touched: [fileOf(id)],
	};
}

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Phase Fix Wave',
		swarm: 'fix-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [task('1.1'), task('1.2')],
			},
		],
	};
}

function writeRetro(): void {
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
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 1,
					task_count: 3,
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

const dispatcher = (verdict: string): ReviewModelDispatcher => ({
	dispatch: async (request) => ({
		status: 'completed',
		agentName: request.agentName,
		text: `VERDICT: ${verdict}\nREASON: the two halves disagree on the export name`,
		durationMs: 1,
		promptBytes: 0,
		responseBytes: 0,
	}),
});

async function declare(id: string): Promise<void> {
	const declared = await executeDeclareScope(
		{ taskId: id, files: [fileOf(id)], working_directory: dir },
		dir,
		{ sessionID: SESSION, messageID: `m-${id}` },
	);
	expect(declared.success).toBe(true);
}

async function landAndComplete(id: string): Promise<void> {
	expect(
		await landEpicTaskForTest(dir, id, {
			[fileOf(id)]: `export const ${ident(id)} = '${id}';\n`,
		}),
	).toMatchObject({ merged: true });
	expect(git(['log', '-1', '--format=%s'])).toStartWith(`swarm(task ${id}):`);
	await updateTaskStatus(dir, id, 'completed');
}

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-phase-fix-');
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
			epic: { mode: { enabled: true } },
		}),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	ensureAgentSession(SESSION, 'architect', dir);
	originalCwd = process.cwd();
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

describe('Epic phase review NEEDS_REVISION → fix task → fix wave → review again', () => {
	test('the official fix path ends in phase_complete', async () => {
		expect(
			await handleEpicCommand(dir, ['start', '--force'], SESSION),
		).toContain('opened for plan');
		await declare('1.1');
		await declare('1.2');
		recordPhaseAgentDispatch(SESSION, 'coder');
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, taskIds: ['1.1', '1.2'] },
		});
		await landAndComplete('1.1');
		await landAndComplete('1.2');
		const ready = await runEpicNextWave(dir, SESSION);
		expect(ready).toMatchObject({ status: 'phase-ready-for-review', phase: 1 });
		if (ready.status === 'phase-ready-for-review') {
			expect(ready.message).toContain('NEW pending task of phase 1');
		}

		// Review: NEEDS_REVISION → the message names the fix-task path.
		writeRetro();
		const rejected = await executeEpicPhaseReview({ phase: 1 }, dir, SESSION, {
			dispatcher: dispatcher('NEEDS_REVISION'),
		});
		expect(rejected).toMatchObject({ success: true, ready: false });
		expect(JSON.stringify(rejected)).toContain('NEW pending task of phase 1');
		expect(JSON.stringify(rejected)).toContain('save_plan');
		// phase_complete is refused with the same path.
		const refused = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: SESSION }),
		);
		expect(refused.success).toBe(false);
		expect(JSON.stringify(refused)).toContain('NEW pending task of phase 1');

		// Re-dispatching a coder for a completed task is refused, with the path.
		const saved = await loadPlanJsonOnly(dir);
		if (!saved) throw new Error('plan');
		const redo = resolveEpicDispatchPolicy(dir, saved, '1.1', [fileOf('1.1')]);
		expect(redo).toMatchObject({ kind: 'reject', code: 'EPIC_NO_ACTIVE_WAVE' });
		if (redo?.kind === 'reject') {
			expect(redo.message).toContain('Phase 1 is in review');
		}

		// The fix: a NEW pending task of phase 1 (save_plan).
		saved.phases[0].tasks.push({
			...task('1.3'),
			description: `Fix review findings: create ${fileOf('1.3')} exporting ${ident('1.3')}`,
		});
		await savePlan(dir, saved);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'declare-scopes',
			tasks: [{ taskId: '1.3' }],
		});
		await declare('1.3');
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, phase: 1, taskIds: ['1.3'] },
		});

		// The real gate admits the fix wave's coder (isolation is attempted:
		// no SDK client here, so the refusal is EPIC_ISOLATION_DEGRADED — never
		// a wave refusal).
		const fixed = await loadPlanJsonOnly(dir);
		if (!fixed) throw new Error('plan');
		await recordPlanCriticApproval(dir, fixed);
		const gate = createDelegationGateHook(
			{
				hooks: { delegation_gate: true },
				worktree: { policy: 'auto' },
			} as PluginConfig,
			dir,
		);
		await expect(
			gate.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'fix-1.3' },
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.3',
						prompt: `TASK: 1.3\nFILE: ${fileOf('1.3')}\nACCEPTANCE: done`,
					},
				},
			),
		).rejects.toThrow('EPIC_ISOLATION_DEGRADED');
		expect(
			resolveEpicDispatchPolicy(dir, fixed, '1.3', [fileOf('1.3')]),
		).toMatchObject({ kind: 'allow', isolate: true, parallel: false });

		// The fix lands and completes; the fix wave closes; review again.
		await landAndComplete('1.3');
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
			closedWave: { seq: 2 },
		});
		expect(getOpenEpic(dir)?.tasks['1.3']).toMatchObject({
			resolution: 'completed',
			waveSeq: 2,
		});
		const approved = await executeEpicPhaseReview({ phase: 1 }, dir, SESSION, {
			dispatcher: dispatcher('APPROVED'),
		});
		expect(approved).toMatchObject({ success: true, ready: true });
		const completed = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: SESSION }),
		);
		expect(completed.success).toBe(true);
		expect(getOpenEpic(dir)?.phases['1']).toMatchObject({ status: 'complete' });
		expect((await runEpicNextWave(dir, SESSION)).status).toBe('epic-complete');
	});
});
