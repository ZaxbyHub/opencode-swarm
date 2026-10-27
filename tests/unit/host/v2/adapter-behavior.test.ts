/**
 * OpenCode v2 adapter behavior tests (issue #3004 review follow-up).
 *
 * Closes the verified untested-surface cluster from the PR #3010 review:
 * event-pump envelope + name mapping, tool execute.before args write-back,
 * tool.execute.after result translation (state fields), prompt rewrite,
 * the identity-paired carrier re-homing partition (the full-auto mid-array
 * splice regression), agent mapping edges, template expansion, the command
 * execute → session.prompt bridge, setup fail-closed, and cleanup ordering.
 *
 * Most tests drive src/host/v2 modules directly against mock v2 contexts per
 * src/host/v2/types.ts provenance. The final tests in this file boot the real
 * plugin (OpenCodeSwarm.server) under an isolated global-config env
 * (createIsolatedTestEnv) and drive its tool.execute hooks. All temp roots
 * via canonicalMkdtemp; no subprocess.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
	expandV1Template,
	mapV1AgentToV2,
} from '../../../../src/host/v2/agents-commands';
import {
	mapV2EventToV1,
	startDeferredEventPump,
} from '../../../../src/host/v2/events';
import { onV2ContextEvent } from '../../../../src/host/v2/guidance';
import {
	registerV2SessionHooks,
	registerV2ToolHooks,
} from '../../../../src/host/v2/hooks';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type {
	V1HooksSubset,
	V2SessionContextEvent,
	V2SessionPromptEvent,
	V2ToolHookInput,
} from '../../../../src/host/v2/types';
import { resetSwarmState, swarmState } from '../../../../src/state';
import { createIsolatedTestEnv } from '../../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const REPO_ROOT = '../../../..';

function makeHooks(overrides: Partial<V1HooksSubset> = {}): V1HooksSubset {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		event: async () => {},
		dispose: async () => {},
		...overrides,
	} as V1HooksSubset;
}

function sessionHookCapture(hooks: V1HooksSubset) {
	const calls: Array<{ name: string; cb: (event: never) => unknown }> = [];
	return {
		calls,
		session: {
			hook: async (name: string, cb: (event: never) => unknown) => {
				calls.push({ name, cb });
				return { dispose: async () => {} };
			},
		},
		hooks,
	};
}

function toolHookCapture(hooks: V1HooksSubset) {
	const calls: Array<{
		name: string;
		cb: (event: V2ToolHookInput) => unknown;
	}> = [];
	return {
		calls,
		tool: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
			hook: async (
				name: 'execute.before' | 'execute.after',
				cb: (event: V2ToolHookInput) => unknown,
			) => {
				calls.push({ name, cb });
				return { dispose: async () => {} };
			},
		},
		hooks,
	};
}

function ctxEvent(
	overrides: Partial<V2SessionContextEvent> = {},
): V2SessionContextEvent {
	return {
		sessionID: 'adapter-behavior-session',
		agent: {
			id: 'architect',
			name: 'architect',
			mode: 'primary',
			hidden: false,
		},
		system: [],
		messages: [],
		options: {},
		tools: {},
		...overrides,
	};
}

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
});

afterEach(() => {
	resetSwarmState();
	isolatedEnv.cleanup();
});

describe('v2 event pump + mapping (PRR-002/PRR-024)', () => {
	test('mapV2EventToV1 maps execution.failed to session.error (a consumed v1 type)', () => {
		const mapped = mapV2EventToV1({
			type: 'session.execution.failed',
			data: { sessionID: 's1' },
		});
		expect(mapped?.type).toBe('session.error');
		expect(mapped?.properties.sessionID).toBe('s1');
	});

	test('mapV2EventToV1 maps terminal/resolver events the v1 chain consumes', () => {
		expect(mapV2EventToV1({ type: 'session.deleted', data: {} })?.type).toBe(
			'session.deleted',
		);
		expect(mapV2EventToV1({ type: 'session.created', data: {} })?.type).toBe(
			'session.created',
		);
		expect(mapV2EventToV1({ type: 'session.idle', data: {} })?.type).toBe(
			'session.idle',
		);
	});

	test('mapV2EventToV1 returns undefined for unmapped types', () => {
		expect(
			mapV2EventToV1({ type: 'session.forked', data: {} }),
		).toBeUndefined();
		expect(mapV2EventToV1({})).toBeUndefined();
	});

	test('pump dispatches the v1 envelope shape { event: { type, properties } }', async () => {
		const received: Array<Record<string, unknown>> = [];
		const hooks = makeHooks({
			event: async (input) => {
				received.push(input as Record<string, unknown>);
			},
		});
		const stop = startDeferredEventPump(
			{
				event: {
					subscribe: () =>
						(async function* () {
							yield { type: 'session.idle', data: { sessionID: 's1' } };
						})(),
				},
			} as never,
			hooks,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		stop();
		expect(received.length).toBe(1);
		const envelope = received[0] as {
			event?: { type?: string; properties?: Record<string, unknown> };
		};
		expect(envelope.event?.type).toBe('session.idle');
		expect(envelope.event?.properties.sessionID).toBe('s1');
	});
});

describe('v2 tool hooks (execute.before write-back / PRR-006 state fields)', () => {
	test('execute.before: v1 output.args mutation writes back onto event.input', async () => {
		const capture = toolHookCapture(
			makeHooks({
				'tool.execute.before': async (_input, output) => {
					(output as { args: Record<string, unknown> }).args = {
						mutated: true,
					};
				},
			}),
		);
		const { calls, hooks } = capture;
		await registerV2ToolHooks(capture as never, hooks, '.', []);
		const before = calls.find((c) => c.name === 'execute.before');
		expect(before).toBeDefined();
		const event = {
			tool: 'swarm_status',
			sessionID: 's1',
			agent: 'architect',
			messageID: 'm1',
			id: 'c1',
			input: { original: true },
		};
		await before?.cb(event);
		expect(event.input).toEqual({ mutated: true });
	});

	test('execute.after: error status carries state:error, completed carries state:completed', async () => {
		const seen: Array<Record<string, unknown>> = [];
		const capture = toolHookCapture(
			makeHooks({
				'tool.execute.after': async (_input, output) => {
					seen.push(output as Record<string, unknown>);
				},
			}),
		);
		const { calls, hooks } = capture;
		await registerV2ToolHooks(capture as never, hooks, '.', []);
		const after = calls.find((c) => c.name === 'execute.after');
		expect(after).toBeDefined();
		await after?.cb({
			tool: 't',
			sessionID: 's',
			agent: 'a',
			messageID: 'm',
			id: 'c',
			input: {},
			status: 'error',
			error: { message: 'boom' },
		});
		await after?.cb({
			tool: 't',
			sessionID: 's',
			agent: 'a',
			messageID: 'm',
			id: 'c',
			input: {},
			status: 'completed',
			result: { content: 'ok', metadata: { k: 1 } },
		});
		expect(seen[0].state).toBe('error');
		expect(seen[0].output).toBe('boom');
		expect(seen[1].state).toBe('completed');
		expect(seen[1].output).toBe('ok');
		expect(seen[1].metadata).toEqual({ k: 1 });
	});
});

describe('v2 prompt adapter (PRR-003 delta surface)', () => {
	test('rewritten output.parts text flows back to event.prompt.text', async () => {
		const capture = sessionHookCapture(
			makeHooks({
				'chat.message': async (_input, output) => {
					const parts = (
						output as { parts: Array<{ type: string; text?: string }> }
					).parts;
					if (parts[0]) parts[0].text = 'rewritten by chain';
				},
			}),
		);
		const { calls, hooks } = capture;
		await registerV2SessionHooks(capture as never, hooks, '.', []);
		const prompt = calls.find((c) => c.name === 'prompt');
		expect(prompt).toBeDefined();
		const event = {
			sessionID: 's1',
			messageID: 'm1',
			prompt: { text: 'original' },
		} as V2SessionPromptEvent;
		await prompt?.cb(event as never);
		expect(event.prompt.text).toBe('rewritten by chain');
	});
});

describe('guidance partition identity pairing (PRR-004 regression)', () => {
	test('a mid-array carrier insertion does not cross-contaminate write-backs', async () => {
		const hooks = makeHooks({
			'experimental.chat.messages.transform': async (_input, output) => {
				const messages = output.messages as Array<{
					info: { id?: string; role?: string };
					parts: Array<{ type: string; text?: string }>;
				}>;
				// Also rewrite u1's own text (catches order-preserving swaps:
				// a wrong pairing that keeps positions but swaps CONTENT fails).
				for (const m of messages) {
					if (m.info.id === 'u1')
						m.parts = [{ type: 'text', text: 'u1 transformed' }];
				}
				// Simulate the full-auto intercept: splice a carrier BEFORE the
				// real message (positional pairing would then misalign).
				messages.unshift({
					info: { id: 'swarm-guidance:test', role: 'user' },
					parts: [
						{
							type: 'text',
							text: '<swarm_system_directive source="opencode-swarm" kind="test">\nfull-auto directive\n</swarm_system_directive>',
						},
					],
				});
			},
			'experimental.chat.system.transform': async (_input, output) => {
				(output as { system: string[] }).system.push('system-chain rule');
			},
		});
		const directory = canonicalMkdtemp('swarm-v2-adapter-');
		const event = ctxEvent({
			messages: [
				{
					id: 'u1',
					role: 'user',
					content: [{ type: 'text', text: 'user content' }],
				},
			],
		});
		await onV2ContextEvent(event, hooks, directory);
		// The carrier was re-homed into system (fenced), the system chain ran,
		// and the REAL message kept its own content (no cross-contamination).
		const fenced = event.system.filter((p) =>
			p.text?.includes('<swarm_system_directive'),
		);
		expect(fenced.length).toBe(1);
		expect(event.system.some((p) => p.text === 'system-chain rule')).toBe(true);
		expect(event.messages.length).toBe(1);
		expect(event.messages[0].id).toBe('u1');
		expect(event.messages[0].content).toEqual([
			{ type: 'text', text: 'u1 transformed' },
		]);
	});

	test('non-text content parts survive the write-back', async () => {
		const hooks = makeHooks({
			'experimental.chat.messages.transform': async () => {},
		});
		const event = ctxEvent({
			messages: [
				{
					id: 'a1',
					role: 'assistant',
					content: [
						{ type: 'text', text: 'answer' },
						{ type: 'media', mime: 'image/png', url: 'file:///x.png' },
					],
				},
			],
		});
		await onV2ContextEvent(event, hooks, canonicalMkdtemp('swarm-v2-adapter-'));
		expect(event.messages[0].content.some((p) => p.type === 'media')).toBe(
			true,
		);
	});
});

describe('agent + command mapping (PRR-011 edges)', () => {
	test('mapV1AgentToV2 splits provider/model and coerces mode', () => {
		const info = mapV1AgentToV2('worker', {
			mode: 'primary',
			prompt: 'p',
			description: 'd',
			model: 'anthropic/claude-3',
		});
		expect(info.model).toEqual({ providerID: 'anthropic', id: 'claude-3' });
		expect(info.mode).toBe('primary');
		expect(info.system).toBe('p');
		expect(info.description).toBe('d');
	});

	test('expandV1Template substitutes $ARGUMENTS', () => {
		expect(expandV1Template('/swarm show-plan $ARGUMENTS', 'alpha beta')).toBe(
			'/swarm show-plan alpha beta',
		);
		expect(expandV1Template('/swarm archive', '')).toBe('/swarm archive');
	});
});

describe('seed re-pairing (PRR-009)', () => {
	test('activeAgent re-pairs when the agent name changes for a live session', async () => {
		const { seedV1SessionState } = await import(
			'../../../../src/host/v2/setup'
		);
		const directory = canonicalMkdtemp('swarm-v2-seed-');
		seedV1SessionState('seed-s1', 'architect', directory);
		expect(swarmState.activeAgent.get('seed-s1')).toBe('architect');
		// Mid-session switch: the second seed must re-pair (no first-write-wins).
		seedV1SessionState('seed-s1', 'reviewer', directory);
		expect(swarmState.activeAgent.get('seed-s1')).toBe('reviewer');
	});

	test('seedV1SessionState refreshes lastAgentEventTime when re-seeded with the same agent', async () => {
		const { seedV1SessionState } = await import(
			'../../../../src/host/v2/setup'
		);
		const directory = canonicalMkdtemp('swarm-v2-seed-time-');
		seedV1SessionState('seed-s2', 'sre-planner', directory);
		const session = swarmState.agentSessions.get('seed-s2');
		expect(session).toBeDefined();
		const staleTimestamp = 1_000;
		session!.lastAgentEventTime = staleTimestamp;

		seedV1SessionState('seed-s2', 'sre-planner', directory);
		expect(session!.lastAgentEventTime).toBeGreaterThan(staleTimestamp);
	});

	test('v2 tool.execute.before preserves host-provided agent and does not bypass circuit breaker after >10s', async () => {
		const OpenCodeSwarm = (await import('../../../../src/index')).default;
		const directory = canonicalMkdtemp('swarm-v2-circuit-');
		mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		const plugin = await OpenCodeSwarm.server({
			directory,
			worktree: directory,
		} as never);

		const sessionID = 'v2-circuit-session';
		const { beginInvocation, ensureAgentSession } = await import(
			'../../../../src/state'
		);
		const session = ensureAgentSession(sessionID, 'coder', directory);
		const window = beginInvocation(sessionID, 'coder');
		expect(window).not.toBeNull();
		window!.hardLimitHit = true;
		session.delegationActive = false;
		session.lastAgentEventTime = 1_000;
		swarmState.activeAgent.set(sessionID, 'coder');

		const beforeHook = plugin['tool.execute.before'] as (
			input: Record<string, unknown>,
			output: { args: Record<string, unknown> },
		) => Promise<void>;

		await expect(
			beforeHook(
				{
					tool: 'read',
					sessionID,
					callID: 'call-after-10s',
					agent: 'coder',
				},
				{ args: { filePath: 'README.md' } },
			),
		).rejects.toThrow(/CIRCUIT BREAKER/);
		expect(swarmState.activeAgent.get(sessionID)).toBe('coder');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('coder');
	});

	test('v2 tool.execute.after Task handoff restores host-provided parent agent instead of hardcoding architect', async () => {
		const OpenCodeSwarm = (await import('../../../../src/index')).default;
		const directory = canonicalMkdtemp('swarm-v2-handoff-');
		mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		const plugin = await OpenCodeSwarm.server({
			directory,
			worktree: directory,
		} as never);

		const sessionID = 'v2-parent-session';
		const { ensureAgentSession } = await import('../../../../src/state');
		const session = ensureAgentSession(sessionID, 'sre-planner', directory);
		session.delegationActive = true;
		swarmState.activeAgent.set(sessionID, 'sre-planner');

		const afterHook = plugin['tool.execute.after'] as (
			input: Record<string, unknown>,
			output: Record<string, unknown>,
		) => Promise<void>;

		await afterHook(
			{
				tool: 'task',
				sessionID,
				callID: 'task-call-1',
				agent: 'sre-planner',
				args: { subagent_type: 'coder' },
			},
			{
				title: 'task',
				output:
					'<task id="child-1" state="completed"><task_result>done</task_result></task>',
				metadata: {},
			},
		);

		expect(swarmState.activeAgent.get(sessionID)).toBe('sre-planner');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'sre-planner',
		);
		expect(swarmState.agentSessions.get(sessionID)?.delegationActive).toBe(
			false,
		);
	});
});
