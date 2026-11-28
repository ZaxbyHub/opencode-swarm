import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimTerminalResult,
	findLatestSettledCoderFilesForTask,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { PluginConfig } from '../../../src/config';
import {
	createDelegationGateHook,
	_internals as gateInternals,
} from '../../../src/hooks/delegation-gate';
import { readReviewRouteReceiptSync } from '../../../src/review/routing-enforcement';
import {
	ensureAgentSession,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * 2026-11-24 swarm_communication_debug agent-gate wedge: a host restart wipes
 * the parent session's in-memory per-task file attribution, so every
 * post-restart reviewer/test-engineer dispatch routed NO_CHANGED_FILES and its
 * fail-open review_route_router_error receipt was terminally refused at the
 * completion-side enforcement boundary — the gate receipt never landed and the
 * workflow rotated stage_b_failed (6 lost reviewer receipts across 3 server
 * instances; the pre-restart 2.19 dispatch with a live in-memory map is the
 * working counterexample). The dispatch-time router now falls back to the
 * latest SETTLED coder settlement's observedFiles — the durable executed
 * contract — fail-closed on an uncertain store.
 */

const REAL_FIND_LATEST = gateInternals.findLatestSettledCoderFilesForTask;

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
let dir: string;
let cleanupDir: (() => void) | undefined;

beforeEach(() => {
	// The route-receipt MAC secret lives under the platform data root
	// (~/.local/share/opencode/review-route-receipts.key); the prod-store
	// tripwire (#2033) blocks tests from touching the real platform store, so
	// the env must be isolated for the receipts to be writable/readable.
	isolatedEnv = createIsolatedTestEnv();
	const safe = createSafeTestDir('swarm-route-durable-fallback-');
	dir = safe.dir;
	cleanupDir = safe.cleanup;
	resetSwarmState();
});

afterEach(() => {
	gateInternals.findLatestSettledCoderFilesForTask = REAL_FIND_LATEST;
	resetSwarmState();
	cleanupDir?.();
	cleanupDir = undefined;
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

async function settleCoderLeg(input: {
	correlationId: string;
	taskId: string;
	files: string[];
	parentSessionId?: string;
}): Promise<void> {
	const parentSessionId = input.parentSessionId ?? 'parent';
	const baseline = captureWorkspaceSnapshot(dir);
	await recordPendingDelegation(dir, {
		correlationId: input.correlationId,
		jobId: null,
		subagentSessionId: input.correlationId,
		parentSessionId,
		callID: `call-${input.correlationId}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: input.taskId,
		evidenceTaskId: input.taskId,
		workspace: baseline,
		taskChangeContext: {
			declaredFiles: input.files,
			baseline,
		},
	});
	const resultDigest = createHash('sha256')
		.update(`coder leg ${input.correlationId}`)
		.digest('hex');
	const eventId = buildBackgroundCompletionEventId({
		correlationId: input.correlationId,
		jobId: null,
		status: 'completed',
		resultDigest,
	});
	await claimTerminalResult(dir, input.correlationId, {
		eventId,
		status: 'completed',
		recordedAt: 1,
		result: {
			text: `coder leg ${input.correlationId}`,
			chars: 10,
			truncated: false,
			digest: resultDigest,
		},
	});
	await claimCoderSettlement(dir, input.correlationId, eventId);
	await updateCoderSettlement(dir, input.correlationId, {
		operationId: eventId,
		state: 'settled',
		observedFiles: input.files,
		outcome: { kind: 'shared-root', result: 'ready' },
	});
}

function hook() {
	return createDelegationGateHook(
		{
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
			hooks: { delegation_gate: true },
		} as PluginConfig,
		dir,
	);
}

async function dispatchReviewer(taskId: string, callID: string): Promise<void> {
	const session = ensureAgentSession('parent', 'architect', dir);
	await Promise.allSettled([...swarmState.pendingRehydrations]);
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	session.currentTaskId = taskId;
	const gate = hook();
	try {
		await gate.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID },
			{
				args: {
					subagent_type: 'reviewer',
					task_id: taskId,
					prompt: `TASK: ${taskId}\nACCEPTANCE: review the exact changed files`,
				},
			},
		);
	} catch {
		// Later reviewer gates (scope binding, settlement fences) are outside
		// this routing assertion — the route receipt is written first.
	}
}

function receiptOf(taskId: string) {
	return readReviewRouteReceiptSync({
		projectRoot: dir,
		sessionId: 'parent',
		taskId,
	});
}

describe('findLatestSettledCoderFilesForTask (durable executed contract)', () => {
	test('returns the latest settled coder leg observed files for the task', async () => {
		await settleCoderLeg({
			correlationId: 'leg-a',
			taskId: '1.1',
			files: ['src/old-a.ts'],
		});
		await settleCoderLeg({
			correlationId: 'leg-b',
			taskId: '1.1',
			files: ['src/new-b.ts', 'src/new-c.ts'],
		});
		const outcome = findLatestSettledCoderFilesForTask(dir, '1.1');
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok') return;
		expect(outcome.files.sort()).toEqual(['src/new-b.ts', 'src/new-c.ts']);
	});

	test('mirrors the in-memory replace semantics: a settled no-mutation leg empties the result', async () => {
		await settleCoderLeg({
			correlationId: 'leg-a',
			taskId: '1.2',
			files: ['src/real.ts'],
		});
		await settleCoderLeg({
			correlationId: 'leg-b',
			taskId: '1.2',
			files: [],
		});
		const outcome = findLatestSettledCoderFilesForTask(dir, '1.2');
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok') return;
		expect(outcome.files).toEqual([]);
	});

	test('ignores reviewer records and settled coders of other tasks', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'reviewer-child',
			jobId: null,
			subagentSessionId: 'reviewer-child',
			parentSessionId: 'parent',
			callID: 'call-reviewer',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.3',
			evidenceTaskId: '1.3',
		});
		await settleCoderLeg({
			correlationId: 'other-task-leg',
			taskId: '9.9',
			files: ['src/other.ts'],
		});
		const outcome = findLatestSettledCoderFilesForTask(dir, '1.3');
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok') return;
		expect(outcome.files).toEqual([]);
	});
});

describe('review routing durable fallback at dispatch (agent-gate wedge)', () => {
	test('post-restart shape (empty in-memory) + settled coder leg routes a REAL receipt, not the router error', async () => {
		await settleCoderLeg({
			correlationId: 'leg-2.20',
			taskId: '2.20',
			files: ['doc/report/a.md', 'src/feature.ts'],
		});
		// Deliberately NO recordModifiedFilesForTask: the post-restart
		// in-memory attribution is empty — the exact wedge shape.
		await dispatchReviewer('2.20', 'rv-wedge');

		const receipt = receiptOf('2.20');
		expect(receipt?.kind).toBe('review_route_receipt');
		expect(receipt?.kind).not.toBe('review_route_router_error');
	});

	test('a live in-memory attribution still wins — the durable store is not consulted for files', async () => {
		await settleCoderLeg({
			correlationId: 'leg-3.1',
			taskId: '3.1',
			files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
		});
		const session = ensureAgentSession('parent', 'architect', dir);
		session.currentTaskId = '3.1';
		// The live map holds ONE file; the seam would answer with a sentinel
		// list if it were consulted.
		recordModifiedFilesForTask(session, '3.1', ['src/live.ts']);
		gateInternals.findLatestSettledCoderFilesForTask = () => ({
			status: 'ok',
			files: ['SENTINEL-NEVER-USED.ts'],
		});
		await dispatchReviewer('3.1', 'rv-live');

		const receipt = receiptOf('3.1');
		expect(receipt?.kind).toBe('review_route_receipt');
		if (receipt?.kind !== 'review_route_receipt') return;
		expect(receipt.semanticRisk).toContain('1 files');
	});

	test('empty in-memory + no settled coder leg keeps the pointed NO_CHANGED_FILES refusal', async () => {
		await dispatchReviewer('4.4', 'rv-nosettle');

		const receipt = receiptOf('4.4');
		expect(receipt?.kind).toBe('review_route_router_error');
		if (receipt?.kind !== 'review_route_router_error') return;
		expect(receipt.code).toBe('NO_CHANGED_FILES');
		expect(receipt.failOpen).toBe(true);
	});

	test('an uncertain store fails closed to the NO_CHANGED_FILES refusal (files are never invented)', async () => {
		gateInternals.findLatestSettledCoderFilesForTask = () => ({
			status: 'uncertain',
		});
		await dispatchReviewer('5.5', 'rv-uncertain');

		const receipt = receiptOf('5.5');
		expect(receipt?.kind).toBe('review_route_router_error');
		if (receipt?.kind !== 'review_route_router_error') return;
		expect(receipt.code).toBe('NO_CHANGED_FILES');
	});
});
