/** Integration coverage for exact-task evidence recording in delegation-gate. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
	getTaskWorkflowSnapshot,
	hasPassedAllGates,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../state';
import { checkReviewerGate } from '../tools/update-task-status';
import { createDelegationGateHook } from './delegation-gate';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
} as PluginConfig;

let tmpDir: string;

beforeEach(() => {
	resetSwarmState();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-evidence-test-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	rmSync(tmpDir, { recursive: true, force: true });
});

async function seedStageA(sessionId: string, taskId: string): Promise<number> {
	const accepted = await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
	const generation = getTaskWorkflowSnapshot(accepted).generation;
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: `seed-stage-a:${taskId}`,
	});
	const session = ensureAgentSession(sessionId, 'architect', tmpDir);
	session.currentTaskId = taskId;
	session.taskWorkflowStates.set(taskId, 'pre_check_passed');
	return generation;
}

async function dispatchGate(
	sessionId: string,
	taskId: string,
	agent: string,
	callID: string,
): Promise<void> {
	const args = {
		subagent_type: agent,
		task_id: taskId,
		prompt: `TASK: ${taskId}\nACCEPTANCE: Verify the exact task and report a bound positive verdict.`,
	};
	const hook = createDelegationGateHook(config, tmpDir);
	await hook.toolBefore(
		{ tool: 'Task', sessionID: sessionId, callID },
		{ args },
	);
	const verdict =
		agent === 'reviewer'
			? `[REVIEWED] | task-${taskId} | APPROVED | exact task approved`
			: agent === 'test_engineer'
				? `[TESTED] | task-${taskId} | PASS | exact task passed`
				: 'completed successfully';
	await hook.toolAfter(
		{ tool: 'Task', sessionID: sessionId, callID, args },
		{ state: 'completed', output: verdict },
	);
}

describe('delegation-gate exact evidence recording', () => {
	it('records reviewer and test_engineer against the launch generation', async () => {
		const sessionId = 'stage-b-session';
		const generation = await seedStageA(sessionId, '1.1');

		await dispatchGate(sessionId, '1.1', 'reviewer', 'review-1');
		await dispatchGate(sessionId, '1.1', 'test_engineer', 'test-1');

		const evidence = await readTaskEvidence(tmpDir, '1.1');
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(evidence?.gates.test_engineer).toBeDefined();
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			generation,
			state: 'tests_run',
			authoritative: true,
		});
		expect(await hasPassedAllGates(tmpDir, '1.1')).toBe(true);
	});

	it.each([
		'docs',
		'explorer',
		'sme',
	])('records a positive %s gate through its bound dispatch', async (agent) => {
		const sessionId = `session-${agent}`;
		const session = ensureAgentSession(sessionId, 'architect', tmpDir);
		session.currentTaskId = '1.2';

		await dispatchGate(sessionId, '1.2', agent, `call-${agent}`);

		const evidence = await readTaskEvidence(tmpDir, '1.2');
		expect(evidence?.required_gates).toEqual([agent]);
		expect(evidence?.gates[agent]?.sessionId).toBe(sessionId);
	});

	it('does not attribute evidence when no exact task can be resolved', async () => {
		const sessionId = 'unattributed';
		ensureAgentSession(sessionId, 'architect', tmpDir);
		const hook = createDelegationGateHook(config, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: sessionId,
				callID: 'unbound',
				args: { subagent_type: 'docs' },
			},
			{ state: 'completed', output: 'completed successfully' },
		);

		expect(await readTaskEvidence(tmpDir, '1.1')).toBeNull();
	});

	it('keeps terminal completion blocked until the central transaction runs', async () => {
		const sessionId = 'terminal-guard';
		await seedStageA(sessionId, '1.3');
		await dispatchGate(sessionId, '1.3', 'reviewer', 'review-guard');
		await dispatchGate(sessionId, '1.3', 'test_engineer', 'test-guard');

		const gate = checkReviewerGate('1.3', tmpDir);
		expect(gate.blocked).toBe(false);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(tmpDir, '1.3')).state,
		).toBe('tests_run');
	});
});
