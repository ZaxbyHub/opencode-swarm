/**
 * Issue #2910 residual scope item 4 — the v2 domain reload() wiring.
 * DISCRIMINATING at base. AMENDED (check-author round): the OLD frozen
 * contract wrongly required the refresh to RE-CONSULT `hooks.config` — but
 * the production closure is STALE BY CONSTRUCTION: the hooks object was
 * captured at setup() time, so re-running `hooks.config` during a refresh
 * would rebuild exactly the tables it built at registration and the refresh
 * could never observe a change. The current-truth channel must instead be a
 * REGISTERED REBUILD SOURCE (what the config-writing command surface
 * registers when it mutates the tables).
 *
 * BASE DEFECT: no src/ caller exists for ANY v2 domain `reload()` (the
 * surface is vendored at src/host/v2/types.ts on the tool, worktree,
 * command, and agent domains) — so after a config-writing command changes
 * the plugin's agent/command tables, an OpenCode 2 host keeps serving the
 * STALE registration until restart.
 *
 * ============================================================================
 * CONTRACT REQUIREMENT IMPOSED ON THE IMPLEMENTER (loud, on purpose):
 *
 *   THE FIX MUST EXPORT FROM `src/host/v2/agents-commands.ts`:
 *     1. `registerV2ConfigRebuildSource(rebuild: (directory: string) =>
 *          Promise<{
 *            agentTable: Record<string, unknown>;
 *            commandTable: Record<string, unknown>;
 *          }>): void`
 *        — registers the current-truth table source (the registration-time
 *          snapshot is captured by `registerV2AgentsAndCommands`; a
 *          config-writing command swaps the source when it mutates tables).
 *     2. `deferredV2RefreshRegistrations(ctx, hooks, directory,
 *        registrations?)` — a Promise<void> refresh trigger named per the
 *        repo's deferred-* convention, with the SAME (ctx, hooks, directory,
 *        registrations) leading args as `registerV2AgentsAndCommands`.
 *
 *   OBSERVABLE CONTRACT (what this check asserts):
 *     (a) Source switched from tables A to tables B after registration:
 *         `deferredV2RefreshRegistrations` calls `ctx.agent.reload()` AND
 *         `ctx.command.reload()` exactly once each, and does NOT invoke
 *         `hooks.config` again (the closure is stale by construction).
 *     (b) Source returns the SAME tables as registration: NEITHER reload
 *         fires (idempotent — a no-change refresh must not churn the host).
 *     (c) NO source registered: resolves without throwing, no reloads.
 *     (d) Source REJECTS: resolves without throwing, no reloads (a failing
 *         rebuild must never wedge the host).
 *     The initial `registerV2AgentsAndCommands` itself does NOT reload
 *     (registration is the fresh path; reload is the refresh path).
 *   ============================================================================
 *
 * Fakes only (no mock.module): the v2 ctx is a plain recording object whose
 * agent/command domains count reload() calls; hooks.config is a
 * call-counting table emitter; the rebuild sources are plain closures.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as agentsCommands from '../../../../src/host/v2/agents-commands';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

interface ReloadRecordingCtx {
	ctx: unknown;
	agentReloads: number;
	commandReloads: number;
}

/** Fake v2 ctx whose agent/command domains COUNT reload() calls. */
function reloadRecordingCtx(): ReloadRecordingCtx {
	const counters = { agentReloads: 0, commandReloads: 0 };
	const registration = { dispose: async () => {} };
	const ctx = {
		agent: {
			transform: async () => registration,
			reload: async () => {
				counters.agentReloads += 1;
			},
		},
		command: {
			transform: async () => registration,
			reload: async () => {
				counters.commandReloads += 1;
			},
		},
		session: {
			hook: async () => registration,
			prompt: async () => {},
		},
	};
	return {
		ctx,
		get agentReloads() {
			return counters.agentReloads;
		},
		get commandReloads() {
			return counters.commandReloads;
		},
	};
}

/** The two seams this check requires (see the header contract block). */
interface RefreshSeams {
	registerSource: (
		rebuild: (directory: string) => Promise<{
			agentTable: Record<string, unknown>;
			commandTable: Record<string, unknown>;
		}>,
	) => void;
	refresh: (
		ctx: never,
		hooks: V1HooksSubset,
		directory: string,
		registrations?: unknown[],
	) => Promise<void>;
}

const MISSING_SEAM_MESSAGE =
	'MISSING SEAM: src/host/v2/agents-commands.ts must export BOTH ' +
	'registerV2ConfigRebuildSource(rebuild: (directory: string) => Promise<' +
	'{agentTable: Record<string, unknown>; commandTable: Record<string, unknown>}>) ' +
	'AND deferredV2RefreshRegistrations(ctx, hooks, directory, registrations?) ' +
	'for the #2910 reload wiring — at base no src/ caller exists for any v2 ' +
	'domain reload() (types.ts tool/worktree/command/agent domains).';

/** Guard BOTH required exports; a missing one is a loud MISSING SEAM error. */
function requireSeams(): RefreshSeams {
	const mod = agentsCommands as unknown as Record<string, unknown>;
	const registerSource = mod.registerV2ConfigRebuildSource;
	const refresh = mod.deferredV2RefreshRegistrations;
	if (typeof registerSource !== 'function' || typeof refresh !== 'function') {
		throw new Error(MISSING_SEAM_MESSAGE);
	}
	return {
		registerSource: registerSource as RefreshSeams['registerSource'],
		refresh: refresh as RefreshSeams['refresh'],
	};
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('v2 registration reload wiring (issue #2910 residual scope item 4)', () => {
	test('the refresh seams are exported from src/host/v2/agents-commands.ts', () => {
		const mod = agentsCommands as unknown as Record<string, unknown>;
		if (
			typeof mod.registerV2ConfigRebuildSource !== 'function' ||
			typeof mod.deferredV2RefreshRegistrations !== 'function'
		) {
			throw new Error(MISSING_SEAM_MESSAGE);
		}
		expect(typeof mod.registerV2ConfigRebuildSource).toBe('function');
		expect(typeof mod.deferredV2RefreshRegistrations).toBe('function');
	});

	// Declared BEFORE the source-registering tests on purpose: the seam
	// holds the rebuild source at MODULE level and exposes no unregister
	// API, so the pristine no-source state is observable only before any
	// sibling test registers one.
	test('(c) NO source registered: the refresh resolves without throwing and reloads nothing', async () => {
		const { refresh } = requireSeams();
		const recording = reloadRecordingCtx();
		const hooks = { config: async () => {} } as V1HooksSubset;
		await refresh(
			recording.ctx as never,
			hooks,
			trackedMkdtemp('swarm-2910-reload-c-'),
			[],
		);
		expect(recording.agentReloads).toBe(0);
		expect(recording.commandReloads).toBe(0);
	});

	test('(a) source switched A -> B after registration: BOTH domains reload once; hooks.config NOT re-invoked', async () => {
		const { registerSource, refresh } = requireSeams();
		const recording = reloadRecordingCtx();
		const directory = trackedMkdtemp('swarm-2910-reload-a-');

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
		let configCalls = 0;
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				configCalls += 1;
				cfg.agent = tableA;
				cfg.command = {};
			},
		} as V1HooksSubset;

		// Source #1 returns tables A (matching the registration snapshot).
		let current = tableA;
		registerSource(async () => ({
			agentTable: current,
			commandTable: {},
		}));

		// Initial registration: the fresh path — NO reload.
		await registerV2AgentsAndCommands(
			recording.ctx as never,
			hooks,
			directory,
			[],
		);
		expect(configCalls).toBe(1);
		expect(recording.agentReloads).toBe(0);
		expect(recording.commandReloads).toBe(0);

		// A config-writing command changed the tables: switch the source to
		// tables B, then refresh.
		current = tableB;
		registerSource(async () => ({
			agentTable: current,
			commandTable: {},
		}));
		await refresh(recording.ctx as never, hooks, directory, []);

		// BOTH domains reload exactly once...
		expect(recording.agentReloads).toBe(1);
		expect(recording.commandReloads).toBe(1);
		// ...and hooks.config is NOT invoked again during the refresh — the
		// v1 closure is stale by construction; the rebuild source is the
		// only current-truth channel.
		expect(configCalls).toBe(1);
	});

	test('(b) source returns the SAME tables: NEITHER reload fires', async () => {
		const { registerSource, refresh } = requireSeams();
		const recording = reloadRecordingCtx();
		const directory = trackedMkdtemp('swarm-2910-reload-b-');

		const agentTable = {
			coder_2910: {
				mode: 'subagent',
				prompt: 'You write code.',
				description: 'coder',
				permission: { write: 'allow' },
			},
		};
		const commandTable = {
			'swarm.status': { template: 'status', description: 'swarm status' },
		};
		let configCalls = 0;
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				configCalls += 1;
				cfg.agent = agentTable;
				cfg.command = commandTable;
			},
		} as V1HooksSubset;

		// The source returns the SAME table references registration captured.
		registerSource(async () => ({ agentTable, commandTable }));

		await registerV2AgentsAndCommands(
			recording.ctx as never,
			hooks,
			directory,
			[],
		);
		expect(configCalls).toBe(1);
		expect(recording.agentReloads).toBe(0);
		expect(recording.commandReloads).toBe(0);

		await refresh(recording.ctx as never, hooks, directory, []);

		// Unchanged tables: idempotent refresh, no churn on the host.
		expect(recording.agentReloads).toBe(0);
		expect(recording.commandReloads).toBe(0);
		expect(configCalls).toBe(1);
	});

	test('(d) source REJECTS: no reloads, resolves without throwing', async () => {
		const { registerSource, refresh } = requireSeams();
		registerSource(async () => {
			throw new Error('rebuild source boom (deliberate)');
		});
		const recording = reloadRecordingCtx();
		const hooks = { config: async () => {} } as V1HooksSubset;
		await refresh(
			recording.ctx as never,
			hooks,
			trackedMkdtemp('swarm-2910-reload-d-'),
			[],
		);
		expect(recording.agentReloads).toBe(0);
		expect(recording.commandReloads).toBe(0);
	});
});
