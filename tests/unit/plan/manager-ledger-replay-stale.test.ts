import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan, RuntimePlan } from '../../../src/config/plan-schema';
import * as realLedger from '../../../src/plan/ledger';
import { loadPlan, resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';

// ---------------------------------------------------------------------------
// #1269 finding 2: structured staleness signal on the stale-return path.
//
// When loadPlan finds a plan.json whose hash mismatches the ledger, ledger
// replay THROWS, AND no critic-approved snapshot is available, it falls back to
// returning the STALE plan.json. Previously it returned that plan with no
// structured flag — a silent stale-read. It must now attach
// `_ledgerReplayStale === true` (+ a reason) so phase-complete.ts and
// update-task-status.ts can detect the condition.
//
// We mock the ledger module (spread real, override four functions) to force the
// exact path: ledger present, hash mismatch, replay throws, no approved
// snapshot. `computePlanHash` stays REAL so it produces a value that differs
// from our sentinel ledger hash, guaranteeing the mismatch branch.
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		// NOTE: deliberately NO specHash — keeps the spec-staleness block from
		// running so it cannot touch the returned object.
		title: 'Ledger Replay Stale Plan',
		swarm: 'replay-stale-swarm',
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
						status: 'in_progress',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

async function writePlanJson(dir: string, plan: Plan): Promise<void> {
	const swarmDir = join(dir, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	await writeFile(
		join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
}

describe('loadPlan — #1269 finding 2: _ledgerReplayStale on stale-return path', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'ledger-replay-stale-'));
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
		mock.restore();
		resetStartupLedgerCheck();
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('hash mismatch + replay throws + no approved snapshot → returns plan with _ledgerReplayStale=true and reason', async () => {
		const plan = createTestPlan();
		await writePlanJson(tempDir, plan);

		const planId = derivePlanId(plan);
		// A ledger event whose plan_id matches the plan identity (so loadPlan takes
		// the rebuild branch, not the migration/identity-mismatch branch) and whose
		// plan_hash_after is a sentinel that will never equal the real
		// computePlanHash(plan) → forces the hash-mismatch branch.
		const fakeEvent = {
			seq: 1,
			plan_id: planId,
			event_type: 'plan_created',
			plan_hash_after: 'SENTINEL_LEDGER_HASH_NEVER_MATCHES',
			timestamp: '2026-01-01T00:00:00.000Z',
		};

		mock.module('../../../src/plan/ledger', () => ({
			...realLedger,
			ledgerExists: async () => true,
			readLedgerEvents: async () => [fakeEvent],
			replayFromLedger: async () => {
				throw new Error('simulated replay failure');
			},
			loadLastApprovedPlan: async () => null,
		}));

		const result = (await loadPlan(tempDir)) as RuntimePlan | null;

		expect(result).not.toBeNull();
		// Proves we returned the (stale) plan.json, not some other object.
		expect(result!.title).toBe('Ledger Replay Stale Plan');
		expect(result!.swarm).toBe('replay-stale-swarm');

		// The structured staleness signal (the assertion this test exists for).
		expect(result!._ledgerReplayStale).toBe(true);
		expect(typeof result!._ledgerReplayStaleReason).toBe('string');
		expect(result!._ledgerReplayStaleReason).toContain('Ledger replay failed');
		expect(result!._ledgerReplayStaleReason).toContain(
			'simulated replay failure',
		);
	});

	test('persistence (core fix): a SECOND loadPlan WITHOUT resetStartupLedgerCheck STILL returns _ledgerReplayStale=true', async () => {
		// Regression for #1269 finding-2 production gap: the stale verdict used to be
		// set only inside the startup-gated block, on a throwaway structuredClone, so
		// it was attached on the FIRST loadPlan per workspace per process and never
		// reached later update_task_status / phase_complete loads. The fix persists
		// the verdict per-workspace (ledgerStaleWorkspaces) and re-surfaces it at the
		// live-plan return chokepoint. This drives the REAL loadPlan (only the LEDGER
		// internals are mocked — loadPlan itself is never mocked).
		const plan = createTestPlan();
		await writePlanJson(tempDir, plan);

		const planId = derivePlanId(plan);
		const fakeEvent = {
			seq: 1,
			plan_id: planId,
			event_type: 'plan_created',
			plan_hash_after: 'SENTINEL_LEDGER_HASH_NEVER_MATCHES',
			timestamp: '2026-01-01T00:00:00.000Z',
		};

		mock.module('../../../src/plan/ledger', () => ({
			...realLedger,
			ledgerExists: async () => true,
			readLedgerEvents: async () => [fakeEvent],
			replayFromLedger: async () => {
				throw new Error('simulated replay failure');
			},
			loadLastApprovedPlan: async () => null,
		}));

		// First load: startup replay runs, detects unrecoverable staleness, persists
		// the verdict, and attaches the detailed reason.
		const first = (await loadPlan(tempDir)) as RuntimePlan | null;
		expect(first).not.toBeNull();
		expect(first!._ledgerReplayStale).toBe(true);
		expect(first!._ledgerReplayStaleReason).toContain(
			'simulated replay failure',
		);

		// Second load WITHOUT resetStartupLedgerCheck(): the expensive startup replay
		// is now skipped (active-session window), so before the fix this returned the
		// plan with NO staleness flag — the dead-guard bug. It must STILL be flagged.
		const second = (await loadPlan(tempDir)) as RuntimePlan | null;
		expect(second).not.toBeNull();
		// Proves it is the live plan.json being returned, re-flagged.
		expect(second!.title).toBe('Ledger Replay Stale Plan');
		expect(second!._ledgerReplayStale).toBe(true);
		// On the persisted (non-startup) surface the detailed replay-error string is
		// not available; assert only that a non-empty reason rides the object.
		expect(typeof second!._ledgerReplayStaleReason).toBe('string');
		expect(second!._ledgerReplayStaleReason!.length).toBeGreaterThan(0);
	});

	test('self-heal: once plan.json reconverges with the ledger, the next loadPlan CLEARS the flag', async () => {
		// Proves the fix is "refuse until fixed, then auto-clear" — not a permanent
		// stuck refusal. After detection, we make the ledger tail hash equal the real
		// computePlanHash of the returned plan (simulating an architect save_plan /
		// rebuild that reconverged plan.json with the ledger). The cheap self-heal
		// recheck at the chokepoint must then drop the verdict.
		const plan = createTestPlan({
			title: 'Self Heal Plan',
			swarm: 'self-heal-swarm',
		});
		await writePlanJson(tempDir, plan);
		const planId = derivePlanId(plan);

		// Mutable ledger tail hash so the same mock can present a mismatch first and
		// a match after reconvergence. Derived from the RETURNED object (not the raw
		// literal) so schema-defaulted fields cannot make the heal hash unreachable.
		let ledgerTail = 'SENTINEL_LEDGER_HASH_NEVER_MATCHES';
		const makeEvent = () => ({
			seq: 1,
			plan_id: planId,
			event_type: 'plan_created',
			plan_hash_after: ledgerTail,
			timestamp: '2026-01-01T00:00:00.000Z',
		});

		mock.module('../../../src/plan/ledger', () => ({
			...realLedger,
			ledgerExists: async () => true,
			readLedgerEvents: async () => [makeEvent()],
			replayFromLedger: async () => {
				throw new Error('simulated replay failure');
			},
			loadLastApprovedPlan: async () => null,
		}));

		// Phase 1 — detect + persist.
		const stale = (await loadPlan(tempDir)) as RuntimePlan | null;
		expect(stale).not.toBeNull();
		expect(stale!._ledgerReplayStale).toBe(true);

		// Invariant 5 evidence: the runtime-only flag does NOT affect the plan hash
		// (computePlanHash uses an explicit field allow-list). Hash the SAME object
		// with the flag, then strip the runtime overlay and hash again — isolating
		// the flag's (non-)effect, so this is safe to use as the reconverged tail.
		const reconvergedHash = realLedger.computePlanHash(stale!);
		const flaglessClone = { ...stale! } as RuntimePlan;
		flaglessClone._ledgerReplayStale = undefined;
		flaglessClone._ledgerReplayStaleReason = undefined;
		expect(realLedger.computePlanHash(flaglessClone)).toBe(reconvergedHash);

		// Phase 2 — reconverge: ledger tail now matches the live plan.json hash.
		ledgerTail = reconvergedHash;

		// Next load WITHOUT resetStartupLedgerCheck(): the self-heal recheck sees
		// plan == ledger and must clear the verdict.
		const healed = (await loadPlan(tempDir)) as RuntimePlan | null;
		expect(healed).not.toBeNull();
		expect(healed!.title).toBe('Self Heal Plan');
		expect(healed!._ledgerReplayStale).toBeUndefined();
		expect(healed!._ledgerReplayStaleReason).toBeUndefined();

		// And it stays cleared on the subsequent load (verdict was removed from the
		// persisted set, not merely suppressed for one call).
		const stillHealed = (await loadPlan(tempDir)) as RuntimePlan | null;
		expect(stillHealed).not.toBeNull();
		expect(stillHealed!._ledgerReplayStale).toBeUndefined();
	});

	test('healthy load (no ledger) does NOT set _ledgerReplayStale', async () => {
		const plan = createTestPlan({
			title: 'Healthy Plan',
			swarm: 'healthy-swarm',
		});
		await writePlanJson(tempDir, plan);

		// No ledger present → loadPlan never enters the rebuild/stale path.
		mock.module('../../../src/plan/ledger', () => ({
			...realLedger,
			ledgerExists: async () => false,
		}));

		const result = (await loadPlan(tempDir)) as RuntimePlan | null;

		expect(result).not.toBeNull();
		expect(result!.title).toBe('Healthy Plan');
		expect(result!._ledgerReplayStale).toBeUndefined();
		expect(result!._ledgerReplayStaleReason).toBeUndefined();
	});
});
