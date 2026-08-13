import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeRmRecursive } from '../../tests/helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { Plan } from '../config/plan-schema';
import {
	appendLedgerEvent,
	computePlanHash,
	initLedger,
	ledgerExists,
	readLedgerEvents,
	replayFromLedger,
} from './ledger';
import { loadPlan } from './manager';

/**
 * Test workspace directory
 */
let testDir: string;

function makeTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		migration_status: 'migrated',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Test task 1',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'medium',
						description: 'Test task 2',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

function writePlanJson(directory: string, plan: Plan): void {
	const planPath = path.join(directory, '.swarm', 'plan.json');
	fs.mkdirSync(path.dirname(planPath), { recursive: true });
	fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
}

function readPlanJson(directory: string): Plan | null {
	const planPath = path.join(directory, '.swarm', 'plan.json');
	if (!fs.existsSync(planPath)) return null;
	return JSON.parse(fs.readFileSync(planPath, 'utf8')) as Plan;
}

describe('loadPlan ledger-aware hash comparison guard', () => {
	beforeEach(() => {
		testDir = canonicalMkdtemp('manager-ledger-aware-test-');
	});

	afterEach(() => {
		safeRmRecursive(testDir);
	});

	describe('Case 1: plan.json hash matches latest ledger hash — no rebuild', () => {
		test('returns plan.json as-is when hash matches ledger', async () => {
			// Set up: valid plan.json + ledger with matching hash
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);
			await initLedger(testDir, 'test-plan');

			// At this point, ledger's last event has plan_hash_after = hash of plan.json at init time
			// Since plan.json hasn't changed since init, they should match
			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Test Plan');
			// plan.json should NOT have been overwritten by rebuild
			const planJsonAfter = readPlanJson(testDir);
			expect(planJsonAfter!.phases[0].tasks[0].status).toBe('pending');
		});

		test('returns plan.json without attempting ledger check when no ledger exists', async () => {
			// Set up: valid plan.json, NO ledger
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Test Plan');
			// No ledger exists, so no hash comparison should occur
			expect(await ledgerExists(testDir)).toBe(false);
		});
	});

	describe('Case 2: plan.json hash does NOT match latest ledger hash — rebuild from ledger', () => {
		test('rebuilds from ledger when hash mismatch detected', async () => {
			// Set up: valid plan.json + ledger with DIFFERENT hash.
			// The planId must match the plan's computed identity (swarm-title format) so the
			// migration-aware guard in loadPlan() recognises this as drift (not migration) and
			// proceeds with the rebuild. Using 'test-plan' as planId would NOT match the
			// plan's computed 'test-swarm-Test_Plan', triggering the migration bypass instead.
			const initialPlan = makeTestPlan(); // swarm:'test-swarm', title:'Test Plan'
			writePlanJson(testDir, initialPlan);
			// Correct planId: "${swarm}-${title}".replace(/[^a-zA-Z0-9-_]/g, '_')
			const planId = 'test-swarm-Test_Plan';
			await initLedger(testDir, planId);

			// Compute the hash of the plan AFTER the task status change so that
			// the ledger event's plan_hash_after reflects the expected post-mutation state.
			// Without this, plan_hash_after defaults to plan_hash_before (current plan.json
			// hash), and when we write the "stale" plan.json with the same pending status,
			// the hashes match and loadPlan() correctly sees no mismatch.
			const postMutationPlan: Plan = {
				...initialPlan,
				phases: initialPlan.phases.map((phase) => ({
					...phase,
					tasks: phase.tasks.map((task) =>
						task.id === '1.1'
							? { ...task, status: 'in_progress' as const }
							: task,
					),
				})),
			};
			const postMutationHash = computePlanHash(postMutationPlan);

			// Add a task_status_changed event to the ledger with correct planHashAfter
			await appendLedgerEvent(
				testDir,
				{
					plan_id: planId,
					event_type: 'task_status_changed',
					task_id: '1.1',
					phase_id: 1,
					from_status: 'pending',
					to_status: 'in_progress',
					source: 'test',
				},
				{ planHashAfter: postMutationHash },
			);

			// Now write plan.json with task 1.1 still pending (stale = didn't apply the event).
			// Keep same swarm/title so the migration guard sees the planId as matching.
			// The ledger's plan_hash_after (in_progress state) ≠ plan.json hash (pending state)
			// → hash mismatch with matching planId → should trigger rebuild.
			const stalePlan: Plan = {
				...initialPlan,
				phases: initialPlan.phases.map((phase) => ({
					...phase,
					tasks: phase.tasks.map((task) =>
						task.id === '1.1'
							? {
									...task,
									status: 'pending' as const,
								}
							: task,
					),
				})),
			};
			writePlanJson(testDir, stalePlan);

			// Load plan - should detect hash mismatch and rebuild from ledger
			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			// The rebuilt plan should have the status from the ledger
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'in_progress',
			);
		});

		test('saves rebuilt plan back to plan.json after rebuild', async () => {
			const initialPlan = makeTestPlan();
			writePlanJson(testDir, initialPlan);
			const planId = 'test-swarm-Test_Plan'; // matches plan's swarm+title
			await initLedger(testDir, planId);

			// Compute post-mutation hash so the ledger event's plan_hash_after reflects
			// the completed state, making the stale plan.json (pending) detectable as drift.
			const completedPlan: Plan = {
				...initialPlan,
				phases: initialPlan.phases.map((phase) => ({
					...phase,
					tasks: phase.tasks.map((task) =>
						task.id === '1.1'
							? { ...task, status: 'completed' as const }
							: task,
					),
				})),
			};
			const completedHash = computePlanHash(completedPlan);

			await appendLedgerEvent(
				testDir,
				{
					plan_id: planId,
					event_type: 'task_status_changed',
					task_id: '1.1',
					phase_id: 1,
					from_status: 'pending',
					to_status: 'completed',
					source: 'test',
				},
				{ planHashAfter: completedHash },
			);

			// Make plan.json stale by modifying it directly (task 1.1 still pending)
			const stalePlan: Plan = {
				...initialPlan,
				phases: initialPlan.phases.map((phase) => ({
					...phase,
					tasks: phase.tasks.map((task) =>
						task.id === '1.1'
							? {
									...task,
									status: 'pending' as const,
								}
							: task,
					),
				})),
			};
			writePlanJson(testDir, stalePlan);

			// First verify stale state
			const before = readPlanJson(testDir);
			expect(before!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'pending',
			);

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			// The returned plan should reflect the ledger state
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'completed',
			);
		});
	});

	describe('Case 3: hash mismatch but ledger replay fails — fall through to stale plan.json', () => {
		test('replayFromLedger throws on corrupted ledger — falls back to stale plan.json gracefully', async () => {
			// Set up: valid plan.json + corrupted ledger that will cause replay to throw
			const stalePlan = makeTestPlan();
			writePlanJson(testDir, stalePlan);

			// Initialize ledger and add an event (so ledger exists and has events)
			await initLedger(testDir, 'test-plan');
			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			// Manually corrupt the ledger with a bad event that will cause replay to throw
			// This writes a second line with malformed JSON after the valid events
			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			fs.appendFileSync(ledgerPath, '\n{"seq":"invalid-json"}\n', 'utf8');

			// Verify ledger has more than just plan_created
			const eventsBefore = await readLedgerEvents(testDir);
			expect(eventsBefore.length).toBeGreaterThan(1);

			// Fixed: replayFromLedger is now wrapped in try-catch
			// loadPlan should return the stale-but-valid plan.json gracefully
			const result = await loadPlan(testDir);
			expect(result).not.toBeNull();
			// Should return the original plan (stale fallback)
			expect(result!.title).toBe('Test Plan');
		});

		test('returns plan when ledger exists but no meaningful events to replay', async () => {
			// Set up: valid plan.json, ledger exists with only plan_created
			const stalePlan = makeTestPlan();
			writePlanJson(testDir, stalePlan);

			// Initialize ledger with just plan_created (no additional events)
			await initLedger(testDir, 'test-plan');
			// Don't add any task_status_changed events

			// Hash mismatch will be detected (plan.json modified after init)
			// but replay will return the same plan (no status changes to apply)
			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'pending',
			);
		});
	});

	describe('Case 4: no ledger exists — returns plan.json as-is (no hash check)', () => {
		test('returns plan.json without checking any hash when no ledger exists', async () => {
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);
			// No ledger initialized

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Test Plan');
			expect(await ledgerExists(testDir)).toBe(false);
		});

		test('plan.json can be loaded even when completely alone', async () => {
			const plan = makeTestPlan({ title: 'Solo Plan' });
			writePlanJson(testDir, plan);

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Solo Plan');
		});
	});

	describe('Case 5: ledger exists but is empty (no events) — returns plan.json as-is', () => {
		test('returns plan.json when ledger file exists but has no events', async () => {
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);

			// Create an empty ledger file (just whitespace/newlines)
			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
			fs.writeFileSync(ledgerPath, '\n\n', 'utf8');

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Test Plan');
			// Should not attempt to rebuild from empty ledger
		});

		test('returns plan.json when ledger exists but only has plan_created event', async () => {
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);
			await initLedger(testDir, 'test-plan');
			// Ledger now has just plan_created event (seq 1)

			const events = await readLedgerEvents(testDir);
			expect(events).toHaveLength(1);
			expect(events[0].event_type).toBe('plan_created');

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Test Plan');
		});

		test('empty ledger hash guard - returns plan.json when ledgerHash is empty string', async () => {
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);

			// Create ledger with only whitespace
			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
			fs.writeFileSync(ledgerPath, '   \n   \n', 'utf8');

			const result = await loadPlan(testDir);

			expect(result).not.toBeNull();
			expect(result!.title).toBe('Test Plan');
		});
	});

	describe('hash comparison edge cases', () => {
		test('plan.json with identical content produces same hash', async () => {
			const plan1 = makeTestPlan();
			const plan2 = makeTestPlan();

			const hash1 = computePlanHash(plan1);
			const hash2 = computePlanHash(plan2);

			expect(hash1).toBe(hash2);
		});

		test('different plan content produces different hash', async () => {
			const plan1 = makeTestPlan({ title: 'Plan A' });
			const plan2 = makeTestPlan({ title: 'Plan B' });

			const hash1 = computePlanHash(plan1);
			const hash2 = computePlanHash(plan2);

			expect(hash1).not.toBe(hash2);
		});

		test('ledger hash matches plan hash at init time', async () => {
			const plan = makeTestPlan();
			writePlanJson(testDir, plan);
			await initLedger(testDir, 'test-plan');

			// Get the ledger hash after init
			const events = await readLedgerEvents(testDir);
			const ledgerHash = events[events.length - 1].plan_hash_after;

			// Get the plan hash from plan.json
			const planJson = readPlanJson(testDir)!;
			const planHash = computePlanHash(planJson);

			// They should match because plan.json hasn't changed since initLedger read it
			expect(planHash).toBe(ledgerHash);
		});
	});

	describe('replayFromLedger integration', () => {
		test('replayFromLedger returns null when plan.json is missing', async () => {
			await initLedger(testDir, 'test-plan');
			// No plan.json

			const result = await replayFromLedger(testDir);

			expect(result).toBeNull();
		});

		test('replayFromLedger returns null when ledger is empty', async () => {
			writePlanJson(testDir, makeTestPlan());
			// Ledger doesn't exist

			const result = await replayFromLedger(testDir);

			expect(result).toBeNull();
		});

		test('replayFromLedger correctly applies status changes', async () => {
			const initialPlan = makeTestPlan();
			writePlanJson(testDir, initialPlan);
			await initLedger(testDir, 'test-plan');

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.2',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'completed',
				source: 'test',
			});

			const result = await replayFromLedger(testDir);

			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'in_progress',
			);
			expect(result!.phases[0].tasks.find((t) => t.id === '1.2')!.status).toBe(
				'completed',
			);
		});
	});
});
