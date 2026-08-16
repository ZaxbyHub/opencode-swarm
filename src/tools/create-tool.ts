import { type ToolContext, tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { resolveWorkingDirectory } from './resolve-working-directory';

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
	allowWorkingDirectoryOverride?: boolean;
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
 * Creates a swarm tool with optional working_directory override injection.
 * Wraps the @opencode-ai/plugin/tool factory to always inject `directory` and `ctx`
 * into tool execute callbacks, and to expose a caller-controlled
 * `working_directory` only for tools that explicitly opt into that override.
 *
 * Registration contract (issue #1781 E4): every `export const NAME = createSwarmTool({...})`
 * in `src/tools/**` MUST have a corresponding entry in `TOOL_METADATA`
 * (`src/tools/tool-metadata.ts`). The reverse-direction CI guard in
 * `scripts/check-tool-registration.ts` enumerates all exported `createSwarmTool`
 * bindings and fails on any without a metadata entry. If a tool definition is
 * intentionally internal (an unpublished helper), mark it with a
 * `/** @tool-opt-out <reason> *\/` JSDoc tag directly above its `export const`
 * so the guard skips it — silence is a failure, not an opt-out.
 */
export function createSwarmTool<Args extends Record<string, unknown>>(
	opts: SwarmToolOptions<Args>,
): ReturnType<typeof tool> {
	type ToolArgs = Parameters<typeof tool>[0]['args'];
	type ToolExecuteArgs = Parameters<Parameters<typeof tool>[0]['execute']>[0];
	const ownsWorkingDirectory = Object.hasOwn(opts.args, 'working_directory');
	const allowsWorkingDirectoryOverride =
		opts.allowWorkingDirectoryOverride === true && !ownsWorkingDirectory;
	const toolArgs = allowsWorkingDirectoryOverride
		? {
				...opts.args,
				working_directory: z
					.string()
					.optional()
					.describe('Project or linked-worktree root for this tool invocation'),
			}
		: opts.args;

	return tool({
		description: opts.description,
		args: toolArgs as unknown as ToolArgs,
		execute: async (args: ToolExecuteArgs, ctx?: ToolContext) => {
			// process.cwd() fallback is intentional: used when tool is invoked directly (CLI) without plugin runtime context
			const fallbackDirectory = ctx?.directory ?? process.cwd();
			try {
				let effectiveArgs = args as Args;
				let effectiveDirectory = fallbackDirectory;
				let effectiveContext = ctx;

				if (
					!ownsWorkingDirectory &&
					typeof args === 'object' &&
					args !== null
				) {
					if (
						!allowsWorkingDirectoryOverride &&
						Object.hasOwn(args, 'working_directory')
					) {
						throw new Error(
							'Invalid working_directory: this tool does not allow working_directory overrides',
						);
					}
					if (
						allowsWorkingDirectoryOverride &&
						Object.hasOwn(args, 'working_directory')
					) {
						const { working_directory: workingDirectory, ...executorArgs } =
							args as Record<string, unknown>;
						effectiveArgs = executorArgs as Args;

						if (workingDirectory !== undefined) {
							const resolved = resolveWorkingDirectory(
								workingDirectory as string | null,
								fallbackDirectory,
							);
							if (!resolved.success) throw new Error(resolved.message);

							effectiveDirectory = resolved.directory;
							effectiveContext = {
								...ctx,
								directory: resolved.directory,
								worktree: resolved.directory,
							} as ToolContext;
						}
					}
				}

				const result = await opts.execute(
					effectiveArgs,
					effectiveDirectory,
					effectiveContext,
				);
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
