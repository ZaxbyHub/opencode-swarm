/**
 * M1 — plan-ledger silent-rollback regression suite.
 *
 * Root cause (pre-fix): when the ledger contained a poison (unparseable) line,
 * integrity-checked replay reconstructed only the PREFIX before it, and
 * `loadPlan` then overwrote canonical plan.json with that prefix-only projection
 * via `rebuildPlan`. Every durable `task_status_changed` / `task_removed` event
 * recorded AFTER the poison line was silently dropped — a silent rollback and
 * permanent data loss.
 *
 * Fix under test:
 *  - `replayFromLedgerWithStatus` threads a `truncated` flag out of replay.
 *  - `loadPlan` refuses to overwrite plan.json when `truncated === true`; it
 *    preserves the on-disk plan and surfaces the `_ledgerReplayStale` marker.
 *  - The canonical ledger is NEVER rewritten/truncated (only a non-destructive
 *    quarantine of the bad suffix to a UNIQUE side file).
 *  - fsync-before-rename in append/init/rebuild durability paths.
 *  - The former `replayWithIntegrity` is folded into `replayFromLedgerWithStatus`
 *    while preserving the #444 plan_created embedded-plan bootstrap branch.
 *
 * Mirrors patterns in ledger-integrity.test.ts and
 * tests/unit/plan/manager-ledger-replay-stale.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan, RuntimePlan } from '../config/plan-schema';
import {
	appendLedgerEvent,
	initLedger,
	type LedgerEvent,
	readLedgerEvents,
	replayFromLedger,
	replayFromLedgerWithStatus,
} from './ledger';
import { loadPlan, resetStartupLedgerCheck } from './manager';
import { derivePlanId } from './utils';

/** A minimal, schema-valid single-task plan. No specHash so the spec-staleness
 * block in loadPlan never runs. */
function makePlan(taskStatus: Plan['phases'][0]['tasks'][0]['status']): Plan {
	return {
		schema_version: '1.0.0',
		title: 'M1 Truncation Plan',
		swarm: 'm1-swarm',
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
						status: taskStatus,
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function writePlanJson(dir: string, plan: Plan): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
}

function ledgerLine(event: LedgerEvent): string {
	return `${JSON.stringify(event)}\n`;
}

describe('M1: loadPlan does not silently roll back plan.json on a truncated ledger', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-truncation-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		resetStartupLedgerCheck();
	});

	afterEach(() => {
		resetStartupLedgerCheck();
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	/**
	 * Build the canonical M1 scenario:
	 *   ledger = [plan_created(embedded pending plan), status→in_progress,
	 *             POISON, status→completed]
	 * with plan.json reflecting the post-poison `completed` status. The last
	 * valid event's plan_hash_after is a sentinel that never equals the real
	 * hash of plan.json, so loadPlan enters the startup hash-mismatch rebuild
	 * branch.
	 */
	function seedTruncatedLedger(): {
		planCompleted: Plan;
		ledgerPath: string;
		planJsonPath: string;
	} {
		const planCompleted = makePlan('completed');
		const planPending = makePlan('pending');
		const planId = derivePlanId(planCompleted);
		writePlanJson(testDir, planCompleted);

		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
		const created: LedgerEvent = {
			seq: 1,
			timestamp: '2026-01-01T00:00:00.000Z',
			plan_id: planId,
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'H1',
			schema_version: '1.1.0',
			payload: { plan: planPending, payload_hash: 'H1' },
		};
		const toInProgress: LedgerEvent = {
			seq: 2,
			timestamp: '2026-01-01T00:00:01.000Z',
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'in_progress',
			source: 'test',
			plan_hash_before: 'H1',
			plan_hash_after: 'H2',
			schema_version: '1.1.0',
		};
		// A durable post-poison event whose plan_hash_after is a sentinel that will
		// never equal computePlanLedgerHash(plan.json), forcing the mismatch branch.
		const toCompleted: LedgerEvent = {
			seq: 4,
			timestamp: '2026-01-01T00:00:03.000Z',
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'in_progress',
			to_status: 'completed',
			source: 'test',
			plan_hash_before: 'H2',
			plan_hash_after: 'SENTINEL_LEDGER_HASH_NEVER_MATCHES',
			schema_version: '1.1.0',
		};

		fs.writeFileSync(
			ledgerPath,
			ledgerLine(created) +
				ledgerLine(toInProgress) +
				'{ POISON — not valid json\n' +
				ledgerLine(toCompleted),
			'utf8',
		);

		return {
			planCompleted,
			ledgerPath,
			planJsonPath: path.join(testDir, '.swarm', 'plan.json'),
		};
	}

	test('(i) preserves the post-poison durable status and surfaces _ledgerReplayStale (no silent rollback)', async () => {
		const { planJsonPath } = seedTruncatedLedger();

		const result = (await loadPlan(testDir)) as RuntimePlan | null;

		expect(result).not.toBeNull();
		// The post-poison durable status is NOT rolled back to the prefix-only
		// `in_progress` projection — plan.json's `completed` is preserved.
		expect(result!.phases[0].tasks[0].status).toBe('completed');
		// Structured staleness marker is surfaced (not a silent stale read).
		expect(result!._ledgerReplayStale).toBe(true);
		expect(typeof result!._ledgerReplayStaleReason).toBe('string');
		expect(result!._ledgerReplayStaleReason!.toLowerCase()).toContain(
			'truncated',
		);

		// On-disk plan.json must be byte-identical: rebuildPlan must NOT have run.
		const onDisk = JSON.parse(fs.readFileSync(planJsonPath, 'utf8')) as Plan;
		expect(onDisk.phases[0].tasks[0].status).toBe('completed');
	});

	test('(ii) canonical ledger file is left completely unchanged (non-destructive)', async () => {
		const { ledgerPath } = seedTruncatedLedger();
		const before = fs.readFileSync(ledgerPath, 'utf8');

		await loadPlan(testDir);

		const after = fs.readFileSync(ledgerPath, 'utf8');
		expect(after).toBe(before);
		// The poison line is still present — the ledger was not "healed"/truncated.
		expect(after).toContain('POISON');
	});

	test('(ii-b) the corrupted suffix is quarantined to a side file (canonical ledger untouched)', async () => {
		seedTruncatedLedger();

		await loadPlan(testDir);

		const quarantineFiles = fs
			.readdirSync(path.join(testDir, '.swarm'))
			.filter((f) => f.startsWith('plan-ledger.quarantine.'));
		expect(quarantineFiles.length).toBeGreaterThanOrEqual(1);
	});
});

describe('M1: replayFromLedgerWithStatus threads the truncated flag', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-replay-status-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	test('returns truncated=true and a prefix-only plan when the ledger has a poison line', async () => {
		const planPending = makePlan('pending');
		const planId = derivePlanId(planPending);
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');

		const created: LedgerEvent = {
			seq: 1,
			timestamp: '2026-01-01T00:00:00.000Z',
			plan_id: planId,
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'H1',
			schema_version: '1.1.0',
			payload: { plan: planPending, payload_hash: 'H1' },
		};
		const toInProgress: LedgerEvent = {
			seq: 2,
			timestamp: '2026-01-01T00:00:01.000Z',
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'in_progress',
			source: 'test',
			plan_hash_before: 'H1',
			plan_hash_after: 'H2',
			schema_version: '1.1.0',
		};
		fs.writeFileSync(
			ledgerPath,
			ledgerLine(created) + ledgerLine(toInProgress) + '{ POISON\n',
			'utf8',
		);

		const { plan, truncated, badSuffix } =
			await replayFromLedgerWithStatus(testDir);

		expect(truncated).toBe(true);
		expect(badSuffix).toContain('POISON');
		expect(plan).not.toBeNull();
		// Prefix-only reconstruction: the pre-poison in_progress transition applied.
		expect(plan!.phases[0].tasks[0].status).toBe('in_progress');
	});

	test('returns truncated=false on a clean ledger', async () => {
		writePlanJson(testDir, makePlan('pending'));
		await initLedger(testDir, derivePlanId(makePlan('pending')));

		const { truncated, badSuffix } = await replayFromLedgerWithStatus(testDir);
		expect(truncated).toBe(false);
		expect(badSuffix).toBeNull();
	});
});

describe('M1: folded engine still bootstraps a legacy plan_created embedded plan', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-bootstrap-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	test('(v) reconstructs plan from the embedded plan_created payload without plan.json, applying later deltas', async () => {
		const planPending = makePlan('pending');
		const planId = derivePlanId(planPending);
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');

		const created: LedgerEvent = {
			seq: 1,
			timestamp: '2026-01-01T00:00:00.000Z',
			plan_id: planId,
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'H1',
			schema_version: '1.1.0',
			payload: { plan: planPending, payload_hash: 'H1' },
		};
		const toCompleted: LedgerEvent = {
			seq: 2,
			timestamp: '2026-01-01T00:00:01.000Z',
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'completed',
			source: 'test',
			plan_hash_before: 'H1',
			plan_hash_after: 'H2',
			schema_version: '1.1.0',
		};
		// NOTE: deliberately NO plan.json — the ledger must be self-sufficient.
		fs.writeFileSync(
			ledgerPath,
			ledgerLine(created) + ledgerLine(toCompleted),
			'utf8',
		);

		const plan = await replayFromLedger(testDir);

		expect(plan).not.toBeNull();
		expect(plan!.title).toBe('M1 Truncation Plan');
		// Delta after the embedded-plan bootstrap was applied.
		expect(plan!.phases[0].tasks[0].status).toBe('completed');
	});
});

describe('M1: fsync-before-rename durability smoke test', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-fsync-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	test('(iv) initLedger + appendLedgerEvent produce a durable, readable ledger and leave no temp files behind', async () => {
		writePlanJson(testDir, makePlan('pending'));
		const planId = derivePlanId(makePlan('pending'));

		await initLedger(testDir, planId);
		const appended = await appendLedgerEvent(testDir, {
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			from_status: 'pending',
			to_status: 'in_progress',
			source: 'test',
		});
		expect(appended.seq).toBe(2);

		// The bytes are durably readable (fsync ran before the publishing rename).
		const events = await readLedgerEvents(testDir);
		expect(events).toHaveLength(2);
		expect(events[0].event_type).toBe('plan_created');
		expect(events[1].event_type).toBe('task_status_changed');
		expect(events[1].to_status).toBe('in_progress');

		// The atomic temp files were renamed away — no `.tmp.` residue remains.
		const leftovers = fs
			.readdirSync(path.join(testDir, '.swarm'))
			.filter((f) => f.includes('.tmp.'));
		expect(leftovers).toHaveLength(0);
	});
});
