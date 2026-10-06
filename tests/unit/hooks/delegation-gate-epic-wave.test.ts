/**
 * Epic v2 C4 — the REAL delegation gate enforces the active epic wave.
 *
 *   - wave-only admission: a coder outside the active wave, before any wave,
 *     or with a scope grown past the frozen one is refused with the policy
 *     code (and nothing is dispatched);
 *   - the wave decides the slot cap: a multi-task wave dispatches up to the
 *     epic's `maxParallel` coders although the plan says
 *     `parallelization_enabled: false` (the C3-review bug: forced isolation +
 *     serial profile ⇒ PARALLEL_SLOTS_EXHAUSTED on the second wave coder);
 *     a single-task wave is serial (slot cap 1);
 *   - reviewer / test_engineer are never routed through coder admission;
 *   - without an epic the serial profile still caps background coders at 1.
 *
 * Isolation succeeds here: the SDK client is stubbed (child sessions) and
 * worktrees are REAL linked git worktrees.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	createDelegationGateHook,
	_internals as gateInternals,
} from '../../../src/hooks/delegation-gate';
import {
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { executeDeclareScope } from '../../../src/tools/declare-scope';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import {
	issuedWaveForTest,
	openEpicForTest,
} from '../../helpers/epic-lifecycle';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const SESSION = 'ses_epicWaveGate';
const FILES: Record<string, string> = {
	'1.1': 'src/one.ts',
	'1.2': 'src/two.ts',
	'1.3': 'src/three.ts',
	'1.4': 'src/four.ts',
};

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		delegation_gate: true,
		background_subagents: true,
		background_pending_timeout_minutes: 30,
	},
	worktree: { policy: 'auto' },
} as PluginConfig;

const realReserve = gateInternals.reserveBackgroundCoderSlotForDispatch;

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

let directory = '';
let cleanup = (): void => {};
let capacities: number[] = [];

async function setup(waveTasks: string[] | null, epic = true): Promise<void> {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(epic ? { epic: { mode: { enabled: true } } } : {}),
	);
	await writeApprovedPlan(
		directory,
		Object.entries(FILES).map(([id, file]) => ({ id, files: [file] })),
		{ executionProfile: { parallelization_enabled: false, locked: true } },
	);
	for (const [taskId, file] of Object.entries(FILES)) {
		const declared = await executeDeclareScope(
			{ taskId, files: [file], working_directory: directory },
			directory,
			{ sessionID: SESSION, messageID: `m-${taskId}` },
		);
		expect(declared.success).toBe(true);
	}
	if (epic) {
		const waves = waveTasks
			? [
					issuedWaveForTest(
						Object.fromEntries(waveTasks.map((id) => [id, [FILES[id]]])),
					),
				]
			: [];
		openEpicForTest(directory, {
			waves,
			activeWaveSeq: waveTasks ? 1 : null,
			config: {
				commitPolicy: 'current-branch',
				isolation: 'worktree',
				maxParallel: 2,
			},
		});
	}
	ensureAgentSession(SESSION, 'architect', directory);
}

function coderArgs(
	taskId: string,
	files = [FILES[taskId]],
	background = false,
) {
	return {
		subagent_type: 'coder',
		task_id: taskId,
		...(background ? { background: true } : {}),
		prompt: `TASK: ${taskId}\n${files.map((f) => `FILE: ${f}`).join('\n')}\nACCEPTANCE: done`,
	};
}

async function launch(
	hook: ReturnType<typeof createDelegationGateHook>,
	taskId: string,
	ordinal: number,
	background = true,
): Promise<void> {
	const args = coderArgs(taskId, undefined, background);
	const callID = `call-${ordinal}`;
	await hook.toolBefore({ tool: 'Task', sessionID: SESSION, callID }, { args });
	if (!background) return;
	await hook.toolAfter(
		{ tool: 'Task', sessionID: SESSION, callID, args },
		{
			state: 'running',
			output: `<task id="bg-session-${ordinal}" state="running">Background task started</task>`,
			metadata: { background: true, jobId: `bg-job-${ordinal}` },
		},
	);
}

beforeEach(() => {
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	({ dir: directory, cleanup } = createSafeTestDir('epic-wave-gate-'));
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'tests@example.com']);
	git(directory, ['config', 'user.name', 'Tests']);
	fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
	git(directory, ['add', 'base.txt']);
	git(directory, ['commit', '-m', 'seed']);
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n.opencode/\n.swarm-worktrees/\n',
	);
	let child = 0;
	swarmState.opencodeClient = {
		session: { create: async () => ({ data: { id: `ses_child_${++child}` } }) },
	} as unknown as typeof swarmState.opencodeClient;
	capacities = [];
	gateInternals.reserveBackgroundCoderSlotForDispatch = ((
		dir: string,
		request: { maxConcurrent: number },
	) => {
		capacities.push(request.maxConcurrent);
		return realReserve(dir, request as never);
	}) as never;
});

afterEach(() => {
	gateInternals.reserveBackgroundCoderSlotForDispatch = realReserve;
	swarmState.opencodeClient = null as never;
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	closeAllProjectDbs();
	cleanup();
});

describe('wave-only admission through the real gate', () => {
	test('no active wave ⇒ EPIC_NO_ACTIVE_WAVE (remedy: epic_next_wave)', async () => {
		await setup(null);
		const hook = createDelegationGateHook(config, directory);
		const attempt = launch(hook, '1.1', 1, false);
		await expect(attempt).rejects.toThrow('EPIC_NO_ACTIVE_WAVE: ');
		await expect(attempt).rejects.toThrow('call epic_next_wave');
		expect(standardWorktreeByCallID.size).toBe(0);
	});

	test('a task outside the wave ⇒ EPIC_TASK_NOT_IN_ACTIVE_WAVE; a wave task is admitted isolated', async () => {
		await setup(['1.1', '1.2']);
		const hook = createDelegationGateHook(config, directory);
		await expect(launch(hook, '1.3', 1, false)).rejects.toThrow(
			'EPIC_TASK_NOT_IN_ACTIVE_WAVE: task 1.3 is not in the active wave 1',
		);
		expect(standardWorktreeByCallID.size).toBe(0);
		await launch(hook, '1.1', 2, false);
		expect(standardWorktreeByCallID.get('call-2')?.planTaskId).toBe('1.1');
	});

	test('a declared scope grown past the frozen one ⇒ EPIC_WAVE_SCOPE_DRIFT', async () => {
		await setup(['1.1', '1.2']);
		const grown = ['src/one.ts', 'src/extra.ts'];
		const declared = await executeDeclareScope(
			{
				taskId: '1.1',
				files: grown,
				working_directory: directory,
				replace_existing: true,
			},
			directory,
			{ sessionID: SESSION, messageID: 'm-grow' },
		);
		expect(declared.success).toBe(true);
		const hook = createDelegationGateHook(config, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'drift' },
				{ args: coderArgs('1.1', grown) },
			),
		).rejects.toThrow('EPIC_WAVE_SCOPE_DRIFT: ');
		expect(standardWorktreeByCallID.size).toBe(0);
	});

	test('Epic disabled by config with the sentinel left behind ⇒ the non-Epic gate', async () => {
		await setup(null); // open epic, no active wave
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({}),
		);
		// (A corrupt row with config off is covered by gate-policy.test.ts.)
		const hook = createDelegationGateHook(config, directory);
		await launch(hook, '1.1', 1, false);
		// Serial profile, no epic: the coder runs in the main tree.
		expect(standardWorktreeByCallID.size).toBe(0);
	});

	test('reviewer and test_engineer are never routed through coder admission', async () => {
		await setup(null); // no active wave: any coder would be refused
		const hook = createDelegationGateHook(config, directory);
		for (const agent of ['reviewer', 'test_engineer']) {
			let message = '';
			try {
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: `qa-${agent}` },
					{
						args: {
							subagent_type: agent,
							task_id: '1.1',
							prompt: 'TASK: 1.1\nReview the change',
						},
					},
				);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).not.toContain('EPIC_');
		}
	});
});

describe('the wave decides the slot cap', () => {
	test('multi-task wave + parallelization_enabled:false ⇒ maxParallel slots, then PARALLEL_SLOTS_EXHAUSTED', async () => {
		await setup(['1.1', '1.2', '1.3']);
		const hook = createDelegationGateHook(config, directory);
		await launch(hook, '1.1', 1);
		await launch(hook, '1.2', 2);
		expect(capacities).toEqual([2, 2]);
		await expect(launch(hook, '1.3', 3)).rejects.toThrow(
			'PARALLEL_SLOTS_EXHAUSTED',
		);
		expect(
			['call-1', 'call-2'].map(
				(id) => standardWorktreeByCallID.get(id)?.planTaskId,
			),
		).toEqual(['1.1', '1.2']);
	});

	test('a single-task wave is serial: slot cap 1', async () => {
		await setup(['1.1']);
		const hook = createDelegationGateHook(config, directory);
		await launch(hook, '1.1', 1);
		expect(capacities).toEqual([1]);
		expect(standardWorktreeByCallID.get('call-1')?.planTaskId).toBe('1.1');
	});

	test('without an epic the serial profile caps background coders at 1 (unchanged)', async () => {
		await setup(null, false);
		const hook = createDelegationGateHook(config, directory);
		await launch(hook, '1.1', 1);
		expect(capacities).toEqual([1]);
		await expect(launch(hook, '1.2', 2)).rejects.toThrow(
			'PARALLEL_SLOTS_EXHAUSTED',
		);
		// Not isolated: the serial profile keeps the main tree.
		expect(standardWorktreeByCallID.size).toBe(0);
	});
});
