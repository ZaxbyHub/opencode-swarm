import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findByCorrelationId } from '../../src/background/pending-delegations';
import { resolveAutoReviewConfig } from '../../src/config/schema';
import { _internals } from '../../src/hooks/auto-review';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import { resetSwarmState } from '../../src/state';
import { writeApprovedPlan } from '../helpers/approved-plan';
import { createSafeTestDir } from '../helpers/safe-test-dir';

const originalRunAutoReview = _internals.runAutoReview;

function pluginContext(directory: string) {
	return {
		client: {} as never,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	};
}

describe('issue #1675 — task auto-review uses the real tool-after boundary', () => {
	let directory: string;
	let cleanup: () => void;
	let restoreIndexInternals: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('auto-review-real-host-'));
		restoreIndexInternals = () => {};
		resetSwarmState();
	});

	afterEach(() => {
		_internals.runAutoReview = originalRunAutoReview;
		restoreIndexInternals();
		resetSwarmState();
		cleanup();
	});

	for (const trigger of ['task_completion', 'both'] as const) {
		test(`${trigger} dispatches from snapshot args when SDK after output has no args`, async () => {
			const opencodeDirectory = path.join(directory, '.opencode');
			fs.mkdirSync(opencodeDirectory, { recursive: true });
			await writeApprovedPlan(directory, [
				{ id: '1.1', files: ['src/index.ts'] },
			]);
			fs.writeFileSync(
				path.join(opencodeDirectory, 'opencode-swarm.json'),
				JSON.stringify({
					version_check: false,
					auto_review: { enabled: true, trigger },
				}),
			);

			const calls: Array<{ trigger: string; taskId?: string }> = [];
			// This seam replaces only the downstream review engine. Its clean/error,
			// fallback, and evidence branches are covered by tests/unit/review and
			// tests/unit/hooks/auto-review.test.ts; this regression exercises the
			// real plugin before/after boundary and dispatch decision.
			_internals.runAutoReview = async (input) => {
				calls.push({ trigger: input.trigger, taskId: input.taskId });
				return undefined;
			};

			const plugin = await OpenCodeSwarm.server(pluginContext(directory));
			const before = plugin['tool.execute.before'];
			const after = plugin['tool.execute.after'];
			const chatMessage = plugin['chat.message'];
			const input = {
				tool: 'update_task_status',
				sessionID: `session-${trigger}`,
				callID: `call-${trigger}`,
			};

			await chatMessage(
				{ sessionID: input.sessionID, agent: 'architect' },
				{ message: {}, parts: [] },
			);
			await before(input, {
				args: { task_id: '1.1', status: 'completed' },
			});

			const productionAfterOutput = {
				title: 'Task status updated',
				output: 'completed',
				metadata: {},
			};
			expect(productionAfterOutput).not.toHaveProperty('args');
			await after(input, productionAfterOutput);

			expect(calls).toEqual([{ trigger: 'task_completion', taskId: '1.1' }]);
		});
	}

	test('omitted v8 auto_review still captures background code provenance', async () => {
		restoreIndexInternals = overrideIndexInternalsForTest({
			resolveAutoReviewConfig: (raw) =>
				resolveAutoReviewConfig(raw, { packageVersion: '8.0.0' }),
		});
		const opencodeDirectory = path.join(directory, '.opencode');
		fs.mkdirSync(opencodeDirectory, { recursive: true });
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/index.ts'] },
		]);
		fs.writeFileSync(
			path.join(opencodeDirectory, 'opencode-swarm.json'),
			JSON.stringify({
				version_check: false,
				hooks: { background_subagents: true },
			}),
		);

		const plugin = await OpenCodeSwarm.server(pluginContext(directory));
		const input = {
			tool: 'Task',
			sessionID: 'v8-default-parent',
			callID: 'v8-default-coder-call',
		};
		const args = {
			subagent_type: 'coder',
			background: true,
			prompt: 'TASK: 1.1\nACCEPTANCE: implementation and tests pass',
		};
		await plugin['chat.message'](
			{ sessionID: input.sessionID, agent: 'architect' },
			{ message: {}, parts: [] },
		);
		await plugin['tool.execute.before'](input, { args });
		await plugin['tool.execute.after'](input, {
			state: 'running',
			output:
				'<task id="v8-default-child" state="running">background coder started</task>',
			metadata: { background: true, jobId: 'job-v8-default-child' },
		});

		// The original config omitted auto_review. Passing that unresolved object
		// into the delegation gate dropped non-Markdown provenance even though the
		// simulated v8 release resolver enabled auto-review for every other surface.
		expect(
			findByCorrelationId(directory, 'v8-default-child')?.taskChangeContext
				?.declaredFiles,
		).toEqual(['src/index.ts']);
	});
});
