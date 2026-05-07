import type { PluginConfig } from '../config';
export interface FullAutoDelegationHookOptions {
    config: PluginConfig;
    directory: string;
}
interface ToolBeforeInput {
    tool: string;
    sessionID: string;
    callID?: string;
}
interface ToolBeforeOutput {
    args: unknown;
}
interface ToolAfterInput {
    tool: string;
    sessionID: string;
    callID?: string;
    args?: unknown;
}
interface ToolAfterOutput {
    output?: unknown;
    error?: unknown;
}
export declare function createFullAutoDelegationHook(options: FullAutoDelegationHookOptions): {
    toolBefore: (input: ToolBeforeInput, output: ToolBeforeOutput) => Promise<void>;
    toolAfter: (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>;
};
export {};
