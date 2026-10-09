/**
 * OpenCode v2 adapter behavior tests (issue #3151; 8.x port — SUBSET — of the
 * 7.x #3004 suite).
 *
 * Ported legs over the 8.x surface: context hook wiring (messages + system
 * transforms invoked through the translated event), tool transform
 * registration from a hooks.tool map, tool execute.before args write-back,
 * tool.execute.after result translation (state fields), prompt rewrite, agent
 * mapping edges, template expansion, and seed re-pairing.
 *
 * Skipped 7.x legs (recorded plan deltas):
 *   - event pump + mapV2EventToV1 (delta D4: events.ts deliberately not
 *     ported — the 8.x v1 factory exposes no `event` hook).
 *   - #2526 carrier identity-pairing partition (delta D1: the 8.x v1 chain
 *     never materializes swarm-guidance:* carriers — there is no carrier
 *     module; the prefix partition in guidance.ts fails open when no carriers
 *     exist). Interleaved-part ordering is pinned separately by
 *     ordering-regression.test.ts.
 *
 * Drives src/host/v2 modules directly (source-level) against mock v2 contexts
 * per src/host/v2/types.ts provenance. All temp roots via canonicalMkdtemp;
 * no wall-clock, no subprocess.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState, swarmState } from '@opencode-swarm/core';
import {
	expandV1Template,
	mapV1AgentToV2,
} from '../../../src/host/v2/agents-commands';
import { onV2ContextEvent } from '../../../src/host/v2/guidance';
import {
	registerV2SessionHooks,
	registerV2ToolHooks,
} from '../../../src/host/v2/hooks';
import { seedV1SessionState } from '../../../src/host/v2/setup';
import { registerV2Tools } from '../../../src/host/v2/tools';
import type {
	V1HooksSubset,
	V2SessionContextEvent,
	V2SessionPromptEvent,
	V2ToolHookInput,
	V2ToolInfo,
} from '../../../src/host/v2/types';
import { canonicalMkdtemp } from './tmpdir';

function makeHooks(overrides: Partial<V1HooksSubset> = {}): V1HooksSubset {
	return {
		tool: {},
		agent: {},
		config: async () => {},
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

afterEach(() => {
	resetSwarmState();
});

// delta D4: the 7.x "v2 event pump + mapping (PRR-002/PRR-024)" describe block
// is not ported — events.ts / startDeferredEventPump / mapV2EventToV1 were
// deliberately excluded from the 8.x staging (the 8.x v1 factory exposes no
// `event` hook; see src/host/v2/setup.ts module header).

describe('v2 context hook wiring (translated event)', () => {
	test('messages and system transforms both run; system output lands on event.system', async () => {
		let messagesChainRan = false;
		const hooks = makeHooks({
			'experimental.chat.messages.transform': async (_input, output) => {
				messagesChainRan = true;
				const messages = output.messages as Array<{
					info: { id?: string };
					parts: Array<{ type: string; text?: string }>;
				}>;
				for (const m of messages) {
					if (m.info.id === 'u1') m.parts[0].text = 'u1 transformed';
				}
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
		// Observable effect so the wiring assertion is not vacuous.
		expect(messagesChainRan).toBe(true);
		expect(
			event.messages[0].content.some(
				(p) => p.type === 'text' && p.text === 'u1 transformed',
			),
		).toBe(true);
		expect(event.system.some((p) => p.text === 'system-chain rule')).toBe(true);
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

// delta D1: the 7.x "guidance partition identity pairing (PRR-004 regression)"
// carrier leg is not ported — the 8.x v1 chain has no carrier module and never
// materializes swarm-guidance:* ids. Interleaved tool-call/tool-result
// ordering is pinned by ordering-regression.test.ts instead.

describe('v2 tool transform registration from the hooks.tool map', () => {
	test('registerV2Tools adds every map entry with schema + execute bridge', async () => {
		const added: V2ToolInfo[] = [];
		const calls: string[] = [];
		const hooks = makeHooks({
			tool: {
				fake_read: {
					description: 'reads a thing',
					args: {},
					execute: async (input: unknown) => {
						calls.push(`exec:${String((input as { k: string }).k)}`);
						return 'plain-string result';
					},
				},
			},
		});
		const registrations: Array<{ dispose: () => Promise<void> }> = [];
		const directory = canonicalMkdtemp('swarm-v2-tools-');
		await registerV2Tools(
			{
				tool: {
					transform: async (
						cb: (editor: { add(t: V2ToolInfo): void }) => void,
					) => {
						cb({
							add(t: V2ToolInfo) {
								added.push(t);
							},
						});
						return { dispose: async () => {} };
					},
					reload: async () => {},
					hook: async () => ({ dispose: async () => {} }),
				},
				permission: {},
			} as never,
			hooks,
			directory,
			registrations,
		);
		expect(added.map((t) => t.name)).toEqual(['fake_read']);
		expect(added[0].description).toBe('reads a thing');
		// zod v4's z.toJSONSchema attaches $schema/~standard metadata; only the
		// structural type is the adapter's contract.
		expect(added[0].input).toMatchObject({ type: 'object' });
		const result = await added[0].execute(
			{ k: 'v' },
			{
				sessionID: 's-tools',
				agent: 'architect',
				messageID: 'm',
				id: 'c',
				signal: new AbortController().signal,
				progress: async () => {},
			},
		);
		expect(calls).toEqual(['exec:v']);
		expect(result).toEqual({ content: 'plain-string result' });
	});
});

describe('v2 tool hooks (execute.before write-back / state fields)', () => {
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

describe('v2 prompt adapter (delta surface)', () => {
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

describe('agent + command mapping (edges)', () => {
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

	test('mapV1AgentToV2 drops v1 tools:false entries from allow rules (documented delta)', () => {
		const info = mapV1AgentToV2('w', { tools: { shell: false, bash: true } });
		expect(info.permissions?.some((r) => r.resource === 'shell')).toBe(false);
		expect(info.permissions?.some((r) => r.resource === 'bash')).toBe(true);
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
		const directory = canonicalMkdtemp('swarm-v2-seed-');
		seedV1SessionState('seed-s1', 'architect', directory);
		expect(swarmState.activeAgent.get('seed-s1')).toBe('architect');
		// Mid-session switch: the second seed must re-pair (no first-write-wins).
		seedV1SessionState('seed-s1', 'reviewer', directory);
		expect(swarmState.activeAgent.get('seed-s1')).toBe('reviewer');
	});
});
