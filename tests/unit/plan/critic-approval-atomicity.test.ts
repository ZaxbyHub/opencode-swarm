/**
 * r13 audit repair (P1-1): the plan-critic approval check-then-write cycle
 * must be atomic under the ledger evidence lock — racing recorders for the
 * same dispatch can never both commit, and a plan edit racing the commit
 * aborts it with a typed conflict.
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
	readLedgerEventsWithIntegrity,
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

function gateSnapshotCount(
	events: Awaited<ReturnType<typeof readLedgerEventsWithIntegrity>>['events'],
	callId: string,
): number {
	return events.filter(
		(event) =>
			event.event_type === 'snapshot' &&
			(event.payload as { approval?: { call_id?: string } })?.approval
				?.call_id === callId,
	).length;
}

describe('plan-critic-approval atomic deduplication (r13 audit P1-1)', () => {
	let dir: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-approval-atomic-'));
		plan = makePlan();
		writePlan(dir, plan);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('two identical parallel approval attempts record exactly one snapshot', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const attempt = () =>
			recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-parallel-1',
				verdictText: APPROVED_TEXT,
				dispatchPlanStructureHash: dispatchHash,
				transport: 'async_completion',
			});
		const results = await Promise.all([attempt(), attempt()]);
		const recorded = results.filter((r) => r.outcome === 'recorded');
		const skipped = results.filter((r) => r.outcome === 'skipped');
		expect(recorded).toHaveLength(1);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.reasonCode).toBe('already_recorded');
		const integrity = await readLedgerEventsWithIntegrity(dir);
		expect(gateSnapshotCount(integrity.events, 'call-parallel-1')).toBe(1);
	});

	test('three identical parallel approval attempts record exactly one snapshot', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const attempt = () =>
			recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-parallel-3',
				verdictText: APPROVED_TEXT,
				dispatchPlanStructureHash: dispatchHash,
				transport: 'async_completion',
			});
		const results = await Promise.all([attempt(), attempt(), attempt()]);
		expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
		expect(results.filter((r) => r.outcome === 'skipped')).toHaveLength(2);
		const integrity = await readLedgerEventsWithIntegrity(dir);
		expect(gateSnapshotCount(integrity.events, 'call-parallel-3')).toBe(1);
	});

	test('plan edited between the outer check and the in-lock commit aborts with conflict', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		// Deterministic interleave: the plan is rewritten exactly at the
		// pre-commit fence point (inside the ledger lock), between the
		// recorder's outer checks and the commit.
		criticApprovalInternals.onPreCommitFence = () => {
			const edited = makePlan('Edited During Commit Fence');
			edited.phases[0].tasks[0].description = 'changed mid-commit';
			writePlan(dir, edited);
		};
		try {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-fence-edit',
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

	test('same call id with contradictory identity never records a second approval', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const first = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_legit',
			callId: 'call-identity',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(first.outcome).toBe('recorded');
		// A racing recorder claims the SAME call id but a different parent
		// session — the durable replay fence keeps the first identity.
		const second = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_imposter',
			callId: 'call-identity',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(second.outcome).toBe('skipped');
		expect(second.reasonCode).toBe('already_recorded');
		const approved = await loadLastPlanCriticApprovedSnapshot(
			dir,
			derivePlanId(plan),
		);
		expect(approved?.approval?.session_id).toBe('ses_parent_legit');
	});

	test('unreadable ledger fails closed with a distinct ledger_unreadable status', async () => {
		await initLedger(dir, derivePlanId(plan));
		// Replace the canonical ledger with an unreadable directory — the
		// read now fails closed instead of silently treating it as empty.
		const ledgerPath = join(dir, '.swarm', 'plan-ledger.jsonl');
		rmSync(ledgerPath);
		mkdirSync(ledgerPath);
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-broken-ledger',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('failed');
		expect(result.outcome === 'failed' && result.reasonCode).toBe(
			'ledger_unreadable',
		);
		// The tri-state probe distinguishes unreadable from absent/present.
		const { inspectPlanCriticApprovalSnapshotForCall } = await import(
			'../../../src/plan/critic-approval'
		);
		const presence = await inspectPlanCriticApprovalSnapshotForCall(
			dir,
			'call-broken-ledger',
		);
		expect(presence.status).toBe('unreadable');
	});

	test('crash after a successful commit — replay recognizes the existing approval', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const first = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-crash-replay',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(first.outcome).toBe('recorded');
		// "Restart": a fresh recorder instance sees the durable snapshot.
		const replay = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-crash-replay',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(replay.outcome).toBe('skipped');
		expect(replay.reasonCode).toBe('already_recorded');
		const integrity = await readLedgerEventsWithIntegrity(dir);
		expect(gateSnapshotCount(integrity.events, 'call-crash-replay')).toBe(1);
	});
});
