import * as path from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';
import {
	AutomationConfigSchema,
	type AutomationStatusArtifact,
	type BackgroundAutomationManager,
	composeHandlers,
	consolidateSystemMessages,
	createAgentActivityHooks,
	createAutomationManager,
	createCoChangeSuggesterHook,
	createCompactionCustomizerHook,
	createContextBudgetHandler,
	createDarkMatterDetectorHook,
	createDelegationGateHook,
	createDelegationSanitizerHook,
	createDelegationTrackerHook,
	createGuardrailsHooks,
	createHivePromoterHook,
	createKnowledgeCuratorHook,
	createKnowledgeInjectorHook,
	createPhaseMonitorHook,
	createPipelineTrackerHook,
	createSnapshotWriterHook,
	createSteeringConsumedHook,
	createSystemEnhancerHook,
	createToolSummarizerHook,
	ensureAgentSession,
	GuardrailsConfigSchema,
	KnowledgeConfigSchema,
	loadSnapshot,
	log,
	ORCHESTRATOR_NAME,
	PlanSyncWorker,
	type PreflightTriggerManager,
	SummaryConfigSchema,
	safeHook,
	shouldRunOnStartup,
	stripKnownSwarmPrefix,
	swarmState,
	truncateToolOutput,
} from '@opencode-swarm/core';
import { createAgents, getAgentConfigs } from './agents';
import { createSwarmCommandHandler } from './commands';
import { loadPluginConfigWithMeta } from './config';
import type { V2SetupDependencies } from './host/v2/setup';
import { openCodeSwarmV2Setup } from './host/v2/setup';
import type { V2PluginContext } from './host/v2/types';
import {
	check_gate_status,
	checkpoint,
	complexity_hotspots,
	declare_scope,
	detect_domains,
	diff,
	evidence_check,
	extract_code_blocks,
	gitingest,
	imports,
	knowledge_query,
	lint,
	phase_complete,
	pkg_audit,
	pre_check_batch,
	retrieve_summary,
	save_plan,
	schema_drift,
	secretscan,
	symbols,
	test_runner,
	todo_extract,
	update_task_status,
	write_retro,
} from './tools/register';

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
const OpenCodeSwarm: Plugin = async (ctx) => {
	console.log(
		'[opencode-swarm] 🚀 Plugin startup begin — version 8.0.0-beta.0',
	);
	console.log('[opencode-swarm] ctx.directory:', ctx.directory);

	let config: ReturnType<typeof loadPluginConfigWithMeta>['config'];
	let loadedFromFile: boolean;
	try {
		const result = loadPluginConfigWithMeta(ctx.directory);
		config = result.config;
		loadedFromFile = result.loadedFromFile;
		console.log(
			'[opencode-swarm] ✓ Config loaded, loadedFromFile:',
			loadedFromFile,
		);
	} catch (err) {
		console.error(
			'[opencode-swarm] ✗ FATAL: loadPluginConfigWithMeta failed:',
			err instanceof Error ? err.stack : err,
		);
		throw err;
	}

	try {
		console.log('[opencode-swarm] → loadSnapshot...');
		await loadSnapshot(ctx.directory);
		console.log('[opencode-swarm] ✓ loadSnapshot complete');
	} catch (err) {
		console.error(
			'[opencode-swarm] ✗ FATAL: loadSnapshot failed:',
			err instanceof Error ? err.stack : err,
		);
		throw err;
	}

	// Declare all variables upfront so they're accessible in return statement
	let agents: ReturnType<typeof getAgentConfigs>;
	let agentDefinitions: ReturnType<typeof createAgents>;
	let pipelineHook: ReturnType<typeof createPipelineTrackerHook>;
	let systemEnhancerHook: ReturnType<typeof createSystemEnhancerHook>;
	let compactionHook: ReturnType<typeof createCompactionCustomizerHook>;
	let contextBudgetHandler: ReturnType<typeof createContextBudgetHandler>;
	let commandHandler: ReturnType<typeof createSwarmCommandHandler>;
	let activityHooks: ReturnType<typeof createAgentActivityHooks>;
	let delegationGateHooks: ReturnType<typeof createDelegationGateHook>;
	let delegationSanitizerHook: ReturnType<typeof createDelegationSanitizerHook>;
	let guardrailsConfig: ReturnType<typeof GuardrailsConfigSchema.parse>;
	let delegationHandler: ReturnType<typeof createDelegationTrackerHook>;
	let guardrailsHooks: ReturnType<typeof createGuardrailsHooks>;
	let summaryConfig: ReturnType<typeof SummaryConfigSchema.parse>;
	let toolSummarizerHook: ReturnType<typeof createToolSummarizerHook>;
	let knowledgeConfig: ReturnType<typeof KnowledgeConfigSchema.parse>;
	let knowledgeCuratorHook:
		| ReturnType<typeof createKnowledgeCuratorHook>
		| undefined;
	let hivePromoterHook: ReturnType<typeof createHivePromoterHook> | undefined;
	let knowledgeInjectorHook:
		| ReturnType<typeof createKnowledgeInjectorHook>
		| undefined;
	let steeringConsumedHook: ReturnType<typeof createSteeringConsumedHook>;
	let coChangeSuggesterHook: ReturnType<typeof createCoChangeSuggesterHook>;
	let darkMatterDetectorHook: ReturnType<typeof createDarkMatterDetectorHook>;
	let snapshotWriterHook: ReturnType<typeof createSnapshotWriterHook>;
	let automationConfig: ReturnType<typeof AutomationConfigSchema.parse>;
	let automationManager: BackgroundAutomationManager | undefined;
	let preflightTriggerManager: PreflightTriggerManager | undefined;

	try {
		console.log('[opencode-swarm] → initializing hooks and managers...');

		// Now assign all values (variables declared before try block for scope access)
		agents = getAgentConfigs(config);
		agentDefinitions = createAgents(config);
		pipelineHook = createPipelineTrackerHook(config, ctx.directory);
		systemEnhancerHook = createSystemEnhancerHook(config, ctx.directory);
		compactionHook = createCompactionCustomizerHook(config, ctx.directory);
		contextBudgetHandler = createContextBudgetHandler(config);
		commandHandler = createSwarmCommandHandler(
			ctx.directory,
			Object.fromEntries(agentDefinitions.map((agent) => [agent.name, agent])),
		);
		activityHooks = createAgentActivityHooks(config, ctx.directory);
		delegationGateHooks = createDelegationGateHook(config, ctx.directory);
		delegationSanitizerHook = createDelegationSanitizerHook(ctx.directory);
		// Fail-secure: honor explicit guardrails.enabled === false (preserving the full
		// guardrails block), otherwise let Zod schema defaults fill in enabled: true.
		const guardrailsFallback =
			config.guardrails?.enabled === false
				? { ...config.guardrails, enabled: false }
				: (config.guardrails ?? {});
		guardrailsConfig = GuardrailsConfigSchema.parse(guardrailsFallback);

		// SECURITY AUDIT: Emit explicit warning when guardrails are disabled via user config
		// This is a security-relevant action that requires explicit acknowledgment
		if (loadedFromFile && guardrailsConfig.enabled === false) {
			console.warn('');
			console.warn(
				'══════════════════════════════════════════════════════════════',
			);
			console.warn(
				'[opencode-swarm] 🔴 SECURITY WARNING: GUARDRAILS ARE DISABLED',
			);
			console.warn(
				'══════════════════════════════════════════════════════════════',
			);
			console.warn(
				'Guardrails have been explicitly disabled in user configuration.',
			);
			console.warn('This disables safety measures including:');
			console.warn('  - Tool call limits');
			console.warn('  - Duration limits');
			console.warn('  - Repetition detection');
			console.warn('  - Error rate limits');
			console.warn('  - Idle timeouts');
			console.warn('');
			console.warn(
				'Only disable guardrails if you fully understand the security implications.',
			);
			console.warn(
				'To re-enable guardrails, set "guardrails.enabled" to true in your config.',
			);
			console.warn(
				'══════════════════════════════════════════════════════════════',
			);
			console.warn('');
		}

		delegationHandler = createDelegationTrackerHook(
			config,
			guardrailsConfig.enabled,
		);
		guardrailsHooks = createGuardrailsHooks(ctx.directory, guardrailsConfig);
		summaryConfig = SummaryConfigSchema.parse(config.summaries ?? {});
		toolSummarizerHook = createToolSummarizerHook(summaryConfig, ctx.directory);

		// v6.17 Knowledge system hooks — fire-and-forget, wrapped in safeHook
		knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
		knowledgeCuratorHook = knowledgeConfig.enabled
			? createKnowledgeCuratorHook(ctx.directory, knowledgeConfig)
			: undefined;
		hivePromoterHook =
			knowledgeConfig.enabled && knowledgeConfig.hive_enabled
				? createHivePromoterHook(ctx.directory, knowledgeConfig)
				: undefined;
		knowledgeInjectorHook = knowledgeConfig.enabled
			? createKnowledgeInjectorHook(ctx.directory, knowledgeConfig)
			: undefined;

		// v6.18 Steering acknowledgment hook — auto-acknowledges unconsumed steering directives
		steeringConsumedHook = createSteeringConsumedHook(ctx.directory);

		// v6.18 Agent intelligence hooks — co-change suggestions and dark-matter gap detection
		coChangeSuggesterHook = createCoChangeSuggesterHook(ctx.directory);
		darkMatterDetectorHook = createDarkMatterDetectorHook(ctx.directory);
		// v6.18 Session persistence — write state snapshot after each tool call
		snapshotWriterHook = createSnapshotWriterHook(ctx.directory);

		// Parse automation config (v6.7 feature flags)
		// Read flags without activating - scaffold only for now
		automationConfig = AutomationConfigSchema.parse(config.automation ?? {});

		// Initialize background automation framework (scaffold only - no business features yet)
		// Only enabled when automation mode is not 'manual' (default-off behavior)

		if (automationConfig.mode !== 'manual') {
			automationManager = createAutomationManager(automationConfig);

			// v6.7 Task 5.5: Initialize trigger manager (plumbing only, no preflight logic yet)
			const { PreflightTriggerManager: PTM } = await import(
				'@opencode-swarm/core'
			);
			preflightTriggerManager = new PTM(automationConfig);

			// v6.7 Task 5.5: Initialize status artifact for GUI visibility
			const { AutomationStatusArtifact: ASA } = await import(
				'@opencode-swarm/core'
			);
			const swarmDir = path.resolve(ctx.directory, '.swarm');
			const statusArtifact = new ASA(swarmDir);
			statusArtifact.updateConfig(
				automationConfig.mode,
				automationConfig.capabilities,
			);

			// v6.8 Task 1.1: Wire evidence summary integration
			if (automationConfig.capabilities?.evidence_auto_summaries === true) {
				const { createEvidenceSummaryIntegration } = await import(
					'@opencode-swarm/core'
				);
				createEvidenceSummaryIntegration({
					automationConfig,
					directory: ctx.directory,
					swarmDir: ctx.directory, // NOTE: persistSummary appends .swarm/ internally
					summaryFilename: 'evidence-summary.json',
				});
				log('Evidence summary integration initialized', {
					directory: ctx.directory,
				});
			}

			// v6.8 Task 2.2: Wire preflight integration
			if (automationConfig.capabilities?.phase_preflight === true) {
				const { createPreflightIntegration } = await import(
					'@opencode-swarm/core'
				);
				try {
					const { manager } = createPreflightIntegration({
						automationConfig,
						directory: ctx.directory,
						swarmDir,
					});
					preflightTriggerManager = manager;
					log('Preflight integration initialized', {
						directory: ctx.directory,
					});
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
				preflightEnabled: preflightTriggerManager?.isEnabled(),
			});
		}

		// v6.7 Task 5.7: Config Doctor - run on startup if automation flags permit
		// Runs in background-safe way (non-blocking, no errors propagate)
		// SECURITY: Default is scan-only (autoFix=false). Autofix requires explicit opt-in
		// via config_doctor_autofix capability.
		if (shouldRunOnStartup(automationConfig)) {
			// Autofix is opt-in only - requires explicit config_doctor_autofix capability
			const enableAutofix =
				automationConfig.capabilities?.config_doctor_autofix === true;

			// Dynamically import to avoid circular dependencies
			import('@opencode-swarm/core').then(({ runConfigDoctorWithFixes }) => {
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

		console.log('[opencode-swarm] ✓ all hooks initialized');
	} catch (err) {
		console.error(
			'[opencode-swarm] ✗ FATAL: hook/manager initialization failed:',
			err instanceof Error ? err.stack : err,
		);
		throw err;
	}

	console.log(
		'[opencode-swarm] ✓ Plugin startup complete — returning plugin object',
	);

	return {
		name: 'opencode-swarm',

		// Register all agents
		agent: agents,

		// Register tools
		tool: {
			check_gate_status,
			checkpoint,
			complexity_hotspots,
			detect_domains,
			evidence_check,
			extract_code_blocks,
			gitingest,
			imports,
			knowledge_query,
			lint,
			diff,
			pkg_audit,
			phase_complete,
			pre_check_batch,
			retrieve_summary,
			save_plan,
			schema_drift,
			secretscan,
			symbols,
			test_runner,
			todo_extract,
			update_task_status,
			write_retro,
			declare_scope,
		},

		// Configure OpenCode - merge agents into config
		config: async (opencodeConfig: Record<string, unknown>) => {
			// Merge agent configs (don't override default_agent)
			if (!opencodeConfig.agent) {
				opencodeConfig.agent = { ...agents };
			} else {
				Object.assign(opencodeConfig.agent, agents);
			}

			// Register /swarm command
			opencodeConfig.command = {
				...((opencodeConfig.command as Record<string, unknown>) || {}),
				swarm: {
					// Template is required by OpenCode and always sent to the LLM.
					// Keep it minimal — instructional text confuses non-frontier models.
					// The actual command is handled by command.execute.before hook.
					template: '/swarm $ARGUMENTS',
					description:
						'Swarm management commands: /swarm [status|plan|agents|history|config|evidence|handoff|archive|diagnose|preflight|sync-plan|benchmark|export|reset|rollback|retrieve|clarify|analyze|specify|dark-matter|knowledge|curate]',
				},
				// Individual subcommands for discoverability by weaker models (Haiku-class)
				'swarm-status': {
					template: '/swarm status',
					description:
						'Use /swarm status to show current swarm status and active phase',
				},
				'swarm-plan': {
					template: '/swarm plan $ARGUMENTS',
					description:
						'Use /swarm plan to view or filter the current execution plan',
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
				'swarm-dark-matter': {
					template: '/swarm dark-matter',
					description: 'Use /swarm dark-matter to detect hidden file couplings',
				},
				'swarm-knowledge': {
					template: '/swarm knowledge $ARGUMENTS',
					description:
						'Use /swarm knowledge for knowledge management (quarantine/restore/migrate)',
				},
				'swarm-curate': {
					template: '/swarm curate',
					description:
						'Use /swarm curate to curate knowledge artifacts and entries',
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
				pipelineHook['experimental.chat.messages.transform'],
				contextBudgetHandler,
				guardrailsHooks.messagesTransform,
				delegationGateHooks.messagesTransform,
				delegationSanitizerHook,
				knowledgeInjectorHook, // v6.17 knowledge injection
				// Final transformation: consolidate multiple system messages into one
				(_input: unknown, output: { messages?: unknown[] }): Promise<void> => {
					if (output.messages) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						// biome-ignore lint/suspicious/noExplicitAny: consolidateSystemMessages accepts unknown[]
						output.messages = consolidateSystemMessages(output.messages as any);
					}
					return Promise.resolve();
				},
			].filter((fn): fn is NonNullable<typeof fn> => Boolean(fn)),
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		) as any,

		// Inject system prompt enhancements + phase monitor (when phase_preflight or knowledge enabled)
		'experimental.chat.system.transform': composeHandlers(
			...([
				systemEnhancerHook['experimental.chat.system.transform'],
				automationConfig.capabilities?.phase_preflight === true &&
				preflightTriggerManager
					? createPhaseMonitorHook(ctx.directory, preflightTriggerManager)
					: knowledgeConfig.enabled
						? createPhaseMonitorHook(ctx.directory)
						: undefined,
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
			// If no active agent is mapped for this session, it's the primary agent (architect)
			// Subagent delegations always set activeAgent via chat.message before tool calls
			if (!swarmState.activeAgent.has(input.sessionID)) {
				swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);
			}

			// Revert to primary agent if delegation appears stale
			// Delegation is stale if:
			// 1. delegationActive is explicitly false, OR
			// 2. The session's lastAgentEventTime is >10s old (subagent completed, no chat.message reset)
			// 10s window is tight enough to prevent architect misidentification after delegation
			// but loose enough to allow for slow subagent operations (file I/O, network)
			// NOTE: Uses lastAgentEventTime (not lastToolCallTime) to ensure tool activity
			// does not prevent stale subagent identity from being detected
			const session = swarmState.agentSessions.get(input.sessionID);
			const activeAgent = swarmState.activeAgent.get(input.sessionID);
			if (session && activeAgent && activeAgent !== ORCHESTRATOR_NAME) {
				const stripActive = stripKnownSwarmPrefix(activeAgent);
				if (stripActive !== ORCHESTRATOR_NAME) {
					const staleDelegation =
						!session.delegationActive ||
						Date.now() - session.lastAgentEventTime > 10000;
					if (staleDelegation) {
						swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);
						ensureAgentSession(input.sessionID, ORCHESTRATOR_NAME);
					}
				}
			}

			// Guardrails runs first WITHOUT safeHook — throws must propagate to block tools
			await guardrailsHooks.toolBefore(input, output);
			// Activity tracking runs second WITH safeHook — errors should not propagate
			await safeHook(activityHooks.toolBefore)(input, output);
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Track tool usage + guardrails (after)
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'tool.execute.after': (async (input: any, output: any) => {
			// Run existing handlers
			await activityHooks.toolAfter(input, output);
			await guardrailsHooks.toolAfter(input, output);
			await safeHook(delegationGateHooks.toolAfter)(input, output);
			// v6.17 Knowledge hooks — after guardrails, before summarizer
			if (knowledgeCuratorHook)
				await safeHook(knowledgeCuratorHook)(input, output);
			if (hivePromoterHook) await safeHook(hivePromoterHook)(input, output);
			// v6.18 Steering acknowledgment — auto-acknowledges unconsumed directives
			await safeHook(steeringConsumedHook)(input, output);
			// v6.18 Agent intelligence hooks — co-change suggestions and dark-matter gap detection
			await safeHook(coChangeSuggesterHook)(input, output);
			await safeHook(darkMatterDetectorHook)(input, output);
			// v6.18 Session persistence — write snapshot after each tool call
			await snapshotWriterHook(input, output);
			await toolSummarizerHook?.(input, output);

			// Tool output truncation (after summarizer to avoid double-processing)
			const toolOutputConfig = config.tool_output;
			if (
				toolOutputConfig &&
				toolOutputConfig.truncation_enabled !== false &&
				typeof output.output === 'string'
			) {
				// Skip structured JSON results
				const skipTools = [
					'pre_check_batch',
					'pkg_audit',
					'schema_drift',
					'sbom_generate',
				];
				if (!skipTools.includes(input.tool)) {
					// Check for per-tool override or use default
					const maxLines =
						toolOutputConfig.per_tool?.[input.tool] ??
						toolOutputConfig.max_lines ??
						150;

					// Only truncate diff and symbols outputs
					if (input.tool === 'diff' || input.tool === 'symbols') {
						output.output = truncateToolOutput(
							output.output,
							maxLines,
							input.tool,
						);
					}
				}
			}

			// Deterministic handoff: when task tool completes, force handoff to architect
			// This ensures architect takes over even if chat.message is delayed
			// NOTE: Must NOT rely on chat.message ordering
			// Normalize tool name to match the format used by plugin runtime (e.g., 'tool.execute.Task' -> 'Task')
			const normalizedTool = input.tool.replace(/^[^:]+[:.]/, '');
			if (normalizedTool === 'Task' || normalizedTool === 'task') {
				const sessionId = input.sessionID;

				// Set active agent to architect
				swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
				// Ensure session is architect and reset state
				ensureAgentSession(sessionId, ORCHESTRATOR_NAME);
				// Mark delegation as inactive
				const session = swarmState.agentSessions.get(sessionId);
				if (session) {
					session.delegationActive = false;
					// Update agent event timestamp for stale detection
					session.lastAgentEventTime = Date.now();
				}
			}
			// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		}) as any,

		// Track agent delegations and active agent
		// biome-ignore lint/suspicious/noExplicitAny: Plugin API requires generic hook wrappers
		'chat.message': safeHook(delegationHandler) as any,

		// v6.7 Background automation framework (scaffold only)
		// Exposed for future Task 5.x business feature integration
		automation: automationManager,
	};
};

/**
 * Shared server-initialization wrapper (issue #3151, adapted from the 7.x
 * #3004 / ADR-0003 seam): counts invocations (warns on dual host load —
 * module-level swarm state is shared between invocations) and surfaces init
 * failures to stderr before re-throwing, so both the v1 `server()` entry and
 * the v2 `setup()` entry share the identical FATAL surface. OpenCode's plugin
 * loader silently drops a plugin whose entry rejects, leaving the user with no
 * commands/agents and no visible error (issue #675) — raw stderr here is the
 * one place it is justified.
 */
let serverInitInvocations = 0;

const runServerInit = async (ctx: Parameters<Plugin>[0]) => {
	serverInitInvocations += 1;
	if (serverInitInvocations > 1) {
		log(
			'[opencode-swarm] WARNING: plugin initialization invoked more than once in this process; module-level swarm state is shared between invocations (dual host load?)',
		);
	}
	try {
		return await OpenCodeSwarm(ctx);
	} catch (err) {
		const stack =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(
			'[opencode-swarm] FATAL: plugin initialization failed. Plugin will not be available.',
		);
		console.error(stack);
		throw err;
	}
};

// Dual-shape default export (issue #3151, mirroring the 7.x #3004 export):
// v1 hosts (OpenCode 1, @opencode-ai/plugin 1.x) call `server()`; OpenCode 2
// hosts (@opencode/plugin 2.x) decode the default export against
// `{ id, setup | effect }` (excess keys ignored) and call `setup(ctx)` — the
// v2 registration surface lives in src/host/v2/. `server` routes through
// runServerInit so both entries share the dual-invocation warning + FATAL
// surface. `satisfies` keeps the wrapper type-checked against the inferred
// shape without loosening the OpenCodeSwarm function's `Plugin` type. The id
// literal must match the package name in package.json.
export default {
	id: 'opencode-swarm' as const,
	server: async (ctx) => runServerInit(ctx),
	setup: (ctx: unknown) =>
		openCodeSwarmV2Setup(ctx as V2PluginContext, {
			// Dependency-injected so src/host/v2 never imports this module (no
			// index ↔ host cycle); the cast bridges the structural subset the
			// adapter declares to the full inferred hooks type.
			runInit: runServerInit as unknown as V2SetupDependencies['runInit'],
		}),
} satisfies {
	id: string;
	server: Plugin;
	setup: (ctx: never) => Promise<() => Promise<void>>;
};

export type { AgentDefinition } from './agents';
// Re-export backward-compat layer for README-named exports
export * from './compat';
// Export types for consumers
export type {
	AgentName,
	AutomationCapabilities,
	AutomationConfig,
	AutomationMode,
	PipelineAgentName,
	PluginConfig,
	QAAgentName,
} from './config';
