import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/index.js';
import {
	_internals,
	COMMAND_REGISTRY,
	type CommandEntry,
	resolveCommand,
	VALID_COMMANDS,
} from './registry.js';

export { handleAcknowledgeSpecDriftCommand } from './acknowledge-spec-drift';
// Re-export individual handlers
export { handleAgentsCommand } from './agents';
export { handleAnalyzeCommand } from './analyze';
export { handleArchiveCommand } from './archive';
export { handleBenchmarkCommand } from './benchmark';
export { handleBrainstormCommand } from './brainstorm';
export { handleCheckpointCommand } from './checkpoint';
export { handleClarifyCommand } from './clarify';
export { handleCloseCommand } from './close';
export type { CommandName } from './command-names.js';
export { COMMAND_NAME_SET, COMMAND_NAMES } from './command-names.js';
export { handleConfigCommand } from './config';
export { handleCouncilCommand } from './council';
export { handleCurateCommand } from './curate';
export { handleDarkMatterCommand } from './dark-matter';
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
} from './knowledge';
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
export { handleSimulateCommand } from './simulate';
export { handleSpecifyCommand } from './specify';
export { handleStatusCommand } from './status';
export { handleSyncPlanCommand } from './sync-plan';
export { handleTurboCommand } from './turbo';
export { handleWriteRetroCommand } from './write-retro';

export function buildHelpText(): string {
	const lines: string[] = ['## Swarm Commands', ''];

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
): (
	input: { command: string; sessionID: string; arguments: string },
	output: { parts: unknown[] },
) => Promise<void> {
	return async (input, output) => {
		// Accept both the generic 'swarm' command and individual shortcut commands
		// like 'swarm-config', 'swarm-status', 'swarm-sync-plan', etc.
		// When a user selects a shortcut from the command picker (e.g. swarm-config),
		// OpenCode sets input.command to the registered key ('swarm-config') and
		// input.arguments to any additional $ARGUMENTS the user typed. Without this
		// check those shortcuts were silently ignored and fell through to the LLM.
		if (input.command !== 'swarm' && !input.command.startsWith('swarm-')) {
			return;
		}

		// First-run sentinel detection (atomic — only swarm commands can initialize)
		let isFirstRun = false;
		const sentinelPath = path.join(directory, '.swarm', '.first-run-complete');
		try {
			const swarmDir = path.join(directory, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			// 'wx' flag: write-only, fails atomically if file already exists
			fs.writeFileSync(
				sentinelPath,
				`first-run-complete: ${new Date().toISOString()}\n`,
				{ flag: 'wx' },
			);
			isFirstRun = true; // Only reached if write succeeded (file didn't exist)
		} catch (_err) {
			// EEXIST means file already existed — not first run; other errors: proceed silently
		}

		// Verified: input.arguments receives the expanded $ARGUMENTS from the template.
		// The hook output.parts overrides the LLM response in the UI.
		// Parse arguments
		let tokens: string[];
		if (input.command === 'swarm') {
			// Generic /swarm $ARGUMENTS: arguments contain the full subcommand + args
			tokens = input.arguments.trim().split(/\s+/).filter(Boolean);
		} else {
			// Shortcut command like 'swarm-config': extract subcommand from the key
			// e.g. 'swarm-config' → 'config', 'swarm-sync-plan' → 'sync-plan'
			const subcommand = input.command.slice('swarm-'.length);
			const extraArgs = input.arguments.trim().split(/\s+/).filter(Boolean);
			tokens = [subcommand, ...extraArgs];
		}

		let text: string;

		const resolved = resolveCommand(tokens);

		if (!resolved) {
			if (tokens.length === 0) {
				text = buildHelpText();
			} else {
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
						? `Did you mean:\n${similar.map((cmd) => `  • /swarm ${cmd}`).join('\n')}`
						: '';
				const footer = 'Run `/swarm help` for all commands.';
				text = [header, suggestions, footer].filter(Boolean).join('\n\n');
			}
		} else {
			try {
				text = await resolved.entry.handler({
					directory,
					args: resolved.remainingArgs,
					sessionID: input.sessionID,
					agents,
				});
			} catch (_err) {
				const cmdName = tokens[0] || 'unknown';
				const errMsg = _err instanceof Error ? _err.message : String(_err);
				text = `Error executing /swarm ${cmdName}: ${errMsg}`;
			}

			// Prepend deprecation warning if the resolved command is a deprecated alias
			if (resolved.warning) {
				text = `${resolved.warning}\n\n${text}`;
			}
		}

		// Prepend welcome message on first run
		if (isFirstRun) {
			const welcomeMessage =
				`Welcome to OpenCode Swarm! 🐝\n` +
				`\n` +
				`Run \`/swarm help\` to see all available commands, or \`/swarm config\` to review your configuration.\n`;
			text = welcomeMessage + text;
		}

		// Convert string result to Part[]
		output.parts = [
			{ type: 'text', text } as unknown as (typeof output.parts)[number],
		];
	};
}
