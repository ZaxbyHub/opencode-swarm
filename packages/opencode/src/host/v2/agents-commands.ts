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
 *     whose `execute` FIRST runs the v1 `command.execute.before` chain
 *     (deterministic /swarm subcommands — the handler acts only on
 *     `command === 'swarm'`, exactly as on v1; alias keys like swarm-status
 *     keep their v1 LLM routing). Non-empty `output.parts` are delivered
 *     through `ctx.session.synthetic` with `resume: false` — the v2 carrier
 *     for deterministic output, since V2CommandDefinition.execute returns
 *     `Promise<void>` and cannot return parts. Empty parts (or a missing
 *     synthetic surface) fall back to submitting the expanded template
 *     through `ctx.session.prompt` (TUI-side $ARGUMENTS expansion is
 *     replaced by direct substitution).
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

/** Bound for one v2 command execution leg (deterministic handler or delivery). */
const V2_COMMAND_EXECUTE_TIMEOUT_MS = 60_000;

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
	// Replacer FUNCTION: a plain-string replacement would interpret $& / $` /
	// $' / $$ sequences inside user arguments as match patterns (UR-09).
	return template.replaceAll('$ARGUMENTS', () => argumentsText).trim();
}

/** Join a deterministic command handler's text parts; undefined when none. */
function collectDeterministicText(
	parts: ReadonlyArray<unknown>,
): string | undefined {
	const texts: string[] = [];
	for (const part of parts) {
		if (
			part &&
			typeof part === 'object' &&
			(part as { type?: unknown }).type === 'text' &&
			typeof (part as { text?: unknown }).text === 'string'
		) {
			texts.push((part as { text: string }).text);
		}
	}
	if (texts.length === 0) return undefined;
	return texts.join('\n');
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

	const agentTransform: Promise<V2Registration> = ctx.agent.transform(
		(editor: V2AgentEditor) => {
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
		},
	);
	// Track the moment each registration resolves (M-7): a late resolve after
	// a timeout win must still reach the cleanup list. Rejection pushes nothing.
	agentTransform
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		agentTransform,
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: agent transform exceeded budget'),
	);

	const commandTransform: Promise<V2Registration> = ctx.command.transform(
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
						const argumentsText = invocation?.prompt?.text ?? '';
						const text = expandV1Template(template, argumentsText);
						// FB-006: deterministic path FIRST. The v1 factory exposes
						// hooks['command.execute.before'] = safeHook(commandHandler)
						// (src/index.ts), and the handler's contract (src/commands/
						// index.ts) is (input:{command, sessionID, arguments},
						// output:{parts}) — it acts only on command === 'swarm' and
						// reads the EXPANDED $ARGUMENTS from input.arguments, which
						// v2 supplies as invocation.prompt.text (the same expansion
						// input the template substitution above uses).
						const commandBefore = hooks['command.execute.before'];
						if (typeof commandBefore === 'function') {
							const v1Input = {
								command: key,
								sessionID: invocation.sessionID,
								arguments: argumentsText,
							};
							const v1Output: { parts: unknown[] } = { parts: [] };
							try {
								await withTimeout(
									Promise.resolve(commandBefore(v1Input, v1Output)),
									V2_COMMAND_EXECUTE_TIMEOUT_MS,
									new Error(
										`[opencode-swarm] v2: command ${key} deterministic handler exceeded budget`,
									),
								);
							} catch (err) {
								const message =
									err instanceof Error ? err.message : String(err);
								// Ungated (FB-014/M-16): deterministic-handler loss must
								// be visible without OPENCODE_SWARM_DEBUG. One line.
								console.warn(
									`[opencode-swarm] v2 command ${key} deterministic handler failed (non-fatal):`,
									message,
								);
								log(
									'v2 deterministic command handler failed (non-fatal); falling back to prompt',
									{ name: key, error: message },
								);
							}
							const deterministicText = collectDeterministicText(
								v1Output.parts,
							);
							if (deterministicText !== undefined) {
								// V2CommandDefinition.execute returns Promise<void> (no
								// parts-return surface — vendored type + @opencode/plugin
								// 2.0.20 dist/promise/command.d.ts), so the v1
								// output.parts analog is delivered through
								// session.synthetic with resume:false — text admitted
								// to the session WITHOUT waking the model.
								const synthetic = ctx.session?.synthetic;
								if (typeof synthetic === 'function') {
									await withTimeout(
										Promise.resolve(
											synthetic({
												sessionID: invocation.sessionID,
												text: deterministicText,
												resume: false,
											}),
										),
										V2_COMMAND_EXECUTE_TIMEOUT_MS,
										new Error(
											`[opencode-swarm] v2: command ${key} deterministic delivery exceeded budget`,
										),
									);
									return;
								}
								log(
									'v2 deterministic command output has no synthetic surface; falling back to prompt',
									{ name: key },
								);
							}
						}
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
	);
	commandTransform
		.then((reg) => {
			registrations.push(reg);
		})
		.catch(() => {
			// withTimeout surfaces the rejection below; nothing to track.
		});
	await withTimeout(
		commandTransform,
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: command transform exceeded budget'),
	);

	log('v2 agents + commands registered', {
		directory,
		agents: Object.keys(agentTable).length,
		commands: Object.keys(commandTable).length,
	});
}
