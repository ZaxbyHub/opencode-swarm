import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';
const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function runGit(directory: string, args: string[], capture = false): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore',
		stdin: 'ignore',
		timeout: 5000,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`fixture git command failed: ${args.join(' ')}`);
	}
	return capture ? String(result.stdout).trim() : '';
}

describe('issue #2763 — delegation gate empty-scope admission', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(
		async () => {
			resetSwarmState();
			({ dir: directory, cleanup } = createSafeTestDir(
				'delegation-empty-2763-',
			));
			runGit(directory, ['init', '--quiet']);
			runGit(directory, ['config', 'user.email', 'issue-2763@example.invalid']);
			runGit(directory, ['config', 'user.name', 'Issue 2763 test']);
			fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(directory, 'src', 'feature.ts'),
				'export const feature = 1;\n',
			);
			runGit(directory, ['add', 'src/feature.ts']);
			runGit(directory, ['commit', '--quiet', '-m', 'issue 2763 fixture']);
			fs.appendFileSync(
				path.join(directory, '.git', 'info', 'exclude'),
				'\n.swarm/\n',
			);
			await writeApprovedPlan(directory, [{ id: TASK_ID, files: [] }]);
			const session = ensureAgentSession('parent', 'architect', directory);
			session.currentTaskId = TASK_ID;
		},
		{ timeout: 30_000 },
	);

	afterEach(
		() => {
			resetSwarmState();
			cleanup();
		},
		{ timeout: 30_000 },
	);

	test(
		'uses a complete FILE directive as the coder scope when the plan is empty',
		async () => {
			const hook = createDelegationGateHook(config, directory);
			const args = {
				subagent_type: 'coder',
				task_id: TASK_ID,
				prompt:
					'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: verify the implementation',
			};
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'empty-plan-file' },
				{ args },
			);
			fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(directory, 'src', 'feature.ts'),
				'export const feature = 9;\n',
			);
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'parent',
					callID: 'empty-plan-file',
					args,
				},
				{ state: 'completed', output: 'verified' },
			);

			const evidence = await readTaskEvidence(directory, TASK_ID);
			expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
				state: 'coder_delegated',
				generation: 1,
				lastOutcome: 'accepted_mutation',
			});
			expect(evidence?.workflow?.noMutationSettlement).toBeUndefined();
			expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
		},
		{ timeout: 30_000 },
	);

	test(
		'records a trusted no-mutation proof while rejecting an explicit empty plan dispatch',
		async () => {
			const hook = createDelegationGateHook(config, directory);
			const args = {
				subagent_type: 'coder',
				task_id: TASK_ID,
				prompt: 'TASK: 1.1\nACCEPTANCE: verify no code change is required',
			};

			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: 'parent', callID: 'empty-plan-rejected' },
					{ args },
				),
			).rejects.toThrow('SCOPE_NOT_DECLARED');

			const evidence = await readTaskEvidence(directory, TASK_ID);
			expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
				state: 'idle',
				generation: 0,
				lastOutcome: 'dispatch_no_mutation',
			});
			expect(evidence?.workflow?.noMutationSettlement).toMatchObject({
				generation: 0,
				transitionId: 'coder-preflight:empty-plan-rejected',
				declaredFiles: [],
			});
		},
		{ timeout: 30_000 },
	);

	test(
		'revokes the no-mutation exception when the current plan later gains scope',
		async () => {
			const hook = createDelegationGateHook(config, directory);
			const args = {
				subagent_type: 'coder',
				task_id: TASK_ID,
				prompt: 'TASK: 1.1\nACCEPTANCE: verify no code change is required',
			};

			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: 'parent', callID: 'empty-plan-expanded' },
					{ args },
				),
			).rejects.toThrow('SCOPE_NOT_DECLARED');

			const planPath = path.join(directory, '.swarm', 'plan.json');
			const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as {
				phases: Array<{
					tasks: Array<{ id: string; files_touched: string[] }>;
				}>;
			};
			plan.phases[0].tasks[0].files_touched = ['src/expanded.ts'];
			fs.writeFileSync(planPath, JSON.stringify(plan));

			const decision = checkReviewerGate(
				TASK_ID,
				directory,
				false,
				'parent',
				directory,
			);
			expect(decision.blocked).toBe(true);
			expect(decision.missingGates).toContain('pre_check');
		},
		{ timeout: 30_000 },
	);
});
