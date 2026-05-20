/**
 * Agent Activity Tracking Hooks
 *
 * Tracks tool usage through tool.execute.before and tool.execute.after hooks.
 * Records timing, success/failure, and periodically flushes aggregated stats.
 */
import type { PluginConfig } from '../config/schema';
/**
 * Creates agent activity tracking hooks
 * @param config Plugin configuration
 * @param directory Project directory path
 * @returns Tool before and after hook handlers
 */
export declare function createAgentActivityHooks(config: PluginConfig, directory: string): {
    toolBefore: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: {
        args: unknown;
    }) => Promise<void>;
    toolAfter: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: {
        title?: string;
        output?: unknown;
        metadata?: unknown;
        error?: unknown;
        success?: boolean;
    }) => Promise<void>;
};
/**
 * Flushes activity data to context.md file
 * Ensures only one flush operation runs at a time
 * @param directory Project directory path
 */
declare function flushActivityToFile(directory: string): Promise<void>;
export { flushActivityToFile as _flushForTesting };
