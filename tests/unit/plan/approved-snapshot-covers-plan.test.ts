import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	type ApprovedSnapshotInfo,
	approvedSnapshotCoversPlan,
	computePlanStructureHash,
} from '../../../src/plan/ledger';

/**
 * `approvedSnapshotCoversPlan` is the one check behind the plan-critic gate,
 * isPlanCriticApproved and get_approved_plan's drift_detected: an approval
 * covers the approved plan and that same plan at another phase cursor, and
 * nothing else.
 */
function plan(cursor: number | undefined): Plan {
	const task = (id: string, phase: number) => ({
		id,
		phase,
		status: 'pending' as const,
		size: 'small' as const,
		description: `task ${id}`,
		depends: [],
		files_touched: [],
	});
	return {
		schema_version: '1.0.0',
		title: 'Covers',
		swarm: 'test',
		...(cursor === undefined ? {} : { current_phase: cursor }),
		phases: [
			{ id: 1, name: 'One', status: 'pending', tasks: [task('1.1', 1)] },
			{ id: 2, name: 'Two', status: 'pending', tasks: [task('2.1', 2)] },
		],
	} as Plan;
}

function approvedAt(approvedPlan: Plan): ApprovedSnapshotInfo {
	return {
		plan: approvedPlan,
		seq: 1,
		timestamp: '2026-10-08T00:00:00.000Z',
		payloadHash: computePlanStructureHash(approvedPlan),
	};
}

describe('approvedSnapshotCoversPlan', () => {
	test('covers the approved plan itself', () => {
		expect(approvedSnapshotCoversPlan(approvedAt(plan(1)), plan(1))).toBe(true);
	});

	test('covers the same plan after the cursor advanced', () => {
		expect(approvedSnapshotCoversPlan(approvedAt(plan(1)), plan(2))).toBe(true);
	});

	test('covers a cursor moved backwards too: only structure is approved', () => {
		expect(approvedSnapshotCoversPlan(approvedAt(plan(2)), plan(1))).toBe(true);
	});

	test('covers a legacy snapshot approved without a cursor', () => {
		expect(
			approvedSnapshotCoversPlan(approvedAt(plan(undefined)), plan(2)),
		).toBe(true);
	});

	test('rejects a structural edit, with or without a cursor change', () => {
		const edited = plan(1);
		edited.phases[1].tasks[0].description = 'changed scope';
		expect(approvedSnapshotCoversPlan(approvedAt(plan(1)), edited)).toBe(false);
		const editedAndAdvanced = { ...edited, current_phase: 2 };
		expect(
			approvedSnapshotCoversPlan(approvedAt(plan(1)), editedAndAdvanced),
		).toBe(false);
	});

	test('rejects a snapshot whose stored hash is not the hash of its own plan', () => {
		// Anti-gaming: a tampered snapshot whose payload was swapped for the
		// current plan (keeping the old hash) must not be trusted.
		const tampered: ApprovedSnapshotInfo = {
			...approvedAt(plan(1)),
			plan: (() => {
				const p = plan(1);
				p.phases[1].tasks[0].description = 'smuggled change';
				return p;
			})(),
		};
		const current = plan(2);
		current.phases[1].tasks[0].description = 'smuggled change';
		expect(approvedSnapshotCoversPlan(tampered, current)).toBe(false);
	});
});
