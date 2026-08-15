/** Cross-session mirroring tests for generation-bound Stage B settlements. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalTmpDir } from '../../tests/helpers/tmpdir.js';
import type { PluginConfig } from '../config';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence';
import { ensureAgentSession, getTaskState, resetSwarmState } from '../state';
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
	tmpDir = mkdtempSync(path.join(canonicalTmpDir(), 'dg-seed-state-'));
});

afterEach(() => {
	resetSwarmState();
	rmSync(tmpDir, { recursive: true, force: true });
});

async function seedStageA(taskId: string): Promise<number> {
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
	return generation;
}

async function dispatchStageB(
	agent: 'reviewer' | 'test_engineer',
	callID: string,
): Promise<void> {
	const args = {
		subagent_type: `mega_${agent}`,
		task_id: '1.1',
		prompt:
			'TASK: 1.1\nACCEPTANCE: Return a positive verdict bound to this exact task.',
	};
	const hook = createDelegationGateHook(config, tmpDir);
	await hook.toolBefore(
		{ tool: 'Task', sessionID: 'session-1', callID },
		{ args },
	);
	const output =
		agent === 'reviewer'
			? '[REVIEWED] | task-1.1 | APPROVED | approved'
			: '[TESTED] | task-1.1 | PASS | passed';
	await hook.toolAfter(
		{ tool: 'Task', sessionID: 'session-1', callID, args },
		{ state: 'completed', output },
	);
}

describe('delegation-gate cross-session exact-state isolation', () => {
	it('reviewer settlement stays durable without manufacturing peer memory', async () => {
		await seedStageA('1.1');
		const origin = ensureAgentSession('session-1', 'architect', tmpDir);
		origin.currentTaskId = '1.1';
		origin.taskWorkflowStates.set('1.1', 'pre_check_passed');
		const peer = ensureAgentSession('session-2', 'architect', tmpDir);

		await dispatchStageB('reviewer', 'reviewer-call');

		expect(getTaskState(peer, '1.1')).toBe('idle');
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(tmpDir, '1.1')).state,
		).toBe('reviewer_run');
	});

	it('test_engineer settlement stays durable without manufacturing peer memory', async () => {
		const generation = await seedStageA('1.1');
		await transitionTaskWorkflowEvidence(tmpDir, '1.1', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'seed-reviewer',
			expectedGeneration: generation,
			transitionId: 'seed-reviewer-gate',
		});
		const origin = ensureAgentSession('session-1', 'architect', tmpDir);
		origin.currentTaskId = '1.1';
		origin.taskWorkflowStates.set('1.1', 'reviewer_run');
		const peer = ensureAgentSession('session-2', 'architect', tmpDir);

		await dispatchStageB('test_engineer', 'test-call');

		expect(getTaskState(peer, '1.1')).toBe('idle');
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(tmpDir, '1.1')).state,
		).toBe('tests_run');
	});

	it('does not overwrite a peer session already at a later state', async () => {
		await seedStageA('1.1');
		const origin = ensureAgentSession('session-1', 'architect', tmpDir);
		origin.currentTaskId = '1.1';
		origin.taskWorkflowStates.set('1.1', 'pre_check_passed');
		const peer = ensureAgentSession('session-2', 'architect', tmpDir);
		peer.taskWorkflowStates.set('1.1', 'tests_run');

		await dispatchStageB('reviewer', 'no-downgrade-call');

		expect(getTaskState(peer, '1.1')).toBe('tests_run');
	});
});
