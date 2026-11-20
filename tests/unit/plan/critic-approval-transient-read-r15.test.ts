/**
 * r15 audit follow-up (P4): a TRANSIENT plan.json read failure inside the
 * approval commit fence must not be classified as a final `conflict`.
 *
 * The pre-commit fence (running under the ledger evidence lock) treated
 * `loadPlanJsonOnly` returning null as `conflict` — "plan.json disappeared
 * before the approval commit". But null also covers a transient unreadable
 * state (e.g. a concurrent save_plan's atomic tmp→rename swap). The closeout
 * observer treats `conflict` as a FINAL rejection and durably marks the step
 * `failed` — a temporary I/O error could permanently destroy a valid critic
 * APPROVED verdict.
 *
 * Required distinction (r15):
 * - PROVEN plan structure change → final `conflict` (covered by the r13
 *   atomicity tests — unchanged),
 * - PROVEN foreign plan identity → final `conflict` (unchanged),
 * - unreadable file / unclear storage state → `failed`/`plan_unreadable`
 *   (retryable — fail-closed: no approval is written, but recovery re-drives),
 * - an identical already-recorded snapshot → `already_recorded` (unchanged).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals as criticApprovalInternals,
	recordVerifiedPlanCriticApproval,
} from '../../../src/plan/critic-approval';
import {
	computePlanStructureHash,
	initLedger,
	loadLastPlanCriticApprovedSnapshot,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function makePlan(title = 'R15 Transient Read Plan'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'r15-transient-read',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
}

function writePlan(directory: string, plan: Plan): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

const APPROVED_TEXT = 'Plan review complete.\n\nVERDICT: APPROVED\nAll good.';

describe('plan-critic-approval transient plan reads (r15 P4)', () => {
	let dir: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-approval-r15-'));
		plan = makePlan();
		writePlan(dir, plan);
	});

	afterEach(() => {
		criticApprovalInternals.onPreCommitFence = null;
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('a transient unreadable plan inside the commit fence is retryable, not a final conflict; the approval survives', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const planPath = join(dir, '.swarm', 'plan.json');

		// Deterministic interleave: the plan file becomes unreadable exactly
		// at the pre-commit fence point (inside the ledger lock) — e.g. a
		// concurrent save_plan's atomic tmp→rename swap — and is readable
		// again moments later.
		criticApprovalInternals.onPreCommitFence = () => {
			rmSync(planPath);
		};

		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-r15-transient',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		criticApprovalInternals.onPreCommitFence = null;

		// Fail-closed held: nothing was approved on an unreadable plan.
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
		// But the classification is RETRYABLE (failed/plan_unreadable), not a
		// final `conflict` that would durably destroy the valid APPROVED.
		expect(result.outcome).toBe('failed');
		expect(result.reasonCode).toBe('plan_unreadable');

		// The plan is readable again (identical, unchanged): the recovery
		// replay must land the approval the critic actually gave.
		writePlan(dir, plan);
		const replay = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-r15-transient',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(replay.outcome).toBe('recorded');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).not.toBeNull();
	});

	test('a PROVEN structure change inside the fence stays a final conflict', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		criticApprovalInternals.onPreCommitFence = () => {
			const edited = makePlan('Edited During Commit Fence');
			edited.phases[0].tasks[0].description = 'changed mid-commit';
			writePlan(dir, edited);
		};
		try {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-r15-conflict',
				verdictText: APPROVED_TEXT,
				dispatchPlanStructureHash: dispatchHash,
				transport: 'async_completion',
			});
			expect(result.outcome).toBe('skipped');
			expect(result.reasonCode).toBe('conflict');
			expect(
				await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
			).toBeNull();
		} finally {
			criticApprovalInternals.onPreCommitFence = null;
		}
	});
});
