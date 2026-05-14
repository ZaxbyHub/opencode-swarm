import type { ResolvedSwarmCommand, SwarmCommandPolicyResult } from './command-dispatch.js';
export declare const SWARM_COMMAND_TOOL_COMMANDS: readonly ["agents", "config", "config doctor", "config-doctor", "doctor", "doctor tools", "status", "show-plan", "plan", "help", "history", "evidence", "evidence summary", "evidence-summary", "retrieve", "diagnose", "preflight", "benchmark", "knowledge", "sync-plan", "export", "list-agents"];
export type SwarmCommandToolInputCommand = (typeof SWARM_COMMAND_TOOL_COMMANDS)[number];
export declare const SWARM_COMMAND_TOOL_ALLOWLIST: Set<string>;
export declare function classifySwarmCommandToolUse(resolved: ResolvedSwarmCommand): SwarmCommandPolicyResult;
export declare function classifySwarmCommandChatFallbackUse(resolved: ResolvedSwarmCommand): SwarmCommandPolicyResult;
