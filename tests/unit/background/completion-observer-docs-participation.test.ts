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
	observePhaseParticipationToolResult,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const FIXED_RECORD_TIMESTAMP_MS = 1_700_000_000_000;

function writePlan(directory: string): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Docs Background Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Docs',
				status: 'in_progress',
				required_agents: ['docs'],
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Update docs',
						depends: [],
						files_touched: ['docs/guide.md'],
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

function backgroundRunningOutput(childSessionId: string): object {
	return {
		output: `<task id="${childSessionId}" state="running"><summary>running</summary></task>`,
		metadata: {
			background: true,
			status: 'running',
			jobId: `job-${childSessionId}`,
		},
	};
}

function completionEvent(
	childSessionId: string,
	state: 'completed' | 'cancelled',
) {
	const body =
		state === 'completed'
			? '<task_result>Documentation updated.</task_result>'
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

describe('background completion observer docs participation', () => {
	let directory: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('bg-docs-participation-'));
		plan = writePlan(directory);
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	test('trusted docs completion writes durable participation proof through the observer', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'docs-call',
			args: { subagent_type: 'docs', prompt: 'TASK: 1.1\nUpdate docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'docs-call',
			output: backgroundRunningOutput('docs-child'),
		});
		await recordPendingDelegation(directory, {
			correlationId: 'docs-child',
			jobId: 'job-docs-child',
			subagentSessionId: 'docs-child',
			parentSessionId: 'parent',
			callID: 'docs-call',
			normalizedAgent: 'docs',
			swarmPrefixedAgent: 'docs',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: 0,
			status: 'pending',
			createdAt: FIXED_RECORD_TIMESTAMP_MS,
			updatedAt: FIXED_RECORD_TIMESTAMP_MS,
			workspace: captureWorkspaceSnapshot(directory),
			ingestion: {
				state: 'consumed',
				attempt: 1,
				claimToken: 'consumed-claim',
				claimedAt: FIXED_RECORD_TIMESTAMP_MS,
				updatedAt: FIXED_RECORD_TIMESTAMP_MS,
			},
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completionEvent('docs-child', 'completed'));

		expect(findByCorrelationId(directory, 'docs-child')?.status).toBe(
			'consumed',
		);
		expect(readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});

	test('cancelled docs completion is terminal but cannot create durable participation proof', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'docs-call',
			args: { subagent_type: 'docs', prompt: 'TASK: 1.1\nUpdate docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'docs-call',
			output: backgroundRunningOutput('docs-child'),
		});
		await recordPendingDelegation(directory, {
			correlationId: 'docs-child',
			jobId: 'job-docs-child',
			subagentSessionId: 'docs-child',
			parentSessionId: 'parent',
			callID: 'docs-call',
			normalizedAgent: 'docs',
			swarmPrefixedAgent: 'docs',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: 0,
			status: 'pending',
			createdAt: FIXED_RECORD_TIMESTAMP_MS,
			updatedAt: FIXED_RECORD_TIMESTAMP_MS,
			workspace: captureWorkspaceSnapshot(directory),
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completionEvent('docs-child', 'cancelled'));

		expect(findByCorrelationId(directory, 'docs-child')?.status).toBe(
			'cancelled',
		);
		expect(readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: false,
		});
	});
});
