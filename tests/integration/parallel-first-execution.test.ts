/**
 * Integration test for v8 parallel-first execution (#1674).
 *
 * This is the test that DIRECTLY proves acceptance criterion 4 ("overlapping/
 * unknown scopes → serial by default, enforced by the harness not advisory"):
 * it drives the real `toolBefore` gate path and observes the observable
 * consequence of `parallelModeActive` — the durable Stage A parallel exemption.
 *
 * Mechanism: with task A in `coder_delegated` state, dispatching a coder for a
 * DIFFERENT task B:
 *   - `parallelModeActive === true` (disjoint scopes) → the parallel-mode
 *     exemption fires → NO throw (the 2nd concurrent coder is allowed).
 *   - `parallelModeActive === false` (overlapping/unknown scopes) → exemption
 *     does NOT fire → throws STAGE_A_REQUIRED (serial fallback).
 *
 * This couples the test to the real gate conjunction (`delegation-gate.ts`
 * `parallelModeActive`), so a future refactor that drops or mis-wires the
 * `scopeAllowsParallel` term breaks this test. That is the safety net the
 * approved plan promised.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../src/config';
import { transitionTaskWorkflowEvidence } from '../../src/gate-evidence';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import type { DelegationEntry } from '../../src/state';
import {
	advanceTaskState,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { writeApprovedPlan } from '../helpers/approved-plan';
import { withFrozenClock } from '../helpers/test-clock.js';

function makeConfig(): PluginConfig {
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

function simulateCoderDelegation(sessionId: string): void {
	const existing = swarmState.delegationChains.get(sessionId) ?? [];
	const entry: DelegationEntry = {
		from: 'architect',
		to: 'coder',
		timestamp: withFrozenClock(() => Date.now(), {
			fixedNow: 1_700_000_000_000,
		}),
	};
	swarmState.delegationChains.set(sessionId, [...existing, entry]);
}

async function seedAcceptedCoderMutation(
	directory: string,
	taskId: string,
): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `parallel-first:${taskId}`,
	});
}

/**
 * Write a plan WITH `parallelization_enabled: true` and the given tasks, then
 * record the critic approval. Reuses `writeApprovedPlan`'s approval machinery
 * but injects the execution_profile that the gate reads.
 */
async function writeParallelApprovedPlan(
	directory: string,
	tasks: Array<{ id: string; files: string[] }>,
): Promise<void> {
	await writeApprovedPlan(directory, tasks, {
		executionProfile: {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			council_parallel: true,
			locked: false,
			auto_proceed: false,
			commit_after_each_completed_task: false,
		},
	});
}

/**
 * #2532: declare scopes through the REGISTERED v2 authority (declare_scope) —
 * the gate's verdict reads the binding store, never the legacy v1 projection.
 */
async function declareScopes(
	directory: string,
	entries: Array<{ id: string; files: string[] }>,
): Promise<void> {
	for (const entry of entries) {
		const result = await executeDeclareScope(
			{ taskId: entry.id, files: entry.files, working_directory: directory },
			directory,
			{ sessionID: 'v8-parallel-int-architect', messageID: `m-${entry.id}` },
		);
		if (!result.success) {
			throw new Error(
				`declare_scope failed for ${entry.id}: ${result.message}`,
			);
		}
	}
}

/** Declare DISJOINT v2 scopes for the given task ids. */
async function writeDisjointScopes(
	directory: string,
	taskIds: string[],
): Promise<void> {
	await declareScopes(
		directory,
		taskIds.map((id) => ({
			id,
			files: [`src/${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.ts`],
		})),
	);
}

/** Declare OVERLAPPING v2 scopes (all tasks touch the same file). */
async function writeOverlappingScopes(
	directory: string,
	taskIds: string[],
): Promise<void> {
	await declareScopes(
		directory,
		taskIds.map((id) => ({ id, files: ['src/shared.ts'] })),
	);
}

function makeCoderInput(sessionId: string, taskId: string) {
	return {
		tool: 'Task',
		sessionID: sessionId,
		callID: `call-${taskId}-${Math.random().toString(36).slice(2, 6)}`,
	};
}

function makeCoderOutput(taskId: string) {
	return {
		args: {
			subagent_type: 'coder',
			task_id: taskId,
			prompt: `Implement ${taskId}\nACCEPTANCE: task complete and covered by tests`,
		},
	};
}

describe('v8 parallel-first execution — gate enforcement through toolBefore (#1674)', () => {
	let testDir: string;

	beforeEach(() => {
		resetSwarmState();
		testDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'v8-parallel-int-')),
		);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5 });
		} catch {
			// best-effort
		}
	});

	test('DISJOINT scopes → 2nd concurrent coder for a different task is ALLOWED (parallelModeActive === true)', async () => {
		await writeParallelApprovedPlan(testDir, [
			{ id: '1.1', files: ['src/a.ts'] },
			{ id: '1.2', files: ['src/b.ts'] },
		]);
		await writeDisjointScopes(testDir, ['1.1', '1.2']);

		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'v8-parallel-disjoint';
		const session = ensureAgentSession(sessionId, 'architect', testDir);

		// Task 1.1 is already coder_delegated (in-flight, awaiting review).
		advanceTaskState(session, '1.1', 'coder_delegated');
		await seedAcceptedCoderMutation(testDir, '1.1');
		simulateCoderDelegation(sessionId);

		// Dispatch a coder for the DIFFERENT, dependency-ready task 1.2.
		// Under v8 with disjoint scopes, parallelModeActive === true, so the
		// parallel-mode exemption fires and the 2nd coder is allowed.
		await expect(
			hooks.toolBefore(
				makeCoderInput(sessionId, '1.2'),
				makeCoderOutput('1.2'),
			),
		).resolves.toBeUndefined();
	});

	test('OVERLAPPING scopes → 2nd concurrent coder for a different task is BLOCKED (parallelModeActive === false → serial fallback)', async () => {
		await writeParallelApprovedPlan(testDir, [
			{ id: '1.1', files: ['src/shared.ts'] },
			{ id: '1.2', files: ['src/shared.ts'] },
		]);
		await writeOverlappingScopes(testDir, ['1.1', '1.2']);

		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'v8-parallel-overlap';
		const session = ensureAgentSession(sessionId, 'architect', testDir);

		advanceTaskState(session, '1.1', 'coder_delegated');
		await seedAcceptedCoderMutation(testDir, '1.1');
		simulateCoderDelegation(sessionId);

		// Same scenario as above but scopes overlap. parallelModeActive === false
		// (gate's inline verdict is conflicts_present), so the parallel-mode
		// exemption does NOT fire → STAGE_A_REQUIRED (serial fallback).
		await expect(
			hooks.toolBefore(
				makeCoderInput(sessionId, '1.2'),
				makeCoderOutput('1.2'),
			),
		).rejects.toThrow('STAGE_A_REQUIRED');
	});

	test('UNKNOWN scopes (no scope files) → 2nd concurrent coder is BLOCKED (fail-closed serial)', async () => {
		await writeParallelApprovedPlan(testDir, [
			{ id: '1.1', files: ['src/a.ts'] },
			{ id: '1.2', files: ['src/b.ts'] },
		]);
		// Intentionally write NO scope files → readTaskScopes returns null for
		// both → verdict unknown_scopes → parallelModeActive === false.

		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'v8-parallel-unknown';
		const session = ensureAgentSession(sessionId, 'architect', testDir);

		advanceTaskState(session, '1.1', 'coder_delegated');
		await seedAcceptedCoderMutation(testDir, '1.1');
		simulateCoderDelegation(sessionId);

		await expect(
			hooks.toolBefore(
				makeCoderInput(sessionId, '1.2'),
				makeCoderOutput('1.2'),
			),
		).rejects.toThrow('STAGE_A_REQUIRED');
	});

	test('parallelization_enabled: false → 2nd concurrent coder is BLOCKED even with disjoint scopes (flag still gates)', async () => {
		await writeApprovedPlan(testDir, [
			{ id: '1.1', files: ['src/a.ts'] },
			{ id: '1.2', files: ['src/b.ts'] },
		]);
		// writeApprovedPlan does NOT set execution_profile → schema default
		// parallelization_enabled: false → parallelModeActive === false.
		await writeDisjointScopes(testDir, ['1.1', '1.2']);

		const config = makeConfig();
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'v8-parallel-flag-off';
		const session = ensureAgentSession(sessionId, 'architect', testDir);

		advanceTaskState(session, '1.1', 'coder_delegated');
		await seedAcceptedCoderMutation(testDir, '1.1');
		simulateCoderDelegation(sessionId);

		await expect(
			hooks.toolBefore(
				makeCoderInput(sessionId, '1.2'),
				makeCoderOutput('1.2'),
			),
		).rejects.toThrow('STAGE_A_REQUIRED');
	});
});
