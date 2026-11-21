import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema.js';
import { _test_exports as stallTest } from '../../../src/hooks/guardrails/execution-stall.js';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails.js';
import { resetSwarmState, startAgentSession } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('execution-stall module state cleared by resetSwarmState (#3608)', () => {
	it('arms under a Task dispatch and is cleared by resetSwarmState (pendingDispatchRoleCount too)', async () => {
		const TEST_DIR = canonicalMkdtemp('execution-stall-reset-');
		try {
			const config: GuardrailsConfig = {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				profiles: undefined,
				block_destructive_commands: true,
			} as GuardrailsConfig;

			resetSwarmState();
			startAgentSession('test-session', 'architect');

			// Arm the episode through a real Task dispatch (the only path that arms).
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			// The stall observation runs at the very top of toolBefore (before
			// every policy gate), so awaiting the (likely-rejecting) dispatch
			// still leaves the episode armed. Awaiting is required so any async
			// rejection is observed rather than becoming an unhandled promise.
			try {
				await hooks.toolBefore(
					{ tool: 'Task', sessionID: 'test-session', callID: 'call-1' },
					{
						args: {
							subagent_type: 'coder',
							task: 'Implement feature X',
						},
					},
				);
			} catch {
				// ignored — arming happens before any later gate rejects
			}

			expect(stallTest.peekState('test-session')).toBeDefined();
			expect(stallTest.peekState('test-session')?.armed).toBe(true);
			expect(stallTest.pendingDispatchRoleCount()).toBeGreaterThan(0);

			// The reset path must clear BOTH module-level registries.
			resetSwarmState();
			expect(stallTest.peekState('test-session')).toBeUndefined();
			expect(stallTest.pendingDispatchRoleCount()).toBe(0);
			expect(stallTest.stateCount()).toBe(0);
		} finally {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it('a fresh session reusing a previously-armed sessionID is not denied by the stale episode', async () => {
		const TEST_DIR = canonicalMkdtemp('execution-stall-reuse-');
		try {
			const config: GuardrailsConfig = {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				profiles: undefined,
				block_destructive_commands: true,
			} as GuardrailsConfig;

			// First swarm session arms an episode.
			resetSwarmState();
			startAgentSession('test-session', 'architect');
			const hooks1 = createGuardrailsHooks(TEST_DIR, undefined, config);
			try {
				hooks1.toolBefore(
					{ tool: 'Task', sessionID: 'test-session', callID: 'call-1' },
					{ args: { subagent_type: 'coder', task: 'x' } },
				);
			} catch {
				// ignored
			}

			// resetSwarmState must disarm before the second session reuses the id.
			resetSwarmState();
			startAgentSession('test-session', 'architect');
			const hooks2 = createGuardrailsHooks(TEST_DIR, undefined, config);
			// 61 allow-shaped calls must NOT trip the stall threshold (60).
			for (let i = 0; i < 61; i++) {
				await hooks2.toolBefore(
					{ tool: 'read', sessionID: 'test-session', callID: `r-${i}` },
					{ args: { filePath: `/t${i}.ts` } },
				);
			}
			// No throw means the stale episode did not survive the reset.
			expect(stallTest.peekState('test-session')?.armed ?? false).toBe(false);
		} finally {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});
});
