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

export const CLAUDE_CODE_CONFLICTS = [
	// CRITICAL (3)
	{
		swarmCommand: 'show-plan',
		ccCommand: '/plan',
		severity: 'CRITICAL',
		ccBehavior:
			'Enters Claude Code plan mode — Claude proposes all actions before executing them',
		swarmBehavior: 'Displays the current .swarm/plan.md task list',
		disambiguationNote:
			'Use /swarm show-plan to read the swarm task plan. NEVER invoke the bare /plan command — it enters Claude Code plan mode and blocks execution.',
	},
	{
		swarmCommand: 'reset',
		ccCommand: '/reset',
		severity: 'CRITICAL',
		ccBehavior:
			'Alias for /clear — wipes the entire conversation context window',
		swarmBehavior: 'Clears .swarm state files (requires --confirm flag)',
		disambiguationNote:
			'Use /swarm reset --confirm to clear swarm state. NEVER invoke the bare /reset or /clear command — it destroys the conversation context.',
	},
	{
		swarmCommand: 'checkpoint',
		ccCommand: '/checkpoint',
		severity: 'CRITICAL',
		ccBehavior:
			'Alias for /rewind — restores conversation and code to a prior state',
		swarmBehavior:
			'Manages named swarm project snapshots (save|restore|delete|list)',
		disambiguationNote:
			'Use /swarm checkpoint <save|restore|list> to manage swarm snapshots. NEVER invoke the bare /checkpoint command — it reverts the conversation history.',
	},

	// HIGH (5)
	{
		swarmCommand: 'status',
		ccCommand: '/status',
		severity: 'HIGH',
		ccBehavior:
			'Shows Claude Code version, active model, account, and API connectivity',
		swarmBehavior:
			'Shows current swarm state: active phase, task counts, registered agents',
		disambiguationNote:
			'Use /swarm status to check swarm progress. Do not confuse with Claude Code /status (which shows Claude version/connectivity).',
	},
	{
		swarmCommand: 'agents',
		ccCommand: '/agents',
		severity: 'HIGH',
		ccBehavior: 'Manages Claude Code subagent configurations and teams',
		swarmBehavior:
			'Lists registered swarm plugin agents with model, temperature, and guardrail info',
		disambiguationNote:
			'Use /swarm agents to list swarm plugin agents. Do not confuse with Claude Code /agents (which manages Claude subagent configs).',
	},
	{
		swarmCommand: 'config',
		ccCommand: '/config',
		severity: 'HIGH',
		ccBehavior: 'Opens Claude Code settings interface (alias: /settings)',
		swarmBehavior:
			'Shows the current resolved opencode-swarm plugin configuration',
		disambiguationNote:
			'Use /swarm config to view swarm plugin config. Do not confuse with Claude Code /config (which opens Claude settings).',
	},
	{
		swarmCommand: 'export',
		ccCommand: '/export',
		severity: 'HIGH',
		ccBehavior:
			'Exports the current Claude Code conversation as plain text to a file',
		swarmBehavior: 'Exports the swarm plan and context as JSON to stdout',
		disambiguationNote:
			'Use /swarm export to export swarm plan+context JSON. Do not confuse with Claude Code /export (which exports conversation text).',
	},
	{
		swarmCommand: 'doctor',
		ccCommand: '/doctor',
		severity: 'HIGH',
		ccBehavior:
			'Diagnoses the Claude Code installation (version, auth, permissions)',
		swarmBehavior: 'Runs health checks on swarm configuration and state files',
		disambiguationNote:
			'Use /swarm config doctor to diagnose swarm config health. NEVER invoke the bare /doctor command — it runs Claude Code installation diagnostics.',
	},

	// MEDIUM (1)
	{
		swarmCommand: 'history',
		ccCommand: '/history',
		severity: 'MEDIUM',
		ccBehavior: 'Shows Claude Code session history',
		swarmBehavior: 'Shows completed swarm phases with status icons',
		disambiguationNote:
			'Use /swarm history to see completed phases. This is unrelated to Claude Code session history.',
	},
] as const satisfies readonly CommandConflict[];

export const CRITICAL_CONFLICTS: Set<string> = new Set(
	CLAUDE_CODE_CONFLICTS.filter((c) => c.severity === 'CRITICAL').map(
		(c) => c.swarmCommand,
	),
);

export const HIGH_CONFLICTS: Set<string> = new Set(
	CLAUDE_CODE_CONFLICTS.filter((c) => c.severity === 'HIGH').map(
		(c) => c.swarmCommand,
	),
);

export const CONFLICT_MAP = new Map<string, CommandConflict>(
	CLAUDE_CODE_CONFLICTS.map((c) => [c.swarmCommand, c]),
);

/**
 * CC_COMMAND_MAP — maps CC command names (without leading /) to their CommandConflict entry.
 * Used by cc-command-intercept hook to look up conflicts by the bare CC command name.
 * E.g., 'plan' → CommandConflict for /plan, 'reset' → CommandConflict for /reset, 'clear' → CommandConflict for /clear
 *
 * Known aliases are registered below: /clear is documented as an alias for /reset
 * (see /reset entry's `ccBehavior` field), so it must be intercepted identically.
 */
export const CC_COMMAND_MAP = new Map<string, CommandConflict>();

// Initialize CC_COMMAND_MAP: extract command name from ccCommand (e.g., '/plan' → 'plan').
// Also register documented aliases (e.g., /clear is alias for /reset per /reset entry's ccBehavior).
for (const conflict of CLAUDE_CODE_CONFLICTS) {
	const ccCommandName = conflict.ccCommand.replace(/^\//, '').toLowerCase();
	CC_COMMAND_MAP.set(ccCommandName, conflict);
	// /clear is documented as an alias for /reset in the /reset entry's `ccBehavior`:
	// "Alias for /clear — wipes the entire conversation context window".
	// The alias key MUST point to the SAME conflict entry so the hard-block path
	// in cc-command-intercept.ts (which checks `bareCmd === 'clear'`) is reachable.
	if (ccCommandName === 'reset') {
		CC_COMMAND_MAP.set('clear', conflict);
	}
}
