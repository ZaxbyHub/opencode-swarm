import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundTaskChangeContext } from '../../../src/background/pending-delegations';
import type { Plan } from '../../../src/config/plan-schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidenceRaw,
} from '../../../src/gate-evidence';
import { getOrAdoptPlanEpochUnderLock } from '../../../src/plan/ledger';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import {
	beginCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import { recoverPreparedTaskTerminal } from '../../../src/workflow/task-terminal';
import { writeWorkflowWalFile } from '../../../src/workflow/workflow-wal-file';
import {
	parseTaskTerminalWal,
	type TaskTerminalWal,
} from '../../../src/workflow/workflow-wal-schema';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { canonicalTmpDir } from '../../helpers/tmpdir';

const TASK_ID = '1.1';
const TERMINAL_PATH = path.join(
	canonicalTmpDir(),
	'task-terminals',
	'1.1.json',
);

const LEGACY_TERMINAL_WAL = {
	version: 1,
	state: 'COMMITTED',
	taskId: TASK_ID,
	transitionId: 'legacy-terminal',
	actor: 'legacy-test',
	oldPlanStatus: 'in_progress',
	newPlanStatus: 'completed',
	oldWorkflowState: 'tests_run',
	newWorkflowState: 'complete',
	generation: 4,
	qaExempt: false,
	recordedAt: '2026-01-01T00:00:00.000Z',
};

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

function fixturePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Issue 2763 terminal fixture',
		swarm: 'issue-2763',
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
						description: 'No-mutation terminal replay',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function seedPreparedReadOnlyTerminal(
	directory: string,
): Promise<string> {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	runGit(directory, ['init', '--quiet']);
	runGit(directory, ['config', 'user.email', 'issue-2763@example.invalid']);
	runGit(directory, ['config', 'user.name', 'Issue 2763 test']);
	fs.writeFileSync(path.join(directory, '.opencode', 'marker'), 'fixture');
	runGit(directory, ['add', '.']);
	runGit(directory, ['commit', '--quiet', '-m', 'issue 2763 terminal fixture']);
	await savePlan(directory, fixturePlan());

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
		transitionId: 'issue-2763-terminal-settlement',
		actor: 'issue-2763-terminal-test',
		expectedGeneration: 0,
		context,
	});
	await settleCoderDispatch({
		directory,
		taskId: TASK_ID,
		transitionId: 'issue-2763-terminal-settlement',
		accepted: false,
		testEngineerExempt: false,
	});

	const plan = await loadPlanJsonOnly(directory);
	if (!plan) throw new Error('terminal fixture plan missing');
	const identity = await getOrAdoptPlanEpochUnderLock(directory, plan);
	const wal = {
		version: 2,
		state: 'PREPARED',
		taskId: TASK_ID,
		transitionId: 'issue-2763-terminal-replay',
		actor: 'issue-2763-terminal-test',
		oldPlanStatus: 'in_progress',
		newPlanStatus: 'completed',
		oldWorkflowState: 'idle',
		newWorkflowState: 'complete',
		generation: 0,
		qaExempt: false,
		readOnlyNoMutation: true,
		recordedAt: '2026-09-14T00:00:00.000Z',
		planIdentityHash: identity.planIdentityHash,
		planEpoch: identity.planEpoch,
	} as unknown as TaskTerminalWal;
	const walPath = path.join(
		directory,
		'.swarm',
		'task-terminals',
		`${TASK_ID}.json`,
	);
	await writeWorkflowWalFile('task-terminal', walPath, wal);
	return walPath;
}

describe('issue #2763 — read-only terminal WAL', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'task-terminal-read-only-2763-',
		));
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('keeps old terminal WALs backward-compatible when the optional field is absent', () => {
		const parsed = parseTaskTerminalWal(
			JSON.stringify(LEGACY_TERMINAL_WAL),
			TERMINAL_PATH,
			TASK_ID,
		);
		expect(parsed.version).toBe(1);
		expect(parsed.newPlanStatus).toBe('completed');
		expect(
			(parsed as TaskTerminalWal & { readOnlyNoMutation?: boolean })
				.readOnlyNoMutation,
		).toBeUndefined();
	});

	test('rejects malformed or contradictory read-only terminal combinations', () => {
		const valid = {
			...LEGACY_TERMINAL_WAL,
			version: 2,
			planIdentityHash: 'a'.repeat(64),
			planEpoch: '11111111-1111-4111-8111-111111111111',
			readOnlyNoMutation: true,
		};
		for (const candidate of [
			{ ...valid, readOnlyNoMutation: 'true' },
			{ ...valid, newPlanStatus: 'blocked', newWorkflowState: 'blocked' },
			{ ...valid, qaExempt: true },
			{ ...valid, generation: 1 },
		]) {
			expect(() =>
				parseTaskTerminalWal(JSON.stringify(candidate), TERMINAL_PATH, TASK_ID),
			).toThrow('TASK_TERMINAL_WAL');
		}
	});

	test('replays a PREPARED read-only completion deterministically', async () => {
		const walPath = await seedPreparedReadOnlyTerminal(directory);
		const replay = await recoverPreparedTaskTerminal(
			directory,
			TASK_ID,
			'issue-2763-terminal-recovery',
		);

		expect(replay?.targetStatus).toBe('completed');
		expect(
			(await loadPlanJsonOnly(directory))?.phases[0]?.tasks[0]?.status,
		).toBe('completed');
		const evidence = readTaskEvidenceRaw(directory, TASK_ID);
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			state: 'complete',
			generation: 0,
		});
		expect(evidence?.workflow?.qaExempt).not.toBe(true);
		expect(evidence?.workflow?.forcedCompletion).not.toBe(true);
		expect(JSON.parse(fs.readFileSync(walPath, 'utf8')).state).toBe(
			'COMMITTED',
		);
	});

	test('issue #2763 review regression: does not replay read-only proof after scope expands', async () => {
		const walPath = await seedPreparedReadOnlyTerminal(directory);
		await updateTaskStatus(directory, TASK_ID, 'completed');
		const forwardedPlan = await loadPlanJsonOnly(directory);
		if (!forwardedPlan) throw new Error('terminal fixture plan missing');
		const expandedPlan: Plan = {
			...forwardedPlan,
			phases: forwardedPlan.phases.map((phase) => ({
				...phase,
				tasks: phase.tasks.map((task) =>
					task.id === TASK_ID
						? { ...task, files_touched: ['src/new-file.ts'] }
						: task,
				),
			})),
		};
		await savePlan(directory, expandedPlan);

		// The persisted true marker proves only that the original declaration was
		// empty. Recovery must not apply it after the ledger-authoritative scope
		// has expanded while the WAL is still PREPARED.
		await expect(
			recoverPreparedTaskTerminal(
				directory,
				TASK_ID,
				'issue-2763-expanded-scope-recovery',
			),
		).rejects.toThrow('TASK_TERMINAL_READ_ONLY_SCOPE_CHANGED');

		const recoveredPlan = await loadPlanJsonOnly(directory);
		expect(recoveredPlan?.phases[0]?.tasks[0]?.status).toBe('in_progress');
		expect(JSON.parse(fs.readFileSync(walPath, 'utf8')).state).toBe('ABORTED');
		expect(
			getTaskWorkflowSnapshot(readTaskEvidenceRaw(directory, TASK_ID)),
		).toMatchObject({
			state: 'idle',
			generation: 0,
		});
	});
});
