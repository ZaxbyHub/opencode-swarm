import { type ToolContext, tool } from '@opencode-ai/plugin';

/**
 * ToolResult can be string | {output: string; metadata?: any}
 * This type matches what the plugin's tool() function expects as a return value.
 */
export type ToolResult = string | { output: string; metadata?: unknown };

/**
 * Options for creating a swarm tool.
 * The args type is inferred from what you pass to the tool() call.
 *
 * Note: The session-level EnvironmentProfile is available to any tool that has
 * a sessionID via `getSessionEnvironment(ctx?.sessionID)` from '../state.js'.
 * ToolContext is defined externally in @opencode-ai/plugin and is not modified here.
 */
export interface SwarmToolOptions<Args extends Record<string, unknown>> {
	description: string;
	args: Args;
	execute: (
		args: Args,
		directory: string,
		ctx?: ToolContext,
	) => Promise<ToolResult>;
}

type ToolFailureClass =
	| 'not_registered'
	| 'not_whitelisted'
	| 'binary_missing'
	| 'execution_error';

function classifyToolError(error: unknown): ToolFailureClass {
	const msg = (
		error instanceof Error ? (error.message ?? '') : String(error)
	).toLowerCase();
	if (msg.includes('not registered') || msg.includes('unknown tool'))
		return 'not_registered';
	if (msg.includes('not whitelisted') || msg.includes('not allowed'))
		return 'not_whitelisted';
	if (
		msg.includes('enoent') ||
		msg.includes('command not found') ||
		msg.includes('binary not found') ||
		msg.includes('no such file or directory')
	)
		return 'binary_missing';
	return 'execution_error';
}

/**
 * Creates a swarm tool with automatic working directory injection.
 * Wraps the @opencode-ai/plugin/tool factory to always inject `directory` and `ctx` into tool execute callbacks.
 */
export function createSwarmTool<Args extends Record<string, unknown>>(
	opts: SwarmToolOptions<Args>,
): ReturnType<typeof tool> {
	type ToolArgs = Parameters<typeof tool>[0]['args'];
	type ToolExecuteArgs = Parameters<Parameters<typeof tool>[0]['execute']>[0];

	return tool({
		description: opts.description,
		args: opts.args as unknown as ToolArgs,
		execute: async (args: ToolExecuteArgs, ctx?: ToolContext) => {
			// process.cwd() fallback is intentional: used when tool is invoked directly (CLI) without plugin runtime context
			const directory = ctx?.directory ?? process.cwd();
			try {
				const result = await opts.execute(args as Args, directory, ctx);
				// ToolResult can be string | {output: string; metadata?: any}
				// If result is a string, return it directly
				// Otherwise return the result object as-is
				return result as unknown as string;
			} catch (error) {
				// Defense-in-depth: sanitize error to prevent stack trace leakage to TUI.
				// Individual tools may also catch internally — this ensures nothing leaks
				// through the centralized wrapper regardless.
				const message = error instanceof Error ? error.message : String(error);
				return JSON.stringify(
					{
						success: false,
						failure_class: classifyToolError(error),
						message: 'Tool execution failed',
						errors: [message],
					},
					null,
					2,
				);
			}
		},
	});
}
