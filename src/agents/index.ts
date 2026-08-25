import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk';
import {
	loadAgentPrompt,
	type PluginConfig,
	type SwarmConfig,
} from '../config';
import { splitEmbeddedAgentVariant } from '../config/agent-model';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	COUNCIL_AGENT_TOOL_MAP,
	DEFAULT_MODELS,
	EXTERNAL_SKILL_AGENT_TOOL_MAP,
	GENERAL_COUNCIL_AGENT_TOOL_MAP,
	MEMORY_AGENT_TOOL_MAP,
	SKILL_AGENT_TOOL_MAP,
	TURBO_AGENT_TOOL_MAP,
} from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import { resolvePlanningProfile } from '../plan/planning-profile';
import {
	addDeferredWarning,
	advisoryWarn,
} from '../services/warning-buffer.js';
import { log } from '../utils/logger';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
import { type AgentDefinition, createArchitectAgent } from './architect';
import { CODER_MEMORY_OUTCOME_GUIDANCE, createCoderAgent } from './coder';
import {
	DOMAIN_EXPERT_COUNCIL_PROMPT,
	GENERALIST_COUNCIL_PROMPT,
	SKEPTIC_COUNCIL_PROMPT,
} from './council-prompts';
import {
	CRITIC_MEMORY_OUTCOME_GUIDANCE,
	type CriticRole,
	createCriticAgent,
	createCriticAutonomousOversightAgent,
} from './critic';
import { type CuratorRole, createCuratorAgent } from './curator-agent';
import { createDesignerAgent } from './designer';
import { createDocsAgent } from './docs';
import {
	createExplorerAgent,
	EXPLORER_MEMORY_OUTCOME_GUIDANCE,
} from './explorer';
import { createResearcherAgent } from './researcher';
import {
	createReviewerAgent,
	REVIEWER_MEMORY_OUTCOME_GUIDANCE,
} from './reviewer';
import { createSkillImproverAgent } from './skill-improver';
import { createSMEAgent } from './sme';
import { createSpecWriterAgent } from './spec-writer';
import {
	assertNoUnresolvedPlaceholders,
	emptyProjectContext,
	type ProjectContext,
} from './template';
import { createTestEngineerAgent } from './test-engineer';

export type { AgentDefinition } from './architect';

/**
 * Test-only dependency-injection seam. `getAgentConfigs` calls
 * `_internals.createAgents(...)` instead of the module-local `createAgents`
 * directly, so tests can substitute a synthetic agent set (e.g. a primary
 * agent whose definition already declares a `permission` block) without
 * `mock.module`, which leaks across files in Bun's shared test-runner
 * process. Mutating this object is file-scoped and trivially restorable via
 * `afterEach`.
 */
export const _internals: {
	createAgents: typeof createAgents;
} = {
	createAgents,
};

// Track agents for which we've already warned about missing config
const warnedAgents = new Set<string>();

const NONTRANSIENT_STOP_PROTOCOL = [
	'',
	'## NON-TRANSIENT TOOL FAILURE PROTOCOL — MANDATORY',
	'Apply this protocol when a tool reports ParserError, ParseError, MissingEndCurlyBrace, CommandNotFoundException, a command-not-found/not-recognized error, or [sandbox] BLOCKED.',
	'It also applies when guardrails report NON-TRANSIENT STOP or NON-TRANSIENT CIRCUIT BREAKER — including the third same-category permanent failure:',
	'1. STOP. Do not retry the same operation with a different command, shell, tool, quoting style, or wrapper.',
	'2. Treat the failure as structural, not transient. Do not spend retry budget on it.',
	'3. Report BLOCKED with the exact error category and the command/tool that failed.',
	'4. Wait for corrected input, environment, scope, or a verified new invocation before continuing.',
].join('\n');

// Module-level map of swarm agents config for runtime fallback resolution by guardrails
// Keyed by swarmId: "default" for the default swarm, "local", "fast", "precise", etc. for named swarms
const _swarmAgentsMap = new Map<
	string,
	Record<
		string,
		{ model?: string; fallback_models?: string[]; disabled?: boolean }
	>
>();

// Tracks gated-agent advisory messages emitted in the current createAgents
// call. Top-level config.agents is merged into every swarm (see ~L933), so
// without dedupe the advisory would fire once per swarm. Cleared in
// createAgents. Plugin init calls createAgents twice (src/index.ts:647 via
// getAgentConfigs and :653 directly), so a misconfigured gated agent produces
// exactly 2 identical deferred warnings per init — cosmetic, accepted.
// Issue #1914 Defect 3 / critic item 5.
const _emittedGatedAgentAdvisories = new Set<string>();

/**
 * Strip the user-defined swarm prefix from an agent name to get the base
 * canonical role.
 *
 * The `swarmPrefix` argument is the swarm ID that the USER configured in
 * their `swarms` map — it is an arbitrary string, NOT one of a known list.
 * Examples of valid prefixes: "banana", "acme-prod", "customer123",
 * "mySwarm". The plugin must not assume any fixed set of swarm names.
 *
 * Example: agentName="banana_coder" with swarmPrefix="banana" -> "coder".
 *
 * Returns the name unchanged if `swarmPrefix` is empty or does not match.
 */
export function stripSwarmPrefix(
	agentName: string,
	swarmPrefix?: string,
): string {
	if (!swarmPrefix || !agentName) return agentName;
	const prefixWithUnderscore = `${swarmPrefix}_`;
	if (agentName.startsWith(prefixWithUnderscore)) {
		return agentName.substring(prefixWithUnderscore.length);
	}
	return agentName;
}

/**
 * Extract the swarm ID from a prefixed agent name.
 * For multi-swarm configurations, agent names are prefixed: "swarmId_agentName"
 * For the default swarm, agent names have no prefix.
 *
 * Example: "local_coder" -> "local", "coder" -> undefined (default swarm)
 * The regex matches everything before the first underscore.
 */
export function extractSwarmIdFromAgentName(
	agentName: string,
): string | undefined {
	if (!agentName) return undefined;
	const match = agentName.match(/^([^_]+)_/);
	return match ? match[1] : undefined;
}

/**
 * Get the model for an agent within a specific swarm config
 */
function getModelForAgent(
	agentName: string,
	swarmAgents?: Record<
		string,
		{
			model?: string;
			temperature?: number;
			disabled?: boolean;
			fallback_models?: string[];
		}
	>,
	swarmPrefix?: string,
	quiet?: boolean,
): string {
	// Strip the user-configured swarm prefix to get the canonical role
	// (e.g., "banana_coder" with swarmPrefix="banana" -> "coder").
	const baseAgentName = stripSwarmPrefix(agentName, swarmPrefix);

	// 1. Check explicit override
	const explicit = swarmAgents?.[baseAgentName]?.model;
	if (explicit) return explicit;

	// NOTE: fallback_models resolution happens at runtime in guardrails (toolAfter),
	// not here. getModelForAgent runs once at agent creation. The guardrails hook
	// modifies the swarmAgents config in _swarmAgentsMap directly when session.model_fallback_index > 0.
	// The config's fallback_models array is read by guardrails to select the fallback.

	// 2. Default from constants — warn once per agent if not in config
	const resolvedModel = DEFAULT_MODELS[baseAgentName] ?? DEFAULT_MODELS.default;
	if (!warnedAgents.has(baseAgentName)) {
		warnedAgents.add(baseAgentName);
		if (!quiet) {
			advisoryWarn(
				`[swarm] Agent '${baseAgentName}' not found in config — using default model '${resolvedModel}'. Add it to opencode-swarm.json to customize.`,
			);
		} else {
			addDeferredWarning(
				`[swarm] Agent '${baseAgentName}' not found in config — using default model '${resolvedModel}'. Add it to opencode-swarm.json to customize.`,
			);
		}
	}
	return resolvedModel;
}

/**
 * Resolve the fallback model for an agent based on its config and fallback index.
 * Called by guardrails at runtime when a transient model error is detected.
 *
 * Fallback inheritance:
 * - curator_init/curator_phase inherit fallback_models from explorer if not explicitly configured
 * - This matches the model inheritance: curator agents default to explorer's model
 */
export function resolveFallbackModel(
	agentBaseName: string,
	fallbackIndex: number,
	swarmAgents?: Record<
		string,
		{
			model?: string;
			temperature?: number;
			disabled?: boolean;
			fallback_models?: string[];
		}
	>,
): string | null {
	const agentConfig = swarmAgents?.[agentBaseName];

	// 1. Check if agent has explicit fallback_models (even if empty)
	let fallbackModels = agentConfig?.fallback_models;

	// 2. If not explicitly set, check if this is a curator agent that should inherit from explorer
	// Only inherit if the curator agent does NOT have fallback_models key at all.
	// All four curator modes default their model to explorer's (see createSwarmAgents:
	// curator_init/phase/postmortem/consolidation all use `?? getModel('explorer')`), so
	// they inherit explorer's fallback chain too — otherwise consolidation-mode dispatch
	// (memory-consolidation service) would fail over to nothing while the other modes do.
	if (
		fallbackModels === undefined &&
		(agentBaseName === 'curator_init' ||
			agentBaseName === 'curator_phase' ||
			agentBaseName === 'curator_postmortem' ||
			agentBaseName === 'curator_consolidation')
	) {
		fallbackModels = swarmAgents?.explorer?.fallback_models;
	}

	if (!fallbackModels || fallbackModels.length === 0) return null;
	if (fallbackIndex < 1 || fallbackIndex > fallbackModels.length) return null;
	return fallbackModels[fallbackIndex - 1];
}

/**
 * Get the swarm agents config (for runtime fallback resolution by guardrails).
 *
 * @param swarmId - The swarm ID to retrieve config for. Defaults to 'default' for the default swarm.
 *                  For multi-swarm configs, use the swarm's ID (e.g., 'local', 'fast', 'precise').
 *                  Can also be extracted from a prefixed agent name using extractSwarmIdFromAgentName().
 */
export function getSwarmAgents(
	swarmId?: string,
):
	| Record<
			string,
			{ model?: string; fallback_models?: string[]; disabled?: boolean }
	  >
	| undefined {
	const id = swarmId ?? 'default';
	return _swarmAgentsMap.get(id);
}

/**
 * Check if an agent is disabled in swarm config
 */
function isAgentDisabled(
	agentName: string,
	swarmAgents?: Record<string, { disabled?: boolean }>,
	swarmPrefix?: string,
): boolean {
	const baseAgentName = stripSwarmPrefix(agentName, swarmPrefix);
	return swarmAgents?.[baseAgentName]?.disabled === true;
}

/**
 * Get temperature override for an agent
 */
function getTemperatureOverride(
	agentName: string,
	swarmAgents?: Record<string, { temperature?: number }>,
	swarmPrefix?: string,
): number | undefined {
	const baseAgentName = stripSwarmPrefix(agentName, swarmPrefix);
	return swarmAgents?.[baseAgentName]?.temperature;
}

/**
 * Get variant (reasoning-effort) override for an agent.
 *
 * OpenCode reads the agent's reasoning effort from a top-level `variant` field
 * on the agent definition (sibling to `model`), NOT from a third `/variant`
 * segment in the model string. The TUI accepts `provider/model/variant` only
 * because its model picker rewrites the input through a variant-aware resolver
 * before applying it to the session; the agent loader uses the basic
 * 2-segment parser, so encoding the variant in `model` raises
 * ProviderModelNotFoundError. We expose `variant` as its own override field.
 */
function getVariantOverride(
	agentName: string,
	swarmAgents?: Record<string, { variant?: string }>,
	swarmPrefix?: string,
): string | undefined {
	const baseAgentName = stripSwarmPrefix(agentName, swarmPrefix);
	return swarmAgents?.[baseAgentName]?.variant;
}

/**
 * Apply config overrides to an agent definition
 */
function applyOverrides(
	agent: AgentDefinition,
	swarmAgents?: Record<
		string,
		{
			temperature?: number;
			variant?: string;
			reasoning?: { effort?: 'low' | 'medium' | 'high' | 'max' };
			thinking?: { type?: 'enabled' | 'disabled'; budget_tokens?: number };
		}
	>,
	swarmPrefix?: string,
	quiet?: boolean,
): AgentDefinition {
	const tempOverride = getTemperatureOverride(
		agent.name,
		swarmAgents,
		swarmPrefix,
	);
	if (tempOverride !== undefined) {
		agent.config.temperature = tempOverride;
	}
	const variantOverride = getVariantOverride(
		agent.name,
		swarmAgents,
		swarmPrefix,
	);
	// Auto-split variant from model string for backward compatibility.
	// Only applies when the last segment is a known reasoning-effort variant
	// (see KNOWN_VARIANT_VALUES above).  Multi-part model IDs such as
	// "lmstudio/qwen/qwen3.6-35b-a3b" are left intact because "qwen3.6-35b-a3b"
	// is not a known variant token — stripping it would produce a wrong model
	// path and raise ProviderModelNotFoundError.
	const embeddedModel = agent.config.model
		? splitEmbeddedAgentVariant(agent.config.model)
		: undefined;
	if (embeddedModel?.variant) {
		const autoVariant = embeddedModel.variant;
		const cleanedModel = embeddedModel.model;
		const effectiveVariant = variantOverride ?? autoVariant;
		if (!quiet) {
			advisoryWarn(
				`[swarm] Deprecation: model "${agent.config.model}" embeds variant. ` +
					`Use "model": "${cleanedModel}", "variant": "${effectiveVariant}" instead.`,
			);
		} else {
			addDeferredWarning(
				`[swarm] Deprecation: model "${agent.config.model}" embeds variant. ` +
					`Use "model": "${cleanedModel}", "variant": "${effectiveVariant}" instead.`,
			);
		}
		agent.config.model = cleanedModel;
		// Use explicit variant override if set, otherwise use auto-split variant
		(agent.config as { variant?: string }).variant = effectiveVariant;
	} else if (variantOverride !== undefined) {
		// `variant` is not declared on @opencode-ai/sdk's AgentConfig type but
		// the runtime Agent struct includes it (see opencode source:
		// `variant: r.optional(r.String)` in the Agent schema). The SDK type
		// has an open-ended index signature so this is structurally valid;
		// the cast just satisfies the strict known-keys check.
		(agent.config as { variant?: string }).variant = variantOverride;
	}

	// Plumb provider-native extended-reasoning / extended-thinking overrides
	// (issue #1220). These were previously silently dropped at config parse
	// time because `AgentOverrideConfigSchema` did not declare them. Now that
	// the schema accepts them, we forward them to the SDK as-is. Like
	// `variant` above, the cast satisfies the strict known-keys check on
	// @opencode-ai/sdk's AgentConfig type; the SDK's open-ended index
	// signature makes this structurally valid.
	const baseAgentName = stripSwarmPrefix(agent.name, swarmPrefix);
	const reasoningOverride = swarmAgents?.[baseAgentName]?.reasoning;
	if (reasoningOverride !== undefined) {
		(agent.config as { reasoning?: typeof reasoningOverride }).reasoning =
			reasoningOverride;
	}
	const thinkingOverride = swarmAgents?.[baseAgentName]?.thinking;
	if (thinkingOverride !== undefined) {
		(agent.config as { thinking?: typeof thinkingOverride }).thinking =
			thinkingOverride;
	}

	return agent;
}

/**
 * Table of Type A agents — simple factory pattern with no extra args.
 * Each entry maps a canonical agent name to its factory function.
 * The loop in createSwarmAgents uses this table to register all nine agents
 * without repeating the same if/prompt/factory/name/push block nine times.
 */
const TYPE_A_AGENTS = [
	{ name: 'explorer' as const, factory: createExplorerAgent },
	{ name: 'sme' as const, factory: createSMEAgent },
	{ name: 'researcher' as const, factory: createResearcherAgent },
	{ name: 'coder' as const, factory: createCoderAgent },
	{ name: 'reviewer' as const, factory: createReviewerAgent },
	{ name: 'test_engineer' as const, factory: createTestEngineerAgent },
	{ name: 'docs' as const, factory: createDocsAgent },
	{ name: 'skill_improver' as const, factory: createSkillImproverAgent },
	{ name: 'spec_writer' as const, factory: createSpecWriterAgent },
] as const;

const MEMORY_OUTCOME_GUIDANCE_BY_AGENT = {
	explorer: EXPLORER_MEMORY_OUTCOME_GUIDANCE,
	coder: CODER_MEMORY_OUTCOME_GUIDANCE,
	reviewer: REVIEWER_MEMORY_OUTCOME_GUIDANCE,
} as const;

function appendMemoryOutcomeGuidance(
	agent: AgentDefinition,
	guidance: string | undefined,
	memoryEnabled: boolean,
): void {
	if (!memoryEnabled || !guidance) return;
	agent.config.prompt = `${agent.config.prompt ?? ''}\n\n${guidance}`.trim();
}

/**
 * Create agents for a single swarm
 */
function createSwarmAgents(
	swarmId: string,
	swarmConfig: SwarmConfig,
	isDefault: boolean,
	pluginConfig?: PluginConfig,
	projectContext: ProjectContext = emptyProjectContext(),
): AgentDefinition[] {
	const agents: AgentDefinition[] = [];
	const swarmAgents = swarmConfig.agents;
	_swarmAgentsMap.set(swarmId, swarmAgents ?? {});

	// Prefix for non-default swarms (e.g., "local" for swarmId "local")
	// We pass swarmId as the prefix identifier, but only prepend to names if not default
	const prefix = isDefault ? '' : `${swarmId}_`;
	const swarmPrefix = isDefault ? undefined : swarmId;

	// Get qa_retry_limit from config (default: 3)
	const qaRetryLimit = pluginConfig?.qa_retry_limit ?? 3;

	// Get quiet mode from config (default: true — matches schema default)
	const quiet = pluginConfig?.quiet ?? true;

	// Helper to get model for agent (pass base name, not prefixed)
	const getModel = (baseName: string) =>
		getModelForAgent(baseName, swarmAgents, swarmPrefix, quiet);

	// Helper to load custom prompts
	const getPrompts = (name: string) => loadAgentPrompt(name);

	// Emit a gated-agent advisory (deduped across swarms within a single
	// createAgents call). Issue #1914 Defect 3. Mirrors the quiet-ternary
	// pattern used by the council moderator deprecation advisory (~L795).
	const emitGatedAgentAdvisory = (msg: string): void => {
		if (_emittedGatedAgentAdvisories.has(msg)) return;
		_emittedGatedAgentAdvisories.add(msg);
		if (quiet) {
			addDeferredWarning(msg);
		} else {
			advisoryWarn(msg);
		}
	};

	// Helper to create prefixed agent name
	const prefixName = (name: string) => `${prefix}${name}`;

	// 1. Create Architect
	if (!isAgentDisabled('architect', swarmAgents, swarmPrefix)) {
		const architectPrompts = getPrompts('architect');
		const architect = createArchitectAgent(
			getModel('architect'),
			architectPrompts.prompt,
			architectPrompts.appendPrompt,
			pluginConfig?.adversarial_testing,
			pluginConfig?.council,
			pluginConfig?.ui_review,
			pluginConfig?.memory?.enabled === true,
			pluginConfig?.architectural_supervision,
			pluginConfig?.design_docs?.enabled === true,
			pluginConfig?.external_skills?.curation_enabled === true,
			pluginConfig?.turbo !== undefined,
			pluginConfig?.skills?.enabled === true,
			resolvePlanningProfile({
				directory: '',
				config: {
					execution_mode: pluginConfig?.execution_mode ?? 'balanced',
				},
			}),
		);
		architect.name = prefixName('architect');

		// Replace placeholders in architect prompt
		const swarmName = swarmConfig.name || swarmId;
		const swarmIdentity = isDefault ? 'default' : swarmId;
		const agentPrefix = prefix; // Empty for default, "cloud_" for cloud, "local_" for local, etc.

		architect.config.prompt = architect.config.prompt
			?.replace(/\{\{SWARM_ID\}\}/g, swarmIdentity)
			.replace(/\{\{AGENT_PREFIX\}\}/g, agentPrefix)
			.replace(/\{\{QA_RETRY_LIMIT\}\}/g, String(qaRetryLimit))
			// Phase 4b: project-context placeholders. Defaults to UNRESOLVED
			// sentinel when no projectContext was passed (architect's existing
			// DISCOVER mode handles the sentinel). The session-init path in
			// src/index.ts:initializeOpenCodeSwarm resolves these via
			// withTimeout(2000ms)+pickBackend, fail-open per Invariant 1.
			.replace(/\{\{PROJECT_LANGUAGE\}\}/g, projectContext.PROJECT_LANGUAGE)
			.replace(/\{\{PROJECT_FRAMEWORK\}\}/g, projectContext.PROJECT_FRAMEWORK)
			.replace(/\{\{BUILD_CMD\}\}/g, projectContext.BUILD_CMD)
			.replace(/\{\{TEST_CMD\}\}/g, projectContext.TEST_CMD)
			.replace(/\{\{LINT_CMD\}\}/g, projectContext.LINT_CMD)
			.replace(/\{\{ENTRY_POINTS\}\}/g, projectContext.ENTRY_POINTS)
			// Constraint / checklist blocks. These resolve to bulleted lists
			// when a backend declares language-specific prompts and to empty
			// strings (NOT the sentinel) when none are configured, so prompts
			// without per-language overrides have no fake-bullet noise.
			.replace(/\{\{CODER_CONSTRAINTS\}\}/g, projectContext.CODER_CONSTRAINTS)
			.replace(/\{\{TEST_CONSTRAINTS\}\}/g, projectContext.TEST_CONSTRAINTS)
			.replace(/\{\{REVIEWER_CHECKLIST\}\}/g, projectContext.REVIEWER_CHECKLIST)
			.replace(
				/\{\{PROJECT_CONTEXT_SECONDARY_LANGUAGES\}\}/g,
				projectContext.PROJECT_CONTEXT_SECONDARY_LANGUAGES,
			);

		// Add swarm identity header for non-default swarms
		if (!isDefault) {
			architect.description = `[${swarmName}] ${architect.description}`;
			const swarmHeader = `## ⚠️ YOU ARE THE ${swarmName.toUpperCase()} SWARM ARCHITECT

Your swarm ID is "${swarmId}". ALL your agents have the "${swarmId}_" prefix:
- @${swarmId}_explorer (not @explorer)
- @${swarmId}_coder (not @coder)
- @${swarmId}_sme (not @sme)
- @${swarmId}_reviewer (not @reviewer)
- @${swarmId}_spec_writer (not @spec_writer)
- etc.

CRITICAL: Agents without the "${swarmId}_" prefix DO NOT EXIST or belong to a DIFFERENT swarm.
If you call @coder instead of @${swarmId}_coder, the call will FAIL or go to the wrong swarm.

`;
			architect.config.prompt = swarmHeader + architect.config.prompt;
		}

		agents.push(applyOverrides(architect, swarmAgents, swarmPrefix, quiet));
	}

	// 2. Register Type A agents via table-driven loop.
	// Covers: explorer, sme, researcher, coder, reviewer, test_engineer, docs,
	// skill_improver, spec_writer — all follow the same factory(model, cp, ca)
	// pattern. Agents with non-standard args (critic variants, curator variants,
	// council agents, docs_design, designer) remain as explicit blocks below.
	for (const { name, factory } of TYPE_A_AGENTS) {
		if (!isAgentDisabled(name, swarmAgents, swarmPrefix)) {
			const prompts = getPrompts(name);
			const agent =
				name === 'reviewer'
					? createReviewerAgent(
							getModel(name),
							prompts.prompt,
							prompts.appendPrompt,
							pluginConfig?.auto_review?.enabled === true &&
								pluginConfig.auto_review.structured_findings !== false,
						)
					: (
							factory as (
								model: string,
								customPrompt?: string,
								customAppendPrompt?: string,
							) => AgentDefinition
						)(getModel(name), prompts.prompt, prompts.appendPrompt);
			appendMemoryOutcomeGuidance(
				agent,
				MEMORY_OUTCOME_GUIDANCE_BY_AGENT[
					name as keyof typeof MEMORY_OUTCOME_GUIDANCE_BY_AGENT
				],
				pluginConfig?.memory?.enabled === true,
			);
			agent.name = prefixName(name);
			agents.push(applyOverrides(agent, swarmAgents, swarmPrefix, quiet));
		}
	}

	// 5a. Create Critic (Plan Review)
	if (!isAgentDisabled('critic', swarmAgents, swarmPrefix)) {
		const criticPrompts = getPrompts('critic');
		const critic = createCriticAgent(
			getModel('critic'),
			criticPrompts.prompt,
			criticPrompts.appendPrompt,
			'plan_critic' as CriticRole,
		);
		appendMemoryOutcomeGuidance(
			critic,
			CRITIC_MEMORY_OUTCOME_GUIDANCE,
			pluginConfig?.memory?.enabled === true,
		);
		critic.name = prefixName('critic');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5b. Create Critic Sounding Board
	if (!isAgentDisabled('critic_sounding_board', swarmAgents, swarmPrefix)) {
		const critic = createCriticAgent(
			swarmAgents?.critic_sounding_board?.model ?? getModel('critic'),
			undefined,
			undefined,
			'sounding_board' as CriticRole,
		);
		critic.name = prefixName('critic_sounding_board');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5c. Create Critic Drift Verifier
	if (!isAgentDisabled('critic_drift_verifier', swarmAgents, swarmPrefix)) {
		const critic = createCriticAgent(
			swarmAgents?.critic_drift_verifier?.model ?? getModel('critic'),
			undefined,
			undefined,
			'phase_drift_verifier' as CriticRole,
		);
		critic.name = prefixName('critic_drift_verifier');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5c-bis. Create Critic Hallucination Verifier
	if (
		!isAgentDisabled('critic_hallucination_verifier', swarmAgents, swarmPrefix)
	) {
		const critic = createCriticAgent(
			swarmAgents?.critic_hallucination_verifier?.model ?? getModel('critic'),
			undefined,
			undefined,
			'hallucination_verifier' as CriticRole,
		);
		critic.name = prefixName('critic_hallucination_verifier');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5c-ter. Create Critic Architecture Supervisor (issue #893)
	if (
		!isAgentDisabled('critic_architecture_supervisor', swarmAgents, swarmPrefix)
	) {
		const critic = createCriticAgent(
			swarmAgents?.critic_architecture_supervisor?.model ?? getModel('critic'),
			undefined,
			undefined,
			'architecture_supervisor' as CriticRole,
		);
		critic.name = prefixName('critic_architecture_supervisor');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5c-quater. Create independent structured-finding validator
	if (!isAgentDisabled('critic_finding_validator', swarmAgents, swarmPrefix)) {
		const critic = createCriticAgent(
			swarmAgents?.critic_finding_validator?.model ?? getModel('critic'),
			undefined,
			undefined,
			'finding_validator' as CriticRole,
		);
		critic.name = prefixName('critic_finding_validator');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5d. Create Critic Autonomous Oversight
	if (!isAgentDisabled('critic_oversight', swarmAgents, swarmPrefix)) {
		const critic = createCriticAutonomousOversightAgent(
			swarmAgents?.critic_oversight?.model ?? getModel('critic'),
		);
		critic.name = prefixName('critic_oversight');
		agents.push(applyOverrides(critic, swarmAgents, swarmPrefix, quiet));
	}

	// 5e. Create Curator Init agent
	if (!isAgentDisabled('curator_init', swarmAgents, swarmPrefix)) {
		const curatorInitPrompts = getPrompts('curator_init');
		const curatorInit = createCuratorAgent(
			swarmAgents?.curator_init?.model ?? getModel('explorer'),
			curatorInitPrompts.prompt,
			curatorInitPrompts.appendPrompt,
			'curator_init' as CuratorRole,
		);
		curatorInit.name = prefixName('curator_init');
		agents.push(applyOverrides(curatorInit, swarmAgents, swarmPrefix, quiet));
	}

	// 5e. Create Curator Phase agent
	if (!isAgentDisabled('curator_phase', swarmAgents, swarmPrefix)) {
		const curatorPhasePrompts = getPrompts('curator_phase');
		const curatorPhase = createCuratorAgent(
			swarmAgents?.curator_phase?.model ?? getModel('explorer'),
			curatorPhasePrompts.prompt,
			curatorPhasePrompts.appendPrompt,
			'curator_phase' as CuratorRole,
		);
		curatorPhase.name = prefixName('curator_phase');
		agents.push(applyOverrides(curatorPhase, swarmAgents, swarmPrefix, quiet));
	}

	// 5e. Create Curator Post-mortem agent
	if (!isAgentDisabled('curator_postmortem', swarmAgents, swarmPrefix)) {
		const curatorPostmortemPrompts = getPrompts('curator_postmortem');
		const curatorPostmortem = createCuratorAgent(
			swarmAgents?.curator_postmortem?.model ?? getModel('explorer'),
			curatorPostmortemPrompts.prompt,
			curatorPostmortemPrompts.appendPrompt,
			'curator_postmortem' as CuratorRole,
		);
		curatorPostmortem.name = prefixName('curator_postmortem');
		agents.push(
			applyOverrides(curatorPostmortem, swarmAgents, swarmPrefix, quiet),
		);
	}

	// 5e. Create Curator Consolidation agent (issue #1464, Phase 3).
	if (!isAgentDisabled('curator_consolidation', swarmAgents, swarmPrefix)) {
		const curatorConsolidationPrompts = getPrompts('curator_consolidation');
		const curatorConsolidation = createCuratorAgent(
			swarmAgents?.curator_consolidation?.model ?? getModel('explorer'),
			curatorConsolidationPrompts.prompt,
			curatorConsolidationPrompts.appendPrompt,
			'curator_consolidation' as CuratorRole,
		);
		curatorConsolidation.name = prefixName('curator_consolidation');
		agents.push(
			applyOverrides(curatorConsolidation, swarmAgents, swarmPrefix, quiet),
		);
	}

	// 5f. General Council agents (opt-in — council.general.enabled === true).
	// Three agents registered with council-specific prompts sourcing models from
	// reviewer/critic/sme swarm config entries — fixing the model resolution bug
	// where council_member always fell back to DEFAULT_MODELS.council_member.
	// Persona mapping: generalist → reviewer model, skeptic → critic model,
	// domain_expert → SME model. Web search is owned by the architect (a single
	// pre-search pass), and synthesis is the architect's responsibility — the
	// dedicated council_moderator agent has been removed.

	// Advisory: agents.council_* configured (and not disabled) but
	// council.general.enabled is off → silent no-op. Issue #1914 Defect 3 sweep.
	// Condition uses per-agent "configured AND not disabled" disjunction so a
	// single council agent configured with {disabled: true} (others absent)
	// does NOT trip the advisory.
	const anyCouncilAgentConfiguredActive =
		(swarmAgents?.council_generalist !== undefined &&
			!isAgentDisabled('council_generalist', swarmAgents, swarmPrefix)) ||
		(swarmAgents?.council_skeptic !== undefined &&
			!isAgentDisabled('council_skeptic', swarmAgents, swarmPrefix)) ||
		(swarmAgents?.council_domain_expert !== undefined &&
			!isAgentDisabled('council_domain_expert', swarmAgents, swarmPrefix));
	if (
		pluginConfig?.council?.general?.enabled !== true &&
		anyCouncilAgentConfiguredActive
	) {
		emitGatedAgentAdvisory(
			'[opencode-swarm] agents.council_{generalist,skeptic,domain_expert} are configured but ' +
				'council.general.enabled is not true — the council agents will NOT be registered. ' +
				'Set "council": { "general": { "enabled": true } } in opencode-swarm.json to enable them, ' +
				'or remove the agents.council_* blocks to silence this warning.',
		);
	}

	if (pluginConfig?.council?.general?.enabled === true) {
		// Council agents intentionally omit the third `appendPrompt` argument that
		// createReviewerAgent / createCriticAgent / createSMEAgent accept.
		// Council prompts are fixed and self-contained: they must not inherit
		// per-agent customizations (e.g. agents.reviewer.appendPrompt) because
		// those customizations are scoped to the reviewer's normal workflow role,
		// not to its council persona. This omission is intentional — see
		// docs/configuration.md § "council.general — appendPrompt note".
		let councilAgentsCreated = 0;

		// Generalist council agent (broad analytical voice) — uses reviewer model.
		if (!isAgentDisabled('reviewer', swarmAgents, swarmPrefix)) {
			const councilGeneralist = createReviewerAgent(
				getModel('reviewer'),
				GENERALIST_COUNCIL_PROMPT,
			);
			councilGeneralist.name = prefixName('council_generalist');
			agents.push(
				applyOverrides(councilGeneralist, swarmAgents, swarmPrefix, quiet),
			);
			councilAgentsCreated++;
		}

		// Skeptic council agent (adversarial stress-tester) — uses critic model.
		if (!isAgentDisabled('critic', swarmAgents, swarmPrefix)) {
			const councilSkeptic = createCriticAgent(
				getModel('critic'),
				SKEPTIC_COUNCIL_PROMPT,
			);
			councilSkeptic.name = prefixName('council_skeptic');
			agents.push(
				applyOverrides(councilSkeptic, swarmAgents, swarmPrefix, quiet),
			);
			councilAgentsCreated++;
		}

		// Domain expert council agent (technical depth voice) — uses SME model.
		if (!isAgentDisabled('sme', swarmAgents, swarmPrefix)) {
			const councilDomainExpert = createSMEAgent(
				getModel('sme'),
				DOMAIN_EXPERT_COUNCIL_PROMPT,
			);
			councilDomainExpert.name = prefixName('council_domain_expert');
			agents.push(
				applyOverrides(councilDomainExpert, swarmAgents, swarmPrefix, quiet),
			);
			councilAgentsCreated++;
		}

		// Warn when council.general.enabled === true but fewer than 3 agents were
		// registered because reviewer / critic / sme base agents are disabled.
		// A user who enables the General Council expects all three council roles to
		// participate; a silently reduced council can produce misleading results.
		// The threshold 3 and the three isAgentDisabled checks below are intentionally
		// hardcoded: the General Council is a fixed three-role construct by design.
		// If a new council role is ever added, update all four values together.
		if (councilAgentsCreated < 3) {
			const missing: string[] = [];
			if (isAgentDisabled('reviewer', swarmAgents, swarmPrefix))
				missing.push('council_generalist (requires reviewer)');
			if (isAgentDisabled('critic', swarmAgents, swarmPrefix))
				missing.push('council_skeptic (requires critic)');
			if (isAgentDisabled('sme', swarmAgents, swarmPrefix))
				missing.push('council_domain_expert (requires sme)');
			addDeferredWarning(
				`[opencode-swarm] council.general.enabled is true but only ${councilAgentsCreated}/3 council agents could be registered because the following base agents are disabled: ${missing.join(', ')}. Re-enable those agents or accept a reduced council.`,
			);
		}

		// Deprecation: the dedicated council_moderator agent and the
		// council.general.moderator / council.general.moderatorModel config
		// fields are no longer honored. The architect now synthesizes the final
		// answer directly using inline output rules. Surface a one-time warning
		// when the user's config still requests the old moderator pass so the
		// drift is visible instead of silent.
		//
		// We only check `moderatorModel` (no schema default, so its presence
		// implies explicit user intent). The `moderator` field has a schema
		// default of `true`, so checking it post-parse cannot distinguish
		// "user explicitly opted in" from "user accepted the default" — which
		// would fire the warning for every council user, defeating its purpose.
		if (pluginConfig?.council?.general?.moderatorModel !== undefined) {
			addDeferredWarning(
				'[opencode-swarm] council.general.moderatorModel is deprecated and ignored. The architect now synthesizes the final answer directly using inline output rules. Remove this field (and council.general.moderator if set) from opencode-swarm.json to silence this warning.',
			);
		}
	}

	// Advisory: agents.docs_design configured (and not disabled) but
	// design_docs.enabled is off → silent no-op. Issue #1914 Defect 3.
	if (
		swarmAgents?.docs_design !== undefined &&
		!isAgentDisabled('docs_design', swarmAgents, swarmPrefix) &&
		pluginConfig?.design_docs?.enabled !== true
	) {
		emitGatedAgentAdvisory(
			'[opencode-swarm] agents.docs_design is configured but design_docs.enabled is not true — ' +
				'the docs_design agent will NOT be registered. Set "design_docs": { "enabled": true } ' +
				'in opencode-swarm.json to enable it, or remove the agents.docs_design block to silence this warning.',
		);
	}

	// 8b. Create Docs (Design-Doc Author) variant — opt-in, only when
	// design_docs.enabled === true (issue #1080). Shares the docs agent base via
	// the 'design_docs' role, mirroring how critic role variants are registered.
	// Runs only via /swarm design-docs or the PHASE-WRAP design-doc sync sub-step;
	// it is NOT swept into the standard docs auto-dispatch.
	if (
		pluginConfig?.design_docs?.enabled === true &&
		!isAgentDisabled('docs_design', swarmAgents, swarmPrefix)
	) {
		const docsDesignPrompts = getPrompts('docs_design');
		const docsDesign = createDocsAgent(
			getModel('docs_design'),
			docsDesignPrompts.prompt,
			docsDesignPrompts.appendPrompt,
			'design_docs',
		);
		docsDesign.name = prefixName('docs_design');
		agents.push(applyOverrides(docsDesign, swarmAgents, swarmPrefix, quiet));
	}

	// Advisory: agents.designer configured (and not disabled) but
	// ui_review.enabled is off → silent no-op. Issue #1914 Defect 3.
	if (
		swarmAgents?.designer !== undefined &&
		!isAgentDisabled('designer', swarmAgents, swarmPrefix) &&
		pluginConfig?.ui_review?.enabled !== true
	) {
		emitGatedAgentAdvisory(
			'[opencode-swarm] agents.designer is configured but ui_review.enabled is not true — ' +
				'the designer agent will NOT be registered. Set "ui_review": { "enabled": true } ' +
				'in opencode-swarm.json to enable it, or remove the agents.designer block to silence this warning.',
		);
	}

	// 9. Create Designer agent (opt-in — only when ui_review.enabled === true)
	if (
		pluginConfig?.ui_review?.enabled === true &&
		!isAgentDisabled('designer', swarmAgents, swarmPrefix)
	) {
		const designerPrompts = getPrompts('designer');
		const designer = createDesignerAgent(
			getModel('designer'),
			designerPrompts.prompt,
			designerPrompts.appendPrompt,
		);
		designer.name = prefixName('designer');
		agents.push(applyOverrides(designer, swarmAgents, swarmPrefix, quiet));
	}

	// Dead-safety-net fix (M12): the three uncoordinated `.replace()` chains
	// that assemble agent prompts — Chain A in src/agents/architect.ts and
	// Chain B above (architect: {{SWARM_ID}}, {{AGENT_PREFIX}}, project-context,
	// etc.) — never validated for leftover placeholders. Assert over EACH
	// agent's FINAL prompt, after every substitution chain has run, so a
	// renamed/mistyped/newly-added `{{KEY}}` fails init loudly instead of
	// leaking raw template text to the model. Runs here (before return) rather
	// than inside createArchitectAgent so it sees Chain B's output — Chain B
	// resolves tokens that Chain A injected (e.g. {{AGENT_PREFIX}} inside the
	// adversarial-test step).
	//
	// FAIL-OPEN (invariant 1): a user-authored custom agent prompt
	// (`<config>/opencode-swarm/<agent>.md`) is passed through verbatim by
	// resolvePrompt with no substitution, so it can legitimately contain a
	// literal `{{UPPER_KEY}}` in prose. Letting the assertion throw here would
	// propagate out of getAgentConfigs → initializeOpenCodeSwarm, whose outer
	// catch is fail-CLOSED (re-throws) — the whole plugin would be dropped and
	// the user would see "no agents". Instead, downgrade a leftover-placeholder
	// to a deferred warning and register the agent anyway. The assertion stays
	// a hard throw (unit tests depend on it), and built-in-prompt regressions
	// are still caught in CI by a test that drains the warning buffer after
	// getAgentConfigs() over the default prompts.
	for (const agent of agents) {
		if (typeof agent.config.prompt === 'string') {
			agent.config.prompt += NONTRANSIENT_STOP_PROTOCOL;
			try {
				assertNoUnresolvedPlaceholders(agent.config.prompt, agent.name);
			} catch (err) {
				addDeferredWarning(
					`[opencode-swarm] ${
						err instanceof Error ? err.message : String(err)
					} (agent "${agent.name}" was registered anyway; plugin init not aborted).`,
				);
			}
		}
	}

	return agents;
}

/**
 * Create all agent definitions with configuration applied
 */
export function createAgents(
	config?: PluginConfig,
	projectContext: ProjectContext = emptyProjectContext(),
): AgentDefinition[] {
	const allAgents: AgentDefinition[] = [];

	// Clear the gated-agent advisory dedupe set at entry. Tests call createAgents
	// repeatedly and need isolation; plugin init calls it twice (see note above).
	_emittedGatedAgentAdvisories.clear();
	// Config may be reloaded in-process. Do not retain swarm entries which are
	// absent from the new configuration (and make test resets deterministic).
	_swarmAgentsMap.clear();

	// Check if we have swarms configured
	const swarms = config?.swarms;

	if (swarms && Object.keys(swarms).length > 0) {
		// Multiple swarms mode
		// Only a swarm explicitly named "default" gets unprefixed agents
		// All other swarms get prefixed (cloud_*, local_*, etc.)
		_swarmAgentsMap.set('default', {});
		for (const swarmId of Object.keys(swarms)) {
			let swarmConfig = swarms[swarmId];
			const isDefault = swarmId === 'default';

			// Merge in top-level agents config for all swarms.
			// This ensures that top-level agents are respected even when swarms are configured.
			// Precedence is object-level (not field-level): if both top-level and the swarm
			// define the same agent (e.g. "coder"), the swarm's entire agent entry wins and
			// top-level fields for that agent are not inherited individually.
			if (config?.agents) {
				swarmConfig = {
					...swarmConfig,
					agents: {
						...config.agents,
						...(swarmConfig.agents ?? {}),
					},
				};
			}

			const swarmAgents = createSwarmAgents(
				swarmId,
				swarmConfig,
				isDefault,
				config,
				projectContext,
			);
			allAgents.push(...swarmAgents);
		}
	} else {
		// Legacy single swarm mode - use top-level agents config
		const legacySwarmConfig: SwarmConfig = {
			name: 'Default',
			agents: config?.agents,
		};
		const swarmAgents = createSwarmAgents(
			'default',
			legacySwarmConfig,
			true,
			config,
			projectContext,
		);
		allAgents.push(...swarmAgents);
	}

	return allAgents;
}

/**
 * Resolve the set of generated agent names that should be marked as primary
 * for OpenCode's session-default-agent resolution.
 *
 * Resolution rules (see schema.ts default_agent comment for full semantics):
 *   - default_agent omitted ⇒ every architect-role agent is primary
 *     (canonical base role === "architect"). This restores v7.0.0 behavior in
 *     multi-swarm configs where there is no unprefixed `architect` agent.
 *   - default_agent exactly matches a generated agent name ⇒ only that agent.
 *     Exact match wins over base-role match — `local_architect` resolves to
 *     just `local_architect`, never the entire architect role.
 *   - default_agent is a base role in ALL_AGENT_NAMES ⇒ every generated agent
 *     whose canonical base role matches that role.
 *   - default_agent is invalid (matches nothing) ⇒ fall back to architect-role
 *     primaries; if no architect roles exist (architects disabled), fall back
 *     to the first generated agent. Always warns. Never returns empty when
 *     `agentNames` is non-empty.
 *
 * Important matching detail: a value like "not_an_architect" is NOT treated
 * as a base-role request even though stripKnownSwarmPrefix() returns
 * "architect" for it. Base-role matching only fires when the user-supplied
 * value is itself one of ALL_AGENT_NAMES.
 */
export function resolvePrimaryAgentNames(
	agentNames: string[],
	defaultAgent?: string,
): {
	primaryNames: Set<string>;
	reason:
		| 'implicit-architects'
		| 'exact'
		| 'base-role'
		| 'fallback-architects'
		| 'fallback-first';
	warning?: string;
} {
	const collectArchitectRole = (): string[] =>
		agentNames.filter((n) => stripKnownSwarmPrefix(n) === 'architect');

	const trimmed =
		typeof defaultAgent === 'string' ? defaultAgent.trim() : undefined;
	const value = trimmed === '' ? undefined : trimmed;

	if (agentNames.length === 0) {
		return { primaryNames: new Set(), reason: 'implicit-architects' };
	}

	// Implicit: omitted default_agent ⇒ all architect-role agents.
	if (value === undefined) {
		const architects = collectArchitectRole();
		if (architects.length > 0) {
			return {
				primaryNames: new Set(architects),
				reason: 'implicit-architects',
			};
		}
		// No architects at all (e.g. all disabled). Fall back to the first
		// generated agent so OpenCode always has at least one primary. Warn.
		const first = agentNames[0];
		return {
			primaryNames: new Set([first]),
			reason: 'fallback-first',
			warning: `[swarm] No architect-role agents are registered and default_agent is unset; falling back to '${first}' as primary. Re-enable an architect agent or set default_agent to silence this warning.`,
		};
	}

	// Base-role match (preferred when the value is itself a canonical base
	// role like "architect" / "coder"): mark every generated agent whose
	// canonical base role matches. We deliberately do NOT call
	// stripKnownSwarmPrefix on the user value — "not_an_architect" must not
	// collapse to "architect". Putting base-role BEFORE exact-match here is
	// load-bearing for the "default swarm + extra swarms + default_agent:
	// 'architect'" case: the user expects all architect-role agents primary
	// (including unprefixed `architect` AND every `*_architect`), not just the
	// agent literally named "architect".
	if ((ALL_AGENT_NAMES as readonly string[]).includes(value)) {
		const matching = agentNames.filter(
			(n) => stripKnownSwarmPrefix(n) === value,
		);
		if (matching.length > 0) {
			return { primaryNames: new Set(matching), reason: 'base-role' };
		}
		// Known role but no generated agent for it (entire role disabled).
		// Fall through to fallback so the user still gets a usable primary.
	}

	// Exact generated-name match: only fires when the value is NOT a base role
	// in ALL_AGENT_NAMES (handled above), so this path serves prefixed names
	// like "local_architect" / "paid_coder". `agentNames.includes(value)` is
	// the literal-string match — no stripping — which is what the spec means
	// by "exact generated-name matching".
	if (agentNames.includes(value)) {
		return { primaryNames: new Set([value]), reason: 'exact' };
	}

	// Invalid / unmatched: fall back to architect-role agents, or to the first
	// generated agent if no architect role exists. Always warn.
	const architects = collectArchitectRole();
	if (architects.length > 0) {
		return {
			primaryNames: new Set(architects),
			reason: 'fallback-architects',
			warning: `[swarm] default_agent '${value}' did not match any registered agent; falling back to architect-role primaries: ${architects.join(', ')}.`,
		};
	}
	const first = agentNames[0];
	return {
		primaryNames: new Set([first]),
		reason: 'fallback-first',
		warning: `[swarm] default_agent '${value}' did not match any registered agent and no architect-role agents are registered; falling back to '${first}' as primary.`,
	};
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 */
export function getAgentConfigs(
	config?: PluginConfig,
	directory?: string,
	sessionId?: string,
	projectContext?: ProjectContext,
): Record<string, SDKAgentConfig> {
	const agents = _internals.createAgents(
		config,
		projectContext ?? emptyProjectContext(),
	);

	// Check if tool filtering is disabled globally
	const toolFilterEnabled = config?.tool_filter?.enabled ?? true;
	const toolFilterOverrides = config?.tool_filter?.overrides ?? {};
	const quiet = config?.quiet ?? true;

	// Track warning for missing whitelist entries (warn once per unique base name)
	const warnedMissingWhitelist = new Set<string>();

	// Accumulate per-agent tool snapshot for evidence writing
	const agentToolSnapshot: Record<string, string[]> = {};

	// Resolve which agents are primary once, before mapping over agents.
	const resolution = resolvePrimaryAgentNames(
		agents.map((a) => a.name),
		config?.default_agent,
	);
	if (resolution.warning) {
		advisoryWarn(resolution.warning);
	}
	// Diagnostic invariant: a non-empty generated agent set must produce at least
	// one primary. resolvePrimaryAgentNames already guarantees this; this is a
	// defense-in-depth check that surfaces a deferred warning if the invariant
	// is ever violated by future changes. It must never block plugin startup.
	if (agents.length > 0 && resolution.primaryNames.size === 0) {
		const generated = agents.map((a) => a.name).join(', ');
		const diagnostic = `[swarm] DIAGNOSTIC: ${agents.length} generated agents but zero primaries. Likely cause: a regression in resolvePrimaryAgentNames. Generated: ${generated}.`;
		if (!quiet) {
			log(diagnostic);
		} else {
			addDeferredWarning(diagnostic);
		}
	}

	// Council enablement is config-global, so validate the architect override once
	// per invocation rather than once per generated architect in multi-swarm mode.
	// Repeating the same advisory can exhaust the bounded warning buffer and hide
	// later, distinct operator guidance.
	const architectOverride = toolFilterOverrides.architect;
	if (
		toolFilterEnabled &&
		config?.council?.enabled !== true &&
		architectOverride !== undefined
	) {
		const councilTools = [
			'declare_council_criteria',
			'submit_council_verdicts',
			'submit_phase_council_verdicts',
			'write_final_council_evidence',
		];
		const present = councilTools.filter((tool) =>
			architectOverride.includes(tool),
		);
		if (present.length > 0) {
			advisoryWarn(
				`[opencode-swarm] tool_filter.overrides.architect includes ${present.join(', ')} but council.enabled is not true. ` +
					`The runtime gate will reject these calls. Either set council.enabled=true, or remove ${present.join(', ')} from the architect override.`,
			);
		}
	}

	// Narrows `agent.config.permission` to the SDK's declared permission
	// shape, defensively rejecting absent values and non-object primitives
	// (a malformed agent definition must not throw here). Mirrors the
	// `isObjectRecord` convention used for config-hook guards in
	// src/index.ts.
	const isPermissionRecord = (
		value: SDKAgentConfig['permission'],
	): value is NonNullable<SDKAgentConfig['permission']> =>
		typeof value === 'object' && value !== null;

	const result = Object.fromEntries(
		agents.map((agent) => {
			const sdkConfig: SDKAgentConfig = {
				...agent.config,
				description: agent.description,
			};

			const isPrimaryAgent = resolution.primaryNames.has(agent.name);

			if (isPrimaryAgent) {
				sdkConfig.mode = 'primary';
				// Allow task delegation for primary agents. Merge — never
				// replace — the agent definition's own permission block.
				// OpenCode merges agent-level permission additively on its
				// side (rule evaluation uses `findLast` over concatenated
				// permission entries), so wholesale replacement here was
				// never necessary and previously discarded any edit/bash/
				// webfetch/external_directory entries (including nested
				// per-pattern objects, e.g. `external_directory: { "C:/foo/*":
				// "allow" }`) the agent definition declared. `task: 'allow'`
				// always wins when the definition also declares its own
				// `task` entry — primary agents must always be able to
				// delegate, which is the existing intent this branch
				// preserves.
				const existingPermission = isPermissionRecord(agent.config.permission)
					? agent.config.permission
					: undefined;
				// POSITION IS PRECEDENCE. The host evaluates with `findLast` over
				// `Object.entries` order and wildcard-matches the permission NAME,
				// so `'*'` also matches `task`. A duplicate key in an object
				// literal keeps its FIRST position and only takes the last value:
				// `{ ...{ task: 'deny', '*': 'deny' }, task: 'allow' }` yields
				// `{ task: 'allow', '*': 'deny' }` with `task` still at index 0, so
				// `findLast` picks `'*': 'deny'` and the primary agent silently
				// loses delegation — the opposite of the intent documented above.
				// Delete-then-set moves `task` to the end so it genuinely wins.
				const mergedPermission: NonNullable<SDKAgentConfig['permission']> & {
					task: 'allow';
				} = { ...existingPermission } as NonNullable<
					SDKAgentConfig['permission']
				> & { task: 'allow' };
				delete (mergedPermission as Record<string, unknown>).task;
				mergedPermission.task = 'allow';
				sdkConfig.permission = mergedPermission;
			} else {
				sdkConfig.mode = 'subagent';
			}

			// Remove model for primary agents (model selection handled by orchestrator)
			if (sdkConfig.mode === 'primary') {
				delete sdkConfig.model;
			}

			// Extract base agent name using canonical prefix stripper (supports underscore, hyphen, space)
			const baseAgentName = stripKnownSwarmPrefix(agent.name);

			// If tool filtering is globally disabled, use original tools unchanged
			if (!toolFilterEnabled) {
				sdkConfig.tools = agent.config.tools ?? {};
				agentToolSnapshot[agent.name] = Object.keys(
					sdkConfig.tools ?? {},
				).filter((k) => sdkConfig.tools![k] !== false);
				return [agent.name, sdkConfig];
			}

			// Determine allowed tools: check override first, then fall back to AGENT_TOOL_MAP.
			// Memory tools are opt-in: default configs must not advertise or enable
			// them until memory.enabled is explicitly true. Apply the opt-in map after
			// overrides so prompt capability text and the SDK allow-list stay in sync.
			let allowedTools: string[] | undefined;
			const override = toolFilterOverrides[baseAgentName];
			if (override !== undefined) {
				// Override exists - use it (even if empty array)
				allowedTools = override;
			} else {
				// No override - use default AGENT_TOOL_MAP
				allowedTools =
					AGENT_TOOL_MAP[baseAgentName as keyof typeof AGENT_TOOL_MAP];
			}
			if (config?.memory?.enabled === true) {
				const memoryTools =
					MEMORY_AGENT_TOOL_MAP[
						baseAgentName as keyof typeof MEMORY_AGENT_TOOL_MAP
					] ?? [];
				if (memoryTools.length > 0) {
					allowedTools = Array.from(
						new Set([...(allowedTools ?? []), ...memoryTools]),
					);
				}
			}

			// Feature-gate: external skill curation tools are only available
			// when external_skills.curation_enabled is true in the resolved config.
			if (config?.external_skills?.curation_enabled === true) {
				const externalSkillTools =
					EXTERNAL_SKILL_AGENT_TOOL_MAP[
						baseAgentName as keyof typeof EXTERNAL_SKILL_AGENT_TOOL_MAP
					] ?? [];
				if (externalSkillTools.length > 0) {
					allowedTools = Array.from(
						new Set([...(allowedTools ?? []), ...externalSkillTools]),
					);
				}
			}

			// Feature-gate: council-mode tools (declare_council_criteria, submit_*_verdicts, write_final_council_evidence)
			if (config?.council?.enabled === true) {
				const councilTools =
					COUNCIL_AGENT_TOOL_MAP[
						baseAgentName as keyof typeof COUNCIL_AGENT_TOOL_MAP
					] ?? [];
				if (councilTools.length > 0) {
					allowedTools = Array.from(
						new Set([...(allowedTools ?? []), ...councilTools]),
					);
				}
			}

			// Feature-gate: general council research tools (convene_general_council, web_search, web_fetch)
			if (config?.council?.general?.enabled === true) {
				const generalCouncilTools =
					GENERAL_COUNCIL_AGENT_TOOL_MAP[
						baseAgentName as keyof typeof GENERAL_COUNCIL_AGENT_TOOL_MAP
					] ?? [];
				if (generalCouncilTools.length > 0) {
					allowedTools = Array.from(
						new Set([...(allowedTools ?? []), ...generalCouncilTools]),
					);
				}
			}

			// Feature-gate: lean turbo tools
			if (config?.turbo !== undefined) {
				const turboTools =
					TURBO_AGENT_TOOL_MAP[
						baseAgentName as keyof typeof TURBO_AGENT_TOOL_MAP
					] ?? [];
				if (turboTools.length > 0) {
					allowedTools = Array.from(
						new Set([...(allowedTools ?? []), ...turboTools]),
					);
				}
			}

			// Feature-gate: skill-management tools (FR-004) — gated by skills.enabled
			// (separate from skill_improver.enabled which controls the agent/quota).
			//
			// AUTHORITATIVE GATE: The skills.enabled check takes precedence over
			// tool_filter.overrides. Skill tools MUST NOT appear when skills.enabled
			// is not true, even if tool_filter.overrides.architect explicitly lists
			// them (e.g. overrides: { architect: ['skill_generate', ...] }).
			// We strip first (to close override bypass), then add only when enabled.
			{
				const skillTools =
					SKILL_AGENT_TOOL_MAP[
						baseAgentName as keyof typeof SKILL_AGENT_TOOL_MAP
					] ?? [];
				if (skillTools.length > 0 && allowedTools) {
					if (config?.skills?.enabled === true) {
						allowedTools = Array.from(
							new Set([...allowedTools, ...skillTools]),
						);
					} else {
						// Strip any skill tools that arrived via override or base map.
						// This is the enforcement point for the FR-004 gate.
						const skillToolsSet = new Set<string>(skillTools);
						allowedTools = allowedTools.filter((t) => !skillToolsSet.has(t));
					}
				}
			}

			// Warn once when base name lacks a whitelist entry (no override and no AGENT_TOOL_MAP)
			if (!allowedTools && !Object.hasOwn(toolFilterOverrides, baseAgentName)) {
				if (!warnedMissingWhitelist.has(baseAgentName) && !quiet) {
					log(
						`[getAgentConfigs] Unknown agent '${baseAgentName}', defaulting to minimal toolset.`,
					);
					warnedMissingWhitelist.add(baseAgentName);
				}
			}

			// Copy original tools to preserve flags (including write/edit)
			const originalTools = agent.config.tools
				? { ...agent.config.tools }
				: undefined;

			if (allowedTools) {
				// Preserve explicit false flags from original tools
				const baseTools = originalTools ?? {};
				const disabledTools = Object.fromEntries(
					Object.entries(baseTools).filter(([, value]) => value === false),
				);
				const filteredTools: Record<string, boolean> = { ...disabledTools };

				// Add allowed tools (skip if explicitly disabled)
				for (const tool of allowedTools) {
					if (filteredTools[tool] === false) continue;
					filteredTools[tool] = true;
				}
				sdkConfig.tools = filteredTools;
			} else {
				// No whitelist entry: default to minimal safe toolset
				sdkConfig.tools = {
					write: false,
					edit: false,
				};
			}

			agentToolSnapshot[agent.name] = Object.keys(sdkConfig.tools ?? {}).filter(
				(k) => sdkConfig.tools![k] !== false,
			);

			return [agent.name, sdkConfig];
		}),
	);

	// Write agent tool snapshot non-blocking
	if (directory) {
		const sid = sessionId ?? `init-${Date.now()}`;
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		const filename = `agent-tools-${sid}.json`;
		const snapshotPath = path.join(evidenceDir, filename);
		const snapshotData = JSON.stringify(
			{
				sessionId: sid,
				generatedAt: new Date().toISOString(),
				agents: agentToolSnapshot,
			},
			null,
			2,
		);
		void mkdir(evidenceDir, { recursive: true })
			.then(() => writeFile(snapshotPath, snapshotData))
			.then(() => {
				invalidateCachedArtifact(snapshotPath);
			})
			.catch(() => {});
	}

	return result;
}

// Re-export agent types
export { createArchitectAgent } from './architect';
export { createCoderAgent } from './coder';
export {
	DOMAIN_EXPERT_COUNCIL_PROMPT,
	GENERALIST_COUNCIL_PROMPT,
	SKEPTIC_COUNCIL_PROMPT,
} from './council-prompts';
export { createCriticAgent } from './critic';
export { createCuratorAgent } from './curator-agent';
export { createDesignerAgent } from './designer';
export { createDocsAgent } from './docs';
export { createExplorerAgent } from './explorer';
export { createResearcherAgent } from './researcher';
export {
	createReviewerAgent,
	SECURITY_CATEGORIES,
	type SecurityCategory,
} from './reviewer';
export { createSMEAgent } from './sme';
export { createTestEngineerAgent } from './test-engineer';
