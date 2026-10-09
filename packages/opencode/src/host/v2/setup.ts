/**
 * OpenCode 2 (v2 plugin API) setup entrypoint — issue #3151 (8.x port of the
 * 7.x #3004 / ADR-0003 adapter).
 *
 * The v2 host validates the plugin's default export against
 * `{ id, setup | effect }` (sst/opencode v2 line, packages/core/src/plugin/
 * module.ts). The v1 `server()` path stays byte-stable for OpenCode 1 hosts;
 * this module is what `setup(ctx)` runs on OpenCode 2 hosts.
 *
 * Architecture: the adapter reuses the SAME initialization core and the SAME
 * v1 hook set — it only TRANSLATES registration surfaces:
 *
 *   - tools: `hooks.tool` map → `ctx.tool.transform(editor.add)`;
 *   - agents + commands: the v1 `config` hook is invoked against a synthetic
 *     `opencodeConfig` object, making the config hook itself the shared
 *     builder (the command table is reused verbatim — zero extraction from
 *     src/index.ts);
 *   - guidance: the v1 messages/system transform chains run against a
 *     translated session event; any #2526-style USER-role guidance carriers
 *     the messages chain materializes are re-homed into `event.system` (v2
 *     renders system natively);
 *   - lifecycle: tool execute.before/after, compaction and prompt hooks are
 *     wired with payload translation; `setup` returns a single Cleanup that
 *     disposes every Registration and runs the v1 dispose teardown.
 *
 * Recorded 8.x plan deltas (do NOT re-add without a plan revision):
 *   - D3: no nested-root redirect — the v1 8.x factory uses ctx.directory
 *     verbatim, so the 7.x fail-closed resolveProjectRootDecision helper is a
 *     recorded follow-up.
 *   - D4: no deferred event pump — 8.x v1 exposes no `event` hook, so
 *     startDeferredEventPump / state.pumpStop are not ported (events.ts was
 *     deliberately not staged).
 *
 * Init boundedness (AGENTS.md invariant 1): every `await` in src/host/** is
 * either on the same physical line as a `withTimeout(` call or inside a
 * function named deferred-…/cleanup-… (the frozen C6 source-scan convention,
 * enforced repo-side by tests/host/v2/dual-shape-parity.test.ts). The shared
 * initialization wrapper (`deps.runInit`) is injected by src/index.ts so no
 * module cycle is created and the FATAL-fail surface stays with the v1
 * wrapper.
 */

import { ensureAgentSession, log, swarmState } from '@opencode-swarm/core';
import { z } from 'zod';
import { registerV2AgentsAndCommands } from './agents-commands';
import { registerV2ContextHook } from './guidance';
import { registerV2SessionHooks, registerV2ToolHooks } from './hooks';
import {
	clearV2AgentTransformSurface,
	registerV2AgentTransformSurface,
} from './model-apply';
import { withTimeout } from './timeout';
import { registerV2Tools } from './tools';
import type { V1HooksSubset, V2PluginContext, V2Registration } from './types';

/** Bounds setup() itself — the v1 repro-704 class of deadline for the v2 path. */
const V2_SETUP_TIMEOUT_MS = 60_000;

/** Dependencies injected from src/index.ts (avoids an index↔host cycle). */
export interface V2SetupDependencies {
	/** The shared server-initialization wrapper (invocation counter → init core → FATAL surface). */
	runInit: (input: unknown) => Promise<V1HooksSubset>;
}

interface CollectedState {
	readonly registrations: V2Registration[];
	disposeV1?: () => Promise<void>;
}

/** Normalize a v2 agent reference (Agent.Info object or bare string) to a name. */
export function normalizeV2AgentRef(agent: unknown): string | undefined {
	if (typeof agent === 'string') return agent;
	if (agent && typeof agent === 'object') {
		const rec = agent as { id?: unknown; name?: unknown };
		if (typeof rec.id === 'string' && rec.id.length > 0) return rec.id;
		if (typeof rec.name === 'string' && rec.name.length > 0) return rec.name;
	}
	return undefined;
}

/**
 * Register the plugin on an OpenCode 2 host. Throws propagate to the v2 host
 * (which skips the plugin) after a FATAL stderr line from the shared wrapper —
 * the same posture the v1 server() path has (issue #675).
 */
export async function openCodeSwarmV2Setup(
	ctx: V2PluginContext,
	deps: V2SetupDependencies,
): Promise<() => Promise<void>> {
	const rawDirectory = ctx?.location?.directory;
	if (typeof rawDirectory !== 'string' || rawDirectory.length === 0) {
		// Fail closed (AGENTS.md invariant 4): the v2 Context contract marks
		// location.directory required; a cwd fallback would silently root
		// .swarm/ at the host process cwd.
		throw new Error(
			'[opencode-swarm] v2 setup: host Context carried no location.directory; refusing to start (invariant 4).',
		);
	}
	// 8.x parity: the v1 factory uses ctx.directory verbatim; the 7.x fail-closed
	// nested-root helper is a recorded follow-up (delta D3).
	const directory = rawDirectory;
	const state: CollectedState = { registrations: [] };

	// v1 PluginInput view — the init core consumes only `directory` and
	// `client`; the v2 Context carries no OpencodeClient, so background
	// managers take their client-absent paths.
	const input = {
		client: undefined,
		directory,
		worktree: directory,
	} as unknown as Parameters<V2SetupDependencies['runInit']>[0];

	const hooks = await withTimeout(
		deps.runInit(input),
		V2_SETUP_TIMEOUT_MS,
		new Error('[opencode-swarm] v2 setup: initialization exceeded budget'),
	);

	// Agents + commands through the v1 config hook against a synthetic config —
	// the single-source builder (see module header).
	await withTimeout(
		registerV2AgentsAndCommands(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: agent/command registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 agent/command registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Tools from the same map the v1 host receives.
	await withTimeout(
		registerV2Tools(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error('[opencode-swarm] v2 setup: tool registration exceeded budget'),
	).catch((err: unknown) => {
		log('v2 tool registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Guidance (context hook), tool hooks, compaction, prompt.
	await withTimeout(
		registerV2ContextHook(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: guidance registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 context-hook registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
	await withTimeout(
		registerV2ToolHooks(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: tool-hook registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 tool-hook registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
	await withTimeout(
		registerV2SessionHooks(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: prompt-hook registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 prompt-hook registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Remember the agent transform surface for runtime model rewrites (the
	// v2-native equivalent of the v1 chat-boundary model override write).
	registerV2AgentTransformSurface(ctx);

	state.disposeV1 =
		typeof hooks.dispose === 'function' ? hooks.dispose : undefined;

	log('[opencode-swarm] v2 setup complete', {
		directory,
		tools: Object.keys(hooks.tool ?? {}).length,
	});

	return async function cleanupV2Plugin(): Promise<void> {
		clearV2AgentTransformSurface();
		for (const registration of state.registrations) {
			try {
				await withTimeout(
					registration.dispose(),
					V2_SETUP_TIMEOUT_MS,
					new Error(
						'[opencode-swarm] v2 cleanup: registration dispose exceeded budget',
					),
				);
			} catch (err) {
				log('v2 registration dispose failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (state.disposeV1) {
			await withTimeout(
				state.disposeV1(),
				V2_SETUP_TIMEOUT_MS,
				new Error('[opencode-swarm] v2 cleanup: v1 dispose exceeded budget'),
			).catch((err: unknown) => {
				log('v1 dispose during v2 cleanup failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	};
}

/**
 * Seed the v1 session state a translated hook event implies. Shared by the
 * guidance/prompt/tool-hook adapters so the v1 chain sees the same session
 * identity the v1 host would have seeded via chat.message.
 */
export function seedV1SessionState(
	sessionID: string | undefined,
	agentRef: unknown,
	directory: string,
): string | undefined {
	if (typeof sessionID !== 'string' || sessionID.length === 0) return undefined;
	const agentName = normalizeV2AgentRef(agentRef);
	if (agentName === undefined) return sessionID;
	try {
		ensureAgentSession(sessionID, agentName, directory);
	} catch {
		// ensureAgentSession is best-effort here; the v1 chain re-resolves.
	}
	// Always re-pair: ensureAgentSession may have rewritten
	// agentSessions[sessionID].agentName on a mid-session agent switch, and
	// the v1 contract keeps activeAgent in sync with it — a first-write-wins
	// guard here left the two maps diverged.
	swarmState.activeAgent.set(sessionID, agentName);
	return sessionID;
}

/**
 * Convert a v1 zod args shape into the JSON-schema-ish `input` value the v2
 * tool editor accepts. Cached per tool at registration time (transforms must
 * be synchronous and cheap).
 */
export function v2ToolInputSchema(args: unknown): unknown {
	try {
		if (args && typeof args === 'object') {
			return z.toJSONSchema(z.object(args as z.ZodRawShape));
		}
	} catch {
		// Fall through to the permissive schema.
	}
	return { type: 'object' as const };
}
