import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { TASK_ID_RESOLUTION_LIMITS } from '../../../src/hooks/task-id-resolver.js';

function writePlan(directory: string, taskIds: string[]): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Participation Plan',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					required_agents: ['docs'],
					tasks: taskIds.map((id) => ({
						id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `Task ${id}`,
						depends: [],
						files_touched: ['docs/configuration.md'],
					})),
				},
			],
		}),
	);
}

function runningOutput(child = 'child'): object {
	return {
		output: `<task id="${child}" state="running"><summary>running</summary></task>`,
		metadata: { background: true, status: 'running', jobId: `job-${child}` },
	};
}

function readPendingTaskId(directory: string): string | null {
	const store = JSON.parse(
		fs.readFileSync(
			path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
			'utf8',
		),
	) as { pending: Array<{ taskId: string | null }> };
	expect(store.pending).toHaveLength(1);
	return store.pending[0]!.taskId;
}

describe('phase participation task-id safety', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.realpathSync(
			fs.mkdtempSync(
				path.join(process.cwd(), 'phase-participation-task-id-safety-'),
			),
		);
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('unknown explicit strict task_id does not fall through to prompt candidate', async () => {
		writePlan(directory, ['1.1']);

		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: {
				subagent_type: 'docs',
				task_id: '9.9',
				prompt: 'TASK: 1.1\nUpdate docs',
			},
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: runningOutput(),
		});

		expect(readPendingTaskId(directory)).toBeNull();
	});

	test('oversized plan context keeps numeric prompt markers taskless', async () => {
		writePlan(
			directory,
			Array.from(
				{ length: TASK_ID_RESOLUTION_LIMITS.maxKnownIds + 1 },
				(_, index) => `1.${index + 1}`,
			),
		);

		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: {
				subagent_type: 'docs',
				prompt: 'TASK: 1.1\nUpdate docs',
			},
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: runningOutput('child-over-limit'),
		});

		expect(readPendingTaskId(directory)).toBeNull();
	});
});
