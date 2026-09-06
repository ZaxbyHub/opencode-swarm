/**
 * Regression tests for GitHub issues #383/#384:
 * PlanSyncWorker Aggressively Reverts Plan Files
 *
 * These tests verify that the fixes introduced in the debug-issues-383-384 branch
 * prevent the destructive revert behavior and related edge cases.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeRmRecursive } from '../../tests/helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { Plan } from '../config/plan-schema';
import { closeProjectDb, getProjectDb } from '../db/project-db';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
	initLedger,
	readLedgerEvents,
	replayFromLedger,
	takeSnapshotEvent,
} from './ledger';
import {
	cutoverSqliteLedger,
	getPlanLedgerState,
	readSqliteLedgerEvents,
} from './ledger-sqlite';
import { loadPlan, savePlan, updateTaskStatus } from './manager';

let testDir: string;

function makeTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
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
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'medium',
						description: 'Task 2',
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
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
}

function readPlanJson(directory: string): Plan | null {
	const planPath = path.join(directory, '.swarm', 'plan.json');
	if (!fs.existsSync(planPath)) return null;
	return JSON.parse(fs.readFileSync(planPath, 'utf8')) as Plan;
}

function getArchiveFiles(swarmDir: string): string[] {
	try {
		const files = fs.readdirSync(swarmDir);
		return files.filter(
			(f) =>
				f.startsWith('plan-ledger.legacy-archive.') && f.endsWith('.jsonl'),
		);
	} catch {
		return [];
	}
}

function expectPreservedLegacyHistory(
	swarmDir: string,
	originalLedger: Buffer,
): void {
	const hash = crypto.createHash('sha256').update(originalLedger).digest('hex');
	const archiveName = `plan-ledger.legacy-archive.${hash}.jsonl`;
	expect(getArchiveFiles(swarmDir)).toEqual([archiveName]);
	expect(fs.readFileSync(path.join(swarmDir, archiveName))).toEqual(
		originalLedger,
	);
}

function readLedgerPlanId(dir: string): string | null {
	const ledgerPath = path.join(dir, '.swarm', 'plan-ledger.jsonl');
	if (!fs.existsSync(ledgerPath)) return null;
	try {
		const content = fs.readFileSync(ledgerPath, 'utf-8');
		const line = content.split('\n').find((l) => l.trim());
		if (!line) return null;
		const event = JSON.parse(line);
		return event.plan_id ?? null;
	} catch {
		return null;
	}
}

beforeEach(() => {
	testDir = canonicalMkdtemp('migration-revert-regression-');
	fs.mkdirSync(path.join(testDir, '.opencode'));
});

afterEach(() => {
	mock.restore();
	safeRmRecursive(testDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #384 Root Cause 1 — Ledger Hash Mismatch After Migration
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 2: loadPlan() migration-aware ledger guard', () => {
	test('does NOT revert plan.json when ledger plan_id differs (migration scenario)', async () => {
		// Simulate post-migration state:
		// - Ledger was initialized with old swarm identity "old-swarm_Test Plan"
		// - plan.json has been updated to use new swarm "new-swarm"

		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		// "old-swarm" + "-" + "Test Plan" → "old-swarm-Test_Plan"
		const oldPlanId = 'old-swarm-Test_Plan';
		await initLedger(testDir, oldPlanId);

		// Simulate task completion event in old ledger
		await appendLedgerEvent(testDir, {
			plan_id: oldPlanId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'completed',
			source: 'test',
		});

		// Now write migrated plan.json with new swarm ID
		const migratedPlan = makeTestPlan({
			swarm: 'new-swarm',
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
							description: 'Task 1 (migrated)',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		writePlanJson(testDir, migratedPlan);

		// loadPlan() should detect: plan_id mismatch (old ≠ new) → do NOT rebuild
		// from ledger; instead use plan.json as-is. The plan.json on disk must be
		// preserved (not reverted to old-swarm content).
		const result = await loadPlan(testDir);
		expect(result).not.toBeNull();
		expect(result!.swarm).toBe('new-swarm');
		expect(result!.phases[0].tasks[0].status).toBe('in_progress');
		// Verify plan.json on disk is still the migrated plan (not reverted)
		const onDisk = readPlanJson(testDir);
		expect(onDisk!.swarm).toBe('new-swarm');
	});

	test('reverts plan.json when ledger plan_id matches but hash mismatches (drift recovery)', async () => {
		// Set up plan and ledger with a task completion event
		const plan = makeTestPlan();
		writePlanJson(testDir, plan);
		await savePlan(testDir, plan);

		// Build the completed-plan hash for the ledger event
		const completedPlan = makeTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							size: 'small',
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		const completedHash = computePlanLedgerHash(completedPlan);

		// "test-swarm" + "-" + "Test Plan" → "test-swarm-Test_Plan"
		const planId = 'test-swarm-Test_Plan';

		// Append event that claims the plan is now in the completed state
		await appendLedgerEvent(
			testDir,
			{
				plan_id: planId,
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'completed',
				source: 'test',
			},
			{ planHashAfter: completedHash },
		);

		// Write stale plan.json (task 1.1 still pending) — simulates drift
		writePlanJson(testDir, plan);

		// loadPlan() should detect: hash of plan.json ≠ completedHash (latest ledger)
		// AND plan_id matches → proceed with rebuild from ledger
		const result = await loadPlan(testDir);
		expect(result).not.toBeNull();
		// Task 1.1 should be restored to 'completed' by the ledger replay
		expect(result!.phases[0].tasks[0].status).toBe('completed');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #384 Root Cause 3 — Ledger Not Re-initialized After Migration
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 3: savePlan() re-initializes ledger on identity change', () => {
	test('archives old ledger and creates new one when swarm ID changes', async () => {
		// Set up old ledger
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		await initLedger(testDir, 'old-swarm-Test_Plan');

		const swarmDir = path.join(testDir, '.swarm');

		// Verify old ledger exists
		const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
		expect(fs.existsSync(ledgerPath)).toBe(true);
		const originalLedger = fs.readFileSync(ledgerPath);

		// Call savePlan with new swarm identity
		const newPlan = makeTestPlan({ swarm: 'new-swarm' });
		await savePlan(testDir, newPlan);

		// New ledger should exist
		expect(fs.existsSync(path.join(swarmDir, 'plan-ledger.jsonl'))).toBe(true);

		// New ledger should have the new plan_id
		// Format: "${swarm}-${title}".replace(/[^a-zA-Z0-9-_]/g, '_')
		// "new-swarm" + "-" + "Test Plan" → "new-swarm-Test_Plan" (hyphen is allowed, space → _)
		const events = await readLedgerEvents(testDir);
		expect(events.length).toBeGreaterThan(0);
		expect(events[0].plan_id).toBe('new-swarm-Test_Plan');

		// Archived ledger should exist
		expectPreservedLegacyHistory(swarmDir, originalLedger);
	});

	test('does NOT archive ledger when plan_id is the same', async () => {
		// Set up plan and save it (creates ledger)
		const plan = makeTestPlan();
		await savePlan(testDir, plan);

		const swarmDir = path.join(testDir, '.swarm');

		// Save again with same identity
		const plan2 = makeTestPlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		await savePlan(testDir, plan2);

		const filesAfter = fs.readdirSync(swarmDir);
		const archived = filesAfter.filter((f) =>
			f.startsWith('plan-ledger.legacy-archive.'),
		);
		// No archives should be created for same identity
		expect(archived.length).toBe(0);
	});

	test('managed identity replacement commits a new root and preserves old history', async () => {
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		await initLedger(testDir, 'old-swarm-Test_Plan');

		const swarmDir = path.resolve(testDir, '.swarm');
		const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
		const originalLedger = fs.readFileSync(ledgerPath);

		await savePlan(testDir, makeTestPlan({ swarm: 'new-swarm' }));

		const events = await readLedgerEvents(testDir);
		expect(events[0]?.plan_id).toBe('new-swarm-Test_Plan');
		expectPreservedLegacyHistory(swarmDir, originalLedger);
	});

	test('repeated identity replacement reuses content-addressed history', async () => {
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		await initLedger(testDir, 'old-swarm-Test_Plan');

		const swarmDir = path.resolve(testDir, '.swarm');
		const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
		const originalLedger = fs.readFileSync(ledgerPath);
		const newPlan = makeTestPlan({ swarm: 'new-swarm' });

		await savePlan(testDir, newPlan);
		const firstRoot = fs.readFileSync(ledgerPath);
		await savePlan(testDir, newPlan);

		expect(fs.readFileSync(ledgerPath)).toEqual(firstRoot);
		expect(readLedgerPlanId(testDir)).toBe('new-swarm-Test_Plan');
		expectPreservedLegacyHistory(swarmDir, originalLedger);
	});

	test('SQLite-authority replacement failure rejects and preserves old JSONL and SQLite', async () => {
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		await initLedger(testDir, 'old-swarm-Test_Plan');

		const swarmDir = path.resolve(testDir, '.swarm');
		const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
		const originalLedger = fs.readFileSync(ledgerPath);
		await readLedgerEvents(testDir);
		const state = getPlanLedgerState(testDir);
		cutoverSqliteLedger(testDir, {
			expectedShadowStartedVersion: state?.shadowStartedVersion ?? undefined,
		});
		const originalSqlite = readSqliteLedgerEvents(testDir);
		const originalState = getPlanLedgerState(testDir);

		const triggerName = 'trg_test_abort_plan_ledger_reroot';
		const db = getProjectDb(testDir);
		db.run(`
			CREATE TEMP TRIGGER ${triggerName}
			BEFORE INSERT ON main.plan_ledger_event
			BEGIN
				SELECT RAISE(ABORT, 'test SQLite re-root failure');
			END
		`);
		try {
			await expect(
				savePlan(testDir, makeTestPlan({ swarm: 'new-swarm' })),
			).rejects.toThrow(/test SQLite re-root failure/);
			expect(fs.readFileSync(ledgerPath)).toEqual(originalLedger);
			expect(readSqliteLedgerEvents(testDir)).toEqual(originalSqlite);
			expect(getPlanLedgerState(testDir)).toEqual(originalState);
			expect(readPlanJson(testDir)?.swarm).toBe('old-swarm');
		} finally {
			db.run(`DROP TRIGGER IF EXISTS ${triggerName}`);
			closeProjectDb(testDir);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Ledger snapshot plan_id bug (takeSnapshotEvent)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 4: takeSnapshotEvent uses correct plan_id format', () => {
	test('snapshot event has plan_id matching swarm-title format', async () => {
		const plan = makeTestPlan({ swarm: 'my-swarm', title: 'My Project' });
		writePlanJson(testDir, plan);
		await initLedger(testDir, 'my-swarm-My_Project');

		await takeSnapshotEvent(testDir, plan);

		const events = await readLedgerEvents(testDir);
		const snapshotEvent = events.find((e) => e.event_type === 'snapshot');
		expect(snapshotEvent).not.toBeUndefined();

		// The plan_id in the snapshot must match the combined format
		// "my-swarm" + "-" + "My Project" → "my-swarm-My_Project" (space → _)
		const expectedPlanId = 'my-swarm-My_Project';
		expect(snapshotEvent!.plan_id).toBe(expectedPlanId);
	});

	test('snapshot plan_id does NOT use title alone', async () => {
		const plan = makeTestPlan({ swarm: 'my-swarm', title: 'My Project' });
		writePlanJson(testDir, plan);
		await initLedger(testDir, 'my-swarm-My_Project');

		await takeSnapshotEvent(testDir, plan);

		const events = await readLedgerEvents(testDir);
		const snapshotEvent = events.find((e) => e.event_type === 'snapshot');

		// Must NOT be just the title (the old bug was plan_id: plan.title)
		expect(snapshotEvent!.plan_id).not.toBe('My Project');
		expect(snapshotEvent!.plan_id).not.toBe('My_Project');
		// Must include the swarm prefix
		expect(snapshotEvent!.plan_id).toContain('my-swarm');
	});

	test('snapshot replayed from replayFromLedger returns consistent plan', async () => {
		const plan = makeTestPlan({ swarm: 'snap-swarm', title: 'Snap Plan' });
		await savePlan(testDir, plan);

		const planId = 'snap-swarm-Snap_Plan';
		await takeSnapshotEvent(testDir, plan);

		// Append a task status event after snapshot
		await appendLedgerEvent(testDir, {
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'completed',
			source: 'test',
		});

		// Replay should start from snapshot and apply the post-snapshot event
		const replayed = await replayFromLedger(testDir);
		expect(replayed).not.toBeNull();
		expect(replayed!.phases[0].tasks[0].status).toBe('completed');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// updateTaskStatus must not trigger the revert
// ─────────────────────────────────────────────────────────────────────────────

describe('updateTaskStatus() respects migration guard — no revert on identity mismatch', () => {
	test('updates task status without reverting plan when ledger identity mismatches (migration guard)', async () => {
		// Set up: plan.json with new swarm, ledger with old swarm
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		await initLedger(testDir, 'old-swarm-Test_Plan'); // "old-swarm" + "-" + "Test Plan"

		// Write migrated plan.json
		const migratedPlan = makeTestPlan({ swarm: 'new-swarm' });
		writePlanJson(testDir, migratedPlan);

		// updateTaskStatus should update against the migrated plan, not revert
		// loadPlan() is used, but the migration guard prevents ledger rebuild
		// when identities differ — so the migrated plan.json is preserved
		const updated = await updateTaskStatus(testDir, '1.1', 'in_progress');

		expect(updated.swarm).toBe('new-swarm');
		expect(updated.phases[0].tasks[0].status).toBe('in_progress');

		// Verify plan.json was updated (not reverted)
		const onDisk = readPlanJson(testDir);
		expect(onDisk!.swarm).toBe('new-swarm');
		expect(onDisk!.phases[0].tasks[0].status).toBe('in_progress');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// updateTaskStatus: same-identity drift recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('updateTaskStatus() heals same-identity ledger drift before applying update', () => {
	test('when plan.json is stale (same identity, hash mismatch), updateTaskStatus rebuilds from ledger first', async () => {
		// Setup: save plan, append a ledger event marking task 1.1 in_progress,
		// then manually write back stale plan.json (both tasks still pending).
		// updateTaskStatus on task 1.2 should use loadPlan() which detects the
		// drift, rebuilds from ledger (task 1.1 → in_progress), then applies the
		// status update (task 1.2 → in_progress) on top of the recovered state.
		// We update a DIFFERENT task (1.2) so preserveCompletedStatuses does not
		// interfere with the drift-recovered status of task 1.1.
		const plan = makeTestPlan();
		await savePlan(testDir, plan);

		// Build the post-drift plan for hash computation
		const driftedPlan = makeTestPlan({
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
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Task 2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		const driftedHash = computePlanLedgerHash(driftedPlan);
		const planId = 'test-swarm-Test_Plan';

		// Append a ledger event with the correct planHashAfter so getLatestLedgerHash
		// returns a hash that differs from the stale plan.json we are about to write.
		await appendLedgerEvent(
			testDir,
			{
				plan_id: planId,
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			},
			{ planHashAfter: driftedHash },
		);

		// Write stale plan.json (both tasks still pending) — simulates drift
		writePlanJson(testDir, plan);

		// updateTaskStatus with loadPlan(): detects hash mismatch (same plan_id),
		// rebuilds from ledger (restores 1.1 → in_progress), then applies 1.2 → in_progress.
		const updated = await updateTaskStatus(testDir, '1.2', 'in_progress');

		// task 1.1 should be in_progress (recovered from ledger, not stale pending)
		expect(updated.phases[0].tasks[0].status).toBe('in_progress');
		// task 1.2 should be in_progress (our update)
		expect(updated.phases[0].tasks[1].status).toBe('in_progress');

		// Verify on-disk plan reflects both — not the stale all-pending state
		const onDisk = readPlanJson(testDir);
		expect(onDisk!.phases[0].tasks[0].status).toBe('in_progress');
		expect(onDisk!.phases[0].tasks[1].status).toBe('in_progress');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// applyEventToPlan status validation
// ─────────────────────────────────────────────────────────────────────────────

describe('applyEventToPlan: invalid status in ledger event is rejected safely', () => {
	test('plan with corrupted ledger event (invalid status) does not crash replayFromLedger', async () => {
		const plan = makeTestPlan();
		await savePlan(testDir, plan);

		// Manually inject a corrupted ledger event with an invalid status
		const swarmDir = path.join(testDir, '.swarm');
		const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
		const currentContent = fs.readFileSync(ledgerPath, 'utf8');
		const corruptEvent = JSON.stringify({
			seq: 999,
			timestamp: new Date().toISOString(),
			plan_id: 'test-swarm_Test_Plan',
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'INVALID_STATUS_XYZ', // invalid
			source: 'test-corruption',
			plan_hash_before: 'fake',
			plan_hash_after: 'fake',
			schema_version: '1.0.0',
		});
		fs.writeFileSync(ledgerPath, `${currentContent}${corruptEvent}\n`, 'utf8');

		// replayFromLedger should not throw and should not apply the invalid status
		const result = await replayFromLedger(testDir);
		expect(result).not.toBeNull();
		// Task 1.1 must not have the invalid status
		const task11 = result!.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task11!.status).not.toBe('INVALID_STATUS_XYZ');
		// Status should be either 'pending' (unchanged) or whatever is valid
		const validStatuses = [
			'pending',
			'in_progress',
			'completed',
			'blocked',
			'closed',
		];
		expect(validStatuses).toContain(task11!.status);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Ledger temp path uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe('appendLedgerEvent: temp file is uniquely named', () => {
	test('concurrent append calls use different temp file names', async () => {
		const plan = makeTestPlan();
		await savePlan(testDir, plan);

		// Intercept temp paths by patching fs.renameSync — instead, verify that
		// two concurrent append calls both succeed without either losing data
		const planId = 'test-swarm-Test_Plan';
		await Promise.all([
			appendLedgerEvent(testDir, {
				plan_id: planId,
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'concurrent-1',
			}),
			appendLedgerEvent(testDir, {
				plan_id: planId,
				event_type: 'task_status_changed',
				task_id: '1.2',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'concurrent-2',
			}),
		]);

		// Both events should be in the ledger (may not be guaranteed on multi-process,
		// but within a single Bun process they serialize on the event loop)
		const events = await readLedgerEvents(testDir);
		const sources = events.map((e) => e.source);
		// Both concurrent appends must appear — unique temp paths prevent clobber.
		// If this fails, a real concurrency write-loss bug is present.
		expect(sources).toContain('concurrent-1');
		expect(sources).toContain('concurrent-2');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PlanSyncWorker import check — it must use loadPlanJsonOnly, not loadPlan
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanSyncWorker import verification', () => {
	test('plan-sync-worker.ts does not import loadPlan', () => {
		const workerPath = path.join(
			__dirname,
			'../background/plan-sync-worker.ts',
		);
		const source = fs.readFileSync(workerPath, 'utf8');

		// Must import loadPlanJsonOnly
		expect(source).toContain('loadPlanJsonOnly');

		// Must NOT import loadPlan directly (would re-introduce the revert bug)
		// Check that loadPlan is not in the import list (allow it only as a string
		// in a comment, but not as an imported symbol)
		const importBlock =
			source.match(
				/^import\s+\{[^}]+\}\s+from\s+['"]\.\.\/plan\/manager['"]/m,
			)?.[0] ?? '';
		expect(importBlock).not.toContain("'loadPlan'");
		expect(importBlock).not.toContain('"loadPlan"');
		// The import block should not have loadPlan as a bare identifier either
		// (excluding loadPlanJsonOnly which contains it as a substring — check precisely)
		const importedNames = importBlock
			.replace(/loadPlanJsonOnly/g, '')
			.match(/\b(loadPlan)\b/);
		expect(importedNames).toBeNull();
	});

	test('plan-sync-worker.ts calls regeneratePlanMarkdown when plan is found', () => {
		const workerPath = path.join(
			__dirname,
			'../background/plan-sync-worker.ts',
		);
		const source = fs.readFileSync(workerPath, 'utf8');
		expect(source).toContain('regeneratePlanMarkdown');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Managed identity replacement preserves exact legacy history
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix: managed identity replacement preserves legacy history', () => {
	test('savePlan commits the new root and exact content-addressed archive', async () => {
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		writePlanJson(testDir, oldPlan);
		await initLedger(testDir, 'old-swarm-Test_Plan');

		const swarmDir = path.resolve(testDir, '.swarm');
		const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
		const originalLedger = fs.readFileSync(ledgerPath);

		const newPlan = makeTestPlan({ swarm: 'new-swarm' });
		await savePlan(testDir, newPlan);

		const events = await readLedgerEvents(testDir);
		expect(events[0]?.plan_id).toBe('new-swarm-Test_Plan');
		expectPreservedLegacyHistory(swarmDir, originalLedger);
	});
});
