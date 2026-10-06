/**
 * Epic v2 C3 (M-b) — a coder for a task of the open git epic is ALWAYS
 * worktree-isolated: the delegation gate forces isolation regardless of
 * `parallelization_enabled`, the session's concurrency override or the
 * plan's `max_concurrent_tasks`, treats an `auto` worktree policy as
 * `required`, and refuses the dispatch with EPIC_ISOLATION_DEGRADED (never
 * running the coder un-isolated in the main tree, never serializing the
 * session). Without an open epic the gate is unchanged: no isolation
 * attempt when parallel mode is off, and the #2271 degradation path when it
 * is on.
 *
 * The SDK client is absent after `resetSwarmState`, so any isolation attempt
 * fails at provisioning (STANDARD_WORKTREE_ISOLATION_UNAVAILABLE) — which is
 * exactly how these tests observe whether isolation was attempted.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	getStandardWorktreeDegradationReason,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import {
	issuedWaveForTest,
	openEpicForTest,
} from '../../helpers/epic-lifecycle';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const baseConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'auto' },
} as PluginConfig;

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf-8',
		timeout: 10_000,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
}

function degradedEvents(directory: string): unknown[] {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf-8')
		.trim()
		.split('\n')
		.filter((line) => line.includes('worktree_isolation_degraded'));
}

const walPath = (directory: string) =>
	path.join(directory, '.swarm', 'coder-settlements', '1.1.json');

describe('Epic v2 C3 — epic coders must be worktree-isolated', () => {
	let directory = '';
	let cleanup = (): void => {};

	async function setup(
		profile: Plan['execution_profile'],
		epic: boolean,
	): Promise<void> {
		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(
				epic
					? {
							epic: { mode: { enabled: true } },
						}
					: {},
			),
		);
		await writeApprovedPlan(
			directory,
			[{ id: '1.1', files: ['src/feature.ts'] }],
			{ executionProfile: profile },
		);
		if (epic) {
			// Epic v2 C4: coders are admitted only for the active wave.
			const wave = issuedWaveForTest({ '1.1': ['src/feature.ts'] });
			openEpicForTest(directory, { waves: [wave], activeWaveSeq: wave.seq });
		}
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	}

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		({ dir: directory, cleanup } = createSafeTestDir('epic-isolation-'));
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
			'\n.swarm/\n.opencode/\n',
		);
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		closeAllProjectDbs();
		cleanup();
	});

	test.each([
		['parallelization_enabled: false', { parallelization_enabled: false }],
		[
			'max_concurrent_tasks: 1',
			{ parallelization_enabled: true, max_concurrent_tasks: 1 },
		],
	] as const)('isolation forced with %s; a failed isolation is refused EPIC_ISOLATION_DEGRADED', async (_label, profile) => {
		await setup(profile, true);
		const hook = createDelegationGateHook(baseConfig, directory);
		const attempt = hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'epic-1' },
			{ args: { ...CODER_ARGS } },
		);
		await expect(attempt).rejects.toThrow('EPIC_ISOLATION_DEGRADED');
		await expect(attempt).rejects.toThrow(
			'STANDARD_WORKTREE_ISOLATION_UNAVAILABLE',
		);
		await expect(attempt).rejects.toThrow('/swarm epic close --abandon');
		// `required`: the session is NOT serialized/degraded, nothing ran in
		// the main tree, no coder settlement began.
		expect(getStandardWorktreeDegradationReason('parent')).toBeUndefined();
		expect(degradedEvents(directory)).toEqual([]);
		expect(fs.existsSync(walPath(directory))).toBe(false);
	});

	test('the session concurrency override does not switch isolation off', async () => {
		await setup(
			{ parallelization_enabled: true, max_concurrent_tasks: 4 },
			true,
		);
		ensureAgentSession('parent').maxConcurrencyOverride = 1;
		const hook = createDelegationGateHook(baseConfig, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'epic-2' },
				{ args: { ...CODER_ARGS } },
			),
		).rejects.toThrow('EPIC_ISOLATION_DEGRADED');
	});

	test('worktree.policy "disabled" mid-epic ⇒ refused, never run un-isolated', async () => {
		await setup({ parallelization_enabled: false }, true);
		const hook = createDelegationGateHook(
			{ ...baseConfig, worktree: { policy: 'disabled' } } as PluginConfig,
			directory,
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'epic-3' },
				{ args: { ...CODER_ARGS } },
			),
		).rejects.toThrow('worktree.policy is "disabled"');
		expect(fs.existsSync(walPath(directory))).toBe(false);
	});

	test('no open epic + parallel mode off ⇒ unchanged: no isolation attempt, the coder runs in the main tree', async () => {
		await setup({ parallelization_enabled: false }, false);
		const hook = createDelegationGateHook(baseConfig, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'plain-1' },
				{ args: { ...CODER_ARGS } },
			),
		).resolves.toBeUndefined();
		expect(getStandardWorktreeDegradationReason('parent')).toBeUndefined();
		expect(JSON.parse(fs.readFileSync(walPath(directory), 'utf-8')).state).toBe(
			'DISPATCHED',
		);
	});

	test('no open epic + parallel mode on ⇒ unchanged #2271 degradation (serialize, run in the root)', async () => {
		await setup(
			{ parallelization_enabled: true, max_concurrent_tasks: 4 },
			false,
		);
		const hook = createDelegationGateHook(baseConfig, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'plain-2' },
				{ args: { ...CODER_ARGS } },
			),
		).resolves.toBeUndefined();
		expect(getStandardWorktreeDegradationReason('parent')?.reason).toContain(
			'STANDARD_WORKTREE_ISOLATION_UNAVAILABLE',
		);
		expect(degradedEvents(directory)).toHaveLength(1);
	});

	test('a task outside the epic plan is never treated as an epic task', async () => {
		await setup({ parallelization_enabled: false }, true);
		const hook = createDelegationGateHook(baseConfig, directory);
		// The plan has only 1.1: 9.9 fails the gate's own scope rules, and
		// never with the Epic isolation refusal.
		let message = '';
		try {
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'epic-4' },
				{
					args: {
						...CODER_ARGS,
						task_id: '9.9',
						prompt: 'TASK: 9.9\nFILE: src/other.ts\nACCEPTANCE: done',
					},
				},
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toContain('EPIC_ISOLATION_DEGRADED');
	});
});
