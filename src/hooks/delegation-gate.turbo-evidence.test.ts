/** Exact-lifecycle coverage for turbo propagation into durable gate evidence. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence';
import {
	ensureAgentSession,
	hasActiveTurboMode,
	resetSwarmState,
} from '../state';
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
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-turbo-evidence-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	rmSync(tmpDir, { recursive: true, force: true });
});

async function dispatch(
	sessionId: string,
	taskId: string,
	agent: 'reviewer' | 'test_engineer' | 'docs',
	callID: string,
): Promise<void> {
	const args = {
		subagent_type: agent,
		task_id: taskId,
		prompt: `TASK: ${taskId}\nACCEPTANCE: Return a bound positive verdict for this exact task.`,
	};
	const hook = createDelegationGateHook(config, tmpDir);
	await hook.toolBefore(
		{ tool: 'Task', sessionID: sessionId, callID },
		{ args },
	);
	const output =
		agent === 'reviewer'
			? `[REVIEWED] | task-${taskId} | APPROVED | approved`
			: agent === 'test_engineer'
				? `[TESTED] | task-${taskId} | PASS | passed`
				: 'completed successfully';
	await hook.toolAfter(
		{ tool: 'Task', sessionID: sessionId, callID, args },
		{ state: 'completed', output },
	);
}

async function seedStageA(sessionId: string, taskId: string): Promise<void> {
	const accepted = await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `turbo-seed:${taskId}`,
	});
	const generation = getTaskWorkflowSnapshot(accepted).generation;
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: `turbo-stage-a:${taskId}`,
	});
	const session = ensureAgentSession(sessionId, 'architect', tmpDir);
	session.currentTaskId = taskId;
	session.taskWorkflowStates.set(taskId, 'pre_check_passed');
}

describe('turbo mode exact evidence propagation', () => {
	it('writes turbo:true for a bound positive non-Stage-B gate', async () => {
		const session = ensureAgentSession('turbo-docs', 'architect', tmpDir);
		session.currentTaskId = '1.1';
		session.turboMode = true;

		await dispatch('turbo-docs', '1.1', 'docs', 'docs-call');

		const evidence = await readTaskEvidence(tmpDir, '1.1');
		expect(evidence?.turbo).toBe(true);
		expect(evidence?.gates.docs).toBeDefined();
	});

	it('does not set turbo:true when the session is supervised', async () => {
		const session = ensureAgentSession('supervised-docs', 'architect', tmpDir);
		session.currentTaskId = '1.2';
		session.turboMode = false;

		await dispatch('supervised-docs', '1.2', 'docs', 'docs-supervised');

		expect((await readTaskEvidence(tmpDir, '1.2'))?.turbo).not.toBe(true);
	});

	it('preserves turbo through reviewer and test_engineer generation-bound gates', async () => {
		const sessionId = 'turbo-stage-b';
		await seedStageA(sessionId, '1.3');
		ensureAgentSession(sessionId).turboMode = true;

		await dispatch(sessionId, '1.3', 'reviewer', 'review-call');
		await dispatch(sessionId, '1.3', 'test_engineer', 'test-call');

		const evidence = await readTaskEvidence(tmpDir, '1.3');
		expect(evidence?.turbo).toBe(true);
		expect(getTaskWorkflowSnapshot(evidence).state).toBe('tests_run');
	});

	it('reports active turbo mode only for the matching session', () => {
		ensureAgentSession('active', 'architect', tmpDir).turboMode = true;
		ensureAgentSession('inactive', 'architect', tmpDir).turboMode = false;

		expect(hasActiveTurboMode('active')).toBe(true);
		expect(hasActiveTurboMode('inactive')).toBe(false);
	});
});
