import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	recordModifiedFilesForTask,
	resetSwarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('review routing task-keyed modified files', () => {
	afterEach(() => resetSwarmState());

	test('routes a non-active reverse-order task from its exact attribution key', async () => {
		const { dir, cleanup } = createSafeTestDir('swarm-review-routing-');
		try {
			const session = ensureAgentSession('parent', 'architect', dir);
			session.currentTaskId = '1.1';
			session.modifiedFilesThisCoderTask = [];
			recordModifiedFilesForTask(session, '1.1', []);
			recordModifiedFilesForTask(session, '2.1', [
				'src/a.ts',
				'src/b.ts',
				'src/c.ts',
				'src/d.ts',
				'src/e.ts',
			]);
			const hook = createDelegationGateHook(
				{
					max_iterations: 5,
					qa_retry_limit: 3,
					inject_phase_reminders: true,
					hooks: { delegation_gate: true },
				} as PluginConfig,
				dir,
			);

			try {
				await hook.toolBefore(
					{ tool: 'Task', sessionID: 'parent', callID: 'review-call' },
					{
						args: {
							subagent_type: 'reviewer',
							task_id: '2.1',
							prompt: 'TASK: 2.1\nACCEPTANCE: review the exact changed files',
						},
					},
				);
			} catch {
				// Later reviewer gates are outside this routing assertion.
			}

			expect(
				session.pendingAdvisoryMessages?.some((message) =>
					message.includes('REVIEW ROUTING: High complexity'),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});
});
