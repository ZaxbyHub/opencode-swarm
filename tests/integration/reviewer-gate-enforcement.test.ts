import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../src/config';
import { closeAllProjectDbs } from '../../src/db/project-db.js';
import { transitionTaskWorkflowEvidence } from '../../src/gate-evidence';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { writeApprovedPlan } from '../helpers/approved-plan';

/**
 * Simulate a coder delegation by adding a delegation chain entry.
 * The delegation-gate checks for this to determine if coder_delegated state
 * is from the current session (not stale from a prior session).
 */
async function seedAcceptedMutation(
	directory: string,
	taskId: string,
): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `accepted-${taskId}`,
	});
}

function makeConfig(): PluginConfig {
	return {
		hooks: {
			delegation_gate: true,
		},
	} as unknown as PluginConfig;
}

describe('runtime reviewer gate', () => {
	let testDir: string;

	beforeEach(async () => {
		resetSwarmState();
		testDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-gate-int-')),
		);
		await writeApprovedPlan(testDir, [
			{ id: '1.1', files: ['src/index.ts'] },
			{ id: '3.1', files: ['src/index.ts'] },
		]);
	});

	afterEach(() => {
		resetSwarmState();
		closeAllProjectDbs();
		fs.rmSync(testDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	});

	test('blocks coder re-delegation when state is coder_delegated', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-reviewer-gate-1';

		ensureAgentSession(sessionId, 'architect', testDir);
		// Set task 1.1 to coder_delegated (coder already ran, no reviewer)
		await seedAcceptedMutation(testDir, '1.1');
		// Simulate that the coder delegation happened in this session
		// (delegation-gate resets stale coder_delegated state if no delegation entry exists)

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'STAGE_A_REQUIRED',
		);
	});

	test('allows coder delegation when state is idle (first delegation)', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-reviewer-gate-2';

		ensureAgentSession(sessionId, 'architect', testDir);
		// State is idle by default (no taskWorkflowStates entries)

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should not throw
		await hooks.toolBefore(input, output);
	});

	test('allows coder delegation after reviewer has run (state reviewer_run)', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-reviewer-gate-3';

		ensureAgentSession(sessionId, 'architect', testDir);
		// Advance through states: idle → coder_delegated → reviewer_run
		await seedAcceptedMutation(testDir, '1.1');
		await transitionTaskWorkflowEvidence(testDir, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-1.1',
		});
		await transitionTaskWorkflowEvidence(testDir, '1.1', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId,
			expectedGeneration: 1,
			transitionId: 'reviewer-1.1',
		});

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should not throw — reviewer has already run
		await hooks.toolBefore(input, output);
	});

	test('turbo mode bypasses the block', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-reviewer-gate-4';

		const session = ensureAgentSession(sessionId, 'architect', testDir);
		await seedAcceptedMutation(testDir, '1.1');

		// Enable turbo mode
		session.turboMode = true;

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should not throw in turbo mode for non-Tier-3 tasks
		await hooks.toolBefore(input, output);
	});

	test('Tier 3 tasks are NOT bypassed even in turbo mode', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-reviewer-gate-5';

		const session = ensureAgentSession(sessionId, 'architect', testDir);
		// Task 3.1 is a Tier 3 task
		await seedAcceptedMutation(testDir, '3.1');
		// Simulate that the coder delegation happened in this session

		// Enable turbo mode
		session.turboMode = true;

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				task_id: '3.1',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should throw even in turbo mode for Tier 3 tasks
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'STAGE_A_REQUIRED',
		);
	});
});
