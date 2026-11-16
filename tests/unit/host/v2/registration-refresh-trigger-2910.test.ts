/**
 * #2910 W3 implementation-phase controls for the config-doctor --fix
 * registration-refresh TRIGGER (the frozen C5
 * registration-reload-2910.test.ts pins the refresh SEAMS; this suite pins
 * the trigger predicate and the production-path leg).
 *
 * POST-PRR-005 contract (swarm-pr-review pr3444-20261025): the trigger
 * fires ONLY on a policy-PERMITTED dispatch — canonicalized `config doctor`
 * + `--fix`/`-f`, non-empty dispatched parts that are NOT the v1
 * tool-policy refusal (both refusal arms, src/commands/tool-policy.ts:
 * swarm_command gate + chat-fallback gate), and no swallowed handler error
 * recorded since the dispatch began.
 *
 *  - generic-route trigger: a dispatch through registry key `swarm` whose
 *    arguments canonicalize to `config doctor --fix` and whose handler
 *    output is a genuine non-refusal fires the refresh
 *    (swarm-command-routing.test.ts:303-306 shows the real generic shape);
 *  - shortcut trigger: the `swarm-config-doctor` registry shortcut fires too;
 *  - read-only commands (`swarm status`, `swarm config`) NEVER trigger;
 *  - POLICY REFUSALS never trigger: the REAL refusal text both v1 policy
 *    gates emit for in-dispatcher `config doctor --fix` (submitted as-is,
 *    no reloads, no rebuild-source consult) — this is the shape a real v2
 *    host dispatch produces today, which is why the in-process trigger is a
 *    policy-permitted-dispatch hook (CLI-path fixes apply on host restart);
 *  - a safeHook-swallowed handler failure (empty parts + registry record)
 *    never triggers;
 *  - PRODUCTION PATH: a real on-disk config, the REAL
 *    buildV2RegistrationTables (imported from src/index.ts) as the rebuild
 *    source, and a memory.enabled flip between rebuilds — the second
 *    permitted config-doctor --fix dispatch observes changed tables and
 *    reloads BOTH domains.
 *
 * Sibling suites: registration-refresh-owner-parity-2910.test.ts (owner
 * isolation + v1 parity of the fresh builder),
 * registration-owner-release-2910.test.ts (snapshot release + rejected
 * setup).
 *
 * Fakes only (no mock.module); plain-object recording contexts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	clearSwallowedCommandErrorRegistry,
	safeHook,
} from '../../../../src/hooks/utils';
import {
	registerV2AgentsAndCommands,
	registerV2ConfigRebuildSource,
	resetV2OperatorWarningState,
} from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { buildV2RegistrationTables } from '../../../../src/index';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

interface TriggerCtx {
	ctx: unknown;
	commands: RegisteredCommand[];
	prompts: Array<{ sessionID?: string; text?: string }>;
	agentReloads: number;
	commandReloads: number;
}

function makeTriggerCtx(): TriggerCtx {
	const commands: RegisteredCommand[] = [];
	const prompts: Array<{ sessionID?: string; text?: string }> = [];
	const counters = { agentReloads: 0, commandReloads: 0 };
	const registration = { dispose: async () => {} };
	const ctx = {
		agent: {
			transform: async (cb: (editor: unknown) => void) => {
				cb({
					update: (_id: string, fn: (agent: unknown) => void) => {
						fn({});
					},
					remove: () => {},
					list: () => [],
				});
				return registration;
			},
			reload: async () => {
				counters.agentReloads += 1;
			},
		},
		command: {
			transform: async (
				cb: (e: { add(d: RegisteredCommand): void }) => void,
			) => {
				cb({
					add(d) {
						commands.push(d);
					},
				});
				return registration;
			},
			reload: async () => {
				counters.commandReloads += 1;
			},
		},
		session: {
			hook: async () => registration,
			prompt: async (input: unknown) => {
				prompts.push(input as { sessionID?: string; text?: string });
			},
		},
	};
	return {
		ctx,
		commands,
		prompts,
		get agentReloads() {
			return counters.agentReloads;
		},
		get commandReloads() {
			return counters.commandReloads;
		},
	};
}

const OK_DOCTOR_PARTS = async (
	_input: unknown,
	output: { parts: unknown[] },
): Promise<void> => {
	output.parts.splice(0, output.parts.length, {
		type: 'text',
		text: 'Config Doctor: all checks passed.',
	});
};

const DOCTOR_TABLE = {
	swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
	'swarm-config-doctor': {
		template: '/swarm config doctor',
		description: 'config doctor shortcut',
	},
};

const tableA = {
	coder_2910: {
		mode: 'subagent',
		prompt: 'You write code (v1).',
		description: 'coder',
		permission: { write: 'allow', edit: 'allow' },
	},
};
const tableB = {
	coder_2910: {
		mode: 'subagent',
		prompt: 'You write code (v2 — config written by a command).',
		description: 'coder',
		permission: { write: 'deny', edit: 'deny' },
	},
};

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	registerV2ConfigRebuildSource(undefined);
	resetV2OperatorWarningState();
	clearSwallowedCommandErrorRegistry();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#2910 W3 config-doctor --fix refresh trigger', () => {
	test('generic route: /swarm config doctor --fix through key `swarm` fires the refresh', async () => {
		const h = makeTriggerCtx();
		let current = tableA;
		registerV2ConfigRebuildSource(async () => ({
			agentTable: current,
			commandTable: DOCTOR_TABLE,
		}));
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = DOCTOR_TABLE;
			},
			'command.execute.before': OK_DOCTOR_PARTS,
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-generic-'),
			[],
		);
		const generic = h.commands.find((c) => c.name === 'swarm');
		expect(generic).toBeDefined();
		expect(h.agentReloads).toBe(0);

		current = tableB;
		await generic?.execute({
			sessionID: 'trig-generic',
			prompt: { text: 'config doctor --fix' },
		});

		expect(h.agentReloads).toBe(1);
		expect(h.commandReloads).toBe(1);
		// The dispatched handler output was still delivered.
		expect(h.prompts.length).toBe(1);
		expect(h.prompts[0]?.text).toBe('Config Doctor: all checks passed.');
	});

	test('shortcut route: the swarm-config-doctor registry key with --fix fires the refresh', async () => {
		const h = makeTriggerCtx();
		let current = tableA;
		registerV2ConfigRebuildSource(async () => ({
			agentTable: current,
			commandTable: {},
		}));
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = DOCTOR_TABLE;
			},
			'command.execute.before': OK_DOCTOR_PARTS,
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-shortcut-'),
			[],
		);
		const doctor = h.commands.find((c) => c.name === 'swarm-config-doctor');
		expect(doctor).toBeDefined();

		current = tableB;
		await doctor?.execute({
			sessionID: 'trig-shortcut',
			prompt: { text: '--fix' },
		});

		expect(h.agentReloads).toBe(1);
		expect(h.commandReloads).toBe(1);
	});

	test('read-only commands never trigger: swarm status and swarm config dispatch without reloads', async () => {
		const h = makeTriggerCtx();
		let served = 0;
		registerV2ConfigRebuildSource(async () => {
			served += 1;
			return { agentTable: tableB, commandTable: {} };
		});
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = {
					swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
				};
			},
			'command.execute.before': async (
				_input: unknown,
				output: { parts: unknown[] },
			) => {
				output.parts.splice(0, output.parts.length, {
					type: 'text',
					text: 'REAL OUTPUT (read-only)',
				});
			},
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-readonly-'),
			[],
		);
		const generic = h.commands.find((c) => c.name === 'swarm');
		expect(generic).toBeDefined();

		await generic?.execute({
			sessionID: 'trig-readonly',
			prompt: { text: 'status' },
		});
		await generic?.execute({
			sessionID: 'trig-readonly',
			prompt: { text: 'config' },
		});

		// The dispatches succeeded and delivered, but no reload fired — and no
		// refresh even consulted a rebuild source for read-only commands.
		expect(h.prompts.length).toBe(2);
		expect(h.agentReloads).toBe(0);
		expect(h.commandReloads).toBe(0);
		expect(served).toBe(0);
	});

	test('policy refusals never trigger: the REAL refusal text of BOTH v1 policy gates submits as-is without a refresh', async () => {
		// The exact dispatched text buildSwarmCommandPrompt produces for a
		// canonicalized `config doctor --fix` the policy refuses —
		// (a) the swarm_command tool gate (classifySwarmCommandToolUse,
		//     src/commands/tool-policy.ts, routable-agent arm) and
		// (b) the chat-fallback gate (classifySwarmCommandChatFallbackUse —
		//     the arm a host without the swarm_command tool takes).
		// Both share the stable marker the dispatcher gates on
		// (`/swarm config doctor --fix is not available through`); a genuine
		// executed-doctor output never contains it.
		const refusalTexts = [
			[
				'The user typed `/swarm config doctor --fix`.',
				'/swarm config doctor --fix is not available through swarm_command. Run the CLI command directly when you intend to modify config files.',
				'Do not invent command output. Explain the limitation and recommend the canonical CLI path above.',
			].join('\n'),
			[
				'The user typed `/swarm config doctor --fix`.',
				'/swarm config doctor --fix is not available through chat fallback because it can modify configuration files. Run the CLI command directly when you intend to apply fixes.',
				'Do not execute this command through chat and do not invent command output.',
			].join('\n'),
		];
		for (const refusalText of refusalTexts) {
			const h = makeTriggerCtx();
			let served = 0;
			registerV2ConfigRebuildSource(async () => {
				served += 1;
				return { agentTable: tableB, commandTable: {} };
			});
			const hooks = {
				config: async (cfg: Record<string, unknown>) => {
					cfg.agent = tableA;
					cfg.command = DOCTOR_TABLE;
				},
				'command.execute.before': async (
					_input: unknown,
					output: { parts: unknown[] },
				) => {
					output.parts.splice(0, output.parts.length, {
						type: 'text',
						text: refusalText,
					});
				},
			} as unknown as V1HooksSubset;
			await registerV2AgentsAndCommands(
				h.ctx as never,
				hooks,
				trackedMkdtemp('v2-2910-trig-refusal-'),
				[],
			);
			const generic = h.commands.find((c) => c.name === 'swarm');
			expect(generic).toBeDefined();

			await generic?.execute({
				sessionID: 'trig-refusal',
				prompt: { text: 'config doctor --fix' },
			});

			// The refusal text was submitted AS-IS (the operator must still see
			// the policy's guidance)…
			expect(h.prompts.length).toBe(1);
			expect(h.prompts[0]?.text).toBe(refusalText);
			// …but a refusal fixed NOTHING: no rebuild-source consult, no
			// reloads (this is the pre-PRR-005 defect — the trigger used to
			// fire on exactly this shape).
			expect(served).toBe(0);
			expect(h.agentReloads).toBe(0);
			expect(h.commandReloads).toBe(0);
		}
	});

	test('a safeHook-swallowed handler failure never triggers (empty parts + registry record)', async () => {
		const h = makeTriggerCtx();
		registerV2ConfigRebuildSource(async () => ({
			agentTable: tableB,
			commandTable: {},
		}));
		const throwing = async (): Promise<void> => {
			throw new Error('doctor handler exploded (deliberate)');
		};
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = DOCTOR_TABLE;
			},
			'command.execute.before': safeHook(throwing),
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-err-swallow-'),
			[],
		);
		const generic = h.commands.find((c) => c.name === 'swarm');
		await generic?.execute({
			sessionID: 'trig-err-swallow',
			prompt: { text: 'config doctor --fix' },
		});
		// Template fallback was submitted, no reload fired.
		expect(h.prompts.length).toBe(1);
		expect(h.prompts[0]?.text).toBe('/swarm config doctor --fix');
		expect(h.agentReloads).toBe(0);
		expect(h.commandReloads).toBe(0);
	});

	test('production path: real buildV2RegistrationTables + on-disk memory.enabled flip reloads both domains', async () => {
		const dir = trackedMkdtemp('v2-2910-trig-prod-');
		mkdirSync(join(dir, '.opencode'), { recursive: true });
		const configPath = join(dir, '.opencode', 'opencode-swarm.json');
		writeFileSync(configPath, JSON.stringify({ memory: { enabled: false } }));

		// The loader may merge a user-level multi-swarm config, so the
		// architect entry is located generically (bare or *_architect).
		const architectOf = (table: Record<string, unknown>) => {
			const entry = Object.entries(table).find(
				([name]) => name === 'architect' || name.endsWith('_architect'),
			)?.[1] as { permission?: Record<string, string> } | undefined;
			if (entry === undefined) throw new Error('no architect entry in table');
			return entry;
		};

		const h = makeTriggerCtx();
		// Registration snapshot = the REAL fresh builder's first output for
		// BOTH tables (the real command table carries the `swarm` key).
		const tables1 = await buildV2RegistrationTables(dir);
		expect(
			architectOf(tables1.agentTable).permission?.swarm_memory_recall,
		).toBe('deny');

		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tables1.agentTable;
				cfg.command = tables1.commandTable;
			},
			'command.execute.before': OK_DOCTOR_PARTS,
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(h.ctx as never, hooks, dir, []);
		registerV2ConfigRebuildSource(buildV2RegistrationTables);
		const generic = h.commands.find((c) => c.name === 'swarm');
		expect(generic).toBeDefined();

		// Disk unchanged: the real rebuild observes the SAME tables — no churn.
		await generic?.execute({
			sessionID: 'trig-prod',
			prompt: { text: 'config doctor --fix' },
		});
		expect(h.agentReloads).toBe(0);
		expect(h.commandReloads).toBe(0);

		// A config-writing doctor flipped the opt-in on disk.
		writeFileSync(configPath, JSON.stringify({ memory: { enabled: true } }));
		await generic?.execute({
			sessionID: 'trig-prod',
			prompt: { text: 'config doctor --fix' },
		});
		expect(h.agentReloads).toBe(1);
		expect(h.commandReloads).toBe(1);

		// And the fresh builder really dropped the deny for the new state.
		const tables2 = await buildV2RegistrationTables(dir);
		expect(
			architectOf(tables2.agentTable).permission?.swarm_memory_recall,
		).not.toBe('deny');
	}, 60_000);
});
