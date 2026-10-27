/**
 * #2910 W3/W5 implementation-phase controls — the owner-registry LIFECYCLE
 * legs the frozen checks do not carry (swarm-pr-review pr3444-20261025):
 *
 *  - PRR-004: a completed setup's cleanup RELEASES its registration
 *    snapshot, so its owner entry DROPS from the bounded v2OwnerStates map
 *    (pre-fix: the snapshot was never cleared, every completed setup stayed
 *    immortal, and a torn-down-but-resolvable owner shadowed the fallback
 *    resolution for surviving instances) — asserted both via the test-only
 *    entry counter and via observable resolution (a post-cleanup dispatch
 *    through the dead ctx resolves NO rebuild source).
 *  - PRR-017: a REJECTED setup (runInit throws — the designed FATAL
 *    posture) unregisters the owner state it registered before the throw:
 *    no leaked entry, no dead-but-current token, and a fresh setup on the
 *    same ctx starts from clean state.
 *
 * Fakes only (no mock.module); the REAL openCodeSwarmV2Setup /
 * deferredV2RefreshRegistrations drive both legs.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	countV2OwnerStatesForTests,
	deferredV2RefreshRegistrations,
	resetV2OperatorWarningState,
} from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
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

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

/** Fake v2 Context with every domain setup touches (setup-wiring shape). */
function fakeV2Ctx(
	directory: string,
	commands?: RegisteredCommand[],
	counters?: { agentReloads: number; commandReloads: number },
): Record<string, unknown> {
	const registration = { dispose: async () => {} };
	const makeTransform = () => async (fn: (editor: unknown) => void) => {
		fn({
			update: (_id: string, mut: (a: unknown) => void) => mut({}),
			remove: () => {},
			list: () => [],
		});
		return registration;
	};
	return {
		location: { directory },
		agent: {
			transform: makeTransform(),
			reload: async () => {
				if (counters !== undefined) counters.agentReloads += 1;
			},
		},
		command: {
			transform: async (
				fn: (e: { add(d: RegisteredCommand): void }) => void,
			) => {
				fn({
					add(d) {
						commands?.push(d);
					},
				});
				return registration;
			},
			reload: async () => {
				if (counters !== undefined) counters.commandReloads += 1;
			},
		},
		tool: { transform: makeTransform(), hook: async () => registration },
		session: { hook: async () => registration, prompt: async () => {} },
		event: {},
	};
}

/** Hooks whose config-hook emits the generic `swarm` command table. */
const doctorHooks = (agentTable: Record<string, unknown>): V1HooksSubset =>
	({
		config: (c: Record<string, unknown>) => {
			c.agent = agentTable;
			c.command = {
				swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
			};
		},
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

const TABLE_V1 = {
	coder_release_2910: {
		mode: 'subagent',
		prompt: 'registration table (v1).',
		description: 'coder',
	},
};
const TABLE_V2 = {
	coder_release_2910: {
		mode: 'subagent',
		prompt: 'rebuilt table (v2 — fix applied).',
		description: 'coder',
	},
};

afterEach(async () => {
	resetV2OperatorWarningState();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#2910 W3 owner-registry lifecycle (PRR-004 / PRR-017)', () => {
	test('PRR-004: cleanup releases the registration snapshot — the owner entry drops and the dead ctx resolves nothing', async () => {
		const baseline = countV2OwnerStatesForTests();
		const served = { count: 0 };
		const reloads = { agentReloads: 0, commandReloads: 0 };
		const commands: RegisteredCommand[] = [];
		const dir = trackedMkdtemp('v2-2910-release-snap-');
		const ctx = fakeV2Ctx(dir, commands, reloads);
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => doctorHooks(TABLE_V1) as never,
			buildV2RegistrationTables: async () => {
				served.count += 1;
				return { agentTable: TABLE_V2, commandTable: {} };
			},
		});
		// Registration stored a snapshot on THIS instance's entry (plus its
		// rebuild source + quiet): exactly one live owner entry was added.
		expect(countV2OwnerStatesForTests()).toBe(baseline + 1);

		const swarm = commands.find((c) => c.name === 'swarm');
		expect(swarm).toBeDefined();
		// One permitted dispatch: A's rebuild serves, tables changed, reloads.
		await swarm?.execute({
			sessionID: 'prr004',
			prompt: { text: 'config doctor --fix' },
		});
		expect(served.count).toBe(1);
		expect(reloads.agentReloads).toBe(1);
		expect(reloads.commandReloads).toBe(1);

		await cleanup();

		// Snapshot released + rebuild/quiet detached + ctx binding removed:
		// the entry DROPPED. Pre-fix the snapshot kept it immortal in the
		// bounded map (unbounded across re-setups).
		expect(countV2OwnerStatesForTests()).toBe(baseline);

		// Observable resolution: a dispatch through the dead ctx resolves NO
		// rebuild source — the source never serves again and the refresh
		// degrades to its designed no-source warning instead of comparing
		// against a torn-down owner's tables.
		clearDeferredWarnings();
		await swarm?.execute({
			sessionID: 'prr004',
			prompt: { text: 'config doctor --fix' },
		});
		expect(served.count).toBe(1);
		expect(reloads.agentReloads).toBe(1);
		expect(reloads.commandReloads).toBe(1);
		expect(
			getDeferredWarnings().some((w) =>
				w.includes('no config rebuild source is registered'),
			),
		).toBe(true);
	}, 60_000);

	test('PRR-017: a rejected runInit unregisters the owner state — no leak, no stale rebuild source for a fresh setup', async () => {
		const baseline = countV2OwnerStatesForTests();
		const staleServed = { count: 0 };
		const dir = trackedMkdtemp('v2-2910-release-reject-');
		const ctx = fakeV2Ctx(dir);
		await expect(
			openCodeSwarmV2Setup(ctx as never, {
				runInit: async () => {
					throw new Error('runInit exploded (deliberate PRR-017)');
				},
				buildV2RegistrationTables: async () => {
					staleServed.count += 1;
					return { agentTable: {}, commandTable: {} };
				},
			}),
		).rejects.toThrow('runInit exploded (deliberate PRR-017)');

		// The failed setup registered its owner entry BEFORE runInit and the
		// rejection-path catch unregistered it: no immortal entry, no
		// dead-but-current token (pre-fix both leaked permanently).
		expect(countV2OwnerStatesForTests()).toBe(baseline);

		// Observable: nothing resolvable — a direct refresh consults no
		// rebuild source (the failed setup's builder never serves).
		clearDeferredWarnings();
		await deferredV2RefreshRegistrations(
			fakeV2Ctx(trackedMkdtemp('v2-2910-release-probe-')) as never,
			{} as V1HooksSubset,
			dir,
			[],
		);
		expect(staleServed.count).toBe(0);
		expect(
			getDeferredWarnings().some((w) =>
				w.includes('no config rebuild source is registered'),
			),
		).toBe(true);

		// And a FRESH setup on the SAME ctx starts from clean owner state —
		// it succeeds and its own cleanup leaves the registry at baseline.
		clearDeferredWarnings();
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => doctorHooks(TABLE_V1) as never,
		});
		expect(countV2OwnerStatesForTests()).toBe(baseline + 1);
		await cleanup();
		expect(countV2OwnerStatesForTests()).toBe(baseline);
	}, 60_000);
});
