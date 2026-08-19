import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	deleteStoredInputArgs,
	getStoredInputArgs,
	setStoredInputArgs,
} from '../../../src/hooks/guardrails/stored-input-args';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	abortCoderSettlement,
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

function settlementEvents(directory: string): Array<Record<string, unknown>> {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf8')
		.trim()
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === 'coder_settlement');
}

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

/**
 * PR #2223 review-feedback hardening: F-002 (denial rollback releases
 * ownership under every failure class), PRR-004 (assertion strength),
 * PRR-005 (module-state isolation), PRR-006 (background-flagged shape),
 * PRR-009 (already-aborted advisory).
 */
describe('issue #2214 — review-feedback hardening', () => {
	let directory = '';
	let cleanup = (): void => {};
	const usedCallIDs: string[] = [];

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('coder-settle-2214-h-'));
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
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	});

	afterEach(() => {
		// PRR-005: resetSwarmState does not cover the stored-args map; drain the
		// callIDs this file used so later tests can never observe them.
		for (const callID of usedCallIDs.splice(0)) {
			deleteStoredInputArgs(callID);
		}
		resetSwarmState();
		cleanup();
	});

	test('F-002: denial rollback releases ownership even when the abort itself fails (lock contention)', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'f2-locked' },
			{ args: { ...CODER_ARGS } },
		);
		setStoredInputArgs('f2-locked', { ...CODER_ARGS });
		usedCallIDs.push('f2-locked');
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');

		// Force the abort to throw CODER_SETTLED_LOCKED by holding the
		// settlement lock from outside.
		const lock = await tryAcquireLock(
			directory,
			'coder-settlements/1.1.json',
			'test-contention',
			'test-contention-id',
		);
		expect(lock.acquired).toBe(true);
		await hook.abortDeniedSettlementForCall('f2-locked');
		await lock.lock._release?.().catch(() => undefined);

		// The WAL is still DISPATCHED (the abort failed), but the in-memory
		// ownership key and callID bookkeeping were released unconditionally —
		// recovery must not report CODER_DISPATCH_IN_PROGRESS.
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
		const key = `${directory}\u00001.1\u0000coder:f2-locked`;
		expect(settlementInternals.liveDispatches.has(key)).toBe(false);
		expect(getStoredInputArgs('f2-locked')).toBeUndefined();
		const recovered = await recoverAndSettle(directory);
		expect(recovered).not.toBeNull();
	});

	test('PRR-004a: a clean workspace dispatch is admitted (guard positive control)', async () => {
		const hook = createDelegationGateHook(config, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'clean-control' },
				{ args: { ...CODER_ARGS } },
			),
		).resolves.toBeUndefined();
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
	});

	test('PRR-004b: a rejected dirty dispatch leaves zero settlement side effects', async () => {
		const hook = createDelegationGateHook(config, directory);
		fs.writeFileSync(
			path.join(directory, 'src', 'wip.md'),
			'work in progress\n',
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'no-side-effects' },
				{ args: { ...CODER_ARGS } },
			),
		).rejects.toThrow('CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED');
		await expect(
			hook.toolAfter(
				{ tool: 'Task', sessionID: 'parent', callID: 'no-side-effects' },
				{ state: 'completed', output: 'unreachable' },
			),
		).resolves.toBeUndefined();
		// Non-tautological: prove toolAfter did NOTHING settlement-shaped.
		expect(readWal(directory, '1.1').state).toBeUndefined();
		expect(settlementEvents(directory)).toEqual([]);
	});

	test('PRR-004c: lifecycle events carry identity fields and include the aborted action', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'events-fields' },
			{ args: { ...CODER_ARGS } },
		);
		await abortCoderSettlement({
			directory,
			taskId: '1.1',
			transitionId: 'coder:events-fields',
			reason: 'field assertion probe',
		});
		const events = settlementEvents(directory);
		expect(events.map((event) => event.action)).toEqual([
			'dispatched',
			'aborted',
		]);
		expect(events[0]).toMatchObject({
			taskId: '1.1',
			transitionId: 'coder:events-fields',
			actor: 'parent',
		});
		expect(typeof events[0].timestamp).toBe('string');
		expect(events[1]).toMatchObject({ reason: 'field assertion probe' });
	});

	test('PRR-006: a background-flagged dispatch is denied by the experimental gate before any settlement state (subagents disabled)', async () => {
		const hook = createDelegationGateHook(config, directory);
		// Dirty or clean makes no difference: the fail-closed background block
		// (issue #1151) fires before the coder dispatch flow, so the settlement
		// system is never engaged for background-flagged calls while background
		// subagents are disabled.
		fs.writeFileSync(
			path.join(directory, 'src', 'wip.md'),
			'work in progress\n',
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'bg-dirty' },
				{ args: { ...CODER_ARGS, background: 'true' } },
			),
		).rejects.toThrow('SWARM_BACKGROUND_TASK_BLOCKED');
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'bg-clean' },
				{ args: { ...CODER_ARGS, background: true } },
			),
		).rejects.toThrow('SWARM_BACKGROUND_TASK_BLOCKED');
		for (const callID of ['bg-dirty', 'bg-clean']) {
			usedCallIDs.push(callID);
		}
		expect(readWal(directory, '1.1').state).toBeUndefined();
		expect(settlementEvents(directory)).toEqual([]);
	});

	test('PRR-009: an already-aborted settlement reports the terminal advisory, not DURABILITY_FAILURE', async () => {
		const nonGit = createSafeTestDir('coder-settle-2214-h-ng-');
		try {
			await writeApprovedPlan(nonGit.dir, [
				{ id: '1.1', files: ['src/feature.ts'] },
			]);
			const session = ensureAgentSession('parent', 'architect', nonGit.dir);
			session.currentTaskId = '1.1';
			const hook = createDelegationGateHook(config, nonGit.dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'already-aborted' },
				{ args: { ...CODER_ARGS } },
			);
			// Terminate the settlement before toolAfter runs (e.g. an operator
			// or a concurrent rollback got there first).
			await abortCoderSettlement({
				directory: nonGit.dir,
				taskId: '1.1',
				transitionId: 'coder:already-aborted',
				reason: 'terminated before completion',
			});
			setStoredInputArgs('already-aborted', { ...CODER_ARGS });
			usedCallIDs.push('already-aborted');
			await expect(
				hook.toolAfter(
					{ tool: 'Task', sessionID: 'parent', callID: 'already-aborted' },
					{ state: 'completed', output: 'implemented feature' },
				),
			).rejects.toThrow('CODER_SETTLEMENT_ATTRIBUTION_UNCERTAIN');
			const advisories =
				ensureAgentSession('parent', 'architect').pendingAdvisoryMessages ?? [];
			expect(
				advisories.some(
					(message) =>
						message.includes('CODER_SETTLEMENT_ABORTED') &&
						message.includes('update_task_status'),
				),
			).toBe(true);
			expect(
				advisories.some((message) =>
					message.includes('CODER_SETTLEMENT_DURABILITY_FAILURE'),
				),
			).toBe(false);
		} finally {
			nonGit.cleanup();
		}
	});
});

async function recoverAndSettle(directory: string): Promise<unknown> {
	const { recoverCoderSettlement } = await import(
		'../../../src/workflow/coder-settlement.js'
	);
	return recoverCoderSettlement(directory, '1.1');
}
