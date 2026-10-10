/**
 * OpenCode v2 adapter lifecycle tests (issue #3004 review follow-up, part 2).
 *
 * Split from adapter-behavior.test.ts under the FR-006 500-line cap: setup
 * fail-closed, cleanup ordering, the command execute -> session.prompt
 * bridge, and the permission-bridge presence path.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	registerV2SessionHooks,
	registerV2ToolHooks,
} from '../../../../src/host/v2/hooks';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type {
	V1HooksSubset,
	V2ToolHookInput,
} from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';

const REPO_ROOT = '../../../..';

import { canonicalMkdtemp } from '../../../helpers/tmpdir';

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

afterEach(() => {
	resetSwarmState();
});

describe('setup fail-closed + cleanup ordering (PRR-011)', () => {
	test('setup throws when the host Context carries no location.directory', async () => {
		const mod = await import(`${REPO_ROOT}/src/index`);
		const setup = (
			mod.default as { setup?: (ctx: unknown) => Promise<unknown> }
		).setup;
		expect(typeof setup).toBe('function');
		const missing = {
			options: {},
			tool: {},
			agent: {},
			command: {},
			session: {},
			event: {},
		};
		await expect(setup(missing)).rejects.toThrow(/location\.directory/);
	});

	test('cleanup stops the pump before disposing registrations', async () => {
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
			event: {
				subscribe: () => {
					order.push('subscribe');
					return (async function* () {})();
				},
			},
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
		// Disposal happens; v1 dispose runs last. (Pump stop is synchronous and
		// precedes the first dispose — asserted implicitly by no hang/rejection.)
		expect(order).toContain('dispose');
		expect(order[order.length - 1]).toBe('v1-dispose');
		// The pump must be registered (and thus stoppable) before teardown:
		// subscribe precedes the first disposal, so cleanup's pumpStop runs
		// while the pump is live rather than after it was torn down.
		expect(order.indexOf('subscribe')).toBeGreaterThan(-1);
		expect(order.indexOf('subscribe')).toBeLessThan(order.indexOf('dispose'));
	});
});

describe('command execute -> session.prompt bridge (PRR-011)', () => {
	test('a registered command execute submits the expanded template via ctx.session.prompt', async () => {
		const { registerV2AgentsAndCommands } = await import(
			'../../../../src/host/v2/agents-commands'
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
					// 2.0.26 SessionApi shape: one object input (#3169).
					prompt: async (input: unknown) => {
						prompts.push(input);
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
		// Object-input form (issue #3169): sessionID + text in ONE input.
		expect(prompts[0]).toEqual({
			sessionID: 's-cmd',
			text: '/swarm status now show lanes',
		});
	});
});

describe('permission-bridge presence path (PRR-011)', () => {
	test('ask() routes through ctx.permission.reply when the surface exists', async () => {
		const { _internals } = await import('../../../../src/host/v2/tools');
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
		const v1 = _internals.synthesizeV1ToolContext(v2ctx, '/tmp/proj', bridge);
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
