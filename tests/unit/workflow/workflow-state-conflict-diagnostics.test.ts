import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	assertNoUnsettledCoderDispatch,
	beginCoderSettlement,
	_internals as coderSettlementInternals,
	recoverCoderSettlement,
} from '../../../src/workflow/coder-settlement';
import { repairTaskWorkflowUnderPlanLock } from '../../../src/workflow/task-repair';
import { commitTaskTerminalUnderPlanLock } from '../../../src/workflow/task-terminal';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * State-conflict errors are the operator's only signal when a close or repair
 * stalls mid-batch. They must name the exact task, transition, WAL path, and a
 * concrete recovery action — the same contract the WAL-corruption errors already
 * meet — because close-terminal's per-task loop adds no tagging of its own.
 */
describe('workflow state-conflict error diagnostics', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('workflow-state-conflict-');
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		coderSettlementInternals.liveDispatches.clear();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function writeWal(kind: string, taskId: string, body: unknown): string {
		const dir = path.join(directory, '.swarm', kind);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${taskId}.json`);
		fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
		return filePath;
	}

	test('CODER_SETTLEMENT_IN_PROGRESS names both transitions, the task, WAL path and next action', async () => {
		// Driven through the real dispatch path rather than a hand-written WAL: this
		// error only fires from beginCoderSettlement's in-transaction re-read, so a
		// synthetic fixture would not prove the message an operator actually sees.
		const git = (args: string[]): void => {
			const result = spawnSync('git', ['-C', directory, ...args], {
				cwd: directory,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				encoding: 'utf8',
				timeout: 10_000,
				maxBuffer: 128 * 1024,
				windowsHide: true,
			});
			if (result.status !== 0) throw new Error(result.stderr || result.stdout);
		};
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(['init']);
		git(['config', 'user.email', 'tests@example.com']);
		git(['config', 'user.name', 'Tests']);
		git(['add', 'src/feature.ts']);
		git(['commit', '-m', 'test: seed']);

		const walFile = path.join(
			directory,
			'.swarm',
			'coder-settlements',
			'8.1.json',
		);
		const context = {
			declaredFiles: ['src/feature.ts'],
			baseline: captureWorkspaceSnapshot(directory),
			workflowGeneration: 0,
		};
		await beginCoderSettlement({
			directory,
			taskId: '8.1',
			transitionId: 'coder:8.1:owning',
			actor: 'architect',
			expectedGeneration: 0,
			context,
		});

		const error = await beginCoderSettlement({
			directory,
			taskId: '8.1',
			transitionId: 'coder:8.1:intruder',
			actor: 'architect',
			expectedGeneration: 0,
			context,
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain('CODER_SETTLEMENT_IN_PROGRESS');
		expect(error.message).toContain('coder:8.1:owning');
		expect(error.message).toContain('coder:8.1:intruder');
		expect(error.message).toContain('task 8.1');
		expect(error.message).toContain(walFile);
		expect(error.message).toContain('state DISPATCHED');
		expect(error.message).toContain('do not remove the WAL by hand');
	});

	test('CODER_SETTLEMENT_RECOVERY_REQUIRED names the task, transition, WAL path and next action', async () => {
		const walPath = writeWal('coder-settlements', '1.1', {
			version: 1,
			state: 'DISPATCHED',
			taskId: '1.1',
			transitionId: 'coder:1.1:7',
			actor: 'coder',
			processId: 4242,
			runtimeId: 'runtime-1',
			expectedGeneration: 0,
			recordedAt: '2026-08-16T00:00:00.000Z',
			context: {
				declaredFiles: [],
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
		});

		const error = await assertNoUnsettledCoderDispatch(directory, '1.1').catch(
			(caught: unknown) => caught as Error,
		);

		expect(error.message).toContain('CODER_SETTLEMENT_RECOVERY_REQUIRED');
		expect(error.message).toContain('coder:1.1:7');
		expect(error.message).toContain('task 1.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('state DISPATCHED');
		expect(error.message).toContain('Run coder-settlement recovery');
	});

	test('CODER_DISPATCH_IN_PROGRESS names the owning transition, WAL path, state and pid', async () => {
		// processId must be a live process other than this one for the ownership check
		// to fire; the parent process is alive for the duration of the test run.
		const walPath = writeWal('coder-settlements', '6.1', {
			version: 1,
			state: 'DISPATCHED',
			taskId: '6.1',
			transitionId: 'coder:6.1:2',
			actor: 'coder',
			processId: process.ppid,
			runtimeId: 'runtime-1',
			expectedGeneration: 0,
			recordedAt: '2026-08-16T00:00:00.000Z',
			context: {
				declaredFiles: [],
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
		});

		const error = await recoverCoderSettlement(directory, '6.1').catch(
			(caught: unknown) => caught as Error,
		);

		expect(error.message).toContain('CODER_DISPATCH_IN_PROGRESS');
		expect(error.message).toContain('coder:6.1:2');
		expect(error.message).toContain('task 6.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('state DISPATCHED');
		expect(error.message).toContain(`pid ${process.ppid}`);
		expect(error.message).toContain('do not remove the WAL by hand');
	});

	test('TASK_REPAIR_IN_PROGRESS names both transitions, the task and the WAL path', async () => {
		const walPath = writeWal('task-repairs', '7.1', {
			version: 1,
			state: 'PREPARED',
			taskId: '7.1',
			transitionId: 'owning-repair',
			reason: 'reopen for rework',
			actor: 'architect',
			oldPlanStatus: 'completed',
			newPlanStatus: 'in_progress',
			oldWorkflowState: 'complete',
			newWorkflowState: 'idle',
			oldGeneration: 0,
			generation: 1,
			recordedAt: '2026-08-16T00:00:00.000Z',
		});

		const error = await repairTaskWorkflowUnderPlanLock({
			directory,
			taskId: '7.1',
			actor: 'architect',
			reason: 'a second, different repair',
			transitionId: 'requesting-repair',
			expectedState: 'complete',
			expectedGeneration: 0,
			currentPlanStatus: 'completed',
			currentPlan: { status: 'completed' },
			updatePlan: async () => ({ status: 'in_progress' }),
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain('TASK_REPAIR_IN_PROGRESS');
		expect(error.message).toContain('owning-repair');
		expect(error.message).toContain('requesting-repair');
		expect(error.message).toContain('task 7.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('Recover or abort');
	});

	test('TASK_TERMINAL_PLAN_IDENTITY_REQUIRED names each missing field plus task, transition and path', async () => {
		const walPath = path.join(
			directory,
			'.swarm',
			'task-terminals',
			'2.3.json',
		);

		const error = await commitTaskTerminalUnderPlanLock({
			directory,
			taskId: '2.3',
			actor: 'close-test',
			transitionId: 'close-terminal:2.3',
			currentPlanStatus: 'in_progress',
			targetStatus: 'closed',
			qaExempt: false,
			currentPlan: { status: 'in_progress' },
			updatePlan: async () => ({ status: 'closed' }),
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain('TASK_TERMINAL_PLAN_IDENTITY_REQUIRED');
		expect(error.message).toContain('task 2.3');
		expect(error.message).toContain('close-terminal:2.3');
		expect(error.message).toContain(walPath);
		// Both fields absent, so both must be named.
		expect(error.message).toContain('planIdentityHash and planEpoch');
		expect(error.message).toContain('getOrAdoptPlanEpochUnderLock');
	});

	test('TASK_TERMINAL_PLAN_IDENTITY_REQUIRED names only the field that is actually missing', async () => {
		const error = await commitTaskTerminalUnderPlanLock({
			directory,
			taskId: '2.4',
			actor: 'close-test',
			transitionId: 'close-terminal:2.4',
			currentPlanStatus: 'in_progress',
			targetStatus: 'closed',
			qaExempt: false,
			planIdentityHash: 'a'.repeat(64),
			currentPlan: { status: 'in_progress' },
			updatePlan: async () => ({ status: 'closed' }),
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain('missing planEpoch');
		// The preamble always names both fields; only the `missing …` clause narrows.
		expect(error.message).not.toContain('missing planIdentityHash');
	});

	test('TASK_TERMINAL_WAL_TASK_MISMATCH names the WAL path, both task ids and a remediation', async () => {
		// This error is raised by the parser (parseTaskTerminalWal), not by a caller-side
		// check: readWorkflowWalFile passes the expected task id down, so a duplicate
		// guard in commitTaskTerminalUnderPlanLock would be unreachable.
		const walPath = writeWal('task-terminals', '5.1', {
			version: 1,
			state: 'PREPARED',
			taskId: '9.9',
			transitionId: 'foreign-transition',
			actor: 'close-test',
			generation: 0,
			oldPlanStatus: 'in_progress',
			// `completed`, not `closed`: a v1 WAL claiming a closed transition is
			// rejected earlier as unreadable, before the task-id check is reached.
			newPlanStatus: 'completed',
			oldWorkflowState: 'idle',
			newWorkflowState: 'complete',
			qaExempt: false,
			recordedAt: '2026-08-16T00:00:00.000Z',
		});

		const error = await commitTaskTerminalUnderPlanLock({
			directory,
			taskId: '5.1',
			actor: 'close-test',
			transitionId: 'close-terminal:5.1',
			currentPlanStatus: 'in_progress',
			targetStatus: 'closed',
			qaExempt: false,
			planIdentityHash: 'a'.repeat(64),
			planEpoch: '11111111-1111-4111-8111-111111111111',
			currentPlan: { status: 'in_progress' },
			updatePlan: async () => ({ status: 'closed' }),
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain('TASK_TERMINAL_WAL_TASK_MISMATCH');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('records task 9.9');
		expect(error.message).toContain('read for task 5.1');
		expect(error.message).toContain(
			'reconcile the task terminal transition before moving it aside',
		);
	});

	test('TASK_TERMINAL_RECOVERY_REQUIRED names both transitions, the task and the WAL path', async () => {
		const walPath = writeWal('task-terminals', '3.1', {
			version: 2,
			state: 'PREPARED',
			taskId: '3.1',
			transitionId: 'owning-transition',
			actor: 'close-test',
			generation: 0,
			oldPlanStatus: 'in_progress',
			newPlanStatus: 'closed',
			oldWorkflowState: 'idle',
			newWorkflowState: 'closed',
			qaExempt: false,
			planIdentityHash: 'a'.repeat(64),
			planEpoch: '11111111-1111-4111-8111-111111111111',
			recordedAt: '2026-08-16T00:00:00.000Z',
		});

		const error = await commitTaskTerminalUnderPlanLock({
			directory,
			taskId: '3.1',
			actor: 'close-test',
			transitionId: 'requesting-transition',
			currentPlanStatus: 'in_progress',
			targetStatus: 'closed',
			qaExempt: false,
			planIdentityHash: 'a'.repeat(64),
			planEpoch: '11111111-1111-4111-8111-111111111111',
			currentPlan: { status: 'in_progress' },
			updatePlan: async () => ({ status: 'closed' }),
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain('TASK_TERMINAL_RECOVERY_REQUIRED');
		expect(error.message).toContain('owning-transition');
		expect(error.message).toContain('requesting-transition');
		expect(error.message).toContain('task 3.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('Run task-terminal recovery');
	});

	test('TASK_TERMINAL_AUTHORITATIVE_EVIDENCE_REQUIRED distinguishes absent evidence and names the target status', async () => {
		const walPath = path.join(
			directory,
			'.swarm',
			'task-terminals',
			'4.1.json',
		);

		const error = await commitTaskTerminalUnderPlanLock({
			directory,
			taskId: '4.1',
			actor: 'close-test',
			transitionId: 'close-terminal:4.1',
			currentPlanStatus: 'completed',
			targetStatus: 'completed',
			qaExempt: false,
			planIdentityHash: 'a'.repeat(64),
			planEpoch: '11111111-1111-4111-8111-111111111111',
			currentPlan: { status: 'completed' },
			// Force the preserve-evidence path with no evidence on disk.
			resolveTerminal: () => ({
				targetStatus: 'completed',
				qaExempt: false,
				preserveEvidence: true,
			}),
			updatePlan: async () => ({ status: 'completed' }),
		}).catch((caught: unknown) => caught as Error);

		expect(error.message).toContain(
			'TASK_TERMINAL_AUTHORITATIVE_EVIDENCE_REQUIRED',
		);
		expect(error.message).toContain('task 4.1');
		expect(error.message).toContain('close-terminal:4.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('completed');
		expect(error.message).toContain('no evidence');
		expect(error.message).toContain('Reconcile task evidence');
	});
});
