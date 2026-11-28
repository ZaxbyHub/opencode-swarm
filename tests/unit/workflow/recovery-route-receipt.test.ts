import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
	readReviewRouteReceiptSync,
	routeReceiptPathForTask,
} from '../../../src/review/routing-enforcement.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { ensureRecoveryRouteReceipt } from '../../../src/workflow/recovery-route-receipt';
import { forceRecoverReworkTask } from '../../../src/workflow/rework-recovery';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * The 2.26 completion wedge (2026-11-25, swarm_communication_debug): a task
 * opened through a recover_* path had every Stage-B gate bound and sat at
 * tests_run, but update_task_status(completed) failed closed on "has not
 * satisfied its exact v1 review route receipt" — no receipt existed for the
 * recovered cycle (the receipt is only ever written by the dispatch-time
 * allocator), and /swarm recover was itself blocked by the completion guard
 * at tests_run, so no agent-legal path could re-materialize the artifact.
 *
 * The fix: the recovery openings materialize a baseline single-complexity
 * receipt (one reviewer identity, one test-engineer identity unless the
 * durable evidence proves the exemption) — written only when no readable
 * receipt exists; the dispatch-time allocator keeps owning real routing
 * counts and overwrites as usual.
 *
 * Env isolation: the receipt MAC secret lives under the app-data roots —
 * createIsolatedTestEnv redirects them (never the developer's real app-data).
 */
describe('recovery route receipt (the 2.26 completion wedge)', () => {
	let directory = '';
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(() => {
		resetSwarmState();
		isolatedEnv = createIsolatedTestEnv();
		directory = canonicalMkdtemp('recovery-route-receipt-');
	});

	afterEach(() => {
		resetSwarmState();
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function writeMinimalPlan(taskId: string): void {
		const plan = {
			schema_version: '1.0.0',
			title: 'recovery-route-receipt test plan',
			swarm: 'local',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: taskId,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: `task ${taskId}`,
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);
	}

	/**
	 * Seeds the 2.26 durable shape: a coder task whose Stage-B gates bound
	 * with route bindings in the requirements chain and whose workflow sits
	 * at tests_run — with NO route receipt (the recover-opened cycle shape).
	 */
	async function seedCompletedRecoveryShape(taskId: string): Promise<void> {
		writeMinimalPlan(taskId);
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `mut:${taskId}`,
		});
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `stage-a:${taskId}`,
		});
		await recordGateEvidence(
			directory,
			taskId,
			'reviewer',
			'child-rev',
			false,
			{
				expectedGeneration: 1,
				transitionId: `rev:${taskId}`,
				routeBinding: {
					role: 'reviewer',
					identity: `${taskId}:reviewer:1`,
					sessionId: 'arch-1',
					taskId,
					slotId: `${taskId}:reviewer:1`,
					callId: 'call-rev',
					childSessionId: 'child-rev',
					generation: 1,
				},
				routeComplete: true,
			},
		);
		await recordGateEvidence(
			directory,
			taskId,
			'test_engineer',
			'child-te',
			false,
			{
				expectedGeneration: 1,
				transitionId: `te:${taskId}`,
				routeBinding: {
					role: 'test_engineer',
					identity: `${taskId}:test_engineer:1`,
					sessionId: 'arch-1',
					taskId,
					slotId: `${taskId}:test_engineer:1`,
					callId: 'call-te',
					childSessionId: 'child-te',
					generation: 1,
				},
				routeComplete: true,
			},
		);
		const evidence = await readTaskEvidence(directory, taskId);
		expect(evidence?.workflow.state).toBe('tests_run');
		expect(
			existsSync(routeReceiptPathForTask(directory, 'arch-1', taskId)),
		).toBe(false);
	}

	it('the wedge: all gates bound at tests_run but completion fails closed on the missing receipt — the recovery receipt unlocks it', async () => {
		await seedCompletedRecoveryShape('2.26');
		ensureAgentSession('arch-1', 'architect', directory);

		// The field refusal: every gate bound, workflow at tests_run, but no
		// route receipt for the recovered cycle.
		const before = checkReviewerGate('2.26', directory, false, 'arch-1');
		expect(before.blocked).toBe(true);
		expect(before.reason).toContain('exact v1 review route receipt');

		// The fix: the recovery opening materializes the baseline receipt.
		const ensured = await ensureRecoveryRouteReceipt({
			directory,
			taskId: '2.26',
			sessionId: 'arch-1',
		});
		expect(ensured).toBe(true);

		const receipt = readReviewRouteReceiptSync({
			projectRoot: directory,
			sessionId: 'arch-1',
			taskId: '2.26',
		});
		expect(receipt?.kind).toBe('review_route_receipt');
		if (receipt?.kind === 'review_route_receipt') {
			expect(receipt.required).toEqual({ reviewers: 1, testEngineers: 1 });
			expect(receipt.identities.reviewers).toEqual(['2.26:reviewer:1']);
			expect(receipt.identities.testEngineers).toEqual([
				'2.26:test_engineer:1',
			]);
		}

		// The durable chain's bindings satisfy the baseline receipt: the
		// completion gate opens.
		const after = checkReviewerGate('2.26', directory, false, 'arch-1');
		expect(after.blocked).toBe(false);
	});

	it('never overwrites a readable receipt (the dispatch allocator owns real routing counts)', async () => {
		writeMinimalPlan('2.27');
		await persistReviewRouteReceipt({
			projectRoot: directory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'arch-1',
				taskId: '2.27',
				complexity: 'double',
				semanticRisk: 'Real dispatch-time routing',
				requiredReviewers: ['2.27:reviewer:1', '2.27:reviewer:2'],
				requiredTestEngineers: ['2.27:test_engineer:1'],
			}),
		});

		const ensured = await ensureRecoveryRouteReceipt({
			directory,
			taskId: '2.27',
			sessionId: 'arch-1',
		});
		expect(ensured).toBe(true);

		const receipt = readReviewRouteReceiptSync({
			projectRoot: directory,
			sessionId: 'arch-1',
			taskId: '2.27',
		});
		if (receipt?.kind !== 'review_route_receipt') {
			throw new Error('expected a readable receipt');
		}
		expect(receipt.complexity).toBe('double');
		expect(receipt.semanticRisk).toBe('Real dispatch-time routing');
		expect(receipt.required).toEqual({ reviewers: 2, testEngineers: 1 });
	});

	it('replaces an unreadable receipt (a corrupt MAC is the wedge, not a protected artifact)', async () => {
		writeMinimalPlan('2.28');
		// Hand-write a receipt with an invalid MAC: the read throws
		// AUTH_INVALID, which is exactly the shape that wedged completion.
		const receiptPath = routeReceiptPathForTask(directory, 'arch-1', '2.28');
		mkdirSync(path.dirname(receiptPath), { recursive: true });
		writeFileSync(
			receiptPath,
			JSON.stringify({
				kind: 'review_route_receipt',
				version: 1,
				sessionId: 'arch-1',
				taskId: '2.28',
				complexity: 'single',
				semanticRisk: 'stale',
				required: { reviewers: 1, testEngineers: 1 },
				identities: {
					reviewers: ['2.28:reviewer:1'],
					testEngineers: ['2.28:test_engineer:1'],
				},
				slots: {
					reviewers: ['2.28:reviewer:1'],
					testEngineers: ['2.28:test_engineer:1'],
				},
				createdAt: '2026-11-25T00:00:00.000Z',
				mac: 'deadbeef',
			}),
			'utf-8',
		);
		expect(() =>
			readReviewRouteReceiptSync({
				projectRoot: directory,
				sessionId: 'arch-1',
				taskId: '2.28',
			}),
		).toThrow();

		const ensured = await ensureRecoveryRouteReceipt({
			directory,
			taskId: '2.28',
			sessionId: 'arch-1',
		});
		expect(ensured).toBe(true);
		expect(
			readReviewRouteReceiptSync({
				projectRoot: directory,
				sessionId: 'arch-1',
				taskId: '2.28',
			})?.kind,
		).toBe('review_route_receipt');
	});

	it('honors the durable test-engineer exemption (zero TE slots, reviewer-only barrier)', async () => {
		writeMinimalPlan('2.29');
		await transitionTaskWorkflowEvidence(directory, '2.29', {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { testEngineerExempt: true },
			expectedGeneration: 0,
			transitionId: 'mut:2.29',
		});

		const ensured = await ensureRecoveryRouteReceipt({
			directory,
			taskId: '2.29',
			sessionId: 'arch-1',
		});
		expect(ensured).toBe(true);
		const receipt = readReviewRouteReceiptSync({
			projectRoot: directory,
			sessionId: 'arch-1',
			taskId: '2.29',
		});
		if (receipt?.kind !== 'review_route_receipt') {
			throw new Error('expected a readable receipt');
		}
		expect(receipt.required).toEqual({ reviewers: 1, testEngineers: 0 });
	});

	it('integration: forceRecoverReworkTask materializes the receipt for the recovered cycle', async () => {
		writeMinimalPlan('2.30');
		await transitionTaskWorkflowEvidence(directory, '2.30', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut:2.30',
		});
		await transitionTaskWorkflowEvidence(directory, '2.30', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a:2.30',
		});
		await transitionTaskWorkflowEvidence(directory, '2.30', {
			type: 'stage_b_failed',
			gate: 'test_engineer',
			expectedGeneration: 1,
			transitionId: 'stage-b-fail:2.30',
		});
		// Green post-settlement pre-check bundles — strictly newer than the
		// failing verdict's durable anchor (derive from the workflow's
		// updatedAt +60s, like the rework-recovery fixture, so the recency
		// floor is genuinely crossed).
		const { getTaskWorkflowSnapshot, readTaskEvidence: readEvidence } =
			await import('../../../src/gate-evidence');
		const anchor = getTaskWorkflowSnapshot(
			await readEvidence(directory, '2.30'),
		).updatedAt;
		const fresh = new Date(Date.parse(anchor) + 60_000).toISOString();
		for (const bucket of ['secretscan', 'sast_scan'] as const) {
			const entry =
				bucket === 'secretscan'
					? {
							task_id: bucket,
							type: 'secretscan',
							timestamp: fresh,
							agent: bucket,
							verdict: 'pass',
							summary: 'green',
							findings_count: 0,
							files_scanned: 3,
							skipped_files: 0,
							incomplete_files: 0,
							incomplete_paths: [],
						}
					: {
							task_id: bucket,
							type: 'sast',
							timestamp: fresh,
							agent: bucket,
							verdict: 'pass',
							summary: 'green',
							findings: [],
							engine: 'tier_a',
							files_scanned: 3,
							findings_count: 0,
							findings_by_severity: {
								critical: 0,
								high: 0,
								medium: 0,
								low: 0,
							},
						};
			const bundle = {
				schema_version: '1.0.0',
				task_id: bucket,
				entries: [entry],
				created_at: fresh,
				updated_at: fresh,
			};
			const dir = path.join(directory, '.swarm', 'evidence', bucket);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				path.join(dir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
				'utf-8',
			);
		}
		ensureAgentSession('arch-2', 'architect', directory);

		const summary = await forceRecoverReworkTask(directory, 'arch-2', {
			taskId: '2.30',
			reason: 'tool-argument verdict failure while the code is green',
		});
		expect(summary.state).toBe('pre_check_passed');
		expect(summary.routeReceiptEnsured).toBe(true);
		expect(
			readReviewRouteReceiptSync({
				projectRoot: directory,
				sessionId: 'arch-2',
				taskId: '2.30',
			})?.kind,
		).toBe('review_route_receipt');
	});
});
