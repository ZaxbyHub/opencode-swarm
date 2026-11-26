/**
 * Regression (Wirtschaftssimulation session e07a3a7a, task 1.8): a Stage-B
 * re-dispatch could never unwedge a durably pinned reviewer_run task.
 *
 * Field shape: the pre-exemption reviewer settlement recorded gates.reviewer
 * and its durable route binding (identity 1.8:reviewer:1 bound to the OLD
 * callId/childSessionId) but the completeness barrier refused the advancement,
 * so the durable workflow stayed at reviewer_run with "all required proof
 * exists". The documented unwedging path — re-dispatch the reviewer, which
 * persists a fresh exemption-aware receipt — then failed terminally: every
 * route slot was occupied by the OLD dispatch, so the fresh dispatch could
 * not bind (ROUTE_RECEIPT_DISPATCH_REQUIRED) and the background completion
 * was consumed with outcome "rejected", never recording evidence and never
 * advancing the state. update_task_status kept reporting the contradiction
 * forever.
 *
 * The fix: a Stage-B re-dispatch of the same gate cycle REPLACES the obsolete
 * binding's slot (same identity, fresh call/child), and the durable
 * requirements chain collapses to one entry per (role, identity) on read so
 * the superseded row cannot read back as ROUTE_RECEIPT_DUPLICATE.
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (never the developer's real app-data).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { PluginConfig } from '../../../src/config';
import {
	readTaskGateRequirementsReceiptsSync,
	routeEvidenceFromTaskGateRequirements,
} from '../../../src/evidence/task-gate-requirements';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import type { ReviewRouteEvidence } from '../../../src/review/routing-enforcement';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import {
	getStageBRouteEvidence,
	getTaskState,
	recordModifiedFilesForTask,
	recordStageBRouteEvidence,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { ensureSessionDrained } from '../hooks/_session-rehydration-drain';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf8',
		timeout: 30_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function reviewerRecord(
	taskId: string,
	callID: string,
	childSessionId: string,
	workspace: ReturnType<typeof captureWorkspaceSnapshot>,
): BackgroundDelegationRecord {
	return {
		schemaVersion: 1,
		correlationId: `reviewer-${taskId}-${callID}`,
		jobId: null,
		subagentSessionId: childSessionId,
		parentSessionId: 'parent-session',
		callID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		workspace,
		workflowGeneration: 1,
	};
}

const approvedVerdict = (taskId: string) => ({
	text: `[REVIEWED] | task-${taskId} | APPROVED | docs are correct`,
	chars: 54,
	truncated: false,
	digest: 'reviewer',
});

/** Foreground reviewer dispatch args (resolveEvidenceTaskId parses the TASK line). */
const foregroundReviewerArgs = (taskId: string) => ({
	subagent_type: 'reviewer',
	prompt: `TASK: ${taskId} review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
});

let testDirectory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

describe('background Stage-B re-dispatch slot reclamation', () => {
	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		testDirectory = canonicalMkdtemp('stage-b-redispatch-');
		git(testDirectory, ['init']);
		git(testDirectory, ['config', 'user.email', 'tests@example.com']);
		git(testDirectory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(testDirectory, 'AGENTS.md'), '# docs rule\n');
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
	 * Seeds the exact field wedge: generation 1, test_engineer_exempt proof,
	 * gates.reviewer recorded by the OLD dispatch whose route binding occupies
	 * the only reviewer slot, and the durable workflow pinned at reviewer_run
	 * because the pre-exemption completeness barrier refused the advancement.
	 */
	async function seedWedgedReviewerRun(taskId: string): Promise<void> {
		await ensureSessionDrained('parent-session', testDirectory);
		await transitionTaskWorkflowEvidence(testDirectory, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { testEngineerExempt: true },
			expectedGeneration: 0,
			transitionId: `wedge-coder:${taskId}`,
		});
		await transitionTaskWorkflowEvidence(testDirectory, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `wedge-stage-a:${taskId}`,
		});

		// The pre-fix dispatch-time receipt: complexity-routed test-engineer
		// slot an exempt task can never fill (the cb1943aa3 wedge shape).
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

		// The OLD reviewer settlement: gate proof and durable route binding
		// recorded, advancement refused (routeComplete false) — exactly what
		// the 11:49 field dispatch left behind.
		const oldBinding: ReviewRouteEvidence = {
			role: 'reviewer',
			identity: `${taskId}:reviewer:1`,
			sessionId: 'parent-session',
			taskId,
			slotId: `${taskId}:reviewer:1`,
			callId: 'call-old',
			childSessionId: 'child-old',
			generation: 1,
		};
		await recordGateEvidence(
			testDirectory,
			taskId,
			'reviewer',
			'child-old',
			false,
			{
				expectedGeneration: 1,
				transitionId: 'background-gate:child-old',
				routeBinding: oldBinding,
				routeComplete: false,
			},
		);
	}

	async function persistFreshExemptReceipt(taskId: string): Promise<void> {
		// The post-fix dispatch-time allocation for the re-dispatch:
		// exemption-aware, zero test-engineer slots.
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-session',
				taskId,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: [`${taskId}:reviewer:1`],
				requiredTestEngineers: [],
			}),
		});
	}

	test('regression: a fresh reviewer re-dispatch unwedges the durably pinned reviewer_run task after a restart', async () => {
		await seedWedgedReviewerRun('1.8');

		let evidence = await readTaskEvidence(testDirectory, '1.8');
		expect(evidence?.test_engineer_exempt).toBe(true);
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(evidence?.workflow.state).toBe('reviewer_run');

		await persistFreshExemptReceipt('1.8');

		// Simulate the host restart that preceded the field re-dispatch: the
		// in-memory session (and its route evidence) is gone; only the durable
		// evidence and requirements chain survive.
		resetSwarmState();
		await ensureSessionDrained('parent-session', testDirectory);
		const resumed = swarmState.agentSessions.get('parent-session');
		resumed?.taskWorkflowStates?.set('1.8', 'reviewer_run');

		const fresh = reviewerRecord(
			'1.8',
			'call-fresh',
			'child-fresh',
			captureWorkspaceSnapshot(testDirectory),
		);
		const result = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: fresh,
			result: approvedVerdict('1.8'),
		});

		// Previous code: terminally rejected ({ ok: false, consumed: true },
		// ROUTE_RECEIPT_DISPATCH_REQUIRED) — every reviewer slot was occupied
		// by the old dispatch and the fresh one could never bind.
		expect(result.ok).toBe(true);
		expect(result.consumed).toBe(true);

		evidence = await readTaskEvidence(testDirectory, '1.8');
		// The durable workflow must advance past the wedge.
		expect(evidence?.workflow.state).toBe('tests_run');
		expect(evidence?.gates.reviewer?.sessionId).toBe('child-fresh');

		// The audit chain keeps BOTH reviewer rows, but the reconstructed
		// route evidence collapses them to the latest dispatch for the
		// identity — the superseded row must not read back as a duplicate,
		// and the reclaimed entry keeps the ORIGINAL identity and slot (F-004:
		// a re-dispatch re-earns the same slot; it never rebinds identity or
		// slotId onto a different route position).
		const receipts = readTaskGateRequirementsReceiptsSync(testDirectory, '1.8');
		const reviewerRows = receipts.filter(
			(receipt) => receipt.routeBinding?.role === 'reviewer',
		);
		expect(reviewerRows.length).toBe(2);
		const reconstructed = routeEvidenceFromTaskGateRequirements(receipts);
		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0]).toMatchObject({
			role: 'reviewer',
			identity: '1.8:reviewer:1',
			slotId: '1.8:reviewer:1',
			callId: 'call-fresh',
			childSessionId: 'child-fresh',
		});
	});

	test('regression: the same-process wedge (in-memory route evidence occupied) also reclaims', async () => {
		await seedWedgedReviewerRun('1.9');

		// No restart: the old binding also lives in the parent session's
		// in-memory route evidence (where the settlement reserved it), and the
		// in-memory workflow is pinned at reviewer_run exactly like the durable one.
		const session = swarmState.agentSessions.get('parent-session');
		expect(session).toBeDefined();
		recordStageBRouteEvidence(session!, '1.9', {
			role: 'reviewer',
			identity: '1.9:reviewer:1',
			sessionId: 'parent-session',
			taskId: '1.9',
			slotId: '1.9:reviewer:1',
			callId: 'call-old',
			childSessionId: 'child-old',
			generation: 1,
		});
		session!.taskWorkflowStates?.set('1.9', 'reviewer_run');

		await persistFreshExemptReceipt('1.9');

		const fresh = reviewerRecord(
			'1.9',
			'call-fresh',
			'child-fresh',
			captureWorkspaceSnapshot(testDirectory),
		);
		const result = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: fresh,
			result: approvedVerdict('1.9'),
		});

		expect(result.ok).toBe(true);
		const evidence = await readTaskEvidence(testDirectory, '1.9');
		expect(evidence?.workflow.state).toBe('tests_run');
		expect(evidence?.gates.reviewer?.sessionId).toBe('child-fresh');
		// F-003 (C1/C3): the reclaim must land on the LIVE array, not only the
		// prospective one. Exactly one fresh reviewer binding survives — the
		// obsolete same-identity entry is replaced, never appended beside (a
		// second same-identity entry reads back as ROUTE_RECEIPT_DUPLICATE and
		// re-wedges every live consumer) — keeping the original identity/slot.
		const liveReviewerBindings = getStageBRouteEvidence(session!, '1.9').filter(
			(entry) => entry.role === 'reviewer',
		);
		expect(liveReviewerBindings).toHaveLength(1);
		expect(liveReviewerBindings[0]).toMatchObject({
			role: 'reviewer',
			identity: '1.9:reviewer:1',
			slotId: '1.9:reviewer:1',
			sessionId: 'parent-session',
			taskId: '1.9',
			callId: 'call-fresh',
			childSessionId: 'child-fresh',
		});
		// F-003: the LIVE workflow advances to tests_run in the same process
		// (pre-fix, the poisoned live array blocked this advancement while the
		// durable workflow alone moved on).
		expect(getTaskState(session!, '1.9')).toBe('tests_run');
	});

	test('control: an occupied slot whose identity is absent from the current receipt is not reclaimed', async () => {
		await seedWedgedReviewerRun('1.10');

		// The fresh receipt demands a DIFFERENT reviewer identity namespace
		// (simulating a receipt the current dispatch cannot satisfy) — the
		// old binding must not be silently rebadged onto it.
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-session',
				taskId: '1.10',
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: ['1.10:reviewer:1'],
				requiredTestEngineers: [],
			}),
		});
		const session = swarmState.agentSessions.get('parent-session');
		recordStageBRouteEvidence(session!, '1.10', {
			role: 'reviewer',
			identity: 'foreign-identity',
			sessionId: 'parent-session',
			taskId: '1.10',
			slotId: '1.10:reviewer:1',
			callId: 'call-old',
			childSessionId: 'child-old',
			generation: 1,
		});

		const fresh = reviewerRecord(
			'1.10',
			'call-fresh',
			'child-fresh',
			captureWorkspaceSnapshot(testDirectory),
		);
		const result = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: fresh,
			result: approvedVerdict('1.10'),
		});

		// Fail-closed control: a foreign identity occupying the slot is not a
		// reclaimable prior attempt of THIS receipt's gate cycle.
		expect(result.ok).toBe(false);
		const evidence = await readTaskEvidence(testDirectory, '1.10');
		expect(evidence?.workflow.state).toBe('reviewer_run');
		// The foreign live binding is untouched (not rebadged, not duplicated).
		const controlLive = getStageBRouteEvidence(session!, '1.10');
		expect(controlLive).toHaveLength(1);
		expect(controlLive[0]).toMatchObject({
			identity: 'foreign-identity',
			callId: 'call-old',
		});
	});

	// F-002 (C2): the foreground settlement twin of the same-process reclaim.
	// The settlement composes its prospective evidence correctly, but its live
	// reserve APPENDed the fresh same-identity binding next to the obsolete
	// one, poisoning the live array for every later live-read consumer.
	test('regression: the foreground settlement twin reclaims the live slot and update_task_status completes without a restart', async () => {
		const taskId = '1.11';
		await seedWedgedReviewerRun(taskId);
		// The dispatch resolves the task (and update_task_status completes it)
		// through the plan projection.
		fs.mkdirSync(path.join(testDirectory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(testDirectory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'foreground reclaim settlement',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Implementation',
						status: 'in_progress',
						tasks: [
							{
								id: taskId,
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Exercise the foreground reclaim',
								depends: [],
								files_touched: ['AGENTS.md'],
							},
						],
					},
				],
			}),
		);
		const session = swarmState.agentSessions.get('parent-session')!;
		recordModifiedFilesForTask(session, taskId, ['AGENTS.md'], testDirectory);
		// Same-process wedge state: obsolete live binding + reviewer_run pin.
		recordStageBRouteEvidence(session, taskId, {
			role: 'reviewer',
			identity: `${taskId}:reviewer:1`,
			sessionId: 'parent-session',
			taskId,
			slotId: `${taskId}:reviewer:1`,
			callId: 'call-old',
			childSessionId: 'child-old',
			generation: 1,
		});
		session.taskWorkflowStates?.set(taskId, 'reviewer_run');

		const hook = createDelegationGateHook(
			{ hooks: { delegation_gate: true } } as unknown as PluginConfig,
			testDirectory,
		);
		// The sanctioned unwedging path: re-dispatch the reviewer in the
		// foreground. Dispatch time builds the fresh exemption-aware receipt
		// and reclaims the occupied slot.
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-session', callID: 'call-fresh' },
			{ args: foregroundReviewerArgs(taskId) },
		);
		await hook.taskMetadata({
			callID: 'call-fresh',
			parentSessionID: 'parent-session',
			childSessionID: 'child-fresh',
		});
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: 'parent-session',
				callID: 'call-fresh',
				args: foregroundReviewerArgs(taskId),
			},
			{
				text: `[REVIEWED] | task-${taskId} | APPROVED | foreground reclaim fixture`,
			},
		);

		// One fresh live binding for the reclaimed slot; the obsolete entry was
		// replaced and identity/slot are preserved.
		const live = getStageBRouteEvidence(session, taskId).filter(
			(entry) => entry.role === 'reviewer',
		);
		expect(live).toHaveLength(1);
		expect(live[0]).toMatchObject({
			role: 'reviewer',
			identity: `${taskId}:reviewer:1`,
			slotId: `${taskId}:reviewer:1`,
			callId: 'call-fresh',
			childSessionId: 'child-fresh',
		});
		expect(getTaskState(session, taskId)).toBe('tests_run');
		const evidence = await readTaskEvidence(testDirectory, taskId);
		expect(evidence?.workflow.state).toBe('tests_run');

		// The live-read completion gate finishes the task in the same process
		// (pre-fix it read the poisoned [old, fresh] array and refused).
		const completion = await executeUpdateTaskStatus({
			task_id: taskId,
			status: 'completed',
			working_directory: testDirectory,
		});
		expect(completion.success).toBe(true);
	});
});
