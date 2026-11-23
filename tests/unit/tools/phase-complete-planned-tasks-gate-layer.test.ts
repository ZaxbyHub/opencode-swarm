/**
 * #3770 direct gate-layer unit legs (moved from the refusal suite and then
 * the degraded suite as each approached the FR-006 500-line cap). Static
 * ISO literals (check:test-clock).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import {
	PLANNED_TASKS_BLOCKED_REASON,
	runPlannedTasksGate,
} from '../../../src/tools/phase-complete/gates/planned-tasks-gate';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

interface TaskFixture {
	id: string;
	status: string;
}

function planWithTasks(tasks: TaskFixture[]): Record<string, unknown> {
	return {
		schema_version: '1.0.0',
		title: 'Planned Tasks Gate Test',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: 1,
					status: task.status,
					description: task.description ?? 'done',
					size: 'small',
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
}

describe('#3770 planned-tasks gate layer (direct unit legs)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('planned-tasks-gate-layer-');
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		removeTreeWithRetry(tempDir);
		resetSwarmState();
	});

	test('gate refuses on its own with pending tasks (no early refusal involved)', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planWithTasks([
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				]),
			),
		);
		const result = await runPlannedTasksGate({
			phase: 1,
			dir: tempDir,
			sessionID: 'sess-gate',
			pluginConfig: {} as never,
			agentsDispatched: [],
			safeWarn: () => undefined,
			preflightNowMs: 0,
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(PLANNED_TASKS_BLOCKED_REASON);
		expect(result.message).toContain('1.2');
	});

	test('gate passes on its own with completed/closed tasks', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planWithTasks([
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'closed' },
				]),
			),
		);
		const result = await runPlannedTasksGate({
			phase: 1,
			dir: tempDir,
			sessionID: 'sess-gate',
			pluginConfig: {} as never,
			agentsDispatched: [],
			safeWarn: () => undefined,
			preflightNowMs: 0,
		});
		expect(result.blocked).toBe(false);
	});
});
