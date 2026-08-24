import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { setStoredInputArgs } from '../../../src/hooks/guardrails/stored-input-args';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { _internals as taskFileInternals } from '../../../src/utils/atomic-write';
import {
	abortCoderSettlement,
	beginCoderSettlement,
	recoverCoderSettlement,
	settleCoderDispatch,
	_internals as settlementInternals,
} from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
}

function writeFile(directory: string, file: string, content: string): void {
	const absolute = path.join(directory, file);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
}

function readWal(directory: string, taskId: string): Record<string, unknown> {
	const walPath = path.join(
		directory,
		'.swarm',
		'coder-settlements',
		`${taskId}.json`,
	);
	if (!fs.existsSync(walPath)) return {};
	return JSON.parse(fs.readFileSync(walPath, 'utf8')) as Record<
		string,
		unknown
	>;
}

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

/**
 * Issue #2214: coder settlements wedged at DISPATCHED forever. Two production
 * triggers, both reproduced against the REAL host boundary (#1849 — the SDK
 * tool.execute.after input carries NO args):
 *  1. a dirty workspace at dispatch made the settle-time attribution check
 *     fail BEFORE settleCoderDispatch, leaving an un-abortable DISPATCHED WAL;
 *  2. with knowledge disabled, architect Task calls had no stored args at
 *     toolAfter, so the settle block silently skipped.
 */
describe('issue #2214 — coder settlement finalization', () => {
	let directory = '';
	let cleanup = (): void => {};
	const realRename = taskFileInternals.renameSync;

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		taskFileInternals.renameSync = realRename;
		({ dir: directory, cleanup } = createSafeTestDir('coder-settle-2214-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		writeFile(directory, 'src/feature.ts', 'export const feature = 1;\n');
		git(directory, ['add', '.']);
		git(directory, ['commit', '-m', 'seed']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	});

	afterEach(() => {
		taskFileInternals.renameSync = realRename;
		resetSwarmState();
		cleanup();
	});

	test('a dirty workspace at dispatch is rejected before any settlement state exists', async () => {
		const hook = createDelegationGateHook(config, directory);
		writeFile(directory, 'src/wip-note.md', 'work in progress\n');
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'dirty-dispatch' },
				{ args: { ...CODER_ARGS } },
			),
		).rejects.toThrow('CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED');
		expect(readWal(directory, '1.1').state).toBeUndefined();
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence).toBeNull();
	});

	test('settle finalizes without toolAfter input args, using the stored-args snapshot (#1849 host shape)', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'host-shape' },
			{ args: { ...CODER_ARGS } },
		);
		setStoredInputArgs('host-shape', { ...CODER_ARGS });
		writeFile(directory, 'src/feature.ts', 'export const feature = 2;\n');
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent', callID: 'host-shape' },
			{ state: 'completed', output: 'implemented feature' },
		);
		expect(readWal(directory, '1.1').state).toBe('COMMITTED');
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')),
		).toMatchObject({
			state: 'coder_delegated',
			lastOutcome: 'accepted_mutation',
		});
	});

	test('a no-mutation coder settles as COMMITTED dispatch_no_mutation', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'no-mutation' },
			{ args: { ...CODER_ARGS } },
		);
		setStoredInputArgs('no-mutation', { ...CODER_ARGS });
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent', callID: 'no-mutation' },
			{ state: 'completed', output: 'no changes required' },
		);
		expect(readWal(directory, '1.1').state).toBe('COMMITTED');
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')),
		).toMatchObject({ state: 'idle', lastOutcome: 'dispatch_no_mutation' });
	});

	test('a non-git launch baseline aborts at settle instead of wedging at DISPATCHED', async () => {
		// Non-git projects stay dispatchable (C1 decision), but their settlement
		// can never attribute mutations — the settle catch must abort it.
		const nonGit = createSafeTestDir('coder-settle-2214-nogit-');
		try {
			await writeApprovedPlan(nonGit.dir, [
				{ id: '1.1', files: ['src/feature.ts'] },
			]);
			const session = ensureAgentSession('parent', 'architect', nonGit.dir);
			session.currentTaskId = '1.1';
			const hook = createDelegationGateHook(config, nonGit.dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'non-git' },
				{ args: { ...CODER_ARGS } },
			);
			expect(readWal(nonGit.dir, '1.1').state).toBe('DISPATCHED');
			setStoredInputArgs('non-git', { ...CODER_ARGS });
			await expect(
				hook.toolAfter(
					{ tool: 'Task', sessionID: 'parent', callID: 'non-git' },
					{ state: 'completed', output: 'implemented feature' },
				),
			).rejects.toThrow('CODER_SETTLEMENT_ATTRIBUTION_UNCERTAIN');
			expect(readWal(nonGit.dir, '1.1').state).toBe('ABORTED');
			expect(typeof readWal(nonGit.dir, '1.1').abortReason).toBe('string');
			// The architect-visible advisory explains the abort and the way out.
			const advisory = ensureAgentSession(
				'parent',
				'architect',
			).pendingAdvisoryMessages?.find((message) =>
				message.includes('CODER_SETTLEMENT_ABORTED'),
			);
			expect(advisory).toContain('update_task_status');
			// Ownership released: same-process recovery is a stable no-op, not
			// CODER_DISPATCH_IN_PROGRESS.
			expect(await recoverCoderSettlement(nonGit.dir, '1.1')).toBeNull();
		} finally {
			nonGit.cleanup();
		}
	});

	test('a denied-after-begin settlement rolls back to ABORTED (no toolAfter fires)', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'denied-later' },
			{ args: { ...CODER_ARGS } },
		);
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
		await hook.abortDeniedSettlementForCall('denied-later');
		expect(readWal(directory, '1.1').state).toBe('ABORTED');
		expect(await recoverCoderSettlement(directory, '1.1')).toBeNull();
		// The task is repairable: no unsettled dispatch fences plan-status change.
		const { assertNoUnsettledCoderDispatch } = await import(
			'../../../src/workflow/coder-settlement.js'
		);
		await expect(
			assertNoUnsettledCoderDispatch(directory, '1.1'),
		).resolves.toBeUndefined();
	});

	test('a legacy dirty-baseline DISPATCHED WAL self-heals to ABORTED on recovery', async () => {
		const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
			timeout: 10_000,
		}).stdout.trim();
		await beginCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:legacy-dirty',
			actor: 'parent',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline: {
					directory,
					gitHead: head,
					dirtyHash: 'legacy',
					changedFiles: ['src/wip.md'],
					prHeadSha: null,
					scope: null,
				},
			},
		});
		// Post-restart shape: the WAL persists, the per-process registry is empty.
		settlementInternals.liveDispatches.clear();
		expect(await recoverCoderSettlement(directory, '1.1')).toBeNull();
		expect(readWal(directory, '1.1').state).toBe('ABORTED');
	});

	test('a clean-baseline DISPATCHED WAL whose current capture fails stays retryable (RECOVERY_UNCERTAIN)', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'transient-git' },
			{ args: { ...CODER_ARGS } },
		);
		settlementInternals.liveDispatches.clear();
		// Break the CURRENT capture (not the recorded baseline): remove the repo
		// so changedFilesSinceSnapshot's current-snapshot leg returns null.
		fs.rmSync(path.join(directory, '.git'), { recursive: true, force: true });
		await expect(recoverCoderSettlement(directory, '1.1')).rejects.toThrow(
			'CODER_SETTLEMENT_RECOVERY_UNCERTAIN',
		);
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
	});

	test('abortCoderSettlement validates identity, is idempotent, and never touches PREPARED', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'abort-unit' },
			{ args: { ...CODER_ARGS } },
		);
		await expect(
			abortCoderSettlement({
				directory,
				taskId: '1.1',
				transitionId: 'coder:someone-else',
				reason: 'stale caller',
			}),
		).rejects.toThrow('CODER_SETTLEMENT_WAL_REPLACED');
		expect(
			await abortCoderSettlement({
				directory,
				taskId: '1.1',
				transitionId: 'coder:abort-unit',
				reason: 'unit abort',
			}),
		).toBe('aborted');
		expect(
			await abortCoderSettlement({
				directory,
				taskId: '1.1',
				transitionId: 'coder:abort-unit',
				reason: 'unit abort',
			}),
		).toBe('already-aborted');
		expect(readWal(directory, '1.1')).toMatchObject({
			state: 'ABORTED',
			abortReason: 'unit abort',
		});
	});

	test('abortCoderSettlement never touches a PREPARED WAL — it stays recoverable', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'prepared-keep' },
			{ args: { ...CODER_ARGS } },
		);
		// Freeze the WAL at PREPARED: settleCoderDispatch writes PREPARED, then
		// commitPrepared fails on an injected evidence-rename error (the same
		// recoverable mid-commit crash shape the #2098 suite exercises).
		taskFileInternals.renameSync = (source, target) => {
			if (target.includes(`${path.sep}evidence${path.sep}1.1.json`)) {
				throw new Error('injected evidence rename failure');
			}
			return realRename(source, target);
		};
		await expect(
			settleCoderDispatch({
				directory,
				taskId: '1.1',
				transitionId: 'coder:prepared-keep',
				accepted: false,
				testEngineerExempt: false,
			}),
		).rejects.toThrow('injected evidence rename failure');
		taskFileInternals.renameSync = realRename;
		expect(readWal(directory, '1.1').state).toBe('PREPARED');
		expect(
			await abortCoderSettlement({
				directory,
				taskId: '1.1',
				transitionId: 'coder:prepared-keep',
				reason: 'must not fire',
			}),
		).toBe('not-dispatched');
		expect(readWal(directory, '1.1').state).toBe('PREPARED');
		// PREPARED remains recoverable: a later recovery commits it.
		settlementInternals.liveDispatches.clear();
		const recovered = await recoverCoderSettlement(directory, '1.1');
		expect(getTaskWorkflowSnapshot(recovered?.evidence ?? null)).toMatchObject({
			lastOutcome: 'dispatch_no_mutation',
		});
		expect(readWal(directory, '1.1').state).toBe('COMMITTED');
	});

	test('settlement lifecycle events are recorded in events.jsonl', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'events' },
			{ args: { ...CODER_ARGS } },
		);
		setStoredInputArgs('events', { ...CODER_ARGS });
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent', callID: 'events' },
			{ state: 'completed', output: 'no changes required' },
		);
		await expect(
			abortCoderSettlement({
				directory,
				taskId: '1.9',
				transitionId: 'coder:missing-probe',
				reason: 'probe',
			}),
		).rejects.toThrow('CODER_SETTLEMENT_WAL_MISSING');
		const events = fs
			.readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { type?: string; action?: string })
			.filter((event) => event.type === 'coder_settlement');
		expect(events.map((event) => event.action)).toEqual([
			'dispatched',
			'settled',
		]);
	});

	test('dual-witness: dirty tree is rejected even when toolAfter stored args are absent', async () => {
		const hook = createDelegationGateHook(config, directory);
		writeFile(directory, 'src/wip-note.md', 'work in progress\n');
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'dual-witness' },
				{ args: { ...CODER_ARGS } },
			),
		).rejects.toThrow('CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED');
		await expect(
			hook.toolAfter(
				{ tool: 'Task', sessionID: 'parent', callID: 'dual-witness' },
				{ state: 'completed', output: 'unreachable' },
			),
		).resolves.toBeUndefined();
		expect(readWal(directory, '1.1').state).toBeUndefined();
	});
});
