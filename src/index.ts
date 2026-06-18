import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '@opencode-ai/plugin';
import packageJson from '../package.json' with { type: 'json' };
import { type AgentDefinition, createAgents, getAgentConfigs } from './agents';
import { parseSoundingBoardResponse } from './agents/critic.js';
import {
	type AutomationStatusArtifact,
	type BackgroundAutomationManager,
	createAutomationManager,
	PlanSyncWorker,
	type PreflightTriggerManager,
	PrMonitorWorker,
} from './background';
import { createBackgroundCompletionObserver } from './background/completion-observer.js';
import {
	listActive as listActiveSubscriptions,
	setOnSubscriptionCreated,
} from './background/pr-subscriptions';
import {
	agentHasSwarmCommandTool,
	createSwarmCommandHandler,
} from './commands';
import { COMMAND_REGISTRY, VALID_COMMANDS } from './commands/registry.js';
import { loadPluginConfigWithMetaAsync } from './config';
import { syncBundledProjectSkillsIfMissingAsync } from './config/bundled-skills.js';
import { DEFAULT_MODELS, ORCHESTRATOR_NAME } from './config/constants';
import {
	writeProjectConfigIfNew,
	writeSwarmConfigExampleIfNew,
} from './config/project-init';
import {
	AuthorityConfigSchema,
	AutomationConfigSchema,
	AutoReviewConfigSchema,
	GuardrailsConfigSchema,
	KnowledgeApplicationConfigSchema,
	KnowledgeConfigSchema,
	PrMonitorConfigSchema,
	PrmConfigSchema,
	SelfReviewConfigSchema,
	SkillImproverConfigSchema,
	SkillPropagationConfigSchema,
	SummaryConfigSchema,
	stripKnownSwarmPrefix,
	WatchdogConfigSchema,
} from './config/schema';
import { updateContextMapAfterAgent } from './context-map/post-agent-update.js';
import { tickAndMaybeDispatchCadence } from './full-auto/cadence.js';
import {
	composeHandlers,
	consolidateSystemMessages,
	createAgentActivityHooks,
	createCompactionCustomizerHook,
	createContextBudgetHandler,
	createCuratorLLMDelegate,
	createDelegationGateHook,
	createDelegationSanitizerHook,
	createDelegationTrackerHook,
	createFullAutoInterceptHook,
	createGuardrailsHooks,
	createPhaseMonitorHook,
	createPipelineTrackerHook,
	createRepoGraphBuilderHook,
	createSystemEnhancerHook,
	createToolSummarizerHook,
	safeHook,
} from './hooks';
import {
	detectAdversarialPatterns,
	detectDebuggingSpiral,
	handleDebuggingSpiral,
	recordToolCall,
} from './hooks/adversarial-detector.js';
import { createAutoReviewHook } from './hooks/auto-review.js';
import { createCcCommandInterceptHook } from './hooks/cc-command-intercept.js';
import { createCoChangeSuggesterHook } from './hooks/co-change-suggester.js';
import { createContextCapsuleInjectHook } from './hooks/context-capsule-inject.js';
import { createDarkMatterDetectorHook } from './hooks/dark-matter-detector.js';
import { collectDelegateAcksAfter } from './hooks/delegate-ack-collector.js';
import { injectDelegateDirectivesBefore } from './hooks/delegate-directive-injection.js';
import { createDelegationLedgerHook } from './hooks/delegation-ledger.js';
import { createFullAutoDelegationHook } from './hooks/full-auto-delegation.js';
import { createFullAutoInputProbeHook } from './hooks/full-auto-input-probe.js';
import { createFullAutoPermissionHook } from './hooks/full-auto-permission.js';
import { deleteStoredInputArgs } from './hooks/guardrails.js';
import { createHivePromoterHook } from './hooks/hive-promoter.js';
import { createIncrementalVerifyHook } from './hooks/incremental-verify';
import {
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
} from './hooks/knowledge-application-gate.js';
import { createKnowledgeCuratorHook } from './hooks/knowledge-curator.js';
import { createKnowledgeInjectorHook } from './hooks/knowledge-injector.js';
import { microReflectorAfter } from './hooks/micro-reflector.js';
import { normalizeToolName } from './hooks/normalize-tool-name';
import { collectReviewerReceiptAfter } from './hooks/review-receipt-collector.js';
import { collectReviewerVerdictsAfter } from './hooks/reviewer-verdict-parser.js';
import { createScopeGuardHook } from './hooks/scope-guard.js';
import { createSelfReviewHook } from './hooks/self-review.js';
import {
	parseDelegationArgs,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
} from './hooks/skill-propagation-gate.js';
import { readSkillMetadata } from './hooks/skill-scoring.js';
import { appendSkillUsageEntry } from './hooks/skill-usage-log.js';
import { createSlopDetectorHook } from './hooks/slop-detector';
import { createSteeringConsumedHook } from './hooks/steering-consumed.js';
import { createTrajectoryLoggerHook } from './hooks/trajectory-logger';
import { createMemoryLifecycleHooks } from './memory';
import { createPrmHook } from './prm';
import { createCompactionService } from './services/compaction-service';
import { shouldRunOnStartup } from './services/config-doctor';
import { scheduleVersionCheck } from './services/version-check.js';
import { loadSnapshot } from './session/snapshot-reader.js';
import { createSnapshotWriterHook } from './session/snapshot-writer.js';
import { ensureAgentSession, swarmState } from './state';
import { initTelemetry, telemetry } from './telemetry';
import { buildPluginToolObject } from './tools/plugin-registration';
import { error, log, warn } from './utils';
import {
	ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS,
	ensureSwarmGitExcluded,
} from './utils/gitignore-warning';
import { withTimeout } from './utils/timeout';
import { truncateToolOutput } from './utils/tool-output';

/**
 * OpenCode Swarm Plugin
 *
 * Architect-centric agentic swarm for code generation.
 * Hub-and-spoke architecture with:
 * - Architect as central orchestrator
 * - Dynamic SME consultation (serial)
 * - Code generation with QA review
 * - Iterative refinement with triage
 */
// Heartbeat throttle map: sessionId -> last heartbeat timestamp
const _heartbeatTimers = new Map<string, number>();

import {
	addDeferredWarning,
	clearDeferredWarnings,
} from './services/warning-buffer.js';

const SWARM_COMMAND_SYSTEM_RULE_TAG = '[opencode-swarm:swarm-command-rule]';
const PACKAGE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
// Upper bound for the DEFERRED bundled-skill materialization. The sync runs in a
// queueMicrotask off the server()-resolution path, so this ceiling does not count
// toward init latency (Invariant 1); it only protects the background task from
// running unboundedly. The copy is missing-only and bounded to ≤64 small files
// (<512KB total), so it completes in single-digit ms on a healthy FS and is a
// no-op after first run. The generous 2s ceiling is belt-and-suspenders for
// pathological filesystems (antivirus interception, NFS stalls) — on timeout we
// fail open and the command-path sync remains a backstop.
const SYNC_BUNDLED_SKILLS_TIMEOUT_MS = 2_000;

function createSwarmCommandSystemRuleHook(
	agentDefinitions: Record<string, AgentDefinition>,
	registeredAgents: Record<string, { tools?: Record<string, boolean> }>,
): (input: unknown, output: { system?: string[] }) => Promise<void> {
	return async (input, output) => {
		const { sessionID } = input as { sessionID?: string };
		const activeAgentName = sessionID
			? swarmState.activeAgent.get(sessionID)
			: undefined;
		if (
			!agentHasSwarmCommandTool(
				activeAgentName,
				agentDefinitions,
				registeredAgents,
			)
		) {
			return;
		}

		const system = Array.isArray(output.system) ? output.system : [];
		if (system.some((entry) => entry.includes(SWARM_COMMAND_SYSTEM_RULE_TAG))) {
			output.system = system;
			return;
		}

		system.push(
			[
				SWARM_COMMAND_SYSTEM_RULE_TAG,
				'When a user asks for a supported /swarm command and the message instructs you to call the `swarm_command` tool, call that tool exactly once with the provided JSON arguments. After the tool returns, show the tool output verbatim and do not add extra swarm state, summaries, or invented command output.',
			].join('\n'),
		);
		output.system = system;
	};
}

const OpenCodeSwarm: Plugin = async (ctx) => {
	try {
		return await initializeOpenCodeSwarm(ctx);
	} catch (err) {
		// OpenCode's plugin loader silently drops plugins whose entry rejects,
		// leaving the user staring at "in plugins" with no commands/agents and no
		// visible error (issue #675). Surface init failures to stderr so the real
		// cause is visible, then re-throw so the host still observes the rejection.
		const stack =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(
			'[opencode-swarm] FATAL: plugin initialization failed. Plugin will not be available.',
		);
		console.error(stack);
		throw err;
	}
};

// Return type intentionally inferred so the literal `{ name: ..., agent: ... }`
// does not trip excess-property checks against `Hooks`. The wrapper above is
// typed as `Plugin`, which validates the structural shape at the call site.
async function initializeOpenCodeSwarm(ctx: Parameters<Plugin>[0]) {
	const { config, loadedFromFile } = await loadPluginConfigWithMetaAsync(
		ctx.directory,
	);

	// Clear deferred warnings at session start for per-session isolation
	clearDeferredWarnings();

	// Full-auto mode validation: critic model must differ from architect model
	if (config.full_auto?.enabled === true) {
		// Resolve critic model (full_auto.critic_model override takes precedence,
		// then config.agents.critic.model, then DEFAULT_MODELS.critic)
		const criticModel =
			config.full_auto.critic_model ??
			config.agents?.critic?.model ??
			DEFAULT_MODELS.critic;

		// Resolve architect model (config.agents.architect.model takes precedence,
		// then DEFAULT_MODELS.default)
		const architectModel =
			config.agents?.architect?.model ?? DEFAULT_MODELS.default;

		if (criticModel === architectModel) {
			const warning =
				'[opencode-swarm] Full-auto mode warning: critic model matches architect model. Model validation is advisory-only; full-auto remains enabled. (Runtime architect model is determined by the orchestrator)';
			if (!config.quiet) {
				console.warn(warning);
			} else {
				addDeferredWarning(warning);
			}
		}
	}

	// Warn once about agents with custom models but no fallback_models configured.
	// Collect all violating agents across top-level agents and all swarms, then
	// emit a single consolidated message so the TUI is not spammed per-agent.
	// Note: fallback_models:[] is treated as "no fallback" — an empty array provides
	// no runtime protection (resolveFallbackModel returns null for length === 0).
	{
		const noFallback: string[] = [];
		const hasNoFallback = (cfg: {
			model?: string;
			fallback_models?: string[];
		}) =>
			cfg.model && (!cfg.fallback_models || cfg.fallback_models.length === 0);

		if (config.agents) {
			for (const [name, cfg] of Object.entries(config.agents)) {
				if (hasNoFallback(cfg)) noFallback.push(`${name}(${cfg.model})`);
			}
		}
		if (config.swarms) {
			for (const [swarmId, swarm] of Object.entries(config.swarms)) {
				if (swarm.agents) {
					for (const [name, cfg] of Object.entries(swarm.agents)) {
						if (hasNoFallback(cfg))
							noFallback.push(`${swarmId}/${name}(${cfg.model})`);
					}
				}
			}
		}
		if (noFallback.length > 0) {
			const msg =
				`[opencode-swarm] WARNING: ${noFallback.length} agent(s) use a custom model without fallback_models: ` +
				noFallback.join(', ') +
				'. Add "fallback_models": ["model-a"] to each agent config for reliability.';
			if (!config.quiet) {
				console.warn(msg);
			} else {
				addDeferredWarning(msg);
			}
		}
	}

	// Track whether full-auto mode is enabled in config
	swarmState.fullAutoEnabledInConfig = config.full_auto?.enabled === true;

	// Store SDK client for curator LLM delegation
	swarmState.opencodeClient = ctx.client;

	// v6.18 Session persistence — restore state from previous session.
	// Bounded with a 5s timeout (issue #704): `loadSnapshot` is read-only, so
	// timing out is safe — it only affects rehydration, not durable state. A
	// slow filesystem (network home, iCloud-backed mount) must never block
	// the plugin host's `await server(...)` indefinitely.
	await withTimeout(
		loadSnapshot(ctx.directory),
		5_000,
		new Error(
			'loadSnapshot exceeded 5s budget; continuing without snapshot rehydration',
		),
	).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		log('loadSnapshot timed out or failed (non-fatal)', { error: msg });
	});

	// Construct the repo-graph hook before any other side-task so we can
	// dispatch its scan deferred to the next macrotask. Issue #704: the
	// previous code invoked `repoGraphHook.init()` inline; because async
	// function bodies execute synchronously up to the first `await`, the
	// inline call blocked the event loop on the recursive workspace scan.
	// The fix is twofold: (a) `init()` itself yields before doing any work
	// and uses an async chunked walker; (b) we still dispatch the call via
	// `queueMicrotask` and bound it with an unref'd 30s watchdog.
	// Ensure .swarm/ exists before repo graph init tries to save the first graph.
	initTelemetry(ctx.directory);

	const repoGraphHook = createRepoGraphBuilderHook(ctx.directory);
	queueMicrotask(() => {
		const watchdog = setTimeout(() => {
			log(
				'[repo-graph] init exceeded 30s budget; scan will continue but is overdue',
			);
		}, 30_000);
		if (typeof (watchdog as { unref?: () => void }).unref === 'function') {
			(watchdog as { unref: () => void }).unref();
		}
		repoGraphHook
			.init()
			.catch(() => {
				/* logged inside init */
			})
			.finally(() => clearTimeout(watchdog));
	});

	// Protect .swarm/ from Git before any write. Uses git CLI so worktrees and
	// submodules (where .git is a file, not a directory) are handled correctly.
	// The await is intentional: the exclude write should complete before the
	// writes below create .swarm/ artifacts. The git subprocess calls finish in
	// <50ms on a healthy host.
	//
	// HARD-BOUNDED via withTimeout because the OpenCode plugin host silently
	// drops a plugin whose entry never resolves (issue #704). On a pathological
	// host (antivirus interception, credential helper prompt, NFS-stalled .git,
	// Bun-on-Windows stdin pipe semantics) this call could otherwise block
	// plugin init forever and produce the symptom "no agents in TUI/GUI".
	// On timeout we fail open: log non-fatal and let init continue.
	// The repoGraphHook.init() above is queued via queueMicrotask and begins
	// its async workspace scan during this await; writes .swarm/repo-graph.json
	// only after a slow directory traversal — in practice the exclude write
	// completes first. This ordering gap is accepted as non-critical.
	await withTimeout(
		ensureSwarmGitExcluded(ctx.directory, { quiet: config.quiet }),
		ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS,
		new Error(
			`ensureSwarmGitExcluded exceeded ${ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS}ms budget; continuing without git-hygiene check`,
		),
	).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		log('ensureSwarmGitExcluded timed out or failed (non-fatal)', {
			error: msg,
		});
	});

	// Side tasks are small and scoped to `<ctx.directory>/.swarm/`
	// or `<ctx.directory>/.opencode/`, so none risks a home-tree scan.
	writeSwarmConfigExampleIfNew(ctx.directory);
	writeProjectConfigIfNew(ctx.directory, config.quiet);
	// Materialize the bundled architect MODE skills into the project so the
	// architect's first auto-entered mode (e.g. SPECIFY on a fresh project) can
	// load its `.opencode/skills/<mode>/SKILL.md` without first running a /swarm
	// command and restarting the session. Previously these were synced ONLY as a
	// side effect of a subset of /swarm commands (commands/registry.ts), so a
	// brand-new project's architect hit missing skill files on turn one and a
	// weaker model would hallucinate the workflow instead of executing it.
	//
	// DEFERRED via queueMicrotask (NOT awaited on the server()-resolution path)
	// per Invariant 1 / Issue #704 — see the repoGraphHook precedent above. The
	// sync touches up to 20 skill directories; awaiting it inline added cold-FS
	// latency that pushed server() past the 400ms repro-704 T1 deadline on
	// Windows. Deferring keeps server() fast: the sync starts on the next
	// microtask, runs in the background, and completes long before the architect
	// reads any SKILL.md at runtime (the user must send a turn first). It is
	// still HARD-BOUNDED + fail-open: the async variant yields between files so
	// withTimeout (which unref's its timer) can bound it; missing-only,
	// never-overwrite, symlink-guarded, byte/file-bounded. On timeout/error we
	// fail open — the command-path sync remains as a backstop.
	queueMicrotask(() => {
		void withTimeout(
			syncBundledProjectSkillsIfMissingAsync(
				ctx.directory,
				PACKAGE_ROOT,
				config.quiet,
			),
			SYNC_BUNDLED_SKILLS_TIMEOUT_MS,
			new Error(
				`syncBundledProjectSkillsIfMissingAsync exceeded ${SYNC_BUNDLED_SKILLS_TIMEOUT_MS}ms budget; continuing without skill materialization (command-path sync remains a backstop)`,
			),
		).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			log('bundled skill materialization timed out or failed (non-fatal)', {
				error: msg,
			});
		});
	});
	// Background staleness check against npm. Detached, never blocks init,
	// throttled to 24h on disk. See services/version-check.ts (issue #675).
	if (config.version_check !== false) {
		scheduleVersionCheck(packageJson.version, (msg) => {
			if (config.quiet) {
				addDeferredWarning(msg);
			} else {
				console.warn(msg);
			}
		});
	}
	// Phase 4b: resolve language-agnostic project context for agent prompt
	// substitution. Bounded to 300ms and fails open with `null` (the agent
	// prompts then ship with `unresolved (run /swarm preflight)` sentinels
	// that the architect's existing DISCOVER mode picks up). Per Invariant 1
	// (plugin init bounded + fail-open) — see ENSURE_SWARM_GIT_EXCLUDED
	// precedent at line 342 above.
	//
	// 300ms budget chosen to keep total `server()` time under the 400ms
	// Issue #704 / repro-704.mjs T1 deadline. `buildProjectContext` itself
	// does NOT spawn subprocesses (see module docstring); typical runtime
	// is <20ms on Linux/macOS and <100ms on Windows with cold FS. The
	// timeout is belt-and-suspenders for pathological filesystems
	// (antivirus interception, NFS stalls). A failed-open `null` projectContext
	// is the same as no detection — placeholders resolve to the sentinel.
	const projectContext = await withTimeout(
		(async () => {
			const mod = await import('./agents/project-context');
			return mod.buildProjectContext(ctx.directory);
		})(),
		300, // LANG_BACKEND_DETECTION_TIMEOUT_MS — see project-context.ts
		new Error(
			'language-backend detection exceeded 300ms; ' +
				'continuing with unresolved sentinels',
		),
	).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		log('language-backend detection timed out or failed (non-fatal)', {
			error: msg,
		});
		return null;
	});

	const agents = getAgentConfigs(
		config,
		ctx.directory,
		undefined,
		projectContext ?? undefined,
	);
	const agentDefinitions = createAgents(config, projectContext ?? undefined);
	const agentDefinitionMap = Object.fromEntries(
		agentDefinitions.map((agent) => [agent.name, agent]),
	);

	// Collect all registered curator agent names across all swarms.
	// The factory resolves the correct name at call time by matching the active
	// session's agent prefix — so multi-swarm deployments each get their own curator.
	swarmState.curatorInitAgentNames = Object.keys(agents).filter(
		(k) => k === 'curator_init' || k.endsWith('_curator_init'),
	);
	swarmState.curatorPhaseAgentNames = Object.keys(agents).filter(
		(k) => k === 'curator_phase' || k.endsWith('_curator_phase'),
	);
	swarmState.curatorPostmortemAgentNames = Object.keys(agents).filter(
		(k) => k === 'curator_postmortem' || k.endsWith('_curator_postmortem'),
	);
	// v2: skill_improver and spec_writer agent registries — same multi-swarm
	// resolution pattern as curator. Used by skill-improver-llm-factory to
	// pick the right prefixed agent under named swarms.
	swarmState.skillImproverAgentNames = Object.keys(agents).filter(
		(k) => k === 'skill_improver' || k.endsWith('_skill_improver'),
	);
	swarmState.specWriterAgentNames = Object.keys(agents).filter(
		(k) => k === 'spec_writer' || k.endsWith('_spec_writer'),
	);
	// Populate the generated-agent registry used by Full-Auto v2's strict
	// canonical-role extraction (resolveGeneratedAgentRole). Without this,
	// user-supplied prose like `not_an_architect` could collapse to
	// `architect` via suffix-only matching and slip past the delegation
	// guard (adversarial review C1 fix).
	swarmState.generatedAgentNames = Object.keys(agents);

	const pipelineHook = createPipelineTrackerHook(config, ctx.directory);
	const systemEnhancerHook = createSystemEnhancerHook(config, ctx.directory);
	const contextCapsuleInjectHook = createContextCapsuleInjectHook(
		config,
		ctx.directory,
	);
	const compactionHook = createCompactionCustomizerHook(config, ctx.directory);
	const contextBudgetHandler = createContextBudgetHandler(config);
	const commandHandler = createSwarmCommandHandler(
		ctx.directory,
		agentDefinitionMap,
		{
			getActiveAgentName: (sessionID) => swarmState.activeAgent.get(sessionID),
			packageRoot: PACKAGE_ROOT,
			registeredAgents: agents,
		},
	);
	const swarmCommandSystemRuleHook = createSwarmCommandSystemRuleHook(
		agentDefinitionMap,
		agents,
	);
	const activityHooks = createAgentActivityHooks(config, ctx.directory);
	const prmHook = createPrmHook(
		config.prm ?? PrmConfigSchema.parse({}),
		ctx.directory,
	);
	const trajectoryLoggerHook = createTrajectoryLoggerHook(
		{
			enabled: true,
			max_lines: 1000,
		},
		ctx.directory,
	);
	const delegationGateHooks = createDelegationGateHook(config, ctx.directory);
	// Issue #1151 PR 2 (Stage A): read-only observer for the background-subagent
	// completion signal. No-op unless hooks.background_subagents is opted in.
	const backgroundCompletionObserver = createBackgroundCompletionObserver({
		config: {
			enabled:
				(config.hooks as Record<string, unknown> | undefined)
					?.background_subagents === true,
		},
		directory: ctx.directory,
	});
	const delegationSanitizerHook = createDelegationSanitizerHook(ctx.directory);
	const memoryLifecycleHooks = createMemoryLifecycleHooks({
		directory: ctx.directory,
		config: config.memory,
		getActiveAgentName: (sessionID) =>
			sessionID ? swarmState.activeAgent.get(sessionID) : undefined,
	});
	// Fail-secure: honor explicit guardrails.enabled === false (preserving the full
	// guardrails block), otherwise let Zod schema defaults fill in enabled: true.
	const guardrailsFallback =
		config.guardrails?.enabled === false
			? { ...config.guardrails, enabled: false }
			: (config.guardrails ?? {});
	const guardrailsConfig = GuardrailsConfigSchema.parse(guardrailsFallback);

	// SECURITY AUDIT: Emit explicit warning when guardrails are disabled via user config
	// This is a security-relevant action that requires explicit acknowledgment
	// Warnings are emitted via debug logger only (OPENCODE_SWARM_DEBUG=1) to prevent
	// TUI corruption. Users can enable debug mode to see the full warning.
	if (loadedFromFile && guardrailsConfig.enabled === false) {
		warn('');
		warn('══════════════════════════════════════════════════════════════');
		warn('[opencode-swarm] 🔴 SECURITY WARNING: GUARDRAILS ARE DISABLED');
		warn('══════════════════════════════════════════════════════════════');
		warn('Guardrails have been explicitly disabled in user configuration.');
		warn('This disables safety measures including:');
		warn('  - Tool call limits');
		warn('  - Duration limits');
		warn('  - Repetition detection');
		warn('  - Error rate limits');
		warn('  - Idle timeouts');
		warn('');
		warn(
			'Only disable guardrails if you fully understand the security implications.',
		);
		warn(
			'To re-enable guardrails, set "guardrails.enabled" to true in your config.',
		);
		warn('══════════════════════════════════════════════════════════════');
		warn('');
	}

	const delegationHandler = createDelegationTrackerHook(
		config,
		guardrailsConfig.enabled,
	);
	const authorityConfig = AuthorityConfigSchema.parse(config.authority ?? {});
	const guardrailsHooks = createGuardrailsHooks(
		ctx.directory,
		undefined,
		guardrailsConfig,
		authorityConfig,
	);

	// Full-auto intercept: autonomous oversight when full-auto mode is active
	const fullAutoInterceptHook = createFullAutoInterceptHook(
		config,
		ctx.directory,
	);

	// Full-Auto v2 hooks: permission, input-probe, delegation. Always armed
	// (first-class toggle); each gates at runtime on the durable per-session
	// run state, so they no-op for sessions that never ran
	// `/swarm full-auto on`. Hook ordering (tool.execute.before):
	//   1. guardrails (existing)
	//   2. scope-guard (existing)
	//   3. delegation-gate (existing)
	//   4. full-auto-permission (NEW — adds an additional decision layer)
	//   5. full-auto-delegation outbound (NEW — Task tool only)
	// Hook ordering (tool.execute.after):
	//   - full-auto-input-probe runs after guardrails/delegation-gate so it can
	//     observe tool output AFTER existing safety has cleaned it up.
	//   - full-auto-delegation return check runs alongside.
	const fullAutoPermissionHook = createFullAutoPermissionHook({
		config,
		directory: ctx.directory,
	});
	const fullAutoInputProbeHook = createFullAutoInputProbeHook({
		config,
		directory: ctx.directory,
	});
	const fullAutoDelegationHook = createFullAutoDelegationHook({
		config,
		directory: ctx.directory,
	});

	// CC command intercept: handle Claude Code command interception
	const ccCommandInterceptHook = createCcCommandInterceptHook({});

	// Watchdog: scope-guard + delegation-ledger
	const watchdogConfig = WatchdogConfigSchema.parse(config.watchdog ?? {});
	const advisoryInjector = (sessionId: string, message: string) => {
		const s = swarmState.agentSessions.get(sessionId);
		if (s) {
			s.pendingAdvisoryMessages ??= [];
			s.pendingAdvisoryMessages.push(message);
		}
	};

	const scopeGuardHook = createScopeGuardHook(
		{
			enabled: watchdogConfig.scope_guard,
			skip_in_turbo: watchdogConfig.skip_in_turbo,
		},
		ctx.directory,
		advisoryInjector,
	);

	const delegationLedgerHook = createDelegationLedgerHook(
		{ enabled: watchdogConfig.delegation_ledger },
		ctx.directory,
		advisoryInjector,
	);

	// Self-review advisory hook
	const selfReviewConfig = SelfReviewConfigSchema.parse(
		config.self_review ?? {},
	);
	const selfReviewHook = createSelfReviewHook(
		{
			enabled: selfReviewConfig.enabled,
			skip_in_turbo: selfReviewConfig.skip_in_turbo,
		},
		advisoryInjector,
	);

	// Auto-review hook (opt-in): dispatches the reviewer agent over an
	// ephemeral session to review the execution diff at task/phase
	// boundaries. Advisory + fire-and-forget — never blocks a tool call.
	const autoReviewHook = createAutoReviewHook({
		config: AutoReviewConfigSchema.parse(config.auto_review ?? {}),
		directory: ctx.directory,
		injectAdvisory: advisoryInjector,
	});

	const summaryConfig = SummaryConfigSchema.parse(config.summaries ?? {});
	const toolSummarizerHook = createToolSummarizerHook(
		summaryConfig,
		ctx.directory,
	);

	// v6.17 Knowledge system hooks — fire-and-forget, wrapped in safeHook
	const knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
	const skillImproverConfig = SkillImproverConfigSchema.parse(
		config.skill_improver ?? {},
	);
	const skillPropagationConfig = SkillPropagationConfigSchema.parse(
		config.skillPropagation ?? {},
	);
	if (
		skillImproverConfig.enabled &&
		skillImproverConfig.trigger === 'scheduled'
	) {
		queueMicrotask(() => {
			import('./services/skill-consolidation.js')
				.then(({ runSkillConsolidationFireAndForget }) => {
					runSkillConsolidationFireAndForget(
						{
							directory: ctx.directory,
							config: skillImproverConfig,
							source: 'startup',
							enrichmentQuota: {
								maxCalls: knowledgeConfig.enrichment.max_calls_per_day,
								window: knowledgeConfig.enrichment.quota_window,
							},
							evaluateDrafts: true,
						},
						undefined,
						(err) => {
							const msg = err instanceof Error ? err.message : String(err);
							log('scheduled skill consolidation failed (non-fatal)', {
								error: msg,
							});
						},
					);
				})
				.catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					log('failed to schedule skill consolidation (non-fatal)', {
						error: msg,
					});
				});
		});
	}
	// skill_improver keeps its own proposal quota; curator/micro-reflector
	// enrichment uses knowledge.enrichment below.
	const knowledgeCuratorHook = knowledgeConfig.enabled
		? createKnowledgeCuratorHook(ctx.directory, knowledgeConfig, {
				llmDelegateFactory: (sessionID) =>
					createCuratorLLMDelegate(ctx.directory, 'phase', sessionID),
				enrichmentQuota: {
					maxCalls: knowledgeConfig.enrichment.max_calls_per_day,
					window: knowledgeConfig.enrichment.quota_window,
				},
			})
		: undefined;
	const hivePromoterHook =
		knowledgeConfig.enabled && knowledgeConfig.hive_enabled
			? createHivePromoterHook(ctx.directory, knowledgeConfig)
			: undefined;
	const knowledgeInjectorHook = knowledgeConfig.enabled
		? createKnowledgeInjectorHook(
				ctx.directory,
				knowledgeConfig,
				config.context_budget?.model_limits ?? {},
			)
		: undefined;

	// v6.18 Steering acknowledgment hook — auto-acknowledges unconsumed steering directives
	const steeringConsumedHook = createSteeringConsumedHook(ctx.directory);

	// v6.18 Agent intelligence hooks — co-change suggestions and dark-matter gap detection
	const coChangeSuggesterHook = createCoChangeSuggesterHook(ctx.directory);
	const darkMatterDetectorHook = createDarkMatterDetectorHook(ctx.directory);
	const slopDetectorHook =
		config.slop_detector?.enabled !== false
			? createSlopDetectorHook(
					config.slop_detector ?? {
						enabled: true,
						classThreshold: 3,
						commentStripThreshold: 5,
						diffLineThreshold: 200,
						importHygieneThreshold: 2,
					},
					ctx.directory,
					(sessionId, message) => {
						const s = swarmState.agentSessions.get(sessionId);
						if (s) {
							s.pendingAdvisoryMessages ??= [];
							s.pendingAdvisoryMessages.push(message);
						}
					},
				)
			: null;
	const incrementalVerifyHook =
		config.incremental_verify?.enabled !== false
			? createIncrementalVerifyHook(
					config.incremental_verify ?? {
						enabled: true,
						command: null,
						timeoutMs: 30000,
						triggerAgents: ['coder'],
					},
					ctx.directory,
					(sessionId, message) => {
						const s = swarmState.agentSessions.get(sessionId);
						if (s) {
							s.pendingAdvisoryMessages ??= [];
							s.pendingAdvisoryMessages.push(message);
						}
					},
				)
			: null;
	const compactionServiceHook =
		config.compaction_service?.enabled !== false
			? createCompactionService(
					config.compaction_service ?? {
						enabled: true,
						observationThreshold: 40,
						reflectionThreshold: 60,
						emergencyThreshold: 80,
						preserveLastNTurns: 5,
					},
					ctx.directory,
					(sessionId, message) => {
						const s = swarmState.agentSessions.get(sessionId);
						if (s) {
							s.pendingAdvisoryMessages ??= [];
							s.pendingAdvisoryMessages.push(message);
						}
					},
				)
			: null;
	// v6.18 Session persistence — write state snapshot after each tool call
	const snapshotWriterHook = createSnapshotWriterHook(ctx.directory);

	// Parse automation config (v6.7 feature flags)
	// Read flags without activating - scaffold only for now
	const automationConfig = AutomationConfigSchema.parse(
		config.automation ?? {},
	);

	// Initialize background automation framework (scaffold only - no business features yet)
	// Only enabled when automation mode is not 'manual' (default-off behavior)
	let automationManager: BackgroundAutomationManager | undefined;
	let preflightTriggerManager: PreflightTriggerManager | undefined;
	let statusArtifact: AutomationStatusArtifact | undefined;
	let prMonitorWorker: PrMonitorWorker | null = null;

	if (automationConfig.mode !== 'manual') {
		automationManager = createAutomationManager(automationConfig);
		automationManager.start();

		// v6.7 Task 5.5: Initialize trigger manager (plumbing only, no preflight logic yet)
		const { PreflightTriggerManager: PTM } = await import(
			'./background/trigger'
		);
		preflightTriggerManager = new PTM(automationConfig);

		// v6.7 Task 5.5: Initialize status artifact for GUI visibility
		const { AutomationStatusArtifact: ASA } = await import(
			'./background/status-artifact'
		);
		const swarmDir = path.resolve(ctx.directory, '.swarm');
		statusArtifact = new ASA(swarmDir);
		statusArtifact.updateConfig(
			automationConfig.mode,
			automationConfig.capabilities,
		);

		// v6.8 Task 1.1: Wire evidence summary integration
		if (automationConfig.capabilities?.evidence_auto_summaries === true) {
			const { createEvidenceSummaryIntegration } = await import(
				'./background/evidence-summary-integration'
			);
			createEvidenceSummaryIntegration({
				automationConfig,
				directory: ctx.directory,
				projectDir: ctx.directory,
				summaryFilename: 'evidence-summary.json',
			});
			log('Evidence summary integration initialized', {
				directory: ctx.directory,
			});
		}

		// v6.8 Task 2.2: Wire preflight integration
		if (automationConfig.capabilities?.phase_preflight === true) {
			const { createPreflightIntegration } = await import(
				'./services/preflight-integration'
			);
			try {
				const { manager } = createPreflightIntegration({
					automationConfig,
					directory: ctx.directory,
					swarmDir,
				});
				preflightTriggerManager = manager;
				log('Preflight integration initialized', { directory: ctx.directory });
			} catch (err) {
				log('Preflight integration failed to initialize (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// v6.8 Task 3.2: Wire PlanSyncWorker for plan.json -> plan.md sync
		if (automationConfig.capabilities?.plan_sync === true) {
			try {
				const planSyncWorker = new PlanSyncWorker({
					directory: ctx.directory,
					// Using defaults: debounceMs=300, pollIntervalMs=2000
				});
				planSyncWorker.start();
				log('PlanSyncWorker initialized', { directory: ctx.directory });
			} catch (err) {
				log('PlanSyncWorker failed to initialize (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		log('Automation framework initialized', {
			mode: automationConfig.mode,
			enabled: automationManager?.isEnabled(),
			running: automationManager?.isActive(),
			preflightEnabled: preflightTriggerManager?.isEnabled(),
		});
	}

	// PR Monitor Worker — starts when pr_monitor.enabled and subscriptions exist.
	// Worker creation is idempotent: first call creates, subsequent calls no-op.
	const prMonitorConfig = PrMonitorConfigSchema.parse(config.pr_monitor ?? {});

	function ensurePrMonitorWorkerRunning(directory: string): void {
		try {
			if (!prMonitorConfig.enabled) return;
			if (!prMonitorWorker) {
				prMonitorWorker = new PrMonitorWorker({
					directory,
					config: prMonitorConfig,
				});
			}
			if (!prMonitorWorker.isRunning()) {
				prMonitorWorker.start();
				log('PR Monitor Worker started', { directory });
			}
		} catch (err) {
			error('[pr-monitor] Worker failed to start (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Wire the lazy-start callback into the subscription store so the
	// worker starts automatically when a new PR is subscribed.
	setOnSubscriptionCreated((directory: string, _record) => {
		ensurePrMonitorWorkerRunning(directory);
	});

	// Register PR event subscribers for advisory delivery to active sessions
	let prEventCleanup: (() => void) | null = null;
	if (prMonitorConfig.enabled) {
		try {
			const { registerPrEventSubscribers } = await import(
				'./background/pr-event-subscribers'
			);
			prEventCleanup = registerPrEventSubscribers({
				directory: ctx.directory,
				config: prMonitorConfig,
			});
		} catch (err) {
			log('[pr-monitor] Failed to register PR event subscribers (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Startup scan: resume worker for existing subscriptions after plugin restart.
	// Deferred via queueMicrotask so setup() returns promptly (fail-open).
	if (prMonitorConfig.enabled) {
		queueMicrotask(() => {
			void listActiveSubscriptions(ctx.directory)
				.then((active) => {
					if (active.length > 0) {
						ensurePrMonitorWorkerRunning(ctx.directory);
					}
				})
				.catch((err) => {
					error('[pr-monitor] Startup scan failed (non-fatal)', {
						error: err instanceof Error ? err.message : String(err),
					});
				});
		});
	}

	// Cleanup: stop automation manager and workers on process exit
	const cleanupAutomation = () => {
		automationManager?.stop();
		prMonitorWorker?.stop();
		prEventCleanup?.();
	};
	process.on('exit', cleanupAutomation);
	process.once('SIGINT', () => {
		cleanupAutomation();
		process.exit(130);
	});
	process.once('SIGTERM', () => {
		cleanupAutomation();
		process.exit(143);
	});

	// v6.7 Task 5.7: Config Doctor - run on startup if automation flags permit
	// Runs in background-safe way (non-blocking, no errors propagate)
	// SECURITY: Default is scan-only (autoFix=false). Autofix requires explicit opt-in
	// via config_doctor_autofix capability.
	if (shouldRunOnStartup(automationConfig)) {
		// Autofix is opt-in only - requires explicit config_doctor_autofix capability
		const enableAutofix =
			automationConfig.capabilities?.config_doctor_autofix === true;

		// Dynamically import to avoid circular dependencies
		import('./services/config-doctor').then(({ runConfigDoctorWithFixes }) => {
			// Default to scan-only mode (autoFix=false) for security
			// Autofix only runs when explicitly enabled via capability
			runConfigDoctorWithFixes(ctx.directory, config, enableAutofix)
				.then((doctorResult) => {
					if (doctorResult.result.findings.length > 0) {
						log('Config Doctor ran on startup', {
							findings: doctorResult.result.findings.length,
							errors: doctorResult.result.summary.error,
							warnings: doctorResult.result.summary.warn,
							appliedFixes: doctorResult.appliedFixes.length,
							autofixEnabled: enableAutofix,
						});

						// Emit chat-visible advisory for auto-fixable findings.
						// Uses console.warn (always visible, non-blocking).
						// Wrapped in try/catch per AGENTS.md invariant #1 (fail-open).
						try {
							const autoFixableCount = doctorResult.result.findings.filter(
								(f) => f.autoFixable,
							).length;

							if (!enableAutofix && autoFixableCount > 0) {
								console.warn(
									`[opencode-swarm] Config Doctor found ${autoFixableCount} auto-fixable issue(s). Run /swarm config doctor --fix to apply.`,
								);
							} else if (
								enableAutofix &&
								doctorResult.appliedFixes.length > 0
							) {
								console.warn(
									`[opencode-swarm] Config Doctor applied ${doctorResult.appliedFixes.length} fix(es) automatically.`,
								);
							}
						} catch {
							// Advisory emission must never block startup
						}
					}
				})
				.catch((err) => {
					// Config doctor errors should NOT block startup
					log('Config Doctor error (non-fatal)', {
						error: err instanceof Error ? err.message : String(err),
					});
				});
		});
	}

	log('Plugin initialized', {
		maxIterations: config.max_iterations,
		agentCount: Object.keys(agents).length,
		hooks: {
			pipeline: !!pipelineHook['experimental.chat.messages.transform'],
			systemEnhancer:
				!!systemEnhancerHook['experimental.chat.system.transform'],
			compaction: !!compactionHook['experimental.session.compacting'],
			contextBudget: !!contextBudgetHandler,
			commands: true,
			agentActivity: config.hooks?.agent_activity !== false,
			delegationTracker: config.hooks?.delegation_tracker === true,
			guardrails: guardrailsConfig.enabled,
			toolSummarizer: summaryConfig.enabled,
			knowledge: knowledgeConfig.enabled,
		},
		// v6.7 automation flags (scaffold only - not yet active)
		automation: {
			mode: automationConfig.mode,
			capabilities: automationConfig.capabilities,
		},
	});

	return {
		name: 'opencode-swarm',

		// Register all agents
		agent: agents,

		// Register tools, respecting knowledge.enabled config
		tool: buildPluginToolObject(agentDefinitionMap, config),

		// Issue #1151 PR 2 (Stage A): observe the background-subagent completion signal.
		// ADVISORY/observer-only — safeHook-wrapped so it can never block event delivery or
		// plugin load. No-op unless hooks.background_subagents is opted in.
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		event: safeHook(backgroundCompletionObserver.event) as any,

		// Configure OpenCode - merge agents into config
		config: async (opencodeConfig: Record<string, unknown>) => {
			const isObjectRecord = (
				value: unknown,
			): value is Record<string, unknown> =>
				typeof value === 'object' && value !== null;
			const pluginConfig = opencodeConfig as Record<string, unknown> & {
				agent?: Record<string, unknown>;
			};

			// Normalize agent config to a plain object if it's absent or a non-object primitive
			if (!isObjectRecord(pluginConfig.agent)) {
				pluginConfig.agent = {};
			}
			const agentConfig = pluginConfig.agent;

			// Merge agent configs (don't override default_agent)
			Object.assign(agentConfig, agents);

			// Auto-select architect: disable competing built-in agents when enabled
			const autoSelect = config?.auto_select_architect;
			if (autoSelect) {
				// Check that at least one architect agent exists in the generated set
				const hasArchitect = Object.keys(agents).some(
					(name) => stripKnownSwarmPrefix(name) === 'architect',
				);
				if (hasArchitect) {
					// Disable build and plan built-in agents
					for (const builtin of ['build', 'plan'] as const) {
						const existing = agentConfig[builtin];
						if (isObjectRecord(existing) && existing.disable === true) {
							// User already disabled this agent — respect their override
							continue;
						}
						agentConfig[builtin] = {
							...(isObjectRecord(existing) ? existing : {}),
							disable: true,
						};
					}

					// Warn when boolean true and multiple architects are primary
					if (autoSelect === true) {
						const primaryArchitects = Object.entries(agents).filter(
							([name, cfg]) =>
								stripKnownSwarmPrefix(name) === 'architect' &&
								isObjectRecord(cfg) &&
								cfg.mode === 'primary',
						);
						if (primaryArchitects.length > 1) {
							const names = primaryArchitects.map(([n]) => n).join(', ');
							addDeferredWarning(
								`[swarm] auto_select_architect is true but ${primaryArchitects.length} architect agents are primary (${names}). Consider setting auto_select_architect to a specific agent name.`,
							);
						}
					}

					// When a specific architect name is provided, demote non-matching architects to subagent
					if (typeof autoSelect === 'string' && autoSelect !== '') {
						const targetName = autoSelect;
						// Only proceed if the target is actually an architect-role agent
						const targetIsArchitect =
							Object.hasOwn(agents, targetName) &&
							stripKnownSwarmPrefix(targetName) === 'architect';

						if (targetIsArchitect) {
							// Demote non-matching architects to subagent
							for (const [name, cfg] of Object.entries(agents)) {
								if (
									stripKnownSwarmPrefix(name) === 'architect' &&
									name !== targetName
								) {
									agentConfig[name] = {
										...(isObjectRecord(cfg) ? cfg : {}),
										mode: 'subagent',
									};
								}
							}
							// Promote the target architect to primary
							const targetExisting = agentConfig[targetName];
							const targetAgent = agents[targetName];
							agentConfig[targetName] = {
								...(isObjectRecord(targetExisting) ? targetExisting : {}),
								...(isObjectRecord(targetAgent) ? targetAgent : {}),
								mode: 'primary',
							};
						} else {
							// Target is not a valid architect — warn the user
							addDeferredWarning(
								`[swarm] auto_select_architect is set to "${targetName}" but that is not a known architect agent. No architect demotion applied.`,
							);
						}
					}
				} else {
					// No architect agents found — warn the user
					addDeferredWarning(
						'[swarm] auto_select_architect is enabled but no architect agents were found in the generated set. The option has no effect.',
					);
				}
			}

			// Register /swarm command
			// Build a model-facing shortcut description from the registry entry (SSOT — can't drift).
			const shortcutDescription = (cmd: string): string => {
				const entry = COMMAND_REGISTRY[cmd as keyof typeof COMMAND_REGISTRY] as
					| { description?: string }
					| undefined;
				if (!entry?.description) {
					return `Use /swarm ${cmd}`; // fallback if registry entry is somehow missing
				}
				const desc =
					entry.description.charAt(0).toLowerCase() +
					entry.description.slice(1);
				return `Use /swarm ${cmd} to ${desc}`;
			};
			opencodeConfig.command = {
				...((opencodeConfig.command as Record<string, unknown>) || {}),
				swarm: {
					// Template is required by OpenCode and always sent to the LLM.
					// Keep it minimal — instructional text confuses non-frontier models.
					// The actual command is handled by command.execute.before hook.
					template: '/swarm $ARGUMENTS',
					description: (() => {
						// Derive the command list from the registry (single source of truth).
						// Include standalone (non-alias, non-deprecated, non-subcommand) commands.
						const standaloneCommands = VALID_COMMANDS.filter((cmd) => {
							const entry = COMMAND_REGISTRY[
								cmd as keyof typeof COMMAND_REGISTRY
							] as {
								aliasOf?: string;
								deprecated?: boolean;
								subcommandOf?: string;
							};
							return !entry.aliasOf && !entry.deprecated && !entry.subcommandOf;
						});
						return `Swarm management commands: /swarm [${standaloneCommands.join('|')}]`;
					})(),
				},
				// Individual subcommands for discoverability by weaker models (Haiku-class)
				'swarm-status': {
					template: '/swarm status',
					description:
						'Use /swarm status to show current swarm status and active phase',
				},
				'swarm-show-plan': {
					template: '/swarm show-plan $ARGUMENTS',
					description:
						'Use /swarm show-plan to view or filter the current execution plan',
				},
				'swarm-plan': {
					template: '/swarm plan $ARGUMENTS',
					description: 'Deprecated alias for /swarm show-plan',
				},
				'swarm-agents': {
					template: '/swarm agents',
					description: 'Use /swarm agents to list registered swarm agents',
				},
				'swarm-history': {
					template: '/swarm history',
					description: 'Use /swarm history to show completed phases summary',
				},
				'swarm-config': {
					template: '/swarm config $ARGUMENTS',
					description: 'Use /swarm config to show or validate configuration',
				},
				'swarm-evidence': {
					template: '/swarm evidence $ARGUMENTS',
					description:
						'Use /swarm evidence to view evidence bundles and summaries',
				},
				'swarm-handoff': {
					template: '/swarm handoff',
					description:
						'Use /swarm handoff to prepare handoff brief for switching models mid-task',
				},
				'swarm-archive': {
					template: '/swarm archive',
					description: 'Use /swarm archive to archive old evidence bundles',
				},
				'swarm-diagnose': {
					template: '/swarm diagnose',
					description:
						'Use /swarm diagnose to run health checks on swarm state',
				},
				'swarm-diagnosis': {
					template: '/swarm diagnosis',
					description:
						'Use /swarm diagnosis to run health checks on swarm state',
				},
				'swarm-preflight': {
					template: '/swarm preflight',
					description:
						'Use /swarm preflight to run preflight automation checks',
				},
				'swarm-sync-plan': {
					template: '/swarm sync-plan',
					description: 'Use /swarm sync-plan to sync plan.json with plan.md',
				},
				'swarm-benchmark': {
					template: '/swarm benchmark',
					description: 'Use /swarm benchmark to show performance metrics',
				},
				'swarm-export': {
					template: '/swarm export',
					description: 'Use /swarm export to export plan and context as JSON',
				},
				'swarm-reset': {
					template: '/swarm reset --confirm',
					description:
						'Use /swarm reset --confirm to clear swarm state (requires --confirm)',
				},
				'swarm-rollback': {
					template: '/swarm rollback $ARGUMENTS',
					description:
						'Use /swarm rollback to restore swarm state to a checkpoint',
				},
				'swarm-retrieve': {
					template: '/swarm retrieve $ARGUMENTS',
					description:
						'Use /swarm retrieve to retrieve full output from summary',
				},
				'swarm-clarify': {
					template: '/swarm clarify $ARGUMENTS',
					description:
						'Use /swarm clarify to clarify and refine a feature specification',
				},
				'swarm-analyze': {
					template: '/swarm analyze',
					description:
						'Use /swarm analyze to analyze spec vs plan for coverage gaps',
				},
				'swarm-specify': {
					template: '/swarm specify $ARGUMENTS',
					description:
						'Use /swarm specify to generate or import a feature specification',
				},
				'swarm-brainstorm': {
					template: '/swarm brainstorm $ARGUMENTS',
					description:
						'Use /swarm brainstorm to enter the architect MODE: BRAINSTORM planning workflow',
				},
				'swarm-loop': {
					template: '/swarm loop $ARGUMENTS',
					description:
						'Use /swarm loop <objective> to run a compound-engineering loop: brainstorm → plan → build → review → improve, iterating until done [--max-cycles 1..5] [--autonomy checkpoint|auto] [--depth standard|exhaustive] [--resume]',
				},
				'swarm-council': {
					template: '/swarm council $ARGUMENTS',
					description:
						'Use /swarm council <question> to convene a multi-model General Council deliberation (generalist / skeptic / domain expert) [--preset <name>] [--spec-review]',
				},
				'swarm-pr-review': {
					template: '/swarm pr-review $ARGUMENTS',
					description:
						'Use /swarm pr-review to launch deep PR review with multi-lane analysis',
				},
				'swarm-pr-feedback': {
					template: '/swarm pr-feedback $ARGUMENTS',
					description:
						'Use /swarm pr-feedback to ingest and close known PR feedback (review comments, CI failures, conflicts) without a fresh broad review',
				},
				'swarm-pr-subscribe': {
					template: '/swarm pr subscribe $ARGUMENTS',
					description: shortcutDescription('pr subscribe'),
				},
				'swarm-pr-unsubscribe': {
					template: '/swarm pr unsubscribe $ARGUMENTS',
					description: shortcutDescription('pr unsubscribe'),
				},
				'swarm-pr-status': {
					template: '/swarm pr status',
					description: shortcutDescription('pr status'),
				},
				'swarm-learning': {
					template: '/swarm learning',
					description: shortcutDescription('learning'),
				},
				'swarm-post-mortem': {
					template: '/swarm post-mortem $ARGUMENTS',
					description: shortcutDescription('post-mortem'),
				},
				'swarm-deep-dive': {
					template: '/swarm deep-dive $ARGUMENTS',
					description:
						'Use /swarm deep-dive to launch a read-only deep audit with parallel explorer waves, dual reviewers, and critic challenge',
				},
				'swarm-deep-research': {
					template: '/swarm deep-research $ARGUMENTS',
					description:
						'Use /swarm deep-research <question> to run a multi-source, fact-checked deep research pass and synthesize a cited report [--depth standard|exhaustive] [--max-researchers 1..6] [--rounds 1..4] [--brief]',
				},
				'swarm-codebase-review': {
					template: '/swarm codebase-review $ARGUMENTS',
					description:
						'Use /swarm codebase-review to launch codebase-review-swarm for a quote-grounded full-repo or large-subsystem audit',
				},
				'swarm-design-docs': {
					template: '/swarm design-docs $ARGUMENTS',
					description:
						'Use /swarm design-docs to generate or sync language-agnostic design docs for the project under build',
				},
				'swarm-sdd': {
					template: '/swarm sdd $ARGUMENTS',
					description:
						'Use /swarm sdd to inspect OpenSpec-compatible SDD artifacts',
				},
				'swarm-sdd-status': {
					template: '/swarm sdd status',
					description:
						'Use /swarm sdd status to show effective spec and OpenSpec artifact status',
				},
				'swarm-sdd-validate': {
					template: '/swarm sdd validate $ARGUMENTS',
					description:
						'Use /swarm sdd validate to validate OpenSpec-compatible SDD artifacts',
				},
				'swarm-sdd-project': {
					template: '/swarm sdd project $ARGUMENTS',
					description:
						'Use /swarm sdd project to materialize OpenSpec artifacts into .swarm/spec.md',
				},
				'swarm-issue': {
					template: '/swarm issue $ARGUMENTS',
					description:
						'Use /swarm issue to ingest a GitHub issue into the swarm workflow',
				},
				'swarm-qa-gates': {
					template: '/swarm qa-gates $ARGUMENTS',
					description:
						'Use /swarm qa-gates to view or modify QA gate profile for the current plan',
				},
				'swarm-dark-matter': {
					template: '/swarm dark-matter',
					description: 'Use /swarm dark-matter to detect hidden file couplings',
				},
				'swarm-knowledge': {
					template: '/swarm knowledge $ARGUMENTS',
					description:
						'Use /swarm knowledge for knowledge management (quarantine/restore/migrate)',
				},
				'swarm-memory': {
					template: '/swarm memory $ARGUMENTS',
					description:
						'Use /swarm memory for memory status, JSONL export/import, and SQLite migration',
				},
				'swarm-memory-status': {
					template: '/swarm memory status',
					description:
						'Use /swarm memory status to show provider and migration status',
				},
				'swarm-memory-export': {
					template: '/swarm memory export',
					description:
						'Use /swarm memory export to write current memory to JSONL',
				},
				'swarm-memory-import': {
					template: '/swarm memory import',
					description:
						'Use /swarm memory import to import legacy JSONL into SQLite',
				},
				'swarm-memory-migrate': {
					template: '/swarm memory migrate',
					description:
						'Use /swarm memory migrate to run the one-time SQLite migration',
				},
				'swarm-curate': {
					template: '/swarm curate',
					description:
						'Use /swarm curate to curate knowledge artifacts and entries',
				},
				'swarm-consolidate': {
					template: '/swarm consolidate $ARGUMENTS',
					description:
						'Use /swarm consolidate to run quota-bounded skill-improver consolidation',
				},
				'swarm-concurrency': {
					template: '/swarm concurrency $ARGUMENTS',
					description:
						'Use /swarm concurrency to manage runtime concurrency override for plan execution',
				},
				'swarm-turbo': {
					template: '/swarm turbo',
					description:
						'Use /swarm turbo to enable turbo mode for faster execution',
				},
				'swarm-full-auto': {
					template: '/swarm full-auto $ARGUMENTS',
					description: 'Toggle Full-Auto Mode for the active session [on|off]',
				},
				'swarm-auto-proceed': {
					template: '/swarm auto-proceed $ARGUMENTS',
					description:
						'Toggle auto-proceed mode for automatic phase advancement',
				},
				'swarm-write-retro': {
					template: '/swarm write-retro $ARGUMENTS',
					description:
						'Use /swarm write-retro to manually write a phase retrospective',
				},
				'swarm-reset-session': {
					template: '/swarm reset-session',
					description:
						'Use /swarm reset-session to clear session state and delegation chains',
				},
				'swarm-simulate': {
					template: '/swarm simulate $ARGUMENTS',
					description: 'Use /swarm simulate to run a simulated agent session',
				},
				'swarm-promote': {
					template: '/swarm promote $ARGUMENTS',
					description:
						'Use /swarm promote to promote knowledge entries to production',
				},
				'swarm-checkpoint': {
					template: '/swarm checkpoint $ARGUMENTS',
					description:
						'Use /swarm checkpoint to save or restore git checkpoints',
				},
				'swarm-config-doctor': {
					template: '/swarm config doctor',
					description:
						'Use /swarm config doctor to diagnose configuration issues',
				},
				'swarm-evidence-summary': {
					template: '/swarm evidence summary',
					description:
						'Use /swarm evidence summary to generate evidence summaries',
				},
				'swarm-finalize': {
					template: '/swarm finalize',
					description:
						'Use /swarm finalize to archive the swarm project and close active state',
				},
				'swarm-close': {
					template: '/swarm close',
					description: 'Deprecated alias for /swarm finalize',
				},
				'swarm-acknowledge-spec-drift': {
					template: '/swarm acknowledge-spec-drift',
					description:
						'Use /swarm acknowledge-spec-drift to acknowledge spec drift and suppress further warnings',
				},
				'swarm-doctor-tools': {
					template: '/swarm doctor tools',
					description:
						'Use /swarm doctor tools to run tool registration coherence check',
				},
			};

			log('Config applied', {
				agents: Object.keys(agents),
				commands: ['swarm'],
			});
		},

		// Inject phase reminders before API calls
		'experimental.chat.messages.transform': composeHandlers(
			...[
				// Delegation ledger: inject summary when architect session resumes
				(input: unknown, _output: unknown): Promise<void> => {
					if (process.env.DEBUG_SWARM)
						console.error(`[DIAG] messagesTransform START`);
					const p = input as { sessionID?: string };
					if (p.sessionID) {
						const archAgent = swarmState.activeAgent.get(p.sessionID);
						const archSession = swarmState.agentSessions.get(p.sessionID);
						const agentName = archAgent ?? archSession?.agentName ?? '';
						if (stripKnownSwarmPrefix(agentName) === ORCHESTRATOR_NAME) {
							try {
								delegationLedgerHook.onArchitectResume(p.sessionID);
							} catch {
								/* non-blocking */
							}
						}
					}
					return Promise.resolve();
				},
				pipelineHook['experimental.chat.messages.transform'],
				contextBudgetHandler,
				guardrailsHooks.messagesTransform,
				fullAutoInterceptHook?.messagesTransform,
				ccCommandInterceptHook?.messagesTransform,
				delegationGateHooks.messagesTransform,
				delegationSanitizerHook,
				memoryLifecycleHooks.messagesTransform,
				knowledgeInjectorHook, // v6.17 knowledge injection
				// v2: scan latest architect-authored message for KNOWLEDGE_APPLIED
				// / KNOWLEDGE_IGNORED / KNOWLEDGE_VIOLATED markers and record
				// each via the dedup-aware path. Best-effort; never throws.
				(input: unknown, output: unknown): Promise<void> => {
					try {
						const p = input as { sessionID?: string };
						return knowledgeApplicationTransformScan(
							ctx.directory,
							output as {
								messages?: import('./hooks/knowledge-types.js').MessageWithParts[];
							},
							p.sessionID,
						);
					} catch {
						return Promise.resolve();
					}
				},
				// v2: scan for skill propagation warnings and compliance tracking
				(input: unknown, output: unknown): Promise<void> => {
					try {
						if (!skillPropagationConfig.enabled) {
							return Promise.resolve();
						}
						const p = input as { sessionID?: string };
						return skillPropagationTransformScan(
							ctx.directory,
							output as {
								messages?: import('./hooks/knowledge-types.js').MessageWithParts[];
							},
							p.sessionID,
						);
					} catch {
						return Promise.resolve();
					}
				},
				// Final transformation: consolidate multiple system messages into one
				(_input: unknown, output: { messages?: unknown[] }): Promise<void> => {
					if (output.messages) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						// biome-ignore lint/suspicious/noExplicitAny: consolidateSystemMessages accepts unknown[]
						output.messages = consolidateSystemMessages(output.messages as any);
					}
					if (process.env.DEBUG_SWARM)
						console.error(`[DIAG] messagesTransform DONE`);
					return Promise.resolve();
				},
			].filter((fn): fn is NonNullable<typeof fn> => Boolean(fn)),
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		) as any,

		// Inject system prompt enhancements + phase monitor (when phase_preflight or knowledge enabled)
		'experimental.chat.system.transform': composeHandlers(
			...([
				async (_input: unknown, _output: unknown): Promise<void> => {
					if (process.env.DEBUG_SWARM)
						console.error(`[DIAG] systemTransform START`);
				},
				systemEnhancerHook['experimental.chat.system.transform'],
				async (_input: unknown, _output: unknown): Promise<void> => {
					if (process.env.DEBUG_SWARM)
						console.error(`[DIAG] systemTransform enhancer DONE`);
				},
				contextCapsuleInjectHook['experimental.chat.system.transform'],
				// Heartbeat: throttled to 30s per session
				(input: unknown, _output: unknown): Promise<void> => {
					try {
						const { sessionID } = input as { sessionID?: string };
						if (!sessionID) return Promise.resolve();
						const lastTime = _heartbeatTimers.get(sessionID);
						if (Date.now() - (lastTime ?? 0) > 30_000) {
							_heartbeatTimers.set(sessionID, Date.now());
							telemetry.heartbeat(sessionID);
						}
					} catch {
						// never throws
					}
					return Promise.resolve();
				},
				automationConfig.capabilities?.phase_preflight === true &&
				preflightTriggerManager
					? createPhaseMonitorHook(
							ctx.directory,
							preflightTriggerManager,
							undefined,
							(sessionId) =>
								createCuratorLLMDelegate(ctx.directory, 'init', sessionId),
						)
					: knowledgeConfig.enabled
						? createPhaseMonitorHook(
								ctx.directory,
								undefined,
								undefined,
								(sessionId) =>
									createCuratorLLMDelegate(ctx.directory, 'init', sessionId),
							)
						: undefined,
				swarmCommandSystemRuleHook,
				(_input: unknown, output: { system?: string[] }): Promise<void> => {
					if (Array.isArray(output.system) && output.system.length > 1) {
						output.system = [output.system.join('\n\n')];
					}
					return Promise.resolve();
				},
			].filter(Boolean) as Array<
				(input: unknown, output: unknown) => Promise<void>
			>),
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		) as any,

		// Handle session compaction
		'experimental.session.compacting': compactionHook[
			'experimental.session.compacting'
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		] as any,

		// Handle /swarm commands
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'command.execute.before': safeHook(commandHandler) as any,

		// Track tool usage + guardrails
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'tool.execute.before': (async (input: any, output: any) => {
			if (process.env.DEBUG_SWARM)
				console.error(
					`[DIAG] toolBefore tool=${normalizeToolName(input.tool) ?? input.tool} session=${input.sessionID}`,
				);
			// If no active agent is mapped for this session, it's the primary agent (architect)
			// Subagent delegations always set activeAgent via chat.message before tool calls
			if (!swarmState.activeAgent.has(input.sessionID)) {
				swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);
			}

			// Revert to primary agent if delegation appears stale.
			// Delegation is stale when BOTH conditions are met:
			// 1. delegationActive is explicitly false (set by chat.message or Task toolAfter), AND
			// 2. The session's lastAgentEventTime is >10s old (subagent completed, no chat.message reset)
			// Using AND (&&) ensures active delegations are never interrupted — the
			// delegationActive flag is the authoritative signal that a subagent is running.
			// The 10s timer is a secondary safety net for cases where chat.message is delayed
			// after Task tool completion sets delegationActive=false.
			// NOTE: Uses lastAgentEventTime (not lastToolCallTime) to ensure tool activity
			// does not prevent stale subagent identity from being detected
			const session = swarmState.agentSessions.get(input.sessionID);
			const activeAgent = swarmState.activeAgent.get(input.sessionID);
			if (session && activeAgent && activeAgent !== ORCHESTRATOR_NAME) {
				const stripActive = stripKnownSwarmPrefix(activeAgent);
				if (stripActive !== ORCHESTRATOR_NAME) {
					const staleDelegation =
						!session.delegationActive &&
						Date.now() - session.lastAgentEventTime > 10000;
					if (staleDelegation) {
						swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);
						ensureAgentSession(input.sessionID, ORCHESTRATOR_NAME);
					}
				}
			}

			// ---------------------------------------------------------------
			// FAIL-CLOSED CHAIN — DO NOT wrap any of the calls below in
			// safeHook() or composeHandlers(). Both helpers swallow throws,
			// which would silently disable the policy and let the tool run
			// anyway. The OpenCode host treats a propagated throw from
			// `tool.execute.before` as a tool rejection.
			//
			// The semantically equivalent `composeBlockingHandlers` helper in
			// src/hooks/utils.ts exists for new fail-closed compositions. The
			// raw-await pattern below is preserved so each hook's role is
			// individually documented for future maintainers.
			//
			// Regression test: tests/unit/hooks/hook-composition.test.ts
			// asserts every callsite below uses raw `await` (not safeHook).
			// ---------------------------------------------------------------

			// 1. Guardrails authority enforcement (FAIL-CLOSED).
			//    Throws must propagate to block tools.
			await guardrailsHooks.toolBefore(input, output);

			// 2. Scope-guard watchdog (FAIL-CLOSED).
			//    Blocks out-of-scope writes by non-architect agents.
			await scopeGuardHook.toolBefore(input, output);

			// 3. Reviewer gate (FAIL-CLOSED).
			//    Blocks coder re-delegation when the prior reviewer round
			//    has not produced an explicit pass/decision.
			await delegationGateHooks.toolBefore(input, output);

			// 4. Full-Auto v2 outbound delegation guard (FAIL-CLOSED).
			//    Throws FULL_AUTO_DELEGATION_DENY on disallowed Task
			//    delegations (unknown canonical role, missing coder scope).
			await fullAutoDelegationHook.toolBefore(input, output);

			// 5. Full-Auto v2 permission policy (FAIL-CLOSED).
			//    Throws FULL_AUTO_DENY / FULL_AUTO_BLOCKED / FULL_AUTO_PAUSED /
			//    FULL_AUTO_ESCALATE_HUMAN on denied actions and dispatches the
			//    critic when escalate_critic is needed.
			await fullAutoPermissionHook.toolBefore(input, output);

			// 6. v2 knowledge-application gate (FAIL-CLOSED in enforce mode).
			//    Reads in-memory currentCriticalShownIds populated at injection
			//    time and the in-process ack dedup set. Throws
			//    KNOWLEDGE_ENFORCE_GATE_DENY for high-risk architect actions
			//    (save_plan / update_task_status / phase_complete / Task) when
			//    a critical directive was shown but no ack was recorded.
			//    In `warn` mode it appends to events.jsonl and returns.
			await knowledgeApplicationGateBefore(
				ctx.directory,
				{
					tool: input.tool,
					agent: input.agent,
					sessionID: input.sessionID,
				},
				KnowledgeApplicationConfigSchema.parse(
					config.knowledge_application ?? {},
				),
			);
			// 7. Skill propagation gate (soft warning when SKILLS field missing).
			//    Logs to events.jsonl when architect delegates to skill-capable
			//    agents without a SKILLS field. Also pushes a visible warning
			//    to pendingAdvisoryMessages for injection into the architect's
			//    next prompt. When enforce=true, blocks the delegation entirely.
			const skillResult = skillPropagationConfig.enabled
				? await skillPropagationGateBefore(
						ctx.directory,
						{
							tool: input.tool,
							agent: input.agent,
							sessionID: input.sessionID,
							args: input.args,
						},
						skillPropagationConfig,
					)
				: { blocked: false, reason: null, recommendedSkills: undefined };
			if (skillResult.blocked) {
				throw new Error(
					skillResult.reason ?? 'Blocked by skill propagation gate',
				);
			}
			if (skillResult.reason) {
				const skillSession = ensureAgentSession(
					input.sessionID,
					swarmState.activeAgent.get(input.sessionID) ?? ORCHESTRATOR_NAME,
				);
				skillSession.pendingAdvisoryMessages ??= [];
				skillSession.pendingAdvisoryMessages.push(skillResult.reason);
			}

			// 8. Skill injection: auto-inject recommended skills when SKILLS field
			//    is missing from the delegation prompt. Preserves explicit
			//    SKILLS: none and architect-set SKILLS fields.
			if (
				skillResult.recommendedSkills &&
				skillResult.recommendedSkills.length > 0
			) {
				const argsRecord = input.args as Record<string, unknown>;
				const promptRaw = argsRecord.prompt;
				if (typeof promptRaw === 'string') {
					// Parse the prompt to check for existing SKILLS field
					const parsedDelegation = parseDelegationArgs(input.args);
					if (parsedDelegation) {
						const existingSkills = parsedDelegation.skillsField.trim();
						// Skip injection if SKILLS field already exists or is explicitly "none"
						if (!existingSkills) {
							// Filter by relevance score threshold (0.5)
							const qualified = skillResult.recommendedSkills.filter(
								(s) => s.score >= 0.5,
							);

							if (qualified.length === 0) {
								// No skills above threshold — inject SKILLS: none
								argsRecord.prompt = `SKILLS: none\n\n${promptRaw}`;
								console.warn(
									'[skill-propagation-gate] No skills above threshold 0.5 — injected SKILLS: none',
								);
							} else {
								// Take top 5 by score
								const topSkills = qualified.slice(0, 5);

								// Dynamic skill description from SKILL.md frontmatter
								const skillPaths = topSkills
									.map((s) => {
										const meta = readSkillMetadata(s.skillPath, ctx.directory);
										let desc = meta.description || '';
										if (!desc || desc === 'No description provided') {
											desc = path.basename(path.dirname(s.skillPath));
										}
										// Strip commas to prevent corruption of comma-delimited SKILLS: parsing
										desc = desc.replace(/,/g, ';');
										return `file:${s.skillPath} (-- ${desc})`;
									})
									.join(', ');

								const skillsLine = `SKILLS: ${skillPaths}`;

								// Inject at the beginning of the prompt
								const newPrompt = `${skillsLine}\n\n${promptRaw}`;
								argsRecord.prompt = newPrompt;

								// Log the injection
								const skillNames = topSkills
									.map(
										(s) =>
											`${path.basename(s.skillPath)} (score: ${s.score.toFixed(2)})`,
									)
									.join(', ');
								console.warn(
									`[skill-propagation-gate] Injected skills: ${skillNames}`,
								);

								// Record each injected skill to skill-usage.jsonl
								for (const skill of topSkills) {
									try {
										appendSkillUsageEntry(ctx.directory, {
											skillPath: skill.skillPath,
											agentName: String(input.agent),
											taskID: 'injection',
											timestamp: new Date().toISOString(),
											complianceVerdict: 'not_checked',
											sessionID: input.sessionID,
										});
									} catch {
										// Non-blocking: best-effort audit logging
									}
								}

								// SKILLS_USED_BY_CODER forwarding for reviewer delegations
								// When auto-injecting skills and the target is a reviewer,
								// append SKILLS_USED_BY_CODER so the compliance feedback loop
								// can track injected skills back to the scoring system.
								const targetAgent = parsedDelegation.targetAgent.toLowerCase();
								if (targetAgent.includes('reviewer')) {
									const usedByCoderLine = `SKILLS_USED_BY_CODER: ${topSkills.map((s) => `file:${s.skillPath}`).join(', ')}`;
									argsRecord.prompt = `${newPrompt}\n${usedByCoderLine}`;
								}
							}
						}
					}
				}
			}
			// ---------------------------------------------------------------

			// 9. Per-delegate knowledge directive injection (Change 1, Task 1.4).
			//    ADVISORY: prepends the role-scoped <delegate_knowledge_directives>
			//    block to a Task delegation's prompt so the subagent sees the
			//    directives + ack contract. Internally fail-open; never blocks.
			if (knowledgeConfig.enabled) {
				await injectDelegateDirectivesBefore(
					ctx.directory,
					{
						tool: input.tool,
						agent: input.agent,
						sessionID: input.sessionID,
						args: input.args,
					},
					knowledgeConfig,
				);
			}

			// v6.29: One-time 50% context pressure warning
			if (swarmState.lastBudgetPct >= 50) {
				const pressureSession = ensureAgentSession(
					input.sessionID,
					swarmState.activeAgent.get(input.sessionID) ?? ORCHESTRATOR_NAME,
				);
				if (!pressureSession.contextPressureWarningSent) {
					pressureSession.contextPressureWarningSent = true;
					pressureSession.pendingAdvisoryMessages ??= [];
					pressureSession.pendingAdvisoryMessages.push(
						`CONTEXT PRESSURE: ${swarmState.lastBudgetPct.toFixed(1)}% of context window used. Prioritize completing the current task before starting new work.`,
					);
				}
			}

			// ADVISORY — activity tracking is observer-only.
			// Wrapped in safeHook intentionally: errors here must NOT block
			// the tool call that the fail-closed chain above has already
			// approved.
			await safeHook(activityHooks.toolBefore)(input, output);
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Track tool usage + guardrails (after)
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'tool.execute.after': (async (input: any, output: any) => {
			const _dbg = !!process.env.DEBUG_SWARM;
			const _toolName = normalizeToolName(input.tool) ?? input.tool;
			if (_dbg)
				console.error(
					`[DIAG] toolAfter START tool=${_toolName} session=${input.sessionID}`,
				);

			const normalizedTool = normalizeToolName(input.tool);
			const isTaskTool = normalizedTool === 'Task' || normalizedTool === 'task';

			const hookChain = async (): Promise<void> => {
				await activityHooks.toolAfter(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter activity done tool=${_toolName}`);
				await safeHook(trajectoryLoggerHook.toolAfter)(input, output);
				if (_dbg)
					console.error(
						`[DIAG] toolAfter trajectoryLogger done tool=${_toolName}`,
					);
				// Per-delegate ack collection (Change 1, Task 1.5): reconcile the
				// directives shown to a returning subagent against its ack markers.
				// Fail-open; never blocks. Only acts on Task tool calls.
				if (knowledgeConfig.enabled) {
					await safeHook(() =>
						collectDelegateAcksAfter(ctx.directory, input, output),
					)(input, output);
					// Reviewer DIRECTIVE_COMPLIANCE reconciliation (Change 2, Task 2.3):
					// parse a returning reviewer's per-ID verdicts into knowledge events.
					await safeHook(() =>
						collectReviewerVerdictsAfter(ctx.directory, input, output),
					)(input, output);
					// Micro-reflector (Change 6, Task 5.1): on a delegate failure/partial
					// return, emit 0-2 v3 insight candidates from the trajectory +
					// transcript. Quota-gated; classification-only without an LLM client.
					await safeHook(() =>
						microReflectorAfter(
							ctx.directory,
							input,
							output,
							createCuratorLLMDelegate(ctx.directory, 'phase', input.sessionID),
							{
								maxCalls: knowledgeConfig.enrichment.max_calls_per_day,
								window: knowledgeConfig.enrichment.quota_window,
							},
						),
					)(input, output);
				}
				// Reviewer receipt collection: persist a returning reviewer Task's
				// VERDICT/RISK/ISSUES block as a durable review receipt. Fail-open;
				// independent of the knowledge system.
				await safeHook(async () => {
					await collectReviewerReceiptAfter(ctx.directory, input, output);
				})(input, output);
				// Auto-review (opt-in): fire-and-forget execution-diff review by
				// the reviewer model at task/phase boundaries.
				await safeHook(autoReviewHook.toolAfter)(input, output);
				await safeHook(prmHook.toolAfter)(input, output);
				await guardrailsHooks.toolAfter(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter guardrails done tool=${_toolName}`);
				await safeHook(delegationLedgerHook.toolAfter)(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter ledger done tool=${_toolName}`);
				await safeHook(selfReviewHook.toolAfter)(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter selfReview done tool=${_toolName}`);
				await safeHook(memoryLifecycleHooks.toolAfter)(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter memory done tool=${_toolName}`);
				await safeHook(delegationGateHooks.toolAfter)(input, output);
				if (_dbg)
					console.error(
						`[DIAG] toolAfter delegationGate done tool=${_toolName}`,
					);

				// Full-Auto v2: prompt-injection probe + subagent return check.
				// Both are non-throwing observers (errors swallowed by safeHook).
				await safeHook(fullAutoInputProbeHook.toolAfter)(input, output);
				await safeHook(fullAutoDelegationHook.toolAfter)(input, output);

				// Adversarial semantic pattern detection on agent output
				if (isTaskTool && typeof output.output === 'string') {
					try {
						const adversarialMatches = detectAdversarialPatterns(output.output);
						if (adversarialMatches.length > 0) {
							const sessionId = input.sessionID;
							const session = swarmState.agentSessions.get(sessionId);
							if (session) {
								session.pendingAdvisoryMessages ??= [];
								session.pendingAdvisoryMessages.push(
									`ADVERSARIAL PATTERN DETECTED: ${adversarialMatches.map((p) => p.pattern).join(', ')}. ` +
										'Review agent output for potential prompt injection or gate bypass.',
								);
							}
							// Telemetry: emit event for adversarial pattern detection
							if ('adversarialPatternDetected' in telemetry) {
								// biome-ignore lint/suspicious/noExplicitAny: telemetry method may not exist yet
								(telemetry as Record<string, any>).adversarialPatternDetected(
									input.sessionID,
									adversarialMatches,
								);
							}
						}
					} catch {
						// adversarial detection errors must never block
					}
				}

				// Record tool call for debugging spiral detection
				try {
					recordToolCall(normalizedTool, input.args, input.sessionID);
				} catch {
					// non-fatal
				}

				// Debugging spiral detection
				try {
					const spiralMatch = await detectDebuggingSpiral(
						ctx.directory,
						input.sessionID,
					);
					if (spiralMatch) {
						const taskId =
							swarmState.agentSessions.get(input.sessionID)?.currentTaskId ??
							`session-${input.sessionID.slice(0, 12)}`;
						const spiralResult = await handleDebuggingSpiral(
							spiralMatch,
							taskId,
							ctx.directory,
						);
						const session = swarmState.agentSessions.get(input.sessionID);
						if (session) {
							session.pendingAdvisoryMessages ??= [];
							session.pendingAdvisoryMessages.push(spiralResult.message);
						}
					}
				} catch {
					// non-fatal
				}

				if (knowledgeCuratorHook)
					await safeHook(knowledgeCuratorHook)(input, output);
				if (hivePromoterHook) await safeHook(hivePromoterHook)(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter knowledge done tool=${_toolName}`);
				await safeHook(steeringConsumedHook)(input, output);
				await safeHook(coChangeSuggesterHook)(input, output);
				await safeHook(darkMatterDetectorHook)(input, output);
				if (_dbg)
					console.error(`[DIAG] toolAfter intelligence done tool=${_toolName}`);
				await snapshotWriterHook(input, output);
				await toolSummarizerHook?.(input, output);
				if (_dbg)
					console.error(
						`[DIAG] toolAfter snapshot+summarizer done tool=${_toolName}`,
					);
				const execMode = config.execution_mode ?? 'balanced';
				if (execMode === 'strict') {
					if (slopDetectorHook) await slopDetectorHook.toolAfter(input, output);
					if (incrementalVerifyHook)
						await incrementalVerifyHook.toolAfter(input, output);
				}
				// Compaction service runs in both strict and balanced modes
				// (context management is critical regardless of quality strictness level)
				if (execMode !== 'fast' && compactionServiceHook) {
					await compactionServiceHook.toolAfter(input, output);
				}

				// Repo graph incremental update on write tools
				await safeHook(repoGraphHook.toolAfter)(input, output);

				// Context Map: post-agent update after Task tool completes
				if (
					isTaskTool &&
					config.context_map?.enabled === true &&
					input.sessionID
				) {
					try {
						const contextMapSession = swarmState.agentSessions.get(
							input.sessionID,
						);
						const contextMapTaskId = contextMapSession?.currentTaskId ?? null;
						if (contextMapTaskId) {
							const agentOutput =
								typeof output.output === 'string' ? output.output : '';
							updateContextMapAfterAgent({
								task_id: contextMapTaskId,
								agent_role:
									swarmState.activeAgent.get(input.sessionID) ?? 'unknown',
								files_touched: [],
								implementation_summary: agentOutput.slice(0, 500),
								task_goal: '',
								final_status: 'completed',
								directory: ctx.directory,
							});
						}
					} catch {
						// Post-agent update must never block the hook chain
					}
				}

				// Tool output truncation (after summarizer to avoid double-processing)
				const toolOutputConfig = config.tool_output;
				if (
					toolOutputConfig &&
					toolOutputConfig.truncation_enabled !== false &&
					typeof output.output === 'string'
				) {
					const defaultTruncatableTools = new Set([
						'diff',
						'symbols',
						'bash',
						'shell',
						'test_runner',
						'lint',
						'pre_check_batch',
						'complexity_hotspots',
						'pkg_audit',
						'sbom_generate',
						'schema_drift',
					]);
					const configuredTools = toolOutputConfig.truncation_tools;
					const truncatableTools =
						configuredTools && configuredTools.length > 0
							? new Set(configuredTools)
							: defaultTruncatableTools;
					const maxLines =
						toolOutputConfig.per_tool?.[input.tool] ??
						toolOutputConfig.max_lines ??
						150;
					if (truncatableTools.has(input.tool)) {
						output.output = truncateToolOutput(
							output.output,
							maxLines,
							input.tool,
							10,
						);
					}
				}
			};

			try {
				await hookChain();
			} catch (err) {
				const warning = `[swarm] toolAfter hook chain error tool=${_toolName}: ${err instanceof Error ? err.message : String(err)}`;
				if (!config.quiet) {
					console.warn(warning);
				} else {
					addDeferredWarning(warning);
				}
			}

			// ── Task handoff runs AFTER hooks ───────────────────────────────
			// Hooks must see the original subagent identity to record evidence
			// correctly. The handoff restores architect identity afterward.
			if (isTaskTool) {
				const sessionId = input.sessionID;
				const agentName = swarmState.activeAgent.get(sessionId) || 'unknown';
				swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
				ensureAgentSession(sessionId, ORCHESTRATOR_NAME);
				const taskSession = swarmState.agentSessions.get(sessionId);
				if (taskSession) {
					taskSession.delegationActive = false;
					taskSession.lastAgentEventTime = Date.now();
					telemetry.delegationEnd(
						sessionId,
						agentName,
						taskSession.currentTaskId || '',
						'completed',
					);
					// Pipeline continuation advisory — prevents happy-path stall when
					// delegated agents return clean results. The architect must resume
					// direct tool execution for remaining QA gate steps.
					const baseAgentName = stripKnownSwarmPrefix(agentName);
					if (
						baseAgentName === 'reviewer' ||
						baseAgentName === 'test_engineer' ||
						baseAgentName === 'critic' ||
						baseAgentName === 'critic_sounding_board'
					) {
						taskSession.pendingAdvisoryMessages ??= [];
						taskSession.pendingAdvisoryMessages.push(
							`[PIPELINE] ${baseAgentName} delegation complete for task ${taskSession.currentTaskId ?? 'unknown'}. ` +
								`Resume the QA gate pipeline — check your task pipeline steps for the next required action. ` +
								`Do not stop here.`,
						);
					}
					// Issue #414: Wire Target B — parse sounding-board response and inject verdict advisory.
					// Note: output.output is NOT truncated for task tools (tool name 'task' is not
					// in defaultTruncatableTools), so the full critic response is available here.
					if (baseAgentName === 'critic_sounding_board') {
						const rawResponse =
							typeof output.output === 'string' ? output.output : '';
						const parsed = parseSoundingBoardResponse(rawResponse);
						taskSession.pendingAdvisoryMessages ??= [];
						if (parsed) {
							let verdictMsg = `[SOUNDING_BOARD] Verdict: ${parsed.verdict}. ${parsed.reasoning}`;
							if (parsed.improvedQuestion)
								verdictMsg += ` Rephrase to: ${parsed.improvedQuestion}`;
							if (parsed.answer) verdictMsg += ` Answer: ${parsed.answer}`;
							if (parsed.warning) verdictMsg += ` WARNING: ${parsed.warning}`;
							taskSession.pendingAdvisoryMessages.push(verdictMsg);
							taskSession.lastDelegationReason = 'critic_consultation';
						} else {
							// Parsing failed — inject a fallback so the architect is not left without
							// guidance. Use conservative behavior: treat as REPHRASE (needs review)
							// rather than silently approving. Expected format:
							// "Verdict: [APPROVED|REPHRASE|RESOLVE|UNNECESSARY]"
							taskSession.pendingAdvisoryMessages.push(
								`[SOUNDING_BOARD] WARNING: Could not parse a structured verdict from ` +
									`critic_sounding_board response (${rawResponse.length} chars). ` +
									`Treat as REPHRASE — review the raw response before surfacing to user or escalating. ` +
									`Do not silently accept as resolved.`,
							);
						}
					}
				}
				if (_dbg)
					console.error(
						`[DIAG] Task handoff DONE session=${sessionId} activeAgent=${swarmState.activeAgent.get(sessionId)}`,
					);
			}

			deleteStoredInputArgs(input.callID);
			if (_dbg) console.error(`[DIAG] toolAfter COMPLETE tool=${_toolName}`);
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Track agent delegations and active agent
		'chat.message': safeHook(
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
			async (input: any, output: any) => {
				if (process.env.DEBUG_SWARM)
					console.error(
						`[DIAG] chat.message agent=${input.agent ?? 'none'} session=${input.sessionID}`,
					);
				await delegationHandler(input, output);

				// Full-Auto v2 cadence: increment architect-turn counter and, when a
				// cadence trigger fires (every N turns / minutes / near-limit
				// denials), dispatch a critic oversight call in the background.
				// Critic-internal tool calls run on ephemeral sessions that have
				// no durable run state, so they short-circuit inside
				// tickAndMaybeDispatchCadence and do NOT recurse.
				try {
					// First-class toggle: no config.full_auto.enabled gate — the
					// tick short-circuits on the durable run state when Full-Auto
					// was never activated for this session.
					if (input?.sessionID && input?.agent) {
						const stripped = stripKnownSwarmPrefix(String(input.agent));
						if (stripped === 'architect') {
							tickAndMaybeDispatchCadence(
								ctx.directory,
								input.sessionID,
								'architectTurns',
								config,
								{ activeAgent: String(input.agent) },
							);
						}
					}
				} catch {
					// Best-effort — never block chat.message.
				}

				if (process.env.DEBUG_SWARM)
					console.error(
						`[DIAG] chat.message DONE agent=${input.agent ?? 'none'}`,
					);
			},
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		) as any,

		// v6.7 Background automation framework (scaffold only)
		// Exposed for future Task 5.x business feature integration
		automation: automationManager,
	};
}

// v1 plugin shape: OpenCode's readV1Plugin requires the default export to be
// an object exposing `id` and `server`. Bare-function defaults fall through to
// the legacy iterator, which then walks Object.values(mod) and throws on any
// non-function export. Issue #675.
//
// `satisfies` keeps the wrapper type-checked against the inferred shape without
// loosening the OpenCodeSwarm function's `Plugin` type. The id literal must
// match the package name in package.json.
export default {
	id: 'opencode-swarm' as const,
	server: OpenCodeSwarm,
} satisfies { id: string; server: Plugin };

// Type re-exports remain — they are erased at runtime so they do not appear
// in Object.values(mod) and cannot break OpenCode's plugin loader.
export type { AgentDefinition } from './agents';
export type {
	AgentName,
	AutomationCapabilities,
	AutomationConfig,
	AutomationMode,
	PipelineAgentName,
	PluginConfig,
	QAAgentName,
} from './config';
