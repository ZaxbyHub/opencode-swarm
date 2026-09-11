import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { readCoreEvents } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import {
	createDelegationGateHook,
	forceRecordRetrySoundingBoardApproval,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
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

interface RetryEvent {
	taskId?: string;
	action?: string;
	reason?: string;
}

function readRetryEvents(directory: string): RetryEvent[] {
	const { text } = readCoreEvents(directory);
	const events: RetryEvent[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as RetryEvent & { type?: string };
			if (parsed && parsed.type === 'coder_retry_circuit_breaker')
				events.push(parsed);
		} catch {
			// skip torn/partial line (production readers are per-line tolerant)
		}
	}
	return events;
}

describe('forceRecordRetrySoundingBoardApproval (issue #2703)', () => {
	let directory = '';
	let cleanup = (): void => {};
	let hook: ReturnType<typeof createDelegationGateHook>;

	async function dispatchCoder(
		sessionID: string,
		callID: string,
		taskId = '1.1',
	): Promise<void> {
		const file = taskId === '1.1' ? 'src/feature.ts' : 'src/other.ts';
		const args = {
			subagent_type: 'coder',
			task_id: taskId,
			prompt: `TASK: ${taskId}\nFILE: ${file}\nACCEPTANCE: feature is implemented and verified`,
		};
		await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID, args },
			{ state: 'completed', output: 'no changes required' },
		);
	}

	/** Trip the breaker and durably record the consultation escalation. */
	async function wedgeTask1_1(): Promise<void> {
		const session = ensureAgentSession('parent-1', 'architect', directory);
		session.currentTaskId = '1.1';
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await dispatchCoder('parent-1', `no-op-${attempt}`);
		}
		await expect(dispatchCoder('parent-1', 'threshold-probe')).rejects.toThrow(
			'Dispatch critic_sounding_board',
		);
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.gates.critic_sounding_board).toBeUndefined();
	}

	beforeEach(async () => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('dg-retry-sb-manual-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		fs.writeFileSync(
			path.join(directory, 'src', 'other.ts'),
			'export const other = 1;\n',
		);
		git(directory, ['add', 'src/feature.ts', 'src/other.ts']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
			{ id: '1.2', files: ['src/other.ts'] },
		]);
		hook = createDelegationGateHook(config, directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('records the durable gate entry + audit event and unblocks the next coder dispatch', async () => {
		await wedgeTask1_1();
		ensureAgentSession('arch-approve', 'architect', directory);
		const before = readRetryEvents(directory);
		const consultationsBefore = before.filter(
			(event) => event.action === 'sounding_board_consultation',
		).length;
		const epochBefore = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		).retryEpoch;

		const summary = await forceRecordRetrySoundingBoardApproval(
			directory,
			'arch-approve',
			{
				taskId: '1.1',
				reason:
					'sounding board returned APPROVED but the verdict format did not match the mechanical recorder',
			},
		);
		expect(summary.taskId).toBe('1.1');
		expect(summary.retryEpoch).toBe(epochBefore);
		expect(summary.auditEventRecorded).toBe(true);

		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.gates.critic_sounding_board?.sessionId).toBe(
			'arch-approve',
		);

		const after = readRetryEvents(directory);
		const manual = after.filter(
			(event) =>
				event.taskId === '1.1' &&
				event.action === 'sounding_board_manual_approval',
		);
		expect(manual.length).toBe(1);
		// The helper emits ONLY the manual action — never the protocol actions
		// (plan-critic round 1, blocker 3: covers the SUCCESS path).
		for (const action of [
			'sounding_board_consultation',
			'simplification',
			'user_escalation',
		]) {
			expect(
				after.filter(
					(event) => event.taskId === '1.1' && event.action === action,
				).length,
			).toBe(
				action === 'sounding_board_consultation' ? consultationsBefore : 0,
			);
		}

		// The next coder dispatch passes the retry-critic check (a different
		// gate error is acceptable) and the admitted retry is durable.
		let postError = '';
		try {
			await dispatchCoder('parent-1', 'post-approval');
		} catch (error) {
			postError = error instanceof Error ? error.message : String(error);
		}
		expect(postError).not.toContain('TASK_RETRY_CRITIC_REQUIRED');
		expect(
			readRetryEvents(directory).some(
				(event) => event.taskId === '1.1' && event.action === 'simplification',
			),
		).toBe(true);
	});

	test('is idempotent per (session, epoch): second call rewrites nothing and emits no second audit event', async () => {
		await wedgeTask1_1();
		ensureAgentSession('arch-approve', 'architect', directory);
		const first = await forceRecordRetrySoundingBoardApproval(
			directory,
			'arch-approve',
			{ taskId: '1.1', reason: 'recovery' },
		);
		const afterFirst = await readTaskEvidence(directory, '1.1');
		const transitionId = getTaskWorkflowSnapshot(afterFirst).lastTransitionId;
		expect(transitionId).toBe(
			`retry-sb-manual:arch-approve:epoch${first.retryEpoch}`,
		);

		const second = await forceRecordRetrySoundingBoardApproval(
			directory,
			'arch-approve',
			{ taskId: '1.1', reason: 'repeated invocation' },
		);
		expect(second.auditEventRecorded).toBe(true);
		const afterSecond = await readTaskEvidence(directory, '1.1');
		// Epoch-stable transitionId: the duplicate transition is a no-op, so
		// lastTransitionId (and the gate entry) are unchanged.
		expect(getTaskWorkflowSnapshot(afterSecond).lastTransitionId).toBe(
			transitionId,
		);
		expect(afterSecond?.gates.critic_sounding_board?.sessionId).toBe(
			'arch-approve',
		);
		const manualEvents = readRetryEvents(directory).filter(
			(event) =>
				event.taskId === '1.1' &&
				event.action === 'sounding_board_manual_approval',
		);
		expect(manualEvents.length).toBe(1);
	});

	test('rejects a non-architect session and writes nothing', async () => {
		await wedgeTask1_1();
		ensureAgentSession('coder-session', 'coder', directory);
		await expect(
			forceRecordRetrySoundingBoardApproval(directory, 'coder-session', {
				taskId: '1.1',
				reason: 'self-unblock attempt',
			}),
		).rejects.toThrow('APPROVE_RETRY_SOUNDING_BOARD_ARCHITECT_REQUIRED');
		expect(
			(await readTaskEvidence(directory, '1.1'))?.gates.critic_sounding_board,
		).toBeUndefined();
	});

	test('rejects a task id that is not in the current plan', async () => {
		await wedgeTask1_1();
		ensureAgentSession('arch-approve', 'architect', directory);
		await expect(
			forceRecordRetrySoundingBoardApproval(directory, 'arch-approve', {
				taskId: '9.9',
				reason: 'foreign task',
			}),
		).rejects.toThrow('APPROVE_RETRY_UNKNOWN_TASK');
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '9.9.json')),
		).toBe(false);
	});

	test('rejects a plan task with no durable workflow evidence', async () => {
		ensureAgentSession('arch-approve', 'architect', directory);
		// 1.2 exists in the plan but was never dispatched: no evidence file.
		await expect(
			forceRecordRetrySoundingBoardApproval(directory, 'arch-approve', {
				taskId: '1.2',
				reason: 'nothing to recover',
			}),
		).rejects.toThrow('APPROVE_RETRY_NO_WORKFLOW');
	});

	test('rejects a task whose breaker never consulted the sounding board', async () => {
		// One no-op dispatch on 1.2: evidence exists, retryCount 1, no escalation.
		const session = ensureAgentSession('parent-2', 'architect', directory);
		session.currentTaskId = '1.2';
		await dispatchCoder('parent-2', 'warm-1-2', '1.2');
		ensureAgentSession('arch-approve', 'architect', directory);
		await expect(
			forceRecordRetrySoundingBoardApproval(directory, 'arch-approve', {
				taskId: '1.2',
				reason: 'skip the consultation',
			}),
		).rejects.toThrow('APPROVE_RETRY_CONSULTATION_REQUIRED');
		expect(
			readRetryEvents(directory).filter((event) => event.taskId === '1.2'),
		).toEqual([]);
		expect(
			(await readTaskEvidence(directory, '1.2'))?.gates.critic_sounding_board,
		).toBeUndefined();
	});

	test('remaps a corrupt retry audit index to a typed recovery error', async () => {
		await wedgeTask1_1();
		ensureAgentSession('arch-approve', 'architect', directory);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'events-authority-index.json'),
			'{not json at all',
		);
		await expect(
			forceRecordRetrySoundingBoardApproval(directory, 'arch-approve', {
				taskId: '1.1',
				reason: 'index corrupt',
			}),
		).rejects.toThrow('APPROVE_RETRY_AUDIT_INDEX_UNREADABLE');
	});

	test('the manual entry is cleared by accepted_mutation like a mechanical one', async () => {
		await wedgeTask1_1();
		ensureAgentSession('arch-approve', 'architect', directory);
		await forceRecordRetrySoundingBoardApproval(directory, 'arch-approve', {
			taskId: '1.1',
			reason: 'recovery',
		});
		expect(
			(await readTaskEvidence(directory, '1.1'))?.gates.critic_sounding_board,
		).toBeDefined();

		// The admitted retry mutates a file and settles: accepted_mutation
		// rotates the generation and clearWorkflowGateProof drops the entry.
		const args = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-1', callID: 'simplified-retry' },
			{ args },
		);
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const simplifiedRepair = true;\n',
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent-1', callID: 'simplified-retry', args },
			{ state: 'completed', output: 'implemented the simplified repair' },
		);

		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.gates.critic_sounding_board).toBeUndefined();
		expect(getTaskWorkflowSnapshot(evidence).generation).toBe(1);
	});
});
