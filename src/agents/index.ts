import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk';
import {
	loadAgentPrompt,
	type PluginConfig,
	type SwarmConfig,
} from '../config';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	DEFAULT_MODELS,
} from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import { addDeferredWarning } from '../services/warning-buffer.js';
import { type AgentDefinition, createArchitectAgent } from './architect';
import { createCoderAgent } from './coder';
import {
	DOMAIN_EXPERT_COUNCIL_PROMPT,
	GENERALIST_COUNCIL_PROMPT,
	SKEPTIC_COUNCIL_PROMPT,
} from './council-prompts';
import {
	type CriticRole,
	createCriticAgent,
	createCriticAutonomousOversightAgent,
} from './critic';
import { type CuratorRole, createCuratorAgent } from './curator-agent';
import { createDesignerAgent } from './designer';
import { createDocsAgent } from './docs';
import { createExplorerAgent } from './explorer';
import { createReviewerAgent } from './reviewer';
import { createSkillImproverAgent } from './skill-improver';
import { createSMEAgent } from './sme';
import { createSpecWriterAgent } from './spec-writer';
import { emptyProjectContext, type ProjectContext } from './template';
import { createTestEngineerAgent } from './test-engineer';

export type { AgentDefinition } from './architect';

// Track agents for which we've already warned about missing config
const warnedAgents = new Set<string>();

// Module-level reference to swarm agents config for runtime fallback resolution by guardrails
let _swarmAgents:
	| Record<
			string,
			{ model?: string; fallback_models?: string[]; disabled?: boolean }
	  >
	| undefined;

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
	// modifies _swarmAgents[name].model directly when session.model_fallback_index > 0.
	// The config's fallback_models array is read by guardrails to select the fallback.

	// 2. Default from constants — warn once per agent if not in config
	const resolvedModel = DEFAULT_MODELS[baseAgentName] ?? DEFAULT_MODELS.default;
	if (!warnedAgents.has(baseAgentName)) {
		warnedAgents.add(baseAgentName);
		if (!quiet) {
			console.warn(
				"[swarm] Agent '%s' not found in config — using default model '%s'. Add it to opencode-swarm.json to customize.",
				baseAgentName,
				resolvedModel,
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
	// Only inherit if the curator agent does NOT have fallback_models key at all
	if (
		fallbackModels === undefined &&
		(agentBaseName === 'curator_init' || agentBaseName === 'curator_phase')
	) {
		fallbackModels = swarmAgents?.explorer?.fallback_models;
	}

	if (!fallbackModels || fallbackModels.length === 0) return null;
	if (fallbackIndex < 1 || fallbackIndex > fallbackModels.length) return null;
	return fallbackModels[fallbackIndex - 1];
}

/**
 * Get the swarm agents config (for runtime fallback resolution by guardrails).
 */
export function getSwarmAgents():
	| Record<
			string,
			{ model?: string; fallback_models?: string[]; disabled?: boolean }
	  >
	| undefined {
	return _swarmAgents;
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
 * Known reasoning-effort variant identifiers that OpenCode supports as a
 * third path segment in `provider/model/variant` notation.
 *
 * ONLY these short tokens are treated as embedded variants during auto-split.
 * Any other third segment (e.g. "qwen3.6-35b-a3b" in
 * "lmstudio/qwen/qwen3.6-35b-a3b") is part of the model path and must NOT
 * be stripped.
 */
const KNOWN_VARIANT_VALUES = new Set([
	'low',
	'medium',
	'high',
	'max',
	'xhigh',
	'thinking',
]);

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
	swarmAgents?: Record<string, { temperature?: number; variant?: string }>,
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
	const modelSegments = agent.config.model?.split('/') ?? [];
	const lastSegment = modelSegments[modelSegments.length - 1] ?? '';
	const hasEmbeddedVariant =
		modelSegments.length >= 3 && KNOWN_VARIANT_VALUES.has(lastSegment);
	if (hasEmbeddedVariant) {
		const autoVariant = lastSegment;
		const cleanedModel = modelSegments.slice(0, -1).join('/');
		const effectiveVariant = variantOverride ?? autoVariant;
		if (!quiet) {
			console.warn(
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
	return agent;
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
	_swarmAgents = swarmAgents;

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

	// 2. Create Explorer
	if (!isAgentDisabled('explorer', swarmAgents, swarmPrefix)) {
		const explorerPrompts = getPrompts('explorer');
		const explorer = createExplorerAgent(
			getModel('explorer'),
			explorerPrompts.prompt,
			explorerPrompts.appendPrompt,
		);
		explorer.name = prefixName('explorer');
		agents.push(applyOverrides(explorer, swarmAgents, swarmPrefix, quiet));
	}

	// 3. Create SME agent
	if (!isAgentDisabled('sme', swarmAgents, swarmPrefix)) {
		const smePrompts = getPrompts('sme');
		const sme = createSMEAgent(
			getModel('sme'),
			smePrompts.prompt,
			smePrompts.appendPrompt,
		);
		sme.name = prefixName('sme');
		agents.push(applyOverrides(sme, swarmAgents, swarmPrefix, quiet));
	}

	// 4. Create pipeline agents
	if (!isAgentDisabled('coder', swarmAgents, swarmPrefix)) {
		const coderPrompts = getPrompts('coder');
		const coder = createCoderAgent(
			getModel('coder'),
			coderPrompts.prompt,
			coderPrompts.appendPrompt,
		);
		coder.name = prefixName('coder');
		agents.push(applyOverrides(coder, swarmAgents, swarmPrefix, quiet));
	}

	if (!isAgentDisabled('reviewer', swarmAgents, swarmPrefix)) {
		const reviewerPrompts = getPrompts('reviewer');
		const reviewer = createReviewerAgent(
			getModel('reviewer'),
			reviewerPrompts.prompt,
			reviewerPrompts.appendPrompt,
		);
		reviewer.name = prefixName('reviewer');
		agents.push(applyOverrides(reviewer, swarmAgents, swarmPrefix, quiet));
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

	// 5f. v2: skill_improver — issue #629. Registered when enabled in config.
	// Always present in agent map (so SDK can dispatch by name) — runtime gating
	// happens in the skill_improve tool which checks skill_improver.enabled.
	if (!isAgentDisabled('skill_improver', swarmAgents, swarmPrefix)) {
		const sip = getPrompts('skill_improver');
		const skillImprover = createSkillImproverAgent(
			swarmAgents?.skill_improver?.model ?? getModel('skill_improver'),
			sip.prompt,
			sip.appendPrompt,
		);
		skillImprover.name = prefixName('skill_improver');
		agents.push(applyOverrides(skillImprover, swarmAgents, swarmPrefix, quiet));
	}

	// 5g. v2: spec_writer — independent model for .swarm/spec.md authorship.
	if (!isAgentDisabled('spec_writer', swarmAgents, swarmPrefix)) {
		const sw = getPrompts('spec_writer');
		const specWriter = createSpecWriterAgent(
			swarmAgents?.spec_writer?.model ?? getModel('spec_writer'),
			sw.prompt,
			sw.appendPrompt,
		);
		specWriter.name = prefixName('spec_writer');
		agents.push(applyOverrides(specWriter, swarmAgents, swarmPrefix, quiet));
	}

	if (!isAgentDisabled('test_engineer', swarmAgents, swarmPrefix)) {
		const testPrompts = getPrompts('test_engineer');
		const testEngineer = createTestEngineerAgent(
			getModel('test_engineer'),
			testPrompts.prompt,
			testPrompts.appendPrompt,
		);
		testEngineer.name = prefixName('test_engineer');
		agents.push(applyOverrides(testEngineer, swarmAgents, swarmPrefix, quiet));
	}

	// 5f. General Council agents (opt-in — council.general.enabled === true).
	// Three agents registered with council-specific prompts sourcing models from
	// reviewer/critic/sme swarm config entries — fixing the model resolution bug
	// where council_member always fell back to DEFAULT_MODELS.council_member.
	// Persona mapping: generalist → reviewer model, skeptic → critic model,
	// domain_expert → SME model. Web search is owned by the architect (a single
	// pre-search pass), and synthesis is the architect's responsibility — the
	// dedicated council_moderator agent has been removed.
	if (pluginConfig?.council?.general?.enabled === true) {
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

	// 8. Create Docs agent (enabled by default — must be explicitly disabled)
	if (!isAgentDisabled('docs', swarmAgents, swarmPrefix)) {
		const docsPrompts = getPrompts('docs');
		const docs = createDocsAgent(
			getModel('docs'),
			docsPrompts.prompt,
			docsPrompts.appendPrompt,
		);
		docs.name = prefixName('docs');
		agents.push(applyOverrides(docs, swarmAgents, swarmPrefix, quiet));
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

	// Check if we have swarms configured
	const swarms = config?.swarms;

	if (swarms && Object.keys(swarms).length > 0) {
		// Multiple swarms mode
		// Only a swarm explicitly named "default" gets unprefixed agents
		// All other swarms get prefixed (cloud_*, local_*, etc.)
		for (const swarmId of Object.keys(swarms)) {
			const swarmConfig = swarms[swarmId];
			const isDefault = swarmId === 'default';
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
	const agents = createAgents(config, projectContext ?? emptyProjectContext());

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
		if (!quiet) {
			console.warn(resolution.warning);
		} else {
			addDeferredWarning(resolution.warning);
		}
	}
	// Diagnostic invariant: a non-empty generated agent set must produce at least
	// one primary. resolvePrimaryAgentNames already guarantees this; this is a
	// defense-in-depth check that surfaces a deferred warning if the invariant
	// is ever violated by future changes. It must never block plugin startup.
	if (agents.length > 0 && resolution.primaryNames.size === 0) {
		const generated = agents.map((a) => a.name).join(', ');
		const diagnostic = `[swarm] DIAGNOSTIC: ${agents.length} generated agents but zero primaries. Likely cause: a regression in resolvePrimaryAgentNames. Generated: ${generated}.`;
		if (!quiet) {
			console.warn(diagnostic);
		} else {
			addDeferredWarning(diagnostic);
		}
	}

	const result = Object.fromEntries(
		agents.map((agent) => {
			const sdkConfig: SDKAgentConfig = {
				...agent.config,
				description: agent.description,
			};

			const isPrimaryAgent = resolution.primaryNames.has(agent.name);

			if (isPrimaryAgent) {
				sdkConfig.mode = 'primary';
				// Allow task delegation for primary agents
				(sdkConfig.permission as Record<string, 'allow'>) = { task: 'allow' };
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

			// Determine allowed tools: check override first, then fall back to AGENT_TOOL_MAP
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

			// Feature-gate: when council is enabled, the architect's system prompt
			// instructs the model to call `declare_council_criteria` and
			// `submit_council_verdicts`. A user-supplied tool_filter.overrides.architect
			// that omits these tools would silently break the council workflow
			// (same class as the original 6.66.0 bug: tools present in
			// AGENT_TOOL_MAP but not usable). We refuse to silently override
			// explicit user intent and refuse to silently lose the feature —
			// throw a clear conflict error and make the user resolve it.
			if (
				baseAgentName === 'architect' &&
				config?.council?.enabled === true &&
				override !== undefined
			) {
				const required = [
					'declare_council_criteria',
					'submit_council_verdicts',
				];
				const missing = required.filter((t) => !override.includes(t));
				if (missing.length > 0) {
					throw new Error(
						`[opencode-swarm] Conflicting config: council.enabled=true but tool_filter.overrides.architect omits ${missing.join(', ')}. ` +
							`Either set council.enabled=false, remove the architect override entirely to fall back on AGENT_TOOL_MAP, or add the missing council tools to the override. ` +
							`Refusing to silently override your explicit tool_filter.overrides.architect.`,
					);
				}
			}

			// Symmetric validation: when council is OFF but the user override
			// INCLUDES the council tools, the runtime gate in
			// src/tools/convene-council.ts will reject any model attempt to call
			// them. Warn so the user knows the tools are present in the override
			// but unusable at runtime.
			if (
				baseAgentName === 'architect' &&
				config?.council?.enabled !== true &&
				override !== undefined
			) {
				const councilTools = [
					'declare_council_criteria',
					'submit_council_verdicts',
				];
				const present = councilTools.filter((t) => override.includes(t));
				if (present.length > 0 && !quiet) {
					console.warn(
						`[opencode-swarm] tool_filter.overrides.architect includes ${present.join(', ')} but council.enabled is not true. ` +
							`The runtime gate will reject these calls. Either set council.enabled=true, or remove ${present.join(', ')} from the architect override.`,
					);
				}
			}

			// Warn once when base name lacks a whitelist entry (no override and no AGENT_TOOL_MAP)
			if (!allowedTools && !Object.hasOwn(toolFilterOverrides, baseAgentName)) {
				if (!warnedMissingWhitelist.has(baseAgentName) && !quiet) {
					console.warn(
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
			.then(() => writeFile(path.join(evidenceDir, filename), snapshotData))
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
export {
	createReviewerAgent,
	SECURITY_CATEGORIES,
	type SecurityCategory,
} from './reviewer';
export { createSMEAgent } from './sme';
export { createTestEngineerAgent } from './test-engineer';
