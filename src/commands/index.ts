import type { AgentDefinition } from '../agents/index.js';
import {
	AGENT_TOOL_MAP,
	type AgentName,
	ORCHESTRATOR_NAME,
} from '../config/constants.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	canonicalCommandKey,
	executeSwarmCommand,
	formatCommandNotFound,
	normalizeSwarmCommandInput,
	type ResolvedSwarmCommand,
} from './command-dispatch.js';
import {
	_internals,
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry.js';
import {
	classifySwarmCommandChatFallbackUse,
	classifySwarmCommandToolUse,
	SWARM_COMMAND_TOOL_ALLOWLIST,
} from './tool-policy.js';

export { handleAcknowledgeSpecDriftCommand } from './acknowledge-spec-drift';
// Re-export individual handlers
export { handleAgentsCommand } from './agents';
export { handleAnalyzeCommand } from './analyze';
export { handleArchiveCommand } from './archive';
export { handleAutoProceedCommand } from './auto-proceed';
export { handleBenchmarkCommand } from './benchmark';
export { handleBrainstormCommand } from './brainstorm';
export { handleCheckpointCommand } from './checkpoint';
export { handleClarifyCommand } from './clarify';
export { handleCloseCommand } from './close';
export { handleCodebaseReviewCommand } from './codebase-review';
export {
	executeSwarmCommand,
	formatCommandNotFound,
	normalizeSwarmCommandInput,
} from './command-dispatch.js';
export type { CommandName } from './command-names.js';
export { COMMAND_NAME_SET, COMMAND_NAMES } from './command-names.js';
export { handleConcurrencyCommand } from './concurrency';
export { handleConfigCommand } from './config';
export { handleCouncilCommand } from './council';
export { handleCurateCommand } from './curate';
export { handleDarkMatterCommand } from './dark-matter';
export { handleDeepDiveCommand } from './deep-dive';
export { handleDeepResearchCommand } from './deep-research';
export { handleDiagnoseCommand } from './diagnose';
export { handleDoctorCommand } from './doctor';
export {
	handleEvidenceCommand,
	handleEvidenceSummaryCommand,
} from './evidence';
export { handleExportCommand } from './export';
export { handleFullAutoCommand } from './full-auto';
export { handleHandoffCommand } from './handoff';
export { handleHistoryCommand } from './history';
export {
	handleKnowledgeListCommand,
	handleKnowledgeMigrateCommand,
	handleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand,
	handleKnowledgeRetryHardeningCommand,
	handleKnowledgeUnactionableCommand,
} from './knowledge';
export { handleLearningCommand } from './learning';
export {
	handleMemoryCommand,
	handleMemoryExportCommand,
	handleMemoryImportCommand,
	handleMemoryMigrateCommand,
	handleMemoryStatusCommand,
} from './memory';
export { handlePlanCommand } from './plan';
export { handlePreflightCommand } from './preflight';
export { handlePromoteCommand } from './promote';
export { handleQaGatesCommand } from './qa-gates';
export { handleHelpCommand } from './registry';
export type {
	CommandContext,
	CommandEntry,
	RegisteredCommand,
} from './registry.js';
// Re-export registry for consumers
export {
	COMMAND_REGISTRY,
	resolveCommand,
	VALID_COMMANDS,
} from './registry.js';
export { handleResetCommand } from './reset';
export { handleResetSessionCommand } from './reset-session';
export { handleRetrieveCommand } from './retrieve';
export { handleRollbackCommand } from './rollback';
export {
	handleSddCommand,
	handleSddProjectCommand,
	handleSddStatusCommand,
	handleSddValidateCommand,
} from './sdd';
export { handleSimulateCommand } from './simulate';
export { handleSpecifyCommand } from './specify';
export { handleStatusCommand } from './status';
export { handleSyncPlanCommand } from './sync-plan';
export {
	classifySwarmCommandChatFallbackUse,
	classifySwarmCommandToolUse,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from './tool-policy.js';
export { handleTurboCommand } from './turbo';
export { handleWriteRetroCommand } from './write-retro';

export function buildHelpText(): string {
	const lines: string[] = [
		'## Swarm Commands',
		'',
		'**Chat routing note**: supported read-only `/swarm` commands are routed through the `swarm_command` tool when the active agent has that tool. Unsupported or state-changing commands remain chat-mediated; use `bunx opencode-swarm run <subcommand>` when you need canonical output.',
		'',
	];

	// Valid categories in display order
	const CATEGORIES = [
		'core',
		'agent',
		'config',
		'diagnostics',
		'utility',
	] as const;
	type Category = (typeof CATEGORIES)[number];

	// Group commands by category
	const byCategory = new Map<Category, string[]>();
	for (const cat of CATEGORIES) {
		byCategory.set(cat, []);
	}

	// Collect deprecated aliases for later
	const deprecatedAliases: Array<{ name: string; aliasOf: string }> = [];

	// First pass: organize commands into categories, skip aliases and subcommands
	for (const cmd of VALID_COMMANDS) {
		const entry = COMMAND_REGISTRY[
			cmd as keyof typeof COMMAND_REGISTRY
		] as CommandEntry;

		// Skip aliases - they go in deprecated section
		if (entry.aliasOf) {
			deprecatedAliases.push({ name: cmd, aliasOf: entry.aliasOf });
			continue;
		}

		// Skip subcommands - they're shown under their parent
		if (entry.subcommandOf) {
			continue;
		}

		// Skip compound commands (with spaces) - handled below as top-level
		if (cmd.includes(' ')) {
			continue;
		}

		const category = (entry.category || 'utility') as Category;
		const catLines = byCategory.get(category) || [];
		catLines.push(cmd);
		byCategory.set(category, catLines);
	}

	// Track which compound commands have been shown as subcommands
	const shownAsSubcommand = new Set<string>();

	// Output each category
	for (const cat of CATEGORIES) {
		const catLines = byCategory.get(cat);
		if (!catLines || catLines.length === 0) continue;

		const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
		lines.push(`### ${catTitle}`, '');

		for (const cmd of catLines) {
			const entry = COMMAND_REGISTRY[
				cmd as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			lines.push(`- \`/swarm ${cmd}\` — ${entry.description}`);

			if (entry.clashesWithNativeCcCommand) {
				lines.push(
					`  ⚠️ Name conflicts with CC built-in \`${entry.clashesWithNativeCcCommand}\` — always use \`/swarm ${cmd}\``,
				);
			}

			if (entry.args) {
				lines.push(`  Args: \`${entry.args}\``);
			}
			if (entry.details) {
				lines.push(`  ${entry.details}`);
			}

			// Show subcommands grouped under this parent
			const subcommands = VALID_COMMANDS.filter(
				(sub) => sub.startsWith(`${cmd} `) && sub !== cmd,
			);
			for (const sub of subcommands) {
				shownAsSubcommand.add(sub);
				const subEntry = COMMAND_REGISTRY[
					sub as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				const subName = sub.slice(cmd.length + 1);
				lines.push(`  - \`${subName}\` — ${subEntry.description}`);
				if (subEntry.args) {
					lines.push(`    Args: \`${subEntry.args}\``);
				}
				if (subEntry.details) {
					lines.push(`    ${subEntry.details}`);
				}
			}
		}
		lines.push('');
	}

	// Second pass: show compound commands that don't have a parent in VALID_COMMANDS
	for (const cmd of VALID_COMMANDS) {
		if (!cmd.includes(' ') || shownAsSubcommand.has(cmd)) continue;
		const entry = COMMAND_REGISTRY[
			cmd as keyof typeof COMMAND_REGISTRY
		] as CommandEntry;

		// Skip aliases and subcommands
		if (entry.aliasOf || entry.subcommandOf) continue;

		lines.push(`- \`/swarm ${cmd}\` — ${entry.description}`);
		if (entry.clashesWithNativeCcCommand) {
			lines.push(
				`  ⚠️ Name conflicts with CC built-in \`${entry.clashesWithNativeCcCommand}\` — always use \`/swarm ${cmd}\``,
			);
		}
		if (entry.args) {
			lines.push(`  Args: \`${entry.args}\``);
		}
		if (entry.details) {
			lines.push(`  ${entry.details}`);
		}
	}

	// Deprecated section
	if (deprecatedAliases.length > 0) {
		lines.push('### Deprecated Commands', '');
		for (const { name, aliasOf } of deprecatedAliases) {
			lines.push(`- \`/swarm ${name}\` → Use \`/swarm ${aliasOf}\``);
			// Check if this deprecated alias has a clash warning
			const aliasEntry = COMMAND_REGISTRY[
				name as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			if (aliasEntry?.clashesWithNativeCcCommand) {
				lines.push(
					`  ⚠️ Name conflicts with CC built-in \`${aliasEntry.clashesWithNativeCcCommand}\` — always use \`/swarm ${aliasOf}\``,
				);
			}
		}
	}

	return lines.join('\n');
}

/**
 * Creates a command.execute.before handler for /swarm commands.
 * Uses factory pattern to close over directory and agents.
 */
export function createSwarmCommandHandler(
	directory: string,
	agents: Record<string, AgentDefinition>,
	options: {
		getActiveAgentName?: (sessionID: string) => string | undefined;
		packageRoot?: string;
		registeredAgents?: Record<string, { tools?: Record<string, boolean> }>;
	} = {},
): (
	input: { command: string; sessionID: string; arguments: string },
	output: { parts: unknown[] },
) => Promise<void> {
	return async (input, output) => {
		const normalized = normalizeSwarmCommandInput(
			input.command,
			input.arguments,
		);
		if (!normalized.isSwarmCommand) {
			return;
		}
		output.parts.splice(0, output.parts.length, {
			type: 'text',
			text: await buildSwarmCommandPrompt({
				directory,
				agents,
				sessionID: input.sessionID,
				tokens: normalized.tokens,
				activeAgentName: options.getActiveAgentName?.(input.sessionID),
				packageRoot: options.packageRoot,
				registeredAgents: options.registeredAgents,
			}),
		} as unknown as (typeof output.parts)[number]);
		return;
	};
}

async function buildSwarmCommandPrompt(args: {
	directory: string;
	agents: Record<string, AgentDefinition>;
	sessionID: string;
	tokens: string[];
	activeAgentName?: string;
	packageRoot?: string;
	registeredAgents?: Record<string, { tools?: Record<string, boolean> }>;
}): Promise<string> {
	const {
		directory,
		agents,
		sessionID,
		tokens,
		activeAgentName,
		packageRoot,
		registeredAgents,
	} = args;
	const resolved = _internals.resolveCommand(tokens);
	if (!resolved) {
		if (tokens.length === 0) {
			return buildHelpText();
		}
		return formatCommandNotFound(tokens);
	}

	const typedResolved = resolved as ResolvedSwarmCommand;
	const canonicalKey = canonicalCommandKey(typedResolved);
	const policy = classifySwarmCommandToolUse(typedResolved);
	const isV1ToolCommand = SWARM_COMMAND_TOOL_ALLOWLIST.has(canonicalKey);
	const canUseTool = agentHasSwarmCommandTool(
		activeAgentName,
		agents,
		registeredAgents,
	);
	if (canUseTool && policy.allowed && isV1ToolCommand) {
		return routeToSwarmCommandTool({
			command: canonicalKey,
			args: resolved.remainingArgs,
			original: `/swarm ${tokens.join(' ')}`.trim(),
		});
	}

	if (canUseTool && isV1ToolCommand && !policy.allowed) {
		return [
			`The user typed \`/swarm ${tokens.join(' ')}\`.`,
			policy.message,
			'Do not invent command output. Explain the limitation and recommend the canonical CLI path above.',
		].join('\n');
	}

	const chatFallbackPolicy = classifySwarmCommandChatFallbackUse(typedResolved);
	if (!chatFallbackPolicy.allowed) {
		return [
			`The user typed \`/swarm ${tokens.join(' ')}\`.`,
			chatFallbackPolicy.message,
			'Do not execute this command through chat and do not invent command output.',
		].join('\n');
	}

	const result = await executeSwarmCommand({
		directory,
		agents,
		sessionID,
		tokens,
		packageRoot,
	});

	return formatCanonicalPromptFallback({
		original: `/swarm ${tokens.join(' ')}`.trim(),
		text: result.text,
	});
}

export function agentHasSwarmCommandTool(
	activeAgentName: string | undefined,
	agents: Record<string, AgentDefinition>,
	registeredAgents?: Record<string, { tools?: Record<string, boolean> }>,
): boolean {
	const name = activeAgentName ?? ORCHESTRATOR_NAME;
	const registeredTools = registeredAgents?.[name]?.tools;
	if (registeredTools) {
		// Registered runtime tools are authoritative. Falling through to
		// AGENT_TOOL_MAP here could tell an agent to call a tool OpenCode did
		// not actually register for it.
		return registeredTools.swarm_command === true;
	}

	const explicitTools = agents[name]?.config?.tools;
	if (explicitTools) {
		// Explicit factory tools are also authoritative for tests and direct
		// consumers that do not pass OpenCode's registered agent map.
		return explicitTools.swarm_command === true;
	}

	const baseName = stripKnownSwarmPrefix(name) as AgentName;
	return AGENT_TOOL_MAP[baseName]?.includes('swarm_command') === true;
}

function formatCanonicalPromptFallback(args: {
	original: string;
	text: string;
}): string {
	// Mode-activation signals (e.g. `[MODE: DEEP_DIVE ...]`, `[MODE: PR_REVIEW ...]`)
	// are NOT command output to echo — they instruct the architect to enter a mode
	// and run that mode's skill. The verbatim-echo wrapper used for informational
	// output actively defeats them (the architect prints the signal instead of
	// acting on it). Detect the signal and emit an activation instruction instead.
	// The instruction is intentionally generic (it names no specific SKILL.md path)
	// so a signal whose mode has no `### MODE:` section/skill — e.g. ANALYZE — is
	// not told to load a file that does not exist; the architect's SIGNAL-TRIGGERED
	// MODE rule falls through when no matching section is found.
	if (/^\s*\[MODE:/.test(args.text)) {
		return [
			`The user typed \`${args.original}\`.`,
			'The line below is a swarm MODE-activation signal, NOT output to display.',
			'Enter the mode named in its `[MODE: X ...]` header now: follow your',
			'prompt’s "### MODE: X" section, load the SKILL.md it references, and',
			'follow that protocol exactly. Treat any text after the closing bracket as',
			'additional instructions. Do NOT echo this signal verbatim.',
			'',
			args.text,
		].join('\n');
	}
	return [
		`The user typed \`${args.original}\`.`,
		'Canonical opencode-swarm command output follows.',
		'Show this output verbatim and add no extra swarm state.',
		'',
		args.text,
	].join('\n');
}

function routeToSwarmCommandTool(args: {
	command: string;
	args: string[];
	original: string;
}): string {
	return [
		`The user typed \`${args.original}\`.`,
		'Call the `swarm_command` tool exactly once with:',
		JSON.stringify({ command: args.command, args: args.args }, null, 2),
		'After the tool returns, show the tool output verbatim and add no extra swarm state.',
	].join('\n');
}
