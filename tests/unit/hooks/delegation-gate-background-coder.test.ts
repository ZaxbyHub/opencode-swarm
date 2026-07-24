import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		delegation_gate: true,
		background_subagents: true,
		background_pending_timeout_minutes: 30,
	},
	worktree: { policy: 'disabled' },
} as PluginConfig;

describe('background coder Stage A provenance', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('swarm-bg-stage-a-coder-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
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
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('ordinary code scope is durably captured before terminal completion', async () => {
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
		session.lastCoderDelegationTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		const args = {
			subagent_type: 'coder',
			background: true,
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and tested',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'coder-call' },
			{ args },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent',
				callID: 'coder-call',
				args,
			},
			{
				state: 'running',
				output:
					'<task id="coder-session" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'coder-job' },
			},
		);

		const record = findByCorrelationId(directory, 'coder-session');
		expect(record?.normalizedAgent).toBe('coder');
		expect(record?.taskChangeContext?.declaredFiles).toEqual([
			'src/feature.ts',
		]);
		expect(record?.taskChangeContext?.baseline.changedFiles).toEqual([]);
		expect(record?.taskChangeContext?.baseline.directory).toBe(directory);
	});

	test('a running background coder durably blocks a duplicate task launch', async () => {
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		const args = {
			subagent_type: 'coder',
			background: true,
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'coder-call-1' },
			{ args: { ...args } },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent',
				callID: 'coder-call-1',
				args: { ...args },
			},
			{
				state: 'running',
				output:
					'<task id="coder-session-1" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'coder-job-1' },
			},
		);

		expect(session.taskWorkflowStates.get('1.1') ?? 'idle').toBe('idle');
		expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'coder-call-2' },
				{ args: { ...args } },
			),
		).rejects.toThrow('BACKGROUND_CODER_TASK_RESERVED');
		expect(findByCorrelationId(directory, 'coder-session-1')?.status).toBe(
			'pending',
		);

		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'src', 'feature.ts'), 'feature\n');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text:
							'<task id="coder-session-1" state="completed">\n' +
							'<task_result>done</task_result>\n</task>',
					},
				},
			},
		});

		expect(findByCorrelationId(directory, 'coder-session-1')?.status).toBe(
			'consumed',
		);
		expect(scanBackgroundCoderReservationsForAdmission(directory)).toEqual({
			status: 'ok',
			reservations: [],
		});
	});

	test('background reservations enforce the configured parallel slot cap', async () => {
		await writeApprovedPlan(
			directory,
			[
				{ id: '1.1', files: ['src/one.ts'] },
				{ id: '1.2', files: ['src/two.ts'] },
				{ id: '1.3', files: ['src/three.ts'] },
			],
			{
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					locked: true,
				},
			},
		);
		const session = ensureAgentSession('parent', 'architect', directory);
		const hook = createDelegationGateHook(config, directory);
		const fileByTask = new Map([
			['1.1', 'src/one.ts'],
			['1.2', 'src/two.ts'],
			['1.3', 'src/three.ts'],
		]);
		const launch = async (taskId: string, ordinal: number): Promise<void> => {
			const args = {
				subagent_type: 'coder',
				background: true,
				task_id: taskId,
				prompt: `TASK: ${taskId}\nFILE: ${fileByTask.get(taskId)}\nACCEPTANCE: task is complete`,
			};
			const callID = `parallel-call-${ordinal}`;
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID },
				{ args },
			);
			await hook.toolAfter(
				{ tool: 'Task', sessionID: 'parent', callID, args },
				{
					state: 'running',
					output: `<task id="parallel-session-${ordinal}" state="running">Background task started</task>`,
					metadata: { background: true, jobId: `parallel-job-${ordinal}` },
				},
			);
		};

		await launch('1.1', 1);
		await launch('1.2', 2);
		expect(
			[...session.taskWorkflowStates.values()].every(
				(state) => state === 'idle',
			),
		).toBe(true);
		await expect(launch('1.3', 3)).rejects.toThrow('PARALLEL_SLOTS_EXHAUSTED');
	});
});
