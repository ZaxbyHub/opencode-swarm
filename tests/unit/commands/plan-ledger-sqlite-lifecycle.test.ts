import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	handleResetCommand,
	_internals as resetInternals,
} from '../../../src/commands/reset';
import {
	handleRollbackCommand,
	_internals as rollbackInternals,
} from '../../../src/commands/rollback';
import type { Plan } from '../../../src/config/plan-schema';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const nowIso = (): string => withFrozenClock(() => new Date().toISOString());

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Lifecycle plan',
		swarm: 'lifecycle-test',
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
						description: 'Lifecycle task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

describe('plan-ledger lifecycle transitions (#2531)', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('plan-ledger-lifecycle-');
		await mkdir(join(directory, '.swarm', 'checkpoints', 'phase-1'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test('reset holds the lifecycle lock while clearing authority and projections', async () => {
		const order: string[] = [];
		await writeFile(join(directory, '.swarm', 'plan.json'), '{}');
		const ledgerPath = join(directory, '.swarm', 'plan-ledger.jsonl');
		await writeFile(ledgerPath, 'old-ledger\n');
		const originalBackup = resetInternals.backupSwarmStateBeforeReset;
		const originalClear = resetInternals.clearPlanLedgerForReset;
		const originalLifecycle = resetInternals.withPlanLifecycleLock;
		resetInternals.backupSwarmStateBeforeReset = () => {
			order.push('backup');
			return {
				backupDir: join(directory, '.swarm', 'reset-backups', 'reset-test'),
				copied: ['plan-ledger.jsonl'],
				warnings: [],
			};
		};
		resetInternals.clearPlanLedgerForReset = async () => {
			order.push('clear');
			await rm(ledgerPath);
		};
		resetInternals.withPlanLifecycleLock = async (_dir, _task, fn) => {
			order.push('lifecycle:start');
			const result = await fn();
			order.push('lifecycle:end');
			return result;
		};

		try {
			const result = await handleResetCommand(directory, ['--confirm']);

			expect(order).toEqual([
				'backup',
				'lifecycle:start',
				'clear',
				'lifecycle:end',
			]);
			expect(result).toContain('Cleared authoritative plan ledger');
			expect(existsSync(join(directory, '.swarm', 'plan.json'))).toBe(false);
			expect(existsSync(ledgerPath)).toBe(false);
		} finally {
			resetInternals.backupSwarmStateBeforeReset = originalBackup;
			resetInternals.clearPlanLedgerForReset = originalClear;
			resetInternals.withPlanLifecycleLock = originalLifecycle;
		}
	});

	test('reset aborts visibly when authority cleanup fails and preserves projections', async () => {
		await writeFile(join(directory, '.swarm', 'plan.json'), '{}');
		const originalBackup = resetInternals.backupSwarmStateBeforeReset;
		const originalClear = resetInternals.clearPlanLedgerForReset;
		const originalLifecycle = resetInternals.withPlanLifecycleLock;
		resetInternals.backupSwarmStateBeforeReset = () => ({
			backupDir: join(directory, '.swarm', 'reset-backups', 'reset-test'),
			copied: ['plan-ledger.jsonl'],
			warnings: [],
		});
		resetInternals.clearPlanLedgerForReset = async () => {
			throw new Error('ledger locked');
		};
		resetInternals.withPlanLifecycleLock = async (_dir, _task, fn) => fn();

		try {
			const result = await handleResetCommand(directory, ['--confirm']);

			expect(result).toContain('Swarm Reset Aborted');
			expect(result).toContain('ledger locked');
			expect(existsSync(join(directory, '.swarm', 'plan.json'))).toBe(true);
		} finally {
			resetInternals.backupSwarmStateBeforeReset = originalBackup;
			resetInternals.clearPlanLedgerForReset = originalClear;
			resetInternals.withPlanLifecycleLock = originalLifecycle;
		}
	});

	test('rollback replaces the ledger root from the restored plan', async () => {
		const plan = makePlan();
		const checkpointDir = join(directory, '.swarm', 'checkpoints', 'phase-1');
		await writeFile(
			join(directory, '.swarm', 'checkpoints', 'manifest.json'),
			JSON.stringify({
				checkpoints: [{ phase: 1, label: 'root', timestamp: nowIso() }],
			}),
		);
		await writeFile(join(checkpointDir, 'plan.json'), JSON.stringify(plan));
		await writeFile(join(checkpointDir, 'plan.md'), '# Lifecycle plan\n');

		const calls: unknown[][] = [];
		const originalReplace = rollbackInternals.replacePlanLedgerWithRoot;
		const originalPeek = rollbackInternals.peekPlanFromLedger;
		const originalLifecycle = rollbackInternals.withPlanLifecycleLock;
		rollbackInternals.replacePlanLedgerWithRoot = async (...args) => {
			calls.push(args);
		};
		rollbackInternals.peekPlanFromLedger = async () => ({
			plan: null,
			truncated: false,
			badSuffix: null,
		});
		rollbackInternals.withPlanLifecycleLock = async (_dir, _task, fn) => fn();
		try {
			const result = await handleRollbackCommand(directory, ['1']);

			expect(result).toContain('Rolled back to phase 1');
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[0]).toBe(directory);
			expect(calls[0]?.[1]).toMatchObject({ title: 'Lifecycle plan' });
			expect(calls[0]?.[2]).toBe('rollback');
		} finally {
			rollbackInternals.replacePlanLedgerWithRoot = originalReplace;
			rollbackInternals.peekPlanFromLedger = originalPeek;
			rollbackInternals.withPlanLifecycleLock = originalLifecycle;
		}
	});

	test('rollback surfaces a failed ledger replacement after restoring projections', async () => {
		const plan = makePlan();
		const checkpointDir = join(directory, '.swarm', 'checkpoints', 'phase-1');
		await writeFile(
			join(directory, '.swarm', 'checkpoints', 'manifest.json'),
			JSON.stringify({
				checkpoints: [{ phase: 1, label: 'root', timestamp: nowIso() }],
			}),
		);
		await writeFile(join(checkpointDir, 'plan.json'), JSON.stringify(plan));

		const originalReplace = rollbackInternals.replacePlanLedgerWithRoot;
		const originalPeek = rollbackInternals.peekPlanFromLedger;
		const originalLifecycle = rollbackInternals.withPlanLifecycleLock;
		rollbackInternals.replacePlanLedgerWithRoot = mock(async () => {
			throw new Error('ledger locked');
		});
		rollbackInternals.peekPlanFromLedger = async () => ({
			plan: null,
			truncated: false,
			badSuffix: null,
		});
		rollbackInternals.withPlanLifecycleLock = async (_dir, _task, fn) => fn();
		try {
			const result = await handleRollbackCommand(directory, ['1']);

			expect(result).toContain('failed to replace the authoritative ledger');
			expect(result).toContain('ledger locked');
		} finally {
			rollbackInternals.replacePlanLedgerWithRoot = originalReplace;
			rollbackInternals.peekPlanFromLedger = originalPeek;
			rollbackInternals.withPlanLifecycleLock = originalLifecycle;
		}
	});
});
