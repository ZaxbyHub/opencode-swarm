/**
 * Tests for issue #1687 task 1.2: `fr_refs` (added to `TaskSchema` in task 1.1)
 * must survive ledger snapshot/replay via the existing generic full-plan-object
 * embed, WITHOUT any field-by-field wiring, and must be deliberately EXCLUDED
 * from `computePlanLedgerHash`, `computePlanStructureHash` (src/plan/ledger.ts), and
 * `computePlanContentHash` (src/plan/manager.ts) so that `plan_hash_after`
 * (persisted on-disk and load-bearing for ledger replay/staleness detection)
 * stays byte-identical for every plan that predates `fr_refs`.
 *
 * Coverage:
 * - A task's `fr_refs` survives a real snapshot-then-replay cycle
 *   (`takeSnapshotEvent` → on-disk ledger file → `replayFromLedger`), not
 *   merely a plan.json save/reload.
 * - `computePlanLedgerHash` / `computePlanStructureHash` are unaffected by a task's
 *   `fr_refs` content (hash identical whether `fr_refs` is unset, empty, or
 *   populated) — proving the exclusion is real, not merely documented.
 * - `computePlanContentHash` (src/plan/manager.ts) is likewise unaffected,
 *   verified indirectly via `isPlanMdInSync`/`regeneratePlanMarkdown` since
 *   `computePlanContentHash` itself is not exported.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanLedgerHash,
	computePlanStructureHash,
	initLedger,
	replayFromLedger,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import {
	isPlanMdInSync,
	regeneratePlanMarkdown,
} from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'FR Refs Hash Exclusion Test',
		swarm: 'fr-refs-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task two',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

/** Same plan as `createTestPlan`, but task 1.1 carries `fr_refs`. */
function withFrRefsOnTaskOne(plan: Plan, frRefs: string[]): Plan {
	return {
		...plan,
		phases: plan.phases.map((phase) => ({
			...phase,
			tasks: phase.tasks.map((task) =>
				task.id === '1.1' ? { ...task, fr_refs: frRefs } : task,
			),
		})),
	};
}

describe('fr_refs survives ledger snapshot + replay (issue #1687 task 1.2)', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'ledger-fr-refs-snapshot-'));
		await mkdir(join(dir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a task fr_refs value survives a full snapshot-then-replay cycle unchanged', async () => {
		const basePlan = createTestPlan();
		const planWithFrRefs = withFrRefsOnTaskOne(basePlan, ['FR-000', 'FR-005']);

		// Bootstrap the ledger WITHOUT fr_refs (mirrors an existing plan that
		// predates the field), then take a snapshot of the mutated (fr_refs-bearing)
		// plan. This exercises the REAL disk-backed snapshot event (takeSnapshotEvent
		// writes a JSON line to .swarm/plan-ledger.jsonl) and the REAL replay path
		// (replayFromLedger re-reads that file from disk and reconstructs the plan
		// from the embedded snapshot payload), not merely a plan.json save/reload.
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(basePlan, null, 2),
			'utf-8',
		);
		await initLedger(dir, derivePlanId(basePlan));

		await takeSnapshotEvent(dir, planWithFrRefs);

		const replayed = await replayFromLedger(dir);
		expect(replayed).not.toBeNull();

		const replayedTaskOne = replayed?.phases[0].tasks.find(
			(t) => t.id === '1.1',
		);
		const replayedTaskTwo = replayed?.phases[0].tasks.find(
			(t) => t.id === '1.2',
		);

		// fr_refs rode along automatically via the generic plan-object embed.
		expect(replayedTaskOne?.fr_refs).toEqual(['FR-000', 'FR-005']);
		// A task with no fr_refs set remains unset (undefined) after replay,
		// confirming the field is not defaulted/injected anywhere in the path.
		expect(replayedTaskTwo?.fr_refs).toBeUndefined();
	});

	test('replay reconstructs fr_refs from the plan_created embedded-plan bootstrap too', async () => {
		// Covers the OTHER embed path in reconstructPlanFromEvents (no snapshot
		// event yet, only the plan_created event's embedded plan, #444 item 4).
		const planWithFrRefs = withFrRefsOnTaskOne(createTestPlan(), ['FR-000']);

		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(planWithFrRefs, null, 2),
			'utf-8',
		);
		await initLedger(
			dir,
			derivePlanId(planWithFrRefs),
			computePlanLedgerHash(planWithFrRefs),
			planWithFrRefs,
		);

		const replayed = await replayFromLedger(dir);
		expect(replayed).not.toBeNull();
		const replayedTaskOne = replayed?.phases[0].tasks.find(
			(t) => t.id === '1.1',
		);
		expect(replayedTaskOne?.fr_refs).toEqual(['FR-000']);
	});
});

describe('fr_refs is excluded from computePlanLedgerHash / computePlanStructureHash (ledger.ts)', () => {
	test('computePlanLedgerHash is byte-identical regardless of fr_refs content', () => {
		const basePlan = createTestPlan();
		const withRefs = withFrRefsOnTaskOne(basePlan, ['FR-000', 'FR-001']);
		const withDifferentRefs = withFrRefsOnTaskOne(basePlan, ['FR-999']);
		const withEmptyRefs = withFrRefsOnTaskOne(basePlan, []);

		const baseHash = computePlanLedgerHash(basePlan);
		expect(computePlanLedgerHash(withRefs)).toBe(baseHash);
		expect(computePlanLedgerHash(withDifferentRefs)).toBe(baseHash);
		expect(computePlanLedgerHash(withEmptyRefs)).toBe(baseHash);
	});

	test('computePlanStructureHash is byte-identical regardless of fr_refs content', () => {
		const basePlan = createTestPlan();
		const withRefs = withFrRefsOnTaskOne(basePlan, ['FR-000', 'FR-001']);
		const withDifferentRefs = withFrRefsOnTaskOne(basePlan, ['FR-999']);

		const baseHash = computePlanStructureHash(basePlan);
		expect(computePlanStructureHash(withRefs)).toBe(baseHash);
		expect(computePlanStructureHash(withDifferentRefs)).toBe(baseHash);
	});
});

describe('fr_refs is excluded from computePlanContentHash (manager.ts, via isPlanMdInSync)', () => {
	let tempDir: string;
	let restoreClock: Restore | null = null;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'plan-md-fr-refs-'));
		// derivePlanMarkdown embeds a timestamp; freeze it so this test only
		// exercises the PLAN_HASH-header comparison path deterministically.
		restoreClock = freezeClock({ isoNow: '2026-01-01T00:00:00.000Z' });
	});

	afterEach(async () => {
		restoreClock?.();
		restoreClock = null;
		mock.restore();
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('plan.md written for a plan without fr_refs stays "in sync" once fr_refs is added to a task', async () => {
		const basePlan = createTestPlan();
		// regeneratePlanMarkdown writes the `<!-- PLAN_HASH: ... -->` header using
		// computePlanContentHash(basePlan) (no fr_refs).
		await regeneratePlanMarkdown(tempDir, basePlan);

		const planWithFrRefs = withFrRefsOnTaskOne(basePlan, ['FR-000', 'FR-001']);

		// If computePlanContentHash were affected by fr_refs, this would report
		// out-of-sync (hash mismatch) purely because a task gained fr_refs with
		// everything else unchanged. It must stay in sync, by design.
		expect(await isPlanMdInSync(tempDir, planWithFrRefs)).toBe(true);
	});
});
