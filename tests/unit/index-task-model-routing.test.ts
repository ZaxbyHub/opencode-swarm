import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { _internals as severeInternals } from '../../src/full-auto/severe-result';
import { startFullAutoRun } from '../../src/full-auto/state';
import OpenCodeSwarm from '../../src/index';
import {
	getTaskModelRoutingStateSnapshot,
	resetTaskModelRoutingStateForTests,
} from '../../src/models/task-model-routing';
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const PARENT_SESSION = 'parent-session';
const CHILD_SESSION = 'child-session';

function makeProject(): string {
	return canonicalMkdtemp('index-task-model-routing-');
}

function writeConfig(directory: string): void {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks: { delegation_gate: false },
			agents: {
				coder: {
					model: 'prov/primary',
					fallback_models: ['prov/fb1'],
				},
			},
		}),
	);
}

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Index task-model routing fixture',
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
						description: 'Task one',
						depends: [],
						files_touched: ['src/index.ts'],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task two',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
}

async function bootPlugin(
	directory: string,
	parentLookup?: (sessionID: string) => string | undefined,
) {
	return OpenCodeSwarm.server({
		client: {
			session: {
				get: async ({ path }: { path: { id: string } }) => ({
					data: { parentID: parentLookup?.(path.id) },
					error: null,
				}),
			},
		} as never,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	});
}

async function dispatchCoderTask(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	callID: string,
	prompt: string,
) {
	await plugin['chat.message']?.(
		{ sessionID: PARENT_SESSION, agent: 'architect' } as never,
		{} as never,
	);
	await plugin['tool.execute.before']?.(
		{ tool: 'Task', sessionID: PARENT_SESSION, callID } as never,
		{
			args: {
				subagent_type: 'coder',
				prompt,
			},
		} as never,
	);
}

describe('index task-model routing integration', () => {
	let directory = '';
	let configDirectory = '';
	let previousXdgConfigHome: string | undefined;

	beforeEach(() => {
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		configDirectory = makeProject();
		process.env.XDG_CONFIG_HOME = configDirectory;
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		directory = makeProject();
		writeConfig(directory);
		writePlan(directory);
	});

	afterEach(() => {
		if (previousXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		}
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		resetTelemetryForTesting();
		severeInternals.pendingCorrelations.clear();
		severeInternals.evidenceEvents.clear();
		severeInternals.childBindings.clear();
		try {
			fs.rmSync(directory, { recursive: true, force: true });
			fs.rmSync(configDirectory, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('binds child metadata, correlates severe state, and mutates output.message.model at the real request boundary', async () => {
		const plugin = await bootPlugin(directory);
		await dispatchCoderTask(
			plugin,
			'call-1',
			'TASK: 1.1\nACCEPTANCE: exercise model fallback wiring',
		);
		startFullAutoRun(directory, PARENT_SESSION, { mode: 'supervised' });

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						sessionID: PARENT_SESSION,
						callID: 'call-1',
						type: 'tool',
						tool: 'task',
						state: {
							metadata: {
								sessionId: CHILD_SESSION,
							},
						},
					},
				},
			},
		});

		expect(severeInternals.childBindings.get(CHILD_SESSION)).toMatchObject({
			childSessionID: CHILD_SESSION,
			parentSessionID: PARENT_SESSION,
			parentCallID: 'call-1',
			generation: 1,
		});

		await plugin.event?.({
			event: {
				type: 'session.error',
				properties: {
					sessionID: CHILD_SESSION,
					error: {
						message: '429 rate_limit_exceeded: too many requests',
					},
				},
			},
		});

		const output = {
			message: {} as { model?: { providerID: string; modelID: string } },
		};
		await plugin['chat.message']?.(
			{ sessionID: CHILD_SESSION, agent: 'coder' } as never,
			output as never,
		);

		expect(output.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	});

	test('fails closed on ambiguous parent lookup when no child metadata binding exists', async () => {
		const plugin = await bootPlugin(directory, () => PARENT_SESSION);
		await dispatchCoderTask(
			plugin,
			'call-1',
			'TASK: 1.1\nACCEPTANCE: first distinct task',
		);
		await dispatchCoderTask(
			plugin,
			'call-2',
			'TASK: 1.2\nACCEPTANCE: second distinct task',
		);

		const output = {
			message: {} as { model?: { providerID: string; modelID: string } },
		};
		await plugin['chat.message']?.(
			{ sessionID: 'child-unbound', agent: 'coder' } as never,
			output as never,
		);

		expect(output.message.model).toBeUndefined();
	});

	test('blocks the request boundary after the configured model chain is exhausted', async () => {
		const plugin = await bootPlugin(directory);
		await dispatchCoderTask(
			plugin,
			'call-exhausted',
			'TASK: 1.2\nACCEPTANCE: fail closed after model exhaustion',
		);
		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						sessionID: PARENT_SESSION,
						callID: 'call-exhausted',
						type: 'tool',
						tool: 'task',
						state: { metadata: { sessionId: CHILD_SESSION } },
					},
				},
			},
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await plugin.event?.({
				event: {
					type: 'session.error',
					properties: {
						sessionID: CHILD_SESSION,
						error: { message: '429 rate_limit_exceeded' },
					},
				},
			});
		}

		await expect(
			plugin['chat.message']?.(
				{ sessionID: CHILD_SESSION, agent: 'coder' } as never,
				{ message: {} } as never,
			),
		).rejects.toThrow('MODEL_FALLBACK_EXHAUSTED');
	});

	test('cleans task-model and severe child state on session deletion', async () => {
		const plugin = await bootPlugin(directory);
		await dispatchCoderTask(
			plugin,
			'call-1',
			'TASK: 1.1\nACCEPTANCE: cleanup on session delete',
		);
		startFullAutoRun(directory, PARENT_SESSION, { mode: 'supervised' });

		await plugin.event?.({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						sessionID: PARENT_SESSION,
						callID: 'call-1',
						type: 'tool',
						tool: 'task',
						state: {
							metadata: {
								sessionId: CHILD_SESSION,
							},
						},
					},
				},
			},
		});

		expect(getTaskModelRoutingStateSnapshot().routes).toHaveLength(1);
		expect(severeInternals.childBindings.size).toBe(1);

		await plugin.event?.({
			event: {
				type: 'session.deleted',
				properties: { sessionID: PARENT_SESSION },
			},
		});

		expect(getTaskModelRoutingStateSnapshot()).toEqual({
			routes: [],
			scopedSelections: [],
		});
		expect(severeInternals.childBindings.size).toBe(0);
	});
});
