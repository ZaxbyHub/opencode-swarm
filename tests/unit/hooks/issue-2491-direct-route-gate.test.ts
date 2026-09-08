import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate.js';
import { routeReceiptPathForTask } from '../../../src/review/routing-enforcement.js';
import {
	advanceTaskState,
	getTaskState,
	recordModifiedFilesForTask,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

const config = {
	hooks: { delegation_gate: true },
} as PluginConfig;

let directory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(async () => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	directory = canonicalMkdtemp('issue-2491-direct-route-gate-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	startAgentSession('parent-2491', 'architect', directory);
	// Drain the asynchronous session rehydration before mutating the in-memory
	// workflow; the delegation gate awaits this queue before Stage-B dispatch.
	await Promise.allSettled([...swarmState.pendingRehydrations]);
	await transitionTaskWorkflowEvidence(directory, '1.1', {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: 'coder:1.1',
	});
	await transitionTaskWorkflowEvidence(directory, '1.1', {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: 'stage-a:1.1',
	});
	const session = swarmState.agentSessions.get('parent-2491')!;
	recordModifiedFilesForTask(session, '1.1', ['src/example.ts']);
	advanceTaskState(session, '1.1', 'coder_delegated');
	advanceTaskState(session, '1.1', 'pre_check_passed');
	session.currentTaskId = '1.1';
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('issue #2491 direct delegation-gate route authorization', () => {
	async function completeDispatch(
		hook: ReturnType<typeof createDelegationGateHook>,
		role: 'reviewer' | 'test_engineer',
		callID: string,
		childSessionID: string,
	): Promise<void> {
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-2491', callID },
			{
				args: {
					subagent_type: role,
					task_id: '1.1',
					prompt: `${role} task-1.1.\nACCEPTANCE: return a structured ${role} result for task-1.1.`,
				},
			},
		);
		await hook.taskMetadata({
			callID,
			parentSessionID: 'parent-2491',
			childSessionID,
		});
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent-2491',
				callID,
				args: { subagent_type: role, task_id: '1.1' },
			},
			{
				text:
					role === 'reviewer'
						? '[REVIEWED] | task-1.1 | APPROVED | looks good'
						: '[TESTED] | task-1.1 | PASS | focused tests passed',
			},
		);
	}

	test('records each valid 1+1 completion before the full-route advancement', async () => {
		const hook = createDelegationGateHook(config, directory);
		await completeDispatch(hook, 'reviewer', 'review-call-1', 'review-child-1');
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, '1.1'),
		).toBe('reviewer_run');
		await completeDispatch(
			hook,
			'test_engineer',
			'test-call-1',
			'test-child-1',
		);
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, '1.1'),
		).toBe('tests_run');
	});

	test('holds reversed 2+2 completions at the full-route barrier', async () => {
		const session = swarmState.agentSessions.get('parent-2491')!;
		recordModifiedFilesForTask(session, '1.1', [
			'src/a.ts',
			'src/b.ts',
			'src/c.ts',
			'src/d.ts',
			'src/e.ts',
		]);
		const hook = createDelegationGateHook(config, directory);
		await completeDispatch(
			hook,
			'test_engineer',
			'test-call-1',
			'test-child-1',
		);
		await completeDispatch(hook, 'reviewer', 'review-call-1', 'review-child-1');
		await completeDispatch(
			hook,
			'test_engineer',
			'test-call-2',
			'test-child-2',
		);
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		await completeDispatch(hook, 'reviewer', 'review-call-2', 'review-child-2');
		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});

	test('retrying the same direct dispatch replaces its route slot once', async () => {
		const session = swarmState.agentSessions.get('parent-2491')!;
		recordModifiedFilesForTask(session, '1.1', [
			'src/a.ts',
			'src/b.ts',
			'src/c.ts',
			'src/d.ts',
			'src/e.ts',
		]);
		const hook = createDelegationGateHook(config, directory);
		await completeDispatch(
			hook,
			'reviewer',
			'review-call-retry',
			'review-child-retry',
		);
		// The task is still waiting for test_engineer, so the same exact dispatch
		// identity can be retried without creating a second reviewer slot.
		await completeDispatch(
			hook,
			'reviewer',
			'review-call-retry',
			'review-child-retry',
		);
		expect(session.stageBRouteEvidence?.get('1.1')).toHaveLength(1);
		expect(session.stageBRouteEvidence?.get('1.1')?.[0]?.slotId).toBe(
			'1.1:reviewer:1',
		);
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
	});

	for (const role of ['reviewer', 'test_engineer'] as const) {
		test(`${role} retry reclaims a slot after denied dispatch cleanup`, async () => {
			const session = swarmState.agentSessions.get('parent-2491')!;
			recordModifiedFilesForTask(session, '1.1', [
				'src/a.ts',
				'src/b.ts',
				'src/c.ts',
				'src/d.ts',
				'src/e.ts',
			]);
			const hook = createDelegationGateHook(config, directory);
			const deniedCallID = `${role}-denied-call`;

			// toolBefore reserves the first route slot before a later fail-closed
			// hook denies the Task. There is intentionally no toolAfter for this
			// call, so abortDeniedSettlementForCall is the only cleanup path.
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-2491', callID: deniedCallID },
				{
					args: {
						subagent_type: role,
						task_id: '1.1',
						prompt: `${role} task-1.1.\nACCEPTANCE: return a structured ${role} result for task-1.1.`,
					},
				},
			);
			await hook.abortDeniedSettlementForCall(deniedCallID);

			// A fresh call identity must be able to reclaim the released first slot;
			// if the denied call's live binding were stranded, it would be assigned
			// the second slot instead.
			await completeDispatch(hook, role, `${role}-retry-call`, `${role}-retry-child`);
			expect(session.stageBRouteEvidence?.get('1.1')).toHaveLength(1);
			expect(session.stageBRouteEvidence?.get('1.1')?.[0]?.slotId).toBe(
				`1.1:${role}:1`,
			);
		});
	}

	test('preserves sequential Stage-B advancement when receipt enforcement is disabled', async () => {
		const session = swarmState.agentSessions.get('parent-2491')!;
		recordModifiedFilesForTask(session, '1.1', [
			'src/a.ts',
			'src/b.ts',
			'src/c.ts',
			'src/d.ts',
			'src/e.ts',
		]);
		const hook = createDelegationGateHook(
			{
				...config,
				review_routing: { enforce_receipts: false },
			} as PluginConfig,
			directory,
		);
		await completeDispatch(hook, 'reviewer', 'review-call-1', 'review-child-1');
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		await completeDispatch(
			hook,
			'test_engineer',
			'test-call-1',
			'test-child-1',
		);
		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});

	test('missing route receipt blocks Stage-B toolAfter before evidence publication', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-2491', callID: 'review-call-1' },
			{
				args: {
					subagent_type: 'reviewer',
					task_id: '1.1',
					prompt:
						'Review task-1.1 and return a structured approval.\nACCEPTANCE: return a structured approval for task-1.1.',
				},
			},
		);

		// The no-change route is explicit and normally fail-open, but the persisted
		// receipt is the authorization source. Removing it simulates a persistence
		// failure after dispatch; the in-memory route must not rescue the call.
		fs.rmSync(routeReceiptPathForTask(directory, 'parent-2491', '1.1'), {
			force: true,
		});
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent-2491',
				callID: 'review-call-1',
				args: { subagent_type: 'reviewer', task_id: '1.1' },
			},
			{ text: '[REVIEWED] | task-1.1 | APPROVED | looks good' },
		);

		const session = swarmState.agentSessions.get('parent-2491')!;
		expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.gates.reviewer).toBeUndefined();
	});
});
