import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundTaskChangeContext } from '../../../src/background/pending-delegations';
import type { Plan, RuntimePlan } from '../../../src/config/plan-schema';
import { replayFromLedgerWithStatus } from '../../../src/plan/ledger';
import { savePlan } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
	_internals as updateTaskStatusInternals,
} from '../../../src/tools/update-task-status';
import {
	beginCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';

function runGit(directory: string, args: string[], capture = false): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore',
		timeout: 5000,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`fixture git failed: ${args.join(' ')}`);
	return capture ? String(result.stdout).trim() : '';
}

function fixturePlan(filesTouched: string[] = []): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Issue 2763 locked scope fixture',
		swarm: 'issue-2763-locked-scope',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Locked completion scope validation',
						depends: [],
						files_touched: filesTouched,
					},
				],
			},
		],
	};
}

async function seedStaleEmptyProjection(
	directory: string,
): Promise<{ planPath: string; authoritativePlan: Plan }> {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(path.join(directory, '.opencode', 'marker'), 'fixture');
	runGit(directory, ['init', '--quiet']);
	runGit(directory, ['config', 'user.email', 'issue-2763@example.invalid']);
	runGit(directory, ['config', 'user.name', 'Issue 2763 test']);
	runGit(directory, ['add', '.']);
	runGit(directory, [
		'commit',
		'--quiet',
		'-m',
		'issue 2763 locked-scope fixture',
	]);
	await savePlan(directory, fixturePlan());
	const planPath = path.join(directory, '.swarm', 'plan.json');
	const emptyProjection = fs.readFileSync(planPath, 'utf8');
	const context = {
		declaredFiles: [],
		baseline: {
			directory,
			gitHead: runGit(directory, ['rev-parse', 'HEAD'], true),
			dirtyHash: null,
			changedFiles: [],
			prHeadSha: null,
			scope: null,
		},
		workflowGeneration: 0,
	} as BackgroundTaskChangeContext;
	await beginCoderSettlement({
		directory,
		taskId: TASK_ID,
		transitionId: 'issue-2763-locked-scope-settlement',
		actor: 'issue-2763-locked-scope-test',
		expectedGeneration: 0,
		context,
	});
	await settleCoderDispatch({
		directory,
		taskId: TASK_ID,
		transitionId: 'issue-2763-locked-scope-settlement',
		accepted: false,
		testEngineerExempt: false,
	});
	await savePlan(directory, fixturePlan(['src/new-file.ts']));
	const replay = await replayFromLedgerWithStatus(directory);
	if (replay.truncated || !replay.plan)
		throw new Error('locked-scope fixture ledger could not be replayed');
	fs.writeFileSync(planPath, emptyProjection);
	return { planPath, authoritativePlan: replay.plan };
}

describe('issue #2763 — locked reviewer gate scope', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'update-task-status-locked-scope-2763-',
		));
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('issue #2763 review regression: locked scope overrides an empty stale projection', async () => {
		const { planPath, authoritativePlan } =
			await seedStaleEmptyProjection(directory);
		expect(authoritativePlan.phases[0]?.tasks[0]?.files_touched).toEqual([
			'src/new-file.ts',
		]);
		// Simulate the locked caller's authoritative task scope alongside a stale
		// projection. The under-lock gate must use the explicit scope argument,
		// never infer emptiness from plan.json.
		expect(
			JSON.parse(fs.readFileSync(planPath, 'utf8')).phases[0].tasks[0]
				.files_touched,
		).toEqual([]);

		const gate = checkReviewerGate(
			TASK_ID,
			directory,
			false,
			'locked-session',
			directory,
			['src/new-file.ts'],
		);

		expect(gate.blocked).toBe(true);
		expect(gate.missingGates).toContain('pre_check');
	});

	test('blocks locked completion before creating a WAL or forwarding status', async () => {
		const { planPath, authoritativePlan } =
			await seedStaleEmptyProjection(directory);
		const originalLoadPlan = updateTaskStatusInternals.loadPlan;
		updateTaskStatusInternals.loadPlan = async () =>
			authoritativePlan as RuntimePlan;
		try {
			const result = await executeUpdateTaskStatus(
				{
					task_id: TASK_ID,
					status: 'completed',
					working_directory: directory,
				},
				directory,
			);
			expect(result.success).toBe(false);
			expect(result.errors?.join(' ')).toContain(
				'TASK_COMPLETION_CAS_MISMATCH',
			);
			expect(
				fs.existsSync(
					path.join(directory, '.swarm', 'task-terminals', `${TASK_ID}.json`),
				),
			).toBe(false);
			expect(
				JSON.parse(fs.readFileSync(planPath, 'utf8')).phases[0].tasks[0].status,
			).toBe('in_progress');
		} finally {
			updateTaskStatusInternals.loadPlan = originalLoadPlan;
		}
	});
});
