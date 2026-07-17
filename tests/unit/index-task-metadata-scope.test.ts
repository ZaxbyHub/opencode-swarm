import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import OpenCodeSwarm from '../../src/index';
import {
	clearScopeBindings,
	getAuthorizedScopeBinding,
} from '../../src/scope/scope-binding';
import { resetSwarmState } from '../../src/state';

const PARENT_SESSION = 'parent-session';
const CHILD_SESSION = 'child-session';
const TASK_CALL_ID = 'task-call-id';

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Task metadata scope activation',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise the production Task event path',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
	};
}

describe('production Task metadata scope activation', () => {
	let directory: string;

	beforeEach(() => {
		resetSwarmState();
		clearScopeBindings();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'task-metadata-scope-')),
		);
		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				quiet: true,
				version_check: false,
				hooks: { delegation_gate: false },
			}),
		);
	});

	afterEach(() => {
		resetSwarmState();
		clearScopeBindings();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('uses the Task ToolPart callID, not its distinct part id', async () => {
		const currentPlan = plan();
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(currentPlan),
		);
		const plugin = await OpenCodeSwarm.server({
			client: {} as never,
			project: {} as never,
			directory,
			worktree: directory,
			serverUrl: new URL('http://localhost:3000'),
			$: {} as never,
		});
		const toolBefore = plugin['tool.execute.before'];
		const chatMessage = plugin['chat.message'];
		expect(typeof toolBefore).toBe('function');
		expect(typeof chatMessage).toBe('function');
		expect(typeof plugin.event).toBe('function');

		await chatMessage?.(
			{ sessionID: PARENT_SESSION, agent: 'architect' } as never,
			{} as never,
		);
		await toolBefore?.(
			{
				tool: 'Task',
				sessionID: PARENT_SESSION,
				callID: TASK_CALL_ID,
			} as never,
			{
				args: {
					subagent_type: 'coder',
					prompt: 'TASK: 1.1\nACCEPTANCE: production event activates scope',
				},
			} as never,
		);

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: TASK_CALL_ID,
						callID: TASK_CALL_ID,
						type: 'text',
						tool: 'Task',
						state: {
							metadata: {
								parentSessionId: PARENT_SESSION,
								sessionId: 'spoofed-child',
							},
						},
					},
				},
			},
		});
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'spoofed-child',
			}),
		).toBeNull();

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'part-id-is-not-the-call-id',
						callID: TASK_CALL_ID,
						type: 'tool',
						tool: 'Task',
						state: {
							metadata: {
								parentSessionId: PARENT_SESSION,
								sessionId: CHILD_SESSION,
							},
						},
					},
				},
			},
		});

		const binding = getAuthorizedScopeBinding({
			directory,
			plan: currentPlan,
			taskId: '1.1',
			activeSessionId: CHILD_SESSION,
		});
		expect(binding?.dispatchCallId).toBe(TASK_CALL_ID);
		expect(binding?.ownerMessageId).toBe(TASK_CALL_ID);

		await chatMessage?.(
			{ sessionID: CHILD_SESSION, agent: 'coder' } as never,
			{} as never,
		);
		await expect(
			toolBefore?.(
				{
					tool: 'write',
					sessionID: CHILD_SESSION,
					callID: 'write-call',
				} as never,
				{ args: { path: 'src/index.ts', content: 'in scope' } } as never,
			),
		).resolves.toBeUndefined();
	});
});
