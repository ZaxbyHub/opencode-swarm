import { type ToolContext, tool } from '@opencode-ai/plugin';
/**
 * ToolResult can be string | {output: string; metadata?: any}
 * This type matches what the plugin's tool() function expects as a return value.
 */
export type ToolResult = string | {
    output: string;
    metadata?: unknown;
};
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
    execute: (args: Args, directory: string, ctx?: ToolContext) => Promise<ToolResult>;
}
/**
 * Creates a swarm tool with automatic working directory injection.
 * Wraps the @opencode-ai/plugin/tool factory to always inject `directory` and `ctx` into tool execute callbacks.
 */
export declare function createSwarmTool<Args extends Record<string, unknown>>(opts: SwarmToolOptions<Args>): ReturnType<typeof tool>;
