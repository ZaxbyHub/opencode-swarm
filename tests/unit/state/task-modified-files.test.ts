import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import {
	advanceTaskState,
	completeModifiedFilesForTask,
	getAgentSession,
	getModifiedFilesForTask,
	MAX_TRACKED_TASK_FILE_ATTRIBUTIONS,
	recordModifiedFileForTask,
	recordModifiedFilesForTask,
	resetModifiedFilesForTask,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function session() {
	const value = getAgentSession('task-files-session');
	if (!value) throw new Error('expected test session');
	return value;
}

const epicDirs: string[] = [];

/**
 * Bind the session to a temp project with an OPEN epic (real lifecycle row +
 * sentinel). Attribution retention follows the project's open epic.
 */
function enterOpenEpic(value: ReturnType<typeof session>): void {
	const dir = canonicalMkdtemp('task-files-epic-');
	epicDirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			epic: { mode: { enabled: true } },
		}),
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({ swarm: 'test-swarm', title: 'Task files', phases: [] }),
	);
	openEpicForTest(dir);
	value.owningProjectKey = dir;
}

beforeEach(() => {
	resetSwarmState();
	startAgentSession('task-files-session', 'architect');
});

afterEach(() => {
	closeAllProjectDbs();
	for (const dir of epicDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('task-keyed modified-file attribution', () => {
	test('keeps reverse-order concurrent task completions distinct', () => {
		const value = session();
		value.currentTaskId = '1.1';

		expect(
			recordModifiedFilesForTask(value, '1.1', ['src/a.ts', 'src/shared.ts']),
		).toBe(true);
		expect(recordModifiedFileForTask(value, '1.2', 'src/b.ts')).toBe(true);

		expect(getModifiedFilesForTask(value, '1.2')).toEqual(['src/b.ts']);
		expect(getModifiedFilesForTask(value, '1.1')).toEqual([
			'src/a.ts',
			'src/shared.ts',
		]);
		expect(value.modifiedFilesThisCoderTask).toEqual([
			'src/a.ts',
			'src/shared.ts',
		]);

		value.currentTaskId = '1.2';
		resetModifiedFilesForTask(value, '1.2');
		expect(value.modifiedFilesThisCoderTask).toEqual([]);
		expect(getModifiedFilesForTask(value, '1.1')).toEqual([
			'src/a.ts',
			'src/shared.ts',
		]);
	});

	test('rejects a new live task at capacity without evicting live attribution', () => {
		const value = session();
		for (let index = 0; index < MAX_TRACKED_TASK_FILE_ATTRIBUTIONS; index++) {
			expect(
				recordModifiedFileForTask(
					value,
					`live-${index}`,
					`src/live-${index}.ts`,
				),
			).toBe(true);
		}

		expect(
			recordModifiedFileForTask(value, 'overflow', 'src/overflow.ts'),
		).toBe(false);
		expect(value.modifiedFilesByTask.size).toBe(
			MAX_TRACKED_TASK_FILE_ATTRIBUTIONS,
		);
		expect(getModifiedFilesForTask(value, 'live-0')).toEqual(['src/live-0.ts']);
		expect(getModifiedFilesForTask(value, 'overflow')).toEqual([]);
	});

	test('reclaims only workflow-complete entries across a lifecycle beyond capacity', () => {
		const value = session();
		enterOpenEpic(value);

		for (
			let index = 0;
			index < MAX_TRACKED_TASK_FILE_ATTRIBUTIONS + 5;
			index++
		) {
			const taskId = `complete-${index}`;
			expect(recordModifiedFileForTask(value, taskId, `src/${taskId}.ts`)).toBe(
				true,
			);
			value.taskWorkflowStates.set(taskId, 'complete');
			completeModifiedFilesForTask(value, taskId);
		}

		expect(value.modifiedFilesByTask.size).toBeLessThanOrEqual(
			MAX_TRACKED_TASK_FILE_ATTRIBUTIONS,
		);
		expect(
			getModifiedFilesForTask(
				value,
				`complete-${MAX_TRACKED_TASK_FILE_ATTRIBUTIONS + 4}`,
			),
		).toEqual([`src/complete-${MAX_TRACKED_TASK_FILE_ATTRIBUTIONS + 4}.ts`]);
		expect(getModifiedFilesForTask(value, 'complete-0')).toEqual([]);
	});

	test('clears non-Epic completion immediately and Epic completion after recording', () => {
		const value = session();
		value.currentTaskId = '2.1';
		recordModifiedFileForTask(value, '2.1', 'src/non-epic.ts');
		value.taskWorkflowStates.set('2.1', 'complete');
		completeModifiedFilesForTask(value, '2.1');
		expect(getModifiedFilesForTask(value, '2.1')).toEqual([]);
		expect(value.modifiedFilesThisCoderTask).toEqual([]);

		enterOpenEpic(value);
		value.currentTaskId = '2.2';
		recordModifiedFileForTask(value, '2.2', 'src/epic.ts');
		value.taskWorkflowStates.set('2.2', 'complete');
		completeModifiedFilesForTask(value, '2.2');
		expect(getModifiedFilesForTask(value, '2.2')).toEqual(['src/epic.ts']);

		resetModifiedFilesForTask(value, '2.2', { remove: true });
		expect(getModifiedFilesForTask(value, '2.2')).toEqual([]);
		expect(value.modifiedFilesThisCoderTask).toEqual([]);
	});

	test('applies cleanup at the actual workflow-complete boundary', () => {
		const value = session();
		value.currentTaskId = '2.3';
		value.taskWorkflowStates.set('2.3', 'tests_run');
		recordModifiedFileForTask(value, '2.3', 'src/workflow.ts');

		advanceTaskState(value, '2.3', 'complete', { emitTelemetry: false });
		expect(getModifiedFilesForTask(value, '2.3')).toEqual([]);

		enterOpenEpic(value);
		value.currentTaskId = '2.4';
		value.taskWorkflowStates.set('2.4', 'tests_run');
		recordModifiedFileForTask(value, '2.4', 'src/workflow-epic.ts');
		advanceTaskState(value, '2.4', 'complete', { emitTelemetry: false });
		expect(getModifiedFilesForTask(value, '2.4')).toEqual([
			'src/workflow-epic.ts',
		]);
	});

	test('round-trips task attribution through a session snapshot', () => {
		const value = session();
		value.currentTaskId = '3.1';
		recordModifiedFilesForTask(value, '3.1', ['src/a.ts', 'src/b.ts']);
		recordModifiedFileForTask(value, '3.2', 'src/c.ts');

		const restored = deserializeAgentSession(serializeAgentSession(value));

		expect(getModifiedFilesForTask(restored, '3.1')).toEqual([
			'src/a.ts',
			'src/b.ts',
		]);
		expect(getModifiedFilesForTask(restored, '3.2')).toEqual(['src/c.ts']);
		expect(restored.modifiedFilesThisCoderTask).toEqual([
			'src/a.ts',
			'src/b.ts',
		]);
	});
});
