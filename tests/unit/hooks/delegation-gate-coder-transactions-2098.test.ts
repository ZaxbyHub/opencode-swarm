import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { _internals as taskFileInternals } from '../../../src/evidence/task-file';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recoverCoderSettlement } from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function writeFile(directory: string, file: string, content: string): void {
	const absolute = path.join(directory, file);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
}

async function dispatchCoder(
	hook: ReturnType<typeof createDelegationGateHook>,
	callID: string,
	output: unknown,
	mutate?: () => void,
): Promise<void> {
	const args = {
		subagent_type: 'coder',
		task_id: '1.1',
		prompt:
			'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
	};
	await hook.toolBefore(
		{ tool: 'Task', sessionID: 'parent', callID },
		{ args },
	);
	mutate?.();
	await hook.toolAfter(
		{ tool: 'Task', sessionID: 'parent', callID, args },
		output,
	);
}

describe('issue #2098 foreground coder transaction fencing', () => {
	let directory = '';
	let cleanup = (): void => {};
	const realRename = taskFileInternals.renameSync;

	beforeEach(async () => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('dg-coder-tx-2098-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		writeFile(directory, 'src/feature.ts', 'export const feature = 1;\n');
		writeFile(directory, 'src/unrelated.ts', 'export const unrelated = 1;\n');
		git(directory, ['add', 'src/feature.ts', 'src/unrelated.ts']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	});

	afterEach(() => {
		taskFileInternals.renameSync = realRename;
		resetSwarmState();
		cleanup();
	});

	test('a foreground evidence-write failure is surfaced and remains recoverable', async () => {
		const hook = createDelegationGateHook(config, directory);
		const args = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'evidence-failure' },
			{ args },
		);
		writeFile(directory, 'src/feature.ts', 'export const feature = 7;\n');
		taskFileInternals.renameSync = (source, target) => {
			if (target.includes(`${path.sep}evidence${path.sep}1.1.json`)) {
				throw new Error('injected evidence rename failure');
			}
			return realRename(source, target);
		};

		await expect(
			hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'parent',
					callID: 'evidence-failure',
					args,
				},
				{ state: 'completed', output: 'implemented feature' },
			),
		).rejects.toThrow('injected evidence rename failure');
		taskFileInternals.renameSync = realRename;
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')),
		).toMatchObject({ state: 'idle', generation: 0 });

		const recovered = await recoverCoderSettlement(directory, '1.1');
		expect(getTaskWorkflowSnapshot(recovered?.evidence ?? null)).toMatchObject({
			state: 'coder_delegated',
			generation: 1,
			lastTransitionId: 'coder:evidence-failure',
		});
	});

	test('a cancelled shared-root coder with an in-scope edit rotates debt and records the failure', async () => {
		const hook = createDelegationGateHook(config, directory);
		await dispatchCoder(
			hook,
			'cancelled-with-diff',
			{ state: 'cancelled', output: 'cancelled by parent' },
			() =>
				writeFile(directory, 'src/feature.ts', 'export const feature = 2;\n'),
		);

		const evidence = await readTaskEvidence(directory, '1.1');
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			state: 'rework_required',
			generation: 1,
			retryCount: 1,
			lastOutcome: 'accepted_mutation_failed',
		});
		const session = ensureAgentSession('parent', 'architect', directory);
		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	test('a concurrent out-of-scope diff cannot turn an exact no-op coder into an accepted mutation', async () => {
		const hook = createDelegationGateHook(config, directory);
		await dispatchCoder(
			hook,
			'out-of-scope-diff',
			{ state: 'completed', output: 'done' },
			() =>
				writeFile(
					directory,
					'src/unrelated.ts',
					'export const unrelated = 2;\n',
				),
		);

		const evidence = await readTaskEvidence(directory, '1.1');
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			state: 'idle',
			generation: 0,
			retryCount: 1,
			lastOutcome: 'dispatch_no_mutation',
		});
		expect(evidence?.gates.coder).toBeUndefined();
	});

	test('retry threshold requires an exact-generation critic, admits one simplified retry, then blocks for the user', async () => {
		const hook = createDelegationGateHook(config, directory);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await dispatchCoder(hook, `no-op-${attempt}`, {
				state: 'completed',
				output: 'no changes required',
			});
		}

		await expect(
			dispatchCoder(hook, 'threshold-probe', {
				state: 'completed',
				output: 'unreachable',
			}),
		).rejects.toThrow('TASK_RETRY_CRITIC_REQUIRED');

		const criticArgs = {
			subagent_type: 'critic_sounding_board',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nACCEPTANCE: identify a smaller exact approach for task 1.1',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'retry-critic' },
			{ args: criticArgs },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent',
				callID: 'retry-critic',
				args: criticArgs,
			},
			{
				state: 'completed',
				output: 'VERDICT: APPROVED\nUse the smaller path.',
			},
		);

		const criticEvidence = await readTaskEvidence(directory, '1.1');
		expect(criticEvidence?.gates.critic_sounding_board?.sessionId).toBe(
			'parent',
		);
		expect(getTaskWorkflowSnapshot(criticEvidence).generation).toBe(0);
		await dispatchCoder(
			hook,
			'simplified-mutation',
			{ state: 'completed', output: 'implemented the simplified repair' },
			() =>
				writeFile(
					directory,
					'src/feature.ts',
					'export const simplifiedRepair = true;\n',
				),
		);
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'stage_a_failed',
			expectedGeneration: 1,
			transitionId: 'simplified-stage-a-failed',
		});

		await expect(
			dispatchCoder(hook, 'post-simplification', {
				state: 'completed',
				output: 'unreachable',
			}),
		).rejects.toThrow('TASK_RETRY_USER_ESCALATION_REQUIRED');
		await expect(
			dispatchCoder(hook, 'user-escalation-repeat', {
				state: 'completed',
				output: 'unreachable',
			}),
		).rejects.toThrow('TASK_RETRY_USER_ESCALATION_REQUIRED');

		const events = fs
			.readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { type?: string; action?: string })
			.filter((event) => event.type === 'coder_retry_circuit_breaker');
		expect(events.map((event) => event.action)).toEqual([
			'sounding_board_consultation',
			'simplification',
			'user_escalation',
		]);
	});
});
