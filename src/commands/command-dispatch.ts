import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/index.js';
import { _internals, type CommandEntry, resolveCommand } from './registry.js';

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
	return resolved.entry.aliasOf ?? resolved.key;
}

export function formatCommandNotFound(tokens: string[]): string {
	const attemptedCommand = tokens[0] || '';
	const MAX_DISPLAY = 100;
	const displayCommand =
		attemptedCommand.length > MAX_DISPLAY
			? `${attemptedCommand.slice(0, MAX_DISPLAY)}...`
			: attemptedCommand;
	const similar = _internals.findSimilarCommands(attemptedCommand);
	const header = `Command \`/swarm ${displayCommand}\` not found.`;
	const suggestions =
		similar.length > 0
			? `Did you mean:\n${similar.map((cmd) => `  - /swarm ${cmd}`).join('\n')}`
			: '';
	const footer = 'Run `/swarm help` for all commands.';
	return [header, suggestions, footer].filter(Boolean).join('\n\n');
}

export function maybeMarkFirstRun(directory: string): boolean {
	const sentinelPath = path.join(directory, '.swarm', '.first-run-complete');
	try {
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			sentinelPath,
			`first-run-complete: ${new Date().toISOString()}\n`,
			{ flag: 'wx' },
		);
		return true;
	} catch {
		return false;
	}
}

export function prependWelcome(text: string): string {
	const welcomeMessage =
		`Welcome to OpenCode Swarm!\n` +
		`\n` +
		`Run \`/swarm help\` to see all available commands, or \`/swarm config\` to review your configuration.\n`;
	return welcomeMessage + text;
}

export async function executeSwarmCommand(args: {
	directory: string;
	agents: Record<string, AgentDefinition>;
	sessionID: string;
	tokens: string[];
	includeWelcome?: boolean;
	buildHelpText?: () => string;
	policy?: SwarmCommandPolicy;
}): Promise<SwarmCommandExecutionResult> {
	const {
		directory,
		agents,
		sessionID,
		tokens,
		includeWelcome = false,
		buildHelpText,
		policy,
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
				text = await resolved.entry.handler({
					directory,
					args: resolved.remainingArgs,
					sessionID,
					agents,
					source: 'chat',
				});
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

	if (includeWelcome && maybeMarkFirstRun(directory)) {
		text = prependWelcome(text);
	}

	return {
		text,
		resolved: resolved ?? undefined,
		canonicalKey: resolved ? canonicalCommandKey(resolved) : undefined,
	};
}

export type { CommandEntry };
