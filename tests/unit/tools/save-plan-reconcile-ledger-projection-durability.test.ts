import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	computePlanLedgerHash,
	_internals as ledgerInternals,
	readLedgerEvents,
	replayFromLedger,
} from '../../../src/plan/ledger';
import { loadPlan, resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	executeSavePlan,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function makePlan(status: 'pending' | 'completed'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Raw Ledger Recovery',
		swarm: 'raw-ledger-recovery',
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
				name: 'Recovery',
				status: status === 'completed' ? 'complete' : 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status,
						size: 'small',
						description: 'Preserve raw ledger bytes',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function seedInvalidUtf8Ledger(directory: string): {
	rawLedger: Buffer;
	rawBadSuffix: Buffer;
} {
	const initial = makePlan('pending');
	const projected = makePlan('completed');
	const planId = 'raw-ledger-recovery-Raw_Ledger_Recovery';
	const initialHash = computePlanLedgerHash(initial);
	const created = Buffer.from(
		`${JSON.stringify({
			seq: 1,
			timestamp: '2026-08-14T00:00:00.000Z',
			plan_id: planId,
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: initialHash,
			schema_version: '1.1.0',
			payload: { plan: initial, payload_hash: initialHash },
		})}\n`,
		'utf8',
	);
	const invalidLine = Buffer.from([0xff, 0xfe, 0xfd, 0x0a]);
	const validTail = Buffer.from(
		`${JSON.stringify({
			seq: 2,
			timestamp: '2026-08-14T00:00:01.000Z',
			plan_id: planId,
			event_type: 'task_status_changed',
			task_id: '1.1',
			phase_id: 1,
			from_status: 'pending',
			to_status: 'completed',
			source: 'test',
			plan_hash_before: initialHash,
			plan_hash_after: 'RAW_INVALID_UTF8_TAIL_HASH',
			schema_version: '1.1.0',
		})}\n`,
		'utf8',
	);
	const rawBadSuffix = Buffer.concat([invalidLine, validTail]);
	const rawLedger = Buffer.concat([created, rawBadSuffix]);
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(projected, null, 2),
	);
	fs.writeFileSync(join(directory, '.swarm', 'plan-ledger.jsonl'), rawLedger);
	return { rawLedger, rawBadSuffix };
}

function makeArgs(directory: string): SavePlanArgs {
	return {
		title: 'Raw Ledger Recovery',
		swarm_id: 'raw-ledger-recovery',
		working_directory: directory,
		reconcile_ledger_projection: true,
		phases: [
			{
				id: 1,
				name: 'Recovery',
				tasks: [{ id: '1.1', description: 'Preserve raw ledger bytes' }],
			},
		],
	};
}

describe('reconcile_ledger_projection raw-byte durability', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(canonicalTmpDir(), 'save-plan-raw-reconcile-'));
		await mkdir(join(tmpDir, '.swarm'), { recursive: true });
		await writeFile(join(tmpDir, '.swarm', 'spec.md'), '# Spec\n', 'utf8');
		process.env.SWARM_SKIP_SPEC_GATE = '1';
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_SPEC_GATE;
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		closeProjectDb(tmpDir);
		resetStartupLedgerCheck();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test('archives and hashes invalid UTF-8 bytes exactly before restart-safe recovery', async () => {
		const { rawLedger, rawBadSuffix } = seedInvalidUtf8Ledger(tmpDir);
		expect((await loadPlan(tmpDir))?._ledgerReplayStale).toBe(true);

		const result = await executeSavePlan(makeArgs(tmpDir));
		expect(result.success).toBe(true);

		const archiveName = fs
			.readdirSync(join(tmpDir, '.swarm'))
			.find((name) => name.startsWith('plan-ledger.reconcile-archive.'));
		expect(archiveName).toBeDefined();
		const archivedBytes = fs.readFileSync(
			join(tmpDir, '.swarm', archiveName as string),
		);
		expect(archivedBytes.equals(rawLedger)).toBe(true);

		const recoveryRoot = (await readLedgerEvents(tmpDir))[0];
		const recovery = (recoveryRoot.payload as Record<string, unknown>)
			.recovery as Record<string, unknown>;
		expect(recovery.archived_sha256).toBe(
			createHash('sha256').update(rawLedger).digest('hex'),
		);
		expect(recovery.bad_suffix_sha256).toBe(
			createHash('sha256').update(rawBadSuffix).digest('hex'),
		);

		resetStartupLedgerCheck();
		expect((await replayFromLedger(tmpDir))?.phases[0].tasks[0].status).toBe(
			'completed',
		);
		expect((await loadPlan(tmpDir))?._ledgerReplayStale).not.toBe(true);
	});

	test('fails closed before canonical replacement when the archive directory barrier fails', async () => {
		const { rawLedger } = seedInvalidUtf8Ledger(tmpDir);
		const ledgerPath = join(tmpDir, '.swarm', 'plan-ledger.jsonl');
		const realDirectoryFsync = ledgerInternals.fsyncRecoveryDirectory;
		let canonicalWriteAttempted = false;
		const realWrite = ledgerInternals.writeFileFsyncedThenRename;
		ledgerInternals.fsyncRecoveryDirectory = () => {
			throw new Error('simulated directory fsync failure');
		};
		ledgerInternals.writeFileFsyncedThenRename = (...args) => {
			if (!String(args[1]).includes('reconcile-archive')) {
				canonicalWriteAttempted = true;
			}
			return realWrite(...args);
		};

		try {
			const result = await executeSavePlan(makeArgs(tmpDir));
			expect(result.success).toBe(false);
			expect(result.errors?.join('\n')).toContain(
				'simulated directory fsync failure',
			);
		} finally {
			ledgerInternals.fsyncRecoveryDirectory = realDirectoryFsync;
			ledgerInternals.writeFileFsyncedThenRename = realWrite;
		}

		expect(canonicalWriteAttempted).toBe(false);
		expect(fs.readFileSync(ledgerPath).equals(rawLedger)).toBe(true);
	});
});
