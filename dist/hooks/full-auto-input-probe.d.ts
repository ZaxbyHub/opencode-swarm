import type { PluginConfig } from '../config';
export interface FullAutoInputProbeHookOptions {
    config: PluginConfig;
    directory: string;
}
interface ToolAfterInput {
    tool: string;
    sessionID: string;
    callID?: string;
}
interface ToolAfterOutput {
    output?: unknown;
    error?: unknown;
}
export interface PendingInputWarning {
    tool: string;
    at: string;
    categories: string[];
}
export declare const fullAutoInputWarningStash: Map<string, PendingInputWarning>;
export declare function setPendingInputWarning(sessionID: string, warning: PendingInputWarning): void;
export declare function consumePendingInputWarning(sessionID: string): PendingInputWarning | undefined;
export declare function peekPendingInputWarning(sessionID: string): PendingInputWarning | undefined;
export declare function createFullAutoInputProbeHook(options: FullAutoInputProbeHookOptions): {
    toolAfter: (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>;
};
export {};
