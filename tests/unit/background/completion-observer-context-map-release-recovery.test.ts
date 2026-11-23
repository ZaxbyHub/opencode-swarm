/**
 * r15 audit follow-up (P3): a context-map task-release promotion lost to a
 * best-effort write failure must be recoverable from the AUTHORITATIVE
 * durable state alone.
 *
 * `promoteContextMapTaskRelease` swallows all errors (by contract — the
 * authoritative task release in the plan must never be rolled back), and its
 * caller in update_task_status swallows them too. Before this repair, a
 * failed promotion left the context map 'pending' FOREVER: the child closeout
 * steps were already completed, so no closeout replay re-drove the promotion,
 * and nothing else reconstructed it.
 *
 * The repair adds an idempotent reconciliation
 * (reconcileContextMapTaskReleases) at the existing maintenance points
 * (observer maintenance pass, /swarm status, post-init). It re-derives the
 * promotion from plan status + recorded QA-gate evidence — fail-closed, the
 * plan stays authoritative, terminal 'rejected' verdicts stay untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import {
	_internals as postAgentInternals,
	reconcileContextMapTaskReleases,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r15p3_parent';

function writePlan(directory: string, taskStatus = 'pending'): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'P3 Release Recovery Plan',
		swarm: 'p3-recovery',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: taskStatus as Plan['phases'][0]['tasks'][0]['status'],
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Unrelated work',
						depends: [],
						files_touched: ['src/b.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
}

function completionEvent(childSessionId: string, body: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function seedGate(
	directory: string,
	taskId: string,
	childSessionId: string,
	agent: 'reviewer' | 'test_engineer',
): Promise<void> {
	await seedGates(directory, taskId, [{ agent, childSessionId }]);
}

async function seedGates(
	directory: string,
	taskId: string,
	gates: Array<{
		agent: 'reviewer' | 'test_engineer';
		childSessionId: string;
	}>,
): Promise<void> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	// Seed Stage A ONCE per task: a second accepted-mutation dispatch would
	// advance the workflow generation and stale the first delegation's binding.
	const generation = await seedStageAPassed(directory, taskId);
	for (const gate of gates) {
		await recordPendingDelegation(directory, {
			correlationId: gate.childSessionId,
			jobId: `job-${gate.childSessionId}`,
			subagentSessionId: gate.childSessionId,
			parentSessionId: PARENT,
			callID: `call-${gate.childSessionId}`,
			normalizedAgent: gate.agent,
			swarmPrefixedAgent: gate.agent,
			planTaskId: taskId,
			evidenceTaskId: taskId,
			workflowGeneration: generation,
			workspace: captureWorkspaceSnapshot(directory),
		});
	}
}

function seedEntry(
	directory: string,
	taskId: string,
	final_status: 'pending' | 'approved' | 'rejected',
): void {
	const map = loadContextMap(directory) ?? createEmptyContextMap();
	saveContextMap(
		appendTaskHistory(map, {
			task_id: taskId,
			goal: '',
			files_touched: [],
			implementation_summary: 'OLD',
			final_status,
		}),
		directory,
	);
}

describe('background completion observer — context-map release promotion recovery (r15 P3)', () => {
	let directory: string;
	let cleanup: () => void;
	let origSave: typeof postAgentInternals.saveContextMap;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-ctxmap-promo-'));
		writePlan(directory);
		origSave = postAgentInternals.saveContextMap;
	});

	afterEach(() => {
		postAgentInternals.saveContextMap = origSave;
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('a promotion lost to a save failure is recovered by a later observer maintenance pass', async () => {
		// Both QA gates for task 1.1 complete through the observer — the
		// context-map entries stay non-final 'pending' by design (r14 P1-5).
		await seedGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_r15p3_rev' },
			{ agent: 'test_engineer', childSessionId: 'ses_r15p3_te' },
		]);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_r15p3_rev',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		await observer.event(
			completionEvent(
				'ses_r15p3_te',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'pending',
		);

		// The authoritative release succeeds, but the context-map promotion
		// write fails (suppressed inside promoteContextMapTaskRelease).
		postAgentInternals.saveContextMap = () => {
			throw new Error('injected disk full');
		};
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
		);
		// The release itself stays authoritative and successful.
		expect(result.success).toBe(true);
		expect(result.new_status).toBe('completed');
		// ...but the context map is still 'pending' — the promotion was lost.
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'pending',
		);
		postAgentInternals.saveContextMap = origSave;

		// "Restart": a fresh observer instance processes an UNRELATED
		// completion; its maintenance pass must reconcile the lost promotion
		// from the durable plan status + gate evidence.
		await seedGate(directory, '1.2', 'ses_r15p3_other', 'reviewer');
		const restarted = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await restarted.event(
			completionEvent(
				'ses_r15p3_other',
				'<task_result>[REVIEWED] | 1.2 | APPROVED | fine</task_result>',
			),
		);
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'approved',
		);
		// The unrelated task's own entry stays non-final (it is not released).
		expect(loadContextMap(directory)?.task_history['1.2']?.final_status).toBe(
			'pending',
		);
	});

	test('no promotion without full QA proof: an unproven release stays pending', async () => {
		// Only the reviewer gate completed; the test-engineer gate is missing.
		// The plan CLAIMS completion (e.g. written directly), but the
		// reconciliation must fail closed on the missing gate evidence.
		await seedGate(directory, '1.1', 'ses_r15p3_rev2', 'reviewer');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_r15p3_rev2',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		writePlan(directory, 'completed');
		seedEntry(directory, '1.1', 'pending');

		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'pending',
		);
	});

	test('a terminal rejected verdict survives reconciliation; repeated runs never duplicate entries', async () => {
		// Full QA proof and a completed plan, but the context map carries a
		// terminal negative verdict — the negative-protection guard holds
		// (r15: the context-map model has no generation identity, so the
		// guard is deliberately NOT weakened).
		await seedGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_r15p3_rev3' },
			{ agent: 'test_engineer', childSessionId: 'ses_r15p3_te3' },
		]);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_r15p3_rev3',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		await observer.event(
			completionEvent(
				'ses_r15p3_te3',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
		);
		expect(result.success).toBe(true);
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'approved',
		);

		// Overwrite with a terminal rejected verdict (the guarded state).
		seedEntry(directory, '1.1', 'rejected');
		await reconcileContextMapTaskReleases(directory);
		await reconcileContextMapTaskReleases(directory);
		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']?.final_status).toBe('rejected');
		// Idempotent upsert: exactly one entry per task id.
		expect(Object.keys(map?.task_history ?? {})).toEqual(['1.1']);
	});
});
