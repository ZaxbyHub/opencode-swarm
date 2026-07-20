/**
 * Integration tests for prepareCoderScope's membership gate and cause-specific
 * SCOPE_NOT_DECLARED diagnostics. Issue #1914.
 *
 * Drives the gate end-to-end via `hook.toolBefore` with a Task dispatch.
 * Sibling to delegation-gate-scope-preflight.test.ts (split to stay under the
 * 500-line test-file cap — see .agents/skills/test-file-split/SKILL.md).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard';
import {
	ensureAgentSession,
	resetSwarmState,
} from '../../../src/state';
import {
	createDelegationGateHook,
	makeConfig,
	recordPlanCriticApproval,
} from './_delegation-gate-helpers';

function planWithTasks(taskIds: string[], files: string[] = []): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Membership gate test',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: taskIds.map((id) => ({
					id,
					phase: 1,
					status: 'pending',
					size: 'small' as const,
					description: `Task ${id}`,
					depends: [],
					files_touched: files,
				})),
			},
		],
	};
}

describe('prepareCoderScope — issue #1914 membership gate + diagnostics', () => {
	let directory: string;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'scope-membership-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		ensureAgentSession('parent', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	async function writePlan(taskIds: string[], files: string[] = []): Promise<Plan> {
		const plan = planWithTasks(taskIds, files);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		await recordPlanCriticApproval(directory, plan);
		return plan;
	}

	async function dispatch(
		args: Record<string, unknown>,
		callID = 'task-call',
	): Promise<void> {
		const hook = createDelegationGateHook(makeConfig(), directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID },
			{
				args: {
					subagent_type: 'coder',
					...args,
				},
			},
		);
	}

	test('acceptance #1: ses_ session-id task_id + unambiguous TASK: line resolves and dispatches', async () => {
		const plan = await writePlan(['3.4'], ['src/index.ts']);
		// The runtime-injected task_id ("ses_...") must NOT defeat resolution
		// of a valid TASK: line. Dispatch should succeed and bind the scope.
		await expect(
			dispatch({
				task_id: 'ses_runtime-injected-session-id',
				prompt: 'TASK: 3.4 — implement feature\nACCEPTANCE: done',
			}),
		).resolves.toBeUndefined();

		// Confirm the binding was staged for the resolved task (3.4), proving
		// the dispatch reached prepareCoderScope's happy path.
		const hook = createDelegationGateHook(makeConfig(), directory);
		await hook.taskMetadata({
			callID: 'task-call',
			parentSessionID: 'parent',
			childSessionID: 'child',
		});
		const child = ensureAgentSession('child', 'coder', directory);
		expect(child.currentTaskId).toBe('3.4');
		expect(plan.phases[0].tasks[0].id).toBe('3.4');
	});

	test('acceptance #2: plan-task-shaped-but-unknown task_id fails closed with membership diagnostic', async () => {
		await writePlan(['1.1'], ['src/index.ts']);
		await expect(
			dispatch({
				task_id: '9.9',
				prompt: 'TASK: 9.9 — unknown task\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/task_id "9\.9" does not match any known plan task id/);
	});

	test('acceptance #2 (variant): plan-task-shaped unknown id + FILE: directives still fails closed (membership gate beats scope sources)', async () => {
		// The latent hole the critic identified: without the membership gate,
		// "9.9" + FILE: src/foo.ts would produce a valid binding because
		// createScopeBinding only validates isStrictTaskId, not plan membership.
		await writePlan(['1.1'], ['src/index.ts']);
		await expect(
			dispatch({
				task_id: '9.9',
				prompt: 'TASK: 9.9 — unknown\nFILE: src/foo.ts\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/task_id "9\.9" does not match any known plan task id/);
	});

	test('acceptance #3a: missing plan produces a plan-path diagnostic', async () => {
		// No writePlan() call — .swarm/plan.json absent.
		await expect(
			dispatch({
				prompt: 'TASK: 1.1 — x\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/no valid plan found at .*plan\.json \(file missing or invalid\)/);
	});

	test('acceptance #3b: corrupt plan.json produces the same plan-path diagnostic', async () => {
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'{ not valid json',
		);
		await expect(
			dispatch({
				prompt: 'TASK: 1.1 — x\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/no valid plan found at .*plan\.json \(file missing or invalid\)/);
	});

	test('acceptance #3c: plan present but no resolvable task id produces a no-signal diagnostic', async () => {
		await writePlan(['1.1'], ['src/index.ts']);
		await expect(
			dispatch({
				prompt: 'Just do some work\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/no plan task id could be resolved/);
	});

	test('acceptance #3d: non-plan-shaped explicit task_id with no text signal reports the fall-through', async () => {
		await writePlan(['1.1'], ['src/index.ts']);
		await expect(
			dispatch({
				task_id: 'ses_abc123',
				prompt: 'Do some work\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/non-plan-shaped.*falling through to text extraction/);
	});

	test('acceptance #4: ambiguous TASK: line lists candidate ids in the error', async () => {
		await writePlan(['1.1', '2.1'], ['src/index.ts']);
		await expect(
			dispatch({
				prompt: 'TASK: port from 1.1 to 2.1\nACCEPTANCE: done',
			}),
		).rejects.toThrow(/multiple candidate task ids found in TASK: line: \[1\.1, 2\.1\]/);
	});

	test('regression: plan-task-shaped explicit task_id still wins over prompt text (PR #961 preserved)', async () => {
		// PR #961's "explicit id takes precedence" intent is preserved for
		// plan-task-shaped values. The dispatch should resolve 1.1 (the explicit
		// field), not 2.1 (the TASK: line).
		await writePlan(['1.1', '2.1'], ['src/index.ts']);
		// Explicit 1.1 matches a plan task → membership gate passes → dispatch
		// proceeds (would only fail if scope binding had nothing to bind, but
		// 1.1 has files_touched).
		await expect(
			dispatch({
				task_id: '1.1',
				prompt: 'TASK: 2.1 — should be overridden\nACCEPTANCE: done',
			}),
		).resolves.toBeUndefined();
	});
});
