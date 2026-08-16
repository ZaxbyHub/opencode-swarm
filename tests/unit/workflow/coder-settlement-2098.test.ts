import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { _internals as taskFileInternals } from '../../../src/evidence/task-file';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import {
	_internals,
	beginCoderSettlement,
	recoverCoderSettlement,
	releaseCoderDispatchOwnership,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import { commitTaskTerminalUnderPlanLock } from '../../../src/workflow/task-terminal';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function writeFile(directory: string, content: string): void {
	const filePath = path.join(directory, 'src', 'feature.ts');
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe('issue #2098 foreground coder settlement WAL', () => {
	let directory = '';
	let cleanup = (): void => {};
	const realRename = taskFileInternals.renameSync;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('coder-settlement-2098-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		writeFile(directory, 'export const feature = 1;\n');
		git(directory, ['add', 'src/feature.ts']);
		git(directory, ['commit', '-m', 'test: seed']);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		taskFileInternals.renameSync = realRename;
		_internals.liveDispatches.clear();
		cleanup();
	});

	function context() {
		return {
			declaredFiles: ['src/feature.ts'],
			baseline: captureWorkspaceSnapshot(directory),
			workflowGeneration: 0,
		};
	}

	test('restart recovery converts an exact shared-root edit into accepted review debt once', async () => {
		await beginCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:restart-edit',
			actor: 'architect',
			expectedGeneration: 0,
			context: context(),
		});
		writeFile(directory, 'export const feature = 2;\n');
		_internals.liveDispatches.clear();

		const recovered = await recoverCoderSettlement(directory, '1.1');
		expect(recovered?.accepted).toBe(true);
		expect(getTaskWorkflowSnapshot(recovered?.evidence ?? null)).toMatchObject({
			state: 'coder_delegated',
			generation: 1,
			lastTransitionId: 'coder:restart-edit',
		});
		expect(await recoverCoderSettlement(directory, '1.1')).toBeNull();
	});

	test('restart recovery records a proven no-op without creating review debt', async () => {
		await beginCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:restart-noop',
			actor: 'architect',
			expectedGeneration: 0,
			context: context(),
		});
		_internals.liveDispatches.clear();

		const recovered = await recoverCoderSettlement(directory, '1.1');
		expect(recovered?.accepted).toBe(false);
		expect(getTaskWorkflowSnapshot(recovered?.evidence ?? null)).toMatchObject({
			state: 'idle',
			generation: 0,
			lastOutcome: 'dispatch_no_mutation',
		});
	});

	test('a committed no-op cannot be replayed as accepted or rebound to a new baseline', async () => {
		const originalContext = context();
		await beginCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:immutable',
			actor: 'architect',
			expectedGeneration: 0,
			context: originalContext,
		});
		await settleCoderDispatch({
			directory,
			taskId: '1.1',
			transitionId: 'coder:immutable',
			accepted: false,
			testEngineerExempt: false,
		});

		await expect(
			settleCoderDispatch({
				directory,
				taskId: '1.1',
				transitionId: 'coder:immutable',
				accepted: true,
				testEngineerExempt: false,
			}),
		).rejects.toThrow('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
		writeFile(directory, 'export const unrelatedBaseline = true;\n');
		await expect(
			beginCoderSettlement({
				directory,
				taskId: '1.1',
				transitionId: 'coder:immutable',
				actor: 'architect',
				expectedGeneration: 0,
				context: context(),
			}),
		).rejects.toThrow('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')),
		).toMatchObject({
			state: 'idle',
			generation: 0,
		});
	});

	test('evidence-written WAL-not-committed recovery is idempotent', async () => {
		await beginCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:commit-crash',
			actor: 'architect',
			expectedGeneration: 0,
			context: context(),
		});
		writeFile(directory, 'export const feature = 3;\n');
		taskFileInternals.renameSync = (source, target) => {
			if (target.includes('coder-settlements')) {
				const candidate = JSON.parse(fs.readFileSync(source, 'utf8')) as {
					state?: string;
				};
				if (candidate.state === 'COMMITTED')
					throw new Error('injected WAL crash');
			}
			return realRename(source, target);
		};
		await expect(
			settleCoderDispatch({
				directory,
				taskId: '1.1',
				transitionId: 'coder:commit-crash',
				accepted: true,
				testEngineerExempt: false,
			}),
		).rejects.toThrow('injected WAL crash');
		taskFileInternals.renameSync = realRename;

		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1'))
				.generation,
		).toBe(1);
		const recovered = await recoverCoderSettlement(directory, '1.1');
		expect(recovered?.alreadyApplied).toBe(true);
		expect(
			getTaskWorkflowSnapshot(recovered?.evidence ?? null).generation,
		).toBe(1);
	});

	test('an active coder WAL fences terminal plan mutation under the evidence lock', async () => {
		await beginCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:active',
			actor: 'architect',
			expectedGeneration: 0,
			context: context(),
		});
		let planWrites = 0;
		await expect(
			commitTaskTerminalUnderPlanLock({
				directory,
				taskId: '1.1',
				actor: 'architect',
				transitionId: 'terminal:blocked-by-coder',
				currentPlanStatus: 'in_progress',
				targetStatus: 'completed',
				qaExempt: true,
				currentPlan: { marker: 'old' },
				updatePlan: async () => {
					planWrites += 1;
					return { marker: 'new' };
				},
			}),
		).rejects.toThrow('CODER_SETTLEMENT_RECOVERY_REQUIRED');
		expect(planWrites).toBe(0);
		releaseCoderDispatchOwnership(directory, '1.1', 'coder:active');
	});
});
