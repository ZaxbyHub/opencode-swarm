import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
});

afterEach(() => {
	resetSwarmState();
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('review routing task-keyed modified files', () => {
	test('routes a non-active reverse-order task from its exact attribution key', async () => {
		const { dir, cleanup } = createSafeTestDir('swarm-review-routing-');
		try {
			mkdirSync(path.join(dir, '.opencode'), { recursive: true });
			const session = ensureAgentSession('parent', 'architect', dir);
			await Promise.allSettled([...swarmState.pendingRehydrations]);
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
