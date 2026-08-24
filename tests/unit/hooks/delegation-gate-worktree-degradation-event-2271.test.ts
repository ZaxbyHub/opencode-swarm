/**
 * Issue #2271 bug 1 — loud degradation when worktree isolation silently
 * falls back to the project root.
 *
 * With the default `worktree.policy: "auto"`, a provisioning failure (here:
 * no OpenCode SDK client available) serializes the session and runs the coder
 * un-isolated in the project root with `worktreeDir: null`. That degradation
 * must be recorded durably in .swarm/events.jsonl so a later
 * dispatch_no_mutation outcome is explainable from the ledger.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	checkStandardWorktreeSerializationRelease,
	getStandardWorktreeDegradationReason,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
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
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
}

function readEvents(directory: string): Array<Record<string, unknown>> {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf-8')
		.trim()
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('issue #2271 bug 1 — worktree_isolation_degraded ledger event', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		({ dir: directory, cleanup } = createSafeTestDir('wt-degrade-2271-'));
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
		await writeApprovedPlan(
			directory,
			[{ id: '1.1', files: ['src/feature.ts'] }],
			{
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 4,
				},
			},
		);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		cleanup();
	});

	test('degraded dispatch records worktree_isolation_degraded in events.jsonl', async () => {
		const hook = createDelegationGateHook(config, directory);
		// swarmState.opencodeClient is null after resetSwarmState → provisioning
		// degrades: STANDARD_WORKTREE_ISOLATION_UNAVAILABLE → serialize →
		// coder runs in the project root (worktreeDir: null).
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'degraded-1' },
				{ args: { ...CODER_ARGS } },
			),
		).resolves.toBeUndefined();

		const degradation = getStandardWorktreeDegradationReason('parent');
		expect(degradation).toBeDefined();
		expect(degradation?.reason).toContain(
			'STANDARD_WORKTREE_ISOLATION_UNAVAILABLE',
		);

		const events = readEvents(directory).filter(
			(event) => event.type === 'worktree_isolation_degraded',
		);
		expect(events.length).toBe(1);
		expect(events[0]?.sessionId).toBe('parent');
		expect(events[0]?.callId).toBe('degraded-1');
		expect(events[0]?.taskId).toBe('1.1');
		expect(String(events[0]?.reason)).toContain(
			'STANDARD_WORKTREE_ISOLATION_UNAVAILABLE',
		);

		// The dispatch itself still proceeds (settlement began in the root).
		const walPath = path.join(
			directory,
			'.swarm',
			'coder-settlements',
			'1.1.json',
		);
		expect(JSON.parse(fs.readFileSync(walPath, 'utf-8')).state).toBe(
			'DISPATCHED',
		);
	});

	test('serialization release clears the degradation reason', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'degraded-2' },
			{ args: { ...CODER_ARGS } },
		);
		expect(getStandardWorktreeDegradationReason('parent')).toBeDefined();

		// checkStandardWorktreeSerializationRelease with a zero TTL releases
		// immediately; the recorded reason must be cleared with it.
		checkStandardWorktreeSerializationRelease('parent', {
			policy: 'auto',
			serialization_release_after_ms: 0,
		} as Parameters<typeof checkStandardWorktreeSerializationRelease>[1]);
		expect(getStandardWorktreeDegradationReason('parent')).toBeUndefined();
	});

	test('explicit policy disabled never records a degradation event', async () => {
		// PR-review T-neg1: worktree.policy 'disabled' is a user opt-out, not a
		// degradation — precreate returns before any serialization, so no
		// reason exists and no worktree_isolation_degraded event may be
		// written even though the coder runs un-isolated in the project root.
		const disabledConfig = {
			...config,
			worktree: { policy: 'disabled' },
		} as PluginConfig;
		const hook = createDelegationGateHook(disabledConfig, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'disabled-1' },
			{ args: { ...CODER_ARGS } },
		);
		expect(getStandardWorktreeDegradationReason('parent')).toBeUndefined();
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		if (fs.existsSync(eventsPath)) {
			const degraded = readEvents(directory).filter(
				(event) => event.type === 'worktree_isolation_degraded',
			);
			expect(degraded).toEqual([]);
		}
		// The dispatch itself still proceeds in the primary tree.
		const walPath = path.join(
			directory,
			'.swarm',
			'coder-settlements',
			'1.1.json',
		);
		expect(fs.existsSync(walPath)).toBe(true);
	});
});
