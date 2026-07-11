import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { readTaskEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
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
			prompt: 'TASK: 1.1\nImplement the approved task.',
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
});
