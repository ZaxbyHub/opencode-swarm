/**
 * Epic v2 lifecycle CONTRACT — FINAL, config-off twin (commit C8).
 *
 * "Epic off" must mean upstream behaviour. The same non-Epic flow runs
 * twice on identical real git repositories with an identical frozen clock
 * (commit dates pinned, so SHAs are comparable):
 *
 *   A. no `epic` block at all (the upstream-equivalent baseline);
 *   B. a full `epic` block with `mode.enabled: false`, and every Epic
 *      entry point invoked along the way (`/swarm epic start`, `status`,
 *      `report`, `epic_next_wave`) — each refusing or reporting nothing.
 *
 * Flow: save_plan → plan approval → declare_scope → the real delegation
 * gate dispatches a coder (Task before/after: isolation, landing,
 * settlement) → the test_engineer writes a test in the main tree (Task
 * after-hook) → update_task_status(completed) for the phase's tasks.
 *
 * The non-Epic artifacts of B are byte-identical to A's: plan.json, every
 * evidence file, every git ref (name and SHA), the working-tree status,
 * and the `.swarm/` file list. And B carries no Epic trace: no
 * `epic_shaping` in save_plan's result, no `refs/swarm/*`, no
 * `.swarm/epic*`, no epic branch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { PluginConfig } from '../../src/config';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import {
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../src/hooks/delegation-gate/worktree-isolation';
import { loadPlanJsonOnly, updateTaskStatus } from '../../src/plan/manager';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeSavePlan } from '../../src/tools/save-plan';
import { recordPlanCriticApproval } from '../helpers/approved-plan';
import {
	createFinalContractRepo,
	FINAL_PHASES,
	type FinalContractRepo,
	finalContent,
	finalSavePlanArgs,
	finalTask,
	listTree,
} from '../helpers/epic-final-contract';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';

const SESSION = 'ses_contractFinalOff';

let isolatedEnv: { cleanup: () => void } | undefined;
const repos: FinalContractRepo[] = [];

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
});

afterEach(() => {
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	swarmState.opencodeClient = null as never;
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	for (const repo of repos.splice(0)) repo.cleanup();
});

interface FlowArtifacts {
	savePlanKeys: string[];
	planJson: string;
	evidence: Record<string, string>;
	refs: string;
	status: string;
	swarmTree: string[];
	epicTrace: string[];
}

/** Run the non-Epic flow; `epicBlock` undefined ⇒ baseline A. */
async function runFlow(
	prefix: string,
	epicBlock: Record<string, unknown> | undefined,
): Promise<FlowArtifacts> {
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	closeAllProjectDbs();
	const repo = createFinalContractRepo(prefix, epicBlock);
	repos.push(repo);
	const { dir } = repo;
	const touchEpic = epicBlock !== undefined;
	ensureAgentSession(SESSION, 'architect', dir);
	let childCount = 0;
	swarmState.opencodeClient = {
		session: {
			create: async () => ({ data: { id: `ses_child_${++childCount}` } }),
		},
	} as unknown as typeof swarmState.opencodeClient;
	const epicTrace: string[] = [];

	const saved = await executeSavePlan(finalSavePlanArgs(dir));
	expect(saved.success).toBe(true);
	const plan = await loadPlanJsonOnly(dir);
	if (!plan) throw new Error('plan not saved');
	await recordPlanCriticApproval(dir, plan);
	if (touchEpic) {
		epicTrace.push(await handleEpicCommand(dir, ['start'], SESSION));
		epicTrace.push(await handleEpicCommand(dir, ['status'], SESSION));
		epicTrace.push(await handleEpicCommand(dir, ['report'], SESSION));
		epicTrace.push(JSON.stringify(await runEpicNextWave(dir, SESSION)));
	}
	for (const task of FINAL_PHASES[0]) {
		const declared = await executeDeclareScope(
			{ taskId: task.id, files: task.files, working_directory: dir },
			dir,
			{ sessionID: SESSION, messageID: `m-${task.id}` },
		);
		expect(declared.success).toBe(true);
	}

	// One coder through the real gate (before: admission/isolation; after:
	// landing + settlement), then a test_engineer main-tree write.
	const gate = createDelegationGateHook(
		{
			hooks: { delegation_gate: true },
			worktree: { policy: 'auto' },
		} as PluginConfig,
		dir,
	);
	const args = {
		subagent_type: 'coder',
		task_id: '1.2',
		prompt: `TASK: 1.2\nFILE: ${finalTask('1.2').files[0]}\nACCEPTANCE: done`,
	};
	repo.setClock(5);
	await gate.toolBefore(
		{ tool: 'Task', sessionID: SESSION, callID: 'c-1.2' },
		{ args },
	);
	const lane = standardWorktreeByCallID.get('c-1.2');
	const root = lane ? lane.handle.worktreePath : dir;
	const target = path.join(root, finalTask('1.2').files[0]);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, finalContent('1.2'));
	await gate.toolAfter(
		{ tool: 'Task', sessionID: SESSION, callID: 'c-1.2', args },
		{ output: 'Implemented 1.2.' },
	);
	repo.setClock(10);
	fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'tests', 'sum.test.ts'), 'test\n');
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
		{ output: '[TESTED] 1.1 PASS' },
	);
	repo.setClock(15);
	for (const task of FINAL_PHASES[0]) {
		await updateTaskStatus(dir, task.id, 'completed');
	}
	if (touchEpic) {
		epicTrace.push(JSON.stringify(await runEpicNextWave(dir, SESSION)));
	}

	repo.releaseClock();
	const swarm = path.join(dir, '.swarm');
	const evidence: Record<string, string> = {};
	for (const file of listTree(path.join(swarm, 'evidence'))) {
		evidence[file] = fs
			.readFileSync(path.join(swarm, 'evidence', file), 'utf-8')
			.split(dir)
			.join('<DIR>');
	}
	return {
		savePlanKeys: Object.keys(saved).sort(),
		planJson: fs.readFileSync(path.join(swarm, 'plan.json'), 'utf-8'),
		evidence,
		refs: repo.git(['for-each-ref', '--format=%(refname) %(objectname)']),
		status: repo.git(['status', '--porcelain', '--untracked-files=all']),
		// Random per-run names (scope-binding UUIDs, lock files hashed from
		// the absolute project path) are normalized; the multiset is kept.
		swarmTree: listTree(swarm)
			.map((file) =>
				file
					.replace(
						/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
						'<uuid>',
					)
					.replace(/^locks\/[0-9a-f]{64}\.lock$/, 'locks/<hash>.lock'),
			)
			.sort(),
		epicTrace,
	};
}

describe('Epic lifecycle contract — final, config off', () => {
	test('Epic disabled ⇒ the non-Epic flow leaves byte-identical artifacts and no Epic trace', async () => {
		const baseline = await runFlow('epic-final-off-a-', undefined);
		const disabled = await runFlow('epic-final-off-b-', {
			mode: { enabled: false },
			commit_policy: 'epic-branch',
			retain_refs: true,
			learning: { enabled: true },
		});

		// The Epic entry points refused / reported nothing.
		const [start, status, report, wave1, wave2] = disabled.epicTrace;
		expect(start).toContain('epic-disabled-by-config');
		expect(status).toContain('No epic is open');
		expect(report).toContain('No epic is open and no past epic report exists');
		for (const wave of [wave1, wave2]) {
			expect(JSON.parse(wave)).toMatchObject({
				status: 'refused',
				reason: 'epic-disabled-by-config',
			});
		}

		// The flow did real work: the coder ran isolated and landed through
		// the default (non-Epic) squash-unstaged merge-back; the test
		// engineer's file was NOT committed as residue (an Epic behaviour).
		expect(baseline.refs).toContain('refs/heads/swarm/lane/');
		expect(baseline.status).toContain('src/b.ts');
		expect(baseline.status).toContain('?? tests/sum.test.ts');
		expect(baseline.planJson).toContain('"status": "completed"');

		// No Epic trace at all.
		for (const run of [baseline, disabled]) {
			expect(run.savePlanKeys).not.toContain('epic_shaping');
			expect(run.refs).not.toContain('refs/swarm/');
			expect(run.refs).not.toContain('swarm/epic/');
			expect(run.swarmTree.filter((f) => /^epic/.test(f))).toEqual([]);
		}

		// Byte-identical non-Epic artifacts.
		expect(disabled.savePlanKeys).toEqual(baseline.savePlanKeys);
		expect(disabled.planJson).toBe(baseline.planJson);
		expect(disabled.evidence).toEqual(baseline.evidence);
		expect(Object.keys(baseline.evidence).length).toBeGreaterThan(0);
		expect(disabled.refs).toBe(baseline.refs);
		expect(disabled.status).toBe(baseline.status);
		expect(disabled.swarmTree).toEqual(baseline.swarmTree);
	});
});
