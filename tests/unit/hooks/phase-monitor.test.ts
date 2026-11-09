/**
 * Unit tests for phase-monitor.ts — createPhaseMonitorHook.
 *
 * Uses ONLY real filesystem temp directories — no mock.module calls — to avoid
 * module mock leakage into other tests (plan/manager exports) when running in
 * the same bun worker process.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreflightTriggerManager } from '../../../src/background/trigger';
import type {
	CuratorConfig,
	CuratorInitResult,
} from '../../../src/hooks/curator-types';
import { createPhaseMonitorHook } from '../../../src/hooks/phase-monitor';

// Mock the preflightManager
const mockCheckAndTrigger =
	jest.fn<
		(
			phase: number,
			completedTasks: number,
			totalTasks: number,
		) => Promise<boolean>
	>();

const mockPreflightManager = {
	checkAndTrigger: mockCheckAndTrigger,
} as unknown as PreflightTriggerManager;

// Stub curatorRunner to prevent real curator from running
const stubCuratorRunner =
	jest.fn<
		(_directory: string, _config: CuratorConfig) => Promise<CuratorInitResult>
	>();

/** Write a valid plan.json to tempDir/.swarm/ */
function writePlanFile(
	tempDir: string,
	currentPhase: number,
	phases: Array<{
		id: number;
		tasks: Array<{ id: string; status: string }>;
	}>,
): void {
	const swarmDir = path.join(tempDir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: currentPhase,
		phases: phases.map((p) => ({
			id: p.id,
			name: `Phase ${p.id}`,
			status: 'in_progress',
			tasks: p.tasks.map((t) => ({
				id: t.id,
				phase: p.id,
				status: t.status,
				size: 'small',
				description: `Task ${t.id}`,
				depends: [],
				files_touched: [],
			})),
		})),
	};
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan),
		'utf-8',
	);
	// Write plan.md so loadPlan doesn't attempt regeneration
	fs.writeFileSync(
		path.join(swarmDir, 'plan.md'),
		`# Plan\n## Phase ${currentPhase}\n`,
		'utf-8',
	);
}

describe('createPhaseMonitorHook', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-monitor-test-'));
		mockCheckAndTrigger.mockClear();
		stubCuratorRunner.mockClear();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('On first call: reads plan, stores phase, does NOT call checkAndTrigger', async () => {
		writePlanFile(tempDir, 1, [
			{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
		]);

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		await hook({ sessionID: 'sess-phase-monitor-test' }, {});

		// Should NOT call checkAndTrigger on first call (phase initialization)
		expect(mockCheckAndTrigger).not.toHaveBeenCalled();
	});

	it('On subsequent calls with same phase: does NOT call checkAndTrigger', async () => {
		writePlanFile(tempDir, 1, [
			{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
		]);

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		// First call - initialize
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});

		// Second call with same phase (plan.json unchanged)
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});

		// Should NOT call checkAndTrigger (same phase)
		expect(mockCheckAndTrigger).not.toHaveBeenCalled();
	});

	it('On subsequent calls with different phase: calls checkAndTrigger with correct args', async () => {
		// First call: phase 1 with 2 tasks (1 completed)
		writePlanFile(tempDir, 1, [
			{
				id: 1,
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				],
			},
		]);

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		// First call - initialize phase 1
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});
		mockCheckAndTrigger.mockClear();

		// Second call: phase 2 - plan must contain BOTH phases to look up previous phase
		writePlanFile(tempDir, 2, [
			{
				id: 1,
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				],
			},
			{
				id: 2,
				tasks: [
					{ id: '2.1', status: 'pending' },
					{ id: '2.2', status: 'pending' },
					{ id: '2.3', status: 'pending' },
				],
			},
		]);

		// Third call - phase changed
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});

		// Should call checkAndTrigger with correct arguments
		expect(mockCheckAndTrigger).toHaveBeenCalledWith(
			2, // new phase
			1, // completed tasks from previous phase (phase 1)
			2, // total tasks from previous phase (phase 1)
		);
	});

	it('When loadPlan returns null: does nothing, no error', async () => {
		// No plan.json written → loadPlan returns null

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		// Should not throw - safeHook wraps and swallows errors
		const result = await hook({ sessionID: 'sess-phase-monitor-test' }, {});
		expect(result).toBeUndefined();

		// Should not call checkAndTrigger
		expect(mockCheckAndTrigger).not.toHaveBeenCalled();
	});

	it('Errors inside the hook are swallowed (safeHook wrapping)', async () => {
		// First call: valid plan
		writePlanFile(tempDir, 1, [
			{ id: 1, tasks: [{ id: '1.1', status: 'completed' }] },
		]);

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		// First call - initialize
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});
		mockCheckAndTrigger.mockClear();

		// Corrupt the plan.json so loadPlan fails on second call
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			'{ invalid json !!!',
			'utf-8',
		);

		// Should not throw - error is swallowed by safeHook
		const result = await hook({ sessionID: 'sess-phase-monitor-test' }, {});
		expect(result).toBeUndefined();

		// checkAndTrigger should not have been called due to error
		expect(mockCheckAndTrigger).not.toHaveBeenCalled();
	});

	it('correctly counts completed and total tasks for the previous phase', async () => {
		// Phase 1: 5 tasks, 3 completed
		writePlanFile(tempDir, 1, [
			{
				id: 1,
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'completed' },
					{ id: '1.3', status: 'completed' },
					{ id: '1.4', status: 'pending' },
					{ id: '1.5', status: 'in_progress' },
				],
			},
		]);

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		// First call
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});
		mockCheckAndTrigger.mockClear();

		// Change to phase 2 - include both phases
		writePlanFile(tempDir, 2, [
			{
				id: 1,
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'completed' },
					{ id: '1.3', status: 'completed' },
					{ id: '1.4', status: 'pending' },
					{ id: '1.5', status: 'in_progress' },
				],
			},
			{ id: 2, tasks: [{ id: '2.1', status: 'pending' }] },
		]);

		await hook({ sessionID: 'sess-phase-monitor-test' }, {});

		// Should count 3 completed out of 5
		expect(mockCheckAndTrigger).toHaveBeenCalledWith(2, 3, 5);
	});

	it('handles missing phase in plan.phases gracefully', async () => {
		// First call: phase 1
		writePlanFile(tempDir, 1, [
			{ id: 1, tasks: [{ id: '1.1', status: 'completed' }] },
		]);

		const hook = createPhaseMonitorHook(
			tempDir,
			mockPreflightManager,
			stubCuratorRunner,
		);

		// First call
		await hook({ sessionID: 'sess-phase-monitor-test' }, {});
		mockCheckAndTrigger.mockClear();

		// Change to phase 3, but phases only contain 2 and 3 (phase 1 is missing)
		writePlanFile(tempDir, 3, [
			{ id: 2, tasks: [{ id: '2.1', status: 'completed' }] },
			{ id: 3, tasks: [{ id: '3.1', status: 'pending' }] },
		]);

		await hook({ sessionID: 'sess-phase-monitor-test' }, {});

		// Should call checkAndTrigger with 0, 0 for missing phase 1 data
		expect(mockCheckAndTrigger).toHaveBeenCalledWith(3, 0, 0);
	});
});
