import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	handleResetSessionCommand,
} from '../../../src/commands/reset-session';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { _internals as settlementInternals } from '../../../src/workflow/coder-settlement';
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

function walPath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
}

function readWalState(directory: string, taskId: string): string {
	return (
		JSON.parse(fs.readFileSync(walPath(directory, taskId), 'utf8')) as {
			state: string;
		}
	).state;
}

const realRecoverStale = _internals.recoverStaleCoderSettlements;

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

/**
 * Issue #2268 regression: the reporter's session was permanently wedged
 * because /swarm reset-session cleared in-memory session state but left the
 * durable DISPATCHED settlement WAL and the in-process ownership key in
 * place, so every coder dispatch retry was refused with
 * CODER_DISPATCH_IN_PROGRESS and even update_task_status stayed paused.
 */
describe('issue #2268 — reset-session recovers stale coder settlements', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('reset-settle-2268-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(directory, ['add', '.']);
		git(directory, ['commit', '-m', 'seed']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		fs.mkdirSync(path.join(directory, '.swarm', 'session'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'session', 'state.json'),
			JSON.stringify({ task: '1.1' }),
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	});

	afterEach(() => {
		_internals.recoverStaleCoderSettlements = realRecoverStale;
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		cleanup();
	});

	async function wedgeTaskWithRealDispatch(callID: string): Promise<void> {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID },
			{ args: { ...CODER_ARGS } },
		);
		expect(readWalState(directory, '1.1')).toBe('DISPATCHED');
	}

	test('regression (#2268): a wedged DISPATCHED WAL + live ownership key is recovered by reset-session', async () => {
		await wedgeTaskWithRealDispatch('wedge-2268');
		// Pre-fix failure shape: both survive a session reset.
		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain('Recovered coder settlement 1.1');
		// Reviewer round-3 pin: the forced-recovery heads-up must surface the
		// idempotency-conflict caveat, mirroring /swarm recover --force.
		expect(out).toContain('Released in-process ownership for 1 dispatch');
		expect(out).toContain('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
		expect(readWalState(directory, '1.1')).toBe('COMMITTED');
		expect(
			settlementInternals.liveDispatches.has(
				`${directory}\u00001.1\u0000coder:wedge-2268`,
			),
		).toBe(false);
	});

	test('clean project keeps the fast zero-settlement path', async () => {
		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain('No coder settlements to recover');
		expect(out).toContain('Deleted .swarm/session/state.json');
	});

	test('an unreadable settlement WAL warns but never breaks the reset', async () => {
		fs.mkdirSync(path.dirname(walPath(directory, '7.7')), {
			recursive: true,
		});
		fs.writeFileSync(walPath(directory, '7.7'), 'not json');
		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain('WAL 7.7 is unreadable');
		expect(out).toContain('Deleted .swarm/session/state.json');
	});

	test('failed recovery preserves .swarm-worktrees/ and sanitizes hostile messages (PRR-012/001)', async () => {
		const worktreesDir = path.resolve(
			path.dirname(directory),
			'.swarm-worktrees',
		);
		fs.mkdirSync(worktreesDir, { recursive: true });
		fs.writeFileSync(path.join(worktreesDir, 'lane-marker'), 'keep');
		_internals.recoverStaleCoderSettlements = (async () => ({
			results: [
				{
					taskId: '1.1',
					outcome: 'error',
					message:
						'CODER_SETTLEMENT_RECOVERY_UNCERTAIN: evil\u0007inject\nline2',
				},
			],
			truncated: false,
		})) as typeof realRecoverStale;

		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain(
			'recovery failed: CODER_SETTLEMENT_RECOVERY_UNCERTAIN: evil?inject?line2',
		);
		expect(out).not.toContain('evil\u0007');
		expect(out).toContain('Preserved .swarm-worktrees/');
		expect(out).toContain('Skipped .swarm-worktrees/ removal');
		expect(fs.existsSync(path.join(worktreesDir, 'lane-marker'))).toBe(true);
	});

	test('scan-cap truncation is surfaced by reset-session (PRR-011)', async () => {
		_internals.recoverStaleCoderSettlements = (async () => ({
			results: [],
			truncated: true,
		})) as typeof realRecoverStale;
		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain('scan cap (200)');
		expect(out).toContain('NOT recovered');
	});

	test('a thrown recovery call also preserves .swarm-worktrees/ (reviewer round)', async () => {
		const worktreesDir = path.resolve(
			path.dirname(directory),
			'.swarm-worktrees',
		);
		fs.mkdirSync(worktreesDir, { recursive: true });
		fs.writeFileSync(path.join(worktreesDir, 'lane-marker'), 'keep');
		_internals.recoverStaleCoderSettlements = (async () => {
			throw new Error('CODER_SETTLEMENT_LOCKED: task 1.1');
		}) as typeof realRecoverStale;

		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain(
			'Coder settlement recovery failed (continuing with reset)',
		);
		expect(out).toContain('Skipped .swarm-worktrees/ removal');
		expect(fs.existsSync(path.join(worktreesDir, 'lane-marker'))).toBe(true);
	});

	test('a foreign-live-pid settlement is reported, not touched', async () => {
		await wedgeTaskWithRealDispatch('foreign-2268');
		const wal = JSON.parse(
			fs.readFileSync(walPath(directory, '1.1'), 'utf8'),
		) as { processId: number };
		wal.processId = process.ppid;
		fs.writeFileSync(walPath(directory, '1.1'), JSON.stringify(wal));
		settlementInternals.liveDispatches.clear();

		const out = await handleResetSessionCommand(directory, []);
		expect(out).toContain('owned by live process pid');
		expect(readWalState(directory, '1.1')).toBe('DISPATCHED');
	});
});
