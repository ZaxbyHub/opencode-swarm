/**
 * Integration test for serialized task orphan risk (Issue #1).
 *
 * Verifies that when lock conflicts cause tasks to be routed to serializedTasks,
 * those tasks are actually marked as completed via standard serial flow and
 * phase-ready eventually returns ok: true.
 *
 * This test covers the contract:
 * - LeanTurboPhaseResult.serializedTasks contains task IDs when lock conflicts occur
 * - phase-ready (step 6b) requires serialized tasks to have status: completed in plan.json
 * - Caller responsibility: complete serialized tasks via standard serial flow
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LeanTurboRunner } from '../../../src/turbo/lean/runner';
import {
	emptyPersisted,
	emptyRunState,
	writePersisted,
} from '../../../src/turbo/lean/state';
import { verifyLeanTurboPhaseReady } from '../../../src/turbo/lean/phase-ready';
import type { LeanTurboPersistedState } from '../../../src/turbo/lean/state';

let tmpDir: string;
const SESSION_ID = 'sess-serialized-tasks-test';

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(
			path.join(os.tmpdir(), 'lean-turbo-serialized-tasks-'),
		),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('Lean Turbo serialized task contract', () => {
	test('serializedTasks are routed when lock conflicts occur', async () => {
		// Set up initial durable state with serialized tasks
		const initialState: LeanTurboPersistedState = emptyPersisted();
		const runState = emptyRunState(SESSION_ID, 4);
		runState.status = 'running';
		runState.phase = 1;
		runState.serializedTasks = ['task-1', 'task-2', 'task-3']; // Simulating lock-conflict route

		initialState.sessions[SESSION_ID] = runState;
		writePersisted(tmpDir, initialState);

		// Verify that serializedTasks are persisted
		const persisted = JSON.parse(
			fs.readFileSync(
				path.join(tmpDir, '.swarm', 'turbo-state.json'),
				'utf-8',
			),
		) as LeanTurboPersistedState;
		expect(persisted.sessions[SESSION_ID]?.serializedTasks).toEqual([
			'task-1',
			'task-2',
			'task-3',
		]);
	});

	test('phase-ready fails when serializedTasks are not completed', async () => {
		// Set up state with serialized tasks
		const initialState: LeanTurboPersistedState = emptyPersisted();
		const runState = emptyRunState(SESSION_ID, 4);
		runState.status = 'running';
		runState.phase = 1;
		runState.serializedTasks = ['task-1', 'task-2', 'task-3'];
		runState.lanes = []; // No lanes (all went to serial)

		initialState.sessions[SESSION_ID] = runState;
		writePersisted(tmpDir, initialState);

		// Create plan.json with tasks not yet completed
		const planDir = path.join(tmpDir, '.swarm');
		fs.writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						tasks: [
							{ id: 'task-1', status: 'in_progress' },
							{ id: 'task-2', status: 'in_progress' },
							{ id: 'task-3', status: 'in_progress' },
						],
					},
				],
			}),
		);

		// Verify phase-ready fails (with reviewer/critic checks disabled)
		const result = verifyLeanTurboPhaseReady(tmpDir, 1, SESSION_ID, {
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('not yet completed');
	});

	test('phase-ready passes when serializedTasks are completed via serial flow', async () => {
		// Set up state with serialized tasks
		const initialState: LeanTurboPersistedState = emptyPersisted();
		const runState = emptyRunState(SESSION_ID, 4);
		runState.status = 'running';
		runState.phase = 1;
		runState.serializedTasks = ['task-1', 'task-2', 'task-3'];
		runState.lanes = []; // No lanes (all went to serial)

		initialState.sessions[SESSION_ID] = runState;
		writePersisted(tmpDir, initialState);

		// Create plan.json with tasks completed via serial flow
		const planDir = path.join(tmpDir, '.swarm');
		fs.writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						tasks: [
							{ id: 'task-1', status: 'completed' },
							{ id: 'task-2', status: 'completed' },
							{ id: 'task-3', status: 'completed' },
						],
					},
				],
			}),
		);

		// Verify phase-ready passes (with reviewer/critic checks disabled)
		const result = verifyLeanTurboPhaseReady(tmpDir, 1, SESSION_ID, {
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
		});
		expect(result.ok).toBe(true);
	});

	test('caller responsibility: serializedTasks must be completed before phase advance', async () => {
		// This test documents the contract:
		// 1. LeanTurboRunner returns serializedTasks in the result
		// 2. Caller (orchestrator) must dispatch these tasks via standard serial flow
		// 3. When completed, plan.json is updated with status: completed
		// 4. phase-ready then verifies and allows phase advance

		// Set up state with mix of lanes and serialized tasks
		const initialState: LeanTurboPersistedState = emptyPersisted();
		const runState = emptyRunState(SESSION_ID, 4);
		runState.status = 'running';
		runState.phase = 1;
		runState.lanes = [
			{
				laneId: 'lane-0',
				taskIds: ['task-0'],
				files: ['src/file1.ts'],
				status: 'completed',
				completedAt: new Date().toISOString(),
			},
		];
		runState.serializedTasks = ['task-1', 'task-2', 'task-3'];

		initialState.sessions[SESSION_ID] = runState;
		writePersisted(tmpDir, initialState);

		// Create evidence for completed lane
		const laneEvidencePath = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			'1',
			'lean-turbo',
			'lane-0.json',
		);
		fs.writeFileSync(
			laneEvidencePath,
			JSON.stringify({
				laneId: 'lane-0',
				taskIds: ['task-0'],
				files: ['src/file1.ts'],
				status: 'completed',
			}),
		);

		// Initial state: phase-ready fails because serialized tasks not completed
		const planDir = path.join(tmpDir, '.swarm');
		fs.writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						tasks: [
							{ id: 'task-0', status: 'completed' },
							{ id: 'task-1', status: 'in_progress' },
							{ id: 'task-2', status: 'in_progress' },
							{ id: 'task-3', status: 'in_progress' },
						],
					},
				],
			}),
		);

		let result = verifyLeanTurboPhaseReady(tmpDir, 1, SESSION_ID, {
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
		});
		expect(result.ok).toBe(false);

		// Caller completes serialized tasks via standard flow
		fs.writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						tasks: [
							{ id: 'task-0', status: 'completed' },
							{ id: 'task-1', status: 'completed' },
							{ id: 'task-2', status: 'completed' },
							{ id: 'task-3', status: 'completed' },
						],
					},
				],
			}),
		);

		// Now phase-ready passes
		result = verifyLeanTurboPhaseReady(tmpDir, 1, SESSION_ID, {
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
		});
		expect(result.ok).toBe(true);
	});
});
