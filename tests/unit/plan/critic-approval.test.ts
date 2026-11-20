import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	hasPlanCriticApprovalSnapshotForCall,
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

function makePlan(title = 'Async Critic Approval'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'async-critic',
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

describe('plan-critic-approval shared recorder', () => {
	let dir: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-approval-'));
		plan = makePlan();
		writePlan(dir, plan);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('records a snapshot for a verified APPROVED verdict with a matching dispatch hash', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-1',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('recorded');

		const approved = await loadLastPlanCriticApprovedSnapshot(
			dir,
			derivePlanId(plan),
		);
		expect(approved).not.toBeNull();
		expect(approved?.approval?.verdict).toBe('APPROVED');
		expect(approved?.approval?.source).toBe('plan_critic_gate');
		expect(approved?.approval?.session_id).toBe('ses_parent_1');
		expect(approved?.approval?.call_id).toBe('call-critic-1');
		expect(approved?.approval?.transport).toBe('async_completion');
		// The snapshot's payload hash is the structural hash — the exact shape
		// assertPlanCriticApprovedForExecution compares against.
		expect(approved?.payloadHash).toBe(dispatchHash);
		expect(
			await hasPlanCriticApprovalSnapshotForCall(dir, 'call-critic-1'),
		).toBe(true);
	});

	test('never records for a NEEDS_REVISION verdict (missing/not APPROVED)', async () => {
		await initLedger(dir, derivePlanId(plan));
		for (const text of [
			'VERDICT: NEEDS_REVISION\nfix gaps',
			'VERDICT: REJECTED\nfundamental flaws',
			'no verdict token at all',
			'',
		]) {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-critic-2',
				verdictText: text,
				dispatchPlanStructureHash: computePlanStructureHash(plan),
				transport: 'async_completion',
			});
			expect(result.outcome).toBe('not_approved');
		}
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('fails closed when the plan changed since the dispatch (hash mismatch)', async () => {
		await initLedger(dir, derivePlanId(plan));
		const staleHash = computePlanStructureHash(plan);
		// The architect edits the plan after the critic was dispatched.
		const edited = makePlan('Edited After Dispatch');
		writePlan(dir, edited);

		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-3',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: staleHash,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('skipped');
		expect(result.reason).toContain('changed');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('replay of the same call id never records a second snapshot', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const first = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-4',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(first.outcome).toBe('recorded');
		const second = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-4',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(second.outcome).toBe('skipped');

		const integrity = await (
			await import('../../../src/plan/ledger')
		).readLedgerEventsWithIntegrity(dir);
		const gateSnapshots = integrity.events.filter(
			(event) =>
				event.event_type === 'snapshot' &&
				(event.payload as { approval?: { source?: string } })?.approval
					?.source === 'plan_critic_gate',
		);
		expect(gateSnapshots.length).toBe(1);
	});

	test('sync transport (no dispatch hash) records exactly like the legacy after-hook', async () => {
		await initLedger(dir, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_sync',
			callId: 'call-critic-sync',
			verdictText: { output: APPROVED_TEXT },
			transport: 'sync_task',
		});
		expect(result.outcome).toBe('recorded');
		const approved = await loadLastPlanCriticApprovedSnapshot(
			dir,
			derivePlanId(plan),
		);
		expect(approved?.approval?.call_id).toBe('call-critic-sync');
		expect(approved?.approval?.transport).toBe('sync_task');
	});

	test('reports failed (never records) when no plan exists', async () => {
		// No plan.json written in this test; a clean .swarm dir exists.
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-5',
			verdictText: APPROVED_TEXT,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('failed');
		expect(
			await hasPlanCriticApprovalSnapshotForCall(dir, 'call-critic-5'),
		).toBe(false);
	});

	test('verdict extraction rejects enumeration-only and fenced pseudo-verdicts', async () => {
		await initLedger(dir, derivePlanId(plan));
		// A bare APPROVED inside a fenced code block, and a mid-review mention
		// (not in the tail), must never read as a verdict (issue #2012 guards).
		for (const text of [
			'Plan review:\n```\nAPPROVED\n```\nmore analysis',
			'This looks like it is approved for execution overall.\n\nReview continues below.',
		]) {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-critic-6',
				verdictText: text,
				dispatchPlanStructureHash: computePlanStructureHash(plan),
				transport: 'async_completion',
			});
			expect(result.outcome).toBe('not_approved');
		}
	});

	test('an APPROVED from a different call id does not satisfy the replay fence', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-a',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(
			await hasPlanCriticApprovalSnapshotForCall(dir, 'call-critic-b'),
		).toBe(false);
		// A second, distinct critic dispatch may still record its own approval.
		const second = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-b',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(second.outcome).toBe('recorded');
	});
});
