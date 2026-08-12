import { ALL_AGENT_NAMES } from './agent-names';
import { DEFAULT_MODELS } from './constants';
import type { PluginConfig } from './schema';

type AgentModelOverride = { model?: string };

interface ResolvedAgentTarget {
	baseAgentName: string;
	override?: AgentModelOverride;
}

export interface ParsedAgentModel {
	modelID: string;
	providerID?: string;
}

type RegisteredAgentModel = {
	model?: unknown;
	mode?: unknown;
};

const CANONICAL_AGENT_NAMES = new Set<string>(ALL_AGENT_NAMES);

const KNOWN_EMBEDDED_VARIANTS = new Set([
	'low',
	'medium',
	'high',
	'max',
	'xhigh',
	'thinking',
]);

/** Split a supported legacy `provider/model/variant` value like registration does. */
export function splitEmbeddedAgentVariant(model: string): {
	model: string;
	variant?: string;
} {
	const segments = model.split('/');
	const lastSegment = segments[segments.length - 1] ?? '';
	if (segments.length < 3 || !KNOWN_EMBEDDED_VARIANTS.has(lastSegment)) {
		return { model };
	}
	return {
		model: segments.slice(0, -1).join('/'),
		variant: lastSegment,
	};
}

function safeGet(
	entries: Record<string, AgentModelOverride> | undefined,
	key: string,
): AgentModelOverride | undefined {
	if (!entries || !Object.hasOwn(entries, key)) return undefined;
	return entries[key];
}

function canonicalAgentName(agentName: string): string | undefined {
	const normalized = agentName.trim().toLowerCase();
	if (CANONICAL_AGENT_NAMES.has(normalized)) return normalized;

	for (const candidate of ALL_AGENT_NAMES) {
		if (normalized.endsWith(`_${candidate}`)) return candidate;
	}
	return undefined;
}

/** Resolve an exact generated agent name to the config entry used by createAgents. */
function resolveAgentTarget(
	config: PluginConfig,
	exactAgentName: string,
): ResolvedAgentTarget | undefined {
	const normalizedTarget = exactAgentName.trim().toLowerCase();
	if (!normalizedTarget) return undefined;

	const baseAgentName = canonicalAgentName(normalizedTarget);
	if (!baseAgentName) return undefined;

	const swarms = config.swarms;
	const swarmIDs = swarms ? Object.keys(swarms) : [];
	if (swarmIDs.length === 0) {
		if (normalizedTarget !== baseAgentName) return undefined;
		return {
			baseAgentName,
			override: safeGet(config.agents, baseAgentName),
		};
	}

	for (const swarmID of swarmIDs) {
		const generatedName =
			swarmID === 'default' ? baseAgentName : `${swarmID}_${baseAgentName}`;
		if (generatedName.toLowerCase() !== normalizedTarget) continue;

		const swarmOverride = safeGet(swarms?.[swarmID]?.agents, baseAgentName);
		return {
			baseAgentName,
			override: swarmOverride ?? safeGet(config.agents, baseAgentName),
		};
	}

	return undefined;
}

/**
 * Return only an explicit, nonblank model for an exact generated agent target.
 * Unknown swarm prefixes and agent names fail closed instead of borrowing a
 * similarly named role from another swarm.
 */
export function resolveConfiguredAgentModel(
	config: PluginConfig,
	exactAgentName: string,
): string | undefined {
	const target = resolveAgentTarget(config, exactAgentName);
	const configuredModel = target?.override?.model;
	if (typeof configuredModel !== 'string') return undefined;

	const trimmed = configuredModel.trim();
	return trimmed ? splitEmbeddedAgentVariant(trimmed).model : undefined;
}

/** Resolve the registered model for an exact generated agent target. */
export function resolveRegisteredAgentModel(
	config: PluginConfig,
	exactAgentName: string,
): string | undefined {
	const target = resolveAgentTarget(config, exactAgentName);
	if (!target) return undefined;

	return (
		resolveConfiguredAgentModel(config, exactAgentName) ??
		DEFAULT_MODELS[target.baseAgentName] ??
		DEFAULT_MODELS.default
	);
}

/**
 * Resolve the model that an exact generated agent will actually receive.
 *
 * Primary agents intentionally omit their registered model so OpenCode's UI
 * controls selection; their live assistant metadata remains authoritative.
 * Subagents use a runtime-mutated explicit model (including guardrail fallback)
 * before the factory-resolved registered model, which also preserves inherited
 * role defaults such as curator -> explorer.
 */
export function resolveRuntimeAgentModel(
	config: PluginConfig,
	registeredAgents: Record<string, RegisteredAgentModel>,
	exactAgentName: string,
): string | undefined {
	const normalizedTarget = exactAgentName.trim().toLowerCase();
	if (!normalizedTarget) return undefined;

	const registeredName = Object.keys(registeredAgents).find(
		(name) => name.toLowerCase() === normalizedTarget,
	);
	if (!registeredName) return undefined;

	const registeredAgent = registeredAgents[registeredName];
	if (registeredAgent?.mode === 'primary') return undefined;

	const configuredModel = resolveConfiguredAgentModel(config, registeredName);
	if (configuredModel) return configuredModel;

	if (typeof registeredAgent?.model !== 'string') return undefined;
	const registeredModel = registeredAgent.model.trim();
	return registeredModel || undefined;
}

/** Parse model-only or provider/model config values without partial fallback. */
export function parseAgentModel(model: string): ParsedAgentModel | undefined {
	const trimmed = model.trim();
	if (!trimmed) return undefined;

	const separatorIndex = trimmed.indexOf('/');
	if (separatorIndex === -1) return { modelID: trimmed };

	const providerID = trimmed.slice(0, separatorIndex).trim();
	const modelID = trimmed.slice(separatorIndex + 1).trim();
	if (
		!providerID ||
		!modelID ||
		modelID.startsWith('/') ||
		modelID.endsWith('/')
	)
		return undefined;

	return { modelID, providerID };
}
