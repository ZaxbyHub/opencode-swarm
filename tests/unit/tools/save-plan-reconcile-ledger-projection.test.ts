import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	computePlanHash,
	_internals as ledgerInternals,
	readLedgerEvents,
	replayFromLedger,
} from '../../../src/plan/ledger';
import {
	loadPlan,
	resetStartupLedgerCheck,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import {
	executeSavePlan,
	isPureLedgerProjectionReconcileRequest,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';

function makePlan(taskStatus: Plan['phases'][0]['tasks'][0]['status']): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Reconcile Plan',
		swarm: 'reconcile-swarm',
		current_phase: 1,
		migration_status: 'native',
		execution_profile: {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: false,
			auto_proceed: false,
			commit_after_each_completed_task: false,
			planning_profile: 'balanced',
		},
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: taskStatus === 'completed' ? 'complete' : 'in_progress',
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

function ledgerLine(event: Record<string, unknown>): string {
	return `${JSON.stringify(event)}\n`;
}

function seedTruncatedLedger(dir: string): void {
	const planCompleted = makePlan('completed');
	fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planCompleted, null, 2),
		'utf8',
	);
	const ledgerPath = join(dir, '.swarm', 'plan-ledger.jsonl');
	const created = {
		seq: 1,
		timestamp: '2026-08-14T00:00:00.000Z',
		plan_id: 'reconcile-swarm-Reconcile_Plan',
		event_type: 'plan_created',
		source: 'test',
		plan_hash_before: '',
		plan_hash_after: 'H1',
		schema_version: '1.1.0',
		payload: { plan: makePlan('pending') },
	};
	const toInProgress = {
		seq: 2,
		timestamp: '2026-08-14T00:00:01.000Z',
		plan_id: 'reconcile-swarm-Reconcile_Plan',
		event_type: 'task_status_changed',
		task_id: '1.1',
		phase_id: 1,
		from_status: 'pending',
		to_status: 'in_progress',
		source: 'test',
		plan_hash_before: 'H1',
		plan_hash_after: 'H2',
		schema_version: '1.1.0',
	};
	const toCompleted = {
		seq: 3,
		timestamp: '2026-08-14T00:00:02.000Z',
		plan_id: 'reconcile-swarm-Reconcile_Plan',
		event_type: 'task_status_changed',
		task_id: '1.1',
		phase_id: 1,
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
			'{ POISON - not valid json\n' +
			ledgerLine(toCompleted),
		'utf8',
	);
}

function seedSemanticUnknownEventLedger(
	dir: string,
	projectedStatus: Plan['phases'][0]['tasks'][0]['status'] = 'completed',
): Plan {
	const projectedPlan = makePlan(projectedStatus);
	projectedPlan.migration_status = 'migrated';
	projectedPlan.specMtime = '2026-08-14T00:00:00.000Z';
	projectedPlan.specHash = 'a'.repeat(64);
	projectedPlan.phases[0].type = 'non-code';
	projectedPlan.phases[0].required_agents = ['docs'];
	projectedPlan.phases[0].tasks[0].size = 'medium';
	projectedPlan.phases[0].tasks[0].acceptance = 'Recovery remains reachable';
	projectedPlan.phases[0].tasks[0].evidence_path = '.swarm/evidence/1.1.json';
	projectedPlan.phases[0].tasks[0].blocked_reason =
		'Preserved metadata fixture';
	projectedPlan.phases[0].tasks[0].fr_refs = ['FR-2098'];
	const initialPlan = makePlan('pending');
	const planId = 'reconcile-swarm-Reconcile_Plan';
	const initialHash = computePlanHash(initialPlan);
	const inProgressPlan = makePlan('in_progress');
	const inProgressHash = computePlanHash(inProgressPlan);
	const unknownTailHash = 'SEMANTIC_UNKNOWN_TAIL_HASH';

	fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(projectedPlan, null, 2),
		'utf8',
	);
	fs.writeFileSync(
		join(dir, '.swarm', 'plan-ledger.jsonl'),
		[
			{
				seq: 1,
				timestamp: '2026-08-14T00:00:00.000Z',
				plan_id: planId,
				event_type: 'plan_created',
				source: 'test',
				plan_hash_before: '',
				plan_hash_after: initialHash,
				schema_version: '1.1.0',
				payload: { plan: initialPlan, payload_hash: initialHash },
			},
			{
				seq: 2,
				timestamp: '2026-08-14T00:00:01.000Z',
				plan_id: planId,
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
				plan_hash_before: initialHash,
				plan_hash_after: inProgressHash,
				schema_version: '1.1.0',
			},
			{
				seq: 3,
				timestamp: '2026-08-14T00:00:02.000Z',
				plan_id: planId,
				// A valid JSON/hash-chained event that this reader does not understand.
				// Before the fix, reconcile called ordinary savePlan, replay reached this
				// event again, and threw before any healing snapshot could be written.
				event_type: 'future_semantic_event',
				source: 'future-writer',
				plan_hash_before: inProgressHash,
				plan_hash_after: unknownTailHash,
				schema_version: '99.0.0',
				payload: { preserved_for_future_reader: true },
			},
		]
			.map(ledgerLine)
			.join(''),
		'utf8',
	);
	return projectedPlan;
}

function makeArgs(dir: string, description = 'Task one'): SavePlanArgs {
	return {
		title: 'Reconcile Plan',
		swarm_id: 'reconcile-swarm',
		working_directory: dir,
		reconcile_ledger_projection: true,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [{ id: '1.1', description }],
			},
		],
	};
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'save-plan-reconcile-'));
	resetStartupLedgerCheck();
	await mkdir(join(tmpDir, '.swarm'), { recursive: true });
	await writeFile(join(tmpDir, '.swarm', 'spec.md'), '# Spec\n', 'utf8');
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
});

afterEach(async () => {
	delete process.env.SWARM_SKIP_SPEC_GATE;
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	closeProjectDb(tmpDir);
	resetStartupLedgerCheck();
	await rm(tmpDir, { recursive: true, force: true });
});

describe('reconcile_ledger_projection', () => {
	test('pure predicate only allows the narrow recovery shape', () => {
		expect(isPureLedgerProjectionReconcileRequest(makeArgs(tmpDir))).toBe(true);
		expect(
			isPureLedgerProjectionReconcileRequest({
				...makeArgs(tmpDir),
				reset_statuses: true,
			}),
		).toBe(false);
	});

	test('re-saves an unchanged stale projection and appends a fresh snapshot', async () => {
		seedTruncatedLedger(tmpDir);
		const ledgerPath = join(tmpDir, '.swarm', 'plan-ledger.jsonl');
		const originalLedger = fs.readFileSync(ledgerPath, 'utf8');

		const result = await executeSavePlan(makeArgs(tmpDir));
		expect(result.success).toBe(true);

		const events = await readLedgerEvents(tmpDir);
		expect(events[0]?.source).toBe('save_plan_truncated_ledger_reconcile');
		expect(events[events.length - 1]?.event_type).toBe('snapshot');
		const recovery = (events[0]?.payload as Record<string, unknown> | undefined)
			?.recovery as Record<string, unknown> | undefined;
		expect(recovery?.kind).toBe('truncated_ledger_reconcile');
		expect(recovery?.prior_tail_seq).toBe(3);
		expect(recovery?.prior_tail_hash).toBe(
			'SENTINEL_LEDGER_HASH_NEVER_MATCHES',
		);

		const archives = fs
			.readdirSync(join(tmpDir, '.swarm'))
			.filter((name) => name.startsWith('plan-ledger.reconcile-archive.'));
		expect(archives).toHaveLength(1);
		expect(recovery?.archived_ledger).toBe(`.swarm/${archives[0]}`);
		expect(recovery?.archived_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(fs.readFileSync(join(tmpDir, '.swarm', archives[0]), 'utf8')).toBe(
			originalLedger,
		);

		// Simulate a fresh process: replay must start from the replacement root,
		// not rely on the in-memory stale-workspace self-heal marker.
		resetStartupLedgerCheck();
		const replayed = await replayFromLedger(tmpDir);
		expect(replayed?.phases[0].tasks[0].status).toBe('completed');

		const reloaded = await loadPlan(tmpDir);
		expect(reloaded?._ledgerReplayStale).not.toBe(true);
		expect(reloaded?.phases[0].tasks[0].status).toBe('completed');
	});

	test('heals a parseable unknown event by appending an exact CAS-bound authoritative snapshot', async () => {
		const projectedPlan = seedSemanticUnknownEventLedger(tmpDir);

		// Falsifiability check: without the recovery snapshot, the real replay
		// rejects this fixture at the semantic event rather than silently skipping it.
		await expect(replayFromLedger(tmpDir)).rejects.toThrow(
			'unhandled event type "future_semantic_event"',
		);
		const stale = await loadPlan(tmpDir);
		expect(stale?._ledgerReplayStale).toBe(true);
		expect(stale?.phases[0].tasks[0].status).toBe('completed');

		const result = await executeSavePlan(makeArgs(tmpDir));
		expect(result.success).toBe(true);

		const events = await readLedgerEvents(tmpDir);
		const recovery = events.find(
			(event) => event.source === 'save_plan_stale_projection_reconcile',
		);
		expect(recovery).toBeDefined();
		expect(recovery?.event_type).toBe('snapshot');
		expect(recovery?.seq).toBe(4);
		expect(recovery?.plan_hash_before).toBe('SEMANTIC_UNKNOWN_TAIL_HASH');
		expect(recovery?.plan_hash_after).toBe(computePlanHash(projectedPlan));

		const recoveredSnapshot = recovery?.payload as
			| { plan?: Plan; payload_hash?: string }
			| undefined;
		expect(recoveredSnapshot?.plan).toEqual(projectedPlan);
		expect(recoveredSnapshot?.payload_hash).toBe(
			computePlanHash(projectedPlan),
		);
		for (let index = 1; index < events.length; index++) {
			expect(events[index].plan_hash_before).toBe(
				events[index - 1].plan_hash_after,
			);
		}

		resetStartupLedgerCheck();
		const reloaded = await loadPlan(tmpDir);
		expect(reloaded?._ledgerReplayStale).not.toBe(true);
		expect(reloaded?.phases[0].tasks[0].status).toBe('completed');
	});

	test('preserves the old canonical ledger when replacement fails after archive durability', async () => {
		seedTruncatedLedger(tmpDir);
		const ledgerPath = join(tmpDir, '.swarm', 'plan-ledger.jsonl');
		const originalLedger = fs.readFileSync(ledgerPath, 'utf8');
		const realWrite = ledgerInternals.writeFileFsyncedThenRename;
		const realDirectoryFsync = ledgerInternals.fsyncRecoveryDirectory;
		let writeCount = 0;
		const durabilityOrder: string[] = [];
		// Only the canonical-replacement write is failed. Untested here: failure
		// of the archive write itself, which trivially leaves canonical untouched.
		ledgerInternals.writeFileFsyncedThenRename = (...args) => {
			writeCount++;
			durabilityOrder.push(
				String(args[1]).includes('reconcile-archive')
					? 'archive-write'
					: 'canonical-write',
			);
			if (writeCount === 2) {
				throw new Error('simulated canonical replacement failure');
			}
			return realWrite(...args);
		};
		ledgerInternals.fsyncRecoveryDirectory = (directory) => {
			durabilityOrder.push('directory-fsync');
			return realDirectoryFsync(directory);
		};

		try {
			const result = await executeSavePlan(makeArgs(tmpDir));
			expect(result.success).toBe(false);
			expect(result.errors?.join('\n')).toContain(
				'simulated canonical replacement failure',
			);
		} finally {
			ledgerInternals.writeFileFsyncedThenRename = realWrite;
			ledgerInternals.fsyncRecoveryDirectory = realDirectoryFsync;
		}

		expect(durabilityOrder).toEqual([
			'archive-write',
			'directory-fsync',
			'canonical-write',
		]);
		expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(originalLedger);
		const archives = fs
			.readdirSync(join(tmpDir, '.swarm'))
			.filter((name) => name.startsWith('plan-ledger.reconcile-archive.'));
		expect(archives).toHaveLength(1);
		expect(fs.readFileSync(join(tmpDir, '.swarm', archives[0]), 'utf8')).toBe(
			originalLedger,
		);

		const retry = await executeSavePlan(makeArgs(tmpDir));
		expect(retry.success).toBe(true);
		const archivesAfterRetry = fs
			.readdirSync(join(tmpDir, '.swarm'))
			.filter((name) => name.startsWith('plan-ledger.reconcile-archive.'));
		expect(archivesAfterRetry).toEqual(archives);
		resetStartupLedgerCheck();
		expect((await loadPlan(tmpDir))?._ledgerReplayStale).not.toBe(true);
	});

	test('restores ordinary task completion reachability after semantic replay recovery', async () => {
		seedSemanticUnknownEventLedger(tmpDir, 'in_progress');

		const result = await executeSavePlan(makeArgs(tmpDir));
		expect(result.success).toBe(true);
		resetStartupLedgerCheck();

		const completed = await updateTaskStatus(tmpDir, '1.1', 'completed');
		expect(completed.phases[0].tasks[0].status).toBe('completed');
		resetStartupLedgerCheck();
		const reloaded = await loadPlan(tmpDir);
		expect(reloaded?._ledgerReplayStale).not.toBe(true);
		expect(reloaded?.phases[0].tasks[0].status).toBe('completed');
	});

	test('manager sink rejects changed content even when a caller supplies the recovery option directly', async () => {
		const projected = seedSemanticUnknownEventLedger(tmpDir);
		const changed = structuredClone(projected);
		changed.phases[0].tasks[0].description = 'Changed behind tool guard';

		await expect(
			savePlan(tmpDir, changed, {
				staleProjectionReconcile: {
					expectedSeq: 3,
					expectedLedgerHash: 'SEMANTIC_UNKNOWN_TAIL_HASH',
				},
			}),
		).rejects.toThrow('RECONCILE_LEDGER_PROJECTION_MISMATCH');

		const events = await readLedgerEvents(tmpDir);
		expect(
			events.some(
				(event) => event.source === 'save_plan_stale_projection_reconcile',
			),
		).toBe(false);
	});

	test('manager sink rejects a stale ledger-tail binding without appending recovery evidence', async () => {
		const projected = seedSemanticUnknownEventLedger(tmpDir);

		await expect(
			savePlan(tmpDir, projected, {
				staleProjectionReconcile: {
					expectedSeq: 2,
					expectedLedgerHash: 'SEMANTIC_UNKNOWN_TAIL_HASH',
				},
			}),
		).rejects.toThrow('RECONCILE_LEDGER_PROJECTION_STALE');

		const events = await readLedgerEvents(tmpDir);
		expect(events).toHaveLength(3);
	});

	test('rejects semantic edits during reconcile mode', async () => {
		seedTruncatedLedger(tmpDir);

		const result = await executeSavePlan(makeArgs(tmpDir, 'Changed task text'));
		expect(result.success).toBe(false);
		expect(result.message).toContain('RECONCILE_LEDGER_PROJECTION_MISMATCH');
	});

	test('rejects reconcile mode when incompatible top-level overrides are present', async () => {
		const result = await executeSavePlan({
			...makeArgs(tmpDir),
			reset_statuses: true,
		});
		expect(result.success).toBe(false);
		expect(result.message).toContain('RECONCILE_LEDGER_PROJECTION_INVALID');
	});
});
