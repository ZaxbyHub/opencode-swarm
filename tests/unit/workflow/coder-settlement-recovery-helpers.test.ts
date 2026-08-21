import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	abortCoderSettlement,
	listCoderSettlementWalStates,
	recoverStaleCoderSettlements,
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

function walPath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
}

function readWalJson(
	directory: string,
	taskId: string,
): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(walPath(directory, taskId), 'utf8'),
	) as Record<string, unknown>;
}

function rewriteWalProcessId(
	directory: string,
	taskId: string,
	processId: number,
): void {
	const wal = readWalJson(directory, taskId);
	wal.processId = processId;
	fs.writeFileSync(walPath(directory, taskId), JSON.stringify(wal));
}

/** A pid that exited, so isProcessAlive() reports it dead (host-crash wedge). */
function deadProcessId(): number {
	const result = spawnSync(process.execPath, ['--version'], {
		stdin: 'ignore',
		encoding: 'utf8',
		timeout: 15_000,
		windowsHide: true,
	});
	if (result.pid === undefined) throw new Error('no pid from helper child');
	return result.pid;
}

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

const realRecoverCoderSettlement = settlementInternals.recoverCoderSettlement;

/**
 * Issue #2268: the /swarm recover + /swarm reset-session recovery matrix.
 * The wedge class: a DISPATCHED settlement WAL whose completion (toolAfter)
 * never arrived, plus the in-process ownership key when the host survived.
 */
describe('issue #2268 — stale settlement recovery helpers', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		settlementInternals.recoverCoderSettlement = realRecoverCoderSettlement;
		({ dir: directory, cleanup } = createSafeTestDir('coder-recover-2268-'));
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
		settlementInternals.recoverCoderSettlement = realRecoverCoderSettlement;
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		cleanup();
	});

	async function beginRealDispatch(callID: string): Promise<void> {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID },
			{ args: { ...CODER_ARGS } },
		);
	}

	test('listCoderSettlementWalStates: empty project lists nothing', async () => {
		expect(await listCoderSettlementWalStates(directory)).toEqual({
			states: [],
			truncated: false,
		});
	});

	test('listCoderSettlementWalStates: in-flight dispatch reports ownedInProcess', async () => {
		await beginRealDispatch('list-owned');
		const { states } = await listCoderSettlementWalStates(directory);
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({
			taskId: '1.1',
			state: 'DISPATCHED',
			ownedInProcess: true,
			ownedByLiveForeignPid: false,
		});
	});

	test('host-crash wedge (dead foreign pid, no in-process key) recovers WITHOUT --force', async () => {
		await beginRealDispatch('host-crash');
		rewriteWalProcessId(directory, '1.1', deadProcessId());
		settlementInternals.liveDispatches.clear();

		const { results } = await recoverStaleCoderSettlements(directory);
		expect(results).toEqual([
			{ taskId: '1.1', outcome: 'recovered', accepted: false, forced: false },
		]);
		expect(readWalJson(directory, '1.1').state).toBe('COMMITTED');
	});

	test('same-process wedge: no --force reports owned_in_process and leaves the WAL untouched', async () => {
		await beginRealDispatch('in-process');
		const { results } = await recoverStaleCoderSettlements(directory);
		expect(results).toEqual([
			{
				taskId: '1.1',
				outcome: 'owned_in_process',
				transitionId: 'coder:in-process',
			},
		]);
		expect(readWalJson(directory, '1.1').state).toBe('DISPATCHED');
	});

	test('same-process wedge: --force releases ownership and recovers, recording the audit event', async () => {
		await beginRealDispatch('force-me');
		expect(readWalJson(directory, '1.1').state).toBe('DISPATCHED');

		const { results } = await recoverStaleCoderSettlements(directory, {
			force: true,
		});
		expect(results).toEqual([
			{ taskId: '1.1', outcome: 'recovered', accepted: false, forced: true },
		]);
		expect(readWalJson(directory, '1.1').state).toBe('COMMITTED');
		expect(
			settlementInternals.liveDispatches.has(
				`${directory}\u00001.1\u0000coder:force-me`,
			),
		).toBe(false);

		const events = fs.readFileSync(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf8',
		);
		expect(events).toContain('"type":"coder_settlement"');
		expect(events).toContain('"action":"recovered"');
		expect(events).toContain('"forced":true');
	});

	test('foreign live pid is NEVER forced, even with --force', async () => {
		await beginRealDispatch('foreign-live');
		// process.ppid is alive for the whole test run and is not this process.
		rewriteWalProcessId(directory, '1.1', process.ppid);
		settlementInternals.liveDispatches.clear();

		for (const force of [false, true]) {
			const { results } = await recoverStaleCoderSettlements(directory, {
				force,
			});
			expect(results).toEqual([
				{
					taskId: '1.1',
					outcome: 'owned_by_live_foreign_pid',
					processId: process.ppid,
				},
			]);
		}
		expect(readWalJson(directory, '1.1').state).toBe('DISPATCHED');
	});

	test('terminal settlements are reported and left untouched', async () => {
		await beginRealDispatch('abort-me');
		await abortCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:abort-me',
			reason: 'test abort',
		});
		expect(readWalJson(directory, '1.1').state).toBe('ABORTED');

		const { results } = await recoverStaleCoderSettlements(directory, {
			force: true,
		});
		expect(results).toEqual([
			{ taskId: '1.1', outcome: 'already_terminal', state: 'ABORTED' },
		]);
		expect(readWalJson(directory, '1.1').state).toBe('ABORTED');
	});

	test('scan cap: >200 WALs truncates the listing with truncated=true (PRR-011)', async () => {
		const settlementsDir = path.join(directory, '.swarm', 'coder-settlements');
		fs.mkdirSync(settlementsDir, { recursive: true });
		const template = {
			version: 1,
			state: 'COMMITTED',
			taskId: 'x',
			transitionId: 'coder:cap',
			actor: 'architect',
			processId: process.pid,
			runtimeId: 'runtime-cap',
			expectedGeneration: 0,
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
			recordedAt: new Date().toISOString(),
		};
		for (let i = 0; i < 201; i++) {
			const taskId = `9${i}`;
			fs.writeFileSync(
				path.join(settlementsDir, `${taskId}.json`),
				JSON.stringify({ ...template, taskId }),
			);
		}
		const { states, truncated } = await listCoderSettlementWalStates(directory);
		expect(truncated).toBe(true);
		expect(states).toHaveLength(200);
		const { results, truncated: recoverTruncated } =
			await recoverStaleCoderSettlements(directory);
		expect(recoverTruncated).toBe(true);
		expect(results).toHaveLength(200);
		expect(results.every((r) => r.outcome === 'already_terminal')).toBe(true);
	});

	test('a settlement completed concurrently with recovery is already_terminal, not error (reviewer delta)', async () => {
		await beginRealDispatch('race-settle');
		settlementInternals.liveDispatches.clear();
		const realRecover = settlementInternals.recoverCoderSettlement;
		settlementInternals.recoverCoderSettlement = async () => {
			// Simulate the concurrent completion settling the WAL between the
			// listing and the recovery attempt, then returning null (terminal).
			const wal = readWalJson(directory, '1.1');
			fs.writeFileSync(
				walPath(directory, '1.1'),
				JSON.stringify({
					...wal,
					state: 'COMMITTED',
					accepted: false,
					testEngineerExempt: false,
				}),
			);
			return null;
		};
		try {
			const { results } = await recoverStaleCoderSettlements(directory);
			expect(results).toEqual([
				{ taskId: '1.1', outcome: 'already_terminal', state: 'COMMITTED' },
			]);
		} finally {
			settlementInternals.recoverCoderSettlement = realRecover;
		}
	});

	test('a failed recovery emits a recovery-failed audit event (reviewer delta)', async () => {
		await beginRealDispatch('fail-settle');
		settlementInternals.liveDispatches.clear();
		const realRecover = settlementInternals.recoverCoderSettlement;
		settlementInternals.recoverCoderSettlement = async () => {
			throw new Error('CODER_SETTLEMENT_RECOVERY_UNCERTAIN: simulated');
		};
		try {
			const { results } = await recoverStaleCoderSettlements(directory);
			expect(results).toEqual([
				{
					taskId: '1.1',
					outcome: 'error',
					message: 'CODER_SETTLEMENT_RECOVERY_UNCERTAIN: simulated',
				},
			]);
			const events = fs.readFileSync(
				path.join(directory, '.swarm', 'events.jsonl'),
				'utf8',
			);
			expect(events).toContain('"action":"recovery-failed"');
			expect(events).toContain(
				'CODER_SETTLEMENT_RECOVERY_UNCERTAIN: simulated',
			);
			// The WAL is untouched — a retry after fixing the underlying cause
			// remains possible.
			expect(readWalJson(directory, '1.1').state).toBe('DISPATCHED');
		} finally {
			settlementInternals.recoverCoderSettlement = realRecover;
		}
	});

	test('an unparseable WAL is reported as unreadable_wal, not a crash', async () => {
		fs.mkdirSync(path.dirname(walPath(directory, '9.9')), {
			recursive: true,
		});
		fs.writeFileSync(walPath(directory, '9.9'), 'not json at all');
		const { results } = await recoverStaleCoderSettlements(directory);
		expect(results).toEqual([{ taskId: '9.9', outcome: 'unreadable_wal' }]);
	});

	test('taskIds filter recovers only the requested task', async () => {
		// Plan already contains only task 1.1 for this suite; add a second
		// settlement WAL for 9.9 by hand so the filter has two candidates.
		await beginRealDispatch('filter-a');
		fs.mkdirSync(path.dirname(walPath(directory, '9.9')), {
			recursive: true,
		});
		fs.writeFileSync(walPath(directory, '9.9'), 'not json at all');

		const { results } = await recoverStaleCoderSettlements(directory, {
			taskIds: ['1.1'],
			force: true,
		});
		// Only 1.1 is in scope: recovered. 9.9 (unreadable) is untouched.
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ taskId: '1.1', outcome: 'recovered' });
	});
});
