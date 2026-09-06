import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as realFs from 'node:fs';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import * as realHookUtils from '../../../src/hooks/utils.js';
import { peekPlanFromLedger } from '../../../src/plan/ledger';
import { savePlan } from '../../../src/plan/manager';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const nowIso = (): string => withFrozenClock(() => new Date().toISOString());

// Mock validateSwarmPath before importing rollback.ts (it binds at module load)
mock.module('../../../src/hooks/utils.js', () => ({
	...realHookUtils,
	validateSwarmPath: (directory: string, filename: string) =>
		path.join(directory, '.swarm', filename),
}));

const { handleRollbackCommand, _internals: rollbackInternals } = await import(
	'../../../src/commands/rollback.js'
);

let testDir: string;

function getSwarmDir(): string {
	return path.join(testDir, '.swarm');
}

function getManifestPath(): string {
	return path.join(testDir, '.swarm', 'checkpoints', 'manifest.json');
}

function getCheckpointDir(phase: number): string {
	return path.join(testDir, '.swarm', 'checkpoints', 'phase-' + phase);
}

function createManifest(
	checkpoints: Array<{ phase: number; label?: string; timestamp: string }>,
) {
	const checkpointsDir = path.join(testDir, '.swarm', 'checkpoints');
	mkdirSync(checkpointsDir, { recursive: true });
	writeFileSync(getManifestPath(), JSON.stringify({ checkpoints }));
}

function createValidPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Rollback test plan',
		swarm: 'rollback-ledger-test',
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
						description: 'Restore the rollback fixture',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function createRollbackCheckpoint(plan: Plan = createValidPlan()) {
	createManifest([
		{
			phase: 1,
			label: 'Phase 1 complete',
			timestamp: nowIso(),
		},
	]);
	const checkpointDir = getCheckpointDir(1);
	mkdirSync(checkpointDir, { recursive: true });
	writeFileSync(path.join(checkpointDir, 'plan.md'), '# Rollback test plan\n');
	writeFileSync(path.join(checkpointDir, 'plan.json'), JSON.stringify(plan));
}

beforeEach(() => {
	testDir = canonicalMkdtemp('rollback-ledger-test-');
	mkdirSync(getSwarmDir(), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	mock.restore();
});

describe('handleRollbackCommand — ledger replacement failure (issue #2484)', () => {
	it('surfaces replacement failures instead of throwing raw EBUSY', async () => {
		const replacementError = Object.assign(new Error('EBUSY: resource busy'), {
			code: 'EBUSY',
		});
		const originalReplace = rollbackInternals.replacePlanLedgerWithRoot;
		rollbackInternals.replacePlanLedgerWithRoot = async () => {
			throw replacementError;
		};

		try {
			createRollbackCheckpoint();
			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('failed to replace the authoritative ledger');
			expect(result).toContain('EBUSY');
			// The checkpoint projection must remain staged until its replacement
			// authority commits; the old implementation copied it before this throw.
			expect(existsSync(path.join(getSwarmDir(), 'plan.json'))).toBe(false);
		} finally {
			rollbackInternals.replacePlanLedgerWithRoot = originalReplace;
		}
	});

	it('reports that checkpoint projections were withheld on re-root failure', async () => {
		const originalReplace = rollbackInternals.replacePlanLedgerWithRoot;
		rollbackInternals.replacePlanLedgerWithRoot = async () => {
			throw new Error('ledger locked');
		};

		try {
			createRollbackCheckpoint();
			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('ledger locked');
			expect(result).toContain(
				'Checkpoint plan projections were not published',
			);
		} finally {
			rollbackInternals.replacePlanLedgerWithRoot = originalReplace;
		}
	});

	it('passes the restored valid Plan to the replacement API', async () => {
		const plan = createValidPlan();
		const calls: Array<[string, Plan, string]> = [];
		const originalReplace = rollbackInternals.replacePlanLedgerWithRoot;
		rollbackInternals.replacePlanLedgerWithRoot = async (...args) => {
			calls.push(args);
		};

		try {
			createRollbackCheckpoint(plan);
			const result = await handleRollbackCommand(testDir, ['1']);

			expect(result).toContain('Rolled back to phase 1: Phase 1 complete');
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[0]).toBe(testDir);
			expect(calls[0]?.[1]).toEqual(plan);
			expect(calls[0]?.[2]).toBe('rollback');
		} finally {
			rollbackInternals.replacePlanLedgerWithRoot = originalReplace;
		}
	});

	it('compensates authority and projections when checkpoint projection publish fails', async () => {
		const priorPlan = createValidPlan();
		priorPlan.title = 'Before rollback';
		const checkpointPlan = createValidPlan();
		checkpointPlan.title = 'Checkpoint rollback';
		await savePlan(testDir, priorPlan);
		createRollbackCheckpoint(checkpointPlan);

		const originalCopy = realFs.cpSync;
		spyOn(realFs, 'cpSync').mockImplementation(
			(source, destination, options) => {
				if (String(destination).endsWith(`${path.sep}plan.json`)) {
					throw new Error('simulated projection publish failure');
				}
				return originalCopy(source, destination, options);
			},
		);

		const result = await handleRollbackCommand(testDir, ['1']);

		expect(result).toContain('failed to replace the authoritative ledger');
		expect(result).toContain('compensation completed');
		expect(
			JSON.parse(
				realFs.readFileSync(path.join(getSwarmDir(), 'plan.json'), 'utf-8'),
			).title,
		).toBe('Before rollback');
		expect((await peekPlanFromLedger(testDir)).plan?.title).toBe(
			'Before rollback',
		);
	});

	it('restores an empty authority when first-plan projection publication fails', async () => {
		const checkpointPlan = createValidPlan();
		checkpointPlan.title = 'First checkpoint plan';
		createRollbackCheckpoint(checkpointPlan);

		const originalCopy = realFs.cpSync;
		spyOn(realFs, 'cpSync').mockImplementation(
			(source, destination, options) => {
				if (String(destination).endsWith(`${path.sep}plan.json`)) {
					throw new Error('simulated first projection failure');
				}
				return originalCopy(source, destination, options);
			},
		);

		const result = await handleRollbackCommand(testDir, ['1']);

		expect(result).toContain('compensation failed');
		expect(existsSync(path.join(getSwarmDir(), 'plan.json'))).toBe(false);
		expect((await peekPlanFromLedger(testDir)).plan).toBeNull();
	});

	it('read-only previews hide ledger state while reset is in progress', async () => {
		await savePlan(testDir, createValidPlan());
		writeFileSync(
			path.join(getSwarmDir(), 'plan-ledger.resetting'),
			'resetting\n',
		);

		expect((await peekPlanFromLedger(testDir)).plan).toBeNull();
	});
});
