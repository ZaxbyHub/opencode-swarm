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
import { resetTelemetryForTesting } from '../../src/telemetry';

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
		// `OpenCodeSwarm.server(...)` below runs `initTelemetry`, which opens a
		// long-lived `createWriteStream` on `<directory>/.swarm/telemetry.jsonl`.
		// Only `resetTelemetryForTesting()` ends that stream. Without it the handle
		// outlives the test and `fs.rmSync` below fails on Windows with
		// `EBUSY: resource busy or locked` — observed as a real CI failure on
		// `unit (windows-latest, 1)`, which retried twice and failed both times.
		// POSIX tolerates unlinking an open file, which is why this only ever
		// surfaced on Windows.
		resetTelemetryForTesting();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	/**
	 * Boot the plugin, register the architect session, and dispatch the coder
	 * Task so a pending_child scope binding is published for TASK_CALL_ID.
	 */
	async function bootAndDispatch(currentPlan: Plan) {
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
		return { plugin, toolBefore, chatMessage };
	}

	// Issue #1896 follow-up (SCOPE_NOT_DECLARED): this event mirrors what the
	// opencode task tool actually emits at v1.1.x — the ToolPart lives in the
	// PARENT session's stream (part.sessionID = parent) and metadata carries ONLY
	// { sessionId, model }. metadata.parentSessionId is NOT emitted on 1.1.x-era
	// runtimes; the old handler required it and therefore never activated.
	test('activates from the real runtime event shape (part.sessionID parent, metadata.sessionId child)', async () => {
		const currentPlan = plan();
		const { plugin, toolBefore, chatMessage } =
			await bootAndDispatch(currentPlan);

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'part-id-is-not-the-call-id',
						sessionID: PARENT_SESSION,
						callID: TASK_CALL_ID,
						type: 'tool',
						tool: 'task',
						state: {
							metadata: {
								sessionId: CHILD_SESSION,
								model: 'some/model',
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

	// Newer opencode ALSO emits metadata.parentSessionId on task parts. The
	// handler must activate on that shape too while IGNORING the metadata parent
	// (parent identity comes from the runtime-assigned part.sessionID). Kept as a
	// SEPARATE test so the previous one stays a pure v1.1.x fixture — the shape
	// whose absence of parentSessionId caused the original bug.
	test('activates on the newer runtime shape (metadata also carries parentSessionId)', async () => {
		const currentPlan = plan();
		const { plugin } = await bootAndDispatch(currentPlan);

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'part-id',
						sessionID: PARENT_SESSION,
						callID: TASK_CALL_ID,
						type: 'tool',
						tool: 'task',
						state: {
							metadata: {
								parentSessionId: PARENT_SESSION,
								sessionId: CHILD_SESSION,
								model: 'some/model',
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
				activeSessionId: CHILD_SESSION,
			}),
		).not.toBeNull();
	});

	test('a text part with task-like metadata never activates (spoof guard)', async () => {
		const currentPlan = plan();
		const { plugin } = await bootAndDispatch(currentPlan);

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: TASK_CALL_ID,
						sessionID: PARENT_SESSION,
						callID: TASK_CALL_ID,
						type: 'text',
						tool: 'task',
						state: {
							metadata: { sessionId: 'spoofed-child' },
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
	});

	// The load-bearing security property: the parent identity comes from the
	// runtime-assigned part.sessionID, and tool-controlled metadata can never
	// override it — even when metadata names the real publishing parent.
	test('metadata.parentSessionId can never override the runtime-assigned parent', async () => {
		const currentPlan = plan();
		const { plugin } = await bootAndDispatch(currentPlan);

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'part-id',
						// Part lives in a NON-publishing session…
						sessionID: 'attacker-session',
						callID: TASK_CALL_ID,
						type: 'tool',
						tool: 'task',
						state: {
							metadata: {
								// …while tool-controlled metadata names the real publisher.
								parentSessionId: PARENT_SESSION,
								sessionId: CHILD_SESSION,
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
				activeSessionId: CHILD_SESSION,
			}),
		).toBeNull();
	});

	test('an empty part.sessionID fails closed (no metadata fallback)', async () => {
		const currentPlan = plan();
		const { plugin } = await bootAndDispatch(currentPlan);

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'part-id',
						sessionID: '  ',
						callID: TASK_CALL_ID,
						type: 'tool',
						tool: 'task',
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
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: CHILD_SESSION,
			}),
		).toBeNull();
	});
});
