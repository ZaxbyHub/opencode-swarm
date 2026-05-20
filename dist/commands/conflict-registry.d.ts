/**
 * Conflict registry — pure data module mapping Claude Code commands to swarm commands.
 * No I/O, no side effects. Used for disambiguation warnings in shortcut routing.
 */
export type ConflictSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export interface CommandConflict {
    /** swarm subcommand name (no leading slash) */
    swarmCommand: string;
    /** CC command with leading slash, e.g. '/plan' */
    ccCommand: string;
    severity: ConflictSeverity;
    /** What the CC command does */
    ccBehavior: string;
    /** What the swarm command does */
    swarmBehavior: string;
    /** Starts with "Use /swarm" or "NEVER invoke" */
    disambiguationNote: string;
}
export declare const CLAUDE_CODE_CONFLICTS: readonly [{
    readonly swarmCommand: "show-plan";
    readonly ccCommand: "/plan";
    readonly severity: "CRITICAL";
    readonly ccBehavior: "Enters Claude Code plan mode — Claude proposes all actions before executing them";
    readonly swarmBehavior: "Displays the current .swarm/plan.md task list";
    readonly disambiguationNote: "Use /swarm show-plan to read the swarm task plan. NEVER invoke the bare /plan command — it enters Claude Code plan mode and blocks execution.";
}, {
    readonly swarmCommand: "reset";
    readonly ccCommand: "/reset";
    readonly severity: "CRITICAL";
    readonly ccBehavior: "Alias for /clear — wipes the entire conversation context window";
    readonly swarmBehavior: "Clears .swarm state files (requires --confirm flag)";
    readonly disambiguationNote: "Use /swarm reset --confirm to clear swarm state. NEVER invoke the bare /reset or /clear command — it destroys the conversation context.";
}, {
    readonly swarmCommand: "checkpoint";
    readonly ccCommand: "/checkpoint";
    readonly severity: "CRITICAL";
    readonly ccBehavior: "Alias for /rewind — restores conversation and code to a prior state";
    readonly swarmBehavior: "Manages named swarm project snapshots (save|restore|delete|list)";
    readonly disambiguationNote: "Use /swarm checkpoint <save|restore|list> to manage swarm snapshots. NEVER invoke the bare /checkpoint command — it reverts the conversation history.";
}, {
    readonly swarmCommand: "status";
    readonly ccCommand: "/status";
    readonly severity: "HIGH";
    readonly ccBehavior: "Shows Claude Code version, active model, account, and API connectivity";
    readonly swarmBehavior: "Shows current swarm state: active phase, task counts, registered agents";
    readonly disambiguationNote: "Use /swarm status to check swarm progress. Do not confuse with Claude Code /status (which shows Claude version/connectivity).";
}, {
    readonly swarmCommand: "agents";
    readonly ccCommand: "/agents";
    readonly severity: "HIGH";
    readonly ccBehavior: "Manages Claude Code subagent configurations and teams";
    readonly swarmBehavior: "Lists registered swarm plugin agents with model, temperature, and guardrail info";
    readonly disambiguationNote: "Use /swarm agents to list swarm plugin agents. Do not confuse with Claude Code /agents (which manages Claude subagent configs).";
}, {
    readonly swarmCommand: "config";
    readonly ccCommand: "/config";
    readonly severity: "HIGH";
    readonly ccBehavior: "Opens Claude Code settings interface (alias: /settings)";
    readonly swarmBehavior: "Shows the current resolved opencode-swarm plugin configuration";
    readonly disambiguationNote: "Use /swarm config to view swarm plugin config. Do not confuse with Claude Code /config (which opens Claude settings).";
}, {
    readonly swarmCommand: "export";
    readonly ccCommand: "/export";
    readonly severity: "HIGH";
    readonly ccBehavior: "Exports the current Claude Code conversation as plain text to a file";
    readonly swarmBehavior: "Exports the swarm plan and context as JSON to stdout";
    readonly disambiguationNote: "Use /swarm export to export swarm plan+context JSON. Do not confuse with Claude Code /export (which exports conversation text).";
}, {
    readonly swarmCommand: "doctor";
    readonly ccCommand: "/doctor";
    readonly severity: "HIGH";
    readonly ccBehavior: "Diagnoses the Claude Code installation (version, auth, permissions)";
    readonly swarmBehavior: "Runs health checks on swarm configuration and state files";
    readonly disambiguationNote: "Use /swarm config doctor to diagnose swarm config health. NEVER invoke the bare /doctor command — it runs Claude Code installation diagnostics.";
}, {
    readonly swarmCommand: "history";
    readonly ccCommand: "/history";
    readonly severity: "MEDIUM";
    readonly ccBehavior: "Shows Claude Code session history";
    readonly swarmBehavior: "Shows completed swarm phases with status icons";
    readonly disambiguationNote: "Use /swarm history to see completed phases. This is unrelated to Claude Code session history.";
}];
export declare const CRITICAL_CONFLICTS: Set<string>;
export declare const HIGH_CONFLICTS: Set<string>;
export declare const CONFLICT_MAP: Map<string, CommandConflict>;
