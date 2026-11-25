/**
 * Regression (Wirtschaftssimulation 2026-11-25, task 2.20 Gen 8/9 — the
 * post-catch-22 accumulation wedge): after the tests_run required-gate
 * counting fix, a task that legitimately re-settles the SAME gate identity
 * twice in one serve instance (recover_* opening → re-dispatch, no restart
 * and no completion clearing the session in between) poisoned the in-memory
 * Stage-B route evidence: the second settlement APPENDED a second entry for
 * the same route identity, and every later Stage-B completion of the task
 * was then terminally consumed with outcome "rejected"
 * (ROUTE_RECEIPT_DUPLICATE) — the gate could never bind and tests_run was
 * unreachable, while fresh tasks with single-dispatch gates (2.24/2.25/2.26)
 * completed normally.
 *
 * The fix: reserveStageBRouteEvidence replaces the existing entry for the
 * same (role, identity) instead of appending — the one-entry-per-identity
 * invariant the durable requirements chain already enforces on read and
 * enforceReviewRouteReceipt's duplicate check requires.
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (never the developer's real app-data).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	readTaskGateRequirementsReceiptsSync,
	routeEvidenceFromTaskGateRequirements,
} from '../../../src/evidence/task-gate-requirements';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { ensureSessionDrained } from '../hooks/_session-rehydration-drain';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function stageBRecord(
	taskId: string,
	agent: 'reviewer' | 'test_engineer',
	callID: string,
	childSessionId: string,
	workspace: ReturnType<typeof captureWorkspaceSnapshot>,
	generation: number,
): BackgroundDelegationRecord {
	return {
		schemaVersion: 1,
		correlationId: `${agent}-${taskId}-${callID}`,
		jobId: null,
		subagentSessionId: childSessionId,
		parentSessionId: 'parent-session',
		callID,
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: taskId,
		evidenceTaskId: taskId,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		workspace,
		workflowGeneration: generation,
	};
}

const approvedVerdict = (taskId: string) => ({
	text: `[REVIEWED] | task-${taskId} | APPROVED | docs are correct`,
	chars: 54,
	truncated: false,
	digest: 'reviewer',
});

const passVerdict = (taskId: string) => ({
	text: `[TESTED] | task-${taskId} | PASS | 3/3 runs exact`,
	chars: 44,
	truncated: false,
	digest: 'test-engineer',
});

let testDirectory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

describe('background Stage-B same-identity re-settlement (accumulation wedge)', () => {
	beforeEach(() => {
		testDirectory = canonicalMkdtemp('sb-accumulation-wedge-');
		isolatedEnv = createIsolatedTestEnv();
		git(testDirectory, ['init']);
		git(testDirectory, ['config', 'user.email', 'tests@example.com']);
		git(testDirectory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(`${testDirectory}/AGENTS.md`, '# Test\n');
		git(testDirectory, ['add', 'AGENTS.md']);
		git(testDirectory, ['commit', '-m', 'test: seed repository']);
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(testDirectory, { recursive: true, force: true });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	/**
	 * Seeds a coder task at pre_check_passed with the default Stage-B pair
	 * required and a single reviewer + single test-engineer slot receipt —
	 * the task-2.20 shape (minus the sounding-board gate, which plays no
	 * role in the route mechanics).
	 */
	async function seedTaskAtPreCheck(taskId: string): Promise<void> {
		await ensureSessionDrained('parent-session', testDirectory);
		startAgentSession('parent-session', 'architect', testDirectory);
		await transitionTaskWorkflowEvidence(testDirectory, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `mut:${taskId}`,
		});
		await transitionTaskWorkflowEvidence(testDirectory, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `stage-a:${taskId}`,
		});
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-session',
				taskId,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: [`${taskId}:reviewer:1`],
				requiredTestEngineers: [`${taskId}:test_engineer:1`],
			}),
		});
	}

	test('regression: a second same-identity reviewer settlement must not poison the route evidence for the test_engineer completion', async () => {
		const taskId = '2.9';
		await seedTaskAtPreCheck(taskId);
		const workspace = captureWorkspaceSnapshot(testDirectory);

		// First reviewer settlement (the fix-test dispatch).
		const first = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: stageBRecord(
				taskId,
				'reviewer',
				'call-r1',
				'child-r1',
				workspace,
				1,
			),
			result: approvedVerdict(taskId),
		});
		expect(first.ok).toBe(true);
		expect(first.consumed).toBe(true);
		expect(
			(await readTaskEvidence(testDirectory, taskId))?.workflow.state,
		).toBe('reviewer_run');

		// The recover_* re-dispatch shape: a SECOND reviewer settlement of
		// the same gate identity in the SAME serve instance — no restart
		// cleared the in-memory route evidence, and the task did not
		// complete (the catch-22 fix keeps it honestly at reviewer_run
		// until the test_engineer gate binds).
		const second = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: stageBRecord(
				taskId,
				'reviewer',
				'call-r2',
				'child-r2',
				workspace,
				1,
			),
			result: approvedVerdict(taskId),
		});
		expect(second.ok).toBe(true);
		expect(second.consumed).toBe(true);

		// The wedge: with the append semantics, the in-memory list now held
		// TWO reviewer entries for identity 2.9:reviewer:1 and the
		// test_engineer completion was terminally consumed with outcome
		// "rejected" (ROUTE_RECEIPT_DUPLICATE) — tests_run unreachable.
		const teResult = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: stageBRecord(
				taskId,
				'test_engineer',
				'call-t3',
				'child-t3',
				workspace,
				1,
			),
			result: passVerdict(taskId),
		});
		expect(teResult.ok).toBe(true);
		expect(teResult.consumed).toBe(true);

		const evidence = await readTaskEvidence(testDirectory, taskId);
		expect(evidence?.workflow.state).toBe('tests_run');
		expect(evidence?.gates.test_engineer?.sessionId).toBe('child-t3');

		// The in-memory list upholds the one-entry-per-identity invariant.
		const session = swarmState.agentSessions.get('parent-session');
		const inMemory = session?.stageBRouteEvidence?.get(taskId) ?? [];
		expect(inMemory.filter((e) => e.role === 'reviewer')).toHaveLength(1);
		expect(inMemory.filter((e) => e.role === 'test_engineer')).toHaveLength(1);

		// The audit chain keeps BOTH reviewer rows; the read-side collapse
		// still yields one entry per identity (the durable semantics the
		// in-memory list now mirrors).
		const receipts = readTaskGateRequirementsReceiptsSync(
			testDirectory,
			taskId,
		);
		expect(
			receipts.filter((r) => r.normalizedRole === 'reviewer'),
		).toHaveLength(2);
		const collapsed = routeEvidenceFromTaskGateRequirements(receipts);
		expect(collapsed.filter((e) => e.role === 'reviewer')).toHaveLength(1);
	});
});
