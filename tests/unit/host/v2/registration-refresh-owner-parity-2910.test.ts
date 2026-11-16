/**
 * #2910 W3 implementation-phase controls — the OWNER-ISOLATION and V1-PARITY
 * legs of the registration-refresh work (split from
 * registration-refresh-trigger-2910.test.ts for the 500-line test-file cap;
 * the trigger predicate + production-path legs live there).
 *
 *  - owner isolation (rebuild source): owner A's detach leaves owner B's
 *    source serving the refresh — one instance's cleanup never removes a
 *    concurrent live instance's entry;
 *  - owner isolation (quiet): a setup instance whose config sets quiet=true
 *    keeps its quiet flag through ANOTHER instance's cleanup;
 *  - CONCURRENT DISPATCH-DRIVEN ROUTING (review PRR-003): two setup-like
 *    instances A then B are BOTH live when A dispatches a policy-permitted
 *    `config doctor --fix` — A's dispatch-driven refresh must resolve A's
 *    rebuild source and A's registration snapshot even though B (the newer
 *    owner) is the module-global current owner;
 *  - v1 parity: buildV2RegistrationTables' agent table equals the REAL
 *    getAgentConfigs output for the same on-disk config (key set + mode +
 *    permission blocks) — the same table the v1 config hook merges.
 *
 * Fakes only (no mock.module); plain-object recording contexts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentConfigs } from '../../../../src/agents';
import { loadPluginConfigWithMetaAsync } from '../../../../src/config/loader';
import { clearSwallowedCommandErrorRegistry } from '../../../../src/hooks/utils';
import {
	deferredV2RefreshRegistrations,
	registerV2ConfigRebuildSourceForOwner,
	resetV2OperatorWarningState,
	setV2OperatorQuietForOwner,
} from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { buildV2RegistrationTables } from '../../../../src/index';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

function writeProjectConfig(dir: string, body: Record<string, unknown>): void {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(body),
	);
}

afterEach(async () => {
	registerV2ConfigRebuildSourceForOwner('iso-a', undefined);
	registerV2ConfigRebuildSourceForOwner('iso-b', undefined);
	setV2OperatorQuietForOwner('iso-a', undefined);
	setV2OperatorQuietForOwner('iso-b', undefined);
	resetV2OperatorWarningState();
	clearSwallowedCommandErrorRegistry();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#2910 W3 owner isolation (rebuild source + quiet)', () => {
	test('owner A detach leaves owner B serving: the refresh resolves through B', async () => {
		const served: string[] = [];
		registerV2ConfigRebuildSourceForOwner('iso-a', async () => {
			served.push('a');
			return { agentTable: {}, commandTable: {} };
		});
		registerV2ConfigRebuildSourceForOwner('iso-b', async () => {
			served.push('b');
			return { agentTable: {}, commandTable: {} };
		});
		// A's cleanup: only A's entry is unregistered.
		registerV2ConfigRebuildSourceForOwner('iso-a', undefined);

		const registration = { dispose: async () => {} };
		const ctx = {
			agent: {
				transform: async (cb: (editor: unknown) => void) => {
					cb({});
					return registration;
				},
				reload: async () => {},
			},
			command: {
				transform: async (cb: (editor: unknown) => void) => {
					cb({});
					return registration;
				},
				reload: async () => {},
			},
			session: { hook: async () => registration, prompt: async () => {} },
		};
		await deferredV2RefreshRegistrations(
			ctx as never,
			{ config: async () => {} } as V1HooksSubset,
			trackedMkdtemp('v2-2910-trig-iso-'),
			[],
		);
		expect(served).toEqual(['b']);
	});

	test('quiet isolation: instance A cleanup does not reset live instance B quiet=true', async () => {
		const dirA = trackedMkdtemp('v2-2910-quiet-a-');
		const dirB = trackedMkdtemp('v2-2910-quiet-b-');
		writeProjectConfig(dirA, { quiet: false });
		writeProjectConfig(dirB, { quiet: true });

		const warnTexts: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			if (args.length > 0 && typeof args[0] === 'string')
				warnTexts.push(args[0]);
		};

		const makeQuietCtx = (
			directory: string,
			commands: RegisteredCommand[],
		): Record<string, unknown> => {
			const registration = { dispose: async () => {} };
			const makeTransform = () => async (fn: (editor: unknown) => void) => {
				fn({});
				return registration;
			};
			return {
				location: { directory },
				agent: { transform: makeTransform(), reload: async () => {} },
				command: {
					transform: async (
						fn: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						fn({
							add(d) {
								commands.push(d);
							},
						});
						return registration;
					},
					reload: async () => {},
				},
				tool: { transform: makeTransform(), hook: async () => registration },
				// Deliberately NO session.prompt: executing a command warns
				// through the operator channel (quiet-gated console.warn).
				session: { hook: async () => registration },
				event: {},
			};
		};

		const commandsA: RegisteredCommand[] = [];
		const commandsB: RegisteredCommand[] = [];
		try {
			// A first (quiet=false): its own warning IS audible.
			const cleanupA = await openCodeSwarmV2Setup(
				makeQuietCtx(dirA, commandsA) as never,
				{
					runInit: async () =>
						({
							config: (c: Record<string, unknown>) => {
								c.agent = {};
								c.command = {
									'swarm-a1': {
										template: '/swarm a1',
										description: 'A probe',
									},
								};
							},
						}) as never,
				},
			);
			await commandsA[0]?.execute({
				sessionID: 'quiet-a',
				prompt: { text: '' },
			});
			expect(warnTexts.some((t) => t.includes('swarm-a1'))).toBe(true);

			// B second (quiet=true, most recent owner): its warning is silent.
			const cleanupB = await openCodeSwarmV2Setup(
				makeQuietCtx(dirB, commandsB) as never,
				{
					runInit: async () =>
						({
							config: (c: Record<string, unknown>) => {
								c.agent = {};
								c.command = {
									'swarm-b1': {
										template: '/swarm b1',
										description: 'B probe 1',
									},
									'swarm-b2': {
										template: '/swarm b2',
										description: 'B probe 2',
									},
								};
							},
						}) as never,
				},
			);
			await commandsB[0]?.execute({
				sessionID: 'quiet-b1',
				prompt: { text: '' },
			});
			expect(warnTexts.some((t) => t.includes('swarm-b1'))).toBe(false);

			// A's cleanup must not reset B's quiet: B's SECOND (distinct)
			// warning stays silent afterwards.
			await cleanupA();
			await commandsB[1]?.execute({
				sessionID: 'quiet-b2',
				prompt: { text: '' },
			});
			expect(warnTexts.some((t) => t.includes('swarm-b2'))).toBe(false);
			await cleanupB();
		} finally {
			console.warn = originalWarn;
		}
	}, 60_000);

	test('PRR-003: dispatch-driven refresh routes through the DISPATCHING instance even after a newer setup registered', async () => {
		// Two setup-like instances (openCodeSwarmV2Setup) whose rebuild
		// sources and registration tables are per-instance
		// distinguishable. A registers FIRST, B SECOND — B is the
		// module-global current owner. A's policy-permitted config-doctor
		// --fix dispatch must use A's rebuild source + A's snapshot
		// (reload fires on A's ctx only).
		interface InstanceState {
			commands: RegisteredCommand[];
			served: number;
			agentReloads: number;
			commandReloads: number;
		}
		const makeInstanceState = (): InstanceState => ({
			commands: [],
			served: 0,
			agentReloads: 0,
			commandReloads: 0,
		});
		const instanceCtx = (dir: string, state: InstanceState) => {
			const registration = { dispose: async () => {} };
			return {
				location: { directory: dir },
				agent: {
					transform: async (fn: (editor: unknown) => void) => {
						fn({
							update: (_id: string, mut: (a: unknown) => void) => mut({}),
							remove: () => {},
							list: () => [],
						});
						return registration;
					},
					reload: async () => {
						state.agentReloads += 1;
					},
				},
				command: {
					transform: async (
						fn: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						fn({
							add(d) {
								state.commands.push(d);
							},
						});
						return registration;
					},
					reload: async () => {
						state.commandReloads += 1;
					},
				},
				tool: {
					transform: async (fn: (editor: unknown) => void) => {
						fn({});
						return registration;
					},
					hook: async () => registration,
				},
				session: {
					hook: async () => registration,
					prompt: async () => {},
				},
				event: {},
			};
		};
		// A's registration table (v1 prompt) vs A's fresh rebuild (v2
		// prompt) — the CHANGED pair that must fire the reload on A's ctx.
		const tableAv1 = {
			coder_prr003: {
				mode: 'subagent',
				prompt: 'A registration (v1).',
				description: 'coder',
			},
		};
		const tableAv2 = {
			coder_prr003: {
				mode: 'subagent',
				prompt: 'A rebuilt (v2 — fix applied through A).',
				description: 'coder',
			},
		};
		const tableBv1 = {
			coder_prr003: {
				mode: 'subagent',
				prompt: 'B registration.',
				description: 'coder',
			},
		};
		// Both instances register the SAME command table; only the agent
		// tables distinguish them, so a rebuild returning the same command
		// table + an unchanged agent table is a genuine no-change refresh.
		const concurrentCommandTable = {
			swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
		};
		const instanceHooks = (agentTable: Record<string, unknown>) =>
			({
				config: (c: Record<string, unknown>) => {
					c.agent = agentTable;
					c.command = concurrentCommandTable;
				},
				// Genuine non-refusal dispatched output (the PRR-005
				// fixed-contract trigger shape).
				'command.execute.before': async (
					_input: unknown,
					output: { parts: unknown[] },
				) => {
					output.parts.splice(0, output.parts.length, {
						type: 'text',
						text: 'Config Doctor: all checks passed.',
					});
				},
			}) as unknown as V1HooksSubset;

		const a = makeInstanceState();
		const b = makeInstanceState();
		const dirA = trackedMkdtemp('v2-2910-parity-conc-a-');
		const dirB = trackedMkdtemp('v2-2910-parity-conc-b-');
		const cleanupA = await openCodeSwarmV2Setup(instanceCtx(dirA, a) as never, {
			runInit: async () => instanceHooks(tableAv1) as never,
			buildV2RegistrationTables: async () => {
				a.served += 1;
				return { agentTable: tableAv2, commandTable: concurrentCommandTable };
			},
		});
		const cleanupB = await openCodeSwarmV2Setup(instanceCtx(dirB, b) as never, {
			runInit: async () => instanceHooks(tableBv1) as never,
			// B's source is deliberately NEVER expected to serve for
			// A's dispatch (it serves B's own below, unchanged).
			buildV2RegistrationTables: async () => {
				b.served += 1;
				return { agentTable: tableBv1, commandTable: concurrentCommandTable };
			},
		});
		try {
			const swarmA = a.commands.find((c) => c.name === 'swarm');
			expect(swarmA).toBeDefined();
			const swarmB = b.commands.find((c) => c.name === 'swarm');
			expect(swarmB).toBeDefined();

			// A dispatches (B registered later — the ambient current owner).
			await swarmA?.execute({
				sessionID: 'prr003-a',
				prompt: { text: 'config doctor --fix' },
			});
			// A's dispatch used A's rebuild source and reloaded A's domains.
			expect(a.served).toBe(1);
			expect(a.agentReloads).toBe(1);
			expect(a.commandReloads).toBe(1);
			// B — the newer owner the module-global chain WOULD have
			// picked (the pre-PRR-003 defect) — was never consulted.
			expect(b.served).toBe(0);
			expect(b.agentReloads).toBe(0);
			expect(b.commandReloads).toBe(0);

			// Symmetry: B's own dispatch resolves B's source and B's
			// UNCHANGED tables (no churn on B either instance).
			await swarmB?.execute({
				sessionID: 'prr003-b',
				prompt: { text: 'config doctor --fix' },
			});
			expect(b.served).toBe(1);
			expect(b.agentReloads).toBe(0);
			expect(a.served).toBe(1);
		} finally {
			await cleanupA();
			await cleanupB();
		}
	}, 60_000);
});

describe('#2910 W3 v1 parity of the fresh builder', () => {
	test('buildV2RegistrationTables agent table == REAL getAgentConfigs output (key set + mode + permission blocks)', async () => {
		const dir = trackedMkdtemp('v2-2910-parity-');
		writeProjectConfig(dir, {
			memory: { enabled: false },
			tool_filter: { enabled: true },
		});
		const { agentTable } = await buildV2RegistrationTables(dir);
		const loaded = await loadPluginConfigWithMetaAsync(dir);
		// The v1 config hook's agent table IS the getAgentConfigs output
		// (Object.assign verbatim); parity is pinned on key set + mode +
		// permission blocks (auto-review resolution affects prompts, not
		// these fields).
		const expected = getAgentConfigs(loaded.config, dir) as Record<
			string,
			{ mode?: string; permission?: Record<string, unknown> }
		>;
		expect(Object.keys(agentTable).sort()).toEqual(
			Object.keys(expected).sort(),
		);
		for (const [name, entry] of Object.entries(expected)) {
			const fromBuilder = agentTable[name] as {
				mode?: string;
				permission?: Record<string, unknown>;
			};
			expect(
				fromBuilder,
				`agent ${name} present in builder output`,
			).toBeDefined();
			expect(fromBuilder.mode).toBe(entry.mode);
			expect(fromBuilder.permission).toEqual(entry.permission);
		}
	}, 60_000);
});
