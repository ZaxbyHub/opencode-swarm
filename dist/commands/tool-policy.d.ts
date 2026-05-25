import type { ResolvedSwarmCommand, SwarmCommandPolicyResult } from './command-dispatch.js';
export declare const SWARM_COMMAND_TOOL_COMMANDS: readonly ["agents", "config", "config doctor", "config-doctor", "doctor", "doctor tools", "status", "show-plan", "plan", "help", "history", "evidence", "evidence summary", "evidence-summary", "retrieve", "diagnose", "preflight", "benchmark", "knowledge", "memory", "memory status", "memory export", "memory import", "memory migrate", "sync-plan", "export", "list-agents"];
export type SwarmCommandToolInputCommand = (typeof SWARM_COMMAND_TOOL_COMMANDS)[number];
export declare const SWARM_COMMAND_TOOL_ALLOWLIST: Set<string>;
/**
 * Issue #890: subcommands that must be invoked by a human user, not by the
 * agent. The runtime Bash guardrail
 * (`src/hooks/guardrails.ts` section 23) blocks the equivalent
 * `bunx opencode-swarm run <cmd>` shell invocation; this set drives the
 * chat-tool refusal message so the agent is told to surface to the user
 * instead of being pointed at the CLI bypass it just attempted.
 */
export declare const HUMAN_ONLY_SWARM_COMMANDS: Set<string>;
export declare function classifySwarmCommandToolUse(resolved: ResolvedSwarmCommand): SwarmCommandPolicyResult;
export declare function classifySwarmCommandChatFallbackUse(resolved: ResolvedSwarmCommand): SwarmCommandPolicyResult;
