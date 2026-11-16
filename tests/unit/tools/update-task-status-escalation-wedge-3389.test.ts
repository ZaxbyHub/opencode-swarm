import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { appendCoreEventSync } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { ToolContext } from '../../../src/tools/create-tool';
import {
	executeUpdateTaskStatus,
	update_task_status,
} from '../../../src/tools/update-task-status';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';
const FIXED_TS = '2026-01-01T00:00:00.000Z';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function seedWedge(directory: string): void {
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(path.join(swarmDir, 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(swarmDir, 'coder-settlements'), { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 3389 handler fixture',
			swarm: 'test-swarm',
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
							description: 'Wedged exact task',
							depends: [],
							files_touched: ['src/feature.ts'],
						},
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(swarmDir, 'evidence', `${TASK_ID}.json`),
		JSON.stringify({
			taskId: TASK_ID,
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				critic_sounding_board: {
					sessionId: 'parent',
					timestamp: FIXED_TS,
					agent: 'critic_sounding_board',
				},
			},
			workflow: {
				schema: 'exact-task-v1',
				state: 'rework_required',
				generation: 2,
				retryCount: 3,
				retryHistory: [
					'accepted_mutation_failed',
					'dispatch_no_mutation',
					'dispatch_no_mutation',
				],
				retryEpoch: 1,
				lastOutcome: 'stage_a_failed',
				updatedAt: FIXED_TS,
			},
		}),
	);
	for (const action of [
		'sounding_board_consultation',
		'simplification',
		'user_escalation',
	]) {
		appendCoreEventSync(directory, {
			type: 'coder_retry_circuit_breaker',
			timestamp: FIXED_TS,
			taskId: TASK_ID,
			generation: 2,
			retryEpoch: 1,
			rejectionCount: 3,
			rejectionHistory: [
				'accepted_mutation_failed',
				'dispatch_no_mutation',
				'dispatch_no_mutation',
			],
			phase: 1,
			action: action as 'user_escalation',
		});
	}
	fs.writeFileSync(
		path.join(swarmDir, 'coder-settlements', `${TASK_ID}.json`),
		JSON.stringify({
			version: 1,
			state: 'COMMITTED',
			taskId: TASK_ID,
			transitionId: `coder:test-${TASK_ID}`,
			actor: 'test',
			processId: process.pid,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 2,
			context: {
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
				declaredFiles: ['src/feature.ts'],
			},
			accepted: false,
			recordedAt: FIXED_TS,
		}),
	);
}

let dispatchCounter = 0;

async function dispatchProbe(
	directory: string,
): Promise<{ refused: boolean; message: string }> {
	dispatchCounter += 1;
	const session = ensureAgentSession('parent', 'architect', directory);
	session.currentTaskId = TASK_ID;
	const hook = createDelegationGateHook(config, directory);
	const args = {
		subagent_type: 'coder',
		task_id: TASK_ID,
		prompt: `TASK: ${TASK_ID}\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified`,
	};
	try {
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: `probe-${dispatchCounter}` },
			{ args },
		);
		return { refused: false, message: '' };
	} catch (error) {
		return {
			refused: true,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

describe('issue #3389 update_task_status wedge repair (handler level)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('wedge-handler-3389-'));
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('the intact wedge still refuses dispatches with a message naming the reachable update_task_status remedy', async () => {
		seedWedge(directory);
		const probe = await dispatchProbe(directory);
		expect(probe.refused).toBe(true);
		expect(probe.message).toContain('TASK_RETRY_USER_ESCALATION_REQUIRED');
		expect(probe.message).toContain('If the user authorizes repair');
		expect(probe.message).toContain('update_task_status');
		// The recipe's argument names are pinned so the advertised remedy
		// cannot drift from the tool's actual schema (maintainer review R).
		expect(probe.message).toContain('status "in_progress"');
		expect(probe.message).toContain('force true');
		expect(probe.message).toContain('expected_state');
		expect(probe.message).toContain('expected_generation 2');
		expect(probe.message).toContain('target_state "idle"');
		expect(probe.message).toContain('transition_id');
		// The plan-status precondition is part of the advertised remedy.
		expect(probe.message).toContain('plan status must already be in_progress');
	});

	test('the audited force repair succeeds through the tool handler and clears the retry circuit', async () => {
		seedWedge(directory);
		const result = await executeUpdateTaskStatus(
			{
				task_id: TASK_ID,
				status: 'in_progress',
				force: true,
				expected_state: 'rework_required',
				expected_generation: 2,
				target_state: 'idle',
				reason: 'user authorized reopening after the retry escalation',
				transition_id: 'repair-1.1-wedge-handler',
			},
			directory,
			{ sessionID: 'wedge-caller' } as ToolContext,
		);
		expect(result.success).toBe(true);
		const evidence = await readTaskEvidence(directory, TASK_ID);
		const workflow = getTaskWorkflowSnapshot(evidence);
		expect(workflow.state).toBe('idle');
		expect(workflow.generation).toBe(3);
		expect(workflow.retryCount).toBe(0);
		expect(workflow.retryEpoch).toBe(0);
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
		) as { phases: { tasks: { id: string; status: string }[] }[] };
		const task = plan.phases
			.flatMap((phase) => phase.tasks)
			.find((candidate) => candidate.id === TASK_ID);
		expect(task?.status).toBe('in_progress');
	});

	test('a post-repair coder dispatch is no longer refused by the escalation gate', async () => {
		seedWedge(directory);
		const repair = await executeUpdateTaskStatus(
			{
				task_id: TASK_ID,
				status: 'in_progress',
				force: true,
				expected_state: 'rework_required',
				expected_generation: 2,
				target_state: 'idle',
				reason: 'user authorized reopening after the retry escalation',
				transition_id: 'repair-1.1-wedge-post-dispatch',
			},
			directory,
			{ sessionID: 'wedge-caller' } as ToolContext,
		);
		expect(repair.success).toBe(true);
		const probe = await dispatchProbe(directory);
		expect(
			probe.refused &&
				probe.message.includes('TASK_RETRY_USER_ESCALATION_REQUIRED'),
		).toBe(false);
	});

	test('the exported tool schema describes the repair contract without the backward-only wording (issue #3389)', async () => {
		// Runtime pin on the zod descriptions the model actually receives (the
		// exported createSwarmTool object preserves its args schema), not a
		// source-text scan: a revert of either description must fail here.
		const tool = update_task_status;
		const args = (tool as { args?: Record<string, { description?: string }> })
			.args;
		expect(args).toBeDefined();
		const forceDescription = args?.force?.description ?? '';
		const targetDescription = args?.target_state?.description ?? '';
		expect(forceDescription.toLowerCase()).not.toContain('backward');
		expect(targetDescription.toLowerCase()).not.toContain('backward');
		expect(forceDescription).toContain('in_progress');
		expect(forceDescription).toContain('retry ladder user_escalation rung');
		expect(targetDescription).toContain('idle');
	});
});
