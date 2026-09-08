import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundDelegationRecord,
	BackgroundWorkspaceSnapshot,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	ingestBackgroundStageBCompletion,
} from '../../../src/background/stage-b-gates.js';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot.js';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import {
	advanceTaskState,
	getStageBRouteEvidence,
	getTaskState,
	markStageBRouteRequired,
	recordStageBRouteEvidence,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function stageBRecord(
	taskId: string,
	role: 'reviewer' | 'test_engineer',
	callID: string,
	childSessionId: string,
	workspace: BackgroundWorkspaceSnapshot,
	generation = 1,
): BackgroundDelegationRecord {
	return {
		schemaVersion: 2,
		correlationId: `${callID}:correlation`,
		jobId: `${callID}:job`,
		subagentSessionId: childSessionId,
		parentSessionId: 'parent-2491',
		callID,
		normalizedAgent: role,
		swarmPrefixedAgent: role,
		planTaskId: taskId,
		evidenceTaskId: taskId,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		completedAt: 2,
		workflowGeneration: generation,
		workspace,
	};
}

async function prepareTask(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${taskId}`,
	});
	const session = swarmState.agentSessions.get('parent-2491')!;
	markStageBRouteRequired(session, taskId);
	advanceTaskState(session, taskId, 'coder_delegated');
	advanceTaskState(session, taskId, 'pre_check_passed');
}

async function ingest(
	taskId: string,
	role: 'reviewer' | 'test_engineer',
	callID: string,
	childSessionId: string,
): Promise<Awaited<ReturnType<typeof ingestBackgroundStageBCompletion>>> {
	const resultText =
		role === 'reviewer'
			? `[REVIEWED] | task-${taskId} | APPROVED | route accepted`
			: `[TESTED] | task-${taskId} | PASS | route accepted`;
	return ingestBackgroundStageBCompletion({
		directory,
		record: stageBRecord(
			taskId,
			role,
			callID,
			childSessionId,
			captureWorkspaceSnapshot(directory),
		),
		result: {
			text: resultText,
			chars: resultText.length,
			truncated: false,
			digest: `${callID}:digest`,
		},
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('issue-2491-stage-b-route-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	git('init');
	git('config', 'user.email', 'tests@example.com');
	git('config', 'user.name', 'Tests');
	fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
	git('add', 'base.txt');
	git('commit', '-m', 'test: route fixture');
	startAgentSession('parent-2491', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('background Stage-B route slots (issue #2491)', () => {
	test('two same-role dispatches consume distinct slots and retry replaces only its slot', async () => {
		const taskId = '1.1';
		const session = swarmState.agentSessions.get('parent-2491')!;
		await persistReviewRouteReceipt({
			projectRoot: directory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-2491',
				taskId,
				complexity: 'high',
				semanticRisk: 'cross_cutting',
				requiredReviewers: ['reviewer-a', 'reviewer-b'],
				requiredTestEngineers: [],
			}),
		});

		const resolve = (callId: string, childSessionId: string) =>
			_test_exports.resolveBackgroundStageBRoute({
				directory,
				taskId,
				parentSessionId: 'parent-2491',
				role: 'reviewer',
				callId,
				childSessionId,
				generation: 1,
				session,
			});

		markStageBRouteRequired(session, taskId);
		const first = resolve('review-call-a', 'review-child-a');
		expect(first.binding).toMatchObject({
			identity: 'reviewer-a',
			slotId: '1.1:reviewer:1',
		});
		recordStageBRouteEvidence(session, taskId, first.binding!);

		const second = resolve('review-call-b', 'review-child-b');
		expect(second.binding).toMatchObject({
			identity: 'reviewer-b',
			slotId: '1.1:reviewer:2',
		});
		recordStageBRouteEvidence(session, taskId, second.binding!);

		const retry = resolve('review-call-a', 'review-child-a');
		expect(retry.binding).toMatchObject({
			identity: 'reviewer-a',
			slotId: '1.1:reviewer:1',
		});
		expect(retry.prospective).toHaveLength(2);
		expect(
			retry.prospective.filter((entry) => entry.role === 'reviewer'),
		).toEqual([
			{
				role: 'reviewer',
				identity: 'reviewer-a',
				sessionId: 'parent-2491',
				taskId,
				slotId: '1.1:reviewer:1',
				callId: 'review-call-a',
				childSessionId: 'review-child-a',
				generation: 1,
			},
			{
				role: 'reviewer',
				identity: 'reviewer-b',
				sessionId: 'parent-2491',
				taskId,
				slotId: '1.1:reviewer:2',
				callId: 'review-call-b',
				childSessionId: 'review-child-b',
				generation: 1,
			},
		]);
		expect(getStageBRouteEvidence(session, taskId)).toHaveLength(2);
	});

	test('a marked task with a missing receipt rejects before publishing gate evidence', async () => {
		const taskId = '1.2';
		const session = swarmState.agentSessions.get('parent-2491')!;
		markStageBRouteRequired(session, taskId);
		advanceTaskState(session, taskId, 'coder_delegated');
		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: stageBRecord(
				taskId,
				'reviewer',
				'review-call-missing',
				'review-child-missing',
				captureWorkspaceSnapshot(directory),
			),
			result: {
				text: `[REVIEWED] | task-${taskId} | APPROVED | route missing`,
				chars: 60,
				truncated: false,
				digest: 'missing-route',
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('ROUTE_RECEIPT_MISSING');
		expect(await readTaskEvidence(directory, taskId)).toBeNull();
	});

	test('live 1+1 completion records each tuple before advancing', async () => {
		const taskId = '1.3';
		await prepareTask(taskId);
		await persistReviewRouteReceipt({
			projectRoot: directory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-2491',
				taskId,
				complexity: 'standard',
				semanticRisk: 'routine',
				requiredReviewers: ['reviewer-a'],
				requiredTestEngineers: ['test-a'],
			}),
		});

		expect(
			await ingest(taskId, 'reviewer', 'review-call-1', 'review-child-1'),
		).toMatchObject({ ok: true });
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, taskId),
		).toBe('reviewer_run');
		expect(
			await ingest(taskId, 'test_engineer', 'test-call-1', 'test-child-1'),
		).toMatchObject({ ok: true });
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, taskId),
		).toBe('tests_run');
		expect(
			getStageBRouteEvidence(
				swarmState.agentSessions.get('parent-2491')!,
				taskId,
			),
		).toHaveLength(2);
	});

	test('live reversed 2+2 completion order waits for every route slot', async () => {
		const taskId = '1.4';
		await prepareTask(taskId);
		await persistReviewRouteReceipt({
			projectRoot: directory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-2491',
				taskId,
				complexity: 'double',
				semanticRisk: 'high',
				requiredReviewers: ['reviewer-a', 'reviewer-b'],
				requiredTestEngineers: ['test-a', 'test-b'],
			}),
		});

		await ingest(taskId, 'test_engineer', 'test-call-1', 'test-child-1');
		await ingest(taskId, 'test_engineer', 'test-call-1', 'test-child-1');
		expect(
			getStageBRouteEvidence(
				swarmState.agentSessions.get('parent-2491')!,
				taskId,
			),
		).toHaveLength(1);
		await ingest(taskId, 'reviewer', 'review-call-1', 'review-child-1');
		await ingest(taskId, 'test_engineer', 'test-call-2', 'test-child-2');
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, taskId),
		).toBe('reviewer_run');
		await ingest(taskId, 'reviewer', 'review-call-2', 'review-child-2');
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, taskId),
		).toBe('tests_run');
		expect(
			getStageBRouteEvidence(
				swarmState.agentSessions.get('parent-2491')!,
				taskId,
			),
		).toHaveLength(4);
	});
});
