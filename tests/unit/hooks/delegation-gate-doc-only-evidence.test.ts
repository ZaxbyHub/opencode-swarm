import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals as workspaceSnapshotInternals } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import { readTaskEvidence } from '../../../src/gate-evidence';
import {
	createDelegationGateHook,
	_internals as delegationGateInternals,
} from '../../../src/hooks/delegation-gate';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';
import {
	makeConfig,
	recordPlanCriticApproval,
} from './_delegation-gate-helpers';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function makePlan(filesTouched: string[]): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Doc-only evidence test',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Update documentation',
						depends: [],
						files_touched: filesTouched,
					},
				],
			},
		],
	};
}

describe('delegation gate doc-only durable evidence', () => {
	let directory: string;
	const originalWorkspaceSpawnSync = workspaceSnapshotInternals.spawnSync;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-doc-gate-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		startAgentSession('architect-session', 'architect');
	});

	afterEach(() => {
		workspaceSnapshotInternals.spawnSync = originalWorkspaceSpawnSync;
		delegationGateInternals.resetStandardWorktreeIsolationState();
		swarmState.opencodeClient = undefined;
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	async function runCoder(filesTouched: string[], actualFiles: string[]) {
		const plan = makePlan(filesTouched);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		await recordPlanCriticApproval(directory, plan);
		const hook = createDelegationGateHook(makeConfig(), directory);
		const args = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nImplement the approved task.\nACCEPTANCE: task complete and covered by tests',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-session', callID: 'coder-call' },
			{ args },
		);
		for (const relativePath of actualFiles) {
			const target = path.join(directory, relativePath);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, `changed ${relativePath}\n`);
		}
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'architect-session',
				callID: 'coder-call',
				args,
			},
			{},
		);
		swarmState.agentSessions
			.get('architect-session')
			?.taskWorkflowStates?.set('1.1', 'coder_delegated');
		return hook;
	}

	test('foreground coder plus reviewer completes exact Markdown-only gates', async () => {
		const hook = await runCoder(['README.md'], ['README.md']);
		let evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.required_gates).toEqual(['reviewer']);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'architect-session',
				callID: 'reviewer-call',
				args: { subagent_type: 'reviewer', task_id: '1.1' },
			},
			{ output: 'APPROVED' },
		);
		evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(
			swarmState.agentSessions
				.get('architect-session')
				?.taskWorkflowStates?.get('1.1'),
		).toBe('tests_run');
		expect(checkReviewerGate('1.1', directory).blocked).toBe(false);
		const completion = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
		);
		expect(completion.success).toBe(true);
		await hook.toolAfter(
			{
				tool: 'update_task_status',
				sessionID: 'architect-session',
				callID: 'completion-call',
				args: { task_id: '1.1', status: 'completed' },
			},
			{},
		);
		expect(
			swarmState.agentSessions
				.get('architect-session')
				?.taskWorkflowStates?.get('1.1'),
		).toBe('complete');

		resetSwarmState();
		expect(checkReviewerGate('1.1', directory).blocked).toBe(false);
	});

	test('observed or declared code keeps test_engineer required', async () => {
		await runCoder(['README.md', 'src/code.ts'], ['README.md', 'src/code.ts']);
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	test('scope mismatch fails closed', async () => {
		await runCoder(['README.md'], ['README.md', 'src/undeclared.ts']);
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	describe('regression: snapshot work is limited to exemption candidates (F-002)', () => {
		test('non-Markdown declared scope performs no workspace snapshot Git calls', async () => {
			const plan = makePlan(['src/code.ts']);
			fs.writeFileSync(
				path.join(directory, '.swarm', 'plan.json'),
				JSON.stringify(plan, null, 2),
			);
			await recordPlanCriticApproval(directory, plan);
			const hook = createDelegationGateHook(makeConfig(), directory);
			let snapshotSpawnCalls = 0;
			workspaceSnapshotInternals.spawnSync = ((..._args: unknown[]) => {
				snapshotSpawnCalls++;
				throw new Error('non-Markdown dispatch must not capture a snapshot');
			}) as typeof workspaceSnapshotInternals.spawnSync;

			// Before F-002, every coder dispatch synchronously captured HEAD and status,
			// so this seam threw before toolBefore could complete.
			await hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'architect-session',
					callID: 'non-doc-coder-call',
				},
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.1',
						prompt:
							'TASK: 1.1\nImplement the approved code task.\nACCEPTANCE: task complete and covered by tests',
					},
				},
			);

			expect(snapshotSpawnCalls).toBe(0);
		});
	});

	describe('regression: serial fallback preserves standard-worktree evidence (F-014)', () => {
		test('observes the lane before merge rather than project-root changes', async () => {
			const plan = makePlan(['README.md']);
			plan.execution_profile = {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: true,
				locked: true,
				auto_proceed: false,
			};
			fs.writeFileSync(
				path.join(directory, '.swarm', 'plan.json'),
				JSON.stringify(plan, null, 2),
			);
			await recordPlanCriticApproval(directory, plan);

			swarmState.opencodeClient = {
				session: {
					create: async () => ({ data: { id: 'foreground-lane-session' } }),
				},
			} as never;
			const originalProvisionWorktree =
				delegationGateInternals.provisionWorktree;
			let lanePath: string | undefined;
			delegationGateInternals.provisionWorktree = async (...args) => {
				const result = await originalProvisionWorktree(...args);
				if ('worktreePath' in result) lanePath = result.worktreePath;
				return result;
			};
			const hook = createDelegationGateHook(
				makeConfig({ worktree: { policy: 'auto', merge_strategy: 'merge' } }),
				directory,
			);
			const args = {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt:
					'TASK: 1.1\nUpdate the approved documentation.\nACCEPTANCE: task complete and covered by tests',
			};

			try {
				await hook.toolBefore(
					{
						tool: 'Task',
						sessionID: 'architect-session',
						callID: 'worktree-doc-coder-call',
					},
					{ args },
				);
				expect(lanePath).toBeDefined();

				fs.writeFileSync(path.join(lanePath!, 'README.md'), '# lane docs\n');
				fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
				fs.writeFileSync(
					path.join(directory, 'src', 'root-only.ts'),
					'export const rootOnly = true;\n',
				);

				// F-014: serial fallback must keep standard-worktree isolation.
				// Observing the project root here sees root-only.ts and fails closed;
				// the isolated lane itself contains exactly the declared Markdown.
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'architect-session',
						callID: 'worktree-doc-coder-call',
						args,
					},
					{},
				);

				const evidence = await readTaskEvidence(directory, '1.1');
				expect(fs.existsSync(path.join(directory, 'src', 'root-only.ts'))).toBe(
					true,
				);
				expect(evidence?.required_gates).toEqual(['reviewer']);
				expect(evidence?.test_engineer_exempt).toBe(true);
			} finally {
				delegationGateInternals.provisionWorktree = originalProvisionWorktree;
				if (lanePath && fs.existsSync(lanePath)) {
					try {
						git(directory, ['worktree', 'remove', '--force', lanePath]);
					} catch {
						// Best-effort cleanup; the enclosing temp repository is removed next.
					}
				}
			}
		});
	});
});
