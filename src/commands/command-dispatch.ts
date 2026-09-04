import type { AgentDefinition } from '../agents/index.js';
import type { AutoReviewConfig, PluginConfig } from '../config/schema.js';
import type { EvaluationModelDispatcher } from '../evaluation/model-dispatcher.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import { stripControlCharacters } from '../utils/sanitize-display.js';
import {
	_internals,
	COMMAND_REGISTRY,
	type CommandEntry,
	isCommandFailure,
	resolveCommand,
} from './registry.js';

export type ResolvedSwarmCommand = NonNullable<
	ReturnType<typeof resolveCommand>
>;

export type SwarmCommandPolicyResult =
	| { allowed: true }
	| { allowed: false; message: string };

export type SwarmCommandPolicy = (
	resolved: ResolvedSwarmCommand,
) => SwarmCommandPolicyResult;

export type SwarmCommandExecutionResult = {
	text: string;
	resolved?: ResolvedSwarmCommand;
	canonicalKey?: string;
};

export function normalizeSwarmCommandInput(
	command: string,
	argumentText: string,
): { isSwarmCommand: boolean; tokens: string[] } {
	if (command !== 'swarm' && !command.startsWith('swarm-')) {
		return { isSwarmCommand: false, tokens: [] };
	}

	if (command === 'swarm') {
		return {
			isSwarmCommand: true,
			tokens: argumentText.trim().split(/\s+/).filter(Boolean),
		};
	}

	const subcommand = command.slice('swarm-'.length);
	const extraArgs = argumentText.trim().split(/\s+/).filter(Boolean);
	return {
		isSwarmCommand: true,
		tokens: [subcommand, ...extraArgs].filter(Boolean),
	};
}

export function canonicalCommandKey(resolved: ResolvedSwarmCommand): string {
	// Handler-BEARING aliases keep their aliasOf through resolveRegistryEntry
	// (it only dereferences handler-less entries, and validateAliases permits
	// handler + aliasOf), so their canonical key is the direct aliasOf read.
	if (resolved.entry.aliasOf) {
		return resolved.entry.aliasOf;
	}
	// #2493 pure aliases: resolveCommand returns the dereferenced canonical
	// entry (which carries no aliasOf), so recover the canonical key by
	// walking the ORIGINAL key's alias chain — the same walk
	// resolveRegistryEntry performs to find the handler-bearing entry.
	let entry = COMMAND_REGISTRY[resolved.key as keyof typeof COMMAND_REGISTRY] as
		| CommandEntry
		| undefined;
	while (entry && !entry.handler && entry.aliasOf) {
		const target = COMMAND_REGISTRY[
			entry.aliasOf as keyof typeof COMMAND_REGISTRY
		] as CommandEntry | undefined;
		if (!target) break;
		if (target.handler) return entry.aliasOf;
		entry = target;
	}
	return resolved.key;
}

export function formatCommandNotFound(tokens: string[]): string {
	// Coerce: adversarial callers can pass non-string tokens (numbers, null,
	// booleans) through argv-shaped inputs; everything downstream is string-typed.
	const attemptedCommand = String(tokens[0]);
	// Strip control characters (#2493 review F-11): the token is interpolated
	// into a single-line chat/CLI message, and raw control bytes would corrupt
	// terminal rendering.
	const sanitized = stripControlCharacters(attemptedCommand);
	const MAX_DISPLAY = 100;
	const displayCommand =
		sanitized.length > MAX_DISPLAY
			? `${sanitized.slice(0, MAX_DISPLAY)}...`
			: sanitized;
	// Match against the bounded form so oversized inputs never reach the
	// per-command levenshtein loop (findSimilarCommands' own 500-char guard
	// fires only AFTER that O(N×Q) work).
	const similar = _internals.findSimilarCommands(displayCommand);
	const header = `Command \`/swarm ${displayCommand}\` not found.`;
	const suggestions =
		similar.length > 0
			? `Did you mean:\n${similar.map((cmd) => `  - /swarm ${cmd}`).join('\n')}`
			: '';
	const footer = 'Run `/swarm help` for all commands.';
	return [header, suggestions, footer].filter(Boolean).join('\n\n');
}

export async function executeSwarmCommand(args: {
	directory: string;
	agents: Record<string, AgentDefinition>;
	sessionID: string;
	tokens: string[];
	packageRoot?: string;
	config?: PluginConfig;
	buildHelpText?: () => string;
	policy?: SwarmCommandPolicy;
	evaluationModelDispatcher?: EvaluationModelDispatcher;
	reviewModelDispatcher?: ReviewModelDispatcher;
	autoReviewConfig?: AutoReviewConfig;
	activeAgentName?: string;
	reviewAgentModelRegistry?: ReviewAgentModelRegistry;
}): Promise<SwarmCommandExecutionResult> {
	const {
		directory,
		agents,
		sessionID,
		tokens,
		packageRoot,
		config,
		buildHelpText,
		policy,
		evaluationModelDispatcher,
		reviewModelDispatcher,
		autoReviewConfig,
		activeAgentName,
		reviewAgentModelRegistry,
	} = args;

	let text: string;
	const resolved = resolveCommand(tokens);

	if (!resolved) {
		text =
			tokens.length === 0 && buildHelpText
				? buildHelpText()
				: formatCommandNotFound(tokens);
	} else {
		const policyResult = policy?.(resolved) ?? { allowed: true };
		if (!policyResult.allowed) {
			text = policyResult.message;
		} else {
			try {
				const raw = await resolved.entry.handler({
					directory,
					args: resolved.remainingArgs,
					sessionID,
					agents,
					config,
					packageRoot,
					source: 'chat',
					evaluationModelDispatcher,
					reviewModelDispatcher,
					autoReviewConfig,
					activeAgentName,
					reviewAgentModelRegistry,
				});
				// Structured failures unwrap to their text on the chat path
				// (chat has no exit codes; the CLI is the exit-code consumer).
				text = isCommandFailure(raw) ? raw.text : raw;
			} catch (_err) {
				const cmdName = tokens[0] || 'unknown';
				const errMsg = _err instanceof Error ? _err.message : String(_err);
				text = `Error executing /swarm ${cmdName}: ${errMsg}`;
			}

			if (resolved.warning) {
				text = `${resolved.warning}\n\n${text}`;
			}
		}
	}

	return {
		text,
		resolved: resolved ?? undefined,
		canonicalKey: resolved ? canonicalCommandKey(resolved) : undefined,
	};
}

export type { CommandEntry };
