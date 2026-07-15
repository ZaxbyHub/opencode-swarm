import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../src/config';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import type { DelegationEntry } from '../../src/state';
import {
	advanceTaskState,
	ensureAgentSession,
	hasActiveTurboMode,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { withFrozenClock } from '../helpers/test-clock.js';

/**
 * Simulate a coder delegation by adding a delegation chain entry.
 * The delegation-gate checks for this to determine if coder_delegated state
 * is from the current session (not stale from a prior session).
 */
function simulateCoderDelegation(sessionId: string): void {
	const existing = swarmState.delegationChains.get(sessionId) ?? [];
	const entry: DelegationEntry = {
		from: 'architect',
		to: 'coder',
		timestamp: withFrozenClock(() => Date.now(), {
			fixedNow: 1_700_000_000_000,
		}),
	};
	swarmState.delegationChains.set(sessionId, [...existing, entry]);
}

const TEST_DIR = '/test/project';

function makeConfig(): PluginConfig {
	return {
		hooks: {
			delegation_gate: true,
		},
	} as unknown as PluginConfig;
}

describe('runtime reviewer gate', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('blocks coder re-delegation when state is coder_delegated', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, TEST_DIR);
		const sessionId = 'session-reviewer-gate-1';

		const session = ensureAgentSession(sessionId, 'architect');
		// Set task 1.1 to coder_delegated (coder already ran, no reviewer)
		advanceTaskState(session, '1.1', 'coder_delegated');
		// Simulate that the coder delegation happened in this session
		// (delegation-gate resets stale coder_delegated state if no delegation entry exists)
		simulateCoderDelegation(sessionId);

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'REVIEWER_GATE_VIOLATION',
		);
	});

	test('allows coder delegation when state is idle (first delegation)', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, TEST_DIR);
		const sessionId = 'session-reviewer-gate-2';

		ensureAgentSession(sessionId, 'architect');
		// State is idle by default (no taskWorkflowStates entries)

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should not throw
		await hooks.toolBefore(input, output);
	});

	test('allows coder delegation after reviewer has run (state reviewer_run)', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, TEST_DIR);
		const sessionId = 'session-reviewer-gate-3';

		const session = ensureAgentSession(sessionId, 'architect');
		// Advance through states: idle → coder_delegated → reviewer_run
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'reviewer_run');

		const input = {
			tool: 'Task',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const output = {
			args: {
				subagent_type: 'coder',
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should not throw — reviewer has already run
		await hooks.toolBefore(input, output);
	});

	test('turbo mode bypasses the block', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, TEST_DIR);
		const sessionId = 'session-reviewer-gate-4';

		const session = ensureAgentSession(sessionId, 'architect');
		advanceTaskState(session, '1.1', 'coder_delegated');

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
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should not throw in turbo mode for non-Tier-3 tasks
		await hooks.toolBefore(input, output);
	});

	test('Tier 3 tasks are NOT bypassed even in turbo mode', async () => {
		const config = makeConfig();
		const hooks = createDelegationGateHook(config, TEST_DIR);
		const sessionId = 'session-reviewer-gate-5';

		const session = ensureAgentSession(sessionId, 'architect');
		// Task 3.1 is a Tier 3 task
		advanceTaskState(session, '3.1', 'coder_delegated');
		// Simulate that the coder delegation happened in this session
		simulateCoderDelegation(sessionId);

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
				prompt: 'Fix the bug\nACCEPTANCE: task complete and covered by tests',
			},
		};

		// Should throw even in turbo mode for Tier 3 tasks
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			'REVIEWER_GATE_VIOLATION',
		);
	});
});
