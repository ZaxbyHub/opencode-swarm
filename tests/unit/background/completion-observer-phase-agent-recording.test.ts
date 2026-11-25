/**
 * Background completion observer → in-memory phase-agent recording.
 *
 * Foreground Task dispatches register the dispatched role on the child
 * session through the delegation tracker (chat.message). A background child
 * never flows through those hooks, so with `hooks.background_subagents`
 * enabled every Stage B dispatch left the phase-aggregation surface empty and
 * phase_complete reported REQUIRED_AGENTS_MISSING with agentsDispatched: []
 * although the roles demonstrably ran (the 2026-11-23
 * swarm_communication_debug pattern). The observer's verified-success
 * closeout now records the completed role on the dispatching parent session
 * — the same surface recordPhaseAgentDispatch writes for foreground runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const FIXED_RECORD_TIMESTAMP_MS = 1_700_000_000_000;

function writePlan(directory: string): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Background Phase Recording',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				required_agents: ['coder', 'reviewer', 'test_engineer'],
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Implement feature',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	return plan;
}

function completionEvent(
	childSessionId: string,
	state: 'completed' | 'cancelled',
	text: string,
) {
	const body =
		state === 'completed'
			? `<task_result>${text}</task_result>`
			: '<task_error>cancelled</task_error>';
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: 'parent',
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function recordDelegation(
	directory: string,
	options: {
		correlationId: string;
		normalizedAgent: string;
		swarmPrefixedAgent: string;
	},
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: options.correlationId,
		jobId: null,
		subagentSessionId: options.correlationId,
		parentSessionId: 'parent',
		callID: `call-${options.correlationId}`,
		normalizedAgent: options.normalizedAgent,
		swarmPrefixedAgent: options.swarmPrefixedAgent,
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		workflowGeneration: 1,
		status: 'pending',
		createdAt: FIXED_RECORD_TIMESTAMP_MS,
		updatedAt: FIXED_RECORD_TIMESTAMP_MS,
		workspace: captureWorkspaceSnapshot(directory),
	});
}

describe('background completion observer phase-agent recording', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('bg-phase-recording-'));
		writePlan(directory);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('verified reviewer completion records the normalized role on the parent session', async () => {
		ensureAgentSession('parent');
		await seedStageAPassed(directory, '1.1');
		await recordDelegation(directory, {
			correlationId: 'reviewer-child',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'astra_reviewer',
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'reviewer-child',
				'completed',
				'[REVIEWED] | 1.1 | APPROVED | no issues\nVERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none',
			),
		);

		expect(findByCorrelationId(directory, 'reviewer-child')?.status).toBe(
			'consumed',
		);
		const dispatched =
			swarmState.agentSessions.get('parent')?.phaseAgentsDispatched ??
			new Set<string>();
		// The prefixed agent name is normalized to the bare role.
		expect(dispatched.has('reviewer')).toBe(true);
	});

	test('a cancelled delegation records no phase participation', async () => {
		ensureAgentSession('parent');
		await seedStageAPassed(directory, '1.1');
		await recordDelegation(directory, {
			correlationId: 'test-child',
			normalizedAgent: 'test_engineer',
			swarmPrefixedAgent: 'astra_test_engineer',
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completionEvent('test-child', 'cancelled', ''));

		expect(findByCorrelationId(directory, 'test-child')?.status).toBe(
			'cancelled',
		);
		const dispatched =
			swarmState.agentSessions.get('parent')?.phaseAgentsDispatched ??
			new Set<string>();
		expect(dispatched.has('test_engineer')).toBe(false);
	});

	test('no parent session in memory is a safe no-op (post-restart replay shape)', async () => {
		// The parent session is not live in agentSessions (restart wiped it):
		// the recording must not resurrect a session or throw.
		await seedStageAPassed(directory, '1.1');
		await recordDelegation(directory, {
			correlationId: 'coder-child',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'astra_coder',
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'coder-child',
				'completed',
				'IMPLEMENTED: change delivered. [CODED] | task-1.1 | DONE |',
			),
		);

		expect(swarmState.agentSessions.has('parent')).toBe(false);
	});
});
