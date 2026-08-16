import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { getOrAdoptPlanEpochUnderLock } from '../../../src/plan/ledger';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import {
	recoverPreparedTaskTerminal,
	_internals as terminalInternals,
} from '../../../src/workflow/task-terminal';
import { writeWorkflowWalFile } from '../../../src/workflow/workflow-wal-file';
import type { TaskTerminalWal } from '../../../src/workflow/workflow-wal-schema';
import { seedStageBGates } from '../../helpers/task-workflow-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Close terminal recovery',
		swarm: 'test-swarm',
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
						description: 'Recover truthful close',
						depends: [],
						files_touched: ['src/close.ts'],
					},
				],
			},
		],
	};
}

describe('issue #2098 close terminal v2 recovery', () => {
	let directory: string;
	let walPath: string;
	let wal: TaskTerminalWal;
	let originalApply: typeof terminalInternals.applyTerminalEvidence;

	beforeEach(async () => {
		directory = canonicalMkdtemp('close-terminal-recovery-2098-');
		fs.mkdirSync(path.join(directory, '.git'));
		await savePlan(directory, plan());
		const generation = await seedStageBGates(directory, '1.1');
		const currentPlan = await loadPlanJsonOnly(directory);
		if (!currentPlan) throw new Error('fixture plan missing');
		const identity = await getOrAdoptPlanEpochUnderLock(directory, currentPlan);
		walPath = path.join(directory, '.swarm', 'task-terminals', '1.1.json');
		wal = {
			version: 2,
			state: 'PREPARED',
			taskId: '1.1',
			transitionId: 'close-recovery:1.1',
			actor: 'close-recovery-test',
			oldPlanStatus: 'in_progress',
			newPlanStatus: 'closed',
			oldWorkflowState: 'tests_run',
			newWorkflowState: 'closed',
			generation,
			qaExempt: false,
			recordedAt: '2026-08-15T00:00:00.000Z',
			planIdentityHash: identity.planIdentityHash,
			planEpoch: identity.planEpoch,
		};
		await writeWorkflowWalFile('task-terminal', walPath, wal);
		originalApply = terminalInternals.applyTerminalEvidence;
	});

	afterEach(() => {
		terminalInternals.applyTerminalEvidence = originalApply;
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('finishes PREPARED old-plan/old-evidence instead of abandoning close', async () => {
		const result = await recoverPreparedTaskTerminal(
			directory,
			'1.1',
			'close-recovery-test',
		);

		expect(result?.targetStatus).toBe('closed');
		expect(
			(await loadPlanJsonOnly(directory))?.phases[0]?.tasks[0]?.status,
		).toBe('closed');
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow?.state).toBe(
			'closed',
		);
		expect(JSON.parse(fs.readFileSync(walPath, 'utf8')).state).toBe(
			'COMMITTED',
		);
	});

	test('returns null without requiring a plan when no PREPARED WAL exists', async () => {
		fs.rmSync(walPath);
		fs.rmSync(path.join(directory, '.swarm', 'plan.json'));
		fs.rmSync(path.join(directory, '.swarm', 'plan-ledger.jsonl'));

		expect(
			await recoverPreparedTaskTerminal(
				directory,
				'1.1',
				'close-recovery-test',
			),
		).toBeNull();
	});

	test('holds plan.json until delayed exact-evidence recovery settles', async () => {
		let markEntered!: () => void;
		let releaseApply!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const applyReleased = new Promise<void>((resolve) => {
			releaseApply = resolve;
		});
		terminalInternals.applyTerminalEvidence = async (...args) => {
			markEntered();
			await applyReleased;
			return originalApply(...args);
		};

		const recovery = recoverPreparedTaskTerminal(
			directory,
			'1.1',
			'close-recovery-test',
		);
		await entered;
		const contender = await tryAcquireLock(
			directory,
			'plan.json',
			'contender',
			'contender-during-terminal-recovery',
		);
		try {
			expect(contender.acquired).toBe(false);
		} finally {
			if (contender.acquired && contender.lock._release) {
				await contender.lock._release();
			}
			releaseApply();
		}
		await recovery;
	});

	test('finishes PREPARED new-plan/old-evidence exactly once', async () => {
		await updateTaskStatus(directory, '1.1', 'closed', {
			terminalReconciliation: true,
		});
		const first = await recoverPreparedTaskTerminal(
			directory,
			'1.1',
			'close-recovery-test',
		);
		const second = await recoverPreparedTaskTerminal(
			directory,
			'1.1',
			'close-recovery-test',
		);

		expect(first?.evidence.workflow).toMatchObject({
			state: 'closed',
			lastTransitionId: 'close-recovery:1.1',
		});
		expect(second).toBeNull();
	});

	test('finishes PREPARED old-plan/new-evidence without duplicating evidence', async () => {
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_closed',
			expectedGeneration: wal.generation,
			transitionId: wal.transitionId,
		});
		const evidenceBefore = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
		);

		await recoverPreparedTaskTerminal(directory, '1.1', 'close-recovery-test');

		expect(
			fs.readFileSync(path.join(directory, '.swarm', 'evidence', '1.1.json')),
		).toEqual(evidenceBefore);
		expect(
			(await loadPlanJsonOnly(directory))?.phases[0]?.tasks[0]?.status,
		).toBe('closed');
	});

	test('rejects a valid foreign plan epoch without mutating plan, ledger, or evidence', async () => {
		await writeWorkflowWalFile('task-terminal', walPath, {
			...wal,
			planEpoch: '11111111-1111-4111-8111-111111111111',
		});
		const tracked = [
			path.join(directory, '.swarm', 'plan.json'),
			path.join(directory, '.swarm', 'plan-ledger.jsonl'),
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
			walPath,
		];
		const before = tracked.map((file) => fs.readFileSync(file));

		await expect(
			recoverPreparedTaskTerminal(directory, '1.1', 'close-recovery-test'),
		).rejects.toThrow('TASK_TERMINAL_PLAN_IDENTITY_MISMATCH');

		tracked.forEach((file, index) => {
			expect(fs.readFileSync(file)).toEqual(before[index]);
		});
	});
});
