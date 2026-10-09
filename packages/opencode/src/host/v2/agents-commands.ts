/**
 * v2 agent + command registration (issue #3151, 8.x port of the 7.x #3004 /
 * #2910 adapter).
 *
 * Single-source design: the v1 `config` hook IS the shared builder. This
 * module invokes `hooks.config` against a synthetic `opencodeConfig` object
 * and registers the resulting `.agent` / `.command` tables onto the v2 agent
 * and command domains — the entire v1 command table is reused with zero
 * extraction from src/index.ts.
 *
 * Mappings:
 *   - v1 AgentConfig → v2 Agent.Info: `prompt`→`system`, `mode` preserved
 *     (multi-swarm `*_architect` primary semantics — AGENTS.md invariant 11),
 *     `model` string 'provider/model' → Model.Ref, `tools` allowlist →
 *     per-tool allow permission rules (best-effort).
 *   - Entries the v1 hook marks `disable: true` are REMOVED on the v2 agent
 *     editor.
 *   - v1 command entries `{template, description}` → v2 CommandDefinition
 *     whose `execute` submits the expanded template through
 *     `ctx.session.prompt` (TUI-side $ARGUMENTS expansion is replaced by
 *     direct substitution).
 */

import { log } from '@opencode-swarm/core';
import { withTimeout } from './timeout';
import type {
	V1HooksSubset,
	V2AgentEditor,
	V2AgentInfo,
	V2CommandDefinition,
	V2PluginContext,
	V2Registration,
} from './types';

const V2_REGISTRATION_TIMEOUT_MS = 60_000;

interface V1AgentConfigLike {
	mode?: unknown;
	prompt?: unknown;
	description?: unknown;
	model?: unknown;
	tools?: unknown;
	disable?: unknown;
}

/** Map one v1 AgentConfig entry to a v2 Agent.Info. */
export function mapV1AgentToV2(
	name: string,
	config: V1AgentConfigLike,
): V2AgentInfo {
	const info: V2AgentInfo = {
		id: name,
		name,
		mode:
			config.mode === 'primary' ||
			config.mode === 'subagent' ||
			config.mode === 'all'
				? config.mode
				: 'subagent',
		hidden: false,
		request: { settings: {}, headers: {}, body: {} },
	};
	if (typeof config.prompt === 'string' && config.prompt.length > 0) {
		info.system = config.prompt;
	}
	if (typeof config.description === 'string' && config.description.length > 0) {
		info.description = config.description;
	}
	if (typeof config.model === 'string' && config.model.includes('/')) {
		const separator = config.model.indexOf('/');
		info.model = {
			providerID: config.model.slice(0, separator),
			id: config.model.slice(separator + 1),
		};
	}
	// The v1 `tools` field carries either an allowlist (string[]) or an
	// override/permission map (Record<string, boolean>); true/absent stays
	// enabled, false disables. Map enabled entries to per-tool allow rules.
	const rules: NonNullable<V2AgentInfo['permissions']> = [];
	if (Array.isArray(config.tools)) {
		for (const tool of config.tools) {
			if (typeof tool === 'string' && tool.length > 0) {
				rules.push({ action: 'tool', resource: tool, effect: 'allow' });
			}
		}
	} else if (config.tools && typeof config.tools === 'object') {
		for (const [tool, enabled] of Object.entries(
			config.tools as Record<string, unknown>,
		)) {
			if (enabled === false) continue;
			if (tool.length > 0)
				rules.push({ action: 'tool', resource: tool, effect: 'allow' });
		}
	}
	if (rules.length > 0) info.permissions = rules;
	return info;
}

/** Expand a v1 TUI template for a v2 command execution. */
export function expandV1Template(
	template: string,
	argumentsText: string,
): string {
	return template.replaceAll('$ARGUMENTS', argumentsText).trim();
}

/** Register agents + commands via the synthetic config-hook run. */
export async function registerV2AgentsAndCommands(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	if (typeof hooks.config !== 'function') return;

	// The v1 config hook mutates this object in place — the shared builder.
	const syntheticConfig: Record<string, unknown> = {};
	await withTimeout(
		Promise.resolve(hooks.config(syntheticConfig)),
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: synthetic config-hook run exceeded budget'),
	);

	const agentTable = (syntheticConfig.agent ?? {}) as Record<
		string,
		V1AgentConfigLike
	>;
	const commandTable = (syntheticConfig.command ?? {}) as Record<
		string,
		{ template?: unknown; description?: unknown }
	>;

	const agentRegistration = await withTimeout(
		ctx.agent.transform((editor: V2AgentEditor) => {
			for (const [name, config] of Object.entries(agentTable)) {
				if (!config || typeof config !== 'object') continue;
				if (config.disable === true) {
					// v1 auto-select disables competing built-ins by flag; v2 removes.
					editor.remove(name);
					continue;
				}
				const mapped = mapV1AgentToV2(name, config);
				// update(id, fn) is the v2 AgentEditor's create-or-update primitive.
				editor.update(name, (agent: V2AgentInfo) => {
					Object.assign(agent, mapped);
				});
			}
		}),
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: agent transform exceeded budget'),
	);
	registrations.push(agentRegistration);

	const commandRegistration = await withTimeout(
		ctx.command.transform(
			(editor: { add(definition: V2CommandDefinition): void }) => {
				for (const [key, entry] of Object.entries(commandTable)) {
					if (!entry || typeof entry !== 'object') continue;
					const template =
						typeof entry.template === 'string' ? entry.template : undefined;
					if (template === undefined) continue;
					const definition: V2CommandDefinition = {
						name: key,
						description:
							typeof entry.description === 'string'
								? entry.description
								: undefined,
						execute: async (invocation) => {
							const text = expandV1Template(
								template,
								invocation?.prompt?.text ?? '',
							);
							const prompt = ctx.session?.prompt;
							if (typeof prompt !== 'function') {
								log('v2 command executed without a session prompt surface', {
									name: key,
								});
								return;
							}
							await withTimeout(
								Promise.resolve(prompt(invocation.sessionID, { text })),
								V2_REGISTRATION_TIMEOUT_MS,
								new Error(
									`[opencode-swarm] v2: command ${key} prompt exceeded budget`,
								),
							);
						},
					};
					editor.add(definition);
				}
			},
		),
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: command transform exceeded budget'),
	);
	registrations.push(commandRegistration);

	log('v2 agents + commands registered', {
		directory,
		agents: Object.keys(agentTable).length,
		commands: Object.keys(commandTable).length,
	});
}
