/**
 * #3352 (PR #3327 follow-up) — v2 register* functions must not drop sibling
 * registrations on the first host rejection.
 *
 * DEFECT (base 8e5cfd387): every register* function awaits its host calls
 * SEQUENTIALLY, so the first rejection skips every remaining sibling in the
 * same function, and the failure reaches the operator only through the
 * debug-gated log() — never the deferred-warning buffer:
 *   - src/host/v2/hooks.ts registerV2ToolHooks:     'execute.before' -> 'execute.after'
 *   - src/host/v2/hooks.ts registerV2SessionHooks:  'compaction' -> 'prompt'
 *   - src/host/v2/agents-commands.ts registerV2AgentsAndCommands:
 *       ctx.agent.transform -> ctx.command.transform
 *
 * CONTRACT this file pins on the implementer:
 *  1. A rejecting host call inside one register* function must NOT prevent the
 *     remaining sibling registrations in THAT function from being attempted.
 *  2. The failed registration must be surfaced through addDeferredWarning
 *     (the operator-reachable channel; log() is OPENCODE_SWARM_DEBUG-gated),
 *     with a warning naming the failed hook/domain.
 * Whether the register* function itself then resolves or rejects is NOT pinned
 * (the setup-level runRegistration wrapper isolates either shape) — the
 * observable contract is sibling-attempted + warning-surfaced.
 *
 * Coordinate note: issue #3318 AC1 covers the agent->command decoupling from
 * its own angle; #3352 requires this file to exist and additionally covers the
 * compaction/prompt pair. No mock.module; plain-object fakes only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import {
	registerV2SessionHooks,
	registerV2ToolHooks,
} from '../../../../src/host/v2/hooks';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

let dir: string;
const registrations: Array<{ dispose: () => Promise<void> }> = [];

beforeEach(() => {
	clearDeferredWarnings();
	dir = canonicalMkdtemp('v2-register-atomicity-3352-');
});

afterEach(() => {
	clearDeferredWarnings();
});

const minimalHooks = {} as unknown as V1HooksSubset;

describe('#3352 register* atomicity: sibling isolation', () => {
	test('tool-hooks-independent: execute.before rejection still attempts execute.after and warns (base skips after -> red)', async () => {
		const hookCalls: string[] = [];
		const ctx = {
			tool: {
				hook: async (name: string) => {
					hookCalls.push(name);
					if (name === 'execute.before') {
						throw new Error('host refused execute.before registration');
					}
					return { dispose: async () => {} };
				},
			},
		} as never;

		await registerV2ToolHooks(ctx, minimalHooks, dir, registrations).catch(
			() => {
				// Resolved-vs-rejected shape is not pinned (see header); only
				// the sibling attempt + warning are the contract.
			},
		);

		expect(hookCalls).toContain('execute.after');
		const warning = getDeferredWarnings().find((w) =>
			w.includes('execute.before'),
		);
		expect(warning).toBeDefined();
	});

	test('agents-commands-independent: agent transform rejection still registers commands and warns (base skips commands -> red)', async () => {
		const transformCalls: string[] = [];
		const addedCommands: string[] = [];
		const ctx = {
			agent: {
				transform: async () => {
					transformCalls.push('agent');
					throw new Error('agent transform rejected by host');
				},
				reload: async () => {},
			},
			command: {
				transform: async (
					fn: (editor: { add: (d: { name: string }) => void }) => void,
				) => {
					transformCalls.push('command');
					fn({
						add: (d) => {
							addedCommands.push(d.name);
						},
					});
					return { dispose: async () => {} };
				},
				reload: async () => {},
			},
			session: { hook: async () => ({ dispose: async () => {} }) },
		} as never;
		const hooks = {
			config: async (c: Record<string, unknown>) => {
				c.agent = { architect: { mode: 'primary', prompt: 'sys' } };
				c.command = {
					'swarm-status': {
						template: '/swarm status $ARGUMENTS',
						description: 'status shortcut',
					},
				};
			},
		} as unknown as V1HooksSubset;

		await registerV2AgentsAndCommands(ctx, hooks, dir, registrations).catch(
			() => {},
		);

		expect(transformCalls).toContain('command');
		expect(addedCommands).toEqual(['swarm-status']);
		const warning = getDeferredWarnings().find((w) => /agent/i.test(w));
		expect(warning).toBeDefined();
	});

	test('agents-commands-independent: compaction hook rejection still attempts the prompt hook and warns (base skips prompt -> red)', async () => {
		// The compaction/prompt pair inside registerV2SessionHooks has the same
		// sequential-await shape (hooks.ts): a rejecting 'compaction'
		// registration must not drop the 'prompt' hook registration.
		const hookCalls: string[] = [];
		const ctx = {
			session: {
				hook: async (name: string) => {
					hookCalls.push(name);
					if (name === 'compaction') {
						throw new Error('compaction registration rejected by host');
					}
					return { dispose: async () => {} };
				},
			},
		} as never;

		await registerV2SessionHooks(ctx, minimalHooks, dir, registrations).catch(
			() => {},
		);

		expect(hookCalls).toContain('prompt');
		const warning = getDeferredWarnings().find((w) => w.includes('compaction'));
		expect(warning).toBeDefined();
	});

	test('all-sibling-success control: no deferred warning when every host call resolves (green both ends)', async () => {
		const hookCalls: string[] = [];
		const ctx = {
			tool: {
				hook: async (name: string) => {
					hookCalls.push(name);
					return { dispose: async () => {} };
				},
			},
		} as never;

		await registerV2ToolHooks(ctx, minimalHooks, dir, registrations);

		expect(hookCalls).toEqual(['execute.before', 'execute.after']);
		expect(getDeferredWarnings().filter((w) => /execute\./.test(w))).toEqual(
			[],
		);
	});
});
