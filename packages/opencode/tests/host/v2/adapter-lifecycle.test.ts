/**
 * OpenCode v2 adapter lifecycle tests (issue #3151; 8.x port of the 7.x
 * #3004 review follow-up, part 2).
 *
 * setup fail-closed, cleanup ordering (registrations disposed before the v1
 * dispose teardown), the command execute -> session.prompt bridge, and the
 * permission-bridge presence path. The 7.x twin also asserted the deferred
 * event pump's stop ordering — that pump is deliberately NOT ported to 8.x
 * (delta D4: the 8.x v1 factory exposes no `event` hook; see
 * src/host/v2/setup.ts module header).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '@opencode-swarm/core';
import {
	registerV2SessionHooks,
	registerV2ToolHooks,
} from '../../../src/host/v2/hooks';
import { openCodeSwarmV2Setup } from '../../../src/host/v2/setup';
import type {
	V1HooksSubset,
	V2ToolHookInput,
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

afterEach(() => {
	resetSwarmState();
});

describe('setup fail-closed + cleanup ordering (PRR-011)', () => {
	test('setup throws when the host Context carries no location.directory', async () => {
		const mod = (await import('../../../src/index')) as {
			default?: { setup?: (ctx: unknown) => Promise<unknown> };
		};
		const setup = mod.default?.setup;
		expect(typeof setup).toBe('function');
		const missing = {
			options: {},
			tool: {},
			agent: {},
			command: {},
			session: {},
			event: {},
		};
		await expect(setup?.(missing)).rejects.toThrow(/location\.directory/);
	});

	test('cleanup disposes registrations in order, v1 dispose last', async () => {
		const order: string[] = [];
		const directory = canonicalMkdtemp('swarm-v2-cleanup-');
		const registration = {
			dispose: async () => {
				order.push('dispose');
			},
		};
		const ctx = {
			app: { name: 'opencode', version: 'test', channel: 'test' },
			location: {
				directory,
				workspaceID: 'w',
				project: { id: 'p', directory, canonical: directory },
			},
			options: {},
			tool: {
				transform: async () => {
					order.push('transform');
					return registration;
				},
				reload: async () => {},
				list: async () => [],
				hook: async () => registration,
			},
			agent: { transform: async () => registration, reload: async () => {} },
			command: { transform: async () => registration, reload: async () => {} },
			session: { hook: async () => registration },
			// delta D4: stub only — 8.x setup never subscribes.
			event: {},
			permission: {},
		} as never;
		const deps = {
			runInit: async () =>
				makeHooks({
					dispose: async () => {
						order.push('v1-dispose');
					},
				}),
		};
		const cleanup = await openCodeSwarmV2Setup(ctx, deps as never);
		expect(typeof cleanup).toBe('function');
		await cleanup();
		// Disposal happens; v1 dispose runs last (the 7.x pump-stop preceding
		// the first dispose is gone with the pump itself — delta D4).
		expect(order).toContain('dispose');
		expect(order[order.length - 1]).toBe('v1-dispose');
	});
});

describe('command execute -> session.prompt bridge (PRR-011)', () => {
	test('a registered command execute submits the expanded template via ctx.session.prompt', async () => {
		const { registerV2AgentsAndCommands } = await import(
			'../../../src/host/v2/agents-commands'
		);
		const prompts: Array<{ sessionID: string; input: unknown }> = [];
		const added: Array<{
			name: string;
			execute: (inv: {
				sessionID: string;
				prompt: { text: string };
			}) => Promise<void>;
		}> = [];
		const directory = canonicalMkdtemp('swarm-v2-cmdbridge-');
		const registrations: Array<{ dispose: () => Promise<void> }> = [];
		await registerV2AgentsAndCommands(
			{
				agent: {
					transform: async () => ({ dispose: async () => {} }),
					reload: async () => {},
				},
				command: {
					transform: async (
						cb: (e: {
							add(d: {
								name: string;
								execute: (inv: {
									sessionID: string;
									prompt: { text: string };
								}) => Promise<void>;
							}): void;
						}) => void,
					) => {
						cb({
							add(d) {
								added.push(d);
							},
						});
						return { dispose: async () => {} };
					},
					reload: async () => {},
				},
				session: {
					hook: async () => ({ dispose: async () => {} }),
					prompt: async (sessionID: string, input: unknown) => {
						prompts.push({ sessionID, input });
					},
				},
			} as never,
			makeHooks({
				config: async (cfg: Record<string, unknown>) => {
					cfg.command = {
						'swarm-status': {
							template: '/swarm status $ARGUMENTS',
							description: 'status shortcut',
						},
					};
				},
			}),
			directory,
			registrations,
		);
		const cmd = added.find((c) => c.name === 'swarm-status');
		expect(cmd).toBeDefined();
		await cmd?.execute({
			sessionID: 's-cmd',
			prompt: { text: 'now show lanes' },
		});
		expect(prompts.length).toBe(1);
		expect(prompts[0].sessionID).toBe('s-cmd');
		expect(prompts[0].input).toEqual({ text: '/swarm status now show lanes' });
	});
});

describe('permission-bridge presence path (PRR-011)', () => {
	test('ask() routes through ctx.permission.reply when the surface exists', async () => {
		const { _internals } = await import('../../../src/host/v2/tools');
		const replied: unknown[] = [];
		const v2ctx = {
			sessionID: 's',
			agent: 'architect',
			messageID: 'm',
			id: 'c',
			signal: new AbortController().signal,
			progress: async () => {},
		};
		const bridge = async (input: unknown) => {
			replied.push(input);
		};
		const projectRoot = canonicalMkdtemp('swarm-v2-askroot-');
		const v1 = _internals.synthesizeV1ToolContext(v2ctx, projectRoot, bridge);
		const ask = {
			permission: 'bash',
			patterns: ['rm -rf /'],
			always: [],
			metadata: {},
		};
		await v1.ask(ask);
		expect(replied).toEqual([ask]);
	});
});
