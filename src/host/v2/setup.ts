/**
 * #3022 AC4 (deferred, per the C6 naming convention): clientless startup model
 * preflight for v2 hosts. The catalog-backed `runModelPreflight` requires an
 * OpencodeClient the v2 Context does not carry, so validate the effective
 * enabled-role models against the checked-in verified keyless roster instead
 * and surface a bounded operational warning per non-roster id. Fail-open on
 * every error; bounded local reads only (no network).
 *
 * #3350 AC1: every failure arm is operator-visible through the
 * deferred-warning buffer — (a) the config read exceeding its LIVE budget
 * (`_internals.preflightConfigTimeoutMs`, read at call time) or throwing, and
 * (b) a resolved-but-degraded ConfigLoadResult (`configHadErrors` — the exact
 * loader field, src/config/loader.ts). Exactly one preflight warning per arm;
 * roster warnings (clean load) are unchanged.
 */
async function deferredV2StartupModelPreflight(
	directory: string,
): Promise<void> {
	// Call-time reads (#3350 AC4 declared seam): tests pin the budget and the
	// loader through _internals, so a module-load capture would freeze them.
	const budgetMs = _internals.preflightConfigTimeoutMs;
	try {
		// Async loader so the budget is a real bound (the sync variant runs to
		// completion before withTimeout could start its timer); same budget as
		// the v1 config load (src/index.ts LOAD_PLUGIN_CONFIG_TIMEOUT_MS).
		const loaded = await withTimeout(
			_internals.loadConfig(directory),
			_internals.preflightConfigTimeoutMs,
			new Error(
				`[opencode-swarm] v2: startup preflight config read exceeded the ${budgetMs}ms budget`,
			),
		);
		// The preflight load is the earliest config read setup owns: feed the
		// v2 operator-warning quiet flag from it (#3318). #2910 W3/W5: the
		// 1-arg setter attaches to the CURRENT owner's registry entry — this
		// setup's per-instance token, made current at startup below.
		setV2OperatorQuiet(loaded?.config?.quiet === true);
		if (loaded?.configHadErrors === true) {
			addDeferredWarning(
				`[opencode-swarm] v2: startup model preflight degraded — the config read resolved with errors (configHadErrors) within its ${budgetMs}ms budget; the roster check ran against the degraded configuration.`,
			);
		}
		const entries = collectEnabledAgentModels(loaded?.config);
		const models = entries
			.map((entry) => entry.model)
			.filter(
				(model): model is string =>
					typeof model === 'string' && model.length > 0,
			);
		const quiet = loaded?.config?.quiet === true;
		for (const warning of collectModelRosterWarnings(
			models,
			VERIFIED_KEYLESS_MODEL_ROSTER,
		)) {
			// Two surfaces, mirroring the v1 preflight (src/index.ts ~1625):
			// 1. addDeferredWarning — the in-process advisory buffer /swarm
			//    diagnose reads. Live hosts run plugins in the background
			//    service process whose console the CLI does not relay (D3/AC4
			//    live probe, 2026-10-02), so the buffer is the channel the
			//    operator can actually reach; warn() alone would be
			//    OPENCODE_SWARM_DEBUG-gated and invisible in production.
			// 2. console.warn on stderr for foreground/standalone service runs,
			//    quiet-gated exactly like the v1 preflight's console.warn.
			addDeferredWarning(warning);
			if (!quiet) {
				// biome-ignore lint/suspicious/noConsole: #3022 AC4 startup roster warning must be visible without OPENCODE_SWARM_DEBUG, gated on config.quiet like the v1 preflight
				console.warn(warning);
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('v2 startup model preflight failed (non-fatal)', { error: message });
		addDeferredWarning(
			`[opencode-swarm] v2: startup model preflight failed after the ${budgetMs}ms config budget (${message}); the roster check did not run.`,
		);
	}
}

/**
 * Read `full_auto.oversight` once and size the v2 tool.execute.before budget
 * for this project directory from it (#3446). Bounded and fail-open: on any
 * error this project's entry is dropped and the module defaults apply (60 s
 * base; 150 s while a Full-Auto run is active, i.e. the default 120 s
 * oversight deadline + 30 s) and an operator-visible warning is queued,
 * because a custom `hook_timeout_ms` / `total_timeout_ms` would not apply.
 */
async function deferredV2ConfigureToolBeforeBudget(
	directory: string,
	loadConfig: typeof loadPluginConfigWithMetaAsync = loadPluginConfigWithMetaAsync,
): Promise<void> {
	try {
		const loaded = await withTimeout(
			loadConfig(directory),
			V2_PREFLIGHT_CONFIG_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: hook-budget config read exceeded budget'),
		);
		configureV2ToolBeforeBudget(loaded?.config?.full_auto, directory);
	} catch (err) {
		// A previous setup for THIS project must not leave a stale custom
		// budget; other projects' entries are untouched.
		resetV2ToolBeforeBudget(directory);
		const reason = err instanceof Error ? err.message : String(err);
		addDeferredWarning(
			`[opencode-swarm] v2: could not read full_auto.oversight for the tool.execute.before budget (${reason}); default budgets apply (60 s, or 150 s while Full-Auto runs).`,
		);
		log('v2 hook-budget config read failed (non-fatal)', { error: reason });
	}
}

/**
 * Register the tool hooks and, concurrently, size the before-chain budget from
 * config. The budget is resolved per call, so registration never waits on the
 * config read (it would otherwise eat into the registration race, #3327).
 */
async function deferredV2RegisterToolHooks(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	await Promise.all([
		deferredV2ConfigureToolBeforeBudget(directory),
		registerV2ToolHooks(ctx, hooks, directory, registrations),
	]);
}

/**
 * OpenCode 2 (v2 plugin API) setup entrypoint — issue #3004 / #2910.
 *
 * The v2 host validates the plugin's default export against
 * `{ id, setup | effect }` (sst/opencode v2 line, packages/core/src/plugin/
 * module.ts). The v1 `server()` path stays byte-stable for OpenCode 1 hosts;
 * this module is what `setup(ctx)` runs on OpenCode 2 hosts.
 *
 * Architecture (ADR-0003): the adapter reuses the SAME initialization core and
 * the SAME v1 hook set — it only TRANSLATES registration surfaces:
 *
 *   - tools: `hooks.tool` map → `ctx.tool.transform(editor.add)` (one source,
 *     `buildPluginToolObject`; no parallel name list — enforced by
 *     scripts/check-tool-registration.ts);
 *   - agents + commands: the v1 `config` hook is invoked against a synthetic
 *     `opencodeConfig` object, making the config hook itself the shared
 *     builder (auto-select promotions and the command table are reused
 *     verbatim — zero extraction from src/index.ts);
 *   - guidance: the v1 messages/system transform chains run against a
 *     translated session event; the #2526 USER-role guidance carriers the
 *     messages chain materializes are re-homed into `event.system` (v2 renders
 *     system natively — the user→system transport delta is recorded in
 *     docs/host/v2-hook-inventory.md);
 *   - lifecycle: tool execute.before/after, compaction, prompt hooks and the
 *     event subscription are wired with payload translation; `setup` returns
 *     a single Cleanup that disposes every Registration and runs the v1
 *     dispose teardown.
 *
 * Init boundedness (AGENTS.md invariant 1): every `await` in src/host/** is
 * either on the same physical line as a `withTimeout(` call or inside a
 * function named deferred-…/cleanup-… (the frozen C6 source-scan convention).
 * The shared initialization wrapper (`deps.runInit`) is injected by
 * src/index.ts so no module cycle is created and the FATAL-fail surface stays
 * with the v1 wrapper.
 */

import { z } from 'zod';
import { loadPluginConfigWithMetaAsync } from '../../config/loader';
import {
	collectEnabledAgentModels,
	collectModelRosterWarnings,
	VERIFIED_KEYLESS_MODEL_ROSTER,
} from '../../services/model-preflight';
import { addDeferredWarning } from '../../services/warning-buffer';
import {
	ensureAgentSession,
	recordPrimaryOwner,
	swarmState,
} from '../../state';
import { log } from '../../utils';
import { resolveProjectRootDecision } from '../../utils/project-boundary';
import { withTimeout } from '../../utils/timeout';
import {
	clearV2CtxOwnerBinding,
	clearV2OwnerRegistrationSnapshot,
	registerV2AgentsAndCommands,
	registerV2ConfigRebuildSourceForOwner,
	setV2OperatorQuiet,
	setV2OperatorQuietForOwner,
} from './agents-commands';
import { clearToolNameRegistry, startDeferredEventPump } from './events';
import { registerV2ContextHook } from './guidance';
import {
	configureV2ToolBeforeBudget,
	resetV2ToolBeforeBudget,
} from './hook-budget';
import {
	registerV2SessionHooks,
	registerV2ShellHooks,
	registerV2ToolHooks,
} from './hooks';
import {
	clearV2AgentTransformSurface,
	registerV2AgentTransformSurface,
} from './model-apply';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from './session-client';
import { registerV2Tools } from './tools';
import type { V1HooksSubset, V2PluginContext, V2Registration } from './types';

/**
 * Bounds setup() init, the tail preflight and cleanup (the v1 repro-704 class
 * of deadline for the v2 path). Deliberately generous: the shared init core has
 * its own bounded fail-open budgets (snapshot 5 s, git-exclude 3 s, config 2 s),
 * and a setup rejection is recorded by the host as a failed plugin load, so this
 * outer cap must not pre-empt those designed degradations.
 */
const V2_SETUP_TIMEOUT_MS = 60_000;

/**
 * Bounds the parallel registration stage only (the five local, in-process host
 * domain registrations; measured ~30 ms). The host awaits plugin activation
 * before serving requests and caps some early requests at 5 s, so a stalled
 * registration must not hold setup() open. When this budget fires, setup()
 * resolves with the registrations that finished and the still-pending domains
 * are surfaced via addDeferredWarning; it is not a bound on total setup() time.
 */
const V2_REGISTRATION_TIMEOUT_MS = 3_500;

/** Startup preflight config-read budget (parity with the v1 config load). */
const V2_PREFLIGHT_CONFIG_TIMEOUT_MS = 2_000;

/**
 * Test seam (#3350 AC4 declared seam, frozen checks
 * setup-registration-budget-fakeclock-3327 / setup-preflight-timeout-3327):
 * the registration-stage budget, the preflight config budget, the preflight
 * loader and the deferred tool.execute.before budget configurator are read
 * through this object AT CALL TIME so tests can pin them without patching
 * global timers (AGENTS.md invariant 7; precedent: PRR-002 dispatchTimeoutMs
 * in agents-commands.ts). Production never mutates it.
 */
export const _internals = {
	registrationTimeoutMs: V2_REGISTRATION_TIMEOUT_MS,
	preflightConfigTimeoutMs: V2_PREFLIGHT_CONFIG_TIMEOUT_MS,
	loadConfig:
		loadPluginConfigWithMetaAsync as typeof loadPluginConfigWithMetaAsync,
	configureToolBeforeBudget: deferredV2ConfigureToolBeforeBudget,
};

/** Dependencies injected from src/index.ts (avoids an index↔host cycle). */
export interface V2SetupDependencies {
	/** The shared server-initialization wrapper (begin-interval → init core → schedule deferred → end-interval). */
	runInit: (input: unknown) => Promise<V1HooksSubset>;
	/**
	 * Fresh registration-table builder (#2910 W3): a FRESH config read plus
	 * `getAgentConfigs` + the shared command-table builder — no
	 * side-effecting init re-run. Registered as this setup instance's config
	 * rebuild source so a successful `config doctor --fix` dispatch can
	 * refresh the registration tables. `undefined` -> the adapter registers
	 * no rebuild source (registration refresh stays a no-op).
	 */
	buildV2RegistrationTables?: (directory: string) => Promise<{
		agentTable: Record<string, unknown>;
		commandTable: Record<string, unknown>;
	}>;
}

interface CollectedState {
	readonly registrations: V2Registration[];
	/** Marks cleanup as started: later registrations dispose themselves. */
	closeRegistrations: () => void;
	pumpStop?: () => void;
	disposeV1?: () => Promise<void>;
}

/**
 * Registration collector. A registration that lands after cleanup began (a
 * stalled domain that outlived the registration budget) is disposed on arrival
 * instead of being left live and untracked.
 */
function createRegistrationSink(): Pick<
	CollectedState,
	'registrations' | 'closeRegistrations'
> {
	const registrations: V2Registration[] = [];
	const push = registrations.push.bind(registrations);
	let closed = false;
	registrations.push = (...items: V2Registration[]): number => {
		if (!closed) return push(...items);
		for (const item of items) {
			withTimeout(
				Promise.resolve().then(() => item.dispose()),
				V2_SETUP_TIMEOUT_MS,
				new Error(
					'[opencode-swarm] v2 cleanup: late registration dispose exceeded budget',
				),
			).catch((err: unknown) => {
				log('v2 late registration dispose failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
		return registrations.length;
	};
	return {
		registrations,
		closeRegistrations: () => {
			closed = true;
		},
	};
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
 * Monotonic per-process owner-token counter (#2910 W3/W5): one token per
 * setup instance, scoping the config rebuild-source/quiet registry entry and
 * the model-apply surface so a concurrent live setup's cleanup can never
 * remove another instance's state.
 */
let v2SetupOwnerCounter = 0;

function nextV2OwnerToken(): string {
	v2SetupOwnerCounter += 1;
	return `v2-owner-${v2SetupOwnerCounter}`;
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
	// #2910 W3/W5 owner startup: register THIS instance's rebuild source (from
	// deps; absent -> no rebuild source) and quiet entry BEFORE anything else,
	// so every later owner-scoped write (preflight quiet, registration
	// snapshot) attaches to this token and cleanup unregisters exactly these.
	const ownerToken = nextV2OwnerToken();
	registerV2ConfigRebuildSourceForOwner(
		ownerToken,
		deps.buildV2RegistrationTables,
	);
	setV2OperatorQuietForOwner(ownerToken, false);
	// #PRR-017 (swarm-pr-review pr3444-20261025): everything AFTER the
	// owner-state registration is guarded — a rejection (the designed FATAL
	// posture: runInit timeout/throw) unregisters THIS instance's owner state
	// (rebuild source, quiet, registration snapshot, transform surface, ctx
	// binding — all sync owner-scoped calls) and RETHROWS, so a failed setup
	// leaks no immortal owner entry and no dead-but-current token.
	try {
		// Route the raw directory through the same project-root decision the v1
		// init path applies (issue #2127): a subdirectory owned by a parent
		// project root redirects, so session-scoped state does not split-brain
		// between two .swarm trees. Fail-closed keeps the raw directory (matching
		// the v1 bootstrapRoot behavior) with state writes disabled upstream.
		const rootDecision = resolveProjectRootDecision(rawDirectory);
		const directory =
			rootDecision.kind === 'redirect'
				? rootDecision.owningRoot
				: rootDecision.kind === 'root'
					? rootDecision.directory
					: rawDirectory;
		const state: CollectedState = createRegistrationSink();

		// v1 PluginInput view — the init core consumes only `directory` and
		// `client`. #3169 Phase 2: the session-client shim bridges the v2
		// `ctx.session` domain into the v1 client subset Epic's dispatch paths use
		// (feature-detected; a host lacking the required surface keeps
		// `undefined`, preserving every client-absent path).
		const input = {
			client: createV2SessionClient(ctx),
			directory,
			worktree: directory,
		} as unknown as Parameters<V2SetupDependencies['runInit']>[0];

		const hooks = await withTimeout(
			deps.runInit(input),
			V2_SETUP_TIMEOUT_MS,
			new Error('[opencode-swarm] v2 setup: initialization exceeded budget'),
		);

		// The five registrations touch disjoint host Context domains and read no
		// state written by one another, so they run concurrently under ONE
		// registration-stage budget; each keeps its own non-fatal isolation. A domain
		// still pending when the budget fires is named in a deferred warning (the
		// operator-reachable channel; log() is debug-gated) — setup resolves with the
		// registrations that completed, and a late arrival is disposed by the sink
		// once cleanup has started.
		const pendingDomains = new Set<string>();
		const runRegistration = (
			domain: string,
			register: () => Promise<unknown>,
		): Promise<unknown> => {
			pendingDomains.add(domain);
			return register()
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					log(`v2 ${domain} registration failed (non-fatal)`, {
						error: message,
					});
					// #3352/#3318: a REJECTED domain is operator-visible, not only
					// debug-logged (log() is OPENCODE_SWARM_DEBUG-gated).
					addDeferredWarning(
						`[opencode-swarm] v2 setup: ${domain} registration failed (${message}); the domain was not registered.`,
					);
				})
				.finally(() => {
					pendingDomains.delete(domain);
				});
		};
		await withTimeout(
			Promise.all([
				runRegistration('agent/command', () =>
					// #2910 W3/W5 / review PRR-003: the setup instance's token —
					// binds this ctx to THIS instance so its dispatch-driven
					// refresh resolves through its own rebuild source/snapshot.
					registerV2AgentsAndCommands(
						ctx,
						hooks,
						directory,
						state.registrations,
						ownerToken,
					),
				),
				runRegistration('tool', () =>
					registerV2Tools(ctx, hooks, directory, state.registrations),
				),
				runRegistration('context-hook', () =>
					registerV2ContextHook(ctx, hooks, directory, state.registrations),
				),
				runRegistration('tool-hook', () =>
					deferredV2RegisterToolHooks(
						ctx,
						hooks,
						directory,
						state.registrations,
					),
				),
				runRegistration('prompt-hook', () =>
					registerV2SessionHooks(ctx, hooks, directory, state.registrations),
				),
				runRegistration('shell-observer', () =>
					registerV2ShellHooks(ctx, state.registrations),
				),
			]),
			_internals.registrationTimeoutMs,
			new Error(
				'[opencode-swarm] v2 setup: parallel registration exceeded budget',
			),
		).catch((err: unknown) => {
			const pending = [...pendingDomains];
			log('v2 registration failed (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
				pending,
			});
			// #3350 AC5 (guard removed — decision recorded on
			// https://github.com/ZaxbyHub/opencode-swarm/issues/3350#issuecomment-6388937737):
			// the timeout catch ALWAYS warns, even when every domain completed
			// after the budget raced ahead of the last .finally — the stage still
			// exceeded its budget and the operator must see that.
			const pendingText =
				pending.length > 0
					? pending.join(', ')
					: 'none — domains completed but the stage exceeded budget';
			addDeferredWarning(
				`[opencode-swarm] v2 setup: registration still pending after ${_internals.registrationTimeoutMs}ms (${pendingText}); the plugin loaded with partial registration.`,
			);
		});

		// Deferred event pump (detached; named for the C6 convention).
		const stopPump = startDeferredEventPump(ctx, hooks);
		state.pumpStop = stopPump;

		// #3022 D2: remember the agent transform surface for runtime model
		// rewrites (fallback advance application — the v2-native equivalent of
		// the v1 output.message.model write). #2910 W5: token-carrying so this
		// instance's cleanup clears only its own surface.
		registerV2AgentTransformSurface(ctx, ownerToken);

		// #3022 AC4: clientless startup roster preflight — the catalog-backed
		// preflight is client-only, so on v2 validate the effective models against
		// the checked-in verified roster instead. Every failure mode is a
		// non-fatal warning. Run INLINE at the tail of setup: live 2.0.21 probing
		// showed the host's plugin realm does NOT execute post-setup timer
		// callbacks, so a setTimeout-deferred run never fired; this is a local
		// two-file JSON read (no network, ~17 ms warm), within invariant 1's
		// fast-init allowance. The withTimeout wrap satisfies the C6 scan's
		// same-line bound requirement for awaits inside openCodeSwarmV2Setup.
		await withTimeout(
			deferredV2StartupModelPreflight(directory),
			V2_SETUP_TIMEOUT_MS,
			new Error('[opencode-swarm] v2: startup model preflight exceeded budget'),
		);

		state.disposeV1 =
			typeof hooks.dispose === 'function' ? hooks.dispose : undefined;

		log('[opencode-swarm] v2 setup complete', {
			directory,
			tools: Object.keys(hooks.tool ?? {}).length,
		});

		return async function cleanupV2Plugin(): Promise<void> {
			state.closeRegistrations();
			if (typeof state.pumpStop === 'function') state.pumpStop();
			// #3169 Phase 2: drop the shim's bounded registries immediately after
			// the pump stop flag — an in-flight pump iteration can still record one
			// error envelope afterwards; that bounded residue is re-cleared on the
			// next cleanup (documented in the trace).
			clearV2SessionClientState();
			// #2910 W5: owner-scoped clear — only THIS instance's surface + held
			// registrations; a concurrent live setup's surface survives.
			clearV2AgentTransformSurface(ownerToken);
			// #3401: the pump-side tool-name registry must not outlive the pump —
			// stale (session,call)→name residue would put a re-setup under
			// eviction pressure (and could hand a recycled dispatch id a stale
			// name).
			clearToolNameRegistry();
			// #2910 W3/W5 / review PRR-002 (swarm-pr-review pr3444-20261025): the
			// process-global swallowed-error registry and the operator-warning
			// dedup state are NOT cleared here anymore. Both are bounded FIFO
			// with explicit eviction (64 / 32 — the AGENTS.md invariant-8
			// strategy), so they cannot grow unbounded WITHOUT a clear; a global
			// clear at cleanup WOULD cross instance boundaries (an overlapping
			// live instance's unread entries and dedup state are its own).
			// #2910 W3/W5: unregister THIS instance's owner-scoped state —
			// rebuild source, quiet entry, the registration snapshot (review
			// PRR-004: without the snapshot release every completed setup stayed
			// immortal in the owner registry), and the ctx→owner binding (review
			// PRR-003). Ambient/other-owner entries are untouched (owner
			// isolation).
			registerV2ConfigRebuildSourceForOwner(ownerToken, undefined);
			setV2OperatorQuietForOwner(ownerToken, undefined);
			clearV2OwnerRegistrationSnapshot(ownerToken);
			clearV2CtxOwnerBinding(ctx);
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
	} catch (err) {
		// #PRR-017 (swarm-pr-review pr3444-20261025): a REJECTED setup must not
		// leak this instance's owner state — the cleanup closure above never
		// exists on this path, so the owner-scoped unregistration runs here
		// (all sync; no awaits in the catch). The throw propagates to the v2
		// host unchanged (it skips the plugin after the FATAL stderr line).
		registerV2ConfigRebuildSourceForOwner(ownerToken, undefined);
		setV2OperatorQuietForOwner(ownerToken, undefined);
		clearV2OwnerRegistrationSnapshot(ownerToken);
		clearV2AgentTransformSurface(ownerToken);
		clearV2CtxOwnerBinding(ctx);
		throw err;
	}
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
	// #3320: a v2 seeding event is a PRIMARY-owner observation for the session
	// (the recorder ignores swarm subagent names on its own).
	recordPrimaryOwner(sessionID, agentName);
	try {
		const session = ensureAgentSession(sessionID, agentName, directory);
		session.lastAgentEventTime = Date.now();
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
