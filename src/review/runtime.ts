import { DEFAULT_AGENT_CONFIGS } from '../config/constants.js';
import { type PluginConfig, stripKnownSwarmPrefix } from '../config/schema.js';
import {
	type ModelOverride,
	parseModelString,
} from '../utils/model-dispatch-fallback.js';

export interface ReviewAgentModelConfig {
	readonly primaryModel?: string;
	readonly fallbackModels: readonly string[];
}

/**
 * Immutable, plugin-instance-local model configuration keyed by generated
 * agent name. Runtime review paths must consume this snapshot instead of the
 * process-global agent map, which can be overwritten by another plugin
 * instance in the same host process.
 */
export type ReviewAgentModelRegistry = Readonly<
	Record<string, ReviewAgentModelConfig>
>;

export interface ReviewAgentNames {
	reviewer: string;
	validator: string;
}

function rolePrefix(agentName: string, role: string): string | undefined {
	if (agentName === role) return '';
	for (const separator of ['_', '-', ' ']) {
		const suffix = `${separator}${role}`;
		if (agentName.endsWith(suffix) && agentName.length > suffix.length) {
			return agentName.slice(0, -role.length);
		}
	}
	return undefined;
}

function roleCandidates(
	generatedAgentNames: readonly string[],
	role: string,
): string[] {
	return generatedAgentNames.filter(
		(name) => stripKnownSwarmPrefix(name) === role,
	);
}

/**
 * Resolve a generated role from the active agent's exact swarm prefix.
 *
 * When no active identity is available, only unambiguous registries are
 * accepted: a single candidate or an explicit default-swarm (bare) role.
 * Multiple named swarms without either signal fail closed instead of routing
 * work to an unrelated longest/alphabetical prefix.
 */
export function resolveAgentForActiveSwarm(
	generatedAgentNames: Iterable<string>,
	role: string,
	activeAgentName?: string,
): string {
	const names = [...generatedAgentNames];
	const candidates = roleCandidates(names, role);
	if (candidates.length === 0) return role;

	if (activeAgentName) {
		const activeRole = stripKnownSwarmPrefix(activeAgentName);
		if (activeAgentName !== activeRole && !names.includes(activeAgentName)) {
			throw new Error(
				`Cannot resolve ${role}: active agent "${activeAgentName}" is not present in this plugin's generated-agent registry.`,
			);
		}
		const prefix = rolePrefix(activeAgentName, activeRole);
		if (prefix === undefined) {
			throw new Error(
				`Cannot resolve ${role}: active agent "${activeAgentName}" has no generated swarm prefix.`,
			);
		}
		const preferred = `${prefix}${role}`;
		if (candidates.includes(preferred)) return preferred;
		throw new Error(
			`Cannot resolve ${role}: active agent "${activeAgentName}" belongs to a swarm without registered "${preferred}".`,
		);
	}

	if (candidates.length === 1) return candidates[0];
	if (candidates.includes(role)) return role;
	throw new Error(
		`Cannot resolve ${role}: multiple named swarms are registered and no active agent identity was supplied.`,
	);
}

export function resolveReviewAgentNames(
	generatedAgentNames: Iterable<string>,
	activeAgentName?: string,
): ReviewAgentNames {
	const names = [...generatedAgentNames];
	const reviewer = resolveAgentForActiveSwarm(
		names,
		'reviewer',
		activeAgentName,
	);
	const prefix = rolePrefix(reviewer, 'reviewer') ?? '';
	const preferredValidator = `${prefix}critic_finding_validator`;
	const validator =
		names.find((name) => name === preferredValidator) ?? preferredValidator;
	return { reviewer, validator };
}

function effectiveAgentConfig(
	config: PluginConfig | undefined,
	agentName: string,
): { model?: string; fallback_models?: string[] } | undefined {
	const role = stripKnownSwarmPrefix(agentName);
	const defaultConfig = DEFAULT_AGENT_CONFIGS[role];
	if (!config) return defaultConfig;
	const prefix = rolePrefix(agentName, role);
	const hasNamedSwarms =
		config.swarms !== undefined && Object.keys(config.swarms).length > 0;
	if (!hasNamedSwarms) return config.agents?.[role] ?? defaultConfig;

	const swarmID =
		prefix === '' ? 'default' : prefix ? prefix.slice(0, -1) : undefined;
	const swarmOverride = swarmID
		? config.swarms?.[swarmID]?.agents?.[role]
		: undefined;
	// createAgents uses object-level precedence: the swarm's entire entry wins.
	return swarmOverride ?? config.agents?.[role] ?? defaultConfig;
}

export function captureReviewAgentModelRegistry(
	config: PluginConfig | undefined,
	generatedAgentNames: Iterable<string>,
): ReviewAgentModelRegistry {
	const snapshot: Record<string, ReviewAgentModelConfig> = Object.create(null);
	for (const agentName of generatedAgentNames) {
		const agentConfig = effectiveAgentConfig(config, agentName);
		snapshot[agentName] = Object.freeze({
			primaryModel: agentConfig?.model,
			fallbackModels: Object.freeze([...(agentConfig?.fallback_models ?? [])]),
		});
	}
	return Object.freeze(snapshot);
}

export function reviewFallbackModelStrings(
	agentName: string,
	registry: ReviewAgentModelRegistry | undefined,
): readonly string[] {
	return registry?.[agentName]?.fallbackModels ?? [];
}

export function reviewPrimaryModel(
	agentName: string,
	registry: ReviewAgentModelRegistry | undefined,
): string | undefined {
	return registry?.[agentName]?.primaryModel;
}

export function resolveReviewFallbackModels(
	agentName: string,
	registry: ReviewAgentModelRegistry | undefined,
): ModelOverride[] {
	const result: ModelOverride[] = [];
	for (const configured of reviewFallbackModelStrings(agentName, registry)) {
		try {
			const parsed = parseModelString(configured);
			if (parsed) result.push(parsed);
		} catch {
			// Match dispatchWithModelFallback: one malformed configured entry
			// must not suppress later valid fallbacks or the primary dispatch.
		}
	}
	return result;
}

export function optionalModelOverride(
	model: string | null | undefined,
): ModelOverride | undefined {
	return model ? parseModelString(model) : undefined;
}
