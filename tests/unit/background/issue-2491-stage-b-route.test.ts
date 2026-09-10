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
import { readTaskGateRequirementsReceipts } from '../../../src/evidence/task-gate-requirements.js';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
	routeReceiptPathForTask,
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
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

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
	isolatedEnv = createIsolatedTestEnv();
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
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
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

	test('fails closed instead of silently dropping the 33rd route binding (FB-027)', () => {
		const taskId = '1.3';
		const session = swarmState.agentSessions.get('parent-2491')!;
		for (let index = 0; index < 32; index += 1) {
			expect(
				recordStageBRouteEvidence(session, taskId, {
					role: 'reviewer',
					identity: `reviewer-${index}`,
					sessionId: 'parent-2491',
					taskId,
					slotId: `${taskId}:reviewer:${index + 1}`,
					callId: `review-call-${index}`,
					childSessionId: `review-child-${index}`,
					generation: 1,
				}),
			).toBe(true);
		}
		expect(
			recordStageBRouteEvidence(session, taskId, {
				role: 'reviewer',
				identity: 'reviewer-overflow',
				sessionId: 'parent-2491',
				taskId,
				slotId: `${taskId}:reviewer:33`,
				callId: 'review-call-overflow',
				childSessionId: 'review-child-overflow',
				generation: 1,
			}),
		).toBe(false);
		expect(getStageBRouteEvidence(session, taskId)).toHaveLength(32);
	});

	test('capacity rejection happens before durable gate evidence publication (NEW-001)', async () => {
		const taskId = '1.30';
		await prepareTask(taskId);
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ review_routing: { enforce_receipts: false } }),
		);
		await persistReviewRouteReceipt({
			projectRoot: directory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-2491',
				taskId,
				complexity: 'single',
				semanticRisk: 'low',
				requiredReviewers: ['reviewer-1'],
				requiredTestEngineers: [],
			}),
		});
		const session = swarmState.agentSessions.get('parent-2491')!;
		for (let index = 0; index < 32; index += 1) {
			recordStageBRouteEvidence(session, taskId, {
				role: 'reviewer',
				identity: `stale-reviewer-${index + 1}`,
				sessionId: 'parent-2491',
				taskId,
				slotId: `${taskId}:stale:${index + 1}`,
				callId: `review-call-${index}`,
				childSessionId: `review-child-${index}`,
				generation: 1,
			});
		}

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: stageBRecord(
				taskId,
				'reviewer',
				'review-call-overflow',
				'review-child-overflow',
				captureWorkspaceSnapshot(directory),
			),
			result: {
				text: `[REVIEWED] | task-${taskId} | APPROVED | overflow check`,
				chars: 64,
				truncated: false,
				digest: 'overflow-route',
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('capacity exceeded');
		const evidence = await readTaskEvidence(directory, taskId);
		expect(evidence?.gates.reviewer).toBeUndefined();
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

	test('parent-unavailable recovery rejects an unauthenticated router error (F-006)', async () => {
		const taskId = '1.25';
		const receiptPath = routeReceiptPathForTask(
			directory,
			'parent-2491',
			taskId,
		);
		fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
		// Previous code accepted this readable router-error marker when the parent
		// session had disappeared, even though it could not bind recovery to the
		// exact session/task that was being resumed.
		fs.writeFileSync(
			receiptPath,
			JSON.stringify({
				kind: 'review_route_router_error',
				version: 1,
				code: 'ROUTER_FAILED',
				failOpen: true,
			}),
			'utf8',
		);
		resetSwarmState();

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: stageBRecord(
				taskId,
				'reviewer',
				'recovery-call',
				'recovery-child',
				captureWorkspaceSnapshot(directory),
			),
			result: {
				text: `[REVIEWED] | task-${taskId} | APPROVED | recovery check`,
				chars: 60,
				truncated: false,
				digest: 'recovery-digest',
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('ROUTE_RECEIPT_AUTH_INVALID');
		expect(await readTaskEvidence(directory, taskId)).toBeNull();
	});

	test('live 1+1 completion records each tuple before advancing (F-008)', async () => {
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

		const reviewerResult = await ingest(
			taskId,
			'reviewer',
			'review-call-1',
			'review-child-1',
		);
		expect(reviewerResult).toMatchObject({ ok: true });
		// Previous tests stopped at in-memory route counts. Verify the durable
		// task-gate receipt records the exact reviewer binding before advancing.
		const reviewerReceipts = await readTaskGateRequirementsReceipts(
			directory,
			taskId,
		);
		expect(reviewerReceipts.at(-1)?.routeBinding).toMatchObject({
			role: 'reviewer',
			identity: 'reviewer-a',
			callId: 'review-call-1',
			childSessionId: 'review-child-1',
			generation: 1,
		});
		expect(
			getTaskState(swarmState.agentSessions.get('parent-2491')!, taskId),
		).toBe('reviewer_run');
		const testEngineerResult = await ingest(
			taskId,
			'test_engineer',
			'test-call-1',
			'test-child-1',
		);
		expect(testEngineerResult).toMatchObject({ ok: true });
		const durableReceipts = await readTaskGateRequirementsReceipts(
			directory,
			taskId,
		);
		expect(durableReceipts.at(-1)?.routeBinding).toMatchObject({
			role: 'test_engineer',
			identity: 'test-a',
			callId: 'test-call-1',
			childSessionId: 'test-child-1',
			generation: 1,
		});
		// `routeComplete: true` is represented durably by the exact-task workflow
		// reaching tests_run after the second bound route tuple is recorded.
		const durableTaskEvidence = await readTaskEvidence(directory, taskId);
		expect(durableTaskEvidence?.workflow?.state).toBe('tests_run');
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
