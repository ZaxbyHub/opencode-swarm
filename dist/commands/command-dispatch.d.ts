import type { AgentDefinition } from '../agents/index.js';
import { type CommandEntry, resolveCommand } from './registry.js';
export type ResolvedSwarmCommand = NonNullable<ReturnType<typeof resolveCommand>>;
export type SwarmCommandPolicyResult = {
    allowed: true;
} | {
    allowed: false;
    message: string;
};
export type SwarmCommandPolicy = (resolved: ResolvedSwarmCommand) => SwarmCommandPolicyResult;
export type SwarmCommandExecutionResult = {
    text: string;
    resolved?: ResolvedSwarmCommand;
    canonicalKey?: string;
};
export declare function normalizeSwarmCommandInput(command: string, argumentText: string): {
    isSwarmCommand: boolean;
    tokens: string[];
};
export declare function canonicalCommandKey(resolved: ResolvedSwarmCommand): string;
export declare function formatCommandNotFound(tokens: string[]): string;
export declare function maybeMarkFirstRun(directory: string): boolean;
export declare function prependWelcome(text: string): string;
export declare function executeSwarmCommand(args: {
    directory: string;
    agents: Record<string, AgentDefinition>;
    sessionID: string;
    tokens: string[];
    includeWelcome?: boolean;
    buildHelpText?: () => string;
    policy?: SwarmCommandPolicy;
}): Promise<SwarmCommandExecutionResult>;
export type { CommandEntry };
