import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '@opencode-ai/plugin';
import packageJson from '../package.json' with { type: 'json' };
import {
	type AgentDefinition,
	createAgents,
	extractSwarmIdFromAgentName,
	getAgentConfigs,
	getSwarmAgents,
} from './agents';
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
import {
	getSafeDefaultConfigLoadResult,
	loadPluginConfigWithMetaAsync,
} from './config';
import {
	resolveRegisteredAgentModel,
	resolveRuntimeAgentModel,
} from './config/agent-model.js';
import { syncBundledProjectSkillsIfMissingAsync } from './config/bundled-skills.js';
import {
	DEFAULT_MODELS,
	ORCHESTRATOR_NAME,
	SUMMARIZER_EXEMPT_TOOL_NAMES,
} from './config/constants';
import { resolveWorktreeIsolationConfig } from './config/index.js';
import {
	writeProjectConfigIfNew,
	writeSwarmConfigExampleIfNew,
} from './config/project-init';
import {
	AuthorityConfigSchema,
	AutomationConfigSchema,
	type AutoReviewConfig,
	GuardrailsConfigSchema,
	KnowledgeApplicationConfigSchema,
	KnowledgeConfigSchema,
	LearningConfigSchema,
	PrMonitorConfigSchema,
	PrmConfigSchema,
	RepoGraphConfigSchema,
	resolveAutoReviewConfig,
	SelfReviewConfigSchema,
	SkillImproverConfigSchema,
	SkillPropagationConfigSchema,
	SummaryConfigSchema,
	stripKnownSwarmPrefix,
	WatchdogConfigSchema,
} from './config/schema';
import { createRoleFilterSystemHook } from './context/role-filter.js';
import { updateContextMapAfterAgent } from './context-map/post-agent-update.js';
import { createEvaluationModelDispatcher } from './evaluation/model-dispatcher.js';
import {
	observePhaseParticipationToolResult,
	reserveApprovedPhaseParticipation,
} from './evidence/phase-participation.js';
import {
	clearSessionActionCircuits,
	listBlockingActionCircuitsForInvocation,
} from './failures/action-circuit.js';
import { createActionIdentity } from './failures/action-identity.js';
import {
	classifyProviderFailure,
	isRetryableProviderFailure,
} from './failures/invocation-failure.js';
import { tickAndMaybeDispatchCadence } from './full-auto/cadence.js';
import { registerFullAutoRecoveryBlockerEvaluator } from './full-auto/recovery.js';
import {
	bindFullAutoSevereChildSession,
	clearFullAutoSevereSession,
} from './full-auto/severe-result.js';
import { loadFullAutoRunState } from './full-auto/state.js';
import {
	composeHandlers,
	consolidateSystemMessagesInPlace,
	createAgentActivityHooks,
	createCompactionCustomizerHook,
	createContextBudgetHandler,
	createCuratorLLMDelegate,
	createDelegationGateHook,
	createDelegationSanitizerHook,
	createDelegationTrackerHook,
	createFinalContextAccountingStep,
	createFullAutoInterceptHook,
	createGuardrailsHooks,
	createPhaseMonitorHook,
	createPipelineTrackerHook,
	createRepoGraphBuilderHook,
	createSystemEnhancerHook,
	createToolSummarizerHook,
	outputLooksLikeBackgroundRunning,
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
import { cacheCohortIdAtMessage } from './hooks/cohort-cache.js';
import { createContextCapsuleInjectHook } from './hooks/context-capsule-inject.js';
import { createDarkMatterDetectorHook } from './hooks/dark-matter-detector.js';
import { collectDelegateAcksAfter } from './hooks/delegate-ack-collector.js';
import { injectDelegateDirectivesBefore } from './hooks/delegate-directive-injection.js';
import { createDelegationLedgerHook } from './hooks/delegation-ledger.js';
import { createFullAutoDelegationHook } from './hooks/full-auto-delegation.js';
import { createFullAutoInputProbeHook } from './hooks/full-auto-input-probe.js';
import { createFullAutoPermissionHook } from './hooks/full-auto-permission.js';
import {
	isAbortLikeError,
	noteGateDenial,
	resetGateDenialStreaks,
} from './hooks/gate-denial-tracker.js';
import {
	deleteStoredInputArgs,
	setStoredInputArgs,
} from './hooks/guardrails.js';
import { createHivePromoterHook } from './hooks/hive-promoter.js';
import {
	type MessageArrayLike,
	resolveMessageTransformContext,
	resolveToolAfterContext,
	resolveToolBeforeContext,
} from './hooks/host-boundary.js';
import { createIncrementalVerifyHook } from './hooks/incremental-verify';
import { runInitOrphanRecovery } from './hooks/init-orphan-recovery.js';
import { createInitOrphanRecoveryAdvisoryHook } from './hooks/init-orphan-recovery-advisory';
import { createIssueTraceHook } from './hooks/issue-trace.js';
import {
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
} from './hooks/knowledge-application-gate.js';
import { createKnowledgeCuratorHook } from './hooks/knowledge-curator.js';
import {
	bumpKnowledgeGeneration,
	createKnowledgeInjectorHook,
} from './hooks/knowledge-injector.js';
import { microReflectorAfter } from './hooks/micro-reflector.js';
import { normalizeToolName } from './hooks/normalize-tool-name';
import { createPrAutoSubscribeHook } from './hooks/pr-auto-subscribe.js';
import {
	enforcePrWorkflowToolBefore,
	recordPrFeedbackPushAttemptResult,
} from './hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from './hooks/pr-workflow-response-gate.js';
import { createPrWorkflowSessionResolver } from './hooks/pr-workflow-session-resolver.js';
import { collectReviewerReceiptAfter } from './hooks/review-receipt-collector.js';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from './hooks/reviewer-scope-lifecycle.js';
import { collectReviewerVerdictsAfter } from './hooks/reviewer-verdict-parser.js';
import { createScopeGuardHook } from './hooks/scope-guard.js';
import { createSelfReviewHook } from './hooks/self-review.js';
import { injectSkillsIntoDelegation } from './hooks/skill-injection.js';
import {
	parseDelegationArgs,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
} from './hooks/skill-propagation-gate.js';
import { createSlopDetectorHook } from './hooks/slop-detector';
import { createSteeringConsumedHook } from './hooks/steering-consumed.js';
import {
	createTrajectoryLoggerHook,
	recordDeniedToolCall,
} from './hooks/trajectory-logger';
import { estimateTokens } from './hooks/utils';
import {
	hasGitMarkerAncestor,
	hasManifestAncestor,
	hasSwarmState,
} from './lang/manifest-files';
import { realtimeAdmissionAfter } from './learning/admission.js';
import { createMemoryLifecycleHooks } from './memory';
import type { MemoryConfig as RuntimeMemoryConfig } from './memory/config.js';
import {
	advancePendingTaskModelRoute,
	bindPendingTaskModelRouteChild,
	clearPendingTaskModelRoutesForSession,
	getPendingTaskModelRouteSnapshot,
	registerPendingTaskModelRoute,
	resolveTaskChatModelOverride,
} from './models/task-model-routing.js';
import { initObservability } from './observability/index.js';
import { loadPlan } from './plan/manager.js';
import { createPrmHook, resolvePrmPatternPersistenceOptions } from './prm';
import { cleanupOldTrajectoryFiles } from './prm/trajectory-store';
import { createReviewModelDispatcher } from './review/contracts.js';
import { createFindingValidationScheduler } from './review/finding-validator.js';
import { captureReviewAgentModelRegistry } from './review/runtime.js';
import { createCompactionService } from './services/compaction-service';
import { shouldRunOnStartup } from './services/config-doctor';
import {
	buildDelegationCostFields,
	type PricingConfig as CostPricingConfig,
	type DelegationCostFields,
	foldTelemetryEvents,
	isCostUpgrade,
	readTelemetryEvents,
} from './services/cost-accounting.js';
import {
	advanceTurnGeneration,
	recordProducerEmission,
} from './services/injection-budget';
import { runModelPreflight } from './services/model-preflight';
import { scheduleVersionCheck } from './services/version-check.js';
import { loadSnapshot } from './session/snapshot-reader.js';
import { createSnapshotWriterHook } from './session/snapshot-writer.js';
import {
	ensureAgentSession,
	getActiveWindow,
	getAgentSession,
	getFinalPromptPressure,
	getSessionBudgetPct,
	swarmState,
} from './state';
import {
	emit as emitTelemetry,
	initTelemetry,
	startHeartbeatTracking,
	telemetry,
} from './telemetry';
import { buildPluginToolObject } from './tools/plugin-registration';
import { error, log, warn } from './utils';
import { pushAdvisory } from './utils/advisory-queue';
import { setGitBinaryOverride } from './utils/git-executable';
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
// Upper bound on distinct session keys tracked for heartbeat throttling. Values are
// timestamps (not timer handles), so eviction needs no clearInterval/clearTimeout.
const MAX_TRACKED_HEARTBEAT_SESSIONS = 500;

/**
 * FIFO-cap a session-keyed Map to at most `max` entries, evicting oldest first.
 * Values tracked by these maps are plain data (timestamps/usage snapshots), never
 * timer handles, so eviction requires no clearInterval/clearTimeout. Exported for
 * unit testing of the cap invariant; used by the heartbeat throttle and
 * delegation-telemetry pairing paths below.
 */
export function capSessionMap<K, V>(map: Map<K, V>, max: number): void {
	while (map.size > max) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/**
 * Delegation-telemetry pairing state: callID → identity recorded when
 * `delegation_begin` was emitted for an admitted Task call. The Task handoff in
 * `tool.execute.after` consumes (get + delete) the entry so its
 * `delegation_end` carries the IDENTICAL sessionId/agentName/taskId as the
 * begin event. Deliberately self-owned: the `getStoredInputArgs` snapshot is
 * populated by guardrails/knowledge hooks, so relying on it would recreate the
 * feature-gating defect this map exists to fix (delegation_begin was
 * unreachable with `guardrails.enabled: false`). An entry is deleted when its
 * delegation_end is emitted; entries whose end never fires (background
 * "running" placeholders, sessions torn down mid-delegation) are bounded by
 * the `capSessionMap` FIFO cap.
 */
const _delegationTelemetryByCallID = new Map<
	string,
	{ agentName: string; taskId: string }
>();
const MAX_TRACKED_DELEGATION_TELEMETRY = 500;

/** @internal — test-only: clears delegation-telemetry pairing state so one
 * test's unconsumed entries (e.g. a before with no matching after) cannot
 * leak into the next. Mirrors resetTelemetryForTesting / resetSwarmState. */
export function _resetDelegationTelemetryPairingForTesting(): void {
	_delegationTelemetryByCallID.clear();
	pendingCostCorrectionByChildSession.clear();
	latestAssistantUsageBySession.clear();
}

import { applyLanePermissions } from './config/lane-permissions.js';
import {
	addDeferredWarning,
	advisoryWarn,
	clearDeferredWarnings,
} from './services/warning-buffer.js';

const SWARM_COMMAND_SYSTEM_RULE_TAG = '[opencode-swarm:swarm-command-rule]';
const PACKAGE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
// Upper bound for the DEFERRED bundled-skill materialization. The sync runs from
// the wrapper-owned post-resolution queue, so this ceiling does not count
// toward init latency (Invariant 1); it only protects the background task from
// running unboundedly. The copy is content-aware and bounded to ≤64 small files
// (<512KB total), so it completes in single-digit ms on a healthy FS and skips
// byte-identical files after the first run. The generous 2s ceiling is
// belt-and-suspenders for
// pathological filesystems (antivirus interception, NFS stalls) — on timeout we
// fail open and the command-path sync remains a backstop.
const SYNC_BUNDLED_SKILLS_TIMEOUT_MS = 2_000;
/** Issue #2104: hard budget for the deferred post-init background maintenance pass. */
const BACKGROUND_MAINTENANCE_INIT_TIMEOUT_MS = 10_000;

/**
 * Issue #2041 — one bounded, fail-open post-resolution pass of the PRM
 * trajectory/replay age+count cleanup. A project whose sessions never go
 * delegation-active would otherwise never reap idle files (the lazy trigger
 * rides on PRM-active tool calls), so plugin load schedules exactly one
 * sweep on the wrapper-owned post-resolution queue — never on the
 * server()-resolution path (Invariant 1).
 */
const TRAJECTORY_CLEANUP_INIT_TIMEOUT_MS = 10_000;

// Per Invariant 1 / Issue #704 / repro-704 T1 Windows failures: the plugin
// init path used to await `loadPluginConfigWithMetaAsync` UNBOUNDED — the only
// one of the three init-path I/O reads without a `withTimeout` wrapper. On
// cold Windows CI runners with AV/indexing, the unbounded stat+read of up to
// 2 config files can add 100–1000ms of latency, contributing to T1 misses.
// 2s matches the SYNC_BUNDLED_SKILLS_TIMEOUT_MS precedent; on timeout we fail
// open via `getSafeDefaultConfigLoadResult()` (empty config + guardrails
// enabled), which is the same shape the loader itself returns for any config
// read error. See `docs/audits/test-stability-audit.md` (issue #1782).
const LOAD_PLUGIN_CONFIG_TIMEOUT_MS = 2_000;

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

		const banner = [
			SWARM_COMMAND_SYSTEM_RULE_TAG,
			'When a user asks for a supported /swarm command and the message instructs you to call the `swarm_command` tool, call that tool exactly once with the provided JSON arguments. After the tool returns, show the tool output verbatim and do not add extra swarm state, summaries, or invented command output.',
		].join('\n');
		system.push(banner);
		output.system = system;
		// #2107 §2: fixed/base content — the banner is COUNTED against the turn
		// ledger (never claimed). System-surface producer: final accounting adds
		// this emission to the total because output.system is invisible to the
		// messages chain.
		if (sessionID) {
			recordProducerEmission(
				sessionID,
				'swarm-command-banner',
				estimateTokens(banner),
				0,
				'system',
			);
		}
	};
}

type PostResolutionTask = () => void | Promise<void>;

/**
 * Start detached initialization work only after the plugin manifest promise can
 * settle. A microtask queued from inside `initializeOpenCodeSwarm` is not truly
 * deferred when that function still has later awaits: the microtask can start
 * expensive filesystem work while `server()` remains unresolved (issue #704).
 */
function schedulePostResolutionTasks(
	tasks: readonly PostResolutionTask[],
): void {
	if (tasks.length === 0) return;
	const timer = setTimeout(() => {
		for (const task of tasks) {
			try {
				void Promise.resolve(task()).catch((err: unknown) => {
					log('post-resolution startup task failed (non-fatal)', {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			} catch (err) {
				log('post-resolution startup task failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}, 0);
	if (typeof (timer as { unref?: () => void }).unref === 'function') {
		(timer as { unref: () => void }).unref();
	}
}

let createRepoGraphBuilderHookForInit = createRepoGraphBuilderHook;
let schedulePostResolutionTasksForInit = schedulePostResolutionTasks;
// Init-path I/O indirections (issue #1782): the three parallelized reads in
// `initializeOpenCodeSwarm` route through these aliases so tests can inject
// stalls / failures deterministically (the `overrideIndexInternalsForTest`
// seam extension below). Default assignment preserves production behavior.
let loadPluginConfigWithMetaAsyncForInit = loadPluginConfigWithMetaAsync;
let loadSnapshotForInit = loadSnapshot;
let ensureSwarmGitExcludedForInit = ensureSwarmGitExcluded;
let resolveAutoReviewConfigForInit = resolveAutoReviewConfig;
type RegenerateMemoryReflectionForInit = (
	directory: string,
	config: Partial<RuntimeMemoryConfig>,
) => Promise<unknown>;
let regenerateMemoryReflectionForInit: RegenerateMemoryReflectionForInit =
	async (directory, config) => {
		const { regenerateMemoryReflection } = await import(
			'./memory/reflection-service.js'
		);
		return regenerateMemoryReflection(directory, config);
	};

export function overrideIndexInternalsForTest(overrides: {
	createRepoGraphBuilderHook?: typeof createRepoGraphBuilderHook;
	schedulePostResolutionTasks?: typeof schedulePostResolutionTasks;
	loadPluginConfigWithMetaAsync?: typeof loadPluginConfigWithMetaAsync;
	loadSnapshot?: typeof loadSnapshot;
	ensureSwarmGitExcluded?: typeof ensureSwarmGitExcluded;
	resolveAutoReviewConfig?: typeof resolveAutoReviewConfig;
	regenerateMemoryReflection?: RegenerateMemoryReflectionForInit;
}): () => void {
	const previousCreateRepoGraphBuilderHook = createRepoGraphBuilderHookForInit;
	const previousSchedulePostResolutionTasks =
		schedulePostResolutionTasksForInit;
	const previousLoadPluginConfigWithMetaAsync =
		loadPluginConfigWithMetaAsyncForInit;
	const previousLoadSnapshot = loadSnapshotForInit;
	const previousEnsureSwarmGitExcluded = ensureSwarmGitExcludedForInit;
	const previousResolveAutoReviewConfig = resolveAutoReviewConfigForInit;
	const previousRegenerateMemoryReflection = regenerateMemoryReflectionForInit;
	if (overrides.createRepoGraphBuilderHook) {
		createRepoGraphBuilderHookForInit = overrides.createRepoGraphBuilderHook;
	}
	if (overrides.schedulePostResolutionTasks) {
		schedulePostResolutionTasksForInit = overrides.schedulePostResolutionTasks;
	}
	if (overrides.loadPluginConfigWithMetaAsync) {
		loadPluginConfigWithMetaAsyncForInit =
			overrides.loadPluginConfigWithMetaAsync;
	}
	if (overrides.loadSnapshot) {
		loadSnapshotForInit = overrides.loadSnapshot;
	}
	if (overrides.ensureSwarmGitExcluded) {
		ensureSwarmGitExcludedForInit = overrides.ensureSwarmGitExcluded;
	}
	if (overrides.resolveAutoReviewConfig) {
		resolveAutoReviewConfigForInit = overrides.resolveAutoReviewConfig;
	}
	if (overrides.regenerateMemoryReflection) {
		regenerateMemoryReflectionForInit = overrides.regenerateMemoryReflection;
	}
	return () => {
		createRepoGraphBuilderHookForInit = previousCreateRepoGraphBuilderHook;
		schedulePostResolutionTasksForInit = previousSchedulePostResolutionTasks;
		loadPluginConfigWithMetaAsyncForInit =
			previousLoadPluginConfigWithMetaAsync;
		loadSnapshotForInit = previousLoadSnapshot;
		ensureSwarmGitExcludedForInit = previousEnsureSwarmGitExcluded;
		resolveAutoReviewConfigForInit = previousResolveAutoReviewConfig;
		regenerateMemoryReflectionForInit = previousRegenerateMemoryReflection;
	};
}

export function schedulePostResolutionTasksForTest(
	tasks: readonly PostResolutionTask[],
): void {
	schedulePostResolutionTasks(tasks);
}

/**
 * Compute the effective set of tools eligible for line-based truncation.
 *
 * SUMMARIZER_EXEMPT_TOOL_NAMES is applied as an unconditional floor
 * subtraction against BOTH the default allowlist and any operator-configured
 * `tool_output.truncation_tools` override (finding R6). Line-truncating a
 * lane/retrieval tool's payload destroys the `output_ref` rows a caller needs
 * to recover the full content — the same unrecoverable-payload defect class
 * the summarizer/context-budget floor already guards against — so operator
 * config must never be able to reintroduce it via this separate rewriting
 * layer.
 */
export function computeEffectiveTruncatableTools(
	defaultTools: ReadonlySet<string>,
	configuredTools: readonly string[] | undefined,
): Set<string> {
	const effective =
		configuredTools && configuredTools.length > 0
			? new Set(configuredTools)
			: new Set(defaultTools);
	for (const exempt of SUMMARIZER_EXEMPT_TOOL_NAMES) {
		effective.delete(exempt);
	}
	return effective;
}

const OpenCodeSwarm: Plugin = async (ctx) => {
	const postResolutionTasks: PostResolutionTask[] = [];
	try {
		const hooks = await initializeOpenCodeSwarm(ctx, postResolutionTasks);
		schedulePostResolutionTasksForInit(postResolutionTasks);
		return hooks;
	} catch (err) {
		// OpenCode's plugin loader silently drops plugins whose entry rejects,
		// leaving the user staring at "in plugins" with no commands/agents and no
		// visible error (issue #675). Surface init failures to stderr so the real
		// cause is visible, then re-throw so the host still observes the rejection.
		const stack =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		// Intentional FATAL surface: OpenCode's plugin loader silently drops a
		// plugin whose entry rejects, leaving the user with no commands/agents
		// and no visible error (issue #675). Raw stderr here is the one place it
		// is justified. biome-ignore added in PR5 of epic #1752 when noConsole was enabled.
		// biome-ignore lint/suspicious/noConsole: FATAL initialization failure — user must see this to debug plugin load issues (issue #675)
		console.error(
			'[opencode-swarm] FATAL: plugin initialization failed. Plugin will not be available.',
		);
		// biome-ignore lint/suspicious/noConsole: FATAL initialization failure — user must see this to debug plugin load issues (issue #675)
		console.error(stack);
		throw err;
	}
};

const MAX_TRACKED_ASSISTANT_USAGE_EVENTS = 200;
const latestAssistantUsageBySession = new Map<string, unknown>();

type PendingCostCorrection = {
	recordId: string;
	identityFingerprint: string;
	parentSessionId: string;
	parentSessionDigest: string;
	agentName: string;
	taskId: string;
	model: string;
	gate?: string;
	retryIndex?: number;
	pricing?: CostPricingConfig;
	version: number;
	currentFields: DelegationCostFields;
};

const pendingCostCorrectionByChildSession = new Map<
	string,
	PendingCostCorrection
>();

function trackPendingCostCorrection(
	childSessionId: string,
	pending: PendingCostCorrection,
): void {
	pendingCostCorrectionByChildSession.delete(childSessionId);
	pendingCostCorrectionByChildSession.set(childSessionId, pending);
	while (
		pendingCostCorrectionByChildSession.size >
		MAX_TRACKED_ASSISTANT_USAGE_EVENTS
	) {
		const oldest = pendingCostCorrectionByChildSession.keys().next().value;
		if (oldest === undefined) break;
		pendingCostCorrectionByChildSession.delete(oldest);
	}
}

function emitPendingCostCorrection(sessionId: string, raw: unknown): boolean {
	const pending = pendingCostCorrectionByChildSession.get(sessionId);
	if (!pending) return false;
	const fields = buildDelegationCostFields({
		raw,
		model: pending.model,
		gate: pending.gate,
		retry_index: pending.retryIndex,
		pricing: pending.pricing,
	});
	// A partial or unknown-currency late event is retained in the ordinary usage
	// cache, but cannot replace the initial snapshot.
	if (fields.evidence_status !== 'complete') return true;
	if (
		!isCostUpgrade(
			pending.currentFields.cost_evidence ?? [],
			fields.cost_evidence ?? [],
		)
	) {
		return true;
	}
	const nextVersion = pending.version + 1;
	emitTelemetry(
		'delegation_cost_correction' as Parameters<typeof emitTelemetry>[0],
		{
			sessionId: pending.parentSessionId,
			agentName: pending.agentName,
			taskId: pending.taskId,
			record_id: pending.recordId,
			identity_fingerprint: pending.identityFingerprint,
			parent_session_digest: pending.parentSessionDigest,
			version: nextVersion,
			...fields,
		},
	);
	pending.version = nextVersion;
	pending.currentFields = fields;
	return true;
}

function recoverPendingCostCorrection(
	directory: string,
	parentSessionId: string,
	pricing?: CostPricingConfig,
): PendingCostCorrection | null | undefined {
	const events = readTelemetryEvents(directory);
	const folded = foldTelemetryEvents(events);
	if (folded.stats.rejected_corrections > 0) return undefined;
	const parentSessionDigest = createHash('sha256')
		.update(`delegation-cost-parent-v1\0${parentSessionId}`)
		.digest('hex')
		.slice(0, 32);
	const candidates = folded.events.filter(
		(event) =>
			event.event === 'delegation_end' &&
			event.parent_session_digest === parentSessionDigest &&
			event.cost_source !== 'reported' &&
			typeof event.record_id === 'string' &&
			typeof event.identity_fingerprint === 'string',
	);
	// Zero candidates commonly means usage arrived before Task terminal; retain
	// the already-bounded usage cache and let the terminal path consume it.
	if (candidates.length === 0) return null;
	if (candidates.length !== 1) return undefined;
	const event = candidates[0];
	const effective = event;
	if (effective.cost_source === 'reported') return null;
	const currentFields = {
		tokens_input:
			typeof effective.tokens_input === 'number' ? effective.tokens_input : 0,
		tokens_output:
			typeof effective.tokens_output === 'number' ? effective.tokens_output : 0,
		tokens_reasoning:
			typeof effective.tokens_reasoning === 'number'
				? effective.tokens_reasoning
				: 0,
		tokens_cache:
			typeof effective.tokens_cache === 'number' ? effective.tokens_cache : 0,
		cost_usd:
			typeof effective.cost_usd === 'number' ? effective.cost_usd : null,
		cost_source:
			effective.cost_source === 'reported' ||
			effective.cost_source === 'estimated'
				? effective.cost_source
				: 'unavailable',
		cost_evidence: Array.isArray(effective.cost_evidence)
			? (effective.cost_evidence as DelegationCostFields['cost_evidence'])
			: undefined,
	} satisfies DelegationCostFields;
	return {
		recordId: event.record_id as string,
		identityFingerprint: event.identity_fingerprint as string,
		parentSessionId,
		parentSessionDigest,
		agentName:
			typeof event.agentName === 'string' ? event.agentName : 'unknown',
		taskId: typeof event.taskId === 'string' ? event.taskId : '',
		model: typeof event.model === 'string' ? event.model : 'unknown',
		gate: typeof event.gate === 'string' ? event.gate : undefined,
		retryIndex:
			typeof event.retry_index === 'number' ? event.retry_index : undefined,
		pricing,
		version: folded.versions[event.record_id as string] ?? 1,
		currentFields,
	};
}

function rememberAssistantUsageEvent(
	input: unknown,
): { sessionId: string; raw: unknown } | undefined {
	const event = isPlainRecord(input) ? input.event : undefined;
	if (!isPlainRecord(event)) return undefined;
	if (event.type === 'message.updated') {
		const properties = isPlainRecord(event.properties)
			? event.properties
			: undefined;
		const info = isPlainRecord(properties?.info) ? properties.info : undefined;
		if (info?.role === 'assistant') {
			rememberAssistantUsage(info.sessionID, info);
			return typeof info.sessionID === 'string'
				? { sessionId: info.sessionID, raw: info }
				: undefined;
		}
		return undefined;
	}
	if (event.type === 'message.part.updated') {
		const properties = isPlainRecord(event.properties)
			? event.properties
			: undefined;
		const part = isPlainRecord(properties?.part) ? properties.part : undefined;
		if (part?.type === 'step-finish') {
			rememberAssistantUsage(part.sessionID, part);
			return typeof part.sessionID === 'string'
				? { sessionId: part.sessionID, raw: part }
				: undefined;
		}
	}
	return undefined;
}

function rememberAssistantUsage(sessionID: unknown, raw: unknown): void {
	if (typeof sessionID !== 'string' || sessionID.trim() === '') return;
	latestAssistantUsageBySession.set(sessionID, raw);
	while (
		latestAssistantUsageBySession.size > MAX_TRACKED_ASSISTANT_USAGE_EVENTS
	) {
		const oldest = latestAssistantUsageBySession.keys().next().value;
		if (oldest === undefined) break;
		latestAssistantUsageBySession.delete(oldest);
	}
}

function consumeAssistantUsageForTask(
	_parentSessionID: string,
	taskOutput: unknown,
): unknown {
	// Provider usage belongs to the delegated child. Consuming the parent's most
	// recent assistant event can silently attribute the architect's own cost to
	// a Task result when both sessions have usage (#2043).
	const sessionIDs = collectSessionIDs(taskOutput);
	for (const sessionID of sessionIDs) {
		const usage = latestAssistantUsageBySession.get(sessionID);
		if (usage !== undefined) {
			latestAssistantUsageBySession.delete(sessionID);
			return usage;
		}
	}
	return undefined;
}

function collectSessionIDs(raw: unknown): string[] {
	const found: string[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3 || !isPlainRecord(value) || seen.has(value)) return;
		seen.add(value);
		for (const key of ['sessionID', 'sessionId', 'session_id']) {
			const candidate = value[key];
			if (typeof candidate === 'string' && candidate.trim() !== '') {
				found.push(candidate);
			}
		}
		for (const key of [
			'metadata',
			'data',
			'info',
			'message',
			'response',
			'output',
		]) {
			visit(value[key], depth + 1);
		}
	};
	visit(raw, 0);
	return [...new Set(found)];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Return type intentionally inferred so the literal `{ name: ..., agent: ... }`
// does not trip excess-property checks against `Hooks`. The wrapper above is
// typed as `Plugin`, which validates the structural shape at the call site.
async function initializeOpenCodeSwarm(
	ctx: Parameters<Plugin>[0],
	postResolutionTasks: PostResolutionTask[],
) {
	// Issue #2236 RC3 item 3: the running plugin version was never logged at
	// startup, so a user hitting a stale-cache/behavior-mismatch issue had no
	// way to confirm which version was actually loaded (packageJson.version
	// previously only reached observability provenance and the throttled
	// staleness warning, never a plain startup line). `packageJson.version`
	// is already imported at module scope, so this is zero extra I/O and does
	// not touch AGENTS.md invariant 1.
	// STDERR, not stdout. This is the only unconditional line the plugin runtime
	// emits, and the host may use stdout for structured protocol traffic — a
	// startup banner there risks corrupting it. Every other always-emitted
	// operator signal in this repo goes to stderr (`criticalWarn`,
	// src/utils/logger.ts); `console.warn` is used directly rather than
	// `criticalWarn` because this is not a warning and should not carry that
	// label. #2236 needs it because the reporter could not identify which
	// plugin version was actually loaded.
	// biome-ignore lint/suspicious/noConsole: Startup version line — user must be able to identify the running plugin version to diagnose stale-cache issues (issue #2236)
	console.warn(`[opencode-swarm] running v${packageJson.version}`);

	// Clear deferred warnings at the very start of the session, BEFORE any
	// init-path work that buffers advisories via advisoryWarn (config load,
	// ensureSwarmGitExcluded, writeProjectConfigIfNew). The clear isolates the
	// new session from the PREVIOUS session's buffer; running it after config
	// load (the historical placement) would wipe the current session's
	// config-validation warnings before /swarm diagnose can surface them
	// (epic #1752 PR2 — config-load warnings now route through advisoryWarn,
	// not raw stderr, so the buffer is the only /swarm diagnose channel).
	clearDeferredWarnings();

	// PARALLEL INIT I/O (issue #1782 / repro-704 T1 Windows failures).
	//
	// Three independent bounded reads used to be awaited SEQUENTIALLY here:
	//   (1) loadPluginConfigWithMetaAsync — reads `.opencode/` config
	//   (2) loadSnapshot                  — reads `.swarm/session-snapshot.json`
	//   (3) ensureSwarmGitExcluded       — runs `git rev-parse` + writes `.git/info/exclude`
	//
	// Verified independent (cross-checked by two independent plan-critic rounds):
	//   - loadSnapshot has NO `config` import (`src/session/snapshot-reader.ts`
	//     imports only fs, state, hooks/utils, bun-compat, logger).
	//   - loadPluginConfigWithMetaAsync does only `stat`+`readFile`+pure
	//     computation; writes nothing other `init` steps read.
	//   - ensureSwarmGitExcluded's `quiet` option is currently void-discarded
	//     (`src/utils/gitignore-warning.ts:223-224`), so passing `{ quiet: false }`
	//     is behavior-identical to the prior `{ quiet: config.quiet }`.
	//   - `_swarmGitExcludedChecked` deduplication is sync check-and-set before
	//     any `await`, so parallel invocation cannot double-spawn git.
	//
	// On cold Windows CI runners with AV/indexing, each step can take 100–500ms;
	// the prior sequential shape summed them, easily exceeding the 400ms
	// repro-704 T1 deadline. Parallelizing drops the floor to `max()` of the
	// three. Snapshot and Git hygiene are additionally skipped when a bounded
	// filesystem preflight proves there is no `.swarm/` state or Git boundary;
	// those operations cannot produce useful work in a source-only workspace.
	// Promise.all preserves the in-source ordering contract at `src/index.ts`
	// (the `.swarm/` writes below run only after all scheduled reads resolve, so
	// `ensureSwarmGitExcluded` still completes before any `.swarm/` artifact is
	// created).
	const __initIoStart = performance.now();
	const configLoadP = withTimeout(
		loadPluginConfigWithMetaAsyncForInit(ctx.directory),
		LOAD_PLUGIN_CONFIG_TIMEOUT_MS,
		new Error(
			`loadPluginConfigWithMetaAsync exceeded ${LOAD_PLUGIN_CONFIG_TIMEOUT_MS}ms budget; continuing with safe-default config`,
		),
	).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		log('loadPluginConfig timed out or failed (non-fatal)', { error: msg });
		// advisoryWarn (not debug log) so `/swarm diagnose` surfaces this: on
		// this path the user's agents/models/guardrails/full_auto settings are
		// silently ignored for the entire session. The safe-default shape
		// matches what the loader itself returns when no config file exists.
		advisoryWarn(
			`[opencode-swarm] Config load exceeded ${LOAD_PLUGIN_CONFIG_TIMEOUT_MS}ms budget; running with default configuration for this session.`,
		);
		return getSafeDefaultConfigLoadResult();
	});
	const snapshotP = hasSwarmState(ctx.directory)
		? withTimeout(
				loadSnapshotForInit(ctx.directory),
				5_000,
				new Error(
					'loadSnapshot exceeded 5s budget; continuing without snapshot rehydration',
				),
			).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				log('loadSnapshot timed out or failed (non-fatal)', { error: msg });
			})
		: Promise.resolve();
	const gitExcludeP = hasGitMarkerAncestor(ctx.directory)
		? withTimeout(
				// `quiet` defaults to false; the option is currently void-discarded in
				// `ensureSwarmGitExcluded` (src/utils/gitignore-warning.ts:223-224), so
				// dropping `{ quiet: config.quiet }` is behavior-identical AND lets us
				// parallelize without waiting on the config read.
				ensureSwarmGitExcludedForInit(ctx.directory),
				ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS,
				new Error(
					`ensureSwarmGitExcluded exceeded ${ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS}ms budget; continuing without git-hygiene check`,
				),
			).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				log('ensureSwarmGitExcluded timed out or failed (non-fatal)', {
					error: msg,
				});
			})
		: Promise.resolve();
	// Phase 4b: resolve language-agnostic project context in parallel with the
	// other independent init reads. Starting the lazy backend import here keeps
	// its cold-module cost off the tail of the critical path while preserving the
	// existing requirement that prompt construction waits for the result. A
	// source-only workspace has no possible backend context, so skip the heavy
	// language-backend graph entirely after the cheap bounded ancestor preflight.
	const projectContextP = hasManifestAncestor(ctx.directory)
		? withTimeout(
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
			})
		: Promise.resolve(null);
	await Promise.all([configLoadP, snapshotP, gitExcludeP, projectContextP]);
	const { config, loadedFromFile } = await configLoadP;
	log(
		`init-path I/O completed in ${(performance.now() - __initIoStart).toFixed(1)}ms (parallel: config+snapshot+git-exclude)`,
	);

	// Register the git-executable resolver override once per init (issue
	// #2236 hardening, F4). `setGitBinaryOverride` is a plain sync object
	// assignment — no I/O, no probe — so this cannot regress the init
	// budget. The env var `OPENCODE_SWARM_GIT_BINARY` always wins over this
	// config value at resolution time (src/utils/git-executable.ts).
	//
	// SECURITY (CWE-427): `config.git?.binary` is safe to pass straight
	// through because the loader has already stripped any PROJECT-supplied
	// value — `git.binary` is honored only from the user-level config and the
	// env var, since a repo can commit both a config naming a shim and the
	// shim itself (`enforceGitBinaryProvenance`, src/config/loader.ts).
	setGitBinaryOverride(config.git?.binary);

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
				// biome-ignore lint/suspicious/noConsole: Full-auto mode warning — user must see when critic/architect models match
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
				// biome-ignore lint/suspicious/noConsole: User-facing warning about missing fallback_models — must reach user even when config.quiet=false
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

	// `loadSnapshot` was awaited in the parallel block above. Its comment
	// (preserved here for context): bounded with a 5s timeout (issue #704);
	// read-only, so timing out is safe — it only affects rehydration, not
	// durable state. A slow filesystem (network home, iCloud-backed mount)
	// must never block the plugin host's `await server(...)` indefinitely.

	// Observability provenance/lineage (issue #2029) must be established BEFORE
	// `initTelemetry`, so no `emit()` can produce an observation with empty
	// lineage. `initObservability` performs zero I/O — it only hashes strings
	// already in memory — so it adds no measurable cost to the bounded init path
	// (AGENTS.md invariant 1) and it never throws (AGENTS.md invariant 1
	// "fail-open"): plugin registration resolves even if it fails.
	//
	// `gitSha` and `configHash` are deliberately absent, i.e. explicitly UNKNOWN
	// rather than zero (issue #2029 item 4). Init already shells out to git via
	// `ensureSwarmGitExcluded`, but only for `rev-parse --show-toplevel` and
	// `--git-path info/exclude`; neither yields a HEAD SHA, and adding a third
	// init-path subprocess to obtain one is exactly what invariant 1 forbids.
	// Populating it is #2047's call, off the init path.
	initObservability({
		directory: ctx.directory,
		provenance: {
			pluginVersion: packageJson.version,
			// Detected via `process.versions`, never a `Bun` global reference —
			// AGENTS.md invariant 2 confines `Bun.*` to src/utils/bun-compat.ts,
			// and this module must stay Node-ESM-loadable.
			runtime: process.versions.bun === undefined ? 'node' : 'bun',
			runtimeVersion: process.versions.bun ?? process.versions.node,
			os: process.platform,
			arch: process.arch,
		},
	});

	// Construct the repo-graph hook before any other side-task, but register its
	// scan with the wrapper-owned post-resolution queue. Issue #704: the
	// previous code invoked `repoGraphHook.init()` inline; because async
	// function bodies execute synchronously up to the first `await`, the
	// inline call blocked the event loop on the recursive workspace scan.
	// The fix is twofold: (a) `init()` itself yields before doing any work
	// and uses an async chunked walker; (b) the wrapper starts it from an
	// unref'd timer only after `initializeOpenCodeSwarm` resolves, with a 30s
	// watchdog around the detached scan.
	// Ensure .swarm/ exists before repo graph init tries to save the first graph.
	initTelemetry(ctx.directory);
	startHeartbeatTracking();

	const repoGraphConfig = RepoGraphConfigSchema.parse(config.repo_graph ?? {});
	const repoGraphHookFactory = createRepoGraphBuilderHookForInit;
	const repoGraphHook = repoGraphConfig.enabled
		? repoGraphHookFactory(ctx.directory, undefined, {
				enabled: true,
				initRefresh: repoGraphConfig.init_refresh,
				refreshCap: repoGraphConfig.refresh_cap,
				walkBudgetMs: repoGraphConfig.walk_budget_ms,
				maxFiles: repoGraphConfig.max_files,
				excludeDirs: repoGraphConfig.exclude_dirs,
			})
		: null;
	let repoGraphInitPromise: Promise<void> | undefined;
	if (repoGraphHook) {
		postResolutionTasks.push(() => {
			const watchdog = setTimeout(() => {
				log(
					'[repo-graph] init exceeded 30s budget; scan will continue but is overdue',
				);
			}, 30_000);
			if (typeof (watchdog as { unref?: () => void }).unref === 'function') {
				(watchdog as { unref: () => void }).unref();
			}
			repoGraphInitPromise = repoGraphHook
				.init()
				.catch(() => {
					/* logged inside init */
				})
				.finally(() => clearTimeout(watchdog));
		});
	}

	// Issue #2271 bug 4: model-resolution preflight runs OFF the resolution
	// path (it makes an HTTP call to the host's provider catalog — exactly the
	// class of work invariant 1 keeps out of `server()` awaits). Pushed AFTER
	// the repo-graph task: tests and tooling index the post-resolution queue,
	// and the #704 ordering contract invokes scheduledTasks[0] as the
	// repo-graph scan. Fail-open by construction: catalog errors surface
	// nothing, and only a POSITIVE unresolved detection warns.
	postResolutionTasks.push(() => {
		void runModelPreflight(config, swarmState.opencodeClient)
			.then((result) => {
				if (!result.catalogAvailable) return;
				const unresolved = result.resolutions.filter(
					(resolution) => resolution.status === 'unresolved',
				);
				if (unresolved.length === 0) return;
				const lines = unresolved.map(
					(resolution) =>
						`  ${resolution.agent}: ${resolution.model} (${resolution.detail ?? 'does not resolve'})`,
				);
				const msg =
					`[opencode-swarm] WARNING: ${unresolved.length} configured agent model(s) do not resolve against the provider catalog:\n` +
					`${lines.join('\n')}\n` +
					'Dispatching these agents will fail permanently ("Model not found"/"Forbidden"). ' +
					'Fix agents.<role>.model in opencode-swarm.json (or remove the override to fall back to the default).';
				if (!config.quiet) {
					// biome-ignore lint/suspicious/noConsole: user-facing operational warning — must be visible even outside debug mode
					console.warn(msg);
				} else {
					addDeferredWarning(msg);
				}
				for (const resolution of unresolved) {
					telemetry.modelUnresolved(
						resolution.agent,
						resolution.model,
						resolution.detail ?? 'does not resolve',
					);
				}
			})
			.catch(() => {
				/* fail-open: preflight must never surface as an error */
			});
	});

	// `ensureSwarmGitExcluded` was awaited in the parallel block above. Its
	// comment (preserved here for context): protects .swarm/ from Git before
	// any write; uses git CLI so worktrees and submodules (where .git is a
	// file, not a directory) are handled correctly. HARD-BOUNDED via
	// withTimeout because the OpenCode plugin host silently drops a plugin
	// whose entry never resolves (issue #704). Promise.all above guarantees
	// the exclude write completes before any `.swarm/` artifact is created
	// below — matching the in-source ordering contract.

	// FR-103: Startup orphan recovery — reclaim orphaned worktrees and branches
	// from crashed sessions. At plugin init no sessions are active yet, so
	// runInitOrphanRecovery with an empty activeSessionIds array will remove
	// ALL swarm-lane branches (orphans). git worktree prune cleans up stale
	// worktree metadata. Results are written to .swarm/advisories/ so the
	// architect sees any state-unreadable conditions on their NEXT TURN.
	//
	// DEFERRED via the wrapper-owned post-resolution queue (NOT awaited on the
	// server()-resolution path) per Invariant 1 / Issue #704.
	// Fails open so plugin init is never blocked. The companion hook
	// createInitOrphanRecoveryAdvisoryHook surfaces results to the architect
	// on their first turn after plugin init.
	postResolutionTasks.push(() => {
		void runInitOrphanRecovery(ctx.directory).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			log('initOrphanRecovery failed (non-fatal)', { error: msg });
		});
	});

	// Issue #2041 — one bounded, fail-open PRM trajectory/replay cleanup pass.
	// The lazy trigger inside the PRM hook only fires for sessions that go
	// delegation-active; a project that never delegates would otherwise never
	// reap idle trajectory files. This pass rides the wrapper-owned
	// post-resolution queue (never the server()-resolution path) and fails
	// open. Bound honesty (maintainer review #2395): withTimeout bounds only
	// how long the SCHEDULER waits before giving up on the awaited promise —
	// the fire-and-forget sweep itself is bounded by the sweeper's own
	// maxDeletionsPerRun/maxFilesPerDir caps, not by the timeout. The lazy
	// per-session trigger and every subsequent plugin load remain as backstops.
	postResolutionTasks.push(function trajectoryCleanupPostInitTask() {
		return withTimeout(
			cleanupOldTrajectoryFiles(ctx.directory),
			TRAJECTORY_CLEANUP_INIT_TIMEOUT_MS,
			new Error(
				`trajectory cleanup exceeded ${TRAJECTORY_CLEANUP_INIT_TIMEOUT_MS}ms post-init budget; continuing without it (lazy per-session cleanup remains a backstop)`,
			),
		)
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				log('post-init trajectory cleanup timed out or failed (non-fatal)', {
					error: msg,
				});
			})
			.then(() => undefined);
	});

	// Issue #2104 — maintenance point P5: one deferred, time-bounded,
	// non-fatal background maintenance pass after plugin registration. It only
	// runs when the operator opted into hooks.background_subagents (default
	// false), so default configurations schedule no work at all. Like the
	// bundled-skill sync above it lives on the wrapper-owned post-resolution
	// queue — never on the server()-resolution path — and is hard-bounded by
	// withTimeout; on timeout/error it fails open (other maintenance points
	// remain as backstops).
	if (
		(config.hooks as Record<string, unknown> | undefined)
			?.background_subagents === true
	) {
		postResolutionTasks.push(function backgroundMaintenancePostInitTask() {
			// Returned (not `void`ed) so the task is awaitable like
			// regenerateMemoryReflectionTask — tests and any future awaiter of
			// the post-resolution queue can observe completion. The scheduler
			// already treats tasks as void | Promise<void>.
			return withTimeout(
				import('./background/pending-delegations.js').then((m) =>
					m.maintainBackgroundDelegations(ctx.directory, {
						lockTimeoutMs: 5_000,
						reason: 'post-init',
						onLegacyCoderSettlementReconciled:
							backgroundCompletionObserver.reconcilePending,
						onLegacyCoderSettlementAdvisoryReplaced:
							backgroundCompletionObserver.notifyLegacyCoderSettlementAdvisoryReplaced,
					}),
				),
				BACKGROUND_MAINTENANCE_INIT_TIMEOUT_MS,
				new Error(
					`background maintenance exceeded ${BACKGROUND_MAINTENANCE_INIT_TIMEOUT_MS}ms post-init budget; continuing without it (other maintenance points remain)`,
				),
			)
				.catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					log(
						'post-init background maintenance timed out or failed (non-fatal)',
						{
							error: msg,
						},
					);
				})
				.then(() => undefined);
		});
	}

	// Side tasks are small and scoped to `<ctx.directory>/.swarm/`
	// or `<ctx.directory>/.opencode/`, so none risks a home-tree scan.
	writeSwarmConfigExampleIfNew(ctx.directory);
	writeProjectConfigIfNew(ctx.directory, config.quiet);
	// Materialize the bundled architect MODE skills into the project so the
	// architect's first auto-entered mode (e.g. SPECIFY on a fresh project) can
	// load its `.swarm/bundled-skills/<mode>/SKILL.md` without first running a /swarm
	// command and restarting the session. Previously these were synced ONLY as a
	// side effect of a subset of /swarm commands (commands/registry.ts), so a
	// brand-new project's architect hit missing skill files on turn one and a
	// weaker model would hallucinate the workflow instead of executing it.
	//
	// DEFERRED via the wrapper-owned post-resolution queue (NOT awaited on the
	// server()-resolution path) per Invariant 1 / Issue #704. The
	// sync touches the bounded bundled-skill inventory; awaiting it inline added cold-FS
	// latency that pushed server() past the 400ms repro-704 T1 deadline on
	// Windows. Deferring keeps server() fast: the sync starts from the wrapper's
	// post-resolution timer and runs in the background. The architect normally
	// cannot read a SKILL.md until a later tool turn, and command-path sync remains
	// a backstop if that practical timing assumption does not hold. It is
	// still HARD-BOUNDED + fail-open: the async variant yields between files so
	// withTimeout (which unref's its timer) can bound it; content-equality-checked,
	// atomic-overwrite-with-rollback, symlink-guarded, byte/file-bounded. On timeout/error we
	// fail open — the command-path sync remains as a backstop.
	postResolutionTasks.push(() => {
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
		postResolutionTasks.push(() => {
			scheduleVersionCheck(packageJson.version, (msg) => {
				if (config.quiet) {
					addDeferredWarning(msg);
				} else {
					// biome-ignore lint/suspicious/noConsole: Version check warning — must surface to user when not quiet
					console.warn(msg);
				}
			});
		});
	}
	// `projectContextP` was started alongside config/snapshot/git I/O above and
	// is already settled before prompt construction. The bounded, fail-open
	// result supplies `null` when backend detection is unavailable; prompts then
	// retain their unresolved sentinels for the architect's DISCOVER mode.
	const projectContext = await projectContextP;

	let autoReviewConfig: AutoReviewConfig;
	try {
		autoReviewConfig = resolveAutoReviewConfigForInit(config.auto_review ?? {});
	} catch (error) {
		addDeferredWarning(
			`[swarm] Invalid auto_review configuration; auto-review is disabled until corrected: ${error instanceof Error ? error.message : String(error)}`,
		);
		autoReviewConfig = resolveAutoReviewConfigForInit({ enabled: false });
	}
	// Agent prompts must use the same release-aware resolution as runtime hooks.
	// In particular, a future approved v8 default must not leave the reviewer on
	// the legacy output contract merely because `auto_review` was omitted.
	const configWithResolvedAutoReview = {
		...config,
		auto_review: autoReviewConfig,
	};
	const agents = getAgentConfigs(
		configWithResolvedAutoReview,
		ctx.directory,
		undefined,
		projectContext ?? undefined,
	);
	// PRR-004 (issue #1649 observability): emit the rendered architect prompt
	// size at session init so operators and support traces can see the budget
	// without re-running tests. Debug-gated — visible only when
	// OPENCODE_SWARM_DEBUG=1, never to chat-visible streams. Find the largest
	// architect prompt across all swarms so multi-swarm configs (where
	// `agents.architect` is undefined and only `cloud_architect`/
	// `mega_architect` are present) still produce a meaningful value.
	const largestArchitectChars = Object.entries(agents).reduce(
		(max, [name, cfg]) => {
			if (!name.endsWith('_architect') && name !== 'architect') return max;
			const len = (cfg as { prompt?: string }).prompt?.length ?? 0;
			return len > max ? len : max;
		},
		0,
	);
	log('architect prompt size', {
		chars: largestArchitectChars,
	});
	const agentDefinitions = createAgents(
		configWithResolvedAutoReview,
		projectContext ?? undefined,
	);
	const agentDefinitionMap = Object.fromEntries(
		agentDefinitions.map((agent) => [agent.name, agent]),
	);
	const instanceGeneratedAgentNames = Object.freeze(Object.keys(agents));

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
	swarmState.curatorConsolidationAgentNames = Object.keys(agents).filter(
		(k) =>
			k === 'curator_consolidation' || k.endsWith('_curator_consolidation'),
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
	swarmState.generatedAgentNames = [...instanceGeneratedAgentNames];

	const pipelineHook = createPipelineTrackerHook(config, ctx.directory);
	const systemEnhancerHook = createSystemEnhancerHook(config, ctx.directory);
	const contextCapsuleInjectHook = createContextCapsuleInjectHook(
		config,
		ctx.directory,
	);
	const compactionHook = createCompactionCustomizerHook(config, ctx.directory);
	const resolveIncomingAgentModel = (agentName: string): string | undefined =>
		resolveRuntimeAgentModel(config, agents, agentName);
	const resolveTaskRouteModelChain = (
		exactAgentName: string | undefined,
	): {
		exactAgentName: string;
		role: string;
		primaryModel?: string;
		fallbackModels: readonly string[];
	} | null => {
		if (!exactAgentName) return null;
		const trimmedAgentName = exactAgentName.trim();
		if (!trimmedAgentName) return null;
		const role = stripKnownSwarmPrefix(trimmedAgentName);
		const swarmAgents = getSwarmAgents(
			extractSwarmIdFromAgentName(trimmedAgentName),
		);
		return {
			exactAgentName: trimmedAgentName,
			role,
			primaryModel:
				resolveRuntimeAgentModel(config, agents, trimmedAgentName) ??
				resolveRegisteredAgentModel(config, trimmedAgentName),
			fallbackModels: swarmAgents?.[role]?.fallback_models ?? [],
		};
	};
	const extractBoundedErrorSignal = (value: unknown, depth = 0): string[] => {
		if (depth > 4) return [];
		if (typeof value === 'string') {
			const trimmed = value.trim();
			return trimmed ? [trimmed.slice(0, 512)] : [];
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return [String(value)];
		}
		if (!value || typeof value !== 'object') return [];
		if (value instanceof Error) {
			return [
				...extractBoundedErrorSignal(value.name, depth + 1),
				...extractBoundedErrorSignal(value.message, depth + 1),
			];
		}
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of [
			'message',
			'reason',
			'code',
			'status',
			'statusCode',
			'error',
			'cause',
			'detail',
			'details',
		]) {
			parts.push(...extractBoundedErrorSignal(record[key], depth + 1));
		}
		return parts;
	};
	const extractSessionErrorSignal = (
		properties: Record<string, unknown> | undefined,
	): string => {
		if (!properties) return '';
		return extractBoundedErrorSignal(properties)
			.filter(Boolean)
			.join(' ')
			.slice(0, 2048);
	};
	const resolveTaskRouteForChildSession = (childSessionID: string) => {
		const trimmedChildSessionID = childSessionID.trim();
		if (!trimmedChildSessionID) return undefined;
		return getPendingTaskModelRouteSnapshot().find(
			(route) => route.childSessionID === trimmedChildSessionID,
		);
	};
	const lookupParentSessionIDForTaskRoute = async (
		childSessionID: string,
	): Promise<string | undefined> => {
		const sessionApi = ctx.client?.session as
			| {
					get?: (args: {
						path: { id: string };
						query: { directory: string };
					}) => Promise<{ data?: { parentID?: unknown }; error?: unknown }>;
			  }
			| undefined;
		if (!sessionApi?.get) return undefined;
		try {
			const result = await sessionApi.get({
				path: { id: childSessionID },
				query: { directory: ctx.directory },
			});
			return typeof result?.data?.parentID === 'string' &&
				result.data.parentID.trim() !== ''
				? result.data.parentID.trim()
				: undefined;
		} catch {
			return undefined;
		}
	};
	registerFullAutoRecoveryBlockerEvaluator(({ sessionID }) => {
		const invocationID = getAgentSession(sessionID)?.activeInvocationId ?? 0;
		if (invocationID <= 0) return [];
		return [
			...new Set(
				listBlockingActionCircuitsForInvocation(sessionID, invocationID).map(
					(entry) => entry.circuitKind,
				),
			),
		];
	});
	const contextBudgetHandler = createContextBudgetHandler(
		config,
		resolveIncomingAgentModel,
	);
	// #2107 §3: the ONE final accounting step (registered after
	// consolidation in the messages.transform chain).
	const finalContextAccountingStep = createFinalContextAccountingStep({
		config,
		// Same seam createContextBudgetHandler consumes: keeps the final
		// accounting step's model-identity ladder identical to physical
		// pruning's (agent handoffs included).
		resolveAgentModelFn: resolveIncomingAgentModel,
	});
	const evaluationModelDispatcher = createEvaluationModelDispatcher(
		ctx.client,
		config.pricing,
	);
	const reviewModelDispatcher = createReviewModelDispatcher(
		ctx.client,
		config.pricing,
	);
	const findingValidationScheduler = createFindingValidationScheduler();
	const reviewAgentModelRegistry = captureReviewAgentModelRegistry(
		config,
		instanceGeneratedAgentNames,
	);
	const getActiveReviewAgentName = (sessionID: string): string | undefined =>
		swarmState.activeAgent.get(sessionID) ??
		swarmState.agentSessions.get(sessionID)?.agentName;
	const roleFilterSystemHook = createRoleFilterSystemHook(
		getActiveReviewAgentName,
	);
	const commandHandler = createSwarmCommandHandler(
		ctx.directory,
		agentDefinitionMap,
		{
			getActiveAgentName: getActiveReviewAgentName,
			config,
			packageRoot: PACKAGE_ROOT,
			registeredAgents: agents,
			evaluationModelDispatcher,
			reviewModelDispatcher,
			autoReviewConfig,
			reviewAgentModelRegistry,
		},
	);
	const swarmCommandSystemRuleHook = createSwarmCommandSystemRuleHook(
		agentDefinitionMap,
		agents,
	);
	const activityHooks = createAgentActivityHooks(config, ctx.directory);
	// #1821 Workstream B: real-time admission + PRM pattern persistence budgets.
	// Parsed once at init (pure Zod, no I/O) so the hot hook path reads plain
	// numbers rather than re-parsing per tool call.
	const learningConfig = LearningConfigSchema.parse(config.learning ?? {});
	// Parsed once, shared by the PRM hook and the trajectory logger: the
	// `prm.max_trajectory_lines` knob is the ONE budget governing the session
	// store's cache trim AND disk compaction (issue #2041 Required 5) — the
	// append path previously hardcoded 1000 here and at the denied-call site
	// while the schema default never reached production.
	const prmConfig = config.prm ?? PrmConfigSchema.parse({});
	const prmHook = createPrmHook(
		prmConfig,
		ctx.directory,
		// #1821 F3: this mapping used to be an inline literal that ANDed
		// `realtime_admission.enabled` into the producer's `enabled` flag, which
		// also disabled the hook's durable `appendInsightCandidates` backstop — so
		// a deployment with real-time admission off wrote no PRM candidate to
		// `.swarm/insight-candidates.jsonl` and the phase-boundary drain never saw
		// one, the exact loss AC8 forbids. `resolvePrmPatternPersistenceOptions`
		// owns the coupling now (durable ← `prm_persistence.enabled`, enqueue ←
		// `realtime_admission.enabled`) and is asserted directly by
		// tests/unit/learning/wiring.test.ts.
		resolvePrmPatternPersistenceOptions(learningConfig),
	);
	const trajectoryLoggerHook = createTrajectoryLoggerHook(
		{
			enabled: true,
			max_lines: prmConfig.max_trajectory_lines,
		},
		ctx.directory,
	);
	const delegationGateHooks = createDelegationGateHook(
		configWithResolvedAutoReview,
		ctx.directory,
	);
	const advisoryInjector = (sessionId: string, message: string) => {
		const session = swarmState.agentSessions.get(sessionId);
		if (session) {
			pushAdvisory(session, message);
		}
	};
	// Advisory ingester for trusted background-subagent completion signals.
	// No-op unless hooks.background_subagents is opted in; never advances gates.
	const backgroundCompletionObserver = createBackgroundCompletionObserver({
		config: {
			enabled:
				(config.hooks as Record<string, unknown> | undefined)
					?.background_subagents === true,
		},
		directory: ctx.directory,
		reviewerReceiptOptions: {
			dispatcher: reviewModelDispatcher,
			config: autoReviewConfig,
			generatedAgentNames: instanceGeneratedAgentNames,
			agentModelRegistry: reviewAgentModelRegistry,
			injectAdvisory: advisoryInjector,
			validationScheduler: findingValidationScheduler,
		},
	});
	// Issue #2104 — maintenance point P3 helper. The dynamic import is
	// memoized once so terminal session events never re-resolve the module
	// (it stays off the init path entirely). The 2 s lock bound is a step
	// looser than admission's 1 s (hot dispatch path) and tighter than the
	// post-init pass's 5 s (nothing user-facing waits on it): a session-close
	// event is rare, but the event hook must still return promptly.
	const backgroundSubagentsEnabled =
		(config.hooks as Record<string, unknown> | undefined)
			?.background_subagents === true;
	let pendingDelegationsModulePromise: Promise<
		typeof import('./background/pending-delegations.js')
	> | null = null;
	const maintainBackgroundDelegationsOnSessionEvent =
		async (): Promise<void> => {
			// A rejected import must not poison the memo: reset the promise so
			// the next session-close event retries instead of skipping
			// maintenance for the rest of the process lifetime. The local
			// binding is required — after a rejection resets the memo, a fresh
			// call may have replaced it while this call still awaits (and
			// surfaces) the original rejection.
			let modulePromise = pendingDelegationsModulePromise;
			if (modulePromise === null) {
				modulePromise = import('./background/pending-delegations.js').catch(
					(err: unknown) => {
						pendingDelegationsModulePromise = null;
						throw err;
					},
				);
				pendingDelegationsModulePromise = modulePromise;
			}
			const module = await modulePromise;
			await module.maintainBackgroundDelegations(ctx.directory, {
				lockTimeoutMs: 2_000,
				reason: 'session-close',
				onLegacyCoderSettlementReconciled:
					backgroundCompletionObserver.reconcilePending,
				onLegacyCoderSettlementAdvisoryReplaced:
					backgroundCompletionObserver.notifyLegacyCoderSettlementAdvisoryReplaced,
			});
		};
	const delegationSanitizerHook = createDelegationSanitizerHook(ctx.directory);
	const memoryLifecycleHooks = createMemoryLifecycleHooks({
		directory: ctx.directory,
		config: config.memory,
		getActiveAgentName: (sessionID) =>
			sessionID ? swarmState.activeAgent.get(sessionID) : undefined,
		// B.1 — resolve the unit-of-work (task) id from the SAME session's
		// currentTaskId. `?? undefined` normalizes the null sentinel so an absent
		// id persists as NULL and recall degrades to session-scoped runId.
		getActiveTaskId: (sessionID) =>
			sessionID
				? (swarmState.agentSessions.get(sessionID)?.currentTaskId ?? undefined)
				: undefined,
	});
	// Issue #1989: reflection regeneration performs provider, graph, and artifact
	// I/O, so it belongs in the wrapper-owned post-resolution queue. Keeping the
	// service behind a dynamic import prevents this optional startup feature from
	// expanding the manifest-resolution path. The timeout and catch are both
	// fail-open: a corrupt/oversized store never prevents plugin registration.
	if (
		config.memory?.enabled === true &&
		config.memory.reflection?.enabled === true
	) {
		const reflectionConfig = config.memory as Partial<RuntimeMemoryConfig>;
		const regenerateMemoryReflectionTask = () =>
			withTimeout(
				repoGraphInitPromise ?? Promise.resolve(),
				5_000,
				new Error('repo graph refresh exceeded reflection wait budget'),
			)
				.catch(() => undefined)
				.then(() =>
					withTimeout(
						regenerateMemoryReflectionForInit(ctx.directory, reflectionConfig),
						15_000,
						new Error('memory reflection startup regeneration exceeded 15s'),
					),
				)
				.catch((err: unknown) => {
					log('memory reflection startup regeneration failed (non-fatal)', {
						error: err instanceof Error ? err.message : String(err),
					});
				})
				.then(() => undefined);
		postResolutionTasks.push(regenerateMemoryReflectionTask);
	}
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
	const worktreeDirOverride =
		resolveWorktreeIsolationConfig(config).worktree_dir;
	const worktreeBaseDirOverrides = worktreeDirOverride
		? [worktreeDirOverride]
		: [];
	const guardrailsHooks = createGuardrailsHooks(
		ctx.directory,
		undefined,
		guardrailsConfig,
		authorityConfig,
		worktreeBaseDirOverrides,
		resolveIncomingAgentModel,
	);
	const durableBackgroundAdvisoryMessagesTransform = async (
		input: Record<string, never>,
		output: {
			messages?: Array<{
				info: { role: string; agent?: string; sessionID?: string };
				parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
			}>;
		},
	): Promise<void> => {
		const mctx = resolveMessageTransformContext(output);
		if (!mctx.sessionID) {
			await guardrailsHooks.messagesTransform(input, output);
			return;
		}
		const observedTexts = (output.messages ?? []).flatMap((message) =>
			(message.parts ?? [])
				.filter((part) => part.type === 'text' && typeof part.text === 'string')
				.map((part) => part.text as string),
		);
		await backgroundCompletionObserver.ackObservedAdvisories(
			mctx.sessionID,
			observedTexts,
		);
		const prepared = await backgroundCompletionObserver.prepareAdvisories(
			mctx.sessionID,
		);
		if (!prepared) {
			await guardrailsHooks.messagesTransform(input, output);
			return;
		}
		const session = swarmState.agentSessions.get(mctx.sessionID);
		const pendingBefore = session
			? [...(session.pendingAdvisoryMessages ?? [])]
			: undefined;
		// Snapshot guardrails-affected session flags so a failed advisory
		// injection can fully undo guardrails' one-shot side effects (e.g.
		// resumeModelAdvisoryDone, configModelAdvisoryDone). Without this,
		// a rollback leaves those flags permanently set, and guardrails
		// skips the corresponding advisories on the next turn.
		const guardrailsSnapshot = session
			? {
					resumeModelAdvisoryDone: session.resumeModelAdvisoryDone,
					configModelAdvisoryDone: session.configModelAdvisoryDone,
					lastObservedModel: session.lastObservedModel,
					lastObservedProviderID: session.lastObservedProviderID,
					lastProviderRecoveryFingerprint:
						session.lastProviderRecoveryFingerprint,
					loopWarningPending: session.loopWarningPending,
				}
			: undefined;
		// Capture messages BEFORE the try block so a structuredClone failure
		// never leaves messagesBefore uninitialized (issue #1961 M-1).
		const messagesBefore = output.messages
			? structuredClone(output.messages)
			: undefined;
		try {
			if (session) {
				for (const message of prepared.messages) {
					pushAdvisory(session, message);
				}
			}
			await guardrailsHooks.messagesTransform(input, output);
			const delivered = prepared.messages.every((message) =>
				(output.messages ?? []).some((candidate) =>
					(candidate.parts ?? []).some(
						(part) =>
							part.type === 'text' &&
							typeof part.text === 'string' &&
							part.text.includes(message),
					),
				),
			);
			if (!delivered) {
				throw new Error('durable background advisory insertion failed');
			}
		} catch (error) {
			if (session && pendingBefore) {
				session.pendingAdvisoryMessages = pendingBefore;
			}
			// Restore guardrails-specific session flags to their pre-guardrails
			// state so a retry does not skip one-shot advisories (PRR-001).
			if (session && guardrailsSnapshot) {
				session.resumeModelAdvisoryDone =
					guardrailsSnapshot.resumeModelAdvisoryDone;
				session.configModelAdvisoryDone =
					guardrailsSnapshot.configModelAdvisoryDone;
				session.lastObservedModel = guardrailsSnapshot.lastObservedModel;
				session.lastObservedProviderID =
					guardrailsSnapshot.lastObservedProviderID;
				session.lastProviderRecoveryFingerprint =
					guardrailsSnapshot.lastProviderRecoveryFingerprint;
				session.loopWarningPending = guardrailsSnapshot.loopWarningPending;
			}
			// Restore IN PLACE (issue #1619). Rebinding `output.messages` here
			// only redirected the *later* handlers in the composed chain — the
			// host keeps its own reference to the array we were handed, so the
			// half-inserted advisories from the failed attempt still reached the
			// model while downstream hooks operated on the discarded clone.
			if (Array.isArray(output.messages) && messagesBefore) {
				output.messages.length = 0;
				// Loop rather than `push(...messagesBefore)`: chat history length is
				// unbounded and spreading it can exceed the argument limit.
				for (const message of messagesBefore) {
					output.messages.push(message);
				}
			} else {
				// `output.messages` is not an array we can mutate in place (absent, or
				// replaced by a non-host caller), so there is nothing to restore into.
				// Fall back to the pre-#1619 assignment rather than skipping the
				// rollback: the host ALWAYS supplies an array, so this branch is
				// unreachable in production and reachable only from tests and non-host
				// callers — where the assignment is the only thing that restores the
				// pre-attempt value. Allowlisted in
				// tests/unit/hooks/chat-transform-rebind-guard.test.ts.
				output.messages = messagesBefore;
			}
			await backgroundCompletionObserver.releaseAdvisories(
				mctx.sessionID,
				prepared,
			);
			warn(
				`[background] advisory injection rolled back for ${mctx.sessionID}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

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

	// Issue trace: mode-transition workflow for traced GitHub issues
	const issueTraceHook = createIssueTraceHook(config, ctx.directory);

	// Watchdog: scope-guard + delegation-ledger
	const watchdogConfig = WatchdogConfigSchema.parse(config.watchdog ?? {});

	const scopeGuardHook = createScopeGuardHook(
		{
			enabled: watchdogConfig.scope_guard,
		},
		ctx.directory,
		advisoryInjector,
	);
	const prWorkflowResponseGate = createPrWorkflowResponseGate({
		directory: ctx.directory,
		client: ctx.client,
	});
	const prWorkflowSessionResolver = createPrWorkflowSessionResolver({
		directory: ctx.directory,
		client: ctx.client,
	});

	const delegationLedgerHook = createDelegationLedgerHook(
		{ enabled: watchdogConfig.delegation_ledger },
		ctx.directory,
		advisoryInjector,
	);

	// Init orphan recovery advisory: surfaces plugin-init orphan reclamation results
	// to the architect on their next turn via pendingAdvisoryMessages.
	const initOrphanRecoveryAdvisoryHook = createInitOrphanRecoveryAdvisoryHook(
		ctx.directory,
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
		config: autoReviewConfig,
		directory: ctx.directory,
		dispatcher: reviewModelDispatcher,
		generatedAgentNames: instanceGeneratedAgentNames,
		agentModelRegistry: reviewAgentModelRegistry,
		getActiveAgentName: getActiveReviewAgentName,
		injectAdvisory: advisoryInjector,
	});

	const summaryConfig = SummaryConfigSchema.parse(config.summaries ?? {});
	const toolSummarizerHook = createToolSummarizerHook(
		summaryConfig,
		ctx.directory,
	);

	// v6.17 Knowledge system hooks — fire-and-forget, wrapped in safeHook
	const knowledgeConfigBase = config.knowledge ?? {};
	const knowledgeConfig = KnowledgeConfigSchema.parse(knowledgeConfigBase);
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
		postResolutionTasks.push(() => {
			return import('./services/skill-consolidation.js')
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
				config.context_budget?.unified_injection_tokens,
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
							pushAdvisory(s, message);
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
							pushAdvisory(s, message);
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
							pushAdvisory(s, message);
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
	let planSyncWorker: PlanSyncWorker | null = null;

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
				planSyncWorker = new PlanSyncWorker({
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

	// Register PR event subscribers for event delivery to active sessions
	let prEventCleanup: (() => void) | null = null;
	// Wake-delivery module handle (prompt mode). Populated only when
	// pr_monitor is enabled with event_delivery === 'prompt' — same
	// enabled-gated dynamic-import pattern as the subscribers (invariant 1:
	// zero added init work when the feature is disabled).
	let prEventDelivery: {
		noteSessionIdle: (sessionID: string) => void;
		unregisterPrEventDelivery: () => void;
	} | null = null;
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
		if (prMonitorConfig.event_delivery === 'prompt') {
			try {
				const deliveryModule = await import('./background/pr-event-delivery');
				deliveryModule.registerPrEventDelivery({
					client: ctx.client,
					directory: ctx.directory,
					config: prMonitorConfig,
				});
				prEventDelivery = {
					noteSessionIdle: deliveryModule.noteSessionIdle,
					unregisterPrEventDelivery: deliveryModule.unregisterPrEventDelivery,
				};
			} catch (err) {
				log('[pr-monitor] Failed to register wake delivery (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// Auto-subscribe on `gh pr create` (tool.execute.after observer).
	// Cheap to construct; all gating (enabled + auto_subscribe_on_pr_create)
	// happens inside the hook.
	const prAutoSubscribeHook = createPrAutoSubscribeHook(
		ctx.directory,
		prMonitorConfig,
	);

	// Startup scan: resume worker for existing subscriptions after plugin restart.
	// Deferred via the wrapper-owned post-resolution queue (fail-open).
	if (prMonitorConfig.enabled) {
		postResolutionTasks.push(() => {
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
		planSyncWorker?.stop();
		prEventCleanup?.();
		prEventDelivery?.unregisterPrEventDelivery();
	};
	process.on('exit', cleanupAutomation);

	// v6.7 Task 5.7: Config Doctor - run on startup if automation flags permit
	// Runs in background-safe way (non-blocking, no errors propagate)
	// SECURITY: Default is scan-only (autoFix=false). Autofix requires explicit opt-in
	// via config_doctor_autofix capability.
	if (shouldRunOnStartup(automationConfig)) {
		// Autofix is opt-in only - requires explicit config_doctor_autofix capability
		const enableAutofix =
			automationConfig.capabilities?.config_doctor_autofix === true;

		postResolutionTasks.push(() => {
			// Dynamically import to avoid circular dependencies
			return import('./services/config-doctor').then(
				({ runConfigDoctorWithFixes }) => {
					// Default to scan-only mode (autoFix=false) for security
					// Autofix only runs when explicitly enabled via capability
					return runConfigDoctorWithFixes(ctx.directory, config, enableAutofix)
						.then((doctorResult) => {
							if (doctorResult.result.findings.length > 0) {
								log('Config Doctor ran on startup', {
									findings: doctorResult.result.findings.length,
									errors: doctorResult.result.summary.error,
									warnings: doctorResult.result.summary.warn,
									appliedFixes: doctorResult.appliedFixes.length,
									autofixEnabled: enableAutofix,
								});

								// Emit advisory for auto-fixable findings.
								// Guarded by config.quiet to avoid stderr writes that bypass the host TUI.
								// Wrapped in try/catch per AGENTS.md invariant #1 (fail-open).
								try {
									const autoFixableCount = doctorResult.result.findings.filter(
										(f) => f.autoFixable,
									).length;
									const appliedCount = doctorResult.appliedFixes.length;

									if (!enableAutofix && autoFixableCount > 0) {
										const msg = `[opencode-swarm] Config Doctor found ${autoFixableCount} auto-fixable issue(s). Run /swarm config doctor --fix to apply.`;
										if (!config.quiet) {
											// biome-ignore lint/suspicious/noConsole: Config Doctor auto-fixable warning — user must see to run --fix
											console.warn(msg);
										} else {
											addDeferredWarning(msg);
										}
									} else if (enableAutofix) {
										// Report what was applied, and — crucially — nudge for any
										// auto-fixable finding NOT applied because it is lossy.
										// Over-length fallback_models is never trimmed silently at
										// startup; the user must opt in via --fix (issue #1886).
										const parts: string[] = [];
										if (appliedCount > 0) {
											parts.push(
												`applied ${appliedCount} fix(es) automatically`,
											);
										}
										const unapplied = Math.max(
											0,
											autoFixableCount - appliedCount,
										);
										if (unapplied > 0) {
											parts.push(
												`${unapplied} auto-fixable issue(s) need explicit review — run /swarm config doctor --fix`,
											);
										}
										if (parts.length > 0) {
											const msg = `[opencode-swarm] Config Doctor: ${parts.join('; ')}.`;
											if (!config.quiet) {
												// biome-ignore lint/suspicious/noConsole: Config Doctor autofix summary — user must see what was fixed / still needs --fix
												console.warn(msg);
											} else {
												addDeferredWarning(msg);
											}
										}
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
				},
			);
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
		tool: buildPluginToolObject(
			agentDefinitionMap,
			config,
			evaluationModelDispatcher,
			reviewModelDispatcher,
			instanceGeneratedAgentNames,
			reviewAgentModelRegistry,
			getActiveReviewAgentName,
		),

		// Observe and ingest trusted background-subagent terminal signals. Errors
		// are caught locally so completion handling can never block event delivery
		// or plugin load. The observer is opt-in and fail-closed.
		event: async (input: { event: unknown }): Promise<void> => {
			try {
				const rememberedUsage = rememberAssistantUsageEvent(input);
				if (rememberedUsage) {
					let corrected = emitPendingCostCorrection(
						rememberedUsage.sessionId,
						rememberedUsage.raw,
					);
					if (!corrected) {
						const parentSessionId = await withTimeout(
							lookupParentSessionIDForTaskRoute(rememberedUsage.sessionId),
							1_000,
							new Error('late cost parent lookup exceeded 1000ms'),
						).catch(() => undefined);
						if (parentSessionId) {
							const recovered = recoverPendingCostCorrection(
								ctx.directory,
								parentSessionId,
								config.pricing,
							);
							if (recovered) {
								trackPendingCostCorrection(
									rememberedUsage.sessionId,
									recovered,
								);
								emitTelemetry(
									'delegation_cost_binding' as Parameters<
										typeof emitTelemetry
									>[0],
									{
										sessionId: parentSessionId,
										parent_session_digest: recovered.parentSessionDigest,
										record_id: recovered.recordId,
										identity_fingerprint: recovered.identityFingerprint,
										child_session_digest: createHash('sha256')
											.update(
												`delegation-cost-child-v1\0${rememberedUsage.sessionId}`,
											)
											.digest('hex')
											.slice(0, 32),
									},
								);
								corrected = emitPendingCostCorrection(
									rememberedUsage.sessionId,
									rememberedUsage.raw,
								);
							}
							if (recovered === null) corrected = true;
							if (!corrected) {
								emitTelemetry(
									'delegation_cost_join' as Parameters<typeof emitTelemetry>[0],
									{
										sessionId: parentSessionId,
										reason: 'join_miss',
									},
								);
							}
						}
					}
				}
				const lifecycleEvent = input.event as
					| {
							type?: string;
							properties?: {
								sessionID?: string;
								sessionId?: string;
								id?: string;
								status?: string | { type?: string };
								part?: {
									id?: string;
									sessionID?: string;
									callID?: string;
									type?: string;
									tool?: string;
									state?: {
										metadata?: {
											sessionId?: string;
										};
									};
								};
								info?: { id?: string; sessionID?: string };
							};
					  }
					| undefined;
				if (lifecycleEvent?.type === 'message.part.updated') {
					const part = lifecycleEvent.properties?.part;
					const metadata = part?.state?.metadata;
					const partTool =
						typeof part?.tool === 'string'
							? normalizeToolName(part.tool)?.toLowerCase()
							: undefined;
					// Scope-activation event sourcing: the PARENT is the SDK-typed
					// `part.sessionID` — the Task ToolPart lives in the parent
					// (architect) session's message stream, and `sessionID` is required
					// on every Part variant (same sourcing as the background
					// completion-observer). The CHILD is `state.metadata.sessionId`,
					// the key opencode's task tool emits at v1.1.x (upstream dev also
					// adds metadata.parentSessionId, but 1.1.x-era runtimes never emit
					// it — gating on it left bindings stuck at pending_child and every
					// default-mode coder write failing SCOPE_NOT_DECLARED). Metadata is
					// tool-controlled, so it is never trusted for the parent identity;
					// empty/whitespace ids fail closed (no activation, no fallback).
					const eventParentSessionID =
						typeof part?.sessionID === 'string' && part.sessionID.trim() !== ''
							? part.sessionID
							: undefined;
					const eventChildSessionID =
						typeof metadata?.sessionId === 'string' &&
						metadata.sessionId.trim() !== ''
							? metadata.sessionId
							: undefined;
					if (
						part?.type === 'tool' &&
						partTool === 'task' &&
						typeof part.callID === 'string' &&
						part.callID.trim() !== '' &&
						eventParentSessionID !== undefined &&
						eventChildSessionID !== undefined &&
						eventParentSessionID !== eventChildSessionID
					) {
						await delegationGateHooks.taskMetadata({
							callID: part.callID,
							parentSessionID: eventParentSessionID,
							childSessionID: eventChildSessionID,
						});
						bindPendingTaskModelRouteChild({
							parentSessionID: eventParentSessionID,
							callID: part.callID,
							childSessionID: eventChildSessionID,
						});
						const fullAutoRunState = loadFullAutoRunState(
							ctx.directory,
							eventParentSessionID,
						);
						if (fullAutoRunState?.runGeneration !== undefined) {
							bindFullAutoSevereChildSession({
								childSessionID: eventChildSessionID,
								parentSessionID: eventParentSessionID,
								parentCallID: part.callID,
								generation: fullAutoRunState.runGeneration,
							});
						}
					}
				}
				if (lifecycleEvent?.type === 'session.error') {
					const properties = lifecycleEvent.properties as
						| Record<string, unknown>
						| undefined;
					const childSessionID =
						typeof properties?.sessionID === 'string'
							? properties.sessionID
							: typeof properties?.sessionId === 'string'
								? properties.sessionId
								: typeof properties?.info === 'object' &&
										properties.info &&
										typeof (properties.info as { id?: unknown }).id === 'string'
									? ((properties.info as { id: string }).id ?? '')
									: '';
					const route = childSessionID
						? resolveTaskRouteForChildSession(childSessionID)
						: undefined;
					const routeModel = resolveTaskRouteModelChain(
						route
							? (swarmState.activeAgent.get(childSessionID) ??
									swarmState.agentSessions.get(childSessionID)?.agentName ??
									route.role)
							: (swarmState.activeAgent.get(childSessionID) ??
									swarmState.agentSessions.get(childSessionID)?.agentName),
					);
					const errorSignal = extractSessionErrorSignal(properties);
					if (
						route &&
						routeModel &&
						errorSignal &&
						isRetryableProviderFailure(classifyProviderFailure(errorSignal))
					) {
						advancePendingTaskModelRoute({
							childSessionID,
							role: route.role,
							actionDigest: route.actionDigest,
							primaryModel: routeModel.primaryModel,
							fallbackModels: routeModel.fallbackModels,
						});
					}
				}
				const lifecycleStatus = lifecycleEvent?.properties?.status;
				const isTerminalSessionEvent =
					lifecycleEvent?.type === 'session.deleted' ||
					lifecycleEvent?.type === 'session.removed' ||
					lifecycleEvent?.type === 'session.idle' ||
					lifecycleEvent?.type === 'session.error' ||
					(lifecycleEvent?.type === 'session.status' &&
						(lifecycleStatus === 'idle' ||
							(typeof lifecycleStatus === 'object' &&
								(lifecycleStatus.type === 'idle' ||
									lifecycleStatus.type === 'error'))));
				if (isTerminalSessionEvent) {
					const properties = lifecycleEvent.properties;
					const sessionID =
						properties?.sessionID ??
						properties?.sessionId ??
						properties?.info?.sessionID ??
						properties?.info?.id ??
						properties?.id;
					if (sessionID) {
						delegationGateHooks.sessionEnded(
							sessionID,
							lifecycleEvent.type === 'session.deleted' ||
								lifecycleEvent.type === 'session.removed',
						);
						if (
							lifecycleEvent.type === 'session.deleted' ||
							lifecycleEvent.type === 'session.removed'
						) {
							clearPendingTaskModelRoutesForSession(sessionID);
							clearSessionActionCircuits(sessionID);
							clearFullAutoSevereSession(sessionID);
						}
						// Issue #2104 — maintenance point P3: a closed/idle
						// session is a listed runtime maintenance trigger (a
						// parent that dies without a later dispatch must not
						// strand reservations). Opt-in only; bounded by the
						// maintenance service's own tight lock bound and
						// fail-open — failures are recorded in the durable
						// facts ring, never fatal to the event hook.
						if (backgroundSubagentsEnabled) {
							try {
								await maintainBackgroundDelegationsOnSessionEvent();
							} catch {
								// observation only; the facts ring records it
							}
						}
					}
				}
				prWorkflowSessionResolver.observeEvent(input);
				await prWorkflowResponseGate.event(input);
				// PR wake delivery: session.idle flushes that session's queued PR
				// events. No-op unless prompt-mode delivery is registered.
				if (prEventDelivery) {
					const evt = input.event as
						| {
								type?: string;
								properties?: { sessionID?: string };
								data?: { sessionID?: string };
						  }
						| undefined;
					const idleSessionID =
						evt?.properties?.sessionID ?? evt?.data?.sessionID;
					if (
						evt?.type === 'session.idle' &&
						typeof idleSessionID === 'string'
					) {
						prEventDelivery.noteSessionIdle(idleSessionID);
					}
				}
				await backgroundCompletionObserver.event(input);
			} catch (err) {
				warn(
					`[swarm] event hook error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},

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

			// Worktree-lane permission scoping.
			//
			// OpenCode partitions permission state per directory, and `Plugin.state`
			// is built through the same directory-keyed InstanceState cache as
			// `Permission.state` — so when this hook runs inside a lane instance,
			// `ctx.directory` IS the lane path. Pre-resolving `external_directory`
			// here prevents the ask from ever being raised, which matters because a
			// lane instance has no TUI that could answer one (the host's
			// `Permission.ask` awaits its deferred with no timeout).
			//
			// A no-op for every ordinary session: `applyLanePermissions` mutates
			// nothing unless the directory resolves as a swarm worktree lane.
			// Wrapped because a config-hook throw is logged and ignored by the host
			// (`tryPromise` + `tapError` + `ignore`), which would silently drop the
			// agent registration work above on some future refactor.
			try {
				// Read straight off `config` rather than via
				// `resolveWorktreeIsolationConfig`: that resolver is a spread over
				// DEFAULT_WORKTREE_ISOLATION_CONFIG whose `lane_permissions` default
				// is this same 'scoped_allow', so the two are behaviourally
				// identical here — and the direct read keeps this hook off the
				// resolver's import chain. Do not "simplify" it into that import
				// without re-checking the init-path cost.
				applyLanePermissions(
					opencodeConfig,
					ctx.directory,
					config?.worktree?.lane_permissions ?? 'scoped_allow',
				);
			} catch (err) {
				addDeferredWarning(
					`[swarm] lane permission scoping failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

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
				'swarm-gate-audit': {
					template: '/swarm gate-audit $ARGUMENTS',
					description:
						'Use /swarm gate-audit to run the bounded Tier-1 production gate matrix',
				},
				'swarm-gate-stats': {
					template: '/swarm gate-stats $ARGUMENTS',
					description:
						'Use /swarm gate-stats to summarize stored gate-audit evidence',
				},
				'swarm-skill-opt': {
					template: '/swarm skill-opt $ARGUMENTS',
					description:
						'Use /swarm skill-opt to govern skill optimization (plan|run|status|diff|approve|reject|rollback|history)',
				},
				'swarm-costs': {
					template: '/swarm costs $ARGUMENTS',
					description:
						'Use /swarm costs to show per-agent, task, gate, and retry token/cost totals',
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
						'Use /swarm council <question> to convene a multi-model General Council deliberation (generalist / skeptic / domain expert) [--spec-review]',
				},
				'swarm-pr-review': {
					template: '/swarm pr-review $ARGUMENTS',
					description:
						'Use /swarm pr-review to launch deep PR review with multi-lane analysis',
				},
				'swarm-review': {
					template: '/swarm review $ARGUMENTS',
					description:
						'Use /swarm review to run the bounded whole-diff review engine for the selected local scope',
				},
				'swarm-pr-feedback': {
					template: '/swarm pr-feedback $ARGUMENTS',
					description:
						'Use /swarm pr-feedback to ingest and close known PR feedback (review comments, CI failures, conflicts) without a fresh broad review',
				},
				'swarm-abort-pr-workflow': {
					template: '/swarm abort-pr-workflow $ARGUMENTS',
					description:
						'Use /swarm abort-pr-workflow to clear a stuck PR_REVIEW/PR_FEEDBACK mechanical gate and stop the auto-resume loop (human-only escape hatch)',
				},
				'swarm-approve-plan-critic': {
					template: '/swarm approve-plan-critic $ARGUMENTS',
					description:
						'Use /swarm approve-plan-critic to record a MANUAL plan-critic approval that unblocks the ratchet-tighter critic_pre_plan execution gate when the critic already returned APPROVED but the snapshot was not recorded (human-only escape hatch)',
				},
				'swarm-approve-write': {
					template: '/swarm approve-write $ARGUMENTS',
					description:
						'Use /swarm approve-write to issue one exact, session-bound, one-shot write approval (human-only)',
				},
				'swarm-ci-monitor': {
					template: '/swarm ci-monitor $ARGUMENTS',
					description:
						'Use /swarm ci-monitor to drive an already-reviewed, approved PR to green and merged (monitor CI, fix, merge)',
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
				'swarm-ci-simulate': {
					template: '/swarm ci-simulate $ARGUMENTS',
					description: shortcutDescription('ci-simulate'),
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
				'swarm-blueprint-validate': {
					template: '/swarm blueprint validate $ARGUMENTS',
					description: shortcutDescription('blueprint validate'),
				},
				'swarm-blueprint-current': {
					template: '/swarm blueprint current',
					description: shortcutDescription('blueprint current'),
				},
				'swarm-blueprint-history': {
					template: '/swarm blueprint history',
					description: shortcutDescription('blueprint history'),
				},
				'swarm-blueprint-diff': {
					template: '/swarm blueprint diff $ARGUMENTS',
					description: shortcutDescription('blueprint diff'),
				},
				'swarm-blueprint-export': {
					template: '/swarm blueprint export $ARGUMENTS',
					description: shortcutDescription('blueprint export'),
				},
				'swarm-harness-candidate-validate': {
					template: '/swarm harness candidate validate $ARGUMENTS',
					description: shortcutDescription('harness candidate validate'),
				},
				'swarm-harness-candidate-show': {
					template: '/swarm harness candidate show $ARGUMENTS',
					description: shortcutDescription('harness candidate show'),
				},
				'swarm-harness-candidate-diff': {
					template: '/swarm harness candidate diff $ARGUMENTS',
					description: shortcutDescription('harness candidate diff'),
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
				'swarm-epic': {
					template: '/swarm epic $ARGUMENTS',
					description: shortcutDescription('epic'),
				},
				'swarm-coupling': {
					template: '/swarm coupling $ARGUMENTS',
					description: shortcutDescription('coupling'),
				},
				'swarm-lanes': {
					template: '/swarm lanes',
					description: shortcutDescription('lanes'),
				},
				'swarm-guardrail-explain': {
					template: '/swarm guardrail explain $ARGUMENTS',
					description: shortcutDescription('guardrail explain'),
				},
				'swarm-guardrail-reset': {
					template: '/swarm guardrail reset $ARGUMENTS',
					description: shortcutDescription('guardrail reset'),
				},
				'swarm-guardrail-log': {
					template: '/swarm guardrail-log $ARGUMENTS',
					description: shortcutDescription('guardrail-log'),
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
				'swarm-recover': {
					template: '/swarm recover $ARGUMENTS',
					description:
						'Use /swarm recover to settle wedged coder settlements [task_id] [--force]',
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
				'swarm-context-map-stats': {
					template: '/swarm context-map stats',
					description: shortcutDescription('context-map-stats'),
				},
				'swarm-link': {
					template: '/swarm link $ARGUMENTS',
					description:
						'Use /swarm link to link this worktree to a shared knowledge store [name|status]',
				},
				'swarm-unlink': {
					template: '/swarm unlink $ARGUMENTS',
					description:
						'Use /swarm unlink to unlink this worktree from the shared knowledge store [--no-copy]',
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
				(_input: unknown, output: unknown): Promise<void> => {
					if (process.env.DEBUG_SWARM)
						// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM diagnostic output — only fires when explicitly enabled
						console.error(`[DIAG] messagesTransform START`);
					// (#1849) The SDK messages.transform input is `{}` — sessionID is
					// NOT on input. Recover it from output.messages[].info.sessionID.
					const mctx = resolveMessageTransformContext(
						output as MessageArrayLike,
					);
					if (mctx.sessionID) {
						const archAgent = swarmState.activeAgent.get(mctx.sessionID);
						const archSession = swarmState.agentSessions.get(mctx.sessionID);
						const agentName = archAgent ?? archSession?.agentName ?? '';
						if (stripKnownSwarmPrefix(agentName) === ORCHESTRATOR_NAME) {
							try {
								delegationLedgerHook.onArchitectResume(mctx.sessionID);
							} catch {
								/* non-blocking */
							}
						}
					}
					return Promise.resolve();
				},
				pipelineHook['experimental.chat.messages.transform'],
				contextBudgetHandler,
				initOrphanRecoveryAdvisoryHook.messagesTransform,
				durableBackgroundAdvisoryMessagesTransform,
				fullAutoInterceptHook?.messagesTransform,
				ccCommandInterceptHook?.messagesTransform,
				delegationGateHooks.messagesTransform,
				issueTraceHook.messagesTransform,
				delegationSanitizerHook,
				memoryLifecycleHooks.messagesTransform,
				knowledgeInjectorHook, // v6.17 knowledge injection
				// v2: scan latest architect-authored message for KNOWLEDGE_APPLIED
				// / KNOWLEDGE_IGNORED / KNOWLEDGE_CONTRADICTED /
				// KNOWLEDGE_VIOLATED markers and record
				// each via the dedup-aware path. Best-effort; never throws.
				(_input: unknown, output: unknown): Promise<void> => {
					try {
						// (#1849) sessionID from output.messages[].info, not input.
						const mctx = resolveMessageTransformContext(
							output as MessageArrayLike,
						);
						return knowledgeApplicationTransformScan(
							ctx.directory,
							output as {
								messages?: import('./hooks/knowledge-types.js').MessageWithParts[];
							},
							mctx.sessionID,
						);
					} catch {
						return Promise.resolve();
					}
				},
				// v2: scan for skill propagation warnings and compliance tracking
				(_input: unknown, output: unknown): Promise<void> => {
					try {
						if (!skillPropagationConfig.enabled) {
							return Promise.resolve();
						}
						// (#1849) sessionID from output.messages[].info, not input.
						const mctx = resolveMessageTransformContext(
							output as MessageArrayLike,
						);
						return skillPropagationTransformScan(
							ctx.directory,
							output as {
								messages?: import('./hooks/knowledge-types.js').MessageWithParts[];
							},
							mctx.sessionID,
							skillPropagationConfig,
						);
					} catch {
						return Promise.resolve();
					}
				},
				// Final transformation: consolidate multiple system messages into one.
				// consolidateSystemMessages handles both the production `{info,parts}`
				// shape and the flat `{role,content}` shape (issue #1778 H1).
				//
				// MUST mutate `output.messages` IN PLACE (issue #1619). The host
				// discards this hook's return value and afterwards reads its own local
				// message array, so the previous
				// `output.messages = consolidateSystemMessages(output.messages)` was a
				// rebind that never reached the model. See
				// `consolidateSystemMessagesInPlace`.
				(
					_input: unknown,
					output: {
						messages?: import('./hooks/messages-transform.js').Message[];
					},
				): Promise<void> => {
					if (Array.isArray(output.messages)) {
						consolidateSystemMessagesInPlace(output.messages);
					}
					if (process.env.DEBUG_SWARM)
						// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM diagnostic output — only fires when explicitly enabled
						console.error(`[DIAG] messagesTransform DONE`);
					return Promise.resolve();
				},
				// #2107 §3: final context accounting. Runs AFTER consolidation
				// (which remains the last STRUCTURE-mutating handler). Read-mostly:
				// measures the final model-visible surface once, resolves the real
				// model limit through the same ladder physical pruning uses, records
				// the snapshot in session state + telemetry, and may prepend ONE
				// bounded advisory warning in place to the last user message. The
				// handler order (advisory drain < memory < knowledge < consolidation <
				// accounting) is pinned by tests/unit/hooks/hook-composition-order.test.ts.
				finalContextAccountingStep,
			].filter((fn): fn is NonNullable<typeof fn> => Boolean(fn)),
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		) as any,

		// Correctness boundary: while a durable PR workflow gate exists, architect
		// text is prepended with a workflow-active banner so it cannot masquerade
		// as a terminal verdict or closure response. Raw-await this hook so
		// gate-state read failures block text completion.
		'experimental.text.complete': prWorkflowResponseGate.textComplete,

		// Inject system prompt enhancements + phase monitor (when phase_preflight or knowledge enabled)
		'experimental.chat.system.transform': composeHandlers(
			...([
				async (_input: unknown, _output: unknown): Promise<void> => {
					if (process.env.DEBUG_SWARM)
						// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM diagnostic output — only fires when explicitly enabled
						console.error(`[DIAG] systemTransform START`);
				},
				systemEnhancerHook['experimental.chat.system.transform'],
				async (_input: unknown, _output: unknown): Promise<void> => {
					if (process.env.DEBUG_SWARM)
						// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM diagnostic output — only fires when explicitly enabled
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
							// FIFO-cap the KEY count to bound memory (mirrors
							// latestAssistantUsageBySession). Values are timestamps, so no
							// clearInterval/clearTimeout is needed on eviction.
							capSessionMap(_heartbeatTimers, MAX_TRACKED_HEARTBEAT_SESSIONS);
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
				roleFilterSystemHook['experimental.chat.system.transform'],
				// NOTE (#1619): there is deliberately no "collapse output.system to a
				// single entry" handler here. One existed (added by c8ad147e for
				// Qwen3.6/Gemma compatibility, #628) but it REBOUND `output.system`,
				// and the host discards a hook's return value and afterwards reads its
				// own local array — so a rebind is invisible and the collapse never
				// took effect. Converting it to an in-place collapse is also wrong:
				// the host marks prompt-cache breakpoints on the first two system
				// messages, so folding the stable base prompt and the per-request
				// swarm injections into one message moves the breakpoint behind
				// varying content and defeats caching on every request. See
				// docs/engineering-invariants.md § "v6.85.1 — Multiple system messages
				// crashing local models".
			].filter(Boolean) as Array<
				(input: unknown, output: unknown) => Promise<void>
			>),
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		) as any,

		// Handle session compaction. The wrapper advances the per-turn injection
		// ledger generation (#2107 §4): compaction changes the message surface,
		// so per-turn accounting/dedup state must not survive into the next
		// request composition. compactionHook's input carries { sessionID }
		// (src/hooks/compaction-customizer.ts).
		'experimental.session.compacting': (async (
			input: unknown,
			output: unknown,
		) => {
			const { sessionID } = (input ?? {}) as { sessionID?: string };
			if (sessionID) {
				advanceTurnGeneration(sessionID);
			}
			await (
				compactionHook['experimental.session.compacting'] as (
					input: unknown,
					output: unknown,
				) => Promise<void>
			)(input, output);
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Handle /swarm commands
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'command.execute.before': safeHook(commandHandler) as any,

		// Track tool usage + guardrails
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'tool.execute.before': (async (input: any, output: any) => {
			if (process.env.DEBUG_SWARM)
				// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM diagnostic output — only fires when explicitly enabled
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
			// static-analysis block reads THIS file and asserts raw `await` for
			// guardrailsHooks, scopeGuardHook, the PR-workflow enforcement pair
			// (prWorkflowSessionResolver.resolve + enforcePrWorkflowToolBefore),
			// delegationGateHooks, and both Full-Auto hooks. It also pins that order.
			// It does NOT
			// yet cover knowledgeApplicationGateBefore or skillPropagationGateBefore
			// — those two callsites are unpinned, so do not assume a safeHook
			// regression on them would be caught by that test.
			// ---------------------------------------------------------------

			// B1 (#2063): everything below runs inside a try/catch so a fail-closed
			// denial can be COUNTED and DECORATED before it propagates. The raw awaits
			// and rethrow semantics are unchanged — the catch always rethrows the SAME
			// object it caught. The intentional chain order is documented below.
			let failClosedRegionCompleted = false;
			try {
				// 1. Guardrails authority enforcement (FAIL-CLOSED).
				//    Throws must propagate to block tools.
				await guardrailsHooks.toolBefore(input, output);

				// 2. Scope-guard watchdog (FAIL-CLOSED).
				//    Blocks out-of-scope writes by non-architect agents.
				await scopeGuardHook.toolBefore(input, output);

				// 3. PR workflow obligation gate (FAIL-CLOSED).
				//    This mode-specific authority runs before the generic delegation gate
				//    so an active PR_REVIEW direct Task receives the actionable structured-
				//    dispatch denial before generic delegation processing can validate its
				//    prompt or publish delegation, scope, or background state. Guardrails and
				//    scope-guard remain first.
				const prWorkflowControllerSessionID =
					await prWorkflowSessionResolver.resolve(input.sessionID);
				const prWorkflowToolContext = resolveToolBeforeContext(
					input as { tool: string; sessionID: string; callID: string },
					output as { args?: unknown },
				);
				await enforcePrWorkflowToolBefore(
					ctx.directory,
					prWorkflowControllerSessionID,
					normalizeToolName(input.tool) ?? input.tool,
					prWorkflowToolContext.args ?? undefined,
					instanceGeneratedAgentNames,
					input.callID,
				);

				// 4. Reviewer/delegation gate (FAIL-CLOSED).
				//    Enforces acceptance, scope preflight, and coder re-delegation only
				//    after an active PR workflow has admitted the requested operation.
				await delegationGateHooks.toolBefore(input, output);

				// 5. Full-Auto v2 outbound delegation guard (FAIL-CLOSED).
				//    Throws FULL_AUTO_DELEGATION_DENY on disallowed Task
				//    delegations (unknown canonical role, missing coder scope).
				await fullAutoDelegationHook.toolBefore(input, output);

				// 6. Full-Auto v2 permission policy (FAIL-CLOSED).
				//    Throws FULL_AUTO_DENY / FULL_AUTO_BLOCKED / FULL_AUTO_PAUSED /
				//    FULL_AUTO_ESCALATE_HUMAN on denied actions and dispatches the
				//    critic when escalate_critic is needed.
				await fullAutoPermissionHook.toolBefore(input, output);

				// 7. v2 knowledge-application gate (FAIL-CLOSED in enforce mode).
				//    Reads in-memory currentCriticalShownIds populated at injection
				//    time and the in-process ack dedup set. Throws
				//    KNOWLEDGE_ENFORCE_GATE_DENY for high-risk architect actions
				//    (save_plan / update_task_status / phase_complete / Task) when
				//    a critical directive was shown but no ack was recorded.
				//    In `warn` mode it appends to events.jsonl and returns.
				await knowledgeApplicationGateBefore(
					ctx.directory,
					{
						// (#1849) tool.execute.before input has no agent/sessionID-derived
						// agent; use the host-boundary adapter (reads swarmState.activeAgent).
						tool: input.tool,
						agent: resolveToolBeforeContext(
							input as { tool: string; sessionID: string; callID: string },
							output as { args?: unknown },
						).agent,
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
				// This gate always performs mandatory explicit-reference validation
				// before its optional propagation-enabled early return. Calling it once
				// avoids reopening every referenced skill twice.
				const skillResult = await skillPropagationGateBefore(
					ctx.directory,
					{
						// (#1849) agent + args via the host-boundary adapter.
						tool: input.tool,
						agent: resolveToolBeforeContext(
							input as { tool: string; sessionID: string; callID: string },
							output as { args?: unknown },
						).agent,
						sessionID: input.sessionID,
						args:
							resolveToolBeforeContext(
								input as { tool: string; sessionID: string; callID: string },
								output as { args?: unknown },
							).args ?? undefined,
					},
					skillPropagationConfig,
				);
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
					pushAdvisory(skillSession, skillResult.reason);
				}

				// 8. Skill injection: auto-inject recommended skills when SKILLS field
				//    is missing from the delegation prompt. Preserves explicit
				//    SKILLS: none and architect-set SKILLS fields. Implemented in
				//    src/hooks/skill-injection.ts (issue #1770) so the injection +
				//    usage-recording path is testable against the REAL implementation.
				//    The function mutates `input.args.prompt` in place and records
				//    usage with the TARGET subagent (canonicalized via
				//    stripKnownSwarmPrefix so 'mega_coder' and 'coder' produce the
				//    same usage attribution as the gate's site 4a) + real taskID
				//    (not the architect + synthetic 'injection' literal the inline
				//    block used).
				// (#1849) Resolve the real mutable args from output.args (the SDK
				// mutation target), not input.args (which the host never populates).
				const toolBeforeCtx = resolveToolBeforeContext(
					input as { tool: string; sessionID: string; callID: string },
					output as { args?: unknown },
				);
				const toolBeforeArgs = toolBeforeCtx.args ?? {};
				injectSkillsIntoDelegation(
					ctx.directory,
					toolBeforeArgs,
					skillResult.recommendedSkills,
					stripKnownSwarmPrefix(
						parseDelegationArgs(toolBeforeArgs)?.targetAgent ?? '',
					) || toolBeforeCtx.agent,
					input.sessionID,
					{ quiet: config.quiet },
				);
				// ---------------------------------------------------------------

				// B1 (#2063): the fail-closed region completed, so a throw from the
				// ADVISORY steps below must NOT be counted as a gate denial.
				// NOTE: the streak RESET deliberately does not happen here. Steps
				// below (notably beginApprovedReviewerScopeLifecycle, which is
				// raw-awaited and does unguarded I/O) can still throw and reject the
				// call. Clearing the streak here would let a repeatable advisory-tail
				// failure silently zero the counter on every attempt, so the ladder
				// would never climb. The reset lives at the very end of the handler.
				failClosedRegionCompleted = true;

				// 9. Per-delegate knowledge directive injection (Change 1, Task 1.4).
				//    ADVISORY: prepends the role-scoped <delegate_knowledge_directives>
				//    block to a Task delegation's prompt so the subagent sees the
				//    directives + ack contract. Internally fail-open; never blocks.
				if (knowledgeConfig.enabled) {
					await injectDelegateDirectivesBefore(
						ctx.directory,
						{
							tool: input.tool,
							agent: toolBeforeCtx.agent,
							sessionID: input.sessionID,
							args: toolBeforeArgs,
						},
						knowledgeConfig,
					);
				}
				// (#1849) Re-snapshot output.args after (optional) directive injection
				// so tool.execute.after consumers recover the FINAL args. This store is
				// UNCONDITIONAL (issue #2214): the SDK toolAfter input carries no args,
				// guardrails' snapshot sits below its `if (!resolved) return` early-out
				// and therefore never runs for the architect session, and this line is
				// the only production store site for architect Task dispatches. Gating
				// it on knowledgeConfig.enabled left subagent_type unresolvable in
				// toolAfter when knowledge is disabled, silently skipping coder
				// settlement finalization, Stage B advancement, and gate-evidence
				// recording for every architect delegation.
				setStoredInputArgs(input.callID, output.args);

				// v6.29: One-time 50% context pressure warning. #2107 §3: the
				// numerator is now the FINAL PROMPT PRESSURE (estimated total prompt
				// vs the real model window, measured after all injectors) — not the
				// legacy swarm injection-footprint pct mislabeled as window usage.
				// Fall back to the footprint pct before the final accounting step
				// has run for the session.
				const pressurePct =
					getFinalPromptPressure(input.sessionID)?.pct ??
					getSessionBudgetPct(input.sessionID);
				if (pressurePct >= 50) {
					const pressureSession = ensureAgentSession(
						input.sessionID,
						swarmState.activeAgent.get(input.sessionID) ?? ORCHESTRATOR_NAME,
					);
					if (!pressureSession.contextPressureWarningSent) {
						pressureSession.contextPressureWarningSent = true;
						pushAdvisory(
							pressureSession,
							`CONTEXT PRESSURE (estimated): ${pressurePct.toFixed(1)}% estimated prompt pressure of the model context window. Prioritize completing the current task before starting new work.`,
						);
					}
				}

				// ADVISORY — activity tracking is observer-only.
				// Wrapped in safeHook intentionally: errors here must NOT block
				// the tool call that the fail-closed chain above has already
				// approved.
				// Stage-B scope state begins only after every blocking before-hook
				// above approved this exact Task call. Starting or claiming earlier
				// would strand identity-bound state when a later policy gate throws.
				if (autoReviewConfig.enabled) {
					await beginApprovedReviewerScopeLifecycle({
						directory: ctx.directory,
						tool: input.tool,
						args: toolBeforeArgs,
						parentSessionID: input.sessionID,
						callID: input.callID,
						maxBytes: autoReviewConfig.max_diff_kb * 1024,
					});
				}

				await safeHook(activityHooks.toolBefore)(input, output);

				// Bind durable phase-role participation only after every blocking and
				// lifecycle-start operation approved the exact Task call. Foreground
				// completions correlate by parent session + call ID; background calls
				// promote that binding in tool.execute.after.
				await reserveApprovedPhaseParticipation({
					directory: ctx.directory,
					tool: input.tool,
					parentSessionId: input.sessionID,
					callId: input.callID,
					args: toolBeforeArgs,
					policy: config.phase_complete,
				});
				if (
					(normalizeToolName(input.tool) ?? input.tool) === 'Task' &&
					typeof toolBeforeArgs.subagent_type === 'string' &&
					toolBeforeArgs.subagent_type.trim() !== ''
				) {
					const actionIdentity = createActionIdentity({
						tool: input.tool,
						args: toolBeforeArgs,
					});
					registerPendingTaskModelRoute({
						parentSessionID: input.sessionID,
						invocationID: String(
							getAgentSession(input.sessionID)?.activeInvocationId ?? 0,
						),
						callID: input.callID,
						role: stripKnownSwarmPrefix(toolBeforeArgs.subagent_type),
						actionDigest: actionIdentity.digest,
						swarmID: actionIdentity.swarm ?? undefined,
					});
				}

				// B1 (#2063): the WHOLE handler completed, so this tool call is
				// actually going to run — the denial streak for it is genuinely over.
				// Scoped to this tool so a successful `read` cannot erase an
				// in-progress `Task` denial loop, and (reviewer round-4) to this
				// call's dispatch target so a successful `Task` → `explorer` cannot
				// erase an in-progress `Task` → `coder` one. `toolBeforeArgs` is the
				// resolved args of the call that just succeeded.
				resetGateDenialStreaks(input.sessionID, input.tool, toolBeforeArgs);

				// Delegation lifecycle telemetry — the paired counterpart of the
				// `delegation_end` emitted by the Task handoff in tool.execute.after.
				// Emitted here (last statement of the handler) so a Task call denied
				// or rejected by ANY gate above never records a begin, and NEVER gated
				// on guardrails: the previous emission lived inside `beginInvocation`
				// (guardrails invocation-window bookkeeping) whose every call site is
				// guardrails-gated, so `guardrails.enabled: false` produced
				// delegation_end events with no delegation_begin ever.
				// `subagent_type` is the delegated agent as dispatched (raw, matching
				// the raw activeAgent names delegation_end historically carried);
				// activeAgent is only a fallback for malformed Task args.
				{
					const beforeToolNormalized =
						normalizeToolName(input.tool) ?? input.tool;
					if (
						beforeToolNormalized === 'Task' ||
						beforeToolNormalized === 'task'
					) {
						const delegatedAgent =
							typeof toolBeforeArgs.subagent_type === 'string' &&
							toolBeforeArgs.subagent_type.length > 0
								? toolBeforeArgs.subagent_type
								: (swarmState.activeAgent.get(input.sessionID) ?? 'unknown');
						const delegationTaskId =
							swarmState.agentSessions.get(input.sessionID)?.currentTaskId ??
							'';
						_delegationTelemetryByCallID.set(input.callID, {
							agentName: delegatedAgent,
							taskId: delegationTaskId,
						});
						capSessionMap(
							_delegationTelemetryByCallID,
							MAX_TRACKED_DELEGATION_TELEMETRY,
						);
						telemetry.delegationBegin(
							input.sessionID,
							delegatedAgent,
							delegationTaskId,
						);
					}
				}
			} catch (err) {
				// A fail-closed gate denied this call. Count the denial, record it as
				// a trajectory failure, and APPEND escalating guidance to the message
				// the agent reads — then rethrow the SAME object so the host still
				// rejects the tool and every consumer that matches on the leading code
				// token sees a byte-identical prefix.
				if (!failClosedRegionCompleted) {
					// Read the message BEFORE noteGateDenial decorates it, so the
					// trajectory carries the gate's own text, not our advisory.
					const deniedMessage =
						err &&
						typeof err === 'object' &&
						typeof (err as { message?: unknown }).message === 'string'
							? (err as { message: string }).message
							: null;
					// Resolved args of the DENIED call. `toolBeforeArgs` is declared
					// inside the try above and is therefore NOT in scope here, so the
					// args are re-resolved — in their own try/catch, because a throw
					// escaping this catch block would change WHICH error propagates.
					let deniedArgs: Record<string, unknown> | undefined;
					try {
						deniedArgs =
							resolveToolBeforeContext(
								input as {
									tool: string;
									sessionID: string;
									callID: string;
								},
								output as { args?: unknown },
							).args ?? undefined;
					} catch {
						deniedArgs = undefined;
					}
					if (deniedMessage !== null && !isAbortLikeError(err)) {
						try {
							await recordDeniedToolCall(
								input.sessionID,
								{
									tool: input.tool,
									callID: input.callID,
									args: deniedArgs,
								},
								deniedMessage,
								ctx.directory,
								// Same knob as the successful-call path (issue
								// #2041 Required 5): prm.max_trajectory_lines.
								{ maxLines: prmConfig.max_trajectory_lines },
							);
						} catch {
							/* D1 recording is observational; never alters the rethrow */
						}
					}
					// noteGateDenial never throws and mutates err.message in place.
					// `deniedArgs` sub-scopes the streak by dispatch target so an
					// interleaved successful `Task` → `explorer` cannot zero a
					// `Task` → `coder` denial loop (reviewer round-4).
					noteGateDenial(
						input.sessionID,
						input.tool,
						err,
						{
							enabled: guardrailsConfig.enabled,
							warnThreshold: guardrailsConfig.gate_denial_warn_threshold,
							stopThreshold: guardrailsConfig.gate_denial_stop_threshold,
						},
						deniedArgs,
					);
				}
				// Issue #2214: a denied Task call never fires toolAfter. If the
				// delegation gate (step 4) already durably began a coder
				// settlement for this callID before ANY later step in this
				// handler rejected it — fail-closed gates 5-8 OR the advisory
				// tail above the flag (issue #2268) — roll the DISPATCHED WAL
				// back to ABORTED so the task is not wedged until a process
				// restart. Never throws — the original denial propagates
				// unchanged.
				//
				// INVARIANT (issue #2268): rollback eligibility deliberately does
				// NOT consult `failClosedRegionCompleted`. This catch only runs
				// when toolBefore THREW, so the Task tool never executes and any
				// begun settlement is orphaned regardless of which region threw.
				// abortDeniedSettlementForCall is a callID-keyed no-op when no
				// settlement was begun for this call, so firing it
				// unconditionally is safe for non-settlement throws (reviewer/
				// docs/other tools). The gate-denial-wiring static guard pins
				// this contract.
				if (
					normalizeToolName(input.tool) === 'Task' ||
					normalizeToolName(input.tool) === 'task'
				) {
					try {
						await delegationGateHooks.abortDeniedSettlementForCall(
							input.callID,
						);
					} catch {
						/* rollback is best-effort; the denial still propagates */
					}
				}
				throw err;
			}
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Track tool usage + guardrails (after)
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'tool.execute.after': (async (input: any, output: any) => {
			const _dbg = !!process.env.DEBUG_SWARM;
			const _toolName = normalizeToolName(input.tool) ?? input.tool;
			if (_dbg)
				// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
				console.error(
					`[DIAG] toolAfter START tool=${_toolName} session=${input.sessionID}`,
				);

			const normalizedTool = normalizeToolName(input.tool);
			const isTaskTool = normalizedTool === 'Task' || normalizedTool === 'task';
			// (#1849) Resolve tool.execute.after args ONCE from the callID snapshot
			// (the SDK toolAfter input has NO args). Reused by the knowledge ack/
			// verdict/receipt collectors below so they see the delegation prompt +
			// subagent_type.
			const afterCtx = resolveToolAfterContext(
				input as { tool: string; sessionID: string; callID: string },
			);
			// Issue #2108: record the durable result of an admitted exact-bound
			// push (`PR_FEEDBACK` publication attempts). Fail-open — a missed
			// observation is recovered by the gate's reaper as `uncertain`, and
			// publication truth always comes from complete_pr_workflow's direct
			// remote verification. The gate session is resolved exactly as the
			// tool-before enforcement does (child sessions walk to their parent).
			try {
				const pushCommand = afterCtx.args?.command;
				if (
					typeof pushCommand === 'string' &&
					/^\s*git\s+push/i.test(pushCommand)
				) {
					const pushAttemptSessionID = await prWorkflowSessionResolver.resolve(
						input.sessionID,
					);
					await recordPrFeedbackPushAttemptResult(
						ctx.directory,
						{
							sessionID: pushAttemptSessionID,
							callID: input.callID,
							tool: input.tool,
						},
						pushCommand,
						output,
					);
				}
			} catch {
				// Fail-open by design (see comment above).
			}
			if (autoReviewConfig.enabled && isTaskTool) {
				await completeReviewerScopeLifecycle({
					directory: ctx.directory,
					tool: input.tool,
					args: afterCtx.args,
					output,
					parentSessionID: input.sessionID,
					callID: input.callID,
				});
			}

			const hookChain = async (): Promise<void> => {
				await activityHooks.toolAfter(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter activity done tool=${_toolName}`);
				await safeHook(trajectoryLoggerHook.toolAfter)(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(
						`[DIAG] toolAfter trajectoryLogger done tool=${_toolName}`,
					);
				// Per-delegate ack collection (Change 1, Task 1.5): reconcile the
				// directives shown to a returning subagent against its ack markers.
				// Fail-open; never blocks. Only acts on Task tool calls.
				// (#1849) tool.execute.after input has NO args — recover them from the
				// callID snapshot taken in toolBefore (guardrails/tool-before.ts) via
				// the host-boundary adapter, so the ack/verdict collectors see the
				// delegation prompt + subagent_type.
				if (knowledgeConfig.enabled) {
					await safeHook(() =>
						collectDelegateAcksAfter(
							ctx.directory,
							{
								tool: input.tool,
								sessionID: input.sessionID,
								args: afterCtx.args,
							},
							output,
						),
					)(input, output);
					// Reviewer DIRECTIVE_COMPLIANCE reconciliation (Change 2, Task 2.3):
					// parse a returning reviewer's per-ID verdicts into knowledge events.
					await safeHook(() =>
						collectReviewerVerdictsAfter(
							ctx.directory,
							{
								tool: input.tool,
								sessionID: input.sessionID,
								args: afterCtx.args,
							},
							output,
						),
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
							// #1821: also hand new candidates to the same-session
							// admission queue. The durable append stays the crash backstop.
							{
								enabled: learningConfig.realtime_admission.enabled,
								maxQueueSize: learningConfig.realtime_admission.max_queue_size,
							},
						),
					)(input, output);
				}
				// #1821 Workstream B: drain the same-session admission queue.
				// Called UNCONDITIONALLY and self-gating inside — there is deliberately
				// NO `return` here or anywhere else in `hookChain`, because an early
				// return would skip every downstream hook for non-Task tool calls.
				// The adapter's first check is `isTaskTool`, and its second is an O(1)
				// queue-depth probe, so the non-Task path does no I/O and takes no lock.
				await safeHook(async () => {
					const summary = await realtimeAdmissionAfter(
						ctx.directory,
						{ tool: input.tool, sessionID: input.sessionID },
						learningConfig.realtime_admission,
						async () => {
							const plan = await loadPlan(ctx.directory).catch(() => null);
							return {
								knowledgeConfig,
								projectName: plan?.title ?? 'unknown',
								phaseNumber: plan?.current_phase ?? 1,
								sessionID: input.sessionID,
								llmDelegate: createCuratorLLMDelegate(
									ctx.directory,
									'phase',
									input.sessionID,
								),
								onKnowledgeChanged: bumpKnowledgeGeneration,
							};
						},
					);
					// `DrainSummary`'s counters were computed and discarded here, which
					// made `deferred` and `failed` — the two that say the drain did NOT
					// finish its work — unobservable in production (issue #1821).
					// `log` is gated on OPENCODE_SWARM_DEBUG and writes to stderr, never
					// to a chat-visible stream (AGENTS.md invariant 10). `undefined`
					// means a gate short-circuited before any drain ran, which is the
					// overwhelmingly common case on the hot path and must stay silent.
					if (summary) {
						log('realtime admission drain', {
							sessionID: input.sessionID,
							...summary,
						});
					}
				})(input, output);
				// Reviewer receipt collection: persist a returning reviewer Task's
				// VERDICT/RISK/ISSUES block as a durable review receipt. Fail-open;
				// independent of the knowledge system.
				// (#1849) tool.execute.after input has NO args — pass the snapshot-
				// recovered args so the collector can parse subagent_type/prompt.
				await safeHook(async () => {
					await collectReviewerReceiptAfter(
						ctx.directory,
						{
							tool: input.tool,
							sessionID: input.sessionID,
							callID: input.callID,
							args: afterCtx.args,
						},
						output,
						{
							dispatcher: reviewModelDispatcher,
							config: autoReviewConfig,
							generatedAgentNames: instanceGeneratedAgentNames,
							agentModelRegistry: reviewAgentModelRegistry,
							injectAdvisory: advisoryInjector,
							validationScheduler: findingValidationScheduler,
						},
					);
				})(input, output);
				// Auto-review (opt-in): fire-and-forget execution-diff review by
				// the reviewer model at task/phase boundaries.
				await safeHook(autoReviewHook.toolAfter)(input, afterCtx);
				await safeHook(prmHook.toolAfter)(input, output);
				await guardrailsHooks.toolAfter(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter guardrails done tool=${_toolName}`);
				await safeHook(delegationLedgerHook.toolAfter)(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter ledger done tool=${_toolName}`);
				await safeHook(selfReviewHook.toolAfter)(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter selfReview done tool=${_toolName}`);
				await safeHook(memoryLifecycleHooks.toolAfter)(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter memory done tool=${_toolName}`);
				await safeHook(delegationGateHooks.toolAfter)(input, output);
				await safeHook(async () => {
					await observePhaseParticipationToolResult({
						directory: ctx.directory,
						tool: input.tool,
						parentSessionId: input.sessionID,
						callId: input.callID,
						output,
					});
				})(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(
						`[DIAG] toolAfter delegationGate done tool=${_toolName}`,
					);

				// Full-Auto v2: prompt-injection probe + subagent return check.
				// Both are non-throwing observers (errors swallowed by safeHook).
				await safeHook(fullAutoInputProbeHook.toolAfter)(input, output);
				await safeHook(fullAutoDelegationHook.toolAfter)(input, output);

				// PR auto-subscribe: observe `gh pr create` bash output and
				// subscribe the session to the created PR (fail-open observer;
				// internally gated by pr_monitor.enabled + auto_subscribe_on_pr_create).
				await safeHook(prAutoSubscribeHook.toolAfter)(input, output);

				// Adversarial semantic pattern detection on agent output
				if (isTaskTool && typeof output.output === 'string') {
					try {
						const adversarialMatches = detectAdversarialPatterns(output.output);
						if (adversarialMatches.length > 0) {
							const sessionId = input.sessionID;
							const session = swarmState.agentSessions.get(sessionId);
							if (session) {
								pushAdvisory(
									session,
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
					// (#1849) tool.execute.after input has no args; recover from the
					// callID snapshot taken in toolBefore (guardrails/tool-before.ts).
					recordToolCall(
						normalizedTool,
						resolveToolAfterContext(
							input as { tool: string; sessionID: string; callID: string },
						).args,
						input.sessionID,
					);
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
							pushAdvisory(session, spiralResult.message);
						}
					}
				} catch {
					// non-fatal
				}

				if (knowledgeCuratorHook)
					await safeHook(knowledgeCuratorHook)(input, output);
				if (hivePromoterHook) await safeHook(hivePromoterHook)(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter knowledge done tool=${_toolName}`);
				await safeHook(steeringConsumedHook)(input, output);
				await safeHook(coChangeSuggesterHook)(input, output);
				await safeHook(darkMatterDetectorHook)(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(`[DIAG] toolAfter intelligence done tool=${_toolName}`);
				await snapshotWriterHook(input, output);
				await toolSummarizerHook?.(input, output);
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
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
				if (repoGraphHook) {
					await safeHook(repoGraphHook.toolAfter)(input, output);
				}

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
					const truncatableTools = computeEffectiveTruncatableTools(
						defaultTruncatableTools,
						configuredTools,
					);
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
					// biome-ignore lint/suspicious/noConsole: toolAfter hook chain error — user must see to debug hook failures
					console.warn(warning);
				} else {
					addDeferredWarning(warning);
				}
			}

			// ── Task handoff runs AFTER hooks ───────────────────────────────
			// Hooks must see the original subagent identity to record evidence
			// correctly. The handoff restores architect identity afterward.
			if (isTaskTool) {
				const backgroundResultIsRunning =
					outputLooksLikeBackgroundRunning(output);
				const sessionId = input.sessionID;
				// Delegated-agent identity for this whole handoff (model resolution for
				// cost fields, pipeline advisories, and the delegation_end emit).
				// activeAgent is NOT a reliable source: subagents run in child sessions,
				// so the parent's activeAgent stays the architect, which mislabelled
				// every production delegation_end and kept the reviewer/critic pipeline
				// advisories below permanently dark.
				//
				// Two independent sources now resolve it, kept in this order:
				//  1. The pairing entry recorded when tool.execute.before emitted
				//     delegation_begin for this exact callID. Preferred, because using
				//     the begin-side value is what makes the begin/end pair symmetric.
				//     Deleted only when its delegation_end is emitted; background
				//     "running" placeholders retain theirs defensively (the host is not
				//     known to deliver a second tool.execute.after for the same callID
				//     today, so retained entries are simply bounded by the FIFO cap).
				//  2. The stored args snapshot's subagent_type. Equivalent in practice
				//     (the begin derives from the same field) and retained so this path
				//     still resolves if no begin was recorded for the callID — e.g. a
				//     plugin restart between before and after.
				const beganDelegation = _delegationTelemetryByCallID.get(input.callID);
				const storedSubagentType =
					typeof afterCtx.args?.subagent_type === 'string'
						? afterCtx.args.subagent_type
						: undefined;
				const agentName =
					beganDelegation?.agentName ||
					storedSubagentType ||
					swarmState.activeAgent.get(sessionId) ||
					'unknown';
				const baseAgentName = stripKnownSwarmPrefix(agentName);
				const preHandoffSession = swarmState.agentSessions.get(sessionId);
				const activeWindow = getActiveWindow(sessionId);
				const configuredModel =
					resolveRegisteredAgentModel(config, agentName) ??
					DEFAULT_MODELS[baseAgentName] ??
					DEFAULT_MODELS.default;
				const assistantUsage = consumeAssistantUsageForTask(sessionId, output);
				const costFields = buildDelegationCostFields({
					raw: { metadata: output.metadata, output, assistant: assistantUsage },
					model: configuredModel,
					gate: preHandoffSession?.lastDelegationReason,
					retry_index: activeWindow?.transientRetryCount,
					pricing: config.pricing,
				});
				const childSessionID = collectSessionIDs(output)[0];
				const recordMaterial = `${sessionId}\0${input.callID}`;
				costFields.record_id = createHash('sha256')
					.update(`delegation-cost-id-v1\0${recordMaterial}`)
					.digest('hex')
					.slice(0, 32);
				costFields.identity_fingerprint = createHash('sha256')
					.update(
						`delegation-cost-identity-v1\0${recordMaterial}\0${agentName}\0${configuredModel}`,
					)
					.digest('hex')
					.slice(0, 32);
				costFields.version = 1;
				costFields.parent_session_digest = createHash('sha256')
					.update(`delegation-cost-parent-v1\0${sessionId}`)
					.digest('hex')
					.slice(0, 32);
				if (childSessionID) {
					costFields.child_session_digest = createHash('sha256')
						.update(`delegation-cost-child-v1\0${childSessionID}`)
						.digest('hex')
						.slice(0, 32);
				}
				swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
				ensureAgentSession(sessionId, ORCHESTRATOR_NAME);
				const taskSession = swarmState.agentSessions.get(sessionId);
				if (taskSession) {
					taskSession.delegationActive = false;
					taskSession.lastAgentEventTime = Date.now();
					// A background Task's running placeholder is a handoff boundary,
					// not terminal completion. Restore architect continuation now, but
					// defer completion telemetry/advisories to the trusted terminal event.
					if (!backgroundResultIsRunning) {
						// Consume the pairing entry only now that its delegation_end is
						// actually emitted. agentName already prefers the begin-side
						// identity above. taskId uses `||` (not `??`) so a begin-side
						// EMPTY taskId — no task was current at dispatch — falls
						// through to currentTaskId, which guardrails toolAfter may
						// have populated during this very call.
						const costTaskId =
							beganDelegation?.taskId || taskSession.currentTaskId || '';
						_delegationTelemetryByCallID.delete(input.callID);
						telemetry.delegationEnd(
							sessionId,
							agentName,
							costTaskId,
							'completed',
							costFields,
						);
						if (
							childSessionID &&
							costFields.evidence_status !== 'complete' &&
							costFields.record_id &&
							costFields.identity_fingerprint
						) {
							trackPendingCostCorrection(childSessionID, {
								recordId: costFields.record_id,
								identityFingerprint: costFields.identity_fingerprint,
								parentSessionId: sessionId,
								parentSessionDigest: costFields.parent_session_digest,
								agentName,
								taskId: costTaskId,
								model: configuredModel,
								gate: preHandoffSession?.lastDelegationReason,
								retryIndex: activeWindow?.transientRetryCount,
								pricing: config.pricing,
								version: 1,
								currentFields: costFields,
							});
						}
						// Pipeline continuation advisory — prevents happy-path stall when
						// delegated agents return clean results. The architect must resume
						// direct tool execution for remaining QA gate steps.
						if (
							baseAgentName === 'reviewer' ||
							baseAgentName === 'test_engineer' ||
							baseAgentName === 'critic' ||
							baseAgentName === 'critic_sounding_board'
						) {
							pushAdvisory(
								taskSession,
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
							if (parsed) {
								let verdictMsg = `[SOUNDING_BOARD] Verdict: ${parsed.verdict}. ${parsed.reasoning}`;
								if (parsed.improvedQuestion)
									verdictMsg += ` Rephrase to: ${parsed.improvedQuestion}`;
								if (parsed.answer) verdictMsg += ` Answer: ${parsed.answer}`;
								if (parsed.warning) verdictMsg += ` WARNING: ${parsed.warning}`;
								pushAdvisory(taskSession, verdictMsg);
								taskSession.lastDelegationReason = 'critic_consultation';
							} else {
								// Parsing failed — inject a fallback so the architect is not left without
								// guidance. Use conservative behavior: treat as REPHRASE (needs review)
								// rather than silently approving. Expected format:
								// "Verdict: [APPROVED|REPHRASE|RESOLVE|UNNECESSARY]"
								pushAdvisory(
									taskSession,
									`[SOUNDING_BOARD] WARNING: Could not parse a structured verdict from ` +
										`critic_sounding_board response (${rawResponse.length} chars). ` +
										`Treat as REPHRASE — review the raw response before surfacing to user or escalating. ` +
										`Do not silently accept as resolved.`,
								);
							}
						}
					}
				}
				if (_dbg)
					// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
					console.error(
						`[DIAG] Task handoff DONE session=${sessionId} activeAgent=${swarmState.activeAgent.get(sessionId)}`,
					);
			}

			deleteStoredInputArgs(input.callID);
			if (_dbg)
				// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for tool execution flow
				console.error(`[DIAG] toolAfter COMPLETE tool=${_toolName}`);
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Track agent delegations and active agent
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'chat.message': (async (input: any, output: any) => {
			// Model-chain exhaustion is a blocking request-boundary condition. Keep
			// this preflight outside safeHook so the host cannot silently continue on
			// the primary/default model after every configured model is exhausted.
			try {
				if (input?.sessionID && typeof input?.agent === 'string') {
					const routeModel = resolveTaskRouteModelChain(String(input.agent));
					if (routeModel) {
						const resolution = await resolveTaskChatModelOverride({
							childSessionID: String(input.sessionID),
							role: routeModel.role,
							primaryModel: routeModel.primaryModel,
							fallbackModels: routeModel.fallbackModels,
							lookupParentSessionID: lookupParentSessionIDForTaskRoute,
						});
						if (resolution.status === 'exhausted') {
							const error = new Error(
								`MODEL_FALLBACK_EXHAUSTED: no configured model remains for ${routeModel.role}`,
							);
							error.name = 'TaskModelFallbackExhaustedError';
							throw error;
						}
					}
				}
			} catch (error) {
				if (
					error instanceof Error &&
					error.name === 'TaskModelFallbackExhaustedError'
				) {
					throw error;
				}
				// Parent lookup is advisory when no bound route can be resolved. The
				// existing safe handler below preserves diagnostics without blocking an
				// unrelated message.
			}

			await safeHook(
				// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
				async (input: any, output: any) => {
					if (process.env.DEBUG_SWARM)
						// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for chat message flow
						console.error(
							`[DIAG] chat.message agent=${input.agent ?? 'none'} session=${input.sessionID}`,
						);
					if (
						input?.sessionID &&
						typeof input?.agent === 'string' &&
						output &&
						typeof output === 'object' &&
						typeof (output as { message?: unknown }).message === 'object' &&
						(output as { message?: unknown }).message !== null
					) {
						const routeModel = resolveTaskRouteModelChain(String(input.agent));
						if (routeModel) {
							const resolution = await resolveTaskChatModelOverride({
								childSessionID: String(input.sessionID),
								role: routeModel.role,
								primaryModel: routeModel.primaryModel,
								fallbackModels: routeModel.fallbackModels,
								lookupParentSessionID: lookupParentSessionIDForTaskRoute,
							});
							if (resolution.status === 'override' && resolution.model) {
								(
									output as {
										message: {
											model?: {
												providerID: string;
												modelID: string;
											};
										};
									}
								).message.model = resolution.model;
							}
						}
					}
					await delegationHandler(input, output);

					// (#1849) Resolve + cache the canonical cohort id once per session
					// at chat.message (where sessionID + agent are reliably present), so
					// the system-enhancer's cohort-identity line and the
					// PromotionEvidenceRecord writer never re-run resolveCohortId (git)
					// on a hot path. Fail-open + bounded; ignored error leaves the cache
					// unset and callers fall back to readLinkPointer / re-resolve-once.
					if (input?.sessionID) {
						try {
							await cacheCohortIdAtMessage(ctx.directory, input.sessionID);
						} catch {
							/* non-blocking — cache stays unset */
						}
					}

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
						// biome-ignore lint/suspicious/noConsole: DEBUG_SWARM-gated diagnostic for chat message flow
						console.error(
							`[DIAG] chat.message DONE agent=${input.agent ?? 'none'}`,
						);
				},
			)(input, output);
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

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
// SQLite archive snapshot engine (issue #2030). Re-exported so the Node-side
// parity proof (scripts/repro-2030-archive-node.mjs) can exercise the REAL
// shipped engine — including the byte-budget preflight, typed reason_code,
// temp-then-rename publish, and row-count validation — under node:sqlite via
// the shared loader, not a standalone shim. Pure until invoked.
export { archiveSqliteSnapshot } from './commands/archive-sqlite.js';
export type {
	AgentName,
	AutomationCapabilities,
	AutomationConfig,
	AutomationMode,
	PipelineAgentName,
	PluginConfig,
	QAAgentName,
} from './config';
export { loadTier1EvaluationTasks } from './evaluation/fixtures.js';
export { recordTestImpactGateGroundTruth } from './evaluation/gate-ground-truth.js';
export type { EvaluatePrReviewRecoveryV1Options } from './evaluation/pr-review-recovery.js';
export { evaluatePrReviewRecoveryV1 } from './evaluation/pr-review-recovery.js';
export type {
	EvaluateCandidateV1Options,
	EvaluateCandidateV1Result,
} from './evaluation/public-api.js';
// Public evaluation API used by package-smoke and external optimizer tooling.
// These exports are pure until invoked and add no plugin-initialization work.
export {
	evaluateCandidateV1,
	evaluationV1,
} from './evaluation/public-api.js';
export type {
	AgentBlueprintV1,
	BlueprintPatchV1,
	HarnessBlueprintV1,
	HarnessCandidateManifestV1,
	OrchestrationSpecV1,
	PromptArtifactV1,
	ToolSpecV1,
} from './harness/contracts.js';
// Public declarative harness API. Callable and pure until explicitly invoked;
// it performs no plugin-initialization work and exposes no autonomous executor.
export { harnessMutationV1 } from './harness/public-api.js';
