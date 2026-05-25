import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { AgentDefinition } from '../agents/index.js';
import { executeSwarmCommand } from '../commands/command-dispatch.js';
import {
	classifySwarmCommandToolUse,
	SWARM_COMMAND_TOOL_COMMANDS,
} from '../commands/tool-policy.js';
import { createSwarmTool } from './create-tool.js';

type SwarmCommandArgs = {
	command: string;
	args?: string[];
};

export function createSwarmCommandTool(
	agents: Record<string, AgentDefinition>,
): ReturnType<typeof createSwarmTool> {
	return createSwarmTool({
		description:
			'Run supported /swarm commands through the canonical opencode-swarm command registry. Return the tool output verbatim to the user.',
		args: {
			command: z
				.enum(SWARM_COMMAND_TOOL_COMMANDS)
				.describe('The /swarm subcommand to run, without the /swarm prefix.'),
			args: z
				.array(z.string())
				.default([])
				.describe('Additional command arguments as separate tokens.'),
		},
		async execute(
			rawArgs: unknown,
			directory: string,
			ctx?: ToolContext,
		): Promise<string> {
			const args = rawArgs as SwarmCommandArgs;
			const result = await executeSwarmCommand({
				directory,
				agents,
				sessionID: ctx?.sessionID ?? '',
				tokens: [args.command, ...(args.args ?? [])],
				policy: classifySwarmCommandToolUse,
			});
			return result.text;
		},
	});
}

// Static barrel export for registration conformance tests. The plugin runtime
// registers a per-session instance with the generated agent map in src/index.ts.
export const swarm_command: ReturnType<typeof createSwarmTool> =
	createSwarmCommandTool({});
